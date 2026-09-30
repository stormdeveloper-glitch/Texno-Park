"""
================================================================
FISKAL CHEK (QR-KODLI CHEK) MODULI — O'zbekiston qonunchiligi
================================================================

Bu modul onlayn savdo va kassa uchun **fiskal chek** shakllantiradi.
Fiskal chek O'zbekistonda majburiy: har bir xarid uchun soliq organining
fiskal moduli (OFD / Virtual kassa) orqali chek chiqarilishi va unda
QR-kod (fiskal belgi) bo'lishi shart.

QAT'IY QOIDALAR (kodda ham, serverda ham tekshiriladi):
  1. Chek FAQAT to'lov to'liq tasdiqlangandan keyin yaratiladi
     (savdo holati `paid` bo'lishi shart — `app.py` dagi endpoint
     buni majburiy tekshiradi, chetlab o'tib bo'lmaydi).
  2. QR-kod / fiskal belgi FAQAT OFD javobidan olinadi — biz uni
     hech qachon o'zimiz to'qib chiqarmaymiz. OFD javob bermasa,
     chek `failed` holatida qoladi va chop etilmaydi.
  3. Har bir mahsulotda soliq talab qiladigan maydonlar bo'lishi shart:
        • ikpu_code    — MXIK kodi (17 xonali)
        • package_code — qadoqlash kodi
        • vat_percent  — QQS stavkasi (masalan 12 yoki 0)
        • title, price, count
  4. Maxfiy kalitlar (merchant_id, secret_key, api_key) FAQAT `.env`
     dan olinadi va hech qachon javobda/logda ko'rsatilmaydi.

Qo'llab-quvvatlanadigan provayderlar (`FISCAL_PROVIDER`):
    • multikassa  — MultiKassa fiskal moduli API
    • soliq       — Soliq qo'mitasi Virtual kassa / OFD API
    • payme       — Payme Business fiskal chek API
    • custom      — istalgan OFD (maydon nomlari .env orqali sozlanadi)
    • disabled    — fiskal modul ulanmagan (chek chiqarilmaydi)

Misol (.env):
    FISCAL_PROVIDER=multikassa
    FISCAL_API_URL=https://api.multikassa.uz/api/v1/receipt
    FISCAL_MERCHANT_ID=12345
    FISCAL_SECRET_KEY=super-secret-key
    FISCAL_TERMINAL_ID=POS-01
    FISCAL_REQUIRED=true
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime

# ============================================================
# SOZLAMALAR (.env dan)
# ============================================================
# Provayder: multikassa | soliq | payme | custom | disabled
FISCAL_PROVIDER = (os.getenv('FISCAL_PROVIDER') or 'disabled').strip().lower()
# Fiskal modul API manzili (to'liq endpoint)
FISCAL_API_URL = (os.getenv('FISCAL_API_URL') or '').strip()
# Savdogar/kassa identifikatorlari
FISCAL_MERCHANT_ID = (os.getenv('FISCAL_MERCHANT_ID') or '').strip()
FISCAL_TERMINAL_ID = (os.getenv('FISCAL_TERMINAL_ID') or 'POS-01').strip()
# Maxfiy kalit (Bearer yoki imzo uchun) — HECH QACHON javobga qo'shilmaydi
FISCAL_SECRET_KEY = (os.getenv('FISCAL_SECRET_KEY') or '').strip()
# Ba'zi OFD'lar alohida API kalit talab qiladi
FISCAL_API_KEY = (os.getenv('FISCAL_API_KEY') or '').strip()
# So'rov kutish vaqti (sekund)
FISCAL_TIMEOUT = max(5, min(60, int(os.getenv('FISCAL_TIMEOUT_SECONDS', '20') or 20)))
# true — fiskal chek majburiy (chek QR'siz chiqmaydi); false — ogohlantirish bilan
FISCAL_REQUIRED = (os.getenv('FISCAL_REQUIRED', 'true').strip().lower() != 'false')
# Standart QQS stavkasi (%) — mahsulotda ko'rsatilmagan bo'lsa ishlatiladi
FISCAL_DEFAULT_VAT = float(os.getenv('FISCAL_DEFAULT_VAT_PERCENT', '12') or 12)
# Chekdagi kompaniya ma'lumotlari (bo'sh bo'lsa /api/config dan olinadi)
FISCAL_COMPANY_NAME = (os.getenv('FISCAL_COMPANY_NAME') or '').strip()
FISCAL_COMPANY_TIN = (os.getenv('FISCAL_COMPANY_TIN') or '').strip()
FISCAL_COMPANY_ADDRESS = (os.getenv('FISCAL_COMPANY_ADDRESS') or '').strip()

# `custom` provayder uchun javob maydonlarini moslash (nuqtali yo'l: data.qr)
CUSTOM_URL_FIELD = (os.getenv('FISCAL_RESPONSE_URL_FIELD') or 'data.receipt_url').strip()
CUSTOM_SIGN_FIELD = (os.getenv('FISCAL_RESPONSE_SIGN_FIELD') or 'data.fiscal_sign').strip()
CUSTOM_NUMBER_FIELD = (os.getenv('FISCAL_RESPONSE_NUMBER_FIELD') or 'data.receipt_id').strip()

# IKPU (MXIK) — 17 xonali kod
IKPU_PATTERN = re.compile(r'^\d{17}$')
PACKAGE_PATTERN = re.compile(r'^[A-Za-z0-9\-_.]{1,20}$')


class FiscalError(Exception):
    """Fiskal modul bilan ishlashda yuzaga kelgan xatolik."""


# ============================================================
# YORDAMCHI FUNKSIYALAR
# ============================================================
def _to_int(value, default=0):
    """Xavfsiz butun songa o'girish."""
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _money_to_tiyin(amount):
    """So'mni tiyinə o'girish (1 so'm = 100 tiyin) — OFD API'lari shuni kutadi."""
    return _to_int(float(amount or 0) * 100)


