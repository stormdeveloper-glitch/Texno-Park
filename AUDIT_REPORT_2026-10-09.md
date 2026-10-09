# Texno Park N1 POS — Xavfsizlik va sifat auditi

**Sana:** 2026-10-09
**Tekshirilgan:** `app.py` (5659 qator), `fiscal.py`, `scripts.js`, `boss.js`, `index.html`, `.env`, `.env.example`, ma'lumotlar bazasi, git tarixi va GitHub repo.
**Metod:** kod o'qish + **jonli HTTP tekshiruv** (Flask server ishga tushirilib, har bir da'vo real so'rov bilan tasdiqlandi).

---

## 1. Qisqa xulosa

Loyiha **yaxshi yozilgan**: serverda RBAC (`@require_staff`), imzolangan tokenlar, sessiya reyestri, brute-force cheklovi, fayl yuklashda magic-bytes tekshiruvi, SQL parametrlash, S3 presigned havolalar, xavfsizlik sarlavhalari (CSP/HSTS), kiritish validatsiyasi — hammasi bor.

Ammo **hujum yuzasi (attack surface) juda katta** bo'lib qolgan edi: bitta catch-all marshrut butun loyiha ildizini (jumladan `.env` va `.git`) tashqi tarmoqqa ochib qo'ygan edi. Shu tuzatildi. Qolgan topilmalar asosan **maxfiy ma'lumotlarni almashtirish (rotation)** va **bazadagi test akountlar** bilan bog'liq.

| # | Daraja | Topilma | Holat |
|---|--------|---------|-------|
| 1 | **CRITICAL** | `GET /.env` butun ildizni ochib berardi — barcha kalitlar + `.git` + kod + baza | **TUZATILDI** |
| 2 | **CRITICAL** | Ommaviy (public) GitHub repo + publik default parol = tirik Boshliq akountiga kirish | O'zingiz hal qilishingiz kerak |
| 3 | **HIGH** | Bazada 7 ta `boss` akounti, barchasining paroli ommaviy ma'lum qiymat | O'zingiz hal qilishingiz kerak |
| 4 | **HIGH** | `_DEFAULT_STAFF` — kodda yozilgan login/telefon + `123456` standart parol | Reja kerak |
| 5 | **MEDIUM** | Parol xeshi — tez SHA-256 (PBKDF2/scrypt emas) | Tavsiya |
| 6 | **MEDIUM** | `/api/security/status` autentifikatsiyasiz barcha xavfsizlik holatini ochadi | Tavsiya |
| 7 | **MEDIUM** | `/uploads/<fayl>` va `/media/<key>` tekshiruvsiz ochiq | Tavsiya |
| 8 | **LOW** | Xato matnlari mijozga ochiq yuboriladi (`str(e)`, DB xatosi) | Tavsiya |
| 9 | **LOW** | Repo gigienasi: 79 ta vaqtinchalik `_tp_*` fayl, APK, `scripts_backup.js` | Tavsiya |

---

## 2. TUZATILDI — kritik zaiflik (topilma #1)

### Sabab
`app.py` oxiridagi catch-all marshrut loyiha **ildizini** fayl-serverga aylantirgan edi:

```python
app = Flask(__name__, static_folder='.')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)   # ← istalgan fayl
```

`send_from_directory` `..` (papkadan chiqish) ni to'sadi, **lekin nuqtali fayllarni yoki ildizdagi boshqa fayllarni to'smaydi**. Shuning uchun `.env`, `.git/`, `*.py`, `*.db` hammasi ochiq edi.

### Tasdiqlangan dalil (tuzatishdan OLDIN, jonli so'rovlar)

```
200  11301 bayt  <-  /.env          ← barcha maxfiy kalitlar
200  240352      <-  /app.py
200  20425       <-  /fiscal.py
200  302         <-  /.git/config
200  21          <-  /.git/HEAD     ← butun git tarixini yuklab olish mumkin
200  155651      <-  /scripts_backup.js
200  0           <-  /Data/database.db
```

Ya'ni **autentifikatsiyasiz** har qanday odam quyidagilarni olardi: `PAYMENT_WEBHOOK_TOKEN`, `CF_API_TOKEN`, S3 kalitlari, `CLICK_SECRET_KEY`, `FISCAL_SECRET_KEY`, `BOSS_DEFAULT_PASSWORD`, va repo ommaviy bo'lgani uchun **Boshliq login raqami + paroli** juftligi. Bu = Boshliq paneliga to'liq kirish (mijoz PII, xodim parollari, moliya, xodimlarni o'chirish).

