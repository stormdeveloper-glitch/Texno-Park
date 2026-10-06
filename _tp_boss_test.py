#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BOSHLIQ RBAC va autentifikatsiya testi (haqiqiy Flask test client).

Tekshiriladi: login, rol, Boshliq endpoint'larida boss=200 va
admin/manager/cashier=403, tokensiz=401, iyerarxiya, xodim CRUD,
bloklash, o'zini himoya qilish, audit log (parolsiz), reyting.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app as tp  # noqa: E402

BOSS_PHONE = '+998901234554'
BOSS_PASSWORD = os.getenv('BOSS_DEFAULT_PASSWORD', 'diyorbek6272')

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


def ensure_test_user(lname):
    """Test uchun xodimga vaqtinchalik parol beradi va token qaytaradi."""
    staff = tp.load_staff()          # ro'yxatni BIR MARTA olamiz
    target = next((u for u in staff
                   if str(u.get('login', '')).lower() == str(lname).lower()), None)
    if not target:
        return None
    salt = tp.make_salt('tp-test-')
    target['salt'] = salt
    target['passHash'] = tp.hash_password('Test12345', salt)
    target['status'] = 'active'
    # Muhim: aynan o'sh ro'yxatni saqlaymiz, yangisini emas.
    tp.db_manager.save_keys({'staff_users': staff})
    res = login(tp.app.test_client(), lname, 'Test12345')
    if res.status_code != 200:
        print(f'      (login {lname} -> HTTP {res.status_code})')
        return None
    return (res.get_json() or {}).get('token')
BOSS_ONLY_ENDPOINTS = [
    '/api/boss/overview',
    '/api/boss/staff',
    '/api/boss/products',
    '/api/boss/branches',
    '/api/boss/finance',
    '/api/boss/reports',
    '/api/boss/audit',
]


def main():
    tp.ensure_boss_account()
    client = tp.app.test_client()

    print('\n=== 1) BOSHLIQ LOGIN ===')
    res = login(client, BOSS_PHONE, BOSS_PASSWORD)
    check('Boshliq login HTTP 200', res.status_code == 200, f'HTTP {res.status_code}')
    body = res.get_json() or {}
    check('role = boss', (body.get('user') or {}).get('role') == 'boss',
          f"rol={(body.get('user') or {}).get('role')}")
    boss_token = body.get('token')
    check('token qaytarildi', bool(boss_token))

    boss_row = next((u for u in tp.load_staff() if str(u.get('role')) == 'boss'), None)
    check('bazada boss akounti mavjud', boss_row is not None)
    raw_staff = str(tp.db_manager.get_all().get('staff_users', ''))
    check("baza da ochiq parol YO'Q", BOSS_PASSWORD not in raw_staff)

    print('\n=== 2) BOSHLIQ-ONLY ENDPOINT: RBAC ===')
    for path in BOSS_ONLY_ENDPOINTS:
        res = client.get(path, headers=auth(boss_token))
        check(f'BOSHLIQ GET {path} -> 200', res.status_code == 200, f'HTTP {res.status_code}')

    tokens = {}
    for role in ('admin', 'manager', 'cashier'):
        tokens[role] = ensure_test_user(role)

    for path in BOSS_ONLY_ENDPOINTS:
        for role in ('admin', 'manager', 'cashier'):
            if not tokens.get(role):
                check(f'{role} token olingan', False)
                continue
            res = client.get(path, headers=auth(tokens[role]))
            check(f'{role.upper()} GET {path} -> 403', res.status_code == 403,
                  f'HTTP {res.status_code}')

    print('\n=== 3) TOKENSIZ / SOFTA TOKEN ===')
    check('tokensiz /api/boss/overview -> 401',
          client.get('/api/boss/overview').status_code == 401)
    check("soxta token -> 401",
          client.get('/api/boss/overview', headers=auth('nope')).status_code == 401)

    print('\n=== 4) IYERARXIYA: Boshliq admin imkoniyatlariga ega ===')
    check('BOSHLIQ /api/auth/staff -> 200',
          client.get('/api/auth/staff', headers=auth(boss_token)).status_code == 200)
    check('BOSHLIQ /api/security/sessions -> 200',
          client.get('/api/security/sessions', headers=auth(boss_token)).status_code == 200)
    check('ADMIN /api/security/sessions -> 200 (eski siyosat saqlanadi)',
          client.get('/api/security/sessions', headers=auth(tokens['admin'])).status_code == 200)
    return client, boss_token, tokens


