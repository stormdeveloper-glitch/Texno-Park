# Tuzatishlar hisoboti — 2026-10-13

**Asos:** [BUG_HUNT_2026-10-13.md](BUG_HUNT_2026-10-13.md) (2 kritik, 4 yuqori, 6 o'rta, 5 past topilma).
**Metod:** har bir tuzatish **jonli HTTP so'rovlar** va **real brauzer** bilan tekshirildi
(klon baza `.testdb/bughunt.db` + vaqtinchalik server 5077-portda). Asl bazaga hech narsa yozilmadi.
**Yakuniy natija:** avtomatik tekshiruv **66/66 PASS** ([.testdb/_verify_final.txt](.testdb/_verify_final.txt)),
brauzerda XSS **TOZA**, APK assetlari ildiz bilan **bit-darajali bir xil**.

---

## 1. Holat jadvali

| # | Daraja | Topilma | Holat |
|---|--------|---------|-------|
| 1 | **CRITICAL** | `.env.example`da haqiqiy Boshliq paroli + ommaviy repo + kodda telefon raqami | **Kod tomoni TUZATILDI** (parol bo'shatildi, 6 ta skriptdan olib tashlandi, standart xodimlar endi Boshliq parolini ishlatmaydi) — parol aylanishi sizdan |
| 2 | **CRITICAL** | `NaN` butun tizimni jim o'chirib qo'yadi (`/api/sync` → buzilgan JSON → frontend eski nusxani ko'rsatadi) | **TUZATILDI** (2 qatlam) |
| 3 | **HIGH** | Ommaviy vitrinada saqlangan XSS (12 joy) | **TUZATILDI** (brauzerda tasdiqlangan) |
| 4 | **HIGH** | Past darajali xodim `/api/sync` bilan butun savdo tarixini o'chira oladi | **TUZATILDI** (`sync-delete-blocked`) |
| 5 | **HIGH** | APK eski frontend bilan quriladi (`boss.js`/`boss.css` umuman yo'q) | **TUZATILDI** (`rebuild_apk.py` + bit-darajali tekshiruv) |
| 6 | **HIGH** | Boshliq paneli xodim parollarini ochiq matnda qaytaradi | **ATAYLAB QOLDIRILDI** — bu sizning siyosiy qaroringiz (pastda 4.3) |
| 7 | **MEDIUM** | `/api/security/status` autentifikatsiyasiz | **TUZATILDI** (admin/Boshliq) |
| 8 | **MEDIUM** | Click webhook: muvaffaqiyatsiz to'lov "to'landi" bo'lib qolardi | **TUZATILDI** (3 tekshiruv) |
| 9 | **MEDIUM** | `/api/reports` — spam himoyasi yo'q, xato matni ochiq | **TUZATILDI** (429) |
| 10 | **MEDIUM** | Parol xeshi — tez SHA-256 | **TUZATILDI** (PBKDF2 + avtomatik migratsiya) |
| 11 | **LOW** | Catch-all `/api/...` → HTML 404 (405 JSON emas) | **TUZATILDI** |
| 12 | **LOW** | `pyflakes` xatolari va yutilgan xatolar | **TUZATILDI** (pyflakes toza) |
| 13 | **LOW** | Repo gigienasi (79 ta `_tp_*`, APK, backup) | **SIZNING QARORINGIZ** (faqat parol qismi tozalandi) |

---

## 2. Tuzatishlar (dalil bilan)

### 2.1. `NaN` / `Infinity` — endi bazaga tushmaydi va javobga chiqmaydi

**Ikki qatlamli himoya:**

1. **Kirish darvozasi** — [app.py:3796](app.py#L3796) `validate_sync_payload()` endi **savdo yozuvlarini ham**
   chuqur tekshiradi: `total`, `discAmt`, `items[].price/qty/cost` (son bo'lishi, `math.isfinite`,
   manfiy emas). Xato yozuv **400** bilan rad etiladi, baza tegilmagan holda qoladi.
2. **Chiqish himoyasi** — [app.py:55](app.py#L55) `_StrictJSONProvider`: `jsonify` endi `allow_nan=False`.
   NaN qandaydir yo'l bilan bazaga tushsa ham, javob **500** bo'ladi, **buzilgan JSON emas** —
   ya'ni frontend hech qachon "eski localStorage" holatiga tushmaydi.
   Xuddi shu qoida `DBManager` yozuvida ham ([app.py:687-694](app.py#L687-L694)).

**Dalil (jonli):** `total=NaN` → 400, `total=Infinity` → 400, `items[].price=NaN` → 400,
`total=-5` → 400, `total="abc"` → 400, chuqur ichkaridagi NaN → 400; bazadagi savdo soni
o'zgarmadi; to'g'ri savdo esa 200 bo'lib yozildi; `GET /api/data` → **200 va JSON toza**
(`json.loads` muvaffaqiyatli).

### 2.2. Saqlangan XSS (vitrina, filial/chegirma kartalari, sessiya `jti`)

`escapeHTML` HTML kontekstida to'g'ri, **lekin inline `onclick="...('{{ qiymat }}')"` ichida
ishlamaydi** — `'` va `"` JS-satrni uzib chiqadi. Shu naqsh 12 joyda tuzatildi:

- yangi yordamchi [scripts.js:91](scripts.js#L91) `jsStrAttr()` — qiymatni **avval** JS-satr,
  **keyin** HTML-atribut qoidalari bo'yicha qochiradi;
- inline handlerlar (`addToShopCart`, `openProduct`, filial/chegirma tugmalari, sessiyani
  bekor qilish va h.k.) endi `jsStrAttr()` orqali yozadi;
- [index.html:3781](index.html#L3781)da versiya `?v=1.4.21`ga ko'tarildi (brauzer eski keshlangan faylni ishlatmasin).

**Dalil (real brauzer, mehmon rejimi):** baza orqali 3 ta payload yozildi
(`XSS-TEST');window.__XSS=1;('`, `<img src=x onerror=window.__XSS=2>`, `XSS-Q"onmouseover="window.__XSS=3`)
va ular vitrinda **matn** sifatida ko'rindi:

```
onclick="...showNotif('success', 'Savatga qo\'shildi', 'XSS-TEST\');window.__XSS=1;(\'')"
```

- payload `'` → `\'`, `"` → `\"` (satr uzilmaydi);
- `<img ...>` uchun DOM'da haqiqiy `img` **yaratilmadi** (`img[src="x"] = 0`);
- uchala handler **haqiqatan bosildi** → `window.__XSS === undefined`, `Object.keys(window)`
  ichida `__XSS` **yo'q**. Tuzatishdan oldin xuddi shu sinovda `window.__XSS = 1` bo'lgan edi.

### 2.3. Ma'lumot yo'qotishdan himoya (kassir tarixni o'chira olmaydi)

`/api/sync` butun to'plamni almashtiradi, shu sababli eski nusxaga ega past darajali xodim
bitta so'rov bilan savdo tarixini o'chira olardi. Endi [app.py:4464](app.py#L4464)
(`sync_data`)da **append-only himoya**:

- `sales`, `products`, `contracts`, `cashFlow`, `expenses`, `discounts`, `branches` uchun
  yo'qolgan yozuvlar (id bo'yicha) **serverda saqlanadi** va ro'yxatga qaytariladi — agar
  rol `admin`/`manager` bo'lmasa;
- urinish xavfsizlik jurnaliga `sync-delete-blocked` (high) bo'lib yoziladi;
- **kassir POS oqimi uzilmaydi**: `{"sales": []}` javobi hamon 200 (frontend xato ko'rmaydi),
  lekin baza o'zgarmaydi; kassir yangi savdoni bemalol qo'shadi;
- admin/manager **o'chirish huquqini saqlab qoldi** (siyosat o'zgarmagan).

**Dalil:** kassir `{"sales": []}` → 200, bazada savdo **saqlanib qoldi**; `sync-delete-blocked`
jurnalda paydo bo'ldi; kassir yangi savdo qo'shdi → 2 ta yozuv; admin `{"sales": []}` → baza bo'sh.

### 2.4. APK endi ildiz frontend bilan quriladi

[rebuild_apk.py:33](rebuild_apk.py#L33) `sync_frontend()` build oldidan ildizdagi
`index.html, scripts.js, style.css, boss.css, boss.js, tour.js, qrcode.min.js, favicon.png`
(nuqtali/pastki chiziqli vaqtinchalik fayllar bundan mustasno) ni
`android/app/src/main/assets/` ga sinxronlaydi; [rebuild_apk.py:68](rebuild_apk.py#L68)
`check_local_assets()` esa `index.html` havola qilgan har bir mahalliy fayl assets'da
borligini tekshiradi va yo'q bo'lsa **buildni to'xtatadi** (aynan `boss.js`/`boss.css`
yo'qolganini ushlab qoladigan tekshiruv).

**Dalil:** `python rebuild_apk.py` → `Frontend sinxronlandi: 9 fayl tekshirildi, 0 yangilandi`
+ `Havola tekshiruvi: 7 mahalliy fayl, hammasi joyida`; 8 ta fayl ildiz bilan `cmp` bo'yicha
**bit-darajali bir xil**; ilgari assets'da umuman yo'q bo'lgan `boss.js`/`boss.css` qo'shildi.

### 2.5. Parol xeshi — PBKDF2 + eski xeshlarni jimgina migratsiya qilish

[app.py:802](app.py#L802) `hash_password()` endi `pbkdf2_sha256$<iteratsiya>$<hex>`;
[app.py:810](app.py#L810) `verify_password()` ikkala sxemani ham qabul qiladi
(`hmac.compare_digest`), [app.py:833](app.py#L833) `password_needs_rehash()` bilan
**kirish paytida eski xesh avtomatik yangilanadi** — foydalanuvchi hech narsa sezmaydi.

**Dalil:** eski SHA-256 xesh bilan login ishladi → o'sha akountning xeshi PBKDF2 ga o'tdi →
qayta login ishladi → noto'g'ri parol 401; **boshqa akountlarga tegilmadi** (faqat bittasi yangilandi).

### 2.6. `/api/security/status` — endi faqat admin/Boshliq

[app.py:5455-5457](app.py#L5455-L5457) `@require_staff('admin')` qo'shildi (Boshliq meros bo'yicha o'tadi).
**Dalil:** anonim → 401, kassir → 403, admin → 200, Boshliq → 200; javobda **maxfiy kalit
qiymatlari yo'q** (tekshirildi).

### 2.7. Click webhook — muvaffaqiyatsiz to'lov "to'landi" bo'lmaydi

Uch qo'shimcha tekshiruv ([app.py:5061](app.py#L5061) atrofi):

1. `error` maydoni noldan farqli bo'lsa (Click to'lovni **bekor qildi/muvaffaqiyatsiz**) → savdo
   `pending` holicha qoladi, `error: -9`;
2. imzo `hmac.compare_digest` bilan (vaqt bo'yicha hujumga chidamli);
3. `merchant_prepare_id` **bazadagi `prepare_id` bilan mos** bo'lishi shart (prepare bosqichisiz
   to'g'ridan-to'g'ri `action=1` yuborib to'lovni soxta tasdiqlash mumkin emas edi).

**Dalil (haqiqiy Click protokoli, imzo to'g'ri hisoblangan):** prepare → `prepare_id` eslab qolindi;
`error=-1` → rad, savdo `pending`; soxta imzo → rad; noto'g'ri `prepare_id` → rad;
faqat to'g'ri imzo + to'g'ri `prepare_id` → `paid` va jurnalga yozuv.

### 2.8. `/api/reports` — spam himoyasi va xato matni

[app.py:4839](app.py#L4839): soatiga limit, oshsa **429**; bo'sh xabar → 400; xato matni mijozga
texnik tafsilot chiqarmaydi. **Dalil:** 200, 200, 200 → keyingi → **429**.

### 2.9. Catch-all marshrut — endi `405` (va `/api/` uchun HTML emas)

[app.py:3609-3635](app.py#L3609-L3635) (`serve_static` → [app.py:3631](app.py#L3631) `abort(405)`): API yo'llari statik oq ro'yxatga tushmaydi va mavjud
bo'lmagan API manzil **404 JSON**, noto'g'ri metod esa **405** qaytaradi.
**Dalil:** `GET /api/sync` → 405, `GET /api/boss/staff/1` → 405, `GET /api/definitely-not-here` → 404,
`/.env`, `/app.py`, `/.git/HEAD`, `/.testdb/bughunt.db` → **404**.

### 2.10. Standart xodimlar endi **Boshliq parolini ishlatmaydi**

[app.py:1340-1345](app.py#L1340-L1345): ilgari `BOSS_DEFAULT_PASSWORD` standart xodimlarning ham
paroli bo'lib qolardi (ya'ni ommaviy repodagi bitta parol bilan **hamma** akountga kirish mumkin edi).
Endi:

- `STAFF_DEFAULT_PASSWORD` berilmasa — **tasodifiy parol** (`secrets.token_urlsafe(12)`) yaratiladi
  va faqat bir marta konsolga chiqariladi, `mustChange=true`;
- `123456` ishlatilsa — konsolga ogohlantirish chiqadi;
- standart xodimlar uchun **unikal salt** (`make_salt`).

### 2.11. Maxfiy parolni gitdan chiqarish (kod tomoni)

| Fayl | Nima qilindi |
|------|--------------|
| [.env.example](.env.example) | `BOSS_DEFAULT_PASSWORD=diyorbek6272` → **bo'sh** qiymat + ogohlantirish izohi (boshqa kalitlar kabi). Haqiqiy qiymat faqat gitga tushmaydigan `.env`da. |
| [_reset_auth_lock.py](_reset_auth_lock.py), [_tp_4accounts_test.py](_tp_4accounts_test.py), [_tp_boss_test.py](_tp_boss_test.py), [_tp_boss_charts_test.py](_tp_boss_charts_test.py), [_tp_final_inject.js](_tp_final_inject.js), [_mission_summary.txt](_mission_summary.txt) | qattiq yozilgan parol olib tashlandi → `os.getenv('BOSS_DEFAULT_PASSWORD')` / `window.TP_BOSS_PASSWORD`; bo'sh bo'lsa skript aniq xato beradi (jimgina noto'g'ri ishlamaydi). |
| [.testdb/_verify.py](.testdb/_verify.py), [_probe.py](.testdb/_probe.py), [_probe2.py](.testdb/_probe2.py), [_race.py](.testdb/_race.py) | tekshiruv skriptlaridagi parol ham env'ga o'tkazildi. |

**Tekshiruv:** `grep -r "diyorbek6272" .` endi faqat **`.env`** ni ko'rsatadi (u `.gitignore`da).
`git history` esa hamon eski commit'da saqlaydi — bu **faqat parolni almashtirish** bilan hal bo'ladi.

---

## 3. Tekshiruv natijalari (yakuniy kod ustida)

| Tekshiruv | Natija |
|-----------|--------|
| Jonli HTTP to'plami (`.testdb/_verify.py`) | **66/66 PASS**, exit 0 |
| Brauzerda XSS (3 payload, haqiqiy bosish) | **TOZA** — `window.__XSS` yo'q, soxta `img` yo'q |
| APK asset sinxronizatsiyasi | 8 fayl **bit-darajali bir xil**, `boss.js`/`boss.css` qo'shildi |
| `python -m py_compile app.py` + `pyflakes` | **toza** (12-topilma yopildi) |
| `node --check` (scripts.js, boss.js, tour.js, _tp_final_inject.js) | **OK** |
| Statik oq ro'yxat / traversal (17+9 yo'l) | hammasi **404** |
| RBAC (6 rol × bir nechta endpoint) | kutulgan (admin→boss: **403**, kassir→`/api/data`: **200**) |

**Regressiya yo'q:** Boshliq panelining 8 ta endpointi 200, kassa oqimi (login → savdo → sinxronizatsiya)
ishlaydi, mehmon vitrinasi render bo'ladi, `FISCAL_PROVIDER=disabled` holatida mahsulot saqlash
(oldingi audit tuzatishi) saqlanib qolgan.

---

## 4. Sizning harakatingiz kerak (kod bilan hal bo'lmaydi)

### 4.1. Parolni va kalitlarni almashtirish (**eng muhim**)
Eski parol `.env.example`da ommaviy repoda turgan va **haqiqatan ishlagan** — shuning uchun
u **oshkor bo'lgan** deb hisoblanishi shart:

1. Boshliq parolini almashtirish (ilova: **Sozlamalar → Parolni o'zgartirish**);
2. `admin`/`cashier`/`manager` (`123456`) va `customer` parollarini almashtirish;
3. bazadagi `boss2…boss7` test akountlarini **o'chirish**;
4. `API_AUTH_SECRET` ni almashtirish — bu **barcha eski sessiyalarni bekor qiladi** (xohlanadi);
5. `.env`dagi `PAYMENT_WEBHOOK_TOKEN`, `CF_API_TOKEN`, `S3_*`, `CLICK_*`, `PAYME_KEY`,
   `PAYNET_KEY`, `UZUM_KEY`, `PAYLOV_KEY`, `FISCAL_SECRET_KEY`, `PASSWORD_VAULT_KEY`, `AI_API_KEY`.

> Diqqat: `PASSWORD_VAULT_KEY` yoki `API_AUTH_SECRET` almashtirilsa, xodim parollarining
> shifrlangan nusxalari o'qilmay qoladi — xodim keyingi kirishida avtomatik yangilanadi.

### 4.2. Repo
- Reponi **private** qilish **yoki** `git filter-repo` bilan tarixdan eski parolni tozalash
  (ishchi daraxtdan olib tashlandi, ammo eski commit'da qolgan);
- `BOSS_PHONE = '+998901234554'` ([app.py:1222](app.py#L1222)) ni ataylab qoldirdim — u
  `ensure_boss_account()` migratsiyasi uchun kerak va **parolsiz o'zi xavf tug'dirmaydi**.
  Xohlasangiz env'ga ko'chirish mumkin (kod ommaviy artefakt).

### 4.3. "Parolni ko'rish" funksiyasi (6-topilma) — ataylab tegilmadi
Boshliq panelida xodim parolini ochiq matnda ko'rish hozircha **ishlaydi**
(`GET /api/boss/staff/<id>/password`, har ko'rish jurnalga yoziladi, `STAFF_PASSWORD_VAULT=false`
bilan butunlay o'chirish mumkin). Bu mahsulot siyosati, shuning uchun **o'zimga ruxsatsiz
o'chirmadim** — agar Boshliqning o'zi parolni ko'ra olmasligi kerak bo'lsa, aytganingizda
o'chiraman.

### 4.4. Repo gigienasi (13-topilma)
79 ta `_tp_*` va 15 ta `_audit_*` vaqtinchalik skript, `Texno-Park-N1-debug.apk` (1.7 MB),
`scripts_backup.js` — bularning barchasi gitda kuzatilgan. O'chirish uchun ayting
(xavfsiz, ular mahsulot kodiga kirmaydi).

---

## 5. Sinalmagan / cheklangan

- **To'lov webhooklari** (Payme/Paynet/Uzum/Paylov) va **fiskal modul** — klon muhitida
  kalitlar sozlanmagani uchun faqat **kod tahlili**; Click to'liq sinaldi (imzo protokoli bilan).
- **Real Click/server prod muhiti** — yo'q; hammasi lokal klon bazada bajarildi.
- **APK real qurilmada ishga tushirilmadi** — faqat asset sinxronizatsiyasi va havolalar tekshirildi.
- **S3 yuklash / presigned havolalar** — sozlanmagan.
- Loyihada **avtomatik test to'plami yo'q**; tekshiruvlar `.testdb/_verify.py` skripti orqali
  qo'lda ishga tushiriladi (takrorlash: `.testdb/_run_final.sh` bilan serverni ko'tarib,
  `python .testdb/_verify.py`).

---

## 6. O'zgargan fayllar

| Fayl | O'zgarish |
|------|-----------|
| [app.py](app.py) | qat'iy JSON, chuqur validatsiya, append-only himoya, PBKDF2, ruxsatlar, Click, reports, 405, `pyflakes` tozalash |
| [scripts.js](scripts.js) | `jsStrAttr()` + 12 XSS sink tuzatildi |
| [index.html](index.html) | `scripts.js` versiyasi `?v=1.4.21` |
| [rebuild_apk.py](rebuild_apk.py) | `sync_frontend()` + `check_local_assets()` |
| [android/app/src/main/assets/*](android/app/src/main/assets) | ildiz frontend bilan sinxronlandi (+`boss.css`, +`boss.js`) |
| [.env.example](.env.example) | haqiqiy parol olib tashlandi |
| `_reset_auth_lock.py`, `_tp_*`, `_mission_summary.txt`, `.testdb/_*` | qattiq yozilgan parol → env |
| [BUG_HUNT_2026-10-13.md](BUG_HUNT_2026-10-13.md) | hisobotdagi parol `[BOSH_PAROL]` bilan maskalandi |
