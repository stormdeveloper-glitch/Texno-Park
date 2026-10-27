#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
XODIMNI O'CHIRISH (arxivlash) — integratsion test.

MUAMMO: xodim o'chirilgandan keyin ham jadvalda qolib ketar edi
(GET /api/boss/staff arxivlangan xodimni ham qaytarar edi).

Test HAQIQIY `Data/database.db` nusxasi — `.testdb/delete_fix_test.db` —
ustida ishlaydi, shuning uchun loyihaning asosiy bazasi o'zgarmaydi.
"""
import json
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

# 1) Vaqtinchalik baza: haqiqiy baza nusxalanadi.
TMP_REL = '.testdb/delete_fix_test.db'
TMP_DB = os.path.join(BASE, TMP_REL.replace('/', os.sep))
os.makedirs(os.path.dirname(TMP_DB), exist_ok=True)
shutil.copyfile(os.path.join(BASE, 'Data', 'database.db'), TMP_DB)

# 2) Importdan OLDIN muhit: shu bazada ishlaymiz.
os.environ['DB_PATH'] = TMP_REL
os.environ.setdefault('BOSS_DEFAULT_PASSWORD', 'BossTest12345')

import app as tp  # noqa: E402

_passed = 0
_failed = 0


def check(label, ok, detail=''):
    global _passed, _failed
    if ok:
        _passed += 1
        print(f'  [OK]   {label}')
    else:
        _failed += 1
        print(f'  [FAIL] {label}  {detail}')


def login(client, login_value, password):
    return client.post('/api/auth/login',
                       json={'login': login_value, 'password': password})


def auth(token):
    return {'Authorization': 'Bearer ' + (token or '')}


def boss_token_for(client):
    """Boshliq akountini yaratadi/vazifasini o'tkazadi va token qaytaradi."""
    tp.ensure_boss_account()
    staff = tp.load_staff()
    boss = next((u for u in staff if str(u.get('role')) == 'boss'), None)
    if not boss:
        raise SystemExit('Boshliq akounti yaratilmadi')
    salt = tp.make_salt('tp-test-')
    boss['salt'] = salt
    boss['passHash'] = tp.hash_password('BossTest12345', salt)
    boss['status'] = 'active'
    boss['mustChange'] = False   # aks holda API 403 password_change_required qaytaradi
    tp.db_manager.save_keys({'staff_users': staff})
    res = login(client, boss.get('login') or boss.get('phone'), 'BossTest12345')
    if res.status_code != 200:
        raise SystemExit(f'Boshliq login xato: HTTP {res.status_code}')
    return (res.get_json() or {}).get('token')


def role_token(client, login_value):
    """Mavjud xodimga vaqtinchalik parol berib, uning tokenini oladi."""
    staff = tp.load_staff()
    target = next((u for u in staff
                   if str(u.get('login', '')).lower() == login_value.lower()), None)
    if not target:
        return None
    salt = tp.make_salt('tp-test-')
    target['salt'] = salt
    target['passHash'] = tp.hash_password('Test12345', salt)
    target['status'] = 'active'
    target['mustChange'] = False
    tp.db_manager.save_keys({'staff_users': staff})
    res = login(client, login_value, 'Test12345')
    # (Vaqtinchalik bazada ishlayapmiz — parolni qayta tiklash shart emas.)
    if res.status_code != 200:
        return None
    return (res.get_json() or {}).get('token')


