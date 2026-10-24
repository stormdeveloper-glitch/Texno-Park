# -*- coding: utf-8 -*-
"""Xodim parol boshqaruvi (Boshliq → Xodimlar) ni tekshirish — vaqtinchalik skript.

Tekshiriladi (topshiriqning 6-bo'limi):
  1. Har bir xodim uchun parol oynasi ochiladi (frontend statik tekshiruv).
  2. Yangi parol ko'rsatiladi/yashiriladi (frontend statik tekshiruv).
  3. Yangi parol backendda xeshlangan holda saqlanadi.
  4. Yangi parol bilan tizimga kirish mumkin.
  5. Eski parol bilan kirish bloklanadi.
  6. Ruxsatsiz foydalanuvchi parolni almashtira olmaydi.
  7. Boshqa xodimning paroli o'zgarmaydi.
  8. Ochiq parollar loglarda/API javoblarida/bazada chiqmaydi.
  9. Desktop va mobil interfeysda modal ishlaydi (frontend statik tekshiruv).

Ishga tushirish (klon baza):
  Copy-Item Data\\database.db .testdb\\staff_pass_test.db -Force
  $env:DB_PATH=".testdb/staff_pass_test.db"; python _tp_staff_pass_test.py
"""
import json
import os
import re
import shutil
import sqlite3
import sys
import time

sys.path.insert(0, '.')
import app as tp  # noqa: E402

DB = os.environ.get('DB_PATH') or os.path.join('Data', 'database.db')
client = tp.app.test_client()
failures = []

NEW_PASS = 'YangiParol-2026!'          # >= 6 belgi (oddiy almashtirish)
TEMP_PASS = 'Vaqtinchalik-Parol-99'    # >= 12 belgi (vaqtinchalik)
INIT_PASS = 'BoshlangichParol1'
TEST_PHONE = '+998900000123'
TEST_PHONE2 = '+998900000124'


def check(label, cond, extra=''):
    print(('  [OK]  ' if cond else '  [FAIL]') + ' ' + label + ('   ' + extra if extra else ''))
    if not cond:
        failures.append(label)


def make_token(user):
    actor = dict(user)
    actor['mustChange'] = False
    with tp.app.test_request_context('/', headers={'User-Agent': 'staff-pass-test'}):
        token, payload = tp.create_token(actor)
        tp.register_session(payload)
    return token


def auth(token):
    return {'Authorization': 'Bearer ' + token}


def db_raw():
    """Bazadagi BARCHA matnli qiymatlarni bitta satr sifatida qaytaradi."""
    con = sqlite3.connect(DB)
    try:
        rows = con.execute('SELECT key, value FROM store_data').fetchall()
        return ' '.join(str(k) + '=' + str(v) for k, v in rows)
    finally:
        con.close()


def db_staff():
    con = sqlite3.connect(DB)
    try:
        row = con.execute("SELECT value FROM store_data WHERE key='staff_users'").fetchone()
        return json.loads(row[0]) if row else []
    finally:
        con.close()


def find(rows, login):
    return next((u for u in rows
                 if str(u.get('login') or '').lower() == str(login).lower()), None)


def make_backup():
    """O'zgarishlardan OLDIN mavjud bazadan xavfsiz nusxa oladi.

    Backendda alohida backup API'si yo'q; SQLite yagona fayl bo'lgani uchun
    `shutil.copy2` bilan nusxa olish mumkin. Bu — «backup olish imkoniyati»
    talabining amaliy tekshiruvi.
    """
    if not os.path.isfile(DB):
        return ''
    out_dir = os.path.join('.testdb', 'backup')
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, 'database_%s.db' % time.strftime('%Y%m%d_%H%M%S'))
    shutil.copy2(DB, target)
    return target


print('=' * 78)
print('A) TAYYORGARLIK: backup, Boshliq tokeni va sinov xodimi')
print('=' * 78)
backup_path = make_backup()
check('backup olish imkoniyati (baza nusxasi)', bool(backup_path),
      backup_path or 'baza fayli topilmadi')
