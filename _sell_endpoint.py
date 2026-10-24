"""Savdo endpointi uchun app.py ichiga qo'shiladigan kod parchasi."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app import (
        _money_str,
        _next_server_sale_id,
        _num,
        _sale_clock_str,
        _sale_day_str,
        _sale_stamp_str,
        app,
        db_manager,
        json_error,
        jsonify,
        request,
        require_staff,
    )


# POS SELL ENDPOINT
# ─────────────────────────────────────────────────────────────────────────────
@app.route('/api/sell', methods=['POST'])
@require_staff()
def api_sell():
    """Sotuvlash: mahsulot ID, miqdori, narxi, filialni serverda tekshirib,
    savdoni saqlab qo'yadi va ombor qoldig'ini atomar ravishda yangilaydi.

    Body:
    {
      "items": [{"id": 1, "qty": 3, "price": 50000, "name": "Telefon"}],
      "branchId": "b2",
      "cashierLogin": "...",
      "cashier": "...",
      "customer": "...",
      "customerId": 123,
      "pay": "cash",
      "provider": "cash",
      "total": 150000,
      "disc": 0,
      "discAmt": 0,
      "date": "23.10.2026",
      "time": "15:30:00"
    }
    - `branchId` taghliq to'ldirilishi shart (POS filiali)
    - U holda qoldiq faqat muvaffaqiyatli yakunlangan savdolar uchun kamayadi
    - Xatolik paydo bo'lsa offtel 400, savdo qaytarilmaydi
    - Natija: {status: 'success', sale, productStocks[]}
    """
    store = db_manager.get_all() or {}
    products = [p for p in (store.get('products') or []) if isinstance(p, dict)]
    staff = getattr(request, 'staff', {}) or {}
    cashier_login = str(staff.get('sub') or '').strip()
    cashier_name = str(staff.get('name') or 'Noma\'lum').strip()

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return json_error('So\'rov ma\'lumotlari noto\'g\'ri formatda.', 400)
    items = body.get('items')
    if not isinstance(items, list) or len(items) == 0:
        return json_error('Savdo itemlari bo\'sh yoki noto\'g\'ri formatda.', 400)
    if len(items) > 500:
        return json_error('Savdo itemlari maksimal: 500 ta.', 400)

    branch_id = str(body.get('branchId') or '').strip()
    if not branch_id:
        return json_error('Filial tanlanmagan. POS da filial aniqlanishi shart.', 400)

    # Filialga biriktirilgan mahsulot faqat o'z filialida sotiladi.
    # Umumiy ombor mahsulotlari (branchId bo'sh) istalgan filialda sotilishi mumkin.
    for item in items:
        if not isinstance(item, dict):
            return json_error('Savdo elementi formati noto\'g\'ri.', 400)
        pid = str(item.get('id'))
        p = next((x for x in products if str(x.get('id')) == pid), None)
        if p is None:
            return json_error(f'Mahsulot #{pid} ro\'yxatdan o\'chirilgan.', 400)
        product_branch = str(p.get('branchId') or '').strip()
        if product_branch and product_branch != branch_id:
            return json_error(f'Mahsulot #{pid} bu filialga tegishli emas.', 400)

    # Natija shabloni (secret-safe)
    sale = {
        'id': body.get('id') or _next_server_sale_id(store),
        'items': items,
        'cashier': cashier_name,
        'cashierLogin': cashier_login,
        'customer': body.get('customer') or 'Noma\'lum',
        'customerId': body.get('customerId') or None,
        'branchId': branch_id,
        'pay': body.get('pay') or 'cash',
        'provider': body.get('provider') or 'cash',
        'total': _num(body.get('total') or 0),
        'disc': _num(body.get('disc') or 0),
        'discAmt': _num(body.get('discAmt') or 0),
        'subtotal': _num(body.get('subtotal') or 0),
        'date': body.get('date') or _sale_day_str(),
        'time': body.get('time') or _sale_clock_str(),
        'status': 'paid' if not body.get('isOnline') else 'pending',
        'createdAt': _sale_stamp_str(),
    }

    # Qoldiq tekshiruv va omborni tanqidlash (atomar — hamma ta'sir bir vaqtda)
    deductions = []
    errors = []
    for item in items:
        pid = str(item.get('id'))
        p = next((x for x in products if str(x.get('id')) == pid), None)
        if p is None:
            errors.append(f'Mahsulot #{pid} ro\'yxatdan o\'chirilgan.')
            continue
        qty = int(_num(item.get('qty')))
        if qty <= 0:
            errors.append(f'Mahsulot #{pid} uchun miqdor 0 dan katta bo\'lishi kerak.')
            continue
        price = _num(item.get('price'))
        if price < 0:
            errors.append(f'Mahsulot #{pid} narxi manfiy bo\'lmasligi kerak.')
            continue
        if not body.get('isOnline'):
            old_stock = int(_num(p.get('stock')) or 0)
            if old_stock < qty:
                errors.append(f'{p.get("name")} — yetarli qoldiq yo\'q. Mavjud: {old_stock}, so\'ralgan: {qty}.')
                continue
            new_stock = old_stock - qty
            p['stock'] = new_stock
            deductions.append({
                'id': pid, 'name': str(p.get('name')),
                'price': price, 'currency': 'so\'m',
                'qty': qty, 'oldStock': old_stock, 'stock': new_stock,
            })

    if errors:
        return json_error('Sawatda mavjud ma\'lumotlar bilan mos kelmasa: ' + '; '.join(errors), 400)

    # Savdo ro'yxatiga qo'shish
    store.setdefault('sales', [])
    store['sales'].append(sale)
    store['audit_log'] = store.get('audit_log') or []
    store['audit_log'].append({
        'action': 'sale-create', 'message': f"Chek #{sale['id']}",
        'detail': f"{cashier_name} — {branch_id} filiali, {len(items)} ta mahsulot, {_money_str(sale['total'])} so'm",
        'username': cashier_name, 'date': sale['date'], 'time': sale['time'],
    })

    # Savdo muvaffaqiyatli bo\'lsa — yangi qoldiqlarni qaytarish
    productStocks = []
    for item in items:
        pid = str(item.get('id'))
        p = next((x for x in products if str(x.get('id')) == pid), None)
        if p:
            productStocks.append({'id': pid, 'name': str(p.get('name')),
                                  'stock': int(_num(p.get('stock')) or 0)})

    # DB saqlash
    try:
        db_manager.save_keys(store)
    except Exception as e:
        print(f'[ERROR] /api/sell db save: {e}')
        return json_error('Ma\'lumotni saqlashda xatolik', 500)

    return jsonify({
        'status': 'success', 'sale': sale,
        'productStocks': productStocks,
        'message': 'Savdo muvaffaqiyatli yakunlandi',
    })