def crud_tests(client, boss_token, tokens):
    print('\n=== 5) XODIM QO\'SHISH / ROL TAQIQLANISHI ===')
    res = client.post('/api/boss/staff', headers=auth(boss_token), json={
        'name': 'Sinov Xodim', 'phone': '+998901112233',
        'role': 'cashier', 'password': 'Test12345'})
    check("xodim qo'shildi -> 201", res.status_code == 201, f'HTTP {res.status_code}')
    new_id = ((res.get_json() or {}).get('staff') or {}).get('id')
    check('yangi xodim id qaytarildi', new_id is not None)

    res = client.post('/api/boss/staff', headers=auth(boss_token), json={
        'name': 'Maxfiy Boshliq', 'phone': '+998901119999',
        'role': 'boss', 'password': 'Test12345'})
    check('BOSH roli tayinlash -> 400', res.status_code == 400, f'HTTP {res.status_code}')

    res = client.post('/api/boss/staff', headers=auth(tokens['admin']), json={
        'name': 'Admin Orqali', 'phone': '+998901118888',
        'role': 'cashier', 'password': 'Test12345'})
    check("ADMIN xodim qo'sha olmaydi -> 403", res.status_code == 403, f'HTTP {res.status_code}')

    res = client.post('/api/boss/staff', headers=auth(boss_token), json={
        'name': 'Qisqa Parol', 'phone': '+998901117777',
        'role': 'cashier', 'password': '123'})
    check('qisqa parol -> 400', res.status_code == 400, f'HTTP {res.status_code}')

    print('\n=== 6) BLOKLASH -> LOGIN ISHLAMAYDI ===')
    check('bloklash -> 200', client.put(f'/api/boss/staff/{new_id}',
          headers=auth(boss_token), json={'status': 'blocked'}).status_code == 200)
    check('bloklangan xodim login -> 403',
          login(client, '+998901112233', 'Test12345').status_code == 403)
    check('blokdan chiqarish -> 200', client.put(f'/api/boss/staff/{new_id}',
          headers=auth(boss_token), json={'status': 'active'}).status_code == 200)

    print('\n=== 7) O\'ZINI HIMOYA QILISH ===')
    boss_row = next(u for u in tp.load_staff() if str(u.get('role')) == 'boss')
    check("boss o'zini o'chira olmaydi -> 403", client.delete(
        f'/api/boss/staff/{boss_row["id"]}', headers=auth(boss_token)).status_code == 403)
    check("boss o'zini bloklay olmaydi -> 403", client.put(
        f'/api/boss/staff/{boss_row["id"]}', headers=auth(boss_token),
        json={'status': 'blocked'}).status_code == 403)
    check("ADMIN boss ni o'chira olmaydi -> 403", client.delete(
        f'/api/boss/staff/{boss_row["id"]}',
        headers=auth(tokens['admin'])).status_code == 403)

    print('\n=== 8) O\'CHIRISH + AUDIT LOG ===')
    check("xodim o'chirildi -> 200", client.delete(
        f'/api/boss/staff/{new_id}', headers=auth(boss_token)).status_code == 200)
    rows = (client.get('/api/boss/staff', headers=auth(boss_token)).get_json()
            or {}).get('staff') or []
    check("o'chirilgan xodim ro'yxatda yo'q",
          'Sinov Xodim' not in [s.get('name') for s in rows])

    events = (client.get('/api/boss/audit', headers=auth(boss_token)).get_json()
              or {}).get('events') or []
    actions = {e.get('action') for e in events}
    check("audit log bo'sh emas", len(events) > 0)
    check('staff-create yozilgan', 'staff-create' in actions, str(actions))
    check('staff-delete yozilgan', 'staff-delete' in actions, str(actions))
    audit_raw = str(tp.db_manager.get_all().get('audit_log') or '')
    check("audit logda parol YO'Q",
          BOSS_PASSWORD not in audit_raw and 'Test12345' not in audit_raw)

    print('\n=== 9) O\'Z PAROLI ===')
    check("noto'g'ri joriy parol -> 401", client.post('/api/boss/password',
          headers=auth(boss_token), json={'currentPassword': 'not-the-password',
                                          'newPassword': 'YangiParol123'}).status_code == 401)
    check('tasdiqlanmagan parol -> 400', client.post('/api/boss/password',
          headers=auth(boss_token), json={'currentPassword': BOSS_PASSWORD,
                                          'newPassword': 'YangiParol123',
                                          'confirmPassword': 'BoshqaParol'}
                     ).status_code == 400)

    print('\n=== 10) REYTING HAQIQIYMI ===')
    rows = (client.get('/api/boss/staff?period=all&sort=total',
                       headers=auth(boss_token)).get_json() or {}).get('staff') or []
    check("xodimlar ro'yxati bo'ldi", len(rows) > 0)
    totals = [r.get('total', 0) for r in rows]
    check('reyting savdo summasi bo\'yicha kamayib boradi',
          totals == sorted(totals, reverse=True), str(totals))
    check("xodimda parol/xash yo'q",
          all('passHash' not in r and 'salt' not in r for r in rows))
    kpi = (client.get('/api/boss/overview',
                      headers=auth(boss_token)).get_json() or {}).get('kpi') or {}
    check("overview KPI kalitlari to'liq",
          all(k in kpi for k in ('todaySales', 'todayOrders', 'totalSales', 'totalProfit',
                                 'products', 'lowStock', 'customers', 'staff',
                                 'staffActive', 'branches')))
    check('xodim qidiruvi ishlaydi', client.get('/api/boss/staff?q=kassir',
          headers=auth(boss_token)).status_code == 200)
    check('CSV eksport ishlaydi', 'text/csv' in client.get(
        '/api/boss/reports?format=csv', headers=auth(boss_token)).headers.get(
            'Content-Type', ''))


if __name__ == '__main__':
    _c, _b, _t = main()
    crud_tests(_c, _b, _t)
    print(f"\n=== NATIJA: {_passed} o'tgan, {_failed} yiqilgan ===")
    sys.exit(1 if _failed else 0)
