#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
sys.path.insert(0, '.')
import app as tp

client = tp.app.test_client()

# 1) Set admin password to Test12345 and KEEP it (don't restore)
def ensure_test_user_keep(lname):
    staff = tp.load_staff()
    target = next((u for u in staff if str(u.get('login', '')).lower() == str(lname).lower()), None)
    if not target:
        return None
    print(f'Before: login={target.get("login")}, passHash={target.get("passHash")[:20]}...')
    orig = {'salt': target.get('salt'), 'passHash': target.get('passHash'), 'status': target.get('status')}
    salt = tp.make_salt('tp-test-')
    target['salt'] = salt
    target['passHash'] = tp.hash_password('Test12345', salt)
    target['status'] = 'active'
    tp.db_manager.save_keys({'staff_users': staff})
    # Reload to verify
    staff2 = tp.load_staff()
    t2 = next((u for u in staff2 if u.get('id') == target.get('id')), None)
    print(f'After: login={t2.get("login")}, passHash={t2.get("passHash")[:20]}...')
    return t2  # Keep the modified user

admin = ensure_test_user_keep('admin')
print('admin loaded:', bool(admin))

# 2) Login with Test12345 (password STILL set)
r = client.post('/api/auth/login', json={'login': 'admin', 'password': 'Test12345'})
print('admin login:', r.status_code)
data = r.get_json()
token = data.get('token')
print('token:', bool(token))

if token:
    import json
    sale_body = {
        'items': [{'id': 1791560183064, 'qty': 1, 'price': 12329.0, 'name': 'dfbgh'}],
        'branchId': 'b2',
        'cashierLogin': 'admin',
        'cashier': 'Abdullayev Admin',
        'customer': 'Test',
        'customerId': None,
        'pay': 'cash',
        'provider': 'cash',
        'total': 12329.0,
        'disc': 0,
        'discAmt': 0,
        'subtotal': 12329.0,
        'date': '23.10.2026',
        'time': '15:30:00',
        'isOnline': False
    }
    r = client.post('/api/sell', json=sale_body, headers={'Authorization': 'Bearer ' + token})
    print('sell status:', r.status_code)
    res = r.get_json()
    print(json.dumps(res, indent=2, ensure_ascii=False))
else:
    print('Could not get token')