# Texno Park POS — Cloudflare bilan ishlash qo'llanmasi

Ushbu hujjat saytni Cloudflare orqasida xavfsiz ishga tushirish uchun
barcha qadamlarni o'z ichiga oladi: **Turnstile (CAPTCHA)**, WAF, rate limit,
SSL/TLS, keshlash va monitoring.

---

## 1. Turnstile (CAPTCHA) — allaqachon tayyor

Yaratilgan widget (Cloudflare hisobi: `Aniedituz@gmail.com`):

| Kalit | Qiymat | Qayerda turadi |
|---|---|---|
| **Site key** (ochiq) | `0x4AAAAAAE-oOjwa55yt8NPr` | `.env` → `CF_TURNSTILE_SITE_KEY`, brauzerga `/api/config` orqali beriladi |
| **Secret key** (maxfiy) | `0x4AAAAAAE-oOgyeBisDQXx5FT7tAfXlCVY` | `.env` → `CF_TURNSTILE_SECRET_KEY` (faqat serverda) |

Widget nomi: **Texno Park POS**, rejim: `managed`.
Hozir ruxsat etilgan domenlar: `texnoo.com`, `universall.uz`, `localhost`, `127.0.0.1`.

### Yangi domen — faqat `.env` ga yoziladi

```ini
SITE_DOMAIN=pos.yangi-domen.uz
```

Shundan keyin dastur o'zi:

1. `https://pos.yangi-domen.uz` va `https://www.pos.yangi-domen.uz` ni
   **CORS manbalariga** qo'shadi;
2. **Host sarlavhasi** tekshiruvini yoqadi (ro'yxatda yo'q Host → `400 bad-host`
   + xavfsizlik jurnaliga yozuv);
3. `CANONICAL_REDIRECT=true` bo'lsa eski domen/IP ni kanonik domenga
   **301** yo'naltiradi (API va to'lov webhook'lari tegilmaydi);
4. **Turnstile widgetiga domenni qo'shadi** — buning uchun quyidagilar kerak
   (bo'lmasa holat `needs_token` bo'ladi va domen qo'lda qo'shiladi):

```ini
CF_ACCOUNT_ID=25d6c64b2fa5334a0a42edaa7eb934fa
CF_TURNSTILE_WIDGET_ID=0x4AAAAAAE-oOjwa55yt8NPr
CF_AUTO_ADD_DOMAIN=true
CF_API_TOKEN=<Cloudflare API token>
```

Token yaratish (bir marta, 1 daqiqa): **My Profile → API Tokens → Create Token →
Custom token → Permissions: `Account` · `Turnstile` · `Edit`** → boshqa huquq
kerak emas → tokenni `.env` ga `CF_API_TOKEN=` sifatida yozing.

Tekshirish va qo'lda ishga tushirish:
- Admin panel → **Sozlamalar → 🔐 Xavfsizlik → Cloudflare va domen holati**
  (holat, widget domenlari, «Domenni sinxronlash» tugmasi);
- yoki `POST /api/cloudflare/sync-domain` (admin tokeni bilan).

> Token bo'lmasa ham hammasi ishlaydi — domenni dashboard'da qo'shasiz:
> **Turnstile → Texno Park POS → Edit → Domains → Add domain**.

### Server tomonda
- `POST /api/auth/login` — token yuborilgan bo'lsa **doim** `siteverify` orqali
  tekshiriladi (serverda, HTTPS orqali, 8 s timeout).
