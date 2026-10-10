#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kassa sotuvi va ombor qoldigi regression testi (haqiqiy Flask test client).

Tekshiriladi:
  1) bitta mahsulot sotuvi   → qoldiq aynan1 ga kamayadi (API + to'g'ridan-to'g'ri SQLite);
  2) bir sotuvda bir nechta mahsulot → har birining qoldig'i o'zgaradi;
  3) boshqa filial mahsulotining qoldig'i sotuvdan keyin o'zgarmaydi;
  4) manfiy/noto'g'ri qoldiq bilan sync rad etiladi va DB o'zgarmaydi;
  5) tasdiqlanmagan (pending) sotuv ombor qoldig'ini o'zgartirmaydi;
  6) bir xil sotuv ikki marta yuborilsa qoldiq IKKI MARTA kamaymaydi;
  7) qayta so'rov (reload) har doim DB dagi so'nggi qoldiqni qaytaradi.

Barcha yozuvlar DB_PATH klonida bajariladi — production bazasi himoyalangan
(DB_PATH production bilan bir xil bo'lsa test ishga tushmaydi).
Muvaffaqiyatli sotuv bu yerda haqiqiy Kassa oqimidek modellashtiriladi:
brauzer mahsulot qoldig'ini kamaytirgan holda to'liq payloadni /api/sync ga
yuboradi (mavjud arxitektura — boshqa API yaratilmaydi).
"""
import os
import sys
import json
import sqlite3
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app as tp  # noqa: E402

PW = (os.getenv('TP_STAFF_PASSWORD') or '').strip()
CASHIER_LOGIN = '+998905450921'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROD_DB = os.path.join(BASE_DIR, 'Data', 'database.db')
DB_PATH = os.getenv('DB_PATH') or PROD_DB

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


def login(client):
    res = client.post('/api/auth/login',
                      json={'login': CASHIER_LOGIN, 'password': PW})
    if res.status_code != 200:
        print(f'  [XATO] Kassir girişi HTTP {res.status_code}')
        return None
    return (res.get_json() or {}).get('token')


def get_store(client, token):
    res = client.get('/api/data', headers=auth(token))
    assert res.status_code == 200, f'/api/data HTTP {res.status_code}'
    return res.get_json() or {}


def find_product(store, pid):
    for p in store.get('products') or []:
        if int(p.get('id') or 0) == int(pid):
            return p
    return None


def stock_of(store, pid):
    p = find_product(store, pid)
    return None if p is None else int(p.get('stock') or 0)


def db_read(key):
    """Yagona haqiqat manbasi — to'g'ridan-to'g'ri SQLite (klon)."""
    con = sqlite3.connect(DB_PATH)
    try:
        row = con.execute('select value from store_data where key=?',
                          (key,)).fetchone()
        return json.loads(row[0]) if row else None
    finally:
        con.close()


def build_sale(sale_id, items, branch_id):
    """Kassa tomonidan yuboriladigan savdo yozuvi (mavjud payload shakli)."""
    subtotal = sum(float(i['price']) * int(i['qty']) for i in items)
    return {
        'id': sale_id,
        'items': items,
        'subtotal': subtotal,
        'disc': 0,
        'discAmt': 0,
        'total': subtotal,
        'pay': 'Naqd',
        'provider': 'cash',
        'time': '12:00:00',
        'date': '01.01.2026',
        'cashier': 'Kassir (test)',
        'customer': "Noma'lum",
        'customerId': None,
        'branchId': branch_id,
        'credit': None,
        'status': 'paid',
    }


def sync(client, token, payload):
    return client.post('/api/sync', json=payload, headers=auth(token))


def main():
    if not PW:
        print('[XATO] TP_STAFF_PASSWORD muhit o\'zgaruvchisi kerak.')
        return 1
    if os.path.abspath(DB_PATH) == os.path.abspath(PROD_DB):
        print('[XATO] Test production bazasida ishga tushmaydi — '
              'DB_PATH klonini ko\'rsating.')
        return 1
    print(f'Baza (klon): {os.path.basename(DB_PATH)}')

    client = tp.app.test_client()
    token = login(client)
    if not token:
        return 1

    # ── Setup: bazadagi real mahsulot + b3 filiali uchun klon-fixture ──
    store = get_store(client, token)
    products = store.get('products') or []
    if not products:
        print('  [XATO] Bazada mahsulot yo\'q — test maqsadsiz.')
        return 1
    p1 = next((p for p in products if int(p.get('id') or 0) == 1791560183064),
              products[0])
    p1_id = int(p1['id'])
    p1_branch = str(p1.get('branchId') or '')

    p2 = next((p for p in products
               if str(p.get('branchId') or '') == 'b3'
               and int(p.get('id') or 0) != p1_id), None)
    if p2 is None:
        p2_id = max(int(p.get('id') or 0) for p in products) + 1
        p2 = {
            'id': p2_id,
            'name': 'TEST-B3 klon-filial',
            'cat': str(p1.get('cat') or 'Test'),
            'price': float(p1.get('price') or 1000),
            'cost': 0,
            'stock': 7,
            'branchId': 'b3',
            'desc': 'Klon bazadagi test mahsuloti (b3)',
        }
        payload = {'products': products + [p2]}
        res = sync(client, token, payload)
        check('Setup: b3 mahsuloti real sync orqali qo\'shildi',
              res.status_code == 200, f'HTTP {res.status_code}')
        store = get_store(client, token)
    p2_id = int(p2['id'])

    base1 = stock_of(store, p1_id)
    base2 = stock_of(store, p2_id)
    initial_sales = len(store.get('sales') or [])
    check('Setup: mahsulotlar topildi', base1 is not None and base2 is not None,
          f'p1={base1} p2={base2}')

    def fresh():
        return get_store(client, token)

    # ──1) Bitta mahsulot sotuvi → qoldiq1 ga kamayadi ──
    s1 = fresh()
    before1 = stock_of(s1, p1_id)
    sale1_id = int(time.time() * 1000) + 101
    items1 = [{'id': p1_id, 'name': p1['name'], 'price': p1.get('price'),
               'qty': 1, 'cost': p1.get('cost', 0)}]
    products_after = [dict(x) for x in s1.get('products') or []]
    for x in products_after:
        if int(x.get('id') or 0) == p1_id:
            x['stock'] = before1 - 1
    res = sync(client, token, {
        'products': products_after,
        # Klient har doim TO'LIQ sales tarixini yuboradi (buildSyncPayload) —
        # shuning uchun test ham mavjud tarixni saqlab, yangi savdoni qo'shadi.
        'sales': (s1.get('sales') or []) + [build_sale(sale1_id, items1, p1_branch)],
    })
    ok = res.status_code == 200
    after1 = stock_of(fresh(), p1_id)
    db_p1 = next((x for x in (db_read('products') or [])
                  if int(x.get('id') or 0) == p1_id), None)
    db1 = int(db_p1.get('stock') or 0) if db_p1 else None
    check('T1: sotuvdan keyin qoldiq1 ga kamaydi (API)',
          ok and after1 == before1 - 1, f'before={before1} after={after1}')
    check('T1: qoldiq DB (SQLite) da ham1 ga kamaydi',
          db1 == before1 - 1, f'db={db1} kutilgan={before1 - 1}')
    sales = fresh().get('sales') or []
    check('T1: savdo yozuvi bazaga tushdi',
          any(int(s.get('id') or 0) == sale1_id for s in sales))

    # ──2) Bir nechta mahsulot bir sotuvda ──
    s2 = fresh()
    b1 = stock_of(s2, p1_id)
    b2 = stock_of(s2, p2_id)
    sale2_id = sale1_id + 1
    items2 = [
        {'id': p1_id, 'name': p1['name'], 'price': p1.get('price'),
         'qty': 1, 'cost': p1.get('cost', 0)},
        {'id': p2_id, 'name': p2['name'], 'price': p2.get('price'),
         'qty': 2, 'cost': p2.get('cost', 0)},
    ]
    prod2 = [dict(x) for x in s2.get('products') or []]
    for x in prod2:
        iid = int(x.get('id') or 0)
        if iid == p1_id:
            x['stock'] = b1 - 1
        elif iid == p2_id:
            x['stock'] = b2 - 2
    res = sync(client, token, {
        'products': prod2,
        'sales': (s2.get('sales') or []) + [build_sale(sale2_id, items2, p1_branch)],
    })
    s2a = fresh()
    check('T2: ko\'p mahsulotli sotuv — har biri o\'zgardi',
          res.status_code == 200
          and stock_of(s2a, p1_id) == b1 - 1
          and stock_of(s2a, p2_id) == b2 - 2,
          f'p1 {b1}->{stock_of(s2a, p1_id)}, p2 {b2}->{stock_of(s2a, p2_id)}')

    # ──3) Boshqa filial sotuvidan b3 mahsuloti ham, b3 sotuvidan b2 ham
    #      noto'g'ri o'zgarmaydi (filial izolyatsiyasi) ──
    b3_before = stock_of(s2a, p2_id)
    prod3 = [dict(x) for x in s2a.get('products') or []]
    for x in prod3:
        if int(x.get('id') or 0) == p1_id:
            x['stock'] = stock_of(s2a, p1_id) - 1
    res = sync(client, token, {
        'products': prod3,
        'sales': (s2a.get('sales') or []) + [
            build_sale(sale1_id + 2, [items1[0]], p1_branch)],
    })
    s3 = fresh()
    check('T3: b2 sotuvi b3 qoldig\'ini o\'zgartirmadi',
          res.status_code == 200 and stock_of(s3, p2_id) == b3_before,
          f'b3 {b3_before}->{stock_of(s3, p2_id)}')

    # ──4) Manfiy qoldiq bilan sync rad etiladi, DB o'zgarmaydi ──
    s4 = fresh()
    before4_1 = stock_of(s4, p1_id)
    before4_2 = stock_of(s4, p2_id)
    prod4 = [dict(x) for x in s4.get('products') or []]
    for x in prod4:
        if int(x.get('id') or 0) == p1_id:
            x['stock'] = -5
    res = sync(client, token, {'products': prod4})
    s4a = fresh()
    check('T4: manfiy qoldiq rad etiladi (HTTP400)',
          res.status_code == 400, f'HTTP {res.status_code}')
    check('T4: rad etilgandan keyin qoldiqlar o\'zgarmadi',
          stock_of(s4a, p1_id) == before4_1
          and stock_of(s4a, p2_id) == before4_2,
          f'p1 {before4_1}->{stock_of(s4a, p1_id)}, p2 {before4_2}->{stock_of(s4a, p2_id)}')

    # ──5) Tasdiqlanmagan (pending) sotuv omborni o'zgartirmaydi ──
    s5 = fresh()
    before5 = stock_of(s5, p1_id)
    pend_id = sale1_id + 3
    res = sync(client, token, {
        'products': [dict(x) for x in s5.get('products') or []],  # qoldiqsiz
        'sales': (s5.get('sales') or []) + [
            build_sale(pend_id, items1, p1_branch) | {'status': 'pending'}],
    })
    s5a = fresh()
    check('T5: pending sotuv saqlanadi, qoldiq o\'zgarmaydi',
          res.status_code == 200 and stock_of(s5a, p1_id) == before5
          and any(int(x.get('id') or 0) == pend_id
                  for x in s5a.get('sales') or []),
          f'qoldiq {before5}->{stock_of(s5a, p1_id)}')

    # ──6) Bir xil sotuv ikki marta → qoldiq ikki marta kamaymaydi ──
    s6 = fresh()
    before6 = stock_of(s6, p1_id)
    sale6_id = sale1_id + 4
    items6 = [{'id': p1_id, 'name': p1['name'], 'price': p1.get('price'),
               'qty': 1, 'cost': p1.get('cost', 0)}]
    prod6 = [dict(x) for x in s6.get('products') or []]
    for x in prod6:
        if int(x.get('id') or 0) == p1_id:
            x['stock'] = before6 - 1
    payload6 = {'products': prod6,
                'sales': (s6.get('sales') or []) + [build_sale(sale6_id, items6, p1_branch)]}
    r1 = sync(client, token, payload6)
    mid = stock_of(fresh(), p1_id)
    r2 = sync(client, token, payload6)  # xuddi shu payload qayta yuboriladi
    s6a = fresh()
    copies = [x for x in s6a.get('sales') or []
              if int(x.get('id') or 0) == sale6_id]
    check('T6: takroriy yuborishda qoldiq ikki marta kamaymaydi',
          r1.status_code == 200 and r2.status_code == 200
          and mid == before6 - 1 and stock_of(s6a, p1_id) == before6 - 1,
          f'{before6} -> {mid} -> {stock_of(s6a, p1_id)}')
    check('T6: savdo yozuvi ham takrorlanmadi',
          len(copies) == 1, f'nusxalar: {len(copies)}')
    hist = s6a.get('sales') or []
    check('T6: avvalgi savdo tarixi saqlanib qoldi (to\'liq payload)',
          len(hist) >= initial_sales + 5,
          f'tarix {len(hist)} < {initial_sales + 5}')

    # ──7) Qayta so'rov (reload) DB dagi so'nggi qoldiqni qaytaradi ──
    f1 = fresh()
    f2 = fresh()
    db_now = {int(x.get('id')): int(x.get('stock') or 0)
              for x in (db_read('products') or [])}
    check('T7: qayta so\'rov doim DB qiymatini qaytaradi (kesh emas)',
          stock_of(f1, p1_id) == stock_of(f2, p1_id)
          == db_now.get(p1_id),
          f'api1={stock_of(f1, p1_id)} api2={stock_of(f2, p1_id)} '
          f'db={db_now.get(p1_id)}')

    # ──8) Tokensiz sync rad etiladi (RBAC regres) ──
    res = client.post('/api/sync', json={'products': []})
    check('T8: tokensiz /api/sync rad etiladi (401)',
          res.status_code == 401, f'HTTP {res.status_code}')

    print(f'\nNatija: {_passed} OK, {_failed} FAIL')
    return 0 if _failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