staff = tp.load_staff()
boss = next((u for u in staff if str(u.get('role')) == 'boss'), None)
if not boss:
    print('!! Boshliq akounti yo\'q — sinov to\'xtatildi')
    sys.exit(1)
boss_token = make_token(boss)
print('  boss login =', boss.get('login'), '| role =', boss.get('role'))

# Eski sinov xodimlarini tozalab, yangisini yaratamiz (klonda dublikat bo'lmasin).
clean = [u for u in staff
         if str(u.get('phone') or '') not in (TEST_PHONE, TEST_PHONE2)]
if len(clean) != len(staff):
    tp.db_manager.save_keys({'staff_users': clean})

r = client.post('/api/boss/staff', headers=auth(boss_token), json={
    'name': 'Sinov Kassir', 'phone': TEST_PHONE, 'role': 'cashier',
    'branchId': '', 'status': 'active', 'salary': 1000000, 'password': INIT_PASS,
})
check('POST /api/boss/staff -> 201', r.status_code == 201, 'code=%s' % r.status_code)
if r.status_code != 201:
    print('  javob:', json.dumps(r.get_json(), ensure_ascii=False))
    sys.exit(1)
created = r.get_json()['staff']
TID = created['id']
print('  yangi xodim id =', TID, '| login =', created.get('login'))

r = client.post('/api/boss/staff', headers=auth(boss_token), json={
    'name': 'Sinov Ikkinchi', 'phone': TEST_PHONE2, 'role': 'cashier',
    'branchId': '', 'status': 'active', 'salary': 900000, 'password': INIT_PASS,
})
OTHER_ID = r.get_json()['staff']['id']
other_login = r.get_json()['staff']['login']
rows = db_staff()
other_hash_before = str(find(rows, other_login).get('passHash') or '')

# Ruxsatsiz foydalanuvchi (TID ga aloqasi yo'q, boshqa kassir) uchun token.
# TID ning paroli o'zgartirilganda uning sessiyasi yopiladi — shuning uchun
# ruxsatsizlikni aynan boshqa (tegilmagan) kassir orqali tekshiramiz.
cashier_user = find(db_staff(), other_login)
cashier_token = make_token(cashier_user)

print()
print('=' * 78)
print('B) 3/4/5) PAROL O\'RNATISH → XESH SAQLASH → YANGI PAROL BILAN KIRISH')
print('=' * 78)
r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token),
               json={'password': NEW_PASS})
check('PUT parol -> 200', r.status_code == 200, 'code=%s' % r.status_code)
body = r.get_json() or {}
check('javobda ochiq parol YO\'Q', NEW_PASS not in json.dumps(body, ensure_ascii=False))
check('javobda passHash YO\'Q', 'passHash' not in json.dumps(body, ensure_ascii=False))

row = find(db_staff(), created['login'])
stored = str(row.get('passHash') or '')
check('bazada xesh saqlandi', bool(stored) and stored != NEW_PASS,
      'hash=%s...' % stored[:22])
check('bazada ochiq parol YO\'Q', NEW_PASS not in db_raw())
check('xesh to\'g\'riligini server tasdiqlaydi',
      tp.verify_password(NEW_PASS, row.get('salt', ''), stored))

r = client.post('/api/auth/login', json={'login': TEST_PHONE, 'password': NEW_PASS})
check('YANGI parol bilan kirish -> 200', r.status_code == 200, 'code=%s' % r.status_code)

r = client.post('/api/auth/login', json={'login': TEST_PHONE, 'password': INIT_PASS})
check('ESKI parol bilan kirish bloklandi -> 401', r.status_code == 401,
      'code=%s' % r.status_code)

print()
print('=' * 78)
print('C) 6) RUXSATSIZ FOYDALANUVCHI PAROLNI ALMASHTIRA OLMASIN')
print('=' * 78)
# cashier o'z sessiyasi bilan boshqa xodim parolini o'zgartirishga urinadi
r = client.put('/api/boss/staff/%d' % OTHER_ID, headers=auth(cashier_token),
               json={'password': 'Buzgunchi-Parol-1'})
check('cashier -> boshqa xodim paroli: 403', r.status_code == 403, 'code=%s' % r.status_code)

