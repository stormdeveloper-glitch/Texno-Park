"""Klon bazaga sinov mijozlari va chek qo'shadi (shartnoma formasi sinovi).

Faqat .testdb/logo_verify.db (klon) o'zgartiriladi — asosiy baza tegmaydi.
"""
import json
import os
import sqlite3

ROOT = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
DB = os.path.join(ROOT, '.testdb', 'logo_verify.db')

CUSTOMERS = [
    {'id': 1, 'name': 'Ali Valiyev', 'phone': '+998901234567', 'email': '', 'orders': 1,
     'total': 100, 'bonus': 0, 'status': 'active'},
    {'id': 2, 'name': 'Dilnoza Karimova', 'phone': '(90) 111-22-33', 'email': '', 'orders': 0,
     'total': 0, 'bonus': 0, 'status': 'active'},
    {'id': 3, 'name': 'Sardor Toxirov', 'phone': '', 'email': '', 'orders': 0,
     'total': 0, 'bonus': 0, 'status': 'active'},
]

SALES = [
    {'id': 9001, 'date': '14.10.2026', 'customer': 'Nodira Sotvoldiyeva +998935556677',
     'cashier': 'Kassir', 'items': [{'name': 'Muzlatgich', 'qty': 1, 'price': 100, 'cost': 50}],
     'total': 100, 'profit': 50, 'status': 'paid', 'branchId': ''},
]

conn = sqlite3.connect(DB)
for key, payload in (('customers', CUSTOMERS), ('sales', SALES)):
    conn.execute("update store_data set value=? where key=?",
                 (json.dumps(payload, ensure_ascii=False), key))
conn.commit()
print('mijozlar:', len(CUSTOMERS), '| cheklar:', len(SALES))
for c in CUSTOMERS:
    print('  -', c['name'], '|', repr(c['phone']))
print('  - chek egasi:', SALES[0]['customer'])
conn.close()
