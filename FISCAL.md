# Fiskal chek (QR-kodli chek) — integratsiya qo'llanmasi

O'zbekiston qonunchiligiga ko'ra har bir xarid uchun **fiskal chek** chiqarilishi va
chekda **QR-kod (fiskal belgi)** bo'lishi shart. Bu loyihada fiskal chek
**OFD / fiskal modul API'si** (MultiKassa, Soliq qo'mitasi Virtual kassa, Payme Business
yoki istalgan `custom` OFD) orqali shakllantiriladi.

Tizim **chekni o'zi to'qib chiqarmaydi**: QR-kod va chek havolasi faqat OFD javobidan
olinadi. OFD javob bermasa — chek chop etilmaydi.

## 1. Qat'iy qoidalar (kodda majburiy)

| Qoida | Qayerda tekshiriladi |
|---|---|
| Chek **faqat to'lov tasdiqlangandan keyin** (`status === 'paid'`) chiqadi | Mijoz: `Fiscal.canPrint()`, `printReceipt()` · Server: `POST /api/fiscal/receipt` (409 `payment_not_confirmed`) |
| QR-kod / chek havolasi faqat OFD javobidan olinadi | `fiscal.py` → `_parse_response()` |
| Majburiy maydonlar: `ikpu_code` (17 xonali), `package_code`, `vat_percent`, `title`, `price`, `count` | `fiscal.py` → `validate_item()` · Server: `/api/sync` validatsiyasi · Mijoz: mahsulot formasi |
| Maxfiy kalitlar faqat `.env` da, javobda/logda ko'rinmaydi | `fiscal.py` (Bearer sarlavhasi), `/api/fiscal/status` faqat `merchantIdMasked` qaytaradi |
| Brauzer fiskal maydonlarni yasab bo'lmaydi | `/api/sync` savdo yozuvlaridan `fiscal*` maydonlarni olib tashlaydi, `apply_fiscal_keep()` bazadagisini tiklaydi |
| Fiskal chek faqat **admin** panelidan boshqariladi | `/api/fiscal/pending*` → `require_staff('admin')` |

## 2. `.env` sozlamalari

```ini
# disabled | multikassa | soliq | payme | custom
FISCAL_PROVIDER=multikassa
FISCAL_API_URL=https://api.multikassa.uz/api/v1/receipt
FISCAL_MERCHANT_ID=12345
FISCAL_TERMINAL_ID=POS-01
FISCAL_SECRET_KEY=super-secret-key
FISCAL_REQUIRED=true
FISCAL_DEFAULT_VAT_PERCENT=12
```

`custom` provayderda javob maydonlarini moslashtirish mumkin:

```ini
FISCAL_PROVIDER=custom
FISCAL_API_URL=https://ofd.example.uz/api/receipt
FISCAL_RESPONSE_URL_FIELD=data.receipt_url
FISCAL_RESPONSE_SIGN_FIELD=data.fiscal_sign
FISCAL_RESPONSE_NUMBER_FIELD=data.receipt_id
```

## 3. Chek qanday chiqadi (oqim)

