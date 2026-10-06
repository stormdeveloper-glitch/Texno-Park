#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Boshliq chart + custom sana filtr testi (haqiqiy Flask test client).
- /api/boss/charts JSON va barcha seriyalar
- period=7d / 30d / custom from-to
- staff/products/branches/finance/reports enpointlari custom sana bilan
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app as tp  # noqa: E402

BOSS_PHONE = '+998901234554'
BOSS_PASSWORD = os.getenv('BOSS_DEFAULT_PASSWORD', 'diyorbek6272')

_passed = 0
_failed = 0


def check(label, ok, detail=''):
    global _passed, _failed
    if ok:
        _passed += 1
        print(f'  [OK]   {label}')
    else:
        _failed += 1
        print(f'  [FAIL] {label}  {detail}')


def auth(token):
    return {'Authorization': 'Bearer ' + (token or '')}


def main():
    tp.ensure_boss_account()
    client = tp.app.test_client()
    res = client.post('/api/auth/login',
                      json={'login': BOSS_PHONE, 'password': BOSS_PASSWORD})
    body = res.get_json() or {}
    token = body.get('token')
    check('Boshliq login 200', res.status_code == 200, f'HTTP {res.status_code}')

    print('\n=== /api/boss/charts ===')
    r = client.get('/api/boss/charts?period=all', headers=auth(token))
    check('charts 200', r.status_code == 200, f'HTTP {r.status_code}')
    data = r.get_json() or {}
    for key in ('daily', 'weekly', 'monthly', 'payments', 'branchSales', 'flow'):
        check(f'seriya "{key}" mavjud', key in data)
    daily = data.get('daily') or []
    check(f'daily 14 kun (endi {len(daily)})', len(daily) == 14, str(len(daily)))
    if daily:
        check('daily revenue son', isinstance(daily[0].get('revenue'), (int, float)))
    check('payments labels list', isinstance((data.get('payments') or {}).get('labels'), list))

    print('\n=== Period: 7d / 30d / custom ===')
    for period in ('7d', '30d', 'today', 'week', 'month'):
        r = client.get('/api/boss/charts?period=' + period, headers=auth(token))
        check(f'charts period={period} -> 200', r.status_code == 200, f'HTTP {r.status_code}')
    r = client.get('/api/boss/charts?from=01.01.2026&to=31.12.2026', headers=auth(token))
    check('charts custom from/to -> 200', r.status_code == 200, f'HTTP {r.status_code}')
    r = client.get('/api/boss/charts?period=7d&from=01.01.2026&to=05.01.2026',
                   headers=auth(token))
    check('charts custom overrides period -> 200', r.status_code == 200)
    r = client.get('/api/boss/staff?period=7d', headers=auth(token))
    check('staff period=7d -> 200', r.status_code == 200, f'HTTP {r.status_code}')
    r = client.get('/api/boss/staff?from=01.01.2026&to=31.12.2026', headers=auth(token))
    check('staff custom -> 200', r.status_code == 200, f'HTTP {r.status_code}')
    r = client.get('/api/boss/products?period=30d&from=01.01.2026&to=31.12.2026',
                   headers=auth(token))
    check('products custom -> 200', r.status_code == 200, f'HTTP {r.status_code}')
    r = client.get('/api/boss/branches?period=7d', headers=auth(token))
    body = r.get_json() or {}
    branches = body.get('branches') or []
    check('branches 7d -> 200 va todaySales maydoni',
          r.status_code == 200 and len(branches) > 0
          and all('todaySales' in b and 'monthSales' in b for b in branches),
          str(r.status_code))
    r = client.get('/api/boss/finance?period=30d&from=01.01.2026&to=31.12.2026',
                   headers=auth(token))
    check('finance custom -> 200', r.status_code == 200, f'HTTP {r.status_code}')
    r = client.get('/api/boss/reports?period=7d&from=01.01.2026&to=31.12.2026',
                   headers=auth(token))
    check('reports custom -> 200', r.status_code == 200, f'HTTP {r.status_code}')
    r = client.get('/api/boss/reports?format=csv&from=01.01.2026&to=31.12.2026',
                   headers=auth(token))
    check('reports CSV custom -> 200', r.status_code == 200, f'HTTP {r.status_code}')

    print('\n=== RBAC: charts faqat BOSHLIQ ===')
    for role in ('admin', 'manager', 'cashier'):
        staff = tp.load_staff()
        target = next((u for u in staff if str(u.get('role')) == role), None)
        if not target:
            continue
        salt = tp.make_salt('tp-test-')
        target['salt'] = salt
        target['passHash'] = tp.hash_password('Test12345', salt)
        target['status'] = 'active'
        tp.db_manager.save_keys({'staff_users': staff})
        r = client.post('/api/auth/login', json={'login': role, 'password': 'Test12345'})
        tok = (r.get_json() or {}).get('token')
        r = client.get('/api/boss/charts', headers=auth(tok))
        check(f'{role} charts -> 403', r.status_code == 403, f'HTTP {r.status_code}')


if __name__ == '__main__':
    main()
    print(f"\n=== NATIJA: {_passed} o'tgan, {_failed} yiqilgan ===")
    sys.exit(1 if _failed else 0)