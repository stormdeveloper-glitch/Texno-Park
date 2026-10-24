# -*- coding: utf-8 -*-
"""POS /api/sell endpointini tekshirish (vaqtinchalik sinov skripti)."""
import sys
import json
sys.path.insert(0, '.')
import app as tp

client = tp.app.test_client()


def snapshot():
    store = tp.db_manager.get_all() or {}
    prods = [p for p in (store.get('products') or []) if isinstance(p, dict)]
    sales = [s for s in (store.get('sales') or []) if isinstance(s, dict)]
    return prods, sales


prods, sales = snapshot()
branches = [b for b in (tp.db_manager.get_all() or {}).get('branches') or [] if isinstance(b, dict)]
print('=== HOLAT ===')
print('branches :', [(b.get('id'), b.get('name'), bool(b.get('isMain'))) for b in branches])
print('products :', len(prods), '| sales:', len(sales))
for p in prods[:6]:
    print('  #%s %-28s branch=%-6r stock=%-6s price=%-10s cost=%s' % (
        p.get('id'), str(p.get('name'))[:28], p.get('branchId'), p.get('stock'), p.get('price'), p.get('cost')))

staff = tp.load_staff()
actor = (next((u for u in staff if str(u.get('role')) == 'boss'), None)
         or next((u for u in staff if str(u.get('role')) == 'admin'), None))
if not actor:
    print('!! admin/boss topilmadi — sinov to\'xtatildi')
    sys.exit(1)
actor = dict(actor)
actor['mustChange'] = False
with tp.app.test_request_context('/', headers={'User-Agent': 'python-sell-verify'}):
    token, payload = tp.create_token(actor)
    tp.register_session(payload)
H = {'Authorization': 'Bearer ' + token}
print('actor:', actor.get('login'), actor.get('role'))

# Sinov mahsulotini tanlash: filialga bog'langan va umumiy (branchId bo'sh)
branch_id = str((branches[0].get('id') if branches else '') or '')
bound = next((p for p in prods if str(p.get('branchId') or '') == branch_id), None)
common = next((p for p in prods if not str(p.get('branchId') or '').strip()), None)
target = bound or common or (prods[0] if prods else None)
if target is None:
    print('!! Mahsulot yo\'q — sinov to\'xtatildi')
    sys.exit(1)
use_branch = str(target.get('branchId') or '').strip() or branch_id
if not use_branch:
    use_branch = 'b-main-test'

print('\n=== SINOV MAHSULOTI ===')
print('id=', target.get('id'), 'name=', target.get('name'),
      'branch=', target.get('branchId'), 'stock=', target.get('stock'))
print('sale branch =', use_branch)

start_stock = int(float(target.get('stock') or 0))
pid = target.get('id')
SALE_ID = 999000000001
failures = []


def do_sale(sale_id, qty, branch, is_online=False):
    body = {
        'id': sale_id,
        'items': [{'id': pid, 'qty': qty, 'price': target.get('price') or 1000,
                   'name': target.get('name'), 'cost': target.get('cost') or 0}],
        'branchId': branch, 'customer': 'Sinov', 'pay': 'Naqd', 'provider': 'cash',
        'subtotal': (target.get('price') or 1000) * qty, 'disc': 0, 'discAmt': 0,
        'total': (target.get('price') or 1000) * qty,
        'date': '23.10.2026', 'time': '15:30:00', 'isOnline': is_online,
    }
    r = client.post('/api/sell', json=body, headers=H)
    return r.status_code, r.get_json()


def cur_stock():
    p, _ = snapshot()
    m = next((x for x in p if str(x.get('id')) == str(pid)), None)
    return int(float((m or {}).get('stock') or 0))


def check(label, cond, extra=''):
    print(('  [OK]  ' if cond else '  [FAIL]') + ' ' + label + ('  ' + extra if extra else ''))
    if not cond:
        failures.append(label)


print('\n=== 1) ODDIY SAVDO (3 dona) ===')
code, res = do_sale(SALE_ID, 3, use_branch)
check('HTTP 200', code == 200, 'code=%s' % code)
if code != 200:
    print('   javob:', json.dumps(res, ensure_ascii=False))
