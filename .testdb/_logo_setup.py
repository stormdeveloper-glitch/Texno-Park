"""Vaqtinchalik tekshiruv bazasi: admin paroli + keng logotip (preview sinovi).

Faqat KLON baza (.testdb/logo_verify.db) o'zgartiriladi — asosiy baza tegmaydi.
"""
import json
import os
import shutil
import sqlite3
import sys

ROOT = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
SRC = os.path.join(ROOT, '.testdb', 'test.db')
DST = os.path.join(ROOT, '.testdb', 'logo_verify.db')

shutil.copy2(SRC, DST)
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ['DB_PATH'] = DST

import app  # noqa: E402

ADMIN_PHONE = '+998908480921'
NEW_PASSWORD = 'verify123456'
# Keng (16:9) rasm — preview qirqilishini ko'rsatish uchun ataylab tanlandi
LOGO = '/assets/texno-park-n1-exterior.jpg'

staff = app.load_staff()
found = False
for item in staff:
    if str(item.get('phone')) == ADMIN_PHONE and item.get('role') == 'admin':
        app.apply_staff_password(item, NEW_PASSWORD, 'logo-verify')
        item['mustChange'] = False
        found = True
        print('parol o\'rnatildi:', item.get('login'), item.get('role'))
if not found:
    raise SystemExit('XATO: admin xodim topilmadi')

conn = sqlite3.connect(DST)
row = conn.execute("select value from store_data where key='settings'").fetchone()
settings = json.loads(row[0]) if row else {}
settings['companyLogo'] = LOGO
settings['companyName'] = 'Texno Park N1'
conn.execute("update store_data set value=? where key='settings'",
             (json.dumps(settings, ensure_ascii=False),))
conn.commit()
conn.close()
app.db_manager.save_keys({'staff_users': staff, 'settings': settings})
print('logo =', LOGO)
print('baza =', DST)
