"""Auth E2E tekshiruvi (haqiqiy Flask ilovasi + haqiqiy baza).

Tekshiriladi:
  - 3 xodim login (ADMIN/MANAGER/CASHIER) turli telefon formatlarida
  - role backend tomonidan aniqlanishi
  - token + sessiya (/api/auth/session, refresh)
  - logout (token o'chirilgach 401)
  - noto'g'ri parol / noto'g'ri telefon rad etilishi
  - javoblar va jurnalda ochiq parol yo'qligi
"""

from __future__ import annotations

import json
import os
import sys

os.environ.setdefault('FLASK_DEBUG', 'false')

import app as appmod  # noqa: E402  (loyiha ildizidagi app.py)

# Konsol kodlashuvi (cp1254/cp1251) unicode belgilarni chop eta olmaydi —
# chiqish UTF-8 ga majburlanadi (aks holda skript yiqiladi).
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

PASSWORD = (os.getenv('TP_STAFF_PASSWORD') or '').strip()

ACCOUNTS = [
    ('BOSHLIQ', '+998901234554', 'boss'),
    ('ADMIN', '+998908480921', 'admin'),
    ('MANAGER', '+998902750921', 'manager'),
    ('CASHIER', '+998905450921', 'cashier'),
]

PHONE_VARIANTS = {
    '+998901234554': ['+998901234554', '+998 90 123 45 54', '998901234554', '901234554'],
    '+998908480921': ['+998908480921', '+998 90 848 09 21', '998908480921', '908480921'],
    '+998902750921': ['+998902750921', '+998 90 275 09 21', '998902750921'],
    '+998905450921': ['+998905450921', '+998 90 545 09 21', '998905450921'],
}

results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(f'{"PASS" if ok else "FAIL"}  {name}{(" — " + detail) if detail else ""}')


def login(client, login, password):
    return client.post('/api/auth/login', json={'login': login, 'password': password})