else:
    after = cur_stock()
    check('qoldiq -3', after == start_stock - 3, 'before=%s after=%s' % (start_stock, after))
    check('productStocks javobda', bool(res.get('productStocks')), str(res.get('productStocks')))
    check('sale saqlandi', bool(res.get('sale')), '')

print('\n=== 2) TAKRORIY SO\'ROV (bir xil id) ===')
before_dup = cur_stock()
code, res = do_sale(SALE_ID, 3, use_branch)
check('HTTP 200', code == 200, 'code=%s' % code)
check('qoldiq o\'zgarmadi (idempotent)', cur_stock() == before_dup,
      'before=%s after=%s' % (before_dup, cur_stock()))
check('duplicate=True', bool(res.get('duplicate')), str(res.get('duplicate')))

print('\n=== 3) YETARLI BO\'LMAGAN QOLDIQ ===')
before_low = cur_stock()
code, res = do_sale(999000000002, before_low + 1000, use_branch)
check('HTTP 400', code == 400, 'code=%s' % code)
check('qoldiq o\'zgarmadi', cur_stock() == before_low, 'before=%s after=%s' % (before_low, cur_stock()))
print('   xabar:', (res or {}).get('message'))

print('\n=== 4) FILIAL MOS EMASLIGI ===')
if bound is not None:
    other_branch = next((str(b.get('id')) for b in branches
                         if str(b.get('id')) != str(bound.get('branchId'))), None)
    if other_branch:
        before_b = cur_stock()
        code, res = do_sale(999000000003, 1, other_branch)
        check('HTTP 400 (boshqa filial)', code == 400, 'code=%s' % code)
        check('qoldiq o\'zgarmadi', cur_stock() == before_b)
        print('   xabar:', (res or {}).get('message'))
    else:
        print('  [SKIP] faqat bitta filial bor')
else:
    print('  [SKIP] filialga bog\'langan mahsulot topilmadi')

print('\n=== 5) UMUMIY OMBOR MAHSULOTI (branchId bo\'sh) — istalgan filialda ===')
if common is not None:
    cid = common.get('id')
    cstock = int(float(common.get('stock') or 0))
    body = {
        'id': 999000000004,
        'items': [{'id': cid, 'qty': 1, 'price': common.get('price') or 1000,
                   'name': common.get('name'), 'cost': common.get('cost') or 0}],
        'branchId': use_branch, 'customer': 'Sinov', 'pay': 'Naqd', 'provider': 'cash',
        'subtotal': common.get('price') or 1000, 'disc': 0, 'discAmt': 0,
        'total': common.get('price') or 1000,
        'date': '23.10.2026', 'time': '15:30:00', 'isOnline': False,
    }
    r = client.post('/api/sell', json=body, headers=H)
    p2, _ = snapshot()
    m2 = next((x for x in p2 if str(x.get('id')) == str(cid)), None)
    nstock = int(float((m2 or {}).get('stock') or 0))
    check('HTTP 200', r.status_code == 200, 'code=%s' % r.status_code)
    check('umumiy mahsulot qoldig\'i -1', nstock == cstock - 1,
          'before=%s after=%s' % (cstock, nstock))
    if r.status_code != 200:
        print('   javob:', json.dumps(r.get_json(), ensure_ascii=False))
else:
        # Klonda vaqtinchalik umumiy (branchId bo'sh) mahsulot qo'shib sinaymiz
        tmp_id = 999000000777
        prods_now, _ = snapshot()
        prods_now.append({'id': tmp_id, 'name': 'Umumiy sinov', 'cat': 'Sinov',
                          'price': 5000, 'cost': 4000, 'stock': 5, 'branchId': ''})
        tp.db_manager.save_keys({'products': prods_now})
        body = {
            'id': 999000000004,
            'items': [{'id': tmp_id, 'qty': 1, 'price': 5000, 'name': 'Umumiy sinov', 'cost': 4000}],
            'branchId': use_branch, 'customer': 'Sinov', 'pay': 'Naqd', 'provider': 'cash',
            'subtotal': 5000, 'disc': 0, 'discAmt': 0, 'total': 5000,
            'date': '23.10.2026', 'time': '15:30:00', 'isOnline': False,
        }
        r = client.post('/api/sell', json=body, headers=H)
        p2, _ = snapshot()
        m2 = next((x for x in p2 if str(x.get('id')) == str(tmp_id)), None)
        check('HTTP 200', r.status_code == 200, 'code=%s' % r.status_code)
        check('umumiy mahsulot qoldig\'i 5 -> 4', int(float((m2 or {}).get('stock') or 0)) == 4,
              'stock=%s' % (m2 or {}).get('stock'))
        if r.status_code != 200:
            print('   javob:', json.dumps(r.get_json(), ensure_ascii=False))