1. Kassir «To'lov» tugmasini bosadi.
2. Naqd/karta uchun **tasdiq oynasi** chiqadi («To'lov qabul qilindimi?»). Bekor qilinsa
   savdo saqlanmaydi va chek chiqmaydi. Onlayn to'lovlarda savdo `pending` bo'ladi.
3. Savdo bazaga yoziladi (`flushSyncNow()`), so'ng brauzer `POST /api/fiscal/receipt`
   so'rovini yuboradi.
4. Server savdo holatini tekshiradi (`paid` bo'lmasa **409**), so'ng `fiscal.py` orqali
   OFD'ga so'rov yuboradi: mahsulot qatorlari IKPU/qadoq/QQS va tiyin narxlari bilan.
5. OFD javobidagi `receipt_url` + `fiscal_sign` savdo yozuviga saqlanadi
   (`fiscalUrl`, `fiscalSign`, `fiscalNumber`, `fiscalDeviceId`, `fiscalTime`).
6. Brauzer chekka **QR-kod**ni mahalliy generatsiya qiladi (`qrcode.min.js`) va chop etish
   tugmasi faollashadi. QR bo'lmasa / to'lov tasdiqlanmagan bo'lsa tugma bloklangan.
7. Onlayn to'lovlarda to'lov webhook orqali tasdiqlanadi (`_confirm_payment_order`) — shu
   paytda server fiskal chekni **fon rejimida** o'zi chiqaradi.

## 4. API endpointlar

| Metod | Yo'l | Huquq | Izoh |
|---|---|---|---|
| GET | `/api/fiscal/status` | xodim | Holat: provayder, sozlanganlik, kompaniya (kalitlar niqoblangan) |
| POST | `/api/fiscal/receipt` | xodim | `{saleId, force?}` → chek chiqaradi (faqat `paid` savdo uchun) |
| GET | `/api/fiscal/receipt/<id>` | xodim | Saqlangan chek: QR havola va fiskal belgi |
| GET | `/api/fiscal/pending` | admin | Chek chiqarilmagan to'langan savdolar |
| POST | `/api/fiscal/pending/run` | admin | Ularga chek chiqaradi (bir marta 25 taga qadar) |

## 5. Mahsulot maydonlari

Mahsulot qo'shish/tahrirlash formasida:

- **IKPU (MXIK) kodi** — 17 xonali (masalan `08801001001000000`);
- **Qadoqlash kodi** — harf/raqam (masalan `PKG01`);
- **QQS stavkasi** — 12% yoki 0%.

Majburiy maydonlar to'ldirilmagan bo'lsa mahsulot saqlanmaydi (`IKPU (MXIK) xato`), chunki
bunday mahsulot uchun fiskal chek chiqmaydi. Mahsulotlar jadvalida IKPU yo'q bo'lsa
«IKPU yo'q» belgisi ko'rinadi.

QQS summasi narx ichidan ajratib olinadi: `vat = total × QQS / (100 + QQS)`.

## 6. Admin panel — «Fiskal chek holati»

**Sozlamalar → 🔐 Xavfsizlik → Fiskal chek (QR-kod) holati**
(server endpointlari: `/api/fiscal/pending`, `/api/fiscal/status`)

- provayder, sozlanganlik, majburiylik, kassa ID, QQS, kompaniya/STIR;
- cheki chiqarilmagan to'langan savdolar ro'yxati va **«Cheklarni chiqarish»** tugmasi
  (bir martada 25 ta, keyin qolganlari).

Sayohat (F1) shu panelni ham tushuntiradi.

## 7. Sinov

`FISCAL_PROVIDER=disabled` holatida (standart) chek chiqmaydi — bu xavfsiz sozlama.
OFD hali ulanmagan bo'lsa ham tizim savdoni saqlaydi, lekin **chek chop etilmaydi** va
admin «Cheklarni chiqarish» orqali keyin chiqaradi.

OFD'ga ulanmasdan tekshirish uchun vaqtinchalik mock server ishlatish mumkin:

```bash
# 1) mock OFD (javob: data.receipt_url + data.fiscal_sign)
# 2) FISCAL_PROVIDER=custom FISCAL_API_URL=http://127.0.0.1:5199/receipt
# 3) DB_PATH=/tmp/test.db PORT=5061 python app.py
```

Tekshiriladigan holatlar: `pending` savdoga chek chiqmasligi (409), `paid` savdoga
QR havola saqlanishi, OFD so'rovida IKPU/QQS/tiyin bo'lishi, maxfiy kalit so'rovda
ketmasligi, brauzer yasagan `fiscalSign` qabul qilinmasligi, kassirga admin panel yopiq
bo'lishi (403).