- `CF_TURNSTILE_ENFORCE=true` bo'lsa — token umuman yuborilmasa ham kirish rad
  etiladi (`403 captcha_failed`). Hozir `false`: brauzer token yuboradi,
  mobil ilova (Turnstile SDK'siz) kiraverishi uchun.
- Nazorat: har bir muvaffaqiyatsiz CAPTCHA `captcha-failed` (high) sifatida,
  tokenisiz urinish esa `captcha-missing` (medium) sifatida xavfsizlik
  jurnaliga yoziladi — **Loglar → Xavfsizlik** bo'limida ko'rinadi.

### Brauzerda
- `challenges.cloudflare.com` faqat `/api/config` da sozlangan bo'lsa yuklanadi.
- Login formasida widget ko'rinadi; har urinishdan keyin yangi token talab qilinadi.
- CSP ro'yxatiga `challenges.cloudflare.com` (script + frame) qo'shilgan.

---

## 2. SSL/TLS (Cloudflare dashboard → SSL/TLS)

| Sozlama | Qiymat |
|---|---|
| SSL/TLS encryption mode | **Full (strict)** |
| Always Use HTTPS | **ON** |
| Automatic HTTPS Rewrites | **ON** |
| Minimum TLS version | **TLS 1.2** |
| Opportunistic Encryption | ON |
| TLS 1.3 | ON |

Server tomonda `FORCE_HTTPS=true` qo'yilsa, sayt Cloudflare'dan kelgan
sxemani (`CF-Visitor` / `X-Forwarded-Proto`) to'g'ri o'qiydi va cheksiz
redirect bo'lmaydi.

---

## 3. Keshlash (Caching)

| Yo'l | Qoida |
|---|---|
| `/api/*` | **Bypass cache** (API javoblari `Cache-Control: no-store` yuboradi) |
| `*.html`, `/` | Standart (Cloudflare avtomatik) |
| `*.css`, `*.js`, `*.png`, `*.ico` | Cache Everything, Edge TTL 1 kun |
| `/uploads/*` | Cache Everything (agar S3 ishlatilmasa) |

**Rules → Cache Rules** da: `URI Path starts with /api` → *Bypass cache*.

---

## 4. WAF va bot himoyasi (Security → WAF / Bots)

1. **Managed Rules** → Cloudflare Managed Ruleset: **ON**.
2. **Bot Fight Mode**: **ON** (Free planda ham mavjud).
3. **Security Level**: *High* (login sahifasi uchun *I'm Under Attack* rejimini
   vaqtincha yoqish mumkin).
4. **Browser Integrity Check**: ON.
5. **Rate limiting rule** (Rules → Rate limiting rules → Create):
   - Expression: `(http.request.uri.path eq "/api/auth/login" and http.request.method eq "POST")`
   - Requests: `10` / `1 minute`
   - Action: **Block** (yoki Managed Challenge), timeout: 1 soat
   - Qo'shimcha: `(http.request.uri.path contains "/api/")` → `300` / `1 minute` → *Managed Challenge*
6. **Custom rule** (ixtiyoriy, admin panelni yopish uchun):
   - Expression: `(http.request.uri.path contains "/api/data" or http.request.uri.path contains "/api/sync")`
   - Action: **Managed Challenge** (yoki IP allowlist).

> Server tomonida ham qatlam bor: `/api/*` uchun IP bo'yicha rate limit
> (60 s.da 100 so'rov), login uchun 8 urinish/5 daqiqa, RBAC tokenlari va
> sessiya reyestri.

---

## 5. DNS va hostname

- Yangi domen Cloudflare'ga qo'shiladi → nameserverlar o'zgartiriladi.
- POS uchun `A` yoki `CNAME` yozuv: serverni ko'rsatuvchi **proxied (orange cloud)**.
- Turnstile widget'iga yangi domen qo'shiladi (1-bo'limga qarang).
- `.env` da `ALLOWED_ORIGINS=https://yangi-domen.uz` (CORS uchun).
- `.env` da `TRUST_CLOUDFLARE=true` qilinadi — haqiqiy mijoz IP'si
  (`CF-Connecting-IP`) rate-limit, jurnal va sessiya panelida ko'rinadi.

---

## 6. Monitoring va tekshiruv

- **Health check** endpoint: `GET /api/health` → `{"status":"ok", ...}`.
  Cloudflare → **Notifications → Uptime/Health check** shu manzilga sozlanadi.
- Admin panel: **Sozlamalar → Xavfsizlik** — Cloudflare holati
  (`behindCloudflare`, `turnstileConfigured`, `realClientIp`) `GET /api/security/status`
  javobida ham ko'rinadi.
- `robots.txt` API va yuklangan fayllarni qidiruv botlaridan yashiradi.

---

## 7. Tekshirish ro'yxati (deploydan keyin)

- [ ] `https://<domen>/api/health` → `status: ok`
- [ ] Login sahifasida Turnstile widget ko'rinadi va tasdiqlanadi
- [ ] Noto'g'ri parol 5 marta → hisob vaqtincha bloklanadi (jurnalda `lockout`)
- [ ] `/api/data` tokenisiz so'ralsa → `401`
- [ ] `curl https://<domen>/api/config` javobida `turnstileSiteKey` bor,
      **hech qanday maxfiy kalit yo'q**
- [ ] Cloudflare → Security → Events: WAF/rate-limit bloklari ko'rinadi
- [ ] `TRUST_CLOUDFLARE=true` bo'lganda Xavfsizlik panelida haqiqiy IP turadi
- [ ] `.env` → `SITE_DOMAIN` to'ldirilgan va Sozlamalar → Xavfsizlik →
      «Cloudflare va domen holati» da domen ko'rinadi
- [ ] Eski domen/IP ga kirilsa → `301` kanonik domenga yo'naltiradi
- [ ] «Domenni sinxronlash» tugmasi `updated` yoki `ok` natija beradi
      (yoki dashboard'da domen qo'lda qo'shilgan)
- [ ] Server logida: `Sayt domeni: <domen> | kanonik yonaltirish: ON`