def main() -> int:
    if not PASSWORD:
        print('[XATO] TP_STAFF_PASSWORD muhit o\'zgaruvchisi kerak.')
        return 2

    client = appmod.app.test_client()
    tokens = {}

    # 1) Har bir hisob uchun turli telefon formatlari
    for label, phone, role in ACCOUNTS:
        for variant in PHONE_VARIANTS[phone]:
            res = login(client, variant, PASSWORD)
            body = res.get_json() or {}
            ok = (res.status_code == 200 and body.get('status') == 'success'
                  and (body.get('user') or {}).get('role') == role)
            check(f'{label}: login "{variant}" → role={role}', ok,
                  f'HTTP {res.status_code} / {body.get("status")} / '
                  f'{(body.get("user") or {}).get("role")}')
            if res.status_code == 200 and not tokens.get(label):
                tokens[label] = body.get('token')

    # 2) Token + sessiya (refresh holati)
    for label, _phone, role in ACCOUNTS:
        token = tokens.get(label, '')
        check(f'{label}: token berildi', bool(token))
        if not token:
            continue
        res = client.get('/api/auth/session', headers={'Authorization': 'Bearer ' + token})
        body = res.get_json() or {}
        check(f'{label}: /api/auth/session (refresh) → role={role}',
              res.status_code == 200 and (body.get('user') or {}).get('role') == role,
              f'HTTP {res.status_code}')
        # Admin-only endpoint: RBAC ishlashini tekshiradi (Boshliq ham admin huquqiga ega)
        res_rbac = client.get('/api/security/sessions', headers={'Authorization': 'Bearer ' + token})
        if role in ('admin', 'boss'):
            check(f'{label}: /api/security/sessions (ruxsat)', res_rbac.status_code == 200,
                  f'HTTP {res_rbac.status_code}')
        else:
            check(f'{label}: /api/security/sessions bloklandi (403)',
                  res_rbac.status_code == 403, f'HTTP {res_rbac.status_code}')

    # 3) Logout: token olib tashlanganda sessiya yopiladi
    res = client.get('/api/auth/session', headers={'Authorization': 'Bearer '})
    check('Logout: tokensiz sessiya 401', res.status_code == 401, f'HTTP {res.status_code}')

    # 3b) Server tomonli logout: joriy sessiya bekor qilinadi
    if tokens.get('ADMIN'):
        res_logout = client.post('/api/auth/logout',
                                 headers={'Authorization': 'Bearer ' + tokens['ADMIN']})
        body_logout = res_logout.get_json() or {}
        check('POST /api/auth/logout → 200', res_logout.status_code == 200,
              f'HTTP {res_logout.status_code}')
        res_after = client.get('/api/auth/session',
                               headers={'Authorization': 'Bearer ' + tokens['ADMIN']})
        check('Logoutdan keyin eski token qabul qilinmaydi (401)',
              res_after.status_code == 401, f'HTTP {res_after.status_code}')

    # 4) Noto'g'ri parol
    res = login(client, '+998908480921', PASSWORD + 'xato')
    body = res.get_json() or {}
    check('ADMIN: noto\'g\'ri parol rad etildi (401)',
          res.status_code == 401 and body.get('code') == 'bad_credentials',
          f'HTTP {res.status_code} / {body.get("message")}')
    check('Xato xabari umumiy (hash/ichki ma\'lumot yo\'q)',
          'Telefon' in str(body.get('message', '')) or 'Login' in str(body.get('message', '')),
          str(body.get('message')))
    check('Javobda parol/hash yo\'q', PASSWORD not in json.dumps(body) and 'passHash' not in json.dumps(body))

    # 5) Noto'g'ri telefon
    res = login(client, '+998900000000', PASSWORD)
    check('Noto\'g\'ri telefon rad etildi (401)', res.status_code == 401, f'HTTP {res.status_code}')

    # 6) Eski parol ishlamasligi (123456)
    res = login(client, '+998902750921', '123456')
    check('Eski parol (123456) rad etildi', res.status_code == 401, f'HTTP {res.status_code}')

    # 7) Bazada ochiq parol yo'qligi
    staff = appmod.load_staff()
    leaked = [u.get('login') for u in staff if PASSWORD in json.dumps(u)]
    check('Bazada ochiq parol yo\'q (faqat xesh)', not leaked, str(leaked))

    # 8) Frontend (oflayn rejim) xeshlari baza bilan bir xil
    import re
    hashes = {str(u.get('login', '')).lower(): u.get('passHash') for u in staff}
    frontend_files = [
        'scripts.js',
        os.path.join('android', 'app', 'src', 'main', 'assets', 'scripts.js'),
    ]
    for path in frontend_files:
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        pairs = re.findall(r"login: '([^']+)'[^}]*passHash: '([0-9a-f]{64})'", src)
        quoted = re.findall(r"passHash:\s*'([^']*)'", src)
        for login_name, digest in pairs:
            if login_name.lower() in hashes:
                check(f'{path}: {login_name} xeshi baza bilan bir xil',
                      digest == hashes[login_name.lower()], digest[:16] + '…')
        check(f'{path}: ochiq parol yo\'q', PASSWORD not in src)
        check(f'{path}: eski xeshlar qolmagan',
              not any(h in src for h in ('847987bfe33b7e4354666fd0a6084ec34e6f09b60f673065a10735f8aa2b7057',
                                         'e3da606a986c263b7018487dfdbc9e8316898f0a1b68792106619ef867c97f41',
                                         '91416abaaa7af1470c242189d1cfe0d6658d1b2eee31a1fdcbd001426dfcc895')))
        check(f'{path}: barcha xeshlar sha256 (64 hex)',
              all(re.fullmatch(r'[0-9a-f]{64}', q) for q in quoted))

    # 9) Login sahifasi: rol kartochkalari yo'q, telefon+parol formasi bor
    with open('index.html', encoding='utf-8') as fh:
        html = fh.read()
    login_block = html[html.find('id="loginPage"'):html.find('id="app"')]
    check('Login sahifasida rol kartochkalari yo\'q',
          'role-card' not in login_block and 'data-role="admin' not in login_block)
    check('Login: telefon (type="tel") + parol maydonlari',
          'type="tel"' in login_block and 'id="loginPass"' in login_block
          and "id='loginPass'" not in login_block)
    check('Login: +998 prefiksi va eye tugmasi',
          '+998' in login_block and 'pass-toggle' in login_block)
    check('HTMLda ochiq parol yo\'q', PASSWORD not in html)

    # 10) Input sozlamalari (autofill xatolari tuzatilgan)
    import re as _re
    phone_input = _re.search(r'<input[^>]*id="loginPhone"[^>]*>', html)
    phone_tag = phone_input.group(0) if phone_input else ''
    check('Telefon: autocomplete="username" (tel-national emas)',
          'autocomplete="username"' in phone_tag, phone_tag[:120])
    check('Telefon: tel-national umuman yo\'q', 'tel-national' not in html)
    check('Telefon: type="tel" + inputmode="numeric"',
          'type="tel"' in phone_tag and 'inputmode="numeric"' in phone_tag)
    check('Telefon: default qiymat yo\'q (value= berilmagan)', 'value=' not in phone_tag)

    pass_input = _re.search(r'<input[^>]*id="loginPass"[^>]*>', html)
    pass_tag = pass_input.group(0) if pass_input else ''
    check('Parol: type="password" (standart holat yashirin)',
          'type="password"' in pass_tag, pass_tag[:120])
    check('Parol: autocomplete="current-password"',
          'autocomplete="current-password"' in pass_tag)
    check('Parol: default qiymat yo\'q (value= berilmagan)', 'value=' not in pass_tag)
    check('Parol: maska ko\'rinishi (12 ta •)',
          'placeholder="' + '•' * 12 + '"' in pass_tag)

    # 11) JS qo'riqchilari: parol hech qachon ochiq qolmaydi
    for path in frontend_files:
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        for fn in ('setLoginPasswordVisible', 'enforceLoginPasswordHidden',
                   'initLoginPasswordGuard', 'initLoginPhoneAutofillGuard', 'formatLoginPhoneField'):
            check(f'{path}: {fn}() mavjud', f'function {fn}(' in src)
        check(f'{path}: MutationObserver orqali type himoyasi',
              'attributeFilter: [\'type\']' in src)
        check(f'{path}: initLoginPasswordGuard() chaqirilgan',
              'initLoginPasswordGuard();' in src)
        check(f'{path}: togglePassword faqat setLoginPasswordVisible ishlatadi',
              'setLoginPasswordVisible(inp.type === \'password\')' in src)

    failed = [r for r in results if not r[1]]
    print(f'\nJami: {len(results)} tekshiruv, {len(results) - len(failed)} PASS, {len(failed)} FAIL')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