def _pick(data, path, default=''):
    """`data` obyektidan nuqtali yo'l bo'yicha qiymat oladi: `data.qr_code`."""
    current = data
    for part in str(path or '').split('.'):
        if not part:
            continue
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return default
    return current if current is not None else default


def _first_of(data, keys, default=''):
    """Javobdan birinchi topilgan maydonni oladi (provayderlar har xil nomlaydi)."""
    for key in keys:
        value = _pick(data, key, None)
        if value not in (None, '', []):
            return value
    return default


def _mask(value):
    """Maxfiy qiymatni ko'rsatish uchun niqoblaydi (log/javob uchun)."""
    text = str(value or '')
    if len(text) <= 4:
        return '••••' if text else ''
    return text[:2] + '•' * (len(text) - 4) + text[-2:]


# ============================================================
# MAHSULOT MAYDONLARINI TEKSHIRISH (IKPU / QADOQ / QQS)
# ============================================================
def validate_item(item):
    """
    Bitta chek qatorini soliq talablari bo'yicha tekshiradi.
    Qaytaradi: (ok: bool, errors: list[str])
    """
    errors = []
    if not isinstance(item, dict):
        return False, ['Chek qatori obyekt emas']

    title = str(item.get('title') or item.get('name') or '').strip()
    if not title:
        errors.append('Mahsulot nomi (title) bo\'sh')

    count = _to_int(item.get('count') or item.get('qty') or item.get('quantity'))
    if count <= 0:
        errors.append(f'«{title or "?"}» uchun soni (count) noto\'g\'ri')

    price = _to_int(item.get('price'))
    if price <= 0:
        errors.append(f'«{title or "?"}» uchun narx (price) noto\'g\'ri')

    ikpu = str(item.get('ikpu_code') or item.get('ikpu') or '').strip()
    if not IKPU_PATTERN.match(ikpu):
        errors.append(f'«{title or "?"}» uchun IKPU/MXIK kodi 17 xonali bo\'lishi shart')

    package_code = str(item.get('package_code') or item.get('packageCode') or '').strip()
    if not PACKAGE_PATTERN.match(package_code):
        errors.append(f'«{title or "?"}» uchun qadoqlash kodi (package_code) noto\'g\'ri')

    try:
        vat = float(item.get('vat_percent', item.get('vatPercent')))
    except (TypeError, ValueError):
        errors.append(f'«{title or "?"}» uchun QQS stavkasi (vat_percent) noto\'g\'ri')
        vat = -1
    if vat < 0 or vat > 30:
        errors.append(f'«{title or "?"}» uchun QQS stavkasi 0..30 oralig\'ida bo\'lishi kerak')

    return (len(errors) == 0), errors


