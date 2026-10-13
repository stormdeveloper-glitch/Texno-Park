"""2-tekshiruv: RBAC matritsasi, NaN, sync orqali ma'lumot yo'qotish."""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:5077'


def req(method, path, data=None, token=None, raw_body=None, form=False):
    url = BASE + path
    body = None
    hdrs = {}
    if raw_body is not None:
        body = raw_body if isinstance(raw_body, bytes) else raw_body.encode()
        hdrs['Content-Type'] = 'application/json'
    elif data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            hdrs['Content-Type'] = 'application/x-www-form-urlencoded'
        else:
            body = json.dumps(data).encode()
            hdrs['Content-Type'] = 'application/json'
    if token:
        hdrs['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(request, timeout=25) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def show(label, status, raw, limit=180):
    text = raw.decode('utf-8', 'replace')
    print(f'{label:56s} HTTP {status}  {len(raw):>7} B  {text[:limit]}')


def login(login_name, password):
    status, raw = req('POST', '/api/auth/login', {'login': login_name, 'password': password})
    if status == 200:
        return json.loads(raw)['token']
    print(f'login {login_name} failed: {status} {raw[:120]}')
    return None


cashier = login('cashier@texnopark.uz', 'cashier123')
manager = login('manager@texnopark.uz', 'manager123')
admin = login('admin@texnopark.uz', '123456')
boss = login('+998901234554', os.environ['BOSS_DEFAULT_PASSWORD'])
customer = login('customer', '123456')
print('tokens:', {k: bool(v) for k, v in
                  [('cashier', cashier), ('manager', manager), ('admin', admin),
                   ('boss', boss), ('customer', customer)]})

print()
print('=' * 100)
print('A) ROLLAR BO\'YICHA RUXSAT MATRITSASI')
print('=' * 100)
actors = [('anonim', None), ('customer', customer), ('cashier', cashier),
          ('manager', manager), ('admin', admin), ('boss', boss)]
paths = ['/api/data', '/api/boss/overview', '/api/boss/staff', '/api/boss/finance',
         '/api/boss/audit', '/api/security/sessions', '/api/payments/orders']
print(f'{"endpoint":28s}' + ''.join(f'{n:>10s}' for n, _ in actors))
for path in paths:
    row = f'{path:28s}'
    for name, token in actors:
        status, _ = req('GET', path, token=token)
        row += f'{status:>10d}'
    print(row)

print()
print('B) YOZISH AMALLARI')
print(f'{"endpoint":34s}' + ''.join(f'{n:>10s}' for n, _ in actors))
writes = [('POST', '/api/boss/staff'), ('POST', '/api/boss/password'),
          ('POST', '/api/fiscal/pending/run'), ('POST', '/api/uploads'),
          ('POST', '/api/auth/staff')]
for method, path in writes:
    row = f'{method + " " + path:34s}'
    for name, token in actors:
        status, _ = req(method, path, {}, token=token)
        row += f'{status:>10d}'
    print(row)

print()
print('=' * 100)
print('C) KASSA XODIMI SAVDO TARIXINI O\'CHIRA OLADIMI? (/api/sync)')
print('=' * 100)
if cashier:
    status, raw = req('POST', '/api/sync', {'sales': []}, token=cashier)
    show('cashier POST /api/sync {"sales": []}', status, raw)
    status, raw = req('GET', '/api/data', token=cashier)
    if status == 200:
        data = json.loads(raw)
        print(' ' * 56 + f'-> bazadagi sales soni: {len(data.get("sales") or [])}')

if cashier:
    status, raw = req('POST', '/api/sync', {'products': [
        {'id': 1, 'name': 'SOXTA', 'cat': 'SOXTA', 'price': 1, 'stock': 999}]},
        token=cashier)
    show('cashier POST /api/sync (narx=1 ga tushirish)', status, raw)
    status, raw = req('GET', '/api/data', token=cashier)
    if status == 200:
        data = json.loads(raw)
        print(' ' * 56 + f'-> mahsulot: {json.dumps(data.get("products"), ensure_ascii=False)[:150]}')

print()
print('=' * 100)
print('D) NaN / Infinity — JSON buzilishi (butun ilova ishlamay qolishi)')
print('=' * 100)
if admin:
    body = b'{"sales": [{"id": 777, "total": NaN, "date": "13.10.2026", "items": []}]}'
    status, raw = req('POST', '/api/sync', raw_body=body, token=admin)
    show('admin POST /api/sync total=NaN', status, raw)
    status, raw = req('GET', '/api/data', token=admin)
    show('GET /api/data (NaN bazada)', status, raw, 200)
    if status == 200:
        text = raw.decode('utf-8', 'replace')
        print('  -> javob ichida NaN bormi?', 'NaN' in text)
        try:
            json.loads(text)
            print('  -> JSON.parse (Python) OK')
        except Exception as exc:
            print('  -> JSON BUZILGAN:', exc)
    status, raw = req('GET', '/api/boss/overview', token=boss)
    show('boss GET /api/boss/overview (NaN bazada)', status, raw, 200)

    body = b'{"products": [{"id": 555, "name": "INF", "cat": "X", "price": Infinity, "stock": 1}]}'
    status, raw = req('POST', '/api/sync', raw_body=body, token=admin)
    show('admin POST /api/sync price=Infinity', status, raw)

print()
print('=' * 100)
print('E) SESSIYA / TOKEN XAVFSIZLIGI')
print('=' * 100)
if cashier:
    status, raw = req('POST', '/api/auth/logout', {}, token=cashier)
    show('cashier logout', status, raw)
    status, raw = req('GET', '/api/data', token=cashier)
    show('logoutdan keyin /api/data (eski token)', status, raw, 120)

for label, token in [('buzilgan imzo', 'abc.def'), ('bo\'sh', ''), ('sarlavhasiz token', None)]:
    status, raw = req('GET', '/api/data', token=token)
    show(f'/api/data token={label}', status, raw, 100)

print()
print('=' * 100)
print('F) IDOR — boshqa filial/xodim resurslariga kirish')
print('=' * 100)
if manager:
    for sid in (1, 2, 9):
        status, raw = req('GET', f'/api/boss/staff/{sid}/sales', token=manager)
        show(f'manager GET /api/boss/staff/{sid}/sales', status, raw, 120)
    status, raw = req('POST', f'/api/branches/FAKE/status', {'status': 'active'}, token=manager)
    show('manager POST /api/branches/FAKE/status', status, raw, 120)
    status, raw = req('DELETE', '/api/branches/FAKE', token=manager)
    show('manager DELETE /api/branches/FAKE', status, raw, 120)
