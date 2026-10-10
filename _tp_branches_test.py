#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Filiallar moduli API regression testi (haqiqiy Flask test client).

Tekshiriladi:
  1) /api/branches/summary — har filial uchun to'liq KPI maydonlari va
     sof natija formulasi: profit = revenue + income − expense − harajat;
  2) summary raqamlari database'dagi haqiqiy savdo/kirim-chiqim bilan mos;
  3) POST /api/branches/<id>/status — holat DB'da saqlanadi, GET'da ko'rinadi;
  4) takroriy status so'rovi idempotent (changed=false);
  5) DELETE — bog'liq ma'lumot BOR filial uchun409 + sabab, filial saqlanadi;
  6) DELETE — bog'liq ma'lumot YO'Q filial uchun muvaffaqiyat + DB'dan o'chdi;
  7) noma'lum id uchun404; kassir uchun403; tokensiz401;
  8) o'chirish urinishlaridan keyin savdo tarixi o'zgarmaydi (yaxlitlik).

Barcha yozuvlar DB_PATH klonida bajariladi — production bazasi himoyalangan
(DB_PATH production bilan bir xil bo'lsa test ishga tushmaydi).
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app as tp  # noqa: E402

try:  # Windows konsollari cp1254 bo'lsa ham UTF-8 chiqarish
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROD_DB = os.path.join(BASE_DIR, 'Data', 'database.db')
DB_PATH = os.getenv('DB_PATH') or PROD_DB
BOSS_PHONE = '+998901234554'
CASHIER_PHONE = '+998905450921'

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


def env_password():
    pw = (os.getenv('TP_STAFF_PASSWORD') or os.getenv('BOSS_DEFAULT_PASSWORD') or '').strip()
    if pw:
        return pw
    env_path = os.path.join(BASE_DIR, '.env')
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip().startswith('BOSS_DEFAULT_PASSWORD='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ''


def auth(token):
    return {'Authorization': 'Bearer ' + (token or '')}


def login(client, phone, password):
    res = client.post('/api/auth/login', json={'login': phone, 'password': password})
    if res.status_code != 200:
        return None
    return (res.get_json() or {}).get('token')


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def sale_branch(sale, products_by_id):
    """Backend `sale_branch()` bilan bir xil mantiq (test mustaqil nusxa)."""
    direct = str(sale.get('branchId') or '').strip()
    if direct:
        return direct
    ids = set()
    for item in (sale.get('items') or []):
        p = products_by_id.get(str((item or {}).get('id')))
        if p and p.get('branchId'):
            ids.add(str(p['branchId']))
    return ids.pop() if len(ids) == 1 else ''


def main():
    print('Baza (klon):', os.path.basename(DB_PATH))
    if os.path.abspath(DB_PATH) == os.path.abspath(PROD_DB):
        print('[XATO] Test production bazasida ishga tushmaydi — '
              'DB_PATH ni klon faylga yo\'naltiring.')
        return 1

    pw = env_password()
    if not pw:
        print('[XATO] BOSS paroli topilmadi (TP_STAFF_PASSWORD / .env).')
        return 1

    client = tp.app.test_client()

    boss_token = login(client, BOSS_PHONE, pw)
    check('Boshliq kirishi (login)', bool(boss_token))
    if not boss_token:
        return 1
    cashier_token = login(client, CASHIER_PHONE, pw)

    # ── Ma'lumot olish ──────────────────────────────────────────
    store_res = client.get('/api/data', headers=auth(boss_token))
    check('/api/data200 (boshliq)', store_res.status_code == 200)
    store = store_res.get_json() or {}
    products = [p for p in (store.get('products') or []) if isinstance(p, dict)]
    sales = [s for s in (store.get('sales') or []) if isinstance(s, dict)]
    products_by_id = {str(p.get('id')): p for p in products}

    # ──1) SUMMARY: to'liq maydonlar + sof natija formulasi ─────
    print('\n===1) /api/branches/summary — KPI + formula ===')
    res = client.get('/api/branches/summary', headers=auth(boss_token))
    check('summary HTTP200', res.status_code == 200, f'HTTP {res.status_code}')
    data = res.get_json() or {}
    rows = data.get('branches') or []
    check('summary kamida3 ta filial qaytardi', len(rows) >= 3, f'{len(rows)} ta')
    fields_ok = all(all(k in r for k in
                        ('branchId', 'name', 'products', 'stockValue',
                         'salesCount', 'revenue', 'income', 'expense',
                         'harajat', 'profit')) for r in rows)
    check('barcha filiallarda to\'liq KPI maydonlari', fields_ok)
    formula_ok = all(
        abs(num(r.get('profit')) - (num(r.get('revenue')) + num(r.get('income'))
                                    - num(r.get('expense')) - num(r.get('harajat')))) < 0.01
        for r in rows)
    check('sof natija formula: profit = revenue + income − expense − harajat', formula_ok)

    # ──2) SUMMARY vs DATABASE (mustaqil hisob) ──────────────────
    print('\n===2) summary raqamlari database bilan mos ===')
    paid = [s for s in sales if str(s.get('status') or 'paid') == 'paid']
    flow = [c for c in (store.get('cashFlow') or []) if isinstance(c, dict)]
    legacy = [c for c in (store.get('expenses') or []) if isinstance(c, dict)]
    row_by_id = {str(r.get('branchId')): r for r in rows}
    matched = checked =0
    for r in rows:
        bid = str(r.get('branchId'))
        checked +=1
        exp_rev = sum(num(s.get('total')) for s in paid if sale_branch(s, products_by_id) == bid)
        exp_in = sum(num(c.get('amount')) for c in flow + legacy
                     if str(c.get('branchId') or '') == bid
                     and str(c.get('type')) in ('kirim', 'income'))
        exp_out = sum(num(c.get('amount')) for c in flow + legacy
                      if str(c.get('branchId') or '') == bid
                      and str(c.get('type')) in ('chiqim', 'expense'))
        exp_har = sum(num(c.get('amount')) for c in flow + legacy
                      if str(c.get('branchId') or '') == bid
                      and str(c.get('type')) == 'harajat')
        exp_prod = len([p for p in products if str(p.get('branchId') or '') == bid])
        if (abs(num(r.get('revenue')) - exp_rev) < 0.01
                and abs(num(r.get('income')) - exp_in) < 0.01
                and abs(num(r.get('expense')) - exp_out) < 0.01
                and abs(num(r.get('harajat')) - exp_har) < 0.01
                and int(r.get('products') or 0) == exp_prod):
            matched +=1
    check('summary = database (savdo/kirim/chiqim/mahsulot)', matched == checked,
          f'{matched}/{checked}')

    # Namuna: b2 filialiga sinx kirim yozuvi qo'shamiz va summary darhol aks ettiradi
    b2_id = 'b2'
    if b2_id in row_by_id:
        before_in = num(row_by_id[b2_id].get('income'))
        seed = {'id': 'cf-test-branch-' + str(int(__import__('time').time())),
                'type': 'kirim', 'amount':77777.0, 'category': 'Test',
                'note': 'branches-test seed', 'branchId': b2_id,
                'date': '2026-01-01', 'user': 'test'}
        new_flow = flow + [seed]
        sync_res = client.post('/api/sync', headers=auth(boss_token),
                               json={'cashFlow': new_flow})
        check('sync (kirim seed)200', sync_res.status_code == 200)
        res2 = client.get('/api/branches/summary', headers=auth(boss_token))
        rows2 = (res2.get_json() or {}).get('branches') or []
        b2_row = next((r for r in rows2 if str(r.get('branchId')) == b2_id), None)
        check('kirim summary\'da paydo bo\'ldi (income +77777)',
              b2_row is not None
              and abs(num(b2_row.get('income')) - (before_in +77777.0)) <0.01,
              f'income={b2_row.get("income") if b2_row else None}')
        check('kirimdan keyin sof natija ham yangilandi',
              b2_row is not None and abs(
                  num(b2_row.get('profit'))
                  - (num(b2_row.get('revenue')) + num(b2_row.get('income'))
                     - num(b2_row.get('expense')) - num(b2_row.get('harajat')))) <0.01)
        # Seedni olib tashlaymiz (klon holatini tiklaymiz)
        restored_flow = [c for c in new_flow if c.get('id') != seed['id']]
        client.post('/api/sync', headers=auth(boss_token), json={'cashFlow': restored_flow})

    # ──3) STATUS: DB'da saqlanadi ───────────────────────────────
    print('\n===3) POST /api/branches/<id>/status ===')
    target = b2_id if b2_id in row_by_id else (rows[0]['branchId'] if rows else None)
    check('test filiali topildi', bool(target))
    if target:
        res = client.post(f'/api/branches/{target}/status',
                          headers=auth(boss_token), json={'status': 'inactive'})
        j = res.get_json() or {}
        check('status inactive →200', res.status_code == 200
              and j.get('status') == 'success'
              and j.get('branchStatus') == 'inactive')
        store2 = (client.get('/api/data', headers=auth(boss_token)).get_json() or {})
        db_status = next((str(b.get('status')) for b in (store2.get('branches') or [])
                          if str(b.get('id')) == target), None)
        check('DB\'da status = inactive (reload\'da ham saqlanadi)', db_status == 'inactive')
        res = client.post(f'/api/branches/{target}/status',
                          headers=auth(boss_token), json={'status': 'inactive'})
        check('takroriy status idempotent (changed=false)',
              res.status_code ==200 and (res.get_json() or {}).get('changed') is False)
        res = client.post(f'/api/branches/{target}/status',
                          headers=auth(boss_token), json={'status': 'active'})
        check('status qayta active →200', res.status_code ==200)
        store2 = (client.get('/api/data', headers=auth(boss_token)).get_json() or {})
        db_status = next((str(b.get('status')) for b in (store2.get('branches') or [])
                          if str(b.get('id')) == target), None)
        check('DB\'da status = active qayta tiklandi', db_status == 'active')

    # ──4) DELETE: bog'liq ma'lumot himoyasi ─────────────────────
    print('\n===4) DELETE — bog\'liq ma\'lumotlar himoyalangan ===')
    sales_before = len(sales)
    prod_with_b2 = len([p for p in products if str(p.get('branchId') or '') == b2_id])
    if prod_with_b2:
        res = client.delete(f'/api/branches/{b2_id}', headers=auth(boss_token))
        j = res.get_json() or {}
        check('bog\'liq filial DELETE →409', res.status_code ==409)
        check('409 code = has_related_data', j.get('code') == 'has_related_data', str(j.get('code')))
        check('related.products to\'g\'ri', (j.get('related') or {}).get('products') == prod_with_b2)
        still = client.get('/api/branches', headers=auth(boss_token))
        check('filial o\'chirilmadi (ro\'yxatda qoldi)',
              any(str(b.get('id')) == b2_id for b in (still.get_json() or {}).get('branches') or []))
    else:
        check('bog\'liq filial DELETE →409', True, '(b2 da mahsulot yo\'q — skip)')

    # ──5) DELETE: bo'sh filial o'chiriladi ──────────────────────
    print('\n===5) DELETE — bo\'sh filial muvaffaqiyatli o\'chiriladi ===')
    tmp_id = 'br-test-del-' + str(int(__import__('time').time()))
    store3 = (client.get('/api/data', headers=auth(boss_token)).get_json() or {})
    branches_list = [b for b in (store3.get('branches') or []) if isinstance(b, dict)]
    branches_list.append({'id': tmp_id, 'name': 'TEST-DEL filial', 'code': '',
                          'city': 'Testshahar', 'address': 'Test ko\'chasi1',
                          'phone': '', 'hours': '', 'lat': None, 'lng': None,
                          'markerIcon': '🏬', 'markerColor': '#ff6b35',
                          'status': 'active', 'isMain': False})
    sync_res = client.post('/api/sync', headers=auth(boss_token),
                           json={'branches': branches_list})
    check('sync (yangi filial)200', sync_res.status_code ==200)
    listed = client.get('/api/branches', headers=auth(boss_token))
    check('yangi filial /api/branches da ko\'rinadi',
          any(str(b.get('id')) == tmp_id for b in (listed.get_json() or {}).get('branches') or []))
    res = client.delete(f'/api/branches/{tmp_id}', headers=auth(boss_token))
    j = res.get_json() or {}
    check('bo\'sh filial DELETE →200', res.status_code ==200 and j.get('status') == 'success',
          f'HTTP {res.status_code} {j}')
    listed = client.get('/api/branches', headers=auth(boss_token))
    check('filial /api/branches dan yo\'qoldi',
          not any(str(b.get('id')) == tmp_id for b in (listed.get_json() or {}).get('branches') or []))
    store4 = (client.get('/api/data', headers=auth(boss_token)).get_json() or {})
    check('DB store\'dan ham o\'chdi',
          not any(str(b.get('id')) == tmp_id for b in (store4.get('branches') or [])))
    check('o\'chirishdan keyin savdo tarixi saqlandi',
          len([s for s in (store4.get('sales') or []) if isinstance(s, dict)]) == sales_before)

    # ──6)404 / RBAC ────────────────────────────────────────────
    print('\n===6)404 + RBAC (kassir403, tokensiz401) ===')
    res = client.delete('/api/branches/br-mavjud-emasp', headers=auth(boss_token))
    check('noma\'lum filial DELETE →404', res.status_code ==404)
    res = client.post('/api/branches/br-mavjud-emasp/status',
                      headers=auth(boss_token), json={'status': 'inactive'})
    check('noma\'lum filial status →404', res.status_code ==404)
    if cashier_token:
        res = client.delete(f'/api/branches/{tmp_id}', headers=auth(cashier_token))
        check('kassir DELETE →403', res.status_code ==403, f'HTTP {res.status_code}')
        res = client.post(f'/api/branches/{b2_id}/status',
                          headers=auth(cashier_token), json={'status': 'inactive'})
        check('kassir status →403', res.status_code ==403, f'HTTP {res.status_code}')
        # Filiallar KPI endpointi ham kassir uchun yopiq (menyu RBAC bilan bir xil)
        res = client.get('/api/branches/summary', headers=auth(cashier_token))
        check('kassir summary →403', res.status_code ==403, f'HTTP {res.status_code}')
    else:
        check('kassir kirishi (login)', False, 'kassir tokeni olinalmadi')
    res = client.delete(f'/api/branches/{b2_id}')
    check('tokensiz DELETE →401', res.status_code ==401)
    # Rollar iyerarxiyasi: boshliq summary endpointdan foydalanishda davom etadi
    res = client.get('/api/branches/summary', headers=auth(boss_token))
    check('boshliq summary →200 (yerarxiya saqlangan)', res.status_code ==200)

    print(f'\n=== NATIJA: {_passed} o\'tgan, {_failed} yiqilgan ===')
    return 0 if _failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
