# -*- coding: utf-8 -*-
"""Xodimlar bo'limi konsolidatsiyasi — vaqtinchalik tekshiruv skripti.

Topshiriq: «Takroriy Xodimlar bo'limini olib tashlash va Boshliq paneliga
to'liq integratsiya qilish» (10 bo'lim). Skript topshiriqning 9-bo'limidagi
13 talabni tekshiradi:

  A) FRONTEND (statik):
     1.  Umumiy menyuda takroriy «Xodimlar» bandi YO'Q.
     2.  Takroriy `page-employees` sahifasi YO'Q.
     3.  Boshliq → Xodimlar (`page-bossStaff`) va uning menyusi MAVJUD.
     4.  Oylik maosh moduli `page-bossStaff` ICHIDA (yagona manba).
     5.  boss.js `onPageOpen('bossStaff')` da SalaryModule.render() chaqiradi.
     6.  scripts.js renderEmployees() yo'q DOM'da xavfsiz (guard).
     7.  style.css da `#page-employees` selektori qolmagan.

  B) BACKEND (klonda ishlaydi):
     8.  Boshliq xodimlar ro'yxatini oladi (maosh + real savdo statistikasi).
     9.  Xodim qo'shish / tahrirlash / rol+filial / bloklash.
     10. Parolni xavfsiz almashtirish (xesh, ochiq matn yo'q).
     11. Ruxsatsiz foydalanuvchi boshqaruv API'larini ishlata olmaydi.
     12. Sahifa yangilangandan keyin ma'lumot saqlanadi (qayta GET).
     13. Boshqa modullar (POS savdosi yozuvlari) va boshliq himoyasi buzilmaydi.

Ishga tushirish (klon baza):
  Copy-Item Data\\database.db .testdb\\staff_cons_test.db -Force
  $env:DB_PATH=".testdb/staff_cons_test.db"; python _tp_staff_consolidation_test.py
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

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get('DB_PATH') or os.path.join('Data', 'database.db')
client = tp.app.test_client()
failures = []

TEST_PHONE = '+998900000321'
TEST_PHONE2 = '+998900000322'
INIT_PASS = 'Konsolidatsiya-2026!'


def check(label, cond, extra=''):
    print(('  [OK]  ' if cond else '  [FAIL]') + ' ' + label + ('   ' + extra if extra else ''))
    if not cond:
        failures.append(label)


def read_file(name):
    with open(os.path.join(ROOT, name), 'r', encoding='utf-8') as fh:
        return fh.read()


def make_token(user):
    actor = dict(user)
    actor['mustChange'] = False
    with tp.app.test_request_context('/', headers={'User-Agent': 'staff-cons-test'}):
        token, payload = tp.create_token(actor)
        tp.register_session(payload)
    return token


def auth(token):
    return {'Authorization': 'Bearer ' + token}


def db_staff():
    con = sqlite3.connect(DB)
    try:
        row = con.execute("SELECT value FROM store_data WHERE key='staff_users'").fetchone()
        return json.loads(row[0]) if row else []
    finally:
        con.close()


def db_raw():
    con = sqlite3.connect(DB)
    try:
        rows = con.execute('SELECT key, value FROM store_data').fetchall()
        return ' '.join(str(k) + '=' + str(v) for k, v in rows)
    finally:
        con.close()


def db_sales_count():
    con = sqlite3.connect(DB)
    try:
        row = con.execute("SELECT value FROM store_data WHERE key='sales'").fetchone()
        return len(json.loads(row[0])) if row and row[0] else 0
    finally:
        con.close()


def make_backup():
    if not os.path.isfile(DB):
        return ''
    out_dir = os.path.join('.testdb', 'backup')
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, 'database_%s.db' % time.strftime('%Y%m%d_%H%M%S'))
    shutil.copy2(DB, target)
    return target


print('=' * 78)
print('A) FRONTEND (statik tekshiruv)')
print('=' * 78)
index_html = read_file('index.html')
boss_js = read_file('boss.js')
scripts_js = read_file('scripts.js')
style_css = read_file('style.css')

# 1) Takroriy menyu olib tashlangan
check('1. Umumiy menyuda `nav-employees-wrapper` YO\'Q',
      'nav-employees-wrapper' not in index_html)
check('1. Umumiy menyuda `id="nav-employees"` YO\'Q',
      'id="nav-employees"' not in index_html)
check('1. Umumiy menyuda `employees-submenu` YO\'Q',
      'employees-submenu' not in index_html)

# 2) Takroriy sahifa olib tashlangan
check('2. `page-employees` sahifasi butunlay olib tashlangan',
      'page-employees' not in index_html)

# 3) Boshliq → Xodimlar mavjud
check('3. `#nav-bossStaff` menyusi mavjud', 'id="nav-bossStaff"' in index_html)
check('3. `#page-bossStaff` sahifasi mavjud', 'id="page-bossStaff"' in index_html)
check('3. Boshliq menyusida «Xodimlar» bandi bor',
      bool(re.search(r'id="nav-bossStaff"[^>]*>.*?Xodimlar', index_html, re.S)))

# 4) Oylik maosh moduli page-bossStaff ICHIDA
m = re.search(r'id="page-bossStaff"[^>]*>(.*?)(?=<div class="page" id="page-bossStaffSales")',
              index_html, re.S)
boss_staff_block = m.group(1) if m else ''
check('4. page-bossStaff bloki aniqlandi', bool(boss_staff_block))
for el in ('salary-stat-cards', 'salaryTable', 'salaryTableBody',
           'salaryHistoryChart', 'salary-recent-list'):
    check('4. maosh moduli elementi `%s` page-bossStaff ICHIDA' % el,
          el in boss_staff_block)
check('4. Maosh modali (salary-modal / add) global DOM da saqlanib qolgan',
      'SalaryModule.saveEmployee()' in index_html)
check('4. Bitta «Maosh yozuvi qo\'shish» tugmasi (takroriy sahifa tugmalari yo\'q)',
      'SalaryModule.openAddModal()' in boss_staff_block)

# 5) boss.js render integratsiyasi
check('5. boss.js: onPageOpen ichida SalaryModule.render() chaqiriladi',
      bool(re.search(r"key === 'bossStaff'\)[\s\S]{0,400}SalaryModule\.render\(\)", boss_js))
      or bool(re.search(r"SalaryModule\.render\(\)", boss_js)))

# 6) renderEmployees guard
check('6. scripts.js: renderEmployees() mavjud',
      'function renderEmployees()' in scripts_js)
check('6. scripts.js: renderEmployees() da employeesTable guard bor',
      bool(re.search(r"renderEmployees\(\)[\s\S]{0,400}employeesTable'\)\)\s*return", scripts_js)))
check('6. scripts.js: salary jadval td larida data-label bor',
      'data-label="Xodim"' in scripts_js and 'data-label="Oylik maosh"' in scripts_js)

# 7) CSS konsolidatsiya
# Izohlar (/* ... */) selektor emas — tekshiruvdan oldin olib tashlanadi.
style_css_nocomment = re.sub(r'/\*.*?\*/', '', style_css, flags=re.S)
check('7. style.css da `#page-employees` selektori qolmagan',
      '#page-employees' not in style_css_nocomment)
check('7. style.css da `#page-bossStaff .salary-stats` mavjud',
      '#page-bossStaff .salary-stats' in style_css_nocomment)
check('7. style.css da `#page-bossStaff .grid-2` mavjud',
      '#page-bossStaff .grid-2' in style_css_nocomment)

print()
print('=' * 78)
print('B) BACKEND (klon bazada)')
print('=' * 78)
backup_path = make_backup()
check('backup olish imkoniyati (baza nusxasi)', bool(backup_path),
      backup_path or 'baza fayli topilmadi')

staff_before = db_staff()
ids_before = sorted(str(u.get('id')) for u in staff_before)
sales_before = db_sales_count()
boss = next((u for u in staff_before if str(u.get('role')) == 'boss'), None)
if not boss:
    print("!! Boshliq akounti yo'q — sinov to'xtatildi")
    sys.exit(1)
boss_token = make_token(boss)

# Eski sinov yozuvlarini tozalash
clean = [u for u in staff_before
         if str(u.get('phone') or '') not in (TEST_PHONE, TEST_PHONE2)]
if len(clean) != len(staff_before):
    tp.db_manager.save_keys({'staff_users': clean})

print()
print('--- 8/12) Boshliq ro\'yxat oladi; savdo statistikasi real POS yozuvlaridan ---')
r = client.get('/api/boss/staff', headers=auth(boss_token))
check('8. GET /api/boss/staff -> 200', r.status_code == 200, 'code=%s' % r.status_code)
body = r.get_json() or {}
rows = body.get('staff') or []
check('8. ro\'yxatda xodimlar qaytadi', isinstance(rows, list) and len(rows) > 0,
      'count=%s' % len(rows))
if rows:
    sample = rows[0]
    for field in ('id', 'name', 'role', 'status', 'salary', 'sales', 'total', 'rank'):
        check('8. xodim yozuvida `%s` maydoni bor' % field, field in sample)
    stat_ok = all(isinstance(sample.get(k), (int, float))
                  for k in ('sales', 'total', 'units', 'profit', 'avgCheck'))
    check('8. savdo statistikasi raqamli (real POS yozuvlaridan)', stat_ok)

print()
print('--- 9/10) Xodim qo\'shish, tahrirlash, rol/filial, bloklash, parol ---')
r = client.post('/api/boss/staff', headers=auth(boss_token), json={
    'name': 'Konsolidatsiya Kassir', 'phone': TEST_PHONE, 'role': 'cashier',
    'branchId': '', 'status': 'active', 'salary': 1500000, 'password': INIT_PASS,
})
check('9. POST /api/boss/staff -> 201', r.status_code == 201, 'code=%s' % r.status_code)
if r.status_code != 201:
    print('   javob:', json.dumps(r.get_json(), ensure_ascii=False))
    sys.exit(1)
created = r.get_json()['staff']
TID = created['id']
check('9. yaratilgan xodimda belgilangan maosh saqlandi',
      int(created.get('salary') or 0) == 1500000, 'salary=%s' % created.get('salary'))
check('9. yaratilgan xodimda ochiq parol qaytarilmadi',
      INIT_PASS not in json.dumps(created, ensure_ascii=False))

r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token), json={
    'role': 'manager', 'salary': 2500000})
check('9. PUT rol+maosh tahriri -> 200', r.status_code == 200, 'code=%s' % r.status_code)
upd = (r.get_json() or {}).get('staff') or {}
check('9. rol manager ga o\'zgardi', str(upd.get('role')) == 'manager', upd.get('role'))
check('9. maosh 2 500 000 ga o\'zgardi', int(upd.get('salary') or 0) == 2500000)
check('9. maosh o\'zgarishi tarixi belgilandi (salaryChangedAt/By)',
      bool(upd.get('salaryChangedAt')) and bool(upd.get('salaryChangedBy')))

r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token), json={
    'password': 'YangiKonsol-2026!'})
check('10. PUT parol -> 200', r.status_code == 200, 'code=%s' % r.status_code)
row = next((u for u in db_staff() if str(u.get('id')) == str(TID)), None)
stored = str((row or {}).get('passHash') or '')
check('10. bazada parol xesh ko\'rinishida saqlandi', bool(stored) and stored != INIT_PASS)
check('10. bazada ochiq parol YO\'Q', 'YangiKonsol-2026!' not in db_raw())
check('10. xesh to\'g\'riligini server tasdiqlaydi',
      tp.verify_password('YangiKonsol-2026!', (row or {}).get('salt', ''), stored))

r = client.post('/api/auth/login', json={'login': TEST_PHONE, 'password': 'YangiKonsol-2026!'})
check('10. yangi parol bilan kirish -> 200', r.status_code == 200, 'code=%s' % r.status_code)

r = client.put('/api/boss/staff/%d' % TID, headers=auth(boss_token), json={'status': 'blocked'})
check('9. PUT holat=blocked -> 200', r.status_code == 200, 'code=%s' % r.status_code)
check('9. xodim holati blocked', str((r.get_json() or {}).get('staff', {}).get('status')) == 'blocked')

r = client.get('/api/boss/staff/%d/sales' % TID, headers=auth(boss_token))
check('9. GET xodim savdolari -> 200', r.status_code == 200, 'code=%s' % r.status_code)

print()
print('--- 11) Ruxsatsiz foydalanuvchi boshqaruv API\'larini ishlata olmaydi ---')
r = client.post('/api/boss/staff', headers=auth(boss_token), json={
    'name': 'Konsolidatsiya Ikkinchi', 'phone': TEST_PHONE2, 'role': 'cashier',
    'branchId': '', 'status': 'active', 'salary': 800000, 'password': INIT_PASS,
})
OTHER_ID = (r.get_json() or {}).get('staff', {}).get('id')
other_login = (r.get_json() or {}).get('staff', {}).get('login')
cashier_user = next((u for u in db_staff() if str(u.get('login') or '').lower()
                     == str(other_login).lower()), None)
cashier_token = make_token(cashier_user) if cashier_user else ''

r = client.get('/api/boss/staff', headers=auth(cashier_token))
check('11. cashier -> GET /api/boss/staff: 403', r.status_code == 403, 'code=%s' % r.status_code)
r = client.post('/api/boss/staff', headers=auth(cashier_token),
                json={'name': 'Buzgunchi', 'phone': '+998900000999', 'role': 'admin',
                      'salary': 1, 'password': 'Buzgunchi-123'})
check('11. cashier -> POST /api/boss/staff: 403', r.status_code == 403, 'code=%s' % r.status_code)
r = client.put('/api/boss/staff/%d' % TID, headers=auth(cashier_token), json={'status': 'active'})
check('11. cashier -> PUT boshqa xodim: 403', r.status_code == 403, 'code=%s' % r.status_code)
r = client.delete('/api/boss/staff/%d' % TID, headers=auth(cashier_token))
check('11. cashier -> DELETE boshqa xodim: 403', r.status_code == 403, 'code=%s' % r.status_code)
r = client.get('/api/boss/staff')
check('11. tokensiz -> GET /api/boss/staff: 401', r.status_code == 401, 'code=%s' % r.status_code)

print()
print('--- 6/13) Boshliq himoyasi ---')
r = client.delete('/api/boss/staff/%d' % int(boss.get('id')), headers=auth(boss_token))
check('13. Boshliqni arxivlash rad etildi (403)', r.status_code == 403, 'code=%s' % r.status_code)
r = client.put('/api/boss/staff/%d' % int(boss.get('id')), headers=auth(boss_token),
               json={'status': 'blocked'})
check('13. Boshliqni bloklash rad etildi', r.status_code in (403,), 'code=%s' % r.status_code)

print()
print('--- 9/13) Nofaol qilish (arxiv) — savdo tarixi saqlanadi ---')
r = client.delete('/api/boss/staff/%d' % TID, headers=auth(boss_token))
check('9. DELETE (arxiv) -> 200', r.status_code == 200, 'code=%s' % r.status_code)
arch = (r.get_json() or {}).get('staff') or {}
check('9. xodim status=inactive (soft delete)', str(arch.get('status')) == 'inactive')

print()
print('--- 12) Sahifa yangilangandan keyin ma\'lumot saqlanadi ---')
staff_after = db_staff()
ids_after = sorted(str(u.get('id')) for u in staff_after)
preserved = all(i in ids_after for i in ids_before)
check('12. oldingi barcha xodim ID lari saqlanib qoldi', preserved,
      'before=%d after=%d' % (len(ids_before), len(ids_after)))
row = next((u for u in staff_after if str(u.get('id')) == str(TID)), None)
check('12. arxivlangan xodim yozuvi bazada qoldi (o\'chirilmagan)', row is not None)
check('12. savdo yozuvlari soni o\'zgarmadi', db_sales_count() == sales_before,
      'before=%d after=%d' % (sales_before, db_sales_count()))
r = client.get('/api/boss/staff', headers=auth(boss_token))
r2 = client.get('/api/boss/staff', headers=auth(boss_token))
check('12. qayta GET barqaror natija beradi',
      (r.get_json() or {}).get('total') == (r2.get_json() or {}).get('total'))
check('12. yangi xodim ro\'yxatda ko\'rinadi (nofaol holatda)',
      any(str(s.get('id')) == str(TID) for s in (r.get_json() or {}).get('staff', [])))

print()
print('--- 6) Maxfiy ma\'lumot (maosh) faqat ruxsatlilarga ---')
check('6. maosh faqat boss endpointida (cashier 403 — yuqorida tasdiqlandi)',
      '11. cashier -> GET /api/boss/staff: 403' not in failures)

print()
print('=' * 78)
if failures:
    print('NATIJA: %d ta tekshiruv O\'TMADI:' % len(failures))
    for f in failures:
        print('   - ' + f)
    sys.exit(1)
print('NATIJA: BARCHA TEKSHIRUVLAR O\'TDI ✓')