### Yechim (minimal patch)
`serve_static` endi **oq ro'yxat** (allowlist) asosida ishlaydi — `app.py:3447-3475`:

1. ixtiyoriy segmentda `..` yoki `.` bilan boshlanish → **404**;
2. fayl nomi `STATIC_FILES` to'plamida bo'lishi shart (`index.html`, `style.css`, `boss.css`, `scripts.js`, `boss.js`, `tour.js`, `qrcode.min.js`, `favicon.png`);
3. faqat `assets/` papkasi (bitta `assets/` darajasi) qo'shimcha ruxsat oladi.

### Tekshiruv (tuzatishdan KEYIN — hammasi jonli HTTP bilan)

| Yo'l | Natija |
|------|--------|
| `/.env`, `/.env.example`, `/app.py`, `/fiscal.py`, `/.git/HEAD`, `/.gitignore`, `/requirements.txt`, `/Data/database.db`, `/scripts_backup.js`, `/android/.../scripts.js`, `/_tp_auth_test.py`, `/LICENSE`, `/mobile_app`, `/vendor/...woff2` | **404 (14 ta yo'l)** |
| traversal: `/assets/../.env`, `/assets/%2e%2e/.env`, `//.env`, `/./.env`, `/.%2e/.env`, `/assets/..%2f.env`, `/%2eenv` | **404 (9 ta yo'l)** |
| `/`, `/index.html`, `/style.css?v=…`, `/boss.css?v=…`, `/scripts.js?v=…`, `/boss.js?v=…`, `/tour.js`, `/qrcode.min.js`, `/favicon.png`, `/assets/texno-park-n1-exterior.jpg`, `/robots.txt` | **200, MIME to'g'ri** (`text/css`, `text/javascript`, `image/jpeg`) |
| `/api/health`, `/api/config`, `/api/catalog`, `/api/branches`, `/api/payments/config` | 200 |
| `/api/data`, `/api/boss/overview`, `/api/auth/staff`, `/api/security/sessions`, `/api/payments/orders` | 401 (to'g'ri) |

Brauzer tekshiruvi (Preview paneli, 127.0.0.1:5055): sahifa to'liq render bo'ldi, konsolda **404 yo'q**, yagona 401 — `/api/data` (mehmon rejimi uchun kutilgan).

> Eslatma: `python -m py_compile app.py` — OK. Fayl CRLF qator oxirini saqlab qoldi (git `core.autocrlf=true`).

---

## 3. DARHOL HAL QILINISHI KERAK (sizning harakatingiz kutiladi)

### 3.1. Barcha kalitlarni almashtiring (ROTATION)
Avval `/.env` ni **istalgan odam** yuklab olishi mumkin edi. Endi kod tuzatildi, lekin eski qiymatlar **allaqachon oshkor bo'lgan** deb hisoblanishi shart. Almashtirilishi kerak:

`BOSS_DEFAULT_PASSWORD`, `PAYMENT_WEBHOOK_TOKEN`, `CF_API_TOKEN`, `S3_ACCESS_KEY` / `S3_SECRET_KEY`, `CLICK_SECRET_KEY`, `PAYME_KEY`, `PAYNET_KEY`, `UZUM_KEY`, `PAYLOV_KEY`, `FISCAL_SECRET_KEY`, `PASSWORD_VAULT_KEY`, `AI_API_KEY`.

`API_AUTH_SECRET` ni almashtirish **barcha eski sessiyalarni bekor qiladi** — bu xohlanadi.

### 3.2. Boshliq paroli va takroriy boss akountlar
Bazada (`C:\app\data\database.db`) **14 ta xodim** bor, ulardan **7 tasi `boss` roli**:

| login | holat |
|-------|-------|
| `boss` | parol = `.env` dagi qiymat bilan **bir xil** |
| `boss2`…`boss7` | parol = `.env` dagi qiymat bilan **bir xil** |

`boss2`–`boss7` — `_tp_*` test skriptlaridan qolgan akountlar (`mustChange=false`). Ular **ham xohlagan narsani qila oladi**.

### 3.3. Zaif parollar (bazadan tekshirildi, xesh solishtirildi)

| login | rol | muammo |
|-------|-----|--------|
| `customer` | customer | parol = repodagi standart `123456` |
| `admin@texnopark.uz` | **admin** | parol = repodagi standart `123456` |
| `cashier@texnopark.uz` | **cashier** | parol = repodagi standart `123456` |
| `manager@texnopark.uz` | **manager** | parol = repodagi standart `123456` |
| `boss`, `boss2`…`boss7` | **boss** | parol = `.env` dagi qiymat (ommaviy repo orqali ma'lum) |

`admin`/`cashier`/`manager` (telefonsiz yozuvlar) — paroli allaqachon almashtirilgan, lekin `mustChange=true` bayrog'i hamon turibdi.

### 3.4. Omma­viy repo
`https://api.github.com/repos/stormdeveloper-glitch/Texno-Park` → **`"private": false`**.
Shu sababli quyidagilar **butun internetga ochiq**: `.env.example` ichidagi **to'ldirilgan** `BOSS_DEFAULT_PASSWORD` (aynan `.env` dagi qiymat bilan bir xil), `_DEFAULT_STAFF` (loginlar + telefon raqamlar + `123456`), `app.py` dagi qattiq yozilgan `BOSS_PHONE`.

**Variantlar:** (a) repo ni **private** qilish + barcha kalitlarni almashtirish; (b) `.env.example` dan haqiqiy parolni o'chirib, uni git tarixidan ham tozalash va parollarni almashtirish. Tarix tozalanmasa, eski commit'da parol qolib ketadi.

---

## 4. Kod bo'yicha topilmalar (tavsiya darajasida)

### 4.1. Standart xodimlar kod ichida — MEDIUM/HIGH
```python
_DEFAULT_STAFF = [
    {'login': 'admin',   'phone': '+998908480921', ...},
    {'login': 'cashier', 'phone': '+998905450921', ...},
    {'login': 'manager', 'phone': '+998902750921', ...},
    ...
]
_DEFAULT_PASSWORD = '123456'
```
`load_staff()` bo'sh bazada ularni **avtomatik yaratadi**. `STAFF_DEFAULT_PASSWORD` bo'sh bo'lsa, parol `BOSS_DEFAULT_PASSWORD` ga tushib qoladi (hozirgi `.env` da aynan shunday) — ya'ni standart xodimlar Boshliq paroli bilan yaratiladi va `mustChange=false` bo'ladi. Bo'sh bazada 3 ta admin/kassir/menejer akounti darhol paydo bo'ladi.
**Tavsiya:** `_DEFAULT_STAFF` ni butunlay olib tashlash yoki faqat `mustChange=true` + tasodifiy parol bilan yaratish.

### 4.2. Parol xeshi — MEDIUM
```python
def hash_password(password, salt):
    return hashlib.sha256(f'{salt}::{password}'.encode()).hexdigest()
```
Tez (GPU'da sekundiga milliardlab) SHA-256. Baza oshkor bo'lsa (eski `/.env`/`.git` zaifligi buni **mumkin qilgan**), parollar tez topiladi. Rate-limit faqat onlayn hujumni sekinlashtiradi, oflayn emas.
**Tavsiya:** `hashlib.pbkdf2_hmac('sha256', ..., iterations=600_000)` — **qo'shimcha kutubxona kerak emas**; versiyalash (`pbkdf2$...`) bilan eski xeshlarni birinchi kirishda yangilash.

### 4.3. `/api/security/status` autentifikatsiyasiz — MEDIUM
`require_staff` yo'q. Anonim foydalanuvchiga qaytaradi: `realClientIp`, baza turi (`sqlite`), rate-limit parametrlari, yuklash whitelist'i, yoqilgan to'lov tizimlari, `turnstileConfigured`, `apiTokenConfigured`, CORS manbalari, `trustedHosts`, domen sinxronizatsiya holati. Hujumchi uchun qulay razvedka.
**Tavsiya:** `@require_staff('admin')` qo'yish (Boshliq paneli shuni ishlatadi).

### 4.4. Ochiq fayl manzillari — MEDIUM
`/uploads/<path:filename>` va `/media/<key>` autentifikatsiyasiz. `media` kaliti qat'iy regex bilan cheklangan va UUID shaklida (capability URL) — bu **yaxshi**. Lekin yuklangan shartnoma/chek rasmlari ham xuddi shunday ochiq; havola sizib chiqsa, hujjat ham ochiq bo'ladi.
**Tavsiya:** shartnoma/chek rasmlarini `/media/` orqali faqat xodim tokeni bilan berish (yoki muddati qisqa imzolangan havolalar).

### 4.5. Xato matnlari mijozga ochiq — LOW
`click_webhook` (`'error_note': f'Database connection error: {str(e)}'`), `/api/reports` (`'message': str(e)`), `/api/upload` (S3 xato detali). Bular ichki tuzilmani oshkor qiladi.
**Tavsiya:** foydalanuvchiga umumiy xabar, tafsilot esa faqat server logiga.

### 4.6. Boshqa kuzatuvlar
- **`STAFF_PASSWORD_VAULT=true`** — Boshliq xodimlarning **joriy parolini** panelda ko'ra oladi. Boshliq akounti buzilsa, barcha xodim parollari ham ketadi. Xavfsizlik jurnali yoziladi (`audit`), lekin riskni hisobga olish kerak.
- **CSRF** — token `sessionStorage` da, so'rovlar `Authorization` sarlavhasi orqali. Cookie ishlatilmagani uchun klassik CSRF yo'q. Lekin CSP da `'unsafe-inline'` bor (`onclick` atributlari ko'p) — XSS topilsa, token o'g'irlanadi. Shu sababli `escapeHTML` izchilligi muhim (hozir 204 joyda ishlatilgan — yaxshi).
- **Rasm ishlovi tekshirildi:** `safeImageUrl()` `javascript:`, `blob:`, SVG-skript sxemalarini rad etadi, o'lchamni cheklaydi — `innerHTML` ga tushadigan rasm qiymati shu funksiyadan o'tadi. **XSS topilmadi.**
- **Repozitoriya gigienasi (LOW):** gitda 79 ta vaqtinchalik fayl (`_tp_*.py/.html/.mjs`, `_srv*.txt`, `_audit_status.py`, `_tp_shots/*.png`), `Texno-Park-N1-debug.apk` (+`.idsig`), `scripts_backup.js` (155 KB nusxa) kuzatilmoqda. Ular endi **berilmaydi** (fix tufayli), lekin reponi ifloslantiradi va `android/.../scripts.js` bilan **kod dublikati** xavfini tug'diradi.
- **`vendor/inter/files/*.woff2`** — hech qayerda ishlatilmaydi (CSS'da `@font-face` yo'q) — o'lik yuk.
- **Testlar:** 6 ta test fayli aniqlangan, lekin `pytest` konfiguratsiyasi va CI yo'q; `README.md` bo'sh. Avtomatik regressiya yo'q.
- **`PORT`**: `app.py` `0.0.0.0` da tinglaydi; `FLASK_DEBUG=false` (to'g'ri). Lokal muhitda `PORT` tashqi o'zgaruvchidan `0` bo'lib qolishi mumkin (ephemeral port) — `PORT=5055` bilan ishlatildi.

---

## 5. Nima o'zgarmadi (regressiya yo'q)

- Bitta fayl: `app.py`. **30 qator qo'shildi, 1 qator o'zgartirildi** — boshqa hech qanday fayl, API yo'li, ma'lumotlar bazasi sxemasi yoki biznes-logika tegmadi.
- `serve_index` (`/`), `/robots.txt`, `/api/*`, `/media/*`, `/uploads/*`, `/upload/*` marshrutlari o'z holida.
- Frontend (`index.html`, `style.css`, `boss.css`, `scripts.js`, `boss.js`, `tour.js`, `qrcode.min.js`) — tegmadi.
- `.gitignore` `.env` ni allaqachon to'sgan (`.env` gitda yo'q — yaxshi).

## 6. TEKSHIRILMAGAN (UNVERIFIED)

- **Production'dagi baza** (Postgres/Railway) — lokal `sqlite` bilan solishtirilmadi; akountlar ro'yxati u yerda boshqacha bo'lishi mumkin.
- **To'lov provayderlari bilan haqiqiy integratsiya** (Click/Payme/Paynet/Uzum/Paylov imzolari) — kalitlar bo'sh, callback'lar real sandbox'da sinalmadi.
- **Fiskal modul** (`FISCAL_PROVIDER=disabled`) — OFD bilan aloqa sinalmadi.
- **Telefonda/responsive** chuqur tekshirilmadi (faqat desktop renderi tasdiqlandi).
- **Rate-limit** bir jarayonli (in-memory `_login_attempts`/`IP_REQUESTS`); ko'p worker'da har bir worker alohida sanaydi.

---

## 7. Keyingi qadam (tavsiya etilgan tartib)

1. Yuqoridagi barcha kalitlarni almashtiring (3.1).
2. `boss2`…`boss7` akountlarini o'chirib, `boss` parolini almashtiring (3.2).
3. `admin@`, `cashier@`, `manager@`, `customer` parollarini almashtiring (3.3).
4. Reponi private qiling yoki `.env.example` va tarixdan parolni olib tashlang (3.4).
5. `_DEFAULT_STAFF` ni olib tashlash + SHA-256 → PBKDF2 (4.1, 4.2).
6. `/api/security/status` ni himoyalash; ochiq yuklangan hujjatlarni yopish (4.3, 4.4).

> Ushbu hisobot `AUDIT_REPORT_2026-10-09.md` — repoga commit qilish ixtiyoriy (maxfiy ma'lumot yo'q, lekin uni gitga qo'shish shart emas).