def normalize_item(item):
    """Mahsulotni fiskal API kutayotgan ko'rinishga keltiradi."""
    name = str(item.get('title') or item.get('name') or '').strip()[:200]
    count = max(1, _to_int(item.get('count') or item.get('qty') or 1))
    price = max(1, _to_int(item.get('price')))
    try:
        vat = float(item.get('vat_percent', item.get('vatPercent', FISCAL_DEFAULT_VAT)))
    except (TypeError, ValueError):
        vat = FISCAL_DEFAULT_VAT
    total = price * count
    # Narx QQS bilan (brutto) — QQS summasi ichidan ajratib olinadi:
    #   vat_amount = total * vat / (100 + vat)
    vat_amount = _to_int(round(total * vat / (100 + vat))) if vat > 0 else 0
    return {
        'title': name,
        'ikpu_code': str(item.get('ikpu_code') or item.get('ikpu') or '').strip(),
        'package_code': str(item.get('package_code') or item.get('packageCode') or '').strip(),
        'vat_percent': _to_int(vat),
        'price': price,                       # so'mda (QQS bilan)
        'count': count,
        'total': total,                       # so'mda
        'price_tiyin': _money_to_tiyin(price),   # tiyin (OFD uchun)
        'total_tiyin': _money_to_tiyin(total),
        'vat_amount': vat_amount,                # so'mda
        'vat_amount_tiyin': _money_to_tiyin(vat_amount),
        'price_without_vat': max(0, price - (vat_amount // count if count else 0)),
    }


def build_payload(sale, company=None):
    """
    Savdo yozuvidan fiskal chek so'rovini yig'adi.

    `sale` — savdo obyekti (items, total, pay, customer, cashier, id, date, time).
    `company` — kompaniya ma'lumotlari (nom, STIR, manzil) — `/api/config` dan.
    """
    if not isinstance(sale, dict):
        raise FiscalError('Savdo yozuvi topilmadi')
    company = company or {}
    raw_items = [i for i in (sale.get('items') or []) if isinstance(i, dict)]
    if not raw_items:
        raise FiscalError('Chekda mahsulot yo\'q')

    items = [normalize_item(i) for i in raw_items]
    total = _to_int(sale.get('total')) or sum(i['total'] for i in items)
    vat_total = sum(i['vat_amount'] for i in items)

    return {
        'receipt_id': str(sale.get('id')),
        'external_id': f"POS-{sale.get('id')}-{int(time.time())}",
        'time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'sale_time': f"{sale.get('date', '')} {sale.get('time', '')}".strip(),
        'cashier': str(sale.get('cashier') or '')[:120],
        'customer': str(sale.get('customer') or '')[:120],
        'payment_type': _payment_type_code(sale.get('provider') or sale.get('pay')),
        'payment_label': str(sale.get('pay') or '')[:40],
        'merchant_id': FISCAL_MERCHANT_ID,
        'terminal_id': FISCAL_TERMINAL_ID,
        'company': {
            'name': company.get('name') or FISCAL_COMPANY_NAME,
            'tin': company.get('tin') or company.get('inn') or FISCAL_COMPANY_TIN,
            'address': company.get('address') or FISCAL_COMPANY_ADDRESS,
        },
        'items': items,
        'total': total,
        'total_tiyin': _money_to_tiyin(total),
        'vat_total': vat_total,
        'vat_total_tiyin': _money_to_tiyin(vat_total),
    }


def _payment_type_code(value):
    """To'lov turini OFD kutilgan kodga o'giradi (1-naqd, 2-karta, 3-onlayn)."""
    text = str(value or '').lower()
    if 'naqd' in text or 'cash' in text:
        return 1
    if 'karta' in text or 'card' in text or 'terminal' in text:
        return 2
    return 3


def validate_payload(payload):
    """Butun chekni tekshiradi (ikpu/qadoq/QQS/son/narx)."""
    errors = []
    if not payload.get('items'):
        errors.append('Chekda mahsulot yo\'q')
    for item in payload.get('items', []):
        ok, item_errors = validate_item(item)
        if not ok:
            errors.extend(item_errors)
    if _to_int(payload.get('total')) <= 0:
        errors.append('Chek summasi noldan katta bo\'lishi kerak')
    return errors


# ============================================================
# API SO'ROVI (HTTP)
# ============================================================
def _provider_request(payload):
    """
    Fiskal modul API'siga so'rov yuboradi va xom javobni qaytaradi.

    Har bir provayder uchun so'rov tanasi (body) va sarlavhalari farq qiladi,
    shuning uchun ular alohida funksiyalarda yig'iladi.
    """
    if FISCAL_PROVIDER == 'disabled':
        raise FiscalError('Fiskal modul ulanmagan (FISCAL_PROVIDER=disabled)')
    if not FISCAL_API_URL:
        raise FiscalError('FISCAL_API_URL .env da ko\'rsatilmagan')
    if not FISCAL_SECRET_KEY and not FISCAL_API_KEY:
        raise FiscalError('Fiskal modul maxfiy kaliti (FISCAL_SECRET_KEY) ko\'rsatilmagan')

    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'TexnoPark-POS/3.0 (+fiscal)',
    }
    if FISCAL_PROVIDER == 'multikassa':
        headers['Authorization'] = f'Bearer {FISCAL_SECRET_KEY}'
        body = {
            'merchant_id': FISCAL_MERCHANT_ID,
            'cashbox_id': FISCAL_TERMINAL_ID,
            'receipt': payload,
        }
    elif FISCAL_PROVIDER == 'soliq':
        # Virtual kassa / OFD: terminal + parol (maxfiy) orqali autentifikatsiya
        headers['X-API-KEY'] = FISCAL_API_KEY or FISCAL_SECRET_KEY
        body = {
            'terminal_id': FISCAL_TERMINAL_ID,
            'merchant_id': FISCAL_MERCHANT_ID,
            'password': FISCAL_SECRET_KEY,
            'receipt': payload,
        }
    elif FISCAL_PROVIDER == 'payme':
        headers['Authorization'] = f'Bearer {FISCAL_SECRET_KEY}'
        headers['X-Merchant-Id'] = FISCAL_MERCHANT_ID
        body = {'receipt': payload}
    elif FISCAL_PROVIDER == 'custom':
        # Maydon nomlarini .env orqali moslashtirish mumkin
        headers['Authorization'] = f'Bearer {FISCAL_API_KEY or FISCAL_SECRET_KEY}'
        body = {
            'merchant_id': FISCAL_MERCHANT_ID,
            'terminal_id': FISCAL_TERMINAL_ID,
            'items': payload['items'],
            'total': payload['total_tiyin'],
            'received_cash': payload['total_tiyin'],
            'received_card': 0,
            'payment_type': payload['payment_type'],
            'time': payload['time'],
            'external_id': payload['external_id'],
        }
    else:
        raise FiscalError(f'Noma\'lum fiskal provayder: {FISCAL_PROVIDER}')

    request = urllib.request.Request(
        FISCAL_API_URL,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers=headers,
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=FISCAL_TIMEOUT) as response:
            raw = response.read().decode('utf-8', 'ignore')
        return json.loads(raw or '{}')
    except urllib.error.HTTPError as exc:
        # Xato tanasi foydali bo'lishi mumkin, lekin maxfiy kalit qaytmaydi
        detail = ''
        try:
            detail = exc.read().decode('utf-8', 'ignore')[:300]
        except Exception:
            detail = ''
        raise FiscalError(f'OFD HTTP xatosi {exc.code}: {detail}') from exc
    except urllib.error.URLError as exc:
        raise FiscalError(f'OFD bilan aloqa yo\'q: {exc.reason}') from exc
    except json.JSONDecodeError as exc:
        raise FiscalError('OFD javobi JSON formatida emas') from exc


def _parse_response(data):
    """
    OFD javobidan chek havolasi, fiskal belgi (QR) va chek raqamini oladi.
    Bu yerda hech narsa o'ylab topilmaydi — faqat API qaytargan qiymatlar.
    """
    if not isinstance(data, dict):
        raise FiscalError('OFD javobi tushunarsiz')

    # Ba'zi OFD'lar xatoni 200 bilan qaytaradi
    if data.get('success') is False and not (data.get('data') or data.get('result')):
        message = _first_of(data, ['error.message', 'message', 'error', 'errors.0.message'], 'noma\'lum xato')
        raise FiscalError(f'OFD rad etdi: {message}')

    if FISCAL_PROVIDER == 'custom':
        url = _pick(data, CUSTOM_URL_FIELD, '')
        sign = _pick(data, CUSTOM_SIGN_FIELD, '')
        number = _pick(data, CUSTOM_NUMBER_FIELD, '')
    else:
        url = _first_of(data, [
            'data.receipt_url', 'data.receiptUrl', 'data.url', 'data.qr_url',
            'result.receipt_url', 'result.url', 'receipt_url', 'receiptUrl', 'url',
        ])
        sign = _first_of(data, [
            'data.fiscal_sign', 'data.fiscalSign', 'data.qr_code', 'data.qrCode',
            'data.qr', 'data.fiscal_mark',
            'result.qrCode', 'result.fiscal_sign', 'result.qr_code', 'result.fiscalSign',
            'qr_code', 'qrCode', 'fiscal_sign', 'fiscalSign', 'fiscal_mark',
        ])
        number = _first_of(data, [
            'data.receipt_id', 'data.receiptId', 'data.fiscal_number', 'data.fm',
            'result.receipt_id', 'result.fm', 'receipt_id', 'receiptId', 'fiscal_number',
        ], f"POS-{int(time.time())}")

    device_id = _first_of(data, [
        'data.device_id', 'data.cashbox_id', 'data.kkm_id', 'result.deviceId',
        'result.kkm_id', 'device_id', 'kkm_id',
    ], FISCAL_TERMINAL_ID)

    return {
        'receipt_url': str(url or '').strip(),
        'fiscal_sign': str(sign or '').strip(),
        'fiscal_number': str(number or '').strip(),
        'device_id': str(device_id or '').strip(),
    }


# ============================================================
# ASOSIY FUNKSIYA
# ============================================================
def fiscalize(sale, company=None):
    """
    Savdo uchun fiskal chek yaratadi.

    Qaytaradi (har doim dict — xatolik ham natija sifatida qaytadi):
        {
          'ok': bool,
          'fiscalStatus': 'ok' | 'failed' | 'not_configured',
          'fiscalProvider': 'multikassa',
          'fiscalUrl': 'https://ofd.uz/check/...',
          'fiscalSign': '...',            # QR-kodga yoziladigan fiskal belgi
          'fiscalNumber': '...',
          'fiscalDeviceId': '...',
          'fiscalTime': '21.09.2026 13:45:02',
          'fiscalTotal': 4200000,
          'fiscalError': '',
          'items': [ ...  # fiskal qatorlar (IKPU/QQS bilan) ]
        }
    """
    stamp = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    result = {
        'ok': False,
        'fiscalStatus': 'failed',
        'fiscalProvider': FISCAL_PROVIDER,
        'fiscalUrl': '',
        'fiscalSign': '',
        'fiscalNumber': '',
        'fiscalDeviceId': '',
        'fiscalTime': stamp,
        'fiscalTotal': _to_int(sale.get('total') if isinstance(sale, dict) else 0),
        'fiscalError': '',
        'fiscalRequired': FISCAL_REQUIRED,
        'items': [],
    }

    # 1) Fiskal modul umuman ulanmagan bo'lsa
    if FISCAL_PROVIDER == 'disabled':
        result['fiscalStatus'] = 'not_configured'
        result['fiscalError'] = ('Fiskal modul ulanmagan — .env da FISCAL_PROVIDER, '
                                 'FISCAL_API_URL va FISCAL_SECRET_KEY ni to\'ldiring')
        return result

    # 2) Chekni yig'ish va soliq maydonlarini tekshirish
    try:
        payload = build_payload(sale, company)
    except FiscalError as exc:
        result['fiscalError'] = str(exc)
        return result

    errors = validate_payload(payload)
    result['items'] = payload['items']
    if errors:
        # IKPU/qadoq/QQS to'lmagan bo'lsa chek chiqarilmaydi (qonun talabi)
        result['fiscalError'] = 'Chek talablariga mos emas: ' + '; '.join(errors[:4])
        return result

    # 3) OFD ga so'rov
    try:
        raw = _provider_request(payload)
        parsed = _parse_response(raw)
    except FiscalError as exc:
        result['fiscalError'] = str(exc)
        return result
    except Exception as exc:  # kutilmagan xatolik — kassani to'xtatmaymiz
        result['fiscalError'] = f'Fiskal modulda kutilmagan xatolik: {exc}'
        return result

    # 4) QR/fiskal belgi bo'lmasa chek yaroqli hisoblanmaydi
    if not parsed['fiscal_sign'] and not parsed['receipt_url']:
        result['fiscalError'] = 'OFD javobida fiskal belgi (QR) ham, chek havolasi ham yo\'q'
        return result

    result.update({
        'ok': True,
        'fiscalStatus': 'ok',
        'fiscalUrl': parsed['receipt_url'],
        'fiscalSign': parsed['fiscal_sign'],
        'fiscalNumber': parsed['fiscal_number'],
        'fiscalDeviceId': parsed['device_id'],
        'fiscalError': '',
    })
    return result


def fiscal_config_state():
    """Frontend va admin panel uchun fiskal modul holati (maxfiy kalitlarsiz)."""
    configured = bool(FISCAL_PROVIDER != 'disabled' and FISCAL_API_URL
                      and (FISCAL_SECRET_KEY or FISCAL_API_KEY))
    return {
        'provider': FISCAL_PROVIDER,
        'configured': configured,
        'required': FISCAL_REQUIRED,
        'terminalId': FISCAL_TERMINAL_ID,
        'merchantId': FISCAL_MERCHANT_ID,
        'merchantIdMasked': _mask(FISCAL_MERCHANT_ID),
        'secretMasked': _mask(FISCAL_SECRET_KEY),
        'defaultVatPercent': FISCAL_DEFAULT_VAT,
        'company': {
            'name': FISCAL_COMPANY_NAME,
            'tin': FISCAL_COMPANY_TIN,
            'address': FISCAL_COMPANY_ADDRESS,
        },
    }