def main():
    client = tp.app.test_client()
    token = boss_token_for(client)

    print('\n=== 1) OCHIQ BAZA: holatni oldindan olish ===')
    store_before = dict(tp.db_manager.get_all() or {})
    sales_before = json.dumps(store_before.get('sales') or [],
                              ensure_ascii=False, sort_keys=True)
    other_before = [(u.get('id'), u.get('name'), u.get('status'))
                    for u in tp.load_staff() if u.get('name') != 'ahatbek']

    print('\n=== 2) AHATBEK YARATILADI ===')
    res = client.post('/api/boss/staff', headers=auth(token), json={
        'name': 'ahatbek', 'phone': '+998907777001',
        'role': 'cashier', 'password': 'Test12345'})
    check('ahatbek yaratildi -> 201', res.status_code == 201,
          f'HTTP {res.status_code} {res.get_json()}')
    ahatbek_id = (res.get_json() or {}).get('staff', {}).get('id')
    check('xodim ID qaytarildi', bool(ahatbek_id), str(ahatbek_id))

    LIST = '/api/boss/staff?period=all&sort=total&limit=200'
    data = (client.get(LIST, headers=auth(token)).get_json() or {})
    names = [s.get('name') for s in data.get('staff') or []]
    check('ahatbek ro\'yxatda ko\'rinadi', 'ahatbek' in names, str(names))
    names_before = set(names)   # o'chirishdan OLDIN ro'yxatdagi ismlar
    check('total = ro\'yxat uzunligi',
          data.get('total') == len(data.get('staff') or []),
          f"total={data.get('total')} len={len(data.get('staff') or [])}")

    print('\n=== 3) O\'CHIRISH TARTIBI ===')
    res = client.delete(f'/api/boss/staff/{ahatbek_id}', headers=auth(token))
    body = res.get_json() or {}
    check('DELETE -> 200', res.status_code == 200, f'HTTP {res.status_code}')
    check('status=success', body.get('status') == 'success', str(body))
    check('xabar qaytarildi', bool(body.get('message')), str(body.get('message')))

    # 3a. Ro'yxatdan butunlay yo'qolishi (sahifani yangilash = qayta so'rov)
    data = (client.get(LIST, headers=auth(token)).get_json() or {})
    names = [s.get('name') for s in data.get('staff') or []]
    check('ro\'yxatda yo\'q (qayta yuklash)', 'ahatbek' not in names, str(names))
    check('total kamaydi', data.get('total') == len(data.get('staff') or []))
    ranks = [s.get('rank') for s in data.get('staff') or []]
    check('reyting 1..N ketma-ket va takrorlanmasdan',
          ranks == list(range(1, len(ranks) + 1)), str(ranks))

    # 3b. Qidiruv
    for qs in ('?q=ahatbek', '?q=ahat&sort=name', '?role=cashier&q=ahatbek',
               '?status=active&q=ahatbek', '?period=7d&q=ahatbek'):
        d = (client.get('/api/boss/staff' + qs, headers=auth(token)).get_json() or {})
        got = [s.get('name') for s in d.get('staff') or []]
        check(f'qidiruv/filtr {qs} → yo\'q', 'ahatbek' not in got, str(got))

    # 3c. Nofaol (arxiv) filtri — xodim shu yerda ko'rinadi
    d = (client.get('/api/boss/staff?status=inactive', headers=auth(token)).get_json() or {})
    got = [s.get('name') for s in d.get('staff') or []]
    check('status=inactive filtri arxivni ko\'rsatadi', 'ahatbek' in got, str(got))

    # 3d. Statistika: jami = faol + bloklangan (arxiv alohida)
    d = (client.get(LIST, headers=auth(token)).get_json() or {})
    c = d.get('statusCounts') or {}
    check('statusCounts to\'liq',
          all(k in c for k in ('active', 'blocked', 'inactive')), str(c))
    check('ro\'yxatdagi jami = faol + bloklangan',
          d.get('total') == c.get('active', 0) + c.get('blocked', 0),
          f"total={d.get('total')} counts={c}")
    check('arxivlanganlar soni oshdi', c.get('inactive', 0) >= 1, str(c))

    print('\n=== 4) TAKRORIY SO\'ROV (idempotent) ===')
    res2 = client.delete(f'/api/boss/staff/{ahatbek_id}', headers=auth(token))
    check('ikkinchi DELETE ham xatoliksiz (idempotent)',
          res2.status_code == 200, f'HTTP {res2.status_code}')
    d = (client.get(LIST, headers=auth(token)).get_json() or {})
    check('qayta o\'chirish ro\'yxatni buzmaydi',
          'ahatbek' not in [s.get('name') for s in d.get('staff') or []])

    print('\n=== 5) RUXSATLAR ===')
    check('tokensiz DELETE -> 401',
          client.delete(f'/api/boss/staff/{ahatbek_id}').status_code == 401)
    admin_tok = role_token(client, 'admin')
    if admin_tok:
        check('ADMIN DELETE -> 403',
              client.delete(f'/api/boss/staff/{ahatbek_id}',
                            headers=auth(admin_tok)).status_code == 403)
    else:
        check('ADMIN token olindi', False)
    boss_row = next(u for u in tp.load_staff() if str(u.get('role')) == 'boss')
    check("Boshliq o'zini o'chira olmaydi -> 403",
          client.delete(f'/api/boss/staff/{boss_row["id"]}',
                        headers=auth(token)).status_code == 403)
    res = client.delete('/api/boss/staff/999999', headers=auth(token))
    check('mavjud bo\'lmagan ID -> 404 + xabar',
          res.status_code == 404 and bool((res.get_json() or {}).get('message')),
          f'HTTP {res.status_code} {res.get_json()}')

    print('\n=== 6) BOSHLIQLARGA ZARAR YETMAYDI ===')
    store_after = dict(tp.db_manager.get_all() or {})
    sales_after = json.dumps(store_after.get('sales') or [],
                             ensure_ascii=False, sort_keys=True)
    check('savdo tarixi o\'zgarmagan', sales_before == sales_after)
    other_after = [(u.get('id'), u.get('name'), u.get('status'))
                   for u in tp.load_staff() if u.get('name') != 'ahatbek']
    check('boshqa xodimlar o\'zgarmagan', other_before == other_after,
          f'{other_before} vs {other_after}')
    d_after = client.get(LIST, headers=auth(token)).get_json() or {}
    list_after = [s.get('name') for s in (d_after.get('staff') or [])]
    check('faqat ahatbek yo\'qoldi, qolganlari joyida',
          names_before - {'ahatbek'} == set(list_after),
          f'old={sorted(names_before)} new={sorted(list_after)}')
    check('ahatbek bazada arxivlangan holda saqlangan (soft delete)',
          any(u.get('name') == 'ahatbek'
              and str(u.get('status')) == 'inactive'
              and u.get('deletedAt')
              for u in tp.load_staff()))

    print('\n=== 7) AUDIT JURNALI ===')
    events = (client.get('/api/boss/audit', headers=auth(token)).get_json()
              or {}).get('events') or []
    actions = {e.get('action') for e in events}
    check("audit'da 'staff-delete' yozuvi", 'staff-delete' in actions, str(actions))

    print('\n=== 8) ARXIVDAN QAYTA FAOLLASHTIRISH (qaytarish) ===')
    res = client.put(f'/api/boss/staff/{ahatbek_id}', headers=auth(token),
                     json={'status': 'active'})
    check('arxivdan chiqarish -> 200', res.status_code == 200,
          f'HTTP {res.status_code}')
    d = (client.get(LIST + '&q=ahatbek', headers=auth(token)).get_json() or {})
    check('qayta faol xodim ro\'yxatga qaytdi',
          'ahatbek' in [s.get('name') for s in d.get('staff') or []])

    print(f'\n=== NATIJA: {_passed} o\'tgan, {_failed} yiqilgan ===')
    return 1 if _failed else 0


if __name__ == '__main__':
    sys.exit(main())
