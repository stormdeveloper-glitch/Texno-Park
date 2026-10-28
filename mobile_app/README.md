# Texno Park N1 — mobil kassa ilovasi (Flutter)

Xodimlar (kassir, menejer, admin, Boshliq) uchun kassa ilovasi. Barcha ma'lumot
serverdan olinadi: login `/api/auth/login`, mahsulotlar `/api/data`, savdo
`/api/sell` (qoldiq serverda tekshiriladi), onlayn to'lov `/api/payments/*`.

## Ishga tushirish

`android/` va `ios/` papkalari repoda bor (Flutter 3.47 bilan yaratilgan, internet ruxsati qo'shilgan):

```bash
cd mobile_app
flutter pub get
flutter run
```

## Server manzili

Odatiy manzil — `https://texno-park-production.up.railway.app`. Boshqa server uchun:

```bash
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:5000
```

`10.0.2.2` — Android emulyatordan kompyuterdagi `localhost`. Oddiy `http://`
manzil uchun `AndroidManifest.xml` dagi `<application>` tegiga
`android:usesCleartextTraffic="true"` qo'shing (faqat test uchun).

## Tekshirish va build

```bash
flutter analyze
flutter build apk --release --dart-define=API_BASE_URL=https://texno-park-production.up.railway.app
```

## Eslatma

- Serverda `CF_TURNSTILE_ENFORCE=true` bo'lsa, ilovadan kirish rad etiladi
  (mobil ilovada CAPTCHA yo'q) — bu sozlamani `false` qoldiring.
- Onlayn to'lov tugmalari faqat serverda Click/Payme kalitlari sozlangan bo'lsa chiqadi.
