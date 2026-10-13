"""Tuzatishlarni JONLI tekshirish (klon baza + vaqtinchalik server).

Har bir tekshiruv PASS/FAIL chiqaradi; FAIL bo'lsa skript 1 bilan tugaydi.
Faqat /api/... interfeyslari ishlatiladi (foydalanuvchi ishlatadigan yo'l).
"""
import hashlib
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:5077'
DB = '.testdb/bughunt.db'
CLICK_SECRET = 'testsecret'
BOSS_PW = (os.getenv('BOSS_DEFAULT_PASSWORD') or '').strip()
if not BOSS_PW:
    sys.exit("XATO: BOSS_DEFAULT_PASSWORD muhit o'zgaruvchisi kerak (parol kodda saqlanmaydi).")
LEGACY_OK = lambda h: bool(h) and not str(h).startswith('pbkdf2_sha256$')
results = []


def req(method, path, data=None, token=None, raw=None, form=None):
    hdrs, body = {}, None
    if raw is not None:
        body = raw if isinstance(raw, bytes) else raw.encode()
        hdrs['Content-Type'] = 'application/json'
    elif form is not None:
        body = urllib.parse.urlencode(form).encode()
        hdrs['Content-Type'] = 'application/x-www-form-urlencoded'
    elif data is not None:
        body = json.dumps(data).encode()
        hdrs['Content-Type'] = 'application/json'
    if token:
        hdrs['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(BASE + path, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def check(name, condition, detail=''):
    results.append((name, bool(condition), detail))
    print(('  PASS  ' if condition else '  FAIL  ') + name + (f'   [{detail}]' if detail else ''))


def login(login_name, password):
    status, raw = req('POST', '/api/auth/login', {'login': login_name, 'password': password})
    return json.loads(raw)['token'] if status == 200 else None


def db_data():
    con = sqlite3.connect(DB)
    try:
        return dict(con.execute('select key, value from store_data'))
    finally:
        con.close()


def staff_rows():
    return json.loads(db_data().get('staff_users') or '[]')


def sales_rows():
    return json.loads(db_data().get('sales') or '[]')


def find_sale(sid):
    return next((s for s in sales_rows() if s.get('id') == sid), {})


print('=' * 78)
print("A) PAROL XESHI: eski SHA-256 dan PBKDF2 ga o'tish (akountlar ishlaydi)")
print('=' * 78)
legacy_before = [u.get('login') for u in staff_rows() if LEGACY_OK(u.get('passHash'))]
print(f"  (eski xeshli akountlar: {len(legacy_before)} ta)")

status, _ = req('GET', '/api/security/status')
check('/api/security/status (anonim) -> 401', status == 401, f'HTTP {status}')

admin = login('admin@texnopark.uz', '123456')
check('Eski SHA-256 xesh bilan login ishlaydi (moslik saqlangan)', admin is not None)

rows = staff_rows()
admin_row = next((u for u in rows if u.get('login') == 'admin@texnopark.uz'), {})
check('Kirishdan keyin xesh PBKDF2 ga otdi',
      str(admin_row.get('passHash', '')).startswith('pbkdf2_sha256$'),
      str(admin_row.get('passHash'))[:30] + '...')
now_legacy = [u.get('login') for u in rows if LEGACY_OK(u.get('passHash'))]
check('Aynan bitta akount yangilandi (qolganlariga tegilmadi)',
      len(now_legacy) == len(legacy_before) - 1, f'{len(legacy_before)} -> {len(now_legacy)}')

admin2 = login('admin@texnopark.uz', '123456')
check('Yangi PBKDF2 xesh bilan qayta login ishlaydi', admin2 is not None)
check('Noto\'g\'ri parol hamon rad etiladi',
      req('POST', '/api/auth/login', {'login': 'admin@texnopark.uz', 'password': 'xato'})[0] == 401)

cashier = login('cashier@texnopark.uz', 'cashier123')
check('Kassir login ishlaydi', cashier is not None)
boss = login('+998901234554', BOSS_PW)
check('Boshliq login ishlaydi', boss is not None)

status, raw = req('GET', '/api/security/status', token=admin2)
check('/api/security/status (admin) -> 200', status == 200, f'HTTP {status}')
check('  javobda maxfiy parol qiymati yo\'q',
      BOSS_PW not in raw.decode('utf-8', 'replace') and 'testsecret' not in raw.decode('utf-8', 'replace'))
status, _ = req('GET', '/api/security/status', token=cashier)
check('/api/security/status (kassir) -> 403', status == 403, f'HTTP {status}')
status, _ = req('GET', '/api/security/status', token=boss)
check('/api/security/status (boshliq) -> 200', status == 200, f'HTTP {status}')

print()
print('=' * 78)
print('B) CATCH-ALL MARSHRUT (405 vs 404) va statik oq ro\'yxat')
print('=' * 78)
status, _ = req('GET', '/api/sync')
check('GET /api/sync (faqat POST) -> 405', status == 405, f'HTTP {status}')
status, _ = req('GET', '/api/boss/staff/1')
check('GET /api/boss/staff/1 (faqat PUT/DELETE) -> 405', status == 405, f'HTTP {status}')
status, _ = req('GET', '/api/definitely-not-here')
check('GET /api/definitely-not-here -> 404', status == 404, f'HTTP {status}')
for path in ['/.env', '/app.py', '/.git/HEAD', '/.testdb/bughunt.db']:
    status, _ = req('GET', path)
    check(f'GET {path} -> 404', status == 404, f'HTTP {status}')
status, _ = req('GET', '/api/data')
check('GET /api/data -> 401 (o\'zgarmagan)', status == 401, f'HTTP {status}')
status, _ = req('GET', '/api/catalog')
check('GET /api/catalog -> 200 (ommaviy, o\'zgarmagan)', status == 200, f'HTTP {status}')

print()
print('=' * 78)
print('C) NaN / Infinity — butun ilovani o\'chiruvchi xato (asosiy tuzatish)')
print('=' * 78)
before = len(sales_rows())
status, raw = req('POST', '/api/sync', raw='{"sales":[{"id":1,"total":NaN,"date":"13.10.2026"}]}', token=admin2)
check('total=NaN -> 400', status == 400, raw[:80].decode('utf-8', 'replace'))
status, _ = req('POST', '/api/sync', raw='{"sales":[{"id":1,"total":Infinity,"date":"13.10.2026"}]}', token=admin2)
check('total=Infinity -> 400', status == 400)
status, _ = req('POST', '/api/sync', raw='{"sales":[{"id":1,"total":100,"items":[{"id":1,"qty":1,"price":NaN}]}]}', token=admin2)
check('items[].price=NaN -> 400', status == 400)
status, _ = req('POST', '/api/sync', {'sales': [{'id': 1, 'total': -5}]}, token=admin2)
check('total=-5 -> 400', status == 400)
status, _ = req('POST', '/api/sync', {'sales': [{'id': 1, 'total': 'abc'}]}, token=admin2)
check('total="abc" -> 400', status == 400)
status, _ = req('POST', '/api/sync', raw='{"sales":[{"id":1,"total":100,"extra":{"deep":NaN}}]}', token=admin2)
check('nested NaN (chuqur tekshiruv) -> 400', status == 400)
status, _ = req('POST', '/api/sync', {'products': [{'id': 1, 'name': 'X', 'cat': 'Y', 'price': 1, 'stock': 1, 'img': 'javascript:alert(1)'}]}, token=admin2)
check('img=javascript: -> 400 (o\'zgarmagan)', status == 400)
check('NaN urinishlaridan keyin baza o\'zgarmadi', len(sales_rows()) == before, f'{before} -> {len(sales_rows())}')

status, _ = req('POST', '/api/sync', {'sales': [{'id': 5001, 'total': 100000, 'date': '13.10.2026',
                                                 'status': 'paid', 'cashier': 'Boshliq Admin',
                                                 'items': [{'id': 1, 'name': 'Telefon',
                                                            'price': 100000, 'qty': 1, 'cost': 80000}]}]},
                token=admin2)
check('To\'g\'ri savdo qabul qilindi (regressiya)', status == 200, f'HTTP {status}')
check('  savdo bazaga yozildi', len(sales_rows()) == 1, f'count={len(sales_rows())}')

status, raw = req('GET', '/api/data', token=admin2)
body = raw.decode('utf-8', 'replace')
check('GET /api/data -> 200, JSON standartiga mos (NaN/Infinity yo\'q)',
      status == 200 and 'NaN' not in body and 'Infinity' not in body)
try:
    json.loads(body)
    ok_parse = True
except Exception:
    ok_parse = False
check('  Python json.parse muvaffaqiyatli', ok_parse)

print()
print('=' * 78)
print('D) MA\'LUMOT YO\'QOTISHDAN HIMOYA (kassir tarixni o\'chira olmasin)')
print('=' * 78)
status, _ = req('POST', '/api/sync', {'sales': []}, token=cashier)
check('kassir {"sales": []} -> so\'rov qabul qilinadi (POS ishlamay qolmaydi)',
      status == 200, f'HTTP {status}')
check('  LEKIN savdo tarixi bazada SAQLANIB qoldi', len(sales_rows()) == 1,
      f'count={len(sales_rows())}')
status, _ = req('POST', '/api/sync', {'sales': [{'id': 6001, 'total': 5000, 'date': '13.10.2026',
                                                 'status': 'paid', 'cashier': 'Karimov Kassir',
                                                 'items': []}]}, token=cashier)
check('kassir YANGI savdo qo\'sha oladi (asosiy oqim uzilmadi)', status == 200, f'HTTP {status}')
check('  yangi + eski savdo ikkisi ham bor', len(sales_rows()) == 2, f'count={len(sales_rows())}')
logs = json.loads(db_data().get('serverSecurityLog') or '[]')
blocked = [e for e in logs if e.get('type') == 'sync-delete-blocked']
check('O\'chirishga urinish xavfsizlik jurnaliga yozildi', bool(blocked),
      (blocked[-1].get('message', '')[:70] if blocked else 'yozuv yo\'q'))
status, _ = req('POST', '/api/sync', {'sales': []}, token=admin2)
check('admin o\'chirish huquqini saqlab qoldi (siyosat o\'zgarmagan)', status == 200, f'HTTP {status}')
check('  admin o\'chirgach baza bo\'sh', len(sales_rows()) == 0, f'count={len(sales_rows())}')

print()
print('=' * 78)
print('E) CLICK WEBHOOK (muvaffaqiyatsiz to\'lov "to\'landi" bo\'lib qolmasin)')
print('=' * 78)
req('POST', '/api/sync', {'sales': [{'id': 9001, 'total': 100000, 'date': '13.10.2026',
                                     'status': 'pending', 'items': []}]}, token=admin2)


def click_sign(trans_id, service_id, merchant_trans_id, amount, action, sign_time, prepare_id=''):
    """Click protokoli bo'yicha imzo (action=1 da prepare_id qatnashadi)."""
    mid = str(prepare_id) if str(action) == '1' else ''
    raw = (f'{trans_id}{service_id}{CLICK_SECRET}{merchant_trans_id}'
           f'{mid}{amount}{action}{sign_time}')
    return hashlib.md5(raw.encode()).hexdigest()


def click_post(**kwargs):
    return req('POST', '/api/payment/click', form=kwargs)


SIGN_TIME = '2026-10-13 23:00:00'
# 1) Prepare
status, raw = click_post(click_trans_id='111', service_id='222', merchant_trans_id='9001',
                         amount='100000', action='0', sign_time=SIGN_TIME,
                         sign_string=click_sign('111', '222', '9001', '100000', '0', SIGN_TIME),
                         error='0')
body = json.loads(raw)
check('Prepare (action=0) muvaffaqiyatli', body.get('error') == 0, str(body)[:70])
check('  prepare_id eslab qolindi', find_sale(9001).get('clickPrepareId') == 111,
      str(find_sale(9001).get('clickPrepareId')))

# 2) Click to'lovni bekor qildi: error != 0
status, raw = click_post(click_trans_id='111', service_id='222', merchant_trans_id='9001',
                         amount='100000', action='1', sign_time=SIGN_TIME,
                         sign_string=click_sign('111', '222', '9001', '100000', '1', SIGN_TIME, '111'),
                         error='-1', error_note='Insufficient funds', merchant_prepare_id='111')
body = json.loads(raw)
check('error != 0 (Click bekor qildi) -> rad etiladi', body.get('error') == -9, str(body)[:70])
check('  savdo "paid" bo\'lib qolmadi', find_sale(9001).get('status') == 'pending',
      str(find_sale(9001).get('status')))

# 3) Noto'g'ri imzo
status, raw = click_post(click_trans_id='111', service_id='222', merchant_trans_id='9001',
                         amount='100000', action='1', sign_time=SIGN_TIME,
                         sign_string='0' * 32, error='0', merchant_prepare_id='111')
check('Noto\'g\'ri imzo -> rad etiladi', json.loads(raw).get('error') == -1,
      raw[:60].decode('utf-8', 'replace'))

# 4) prepare_id mos emas (imzo to'g'ri, lekin 999 yuborilgan)
status, raw = click_post(click_trans_id='111', service_id='222', merchant_trans_id='9001',
                         amount='100000', action='1', sign_time=SIGN_TIME,
                         sign_string=click_sign('111', '222', '9001', '100000', '1', SIGN_TIME, '999'),
                         error='0', merchant_prepare_id='999')
body = json.loads(raw)
check('merchant_prepare_id mos emas -> rad etiladi (yangi tekshiruv)',
      body.get('error') == -1 and 'Prepare' in str(body.get('error_note')), str(body)[:80])

# 5) To'g'ri imzo + to'g'ri prepare_id
status, raw = click_post(click_trans_id='111', service_id='222', merchant_trans_id='9001',
                         amount='100000', action='1', sign_time=SIGN_TIME,
                         sign_string=click_sign('111', '222', '9001', '100000', '1', SIGN_TIME, '111'),
                         error='0', merchant_prepare_id='111')
body = json.loads(raw)
check('To\'g\'ri imzo + prepare_id -> to\'lov tasdiqlandi', body.get('error') == 0, str(body)[:70])
check('  savdo endi "paid"', find_sale(9001).get('status') == 'paid',
      str(find_sale(9001).get('status')))
check('  logs\'ga paydoc id yozildi',
      any('Click Webhook' in str(l.get('type')) for l in json.loads(db_data().get('logs') or '[]')))

print()
print('=' * 78)
print('F) /api/reports — spam himoyasi va xato matni')
print('=' * 78)
# Limit: soatiga 5 ta (limit HAR so'rovda hisoblanadi, shu sababli tartib aniq)
status, raw = req('POST', '/api/reports', {'message': ''})
check('Bo\'sh xabar -> 400', status == 400, f'HTTP {status}')
status, raw = req('POST', '/api/reports', {'message': 'x' * 5000})
check('Uzun xabar -> 200 (2000 belgiga qisqartiriladi)', status == 200, f'HTTP {status}')
codes = [req('POST', '/api/reports', {'message': f'sinov {i}'})[0] for i in range(3)]
check('Limit ichida qabul qilinadi', codes == [200, 200, 200], str(codes))
status, _ = req('POST', '/api/reports', {'message': 'limitdan keyin'})
check('Limitdan keyin -> 429 (yangi himoya)', status == 429, f'HTTP {status}')

print()
print('=' * 78)
print('G) REGRESSIYA — boshliq paneli va kassa ishlashda davom etadimi?')
print('=' * 78)
for path in ['/api/boss/overview', '/api/boss/staff', '/api/boss/finance', '/api/boss/audit',
             '/api/boss/reports', '/api/boss/charts', '/api/boss/products', '/api/boss/branches']:
    status, _ = req('GET', path, token=boss)
    check(f'boss GET {path} -> 200', status == 200, f'HTTP {status}')
status, _ = req('GET', '/api/boss/overview', token=admin2)
check('admin GET /api/boss/overview -> 403 (o\'zgarmagan)', status == 403, f'HTTP {status}')
status, _ = req('GET', '/api/data', token=cashier)
check('kassir GET /api/data -> 200 (kassa ishlaydi)', status == 200, f'HTTP {status}')
status, _ = req('GET', '/api/fiscal/status', token=cashier)
check('kassir GET /api/fiscal/status -> 200', status == 200, f'HTTP {status}')
status, _ = req('GET', '/api/auth/session', token=boss)
check('boss GET /api/auth/session -> 200', status == 200, f'HTTP {status}')
status, raw = req('GET', '/api/boss/staff/1/password', token=boss)
check('boss parol ko\'rish endpointi ishlaydi (ataylab qoldirilgan)', status == 200, f'HTTP {status}')

print()
print('=' * 78)
failed = [n for n, ok, _ in results if not ok]
passed = len(results) - len(failed)
print(f'YAKUN: {passed}/{len(results)} PASS')
if failed:
    print('YIQILGAN:')
    for name in failed:
        print('  - ' + name)
    sys.exit(1)
print('Hamma tekshiruv o\'tdi.')
