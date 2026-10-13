"""Cashier akountiga ma'lum parol qo'yadi (faqat klon baza)."""
import os
import sqlite3
import sys

os.environ.setdefault('DB_PATH', os.path.join('.testdb', 'bughunt.db'))
sys.path.insert(0, os.getcwd())

import app  # noqa: E402

staff = app.load_staff()
targets = {'cashier@texnopark.uz': 'cashier123', 'manager@texnopark.uz': 'manager123'}
for item in staff:
    pwd = targets.get(str(item.get('login')))
    if pwd:
        app.apply_staff_password(item, pwd, 'bughunt')
        print('set password for', item.get('login'), '->', item.get('role'))
app.db_manager.save_keys({'staff_users': staff})
print('saved')