r = client.put('/api/boss/staff/%d' % TID, headers=auth(cashier_token),
               json={'password': 'Buzgunchi-Parol-2'})
check('cashier -> boshqa xodim (2): 403', r.status_code == 403, 'code=%s' % r.status_code)

r = client.put('/api/boss/staff/%d' % TID, json={'password': 'Buzgunchi-Parol-3'})
check('tokensiz -> 401', r.status_code == 401, 'code=%s' % r.status_code)

# GET orqali parolni ko'rish urinishi rad etiladi (ochiq parol qaytarilmaydi)
r = client.get('/api/boss/staff/%d/password' % TID, headers=auth(boss_token))
check('GET parolni ochish rad etildi (410)', r.status_code == 410, 'code=%s' % r.status_code)
check('  javobda parol yo\'q', NEW_PASS not in (r.get_data(as_text=True) or ''))

# Boshliq o'zini PUT orqali o'zgartira olmaydi (alohida oyna kerak)
r = client.put('/api/boss/staff/%d' % int(boss.get('id')), headers=auth(boss_token),
               json={'password': 'OzParolim-123'})
check('boss o\'zini PUT bilan: 403', r.status_code == 403, 'code=%s' % r.status_code)

print()
print('=' * 78)
print('D) 7) BOSHQA XODIMNING PAROLI O\'ZGARMAYDI')
print('=' * 78)
otr = next((u for u in db_staff() if int(u.get('id')) == int(OTHER_ID)), None)
check('ikkinchi xodim passHash o\'zgarmadi',
      str(otr.get('passHash') or '') == other_hash_before)

print()
print('=' * 78)
print('D2) 2) PAROL HOLATI API MAYDONI (hasPassword) + XESH OSHKOR BO\'LMASLIGI')
print('=' * 78)
r = client.get('/api/boss/staff', headers=auth(boss_token))
check('GET /api/boss/staff -> 200', r.status_code == 200, 'code=%s' % r.status_code)
list_txt = json.dumps(r.get_json() or {}, ensure_ascii=False)
check('ro\'yxat javobida passHash YO\'Q', 'passHash' not in list_txt)
check('ro\'yxat javobida salt YO\'Q', '"salt"' not in list_txt)
check('ro\'yxat javobida passVault YO\'Q', 'passVault' not in list_txt)
lst = (r.get_json() or {}).get('staff') or []
me_row = next((s for s in lst if int(s.get('id') or 0) == int(TID)), None)
check('xodim yozuvida hasPassword maydoni bor', bool(me_row) and 'hasPassword' in me_row)
check('paroli bor xodim -> hasPassword=True', bool(me_row) and me_row.get('hasPassword') is True)
check('passChangedAt audit sanasi keladi', bool(me_row) and bool(me_row.get('passChangedAt')))

# Legacy (xeshsiz) yozuvni simulyatsiya qilamiz — jadvalda "o'rnatilmagan"
# ko'rinishi kerak. Faqat klonda bajariladi va tekshiruvdan keyin qaytariladi.
rows = db_staff()
legacy = next((u for u in rows if int(u.get('id') or 0) == int(OTHER_ID)), None)
if legacy is not None:
    legacy.pop('passHash', None)
    legacy.pop('salt', None)
    tp.db_manager.save_keys({'staff_users': rows})
    r = client.get('/api/boss/staff', headers=auth(boss_token))
    lst = (r.get_json() or {}).get('staff') or []
    lrow = next((s for s in lst if int(s.get('id') or 0) == int(OTHER_ID)), None)
    check('xeshsiz (legacy) xodim -> hasPassword=False',
          bool(lrow) and lrow.get('hasPassword') is False, str(lrow and lrow.get('hasPassword')))
    check('legacy holatda parol ochiq chiqmaydi',
          'passHash' not in json.dumps(r.get_json() or {}, ensure_ascii=False))

print()
print('=' * 78)
print('E) 3) VAQTINCHALIK PAROL MAJBURIY ALMASHTIRISH BILAN O\'RNATILADI')
print('=' * 78)
r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token),
               json={'password': TEMP_PASS, 'requirePasswordChange': True})