print('\n=== 6) AUTH TEKSHIRUVI ===')
r = client.post('/api/sell', json={'items': [], 'branchId': use_branch})
check('token yo\'q → 401/403', r.status_code in (401, 403), 'code=%s' % r.status_code)

print('\n=== 7) FILIALLAR AJRALISHI (bir filial savdosi boshqasiga ta\'sir qilmasin) ===')
if branches:
    other = next((b for b in branches if str(b.get('id')) != use_branch), None)
    if other:
        p3_id = 999000000888
        prods_now, _ = snapshot()
        prods_now.append({'id': p3_id, 'name': 'Filial sinov', 'cat': 'Sinov',
                          'price': 7000, 'cost': 5000, 'stock': 10,
                          'branchId': str(other.get('id'))})
        tp.db_manager.save_keys({'products': prods_now})
        main_before = cur_stock()

        def stock_of(x_id):
            pp, _ = snapshot()
            m = next((x for x in pp if str(x.get('id')) == str(x_id)), None)
            return int(float((m or {}).get('stock') or 0))

        r = client.post('/api/sell', json={
            'id': 999000000005,
            'items': [{'id': p3_id, 'qty': 2, 'price': 7000, 'name': 'Filial sinov', 'cost': 5000}],
            'branchId': use_branch, 'customer': 'Sinov', 'pay': 'Naqd', 'provider': 'cash',
            'subtotal': 14000, 'disc': 0, 'discAmt': 0, 'total': 14000,
            'date': '23.10.2026', 'time': '15:30:00', 'isOnline': False,
        }, headers=H)
        check('boshqa filial mahsuloti shu filialda rad etiladi', r.status_code == 400,
              'code=%s' % r.status_code)
        check('  o\'sha filial mahsuloti qoldig\'i o\'zgarmadi', stock_of(p3_id) == 10,
              'stock=%s' % stock_of(p3_id))
        check('  asosiy mahsulot qoldig\'i ham o\'zgarmadi', cur_stock() == main_before)
    else:
        print('  [SKIP] ikkinchi filial yo\'q')
else:
    print('  [SKIP] filial yo\'q')

print('\n=== 8) PARALLEL SAVDO (oxirgi dona — faqat bittasi o\'tadi) ===')
import threading as _thr
race_id = 999000000999
rp = 999000000555
prods_now, _ = snapshot()
prods_now.append({'id': rp, 'name': 'Oxirgi dona', 'cat': 'Sinov',
                  'price': 9000, 'cost': 6000, 'stock': 1, 'branchId': ''})
tp.db_manager.save_keys({'products': prods_now})
results = []


def race_worker(sid):
    c = tp.app.test_client()
    rr = c.post('/api/sell', json={
        'id': sid,
        'items': [{'id': rp, 'qty': 1, 'price': 9000, 'name': 'Oxirgi dona', 'cost': 6000}],
        'branchId': use_branch, 'customer': 'Sinov', 'pay': 'Naqd', 'provider': 'cash',
        'subtotal': 9000, 'disc': 0, 'discAmt': 0, 'total': 9000,
        'date': '23.10.2026', 'time': '15:30:00', 'isOnline': False,
    }, headers=H)
    results.append(rr.status_code)


threads = [_thr.Thread(target=race_worker, args=(race_id + i,)) for i in range(2)]
for t in threads:
    t.start()
for t in threads:
    t.join()
ok_count = results.count(200)
pp, _ = snapshot()
m = next((x for x in pp if str(x.get('id')) == str(rp)), None)
check('parallel: faqat 1 ta savdo o\'tdi', ok_count == 1, 'results=%s' % results)
check('parallel: qoldiq 1 -> 0 (manfiy emas)', int(float((m or {}).get('stock') or 0)) == 0,
      'stock=%s' % (m or {}).get('stock'))

print('\n=== YAKUN ===')
print('Failures:', failures if failures else 'YO\'Q — barcha sinovlar muvaffaqiyatli')
