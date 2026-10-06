# -*- coding: utf-8 -*-
"""
Boshliq UI uchun VAQTINCHALIK namuna ma'lumot kiritadi (faqat test uchun).
Sxema REAL bo'lishi shart: mahsulot/savdo/filial/xaridor yozuvlari
frontend bilan bir xil tuzilmada. Ma'lumot kiritilgach analytics
haqiqiy hisoblanadi; test tugagach `python _tp_boss_demo_data.py --clear`
bilan tozalanadi.
"""
import json
import sys
from datetime import datetime, timedelta

sys.path.insert(0, '.')
import app as tp  # noqa: E402

TODAY = datetime.now()


def d(offset):
    return (TODAY - timedelta(days=offset)).strftime('%d.%m.%Y')


def seed():
    store = tp.db_manager.get_all() or {}

    branches = [
        {'id': 'b1', 'name': 'Filial 1 — Markaziy', 'address': 'Toshkent, Markaziy',
         'status': 'active', 'phone': '+998901110001'},
        {'id': 'b2', 'name': 'Filial 2 — Yunusobod', 'address': 'Toshkent, Yunusobod',
         'status': 'active', 'phone': '+998901110002'},
        {'id': 'b3', 'name': 'Filial 3 — Sergeli', 'address': 'Toshkent, Sergeli',
         'status': 'inactive', 'phone': '+998901110003'},
    ]

    products = []
    catalog = [
        ('Samsung RB33', 'Muzlatgichlar', 'Samsung', 2890000, 2400000, 40, 'b1'),
        ('Samsung WM55', 'Kir Yuvish Mashinalari', 'Samsung', 1450000, 1180000, 3, 'b1'),
        ('LG GA-B22', 'Muzlatgichlar', 'LG', 2450000, 2050000, 2, 'b2'),
        ('Artel WC50', 'Kir Yuvish Mashinalari', 'Artel', 980000, 760000, 18, 'b2'),
        ('Philips 55PU', 'Televizorlar', 'Philips', 3150000, 2700000, 12, 'b1'),
        ('Bosch SMD', 'Peçlar'.replace('ç', 'c'), 'Bosch', 1750000, 1420000, 7, 'b2'),
        ('Dyson V12', 'Changyutgichlar', 'Dyson', 1650000, 1340000, 0, 'b1'),
        ('Samsung WW90', 'Kir Yuvish Mashinalari', 'Samsung', 1290000, 1020000, 15, 'b3'),
    ]
    for i, (name, cat, brand, price, cost, stock, bid) in enumerate(catalog, start=1):
        products.append({
            'id': 900 + i, 'name': name, 'cat': cat, 'brand': brand,
            'price': price, 'cost': cost, 'stock': stock, 'branchId': bid,
            'barcode': f'998{i:010d}', 'desc': '', 'img': '', 'vatPercent': 12,
        })

    cashiers = ['Karimov Kassir', 'Abdullayev Admin', 'Toshmatov Menejer', 'Boshliq']
    sales = []
    sale_id = 1
    for day in range(0, 26):
        for n in range(1 + (day % 3)):
            who = cashiers[(day + n) % len(cashiers)]
            items = []
            for k in range(1 + ((day + n) % 2)):
                p = products[(day + n + k) % len(products)]
                qty = 1 + ((day + k) % 3)
                items.append({'id': p['id'], 'name': p['name'], 'cat': p['cat'],
                              'price': p['price'], 'cost': p['cost'], 'qty': qty})
            subtotal = sum(i['price'] * i['qty'] for i in items)
            disc = 0 if subtotal % 3 else subtotal * 0.05
            total = subtotal - disc
            sales.append({
                'id': sale_id, 'items': items, 'subtotal': subtotal,
                'disc': 5 if disc else 0, 'discAmt': disc, 'total': total,
                'pay': 'Naqd', 'provider': 'cash',
                'time': f'{10 + (day % 8):02d}:{(n * 17) % 60:02d}:00',
                'date': d(day), 'cashier': who,
                'customer': 'Sinov mijoz', 'customerId': 501, 'status': 'paid',
            })
            sale_id += 1

    customers = [
        {'id': 501, 'name': 'Alisher Karimov', 'phone': '+998901234501',
         'email': '', 'orders': 5, 'total': 12500000, 'bonus': 1250, 'status': 'vip'},
        {'id': 502, 'name': 'Nodira Toshmatova', 'phone': '+998901234502',
         'email': '', 'orders': 3, 'total': 7400000, 'bonus': 740, 'status': 'active'},
        {'id': 503, 'name': 'Javlon Saidov', 'phone': '+998901234503',
         'email': '', 'orders': 0, 'total': 0, 'bonus': 0, 'status': 'inactive'},
    ]

    cash_flow = [
        {'id': 'cf1', 'type': 'kirim', 'amount': 45000000, 'category': 'Savdo tushumi',
         'note': 'Kunlik tushum', 'branchId': 'b1', 'date': d(1)},
        {'id': 'cf2', 'type': 'chiqim', 'amount': 18000000, 'category': "Ta'minotchi to'lovi",
         'note': 'Tovar', 'branchId': 'b1', 'date': d(3)},
        {'id': 'cf3', 'type': 'harajat', 'amount': 5200000, 'category': 'Oylik maosh',
         'note': 'Ish haqi', 'branchId': 'b2', 'date': d(5)},
        {'id': 'cf4', 'type': 'chiqim', 'amount': 2400000, 'category': 'Ijara',
         'note': 'Filial ijarasi', 'branchId': 'b2', 'date': d(8)},
    ]

    tp.db_manager.save_keys({
        'branches': branches, 'products': products, 'sales': sales,
        'customers': customers, 'cashFlow': cash_flow,
        'categories': sorted({p['cat'] for p in products}),
    })
    print(f"Namuna ma'lumot yozildi: {len(products)} mahsulot, {len(sales)} savdo, "
          f"{len(branches)} filial, {len(customers)} mijoz")


def clear():
    tp.db_manager.save_keys({
        'branches': [], 'products': [], 'sales': [], 'customers': [], 'cashFlow': [],
    })
    print('Namuna ma\'lumot tozalandi (bo\'sh holatga qaytarildi)')


if __name__ == '__main__':
    if '--clear' in sys.argv:
        clear()
    else:
        seed()