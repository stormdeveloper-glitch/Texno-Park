"""Jonli HTTP tekshiruv (faqat klon bazadagi vaqtinchalik serverga qarshi)."""
import json
import os
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:5077'


def req(method, path, data=None, token=None, headers=None, form=False):
    url = BASE + path
    body = None
    hdrs = dict(headers or {})
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            hdrs.setdefault('Content-Type', 'application/x-www-form-urlencoded')
        else:
            body = json.dumps(data).encode()
            hdrs.setdefault('Content-Type', 'application/json')
    if token:
        hdrs['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as resp:
            raw = resp.read()
            return resp.status, raw
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def show(label, status, raw, limit=220):
    text = raw.decode('utf-8', 'replace')
    print(f'{label:52s} HTTP {status}  {len(raw):>7} B  {text[:limit].replace(chr(10), " ")}')


import urllib.parse  # noqa: E402

print('=' * 100)
print('1) STATIK FAYL OQ RO\'YXATI (avvalgi audit tuzatishi regressiyasi)')
print('=' * 100)
for path in ['/.env', '/.env.example', '/app.py', '/fiscal.py', '/.git/HEAD', '/.gitignore',
             '/requirements.txt', '/Data/database.db', '/scripts_backup.js', '/LICENSE',
             '/android/app/src/main/assets/scripts.js', '/assets/../.env', '//.env',
             '/%2eenv', '/.testdb/bughunt.db', '/_bug_server.log', '/mobile_app/pubspec.yaml']:
    status, raw = req('GET', path)
    show(path, status, raw, 60)

print()
print('1b) RUXSAT ETILGAN statik fayllar')
for path in ['/', '/index.html', '/style.css', '/scripts.js', '/boss.js', '/tour.js',
             '/qrcode.min.js', '/favicon.png', '/robots.txt']:
    status, raw = req('GET', path)
    show(path, status, raw, 40)

print()
print('=' * 100)
print('2) AUTENTIFIKATSIYASIZ OCHIQ API\'LAR')
print('=' * 100)
for path in ['/api/config', '/api/catalog', '/api/branches', '/api/branches/summary',
             '/api/health', '/api/security/status', '/api/payments/config',
             '/api/data', '/api/boss/overview', '/api/boss/staff', '/api/auth/staff',
             '/api/security/sessions', '/api/payments/orders', '/api/fiscal/status',
             '/api/storage/check', '/api/assistant/chat']:
    status, raw = req('GET', path)
    show(path, status, raw, 160)

print()
print('=' * 100)
print('3) LOGIN (klon bazadagi standart parollar)')
print('=' * 100)
tokens = {}
for login, pwd in [('+998908480921', '123456'), ('admin@texnopark.uz', '123456'),
                   ('+998905450921', '123456'), ('+998902750921', '123456'),
                   (os.environ['BOSS_DEFAULT_PASSWORD'], ), ('customer', '123456')]:
    status, raw = req('POST', '/api/auth/login', {'login': login, 'password': pwd})
    body = raw.decode('utf-8', 'replace')
    ok = '"status": "success"' in body or '"status":"success"' in body
    who = ''
    if ok:
        payload = json.loads(body)
        tokens[payload['user']['role']] = payload['token']
        who = f"role={payload['user']['role']} name={payload['user']['name']} mustChange={payload['mustChangePassword']}"
    show(f'login {login} / {pwd}', status, raw, 130)
    if ok:
        print(' ' * 54 + '↳ ' + who)

print()
print('=' * 100)
print('4) RBAC CHEGARALARI (cashier bilan boss/admin endpointlariga)')
print('=' * 100)
cash = tokens.get('cashier')
adm = tokens.get('admin')
boss = tokens.get('boss')
print('tokenlar:', {k: (v[:12] + '...') for k, v in tokens.items()})
if cash:
    for path in ['/api/boss/overview', '/api/boss/staff', '/api/boss/finance', '/api/boss/audit',
                 '/api/boss/reports', '/api/boss/products', '/api/boss/branches',
                 '/api/boss/charts', '/api/security/sessions', '/api/payments/orders',
                 '/api/assistant/chat']:
        status, raw = req('GET', path, token=cash)
        show(f'cashier GET {path}', status, raw, 110)
    status, raw = req('POST', '/api/assistant/chat', {'message': 'salom'}, token=cash)
    show('cashier POST /api/assistant/chat', status, raw, 110)
if adm:
    status, raw = req('GET', '/api/boss/staff/1/password', token=adm)
    show('admin GET /api/boss/staff/1/password', status, raw, 200)
    status, raw = req('GET', '/api/boss/staff/9/password', token=adm)
    show('admin GET /api/boss/staff/9/password (boshqa admin)', status, raw, 200)
if boss:
    status, raw = req('GET', '/api/boss/staff/1/password', token=boss)
    show('boss GET /api/boss/staff/1/password', status, raw, 240)

print()
print('=' * 100)
print('5) VALIDATSIYA / INJECTION SINOVLARI')
print('=' * 100)
if adm:
    status, raw = req('POST', '/api/sync',
                      {'products': [{'id': 1, 'name': 'X', 'cat': 'Y', 'price': 'abc', 'stock': 1}]},
                      token=adm)
    show('sync: price="abc"', status, raw, 160)
    status, raw = req('POST', '/api/sync',
                      {'products': [{'id': 1, 'name': 'X', 'cat': 'Y', 'price': -5, 'stock': 1}]},
                      token=adm)
    show('sync: price=-5', status, raw, 160)
    status, raw = req('POST', '/api/sync',
                      {'products': [{'id': 1, 'name': 'X', 'cat': 'Y', 'price': 1, 'stock': 1,
                                     'img': 'javascript:alert(1)'}]}, token=adm)
    show('sync: img=javascript:', status, raw, 160)
    status, raw = req('POST', '/api/sync',
                      {'sales': [{'id': 1, 'total': 100, 'fiscalSign': 'SOXTA'}]}, token=adm)
    show('sync: soxta fiscalSign', status, raw, 200)
    status, raw = req('POST', '/api/sync', {'unknownKey': [1, 2, 3]}, token=adm)
    show('sync: noma\'lum kalit', status, raw, 160)
    status, raw = req('POST', '/api/sync', {'settings': {'x': 'y'}}, token=adm)
    show('sync: settings', status, raw, 160)
    status, raw = req('POST', '/api/sync', {'products': [{'id': 1, 'name': 'X', 'cat': 'Y',
                                                          'price': 100, 'stock': 5,
                                                          'branchId': {'a': 1}}]}, token=adm)
    show('sync: branchId=obyekt', status, raw, 160)

print()
print('=' * 100)
print('6) BOSHQA XAVFSIZLIK SINOVLARI')
print('=' * 100)
status, raw = req('POST', '/api/reports', {'type': 'spam', 'message': 'test ' * 20})
show('POST /api/reports (autentifikatsiyasiz)', status, raw, 120)
status, raw = req('POST', '/api/reports', {'message': 'x', 'user': '<script>alert(1)</script>'})
show('POST /api/reports: user=XSS', status, raw, 120)
status, raw = req('POST', '/api/upload')
show('POST /api/upload (authsiz)', status, raw, 120)
status, raw = req('POST', '/api/payments/mark-paid', {'orderId': 'x'})
show('POST /api/payments/mark-paid (authsiz)', status, raw, 120)
status, raw = req('POST', '/api/payment/click', {'click_trans_id': '1', 'action': '1'}, form=True)
show('POST /api/payment/click (imzosiz)', status, raw, 160)
status, raw = req('GET', '/api/payment/status/1')
show('GET /api/payment/status/1 (authsiz)', status, raw, 120)
status, raw = req('GET', '/api/media/products/x.jpg')
show('GET /api/media/products/x.jpg', status, raw, 80)
status, raw = req('GET', '/api/media/../../.env')
show('GET /api/media/../../.env', status, raw, 80)
status, raw = req('GET', '/uploads/../.env')
show('GET /uploads/../.env', status, raw, 80)
status, raw = req('GET', '/api/media/products/ok.png')
show('GET /api/media/products/ok.png', status, raw, 80)

print()
print('=' * 100)
print('7) METOD CHEGARALARI (GET orqali yozish / OPTIONS)')
print('=' * 100)
for method, path in [('GET', '/api/sync'), ('PUT', '/api/boss/staff/1'), ('DELETE', '/api/boss/staff/1'),
                     ('GET', '/api/boss/staff/1')]:
    status, raw = req(method, path, token=adm)
    show(f'{method} {path} (admin)', status, raw, 120)