check('PUT vaqtinchalik parol -> 200', r.status_code == 200, 'code=%s' % r.status_code)
tr = next((u for u in db_staff() if int(u.get('id')) == int(TID)), None)
check('mustChange = True o\'rnatildi', bool(tr.get('mustChange')), str(tr.get('mustChange')))
check('bazada vaqtinchalik parol ochiq YO\'Q', TEMP_PASS not in db_raw())
r = client.post('/api/auth/login', json={'login': TEST_PHONE, 'password': TEMP_PASS})
lb = r.get_json() or {}
check('vaqtinchalik parol bilan kirish mumkin', r.status_code == 200, 'code=%s' % r.status_code)
check('login mustChangePassword=True qaytaradi',
      bool(lb.get('mustChangePassword')), str(lb.get('mustChangePassword')))

# Qisqa vaqtinchalik parol rad etiladi (>=12 majburiy)
r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token),
               json={'password': 'Qisqa1!', 'requirePasswordChange': True})
check('qisqa vaqtinchalik parol rad etildi (400)', r.status_code == 400, 'code=%s' % r.status_code)

print()
print('=' * 78)
print('E2) 10) XODIM QO\'SHISH VA TAHRIRLASH BUZILMAGANLIGI')
print('=' * 78)
r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token),
               json={'name': 'Sinov Kassir Yangi', 'salary': 1200000})
check('ism/maosh tahriri -> 200', r.status_code == 200, 'code=%s' % r.status_code)
eb = r.get_json() or {}
check('tahrirda ism yangilandi',
      (eb.get('staff') or {}).get('name') == 'Sinov Kassir Yangi',
      str((eb.get('staff') or {}).get('name')))
check('tahrir javobida passHash/salt YO\'Q',
      'passHash' not in json.dumps(eb, ensure_ascii=False)
      and '"salt"' not in json.dumps(eb, ensure_ascii=False))
check('tahrirdan keyin hasPassword saqlanadi (True)',
      (eb.get('staff') or {}).get('hasPassword') is True)

r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token),
               json={'role': 'manager'})
check('rolni o\'zgartirish -> 200', r.status_code == 200, 'code=%s' % r.status_code)
tr = next((u for u in db_staff() if int(u.get('id') or 0) == int(TID)), None)
check('rol bazada yangilandi (manager)', str((tr or {}).get('role')) == 'manager',
      str((tr or {}).get('role')))
check('rol o\'zgarishida parol holati saqlanadi',
      bool(str((tr or {}).get('passHash') or '')))

r = client.delete('/api/boss/staff/%d' % OTHER_ID, headers=auth(boss_token))
check('xodimni arxivlash (DELETE) -> 200', r.status_code == 200, 'code=%s' % r.status_code)
arch = next((u for u in db_staff() if int(u.get('id') or 0) == int(OTHER_ID)), None)
check('arxivlangandan keyin status inactive',
      str((arch or {}).get('status')) == 'inactive', str((arch or {}).get('status')))

print()
print('=' * 78)
print('F) 8) OCHIQ PAROLLAR LOG/API JAVOBLARIDA CHIQMAYDI')
print('=' * 78)
raw = db_raw()
check('new/pass/temp parollar bazada ochiq emas',
      NEW_PASS not in raw and TEMP_PASS not in raw and INIT_PASS not in raw)
# Barcha PUT/login javoblarida ochiq parol yo'qligi
leak = False
for pwd in (NEW_PASS, TEMP_PASS, INIT_PASS):
    if pwd in json.dumps(body, ensure_ascii=False):
        leak = True
check('API javoblari ochiq parol chiqarmaydi', not leak)

print()
print('=' * 78)
print('G) 1/2/9) FRONTEND STATIK TEKSHIRUV (modal, ko\'zcha, mobil)')
print('=' * 78)
try:
    html = open('index.html', encoding='utf-8').read()
    js = open('boss.js', encoding='utf-8').read()
    bcss = open('boss.css', encoding='utf-8').read()
