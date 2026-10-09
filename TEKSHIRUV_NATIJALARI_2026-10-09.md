# Funksional tekshiruv natijalari — 2026-10-09

**Nima qilindi:** har bir shikoyat **jonli ilovada** sinab ko'rildi (nusxa bazada,
alohida serverda). Har bir da'vo HTTP so'rovlar va brauzer bilan tasdiqlandi.

**Muhim izoh:** tekshiruv **jonli bazaning nusxasida** bajarildi — asl ma'lumotlarga
hech narsa yozilmadi. Nusxa baza va vaqtinchalik server o'chirildi.

---

## 1. Shikoyatlar bo'yicha yakuniy holat

| # | Shikoyat | Holat | Dalil |
|---|----------|-------|-------|
| 1 | **Mahsulot qo'shish ishlamayapti** | ❌ **HAQIQIY NUQSON → TUZATILDI** | UI orqali qo'shilgan mahsulot bazaga yozilmadi; sabab topilib tuzatildi |
| 2 | Kategoriya ishlamayapti | ✅ Ishlaydi | UI orqali qo'shildi: 9 → 10, bazaga saqlandi |
| 3 | Kassa (filial) qo'shish ishlamayapti | ✅ Ishlaydi | "AUDIT KASSA 2" yaratildi, `/api/branches` da ko'rindi |
| 4 | KPI chiqmayapti | ✅ Chiqadi | `/api/boss/overview` → `kpi: {branches:2, products:3, staff:6, ...}`; kartalar render bo'ladi |
| 5 | Asosiy sahifa ishlamayapti | ✅ Ishlaydi | 13 sahifa ham **bitta ham JS xatosisiz** ochildi |
| 6 | Kirim/chiqim ishlamayapti | ✅ Ishlaydi | `/api/boss/finance` → `{kirim, chiqim, harajat, net}`; saqlash mantiqi sog'lom |
| 7 | Shartnoma tuzatish kerak | ✅ Saqlanadi | UI orqali "AUDIT MIJOZ" shartnomasi `SH-2026-0001` bo'lib yozildi |
| 8 | Hisobot / foyda | ✅ Ishlaydi | `/api/boss/reports` → `rows/summary/total/period` |
| 9 | AI | ✅ Ishlaydi | Savolga real javob qaytardi (lokal rejim, `AI_API_KEY` yo'q) |
| 10 | **Chegirma** | ❌ **FUNKSIYA YETISHMAYAPTI** | Sahifada yaratish tugmasi/modal umuman yo'q |
| 11 | Boshliq amallar jurnali yo'qolgan | ✅ Ishlaydi | Xodim qo'shilganda yozuv paydo bo'ldi (`staff-create`, actor: Boshliq) |

---

## 2. TUZATISH #1 — Mahsulot qo'shish (asosiy nuqson)

### Sabab (`scripts.js` → `saveProduct()`)
Mahsulot saqlashdan **oldin** quyidagi ikkita maydon **har doim** majburiy edi:

```js
if (ikpu.length !== 17) { ...xato...; return; }        // IKPU (MXIK) kodi
if (!packageCode)       { ...xato...; return; }        // Qadoqlash kodi
```

Ikkovi ham modalning **Fiskal** bo'limida, ko'zga tashlanmaydigan joyda. Ular
to'ldirilmasa funksiya **jimgina to'xtardi** — mahsulot na ro'yxatga, na bazaga
qo'shilardi.

### Nima uchun bu nuqson (mantiqiy xato)
`.env` da `FISCAL_PROVIDER=disabled` — ya'ni fiskal modul **o'chirilgan**, chek
chiqmaydi. Shunga qaramay IKPU talab qilinardi. Bundan tashqari mahsulotlar
jadvali "IKPU yo'q" degan **ogohlantirish belgisini** allaqachon qo'llab-quvvatlaydi
(`scripts.js:4524`) — demak IKPU ixtiyoriy bo'lishi ko'zda tutilgan.

### Tekshiruv dalillari
| Sinov | Natija |
|-------|--------|
| IKPU/qadoq **bo'sh** holda saqlash (tuzatishdan oldin) | ❌ saqlanmadi — modal ochiq qoldi, JS xatosi yo'q, sync urinilmadi |
| IKPU + qadoq **to'ldirilgan** holda saqlash | ✅ saqlandi (sabab tasdiqlandi) |
| IKPU/qadoq **bo'sh** holda saqlash (tuzatishdan keyin) | ✅ **saqlandi** |

### Yechim
IKPU va qadoq kodi endi **faqat fiskal modul haqiqatan sozlangan** (OFD ulangan)
holatda majburiy:

```js
const fiscalEnforced = (typeof Fiscal !== 'undefined')
    && typeof Fiscal.isRequired === 'function'
    && typeof Fiscal.isConfigured === 'function'
    && Fiscal.isRequired() && Fiscal.isConfigured();
if (fiscalEnforced && ikpu.length !== 17) { ... }
if (fiscalEnforced && !packageCode)       { ... }
```

- `FISCAL_PROVIDER=disabled` (hozirgi holat) → `configured:false` → **mahsulot saqlanadi**.
- OFD ulangan productionda (`configured:true`) → IKPU **hamon majburiy** (qonun talabi buzilmaydi).

`index.html` da `scripts.js` versiyasi `?v=1.4.11` → **`?v=1.4.12`** ga ko'tarildi
(brauzer eski keshlangan faylni ishlatmasligi uchun).

---

## 3. TUZATISH #2 — Kategoriya modalining dublikati

`index.html` da `id="categoryModal"`, `categoryNameInput`, `categoryModalTitle`
**ikki marta** uchraydi (`collections.Counter` bilan tasdiqlandi):

- **1-nusxa** (eski): emoji maydoni yo'q;
- **2-nusxa** (yangi): `#categoryEmojiInput` bor.

`document.getElementById()` har doim birinchisini oladi → **yangi modal hech qachon
ochilmasdi**, ya'ni kategoriyaga **icon/emoji qo'yish imkonsiz** edi
(`saveCategoryFromModal` esa aynan `#categoryEmojiInput` ni o'qiydi).

**Yechim:** eski nusxa olib tashlandi (balanslangan `<div>` skaneri bilan, 17 qator).
Barcha id va handlerlar bir xil — shuning uchun saqlash oqimi o'zgarmadi.

**Tekshiruv:** `id` dublikatlari — **0**; modal ochiladi; `categoryEmojiInput`
**ko'rinadi**; "AUDIT EMOJI KAT" + 🎯 bazaga saqlandi
(`settings.categoryEmojis = {"AUDIT EMOJI KAT": "🎯"}`).

---

## 4. TUZATILMAGAN / O'ZINGIZ QAROR QILADIGAN joylar

### 4.1. Chegirma — yaratish UI yo'q (funksiya yetishmayapti)
`#page-discounts` sahifasida faqat `#discountsTableBody` bor: `renderDiscountsPage()`
kampaniyalarni **ko'rsatadi**, lekin ularni **yaratish/tahrirlash/o'chirish** uchun
tugma, modal yoki funksiya **umuman yo'q**. Baza tomoni tayyor
(`/api/sync` → `discounts` kaliti, 500 tagacha) — faqat UI yetishmayapti.
> Kassa ichidagi oddiy chegirma (`#discountInput`, `posSetDiscount`) **ishlaydi** —
> yetishmayotgani "kampaniya" (kod bilan chegirma) qismi.

### 4.2. Sahifalarda yetishmayotgan bloklar (uzilish bermaydi, lekin ko'rinmaydi)
JS ishlatadi, HTML da yo'q → shu bloklar jimgina chiqmaydi:
`cfPeriod` (davr tanlash), `cfSplit` (kirim/chiqim ajratilgan ko'rinish),
`cfCoStatus` (saqlash holati), `d-catbreak` (kategoriya bo'yicha taqsimot),
`m-topproducts` (eng ko'p sotilganlar), `salary-urgent-badge`.
Hammasi `if (el)` bilan himoyalangan — shuning uchun sahifa buzilmaydi, shunchaki
bo'lim ko'rinmaydi.

### 4.3. KPI nollar ko'rinishi — bu kod xatosi emas
Tekshirilgan bazada **savdo (sales) = 0 ta**, shu sababli barcha KPI "0 so'm".
Formulalar to'g'ri ishlaydi (`saleProfit` = sotuv − tannarx − chegirma).
Agar haqiqiy savdolar boshqa bazada (production/Postgres) bo'lsa, u yerda raqamlar
chiqadi. Shu sababli "KPI chiqmayapti" — **ma'lumot yo'qligi**, kod nuqsoni emas.

---

## 5. Nima o'zgardi (regressiya nazorati)

| Fayl | O'zgarish |
|------|-----------|
| `scripts.js` | `saveProduct()` ga fiskal shart (12 qator) |
| `index.html` | eski dublikat modal olib tashlandi (−18), `scripts.js?v=1.4.12` (+1) |
| `app.py` | *(oldingi vazifa)* statik fayllar oq ro'yxati |

**Tegilmagan:** biznes-logika, API shartnomalari, baza sxemasi, boshqa sahifalar,
`boss.js`, `tour.js`, `style.css`, `boss.css`.

**Tekshirilgan:** `python -m py_compile app.py` ✅, `node --check scripts.js` ✅,
`node --check` bilan JS sintaksisi ✅, brauzerda 13 sahifa xatosisiz ✅,
mahsulot/kategoriya/kassa/shartnoma saqlash bazada tasdiqlandi ✅.

## 6. TEKSHIRILMAGAN (UNVERIFIED)

- Production (Railway/Postgres) bazasi — lokal nusxa bilan solishtirilmadi.
- To'lov provayderlari va fiskal OFD bilan haqiqiy integratsiya (kalitlar bo'sh).
- Mobil/responsive ko'rinish chuqur tekshirilmadi (desktop 1440×900).
- Chegirma kampaniyalari va 4.2-banddagi bloklar uchun **tuzatish qilinmadi**.
