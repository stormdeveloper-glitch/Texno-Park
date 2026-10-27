#!/usr/bin/env python3
"""E2E uchun vaqtinchalik baza tayyorlaydi: Boshliq + 'ahatbek' xodimi."""
import datetime
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))   # .testdb
PROJ = os.path.dirname(BASE)                       # Texno-Park
sys.path.insert(0, PROJ)

src = os.path.join(PROJ, 'Data', 'database.db')
dst = os.path.join(BASE, 'e2e.db')
shutil.copyfile(src, dst)

os.environ['DB_PATH'] = '.testdb/e2e.db'
os.environ['BOSS_DEFAULT_PASSWORD'] = 'BossTest12345'

import app as tp  # noqa: E402

tp.ensure_boss_account()
staff = tp.load_staff()
boss = next(u for u in staff if str(u.get('role')) == 'boss')
boss['mustChange'] = False
boss['status'] = 'active'

if not any(str(u.get('name')) == 'ahatbek' for u in staff):
    salt = tp.make_salt('tp-e2e-')
    now = datetime.datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    staff.append({
        'id': tp._next_staff_id(staff),
        'login': 'ahatbek',
        'phone': '+998907777001',
        'name': 'ahatbek',
        'role': 'cashier',
        'status': 'active',
        'branchId': '',
        'mustChange': False,
        'salt': salt,
        'passHash': tp.hash_password('Test12345', salt),
        'createdAt': now,
        'createdBy': 'e2e-test',
    })

tp.db_manager.save_keys({'staff_users': staff})
names = [f"{u.get('id')}:{u.get('name')}/{u.get('status')}" for u in tp.load_staff()]
print('E2E DB tayyor:', ', '.join(names))