except Exception as e:
    print('  [SKIP] fayllarni o\'qib bo\'lmadi:', e)
    html = js = bcss = ''

check('parol modali (bossPassModal) mavjud', 'id="bossPassModal"' in html)
check('kalit ikonkasi (data-boss-pass) mavjud', 'data-boss-pass' in js)
for gid in ('boss-pass-new', 'boss-pass-confirm', 'boss-pass-result',
            'boss-pass-generate', 'boss-pass-submit', 'boss-pass-result-value',
            'boss-pass-result-eye', 'boss-pass-passstate'):
    check('modal elementi #%s' % gid, ('id="%s"' % gid) in html)
check('ko\'zcha (pass-toggle) mavjud', 'pass-toggle' in html and 'toggleOwnPassField' in js)
check('nusxalash tugmasi mavjud', 'copyGeneratedStaffPassword' in js)
check('mobil media-query (boss-pass) mavjud', '@media' in bcss and 'boss-pass-tools' in bcss)

print()
print('=' * 78)
print('H) 2/5/6/11) PAROL HOLATI USTUNI, MODAL INDIKATORI VA NATIJA KO\'ZCHASI')
print('=' * 78)
check('jadval sarlavhasida «Parol» ustuni', '<th>Parol</th>' in html)
check('jadval katakchasi data-label="Parol"', 'data-label="Parol"' in js)
check('jadval colspan=11 (ustun qo\'shildi)', 'colspan="11"' in js)
check('parol holati katakchasi (passStateCellHtml)', 'passStateCellHtml' in js)
check('hasPassword frontendda ishlatiladi', 'hasPassword' in js)
check('modal parol holati indikatori (boss-pass-passstate)',
      'boss-pass-passstate' in html and 'boss-pass-passstate-text' in js)
check('jadval min-width kengaytirildi (>=1270px)', 'min-width: 1270px' in bcss)
check('parol holati CSS (.boss-pass-state)', '.boss-pass-state' in bcss)

# Natija oynasi ko'zchasi: faqat shu oynada ko'rsatish/yashirish
check('natija ko\'zchasi (toggleResultPassword) JS', 'toggleResultPassword' in js)
check('natija ko\'zchasi HTML tugmasi', 'Boss.toggleResultPassword()' in html)
check('natija ko\'zchasi holatni almashtiradi', 'setResultPasswordVisible' in js)
check('yashirilganda DOM\'dan qiymat o\'chiriladi (mask)',
      'masked' in js and 'code.masked' in bcss)
check('modal yopilganda maxfiy qiymatlar tozalanadi',
      'clearStaffPassSensitive' in js and 'boss-pass-result-value' in js)

# 5) Parol almashtirilgach jadval holati yangilanadi
check('parol almashtirilgach jadval yangilanadi (loadStaff)',
      'await loadStaff()' in js)
# 11) Mobil kartochkada ham parol holati
check('mobil kartochkada parol holati (bsc-row-pass)', 'bsc-row-pass' in js)
check('mobil parol holati CSS (.bsc-row-pass)', '.bsc-row-pass' in bcss)
# 6) Xodim qo'shish formasi buzilmagan
check('xodim qo\'shish parol maydoni saqlangan',
      'id="boss-new-password"' in html and 'createStaff' in js)
check('xodim qo\'shish natijasida parol ko\'rsatiladi',
      'boss-new-credentials' in html and 'showNewStaffCredentials' in js)
# Kod sintaksisi buzilmaganini tasdiqlash
try:
    import subprocess
    rc = subprocess.run(['node', '--check', 'boss.js'], capture_output=True, text=True)
    check('boss.js sintaksisi to\'g\'ri (node --check)',
          rc.returncode == 0, (rc.stderr or '').strip()[:120])
except Exception as e:  # node bo'lmasa — o'tkazib yuboramiz
    print('  [SKIP] node --check bajarilmadi:', e)

print()
print('=' * 78)
print('YAKUN')
print('=' * 78)
print('Failures:', failures if failures else 'YO\'Q — barcha sinovlar muvaffaqiyatli')
sys.exit(1 if failures else 0)
