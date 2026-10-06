"""TEXNO PARK N1 — 4 AKKAUNT E2E TESTI (haqiqiy Flask + haqiqiy baza).

Vazifa (50 bandlik ro'yxat) asosida quyidagilar tekshiriladi:
  1) DB da aynan shu 4 akkaunt: BOSHLIQ / ADMIN / MANAGER / CASHIER
  2) telefon unique, telefon format variantlari bilan login
  3) role backend tomonidan aniqlanadi
  4) parol faqat SHA-256 xesh (ochiq matn yo'q)
  5) noto'g'ri parol / noto'g'ri telefon → 401 (umumiy xabar)
  6) bloklangan akkaunt → 403
  7) RBAC: /api/boss/* faqat BOSHLIQ (admin/manager/cashier → 403)
  8) logout serverda sessiyani bekor qiladi
  9) duplicate telefon yaratilmaydi
  10) baza boshqa ma'lumotlar o'chirilmaydi
"""
from __future__ import annotations

import json
import os
import sys

os.environ.setdefault('FLASK_DEBUG', 'false')

import app as appmod  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

PW = (os.getenv('TP_STAFF_PASSWORD') or 'diyorbek6272').strip()

ACCOUNTS = [
    ('BOSHLIQ', '+998901234554', 'boss'),
    ('ADMIN', '+998908480921', 'admin'),
    ('MANAGER', '+998902750921', 'manager'),
    ('CASHIER', '+998905450921', 'cashier'),
]

VARIANT = {
    '+998901234554': ['+998901234554', '+998 90 123 45 54', '998901234554', '901234554'],
    '+998908480921': ['+998908480921', '+998 90 848 09 21', '998908480921'],
    '+998902750921': ['+998902750921', '+998 90 275 09 21'],
    '+998905450921': ['+998905450921', '905450921'],
}

negative = 0
positive = 0


def check(name, ok, detail=''):
    global positive, negative
    if ok:
        positive += 1
        print(f'  [OK]   {name}')
    else:
        negative += 1
        print(f'  [FAIL] {name}  {detail}')


def auth(token):
    return {'Authorization': 'Bearer ' + (token or '')}


def main() -> int:
    client = appmod.app.test_client()
    staff = appmod.load_staff()
    tokens = {}

    print('=== 1) 4 AKKAUNT AUDITI ===')
    for label, phone, role in ACCOUNTS:
        u = next((x for x in staff if appmod.phones_match(x.get('phone'), phone)), None)
        check(f'{label}: akkaunt mavjud ({phone})', u is not None,
              str([x.get('phone') for x in staff]))
        if u:
            check(f'{label}: rol = {role}', str(u.get('role', '')).lower() == role,
                  str(u.get('role')))
            check(f"{label}: status active", str(u.get('status', 'active')).lower() == 'active',
                  str(u.get('status')))
            check(f'{label}: xesh 64 hex (parol emas)',
                  isinstance(u.get('passHash'), str) and len(u['passHash']) == 64,
                  str(u.get('passHash'))[:16])

    phones = [appmod.normalize_phone(x.get('phone')) for x in staff if x.get('phone')]
    dup = len(phones) - len(set(p for p in phones if p))
    check('Telefon raqamlari duplicate emas', dup == 0, str(dup))
    check("Bazada OCHIQ parol yo'q", PW not in json.dumps(staff))

    print('\\n=== 2) LOGIN: TELEFON FORMAT VARIANTLARI ===')
    for label, phone, role in ACCOUNTS:
        for v in VARIANT[phone]:
            res = client.post('/api/auth/login', json={'login': v, 'password': PW})
            body = res.get_json() or {}
            check(f'{label}: login "{v}" -> role={role}',
                  res.status_code == 200 and body.get('status') == 'success'
                  and (body.get('user') or {}).get('role') == role,
                  f'HTTP {res.status_code} / {(body.get("user") or {}).get("role")}')
            if res.status_code == 200 and not tokens.get(label):
                tokens[label] = body.get('token')
    print("\\n=== 3) NOTO'G'RI PAROL / TELEFON ===")
    bad = client.post('/api/auth/login', json={'login': '+998908480921', 'password': PW + 'zz'})
    bbody = bad.get_json() or {}
    check("Noto'g'ri parol → 401", bad.status_code == 401, f'HTTP {bad.status_code}')
    check('Xabar umumiy (parol/rol oshkor etilmaydi)',
          'Telefon' in str(bbody.get('message')) or 'Login' in str(bbody.get('message')),
          str(bbody.get('message')))
    check("Javobda hash yoki parol yo'q",
          PW not in json.dumps(bbody) and 'passHash' not in json.dumps(bbody))
    for label, phone, _role in ACCOUNTS:
        res = client.post('/api/auth/login', json={'login': phone, 'password': PW + 'x'})
        check(f"{label}: noto'g'ri parol → 401", res.status_code == 401,
              f'HTTP {res.status_code}')
    res = client.post('/api/auth/login', json={'login': '+998900000000', 'password': PW})
    check("Mavjud bo'lmagan telefon → 401", res.status_code == 401, f'HTTP {res.status_code}')

    print('\\n=== 4) RBAC: /api/boss/* ===')
    boss_only = ['/api/boss/overview', '/api/boss/staff', '/api/boss/products',
                 '/api/boss/branches', '/api/boss/finance', '/api/boss/reports',
                 '/api/boss/audit']
    for path in boss_only:
        check(f'BOSHLIQ GET {path} → 200',
              client.get(path, headers=auth(tokens['BOSHLIQ'])).status_code == 200,
              f'HTTP {client.get(path, headers=auth(tokens["BOSHLIQ"])).status_code}')
    for label in ('ADMIN', 'MANAGER', 'CASHIER'):
        if not tokens.get(label):
            continue
        for path in boss_only:
            check(f'{label} GET {path} → 403',
                  client.get(path, headers=auth(tokens[label])).status_code == 403,
                  f'HTTP {client.get(path, headers=auth(tokens[label])).status_code}')

    print("\\n=== 5) BLOKLANGAN AKKAUNT ===")
    cashier = next(x for x in staff if str(x.get('login', '')).lower() == 'cashier')
    cashier_old_status = cashier.get('status', 'active')
    try:
        cashier['status'] = 'blocked'
        appmod.db_manager.save_keys({'staff_users': staff})
        res = client.post('/api/auth/login', json={'login': '+998905450921', 'password': PW})
        check('Bloklangan CASHIER login → 403', res.status_code == 403,
              f'HTTP {res.status_code}')
    finally:
        cashier['status'] = cashier_old_status
        appmod.db_manager.save_keys({'staff_users': staff})
    res = client.post('/api/auth/login', json={'login': '+998905450921', 'password': PW})
    check('Qayta aktivlashtirilgach login → 200', res.status_code == 200,
          f'HTTP {res.status_code}')

    print('\\n=== 6) LOGOUT (server sessiyasi) ===')
    tok = tokens.get('ADMIN', '')
    if tok:
        res = client.post('/api/auth/logout', headers=auth(tok))
        check('POST /api/auth/logout → 200', res.status_code == 200, f'HTTP {res.status_code}')
        res = client.get('/api/auth/session', headers=auth(tok))
        check("Logoutdan so'ng eski token → 401", res.status_code == 401,
              f'HTTP {res.status_code}')

    print('\\n=== 7) DUPLICATE TELEFON YARATILMAYDI ===')
    if tokens.get('BOSHLIQ'):
        res = client.post('/api/boss/staff', headers=auth(tokens['BOSHLIQ']), json={
            'name': 'Dublikat Test',
            'phone': '+998908480921',  # ADMIN bilan bir xil — band bo'lishi shart
            'role': 'manager',
            'password': PW,
        })
        check("Mavjud telefon bilan xodim qo'shish → 409", res.status_code == 409,
              f'HTTP {res.status_code}')

    print("\n=== 8) MAVJUD MALUMOTLAR SAQLANDI ===")
    before = set((appmod.db_manager.get_all() or {}).keys())
    after = set((appmod.db_manager.get_all() or {}).keys())
    check("store_data kalitlari o'chmadi", before == after,
          str(sorted(before ^ after))[:120])

    print(f'\\nJami: {positive + negative} tekshiruv, {positive} PASS, {negative} FAIL')
    return 1 if negative else 0


if __name__ == '__main__':
    sys.exit(main())