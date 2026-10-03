/* ============================================================
   SAYOHAT (GUIDED TOUR) — v1
   ============================================================
   Har bir panel (admin / kassir / menejer) uchun alohida qadam-baqadam
   qo'llanma. Sayohat davomida:
     • butun ekran qorayadi (nur kam tushadi);
     • ayni tushuntirilayotgan tugma/joy yorqin halqa bilan ajralib turadi;
     • har bir qadamda "bu tugmani bossangiz nima bo'ladi" yozib boriladi.
   Boshqarish: Keyingi / Orqaga, ← → tugmalari, Esc — tugatish, F1 — qayta boshlash.
   ============================================================ */
const TOUR_STEPS = {
    /* ── ADMINISTRATOR: butun tizim bo'ylab to'liq sayohat ── */
    admin: [
        {
            page: 'page-dashboard', target: '#admin-dashboard .stat-grid',
            title: 'Admin Dashboard — asosiy ko\'rsatkichlar',
            text: 'Bu kartalarda bugungi savdo, buyurtmalar soni, mijozlar, mahsulotlar, foyda va xodimlar soni turadi. Hamma raqam faqat haqiqiy ma\'lumotdan hisoblanadi — tizim yangi bo\'lsa hammasi 0 bo\'lib turadi.'
        },
        {
            page: 'page-dashboard', target: '#salesChart',
            title: 'Haftalik savdo grafigi',
            text: 'Oxirgi 7 kunning savdosi (mln so\'m). Savdo qilinmagan kun 0 bo\'lib turadi. Yonidagi "PDF" tugmasi grafik hisobotini yuklab beradi.'
        },
        {
            page: 'page-dashboard', target: '#recentSales',
            title: 'Oxirgi sotuvlar jadvali',
            text: 'Kassada har bir to\'lovdan keyin shu yerga yangi qator tushadi: chek raqami, mijoz, summa, to\'lov turi va vaqt.'
        },
        {
            target: '#sidebar .sidebar-nav',
            title: 'Yon menyu — bo\'limlar xaritasi',
            text: 'Menyu rolingizga qarab filtrlanadi: sizda hamma bo\'lim bor. Har bir band sayohat davomida ko\'rsatib chiqiladi; band ustiga bosilsa o\'sha sahifa ochiladi.'
        },
        {
            page: 'page-pos', target: '#posSearch',
            title: 'Kassa (POS): qidiruv va barkod',
            text: 'Mahsulot nomini yoki barkodini yozing. Barkod skaner bilan skanerlasangiz, mahsulot avtomatik savatga tushadi. F3 tugmasi istalgan joydan kassaga qaytaradi.'
        },
        {
            target: '#catTabs',
            title: 'Kategoriya tugmalari',
            text: 'Barcha kategoriyalar doimiy turadi (mahsulot bo\'lmasa ham). Tugmani bossangiz — o\'sha kategoriyadagi mahsulotlargina ko\'rsatiladi, yonidagi raqam mahsulot sonini bildiradi.'
        },
        {
            target: '#productGrid',
            title: 'Mahsulot kartalari',
            text: 'Kartaning istalgan joyini bossangiz mahsulot savatga qo\'shiladi. Qoldiq 5 tadan kam bo\'lsa ogohlantirish chiqadi.'
        },
        {
            target: '#cartItems',
            title: 'Savat',
            text: 'Qo\'shilgan mahsulotlar shu yerda. + / − bilan sonini o\'zgartirasiz, axlat belgisi bilan o\'chirasiz. Hisoblar pastda avtomatik yangilanadi.'
        },
        {
            target: '#cartCustomer',
            title: 'Mijozni tanlash',
            text: 'Mijozni tanlasangiz xarid uning tarixiga va bonusiga yoziladi. Eslatma: shartnoma avtomatik tuzilmaydi — u bilan shartnoma tuzishni administrator «Shartnomalar» bo\'limida o\'zi belgilaydi.'
        },
        {
            target: '#discountInput',
            title: 'Chegirma foizi',
            text: 'Bu yerga 0–100 orasida chegirma yoziladi va umumiy summa darhol kamayadi. Yonidagi savat belgisi butun savatni tozalaydi.'
        },
        {
            target: '#payTypesGrid',
            title: 'To\'lov turlari',
            text: 'Naqd, karta, Click, Payme, Paynet, Uzum, Paylov, kredit yoki o\'tkazma. Tugmani bossangiz o\'sha to\'lov tanlanadi; kreditni tanlasangiz muddat va boshlang\'ich to\'lov paneli ochiladi.'
        },
        {
            target: '#page-pos .cart-footer button.btn-primary',
            title: 'To\'lovni qabul qilish (F2)',
            text: 'Bu tugma to\'lovni yopadi: tasdiq oynasida «To\'lov qabul qilindimi?» so\'raladi. Tasdiqlasangiz savdo tarixiga yoziladi, qoldiq kamayadi va fiskal chek chiqariladi. Bekor qilsangiz savdo ham, chek ham bo\'lmaydi.'
        },
        {
            target: '#checkoutModal',
            title: 'QR-kodli fiskal chek',
            text: 'Chek faqat to\'lov tasdiqlangandan keyin chiqadi. OFD javobidan kelgan havola QR-kodga aylanadi (fiskal belgi). QR tayyor bo\'lmaguncha «Chek Chop» tugmasi bloklangan — soxta yoki tasdiqlanmagan chek chiqmaydi.'
        },
        {
            page: 'page-products', target: '#productsTable',
            title: 'IKPU (MXIK) va qadoq kodi',
            text: 'Fiskal chek chiqishi uchun har bir mahsulotda IKPU (MXIK, 17 xonali), qadoqlash kodi va QQS stavkasi bo\'lishi shart. IKPU yo\'q mahsulotda «IKPU yo\'q» belgisi turadi va chek chiqmaydi.'
        },
        {
            page: 'page-products', target: '#page-products .btn-primary',
            title: 'Yangi mahsulot qo\'shish',
            text: 'Faqat administrator ko\'radi. Tugma formada ochiladi: nomi, kategoriyasi, narxi, qoldig\'i, barkodi va rasmi kiritiladi — saqlangach do\'kon va kassada darhol paydo bo\'ladi.'
        },
        {
            target: '#catFilter',
            title: 'Kategoriya bo\'yicha filtr',
            text: 'Kerakli kategoriyani tanlasangiz jadval faqat shu turdagi mahsulotlarni ko\'rsatadi. Yonidagi qidiruv maydoni nom bo\'yicha izlaydi.'
        },
        {
            target: '#productsTable',
            title: 'Mahsulotlar jadvali',
            text: 'Har bir qatorda rasm, narx, qoldiq va holat. Qalamcha — tahrirlash, axlat belgisi — o\'chirish (tasdiqlash so\'raladi).'
        },
        {
            page: 'page-products', target: '#catFilter',
            title: 'Mahsulot rasmi — bazaga saqlanadi',
            text: 'Tahrirlash/qo\'shish formasida rasm yuklagich (⬆) rasmni avtomatik siqadi (max 1000px, ≤ 900 KB) va mahsulot yozuvi bilan birga bazaga saqlanadi. Shuning uchun rasm boshqa kompyuter yoki brauzerda ham ko\'rinadi; xohlasangiz rasm URL manzilini qo\'lda yozish ham mumkin.'
        },
        {
            page: 'page-categories', target: '#categoriesTableBody',
            title: 'Kategoriyalar bo\'limi',
            text: 'Bu yerda tizimdagi barcha kategoriyalar va ulardagi mahsulot soni ko\'rinadi. "Ko\'rish" tugmasi o\'sha kategoriyani do\'konda filtrlab ochadi.'
        },
        {
            page: 'page-warehouse', target: '#warehouseTotalValue',
            title: 'Ombor: zaxira qiymati',
            text: 'Barcha mahsulotlarning jami tannarx qiymati (narx × qoldiq). Yonidagi karta 5 tadan kam qolgan mahsulotlar sonini ko\'rsatadi.'
        },
        {
            page: 'page-warehouse', target: '#warehouseTableBody',
            title: 'Ombordagi zaxiralar jadvali',
            text: 'Har bir mahsulotning qoldig\'i va jami qiymati. Kam qolgan qatorlar qizil rangda — vaqtida tovar buyurtma qilish uchun.'
        },
        {
            page: 'page-customers', target: '#page-customers .stat-grid',
            title: 'Mijozlar statistikasi',
            text: 'Jami, faol, VIP va nofaol mijozlar soni — barchasi haqiqiy ro\'yxatdan hisoblanadi.'
        },
        {
            page: 'page-customers', target: '#customersTable',
            title: 'Mijozlar ro\'yxati',
            text: 'Xaridlar soni, jami summasi va bonus ballari shu yerda. SMS belgisi — shu mijozga xabar yuborish, axlat belgisi — o\'chirish.'
        },
        {
            page: 'page-employees', target: '#employeesTable',
            title: 'Xodimlar va sotuv ko\'rsatkichlari',
            text: 'Har bir xodimning sotuvlar soni va daromadi real savdo tarixidan hisoblanadi. Yangi xodim qo\'shsangiz jadval yangilanadi.'
        },
        {
            page: 'page-employees', target: '#salary-stat-cards',
            title: 'Oylik maosh moduli',
            text: 'Xodimlarning oylik maoshi, navbatdagi to\'lov sanasi va holati. "Xodim Qo\'shish" tugmasi orqali maosh yozuvi kiritiladi, to\'lov qilinganda tarixga tushadi.'
        },
        {
            page: 'page-contracts', target: '.contract-auto-banner',
            title: 'Shartnomalar — faqat qo\'lda (admin qaroriga ko\'ra)',
            text: 'Savdo qilinganda shartnoma avtomatik yaratilmaydi. Kim bilan shartnoma tuzishni administrator o\'zi hal qiladi: «Qo\'lda shartnoma» tugmasi bilan mijozni (ro\'yxatdan yoki chekdan) tanlab, summa va kafolat muddatini belgilaydi. «Cheklardan import» — eski savdolarni bir marta qo\'shish uchun, «Holatlarni yangilash» esa kafolat muddatlarini qayta hisoblaydi.'
        },
        {
            page: 'page-contracts', target: '#contractsTable',
            title: 'Shartnomalar jadvali',
            text: 'Shartnoma raqami, mijoz, summa, muddat va holat. «Chek asosida» yoki «Qo\'lda kiritilgan» belgisi turadi. «Ko\'rish» bilan matn ochiladi, «Chop etish» kafolat talonini beradi; tahrirlash va o\'chirish faqat administrator uchun.'
        },
        {
            page: 'page-reports', target: '#monthChart',
            title: 'Hisobotlar: oylik savdo',
            text: 'Oxirgi 6 oyning savdo hajmi — faqat haqiqiy to\'lovlardan. Pastdagi grafik daromad dinamikasini ko\'rsatadi.'
        },
        {
            page: 'page-reports', target: '#employeeRank',
            title: 'Xodimlar reytingi',
            text: 'Kim qancha sotgani bo\'yicha o\'rinlar. Ma\'lumot savdo tarixidan avtomatik hisoblanadi.'
        },
        {
            page: 'page-discounts', target: '#discountsTableBody',
            title: 'Chegirmalar va promo-kodlar',
            text: 'Faol kampaniyalar jadvali: nomi, promo kod va foiz. Kampaniya bo\'lmasa jadval bo\'sh — hech qanday namuna ma\'lumot ko\'rsatilmaydi.'
        },
        {
            page: 'page-sms', target: '#smsTo',
            title: 'SMS: kimga yuboriladi',
            text: 'Qabul qiluvchini tanlaysiz: barcha, VIP, faol yoki nofaol mijozlar. Qavsdagi raqamlar — haqiqiy mijozlar soni.'
        },
        {
            page: 'page-sms', target: '#smsTemplates',
            title: 'SMS shablonlari',
            text: 'Tayyor shablonni bossangiz matn pastdagi maydonga tushadi; {ism}, {summa} kabi o\'rinlar mijozga moslab almashtiriladi. Yuborilgan xabarlar tarixga yoziladi.'
        },
        {
            page: 'page-logs', target: '#logsTable',
            title: 'Faollik loglari',
            text: 'Kim, qachon, qanday amal qilgani. Har bir qo\'shish, o\'chirish va to\'lov shu yerga yoziladi — nazorat uchun.'
        },
        {
            page: 'page-logs', target: '#securityTable',
            title: 'Xavfsizlik monitoringi',
            text: 'Muvaffaqiyatsiz kirishlar, bloklangan urinishlar va shubhali amallar avtomatik yozib boriladi. Yuqoridagi baho tizim xavfsizlik holatini ko\'rsatadi.'
        },
        {
            page: 'page-assistant', target: '#ai-stats',
            title: 'AI Yordamchi — real ko\'rsatkichlar',
            text: 'Yuqoridagi kartalar bazadagi haqiqiy holatni ko\'rsatadi: mahsulot turi, jami savdo, bugungi daromad va mijozlar soni. AI aynan shu ma\'lumotlarga tayanib javob beradi.'
        },
        {
            page: 'page-assistant', target: '#ai-quick',
            title: 'Tayyor savollar',
            text: 'Savolni bosish kifoya — AI bazadan hisoblab darhol javob qaytaradi: "Omborda nima kam qoldi?", "Eng ko\'p sotilgan mahsulotlar?", "Xavfsizlik hodisalari bormi?"'
        },
        {
            page: 'page-assistant', target: '#ai-input',
            title: 'AI bilan suhbat',
            text: 'O\'z savolingizni yozib Enter bosing. AI faqat o\'qish huquqi bilan ishlaydi: mijoz shaxsiy ma\'lumoti, parol yoki tizim kaliti so\'ralsa — so\'rov bloklanadi va xavfsizlik jurnaliga yoziladi.'
        },
        {
            page: 'page-settings', tab: 'tab-security', target: '#fiscalPanel',
            title: 'Fiskal chek (QR) holati',
            text: 'Bu panelda fiskal modul holati (provayder, kassa, kompaniya STIR) va cheki chiqarilmagan to\'langan savdolar ko\'rinadi. To\'lov o\'tgan, lekin OFD javob bermagan bo\'lsa «Cheklarni chiqarish» tugmasi ularni bir marta chiqarib beradi.'
        },
        {
            page: 'page-settings', tab: 'tab-security', target: '#sessionsPanel',
            title: 'Faol sessiyalar va login tarixi (serverda)',
            text: 'Bu jadvalda tizimga ulangan barcha qurilmalar: qurilma va brauzer nomi, xodim, IP manzil, kirgan vaqt va oxirgi faollik. Tanish bo\'lmagan qurilmani ko\'rsangiz — «Yopish» tugmasi bilan o\'sha sessiyani darhol o\'chirasiz (u qayta kirishi kerak bo\'ladi). Pastdagi jadvalda esa har bir login/chiqish urinishi, IP manzili va sababi ko\'rinadi.'
        },
        {
            page: 'page-settings', tab: 'tab-security', target: '#secOldPass',
            title: 'Parolni o\'zgartirish — serverda',
            text: 'Joriy va yangi parolni kiritib tugmani bossangiz parol server bazasida ham xeshlanib yangilanadi; eski tokenlar bekor qilinadi. "Barcha sessiyalarni yopish" tugmasi barcha qurilmalardagi sessiyalarni darhol kuchsiz qiladi.'
        },
        {
            page: 'page-settings', target: '#page-settings .tabs',
            title: 'Sozlamalar',
            text: 'Kompaniya ma\'lumoti, soliq foizi, chek printeri, SMS API, Click to\'lov va xavfsizlik sozlamalari shu bo\'limlarda. O\'zgartirgandan keyin "Saqlash" bosiladi.'
        },
        {
            target: '.topbar',
            title: 'Yuqori panel',
            text: 'Global qidiruv, murojaat yuborish, bildirishnomalar, chek chop etish, tema almashtirish va xodim profil menyusi shu yerda.'
        },
        {
            target: '#topbarTourBtn',
            title: 'Sayohatni qayta ko\'rish',
            text: 'Shu tugma (yoki F1) sayohatni istalgan vaqtda qaytadan boshlaydi. Sayohat tugadi — endi tizimni bemalol boshqarishingiz mumkin!'
        }
    ],

    /* ── KASSIR: kunlik ish oqimi ── */
    cashier: [
        {
            page: 'page-dashboard', target: '#cashier-dashboard .stat-grid',
            title: 'Kassir Dashboard',
            text: 'Bugungi savdo summasi, cheklar soni va o\'rtacha chek. Faqat siz qabul qilgan to\'lovlar hisoblanadi va tizim 0 dan boshlanadi.'
        },
        {
            page: 'page-dashboard', target: '#cashier-sales',
            title: 'Mening sotuvlarim',
            text: 'Bugun qabul qilgan har bir chekingiz shu jadvalda: raqami, vaqti, summasi va to\'lov turi.'
        },
        {
            page: 'page-pos', target: '#posSearch',
            title: 'Kassa: mahsulot qidirish',
            text: 'Nomini yozing yoki barkodni skanerlang — mahsulot darhol savatga qo\'shiladi. F3 istalgan joydan kassaga qaytaradi, Enter qidiruvni tasdiqlaydi.'
        },
        {
            target: '#catTabs',
            title: 'Kategoriya tugmalari',
            text: 'Barcha kategoriyalar doimiy turadi. Tugmani bossangiz faqat o\'sha turdagi mahsulotlar qoladi, qavsdagi raqam — mahsulot soni.'
        },
        {
            target: '#productGrid',
            title: 'Mahsulot kartalari',
            text: 'Kartani bossangiz mahsulot savatga tushadi. Qoldiq 5 tadan kam bo\'lsa ogohlantirish belgisi chiqadi.'
        },
        {
            target: '#cartItems',
            title: 'Savat',
            text: 'Savat ichida sonni + / − bilan o\'zgartirasiz, kerak bo\'lmasa o\'chirasiz. Pastdagi jami summa avtomatik hisoblanadi.'
        },
        {
            target: '#cartCustomer',
            title: 'Mijozni biriktirish',
            text: 'Mijozni tanlasangiz xarid uning tarixiga yoziladi. Shartnoma avtomatik tuzilmaydi — uni administrator alohida «Shartnomalar» bo\'limida tuzadi. Ro\'yxatda yo\'q bo\'lsa "Mijozlar" bo\'limidan qo\'shasiz.'
        },
        {
            target: '#discountInput',
            title: 'Chegirma berish',
            text: 'Foizni yozsangiz summa darhol kamayadi. Bu maydon yonidagi savat belgisi butun savatni tozalaydi (Esc ham).'
        },
        {
            target: '#payTypesGrid',
            title: 'To\'lov turini tanlash',
            text: 'Naqd, karta yoki onlayn to\'lovni tanlaysiz. Onlayn to\'lovni tanlasangiz QR-kod va to\'lov havolasi chiqadi; kreditni tanlasangiz muddat paneli ochiladi.'
        },
        {
            target: '#page-pos .cart-footer button.btn-primary',
            title: 'To\'lovni qabul qilish (F2)',
            text: 'Eng muhim tugma: tasdiq oynasida to\'lovni qabul qilganingizni belgilaysiz. Shundan keyingina savdo saqlanadi, qoldiq kamayadi va QR-kodli fiskal chek chiqadi — chek chop etish tugmasi QR tayyor bo\'lgach faollashadi.'
        },
        {
            page: 'page-contracts', target: '#contractsTable',
            title: 'Shartnomalar',
            text: 'Shartnomalar avtomatik yaratilmaydi — ularni administrator tuzadi. Mijoz kafolat talonini so\'rasa shu yerdan «Ko\'rish» orqali chiqarib berasiz (tahrirlash/o\'chirish faqat admin uchun).'
        },
        {
            page: 'page-customers', target: '#customersTable',
            title: 'Mijozlar',
            text: 'Mijozning xaridlari va bonus ballari. "Yangi Mijoz" tugmasi bilan kassada turib mijoz qo\'shishingiz mumkin.'
        },
        {
            target: '.topbar',
            title: 'Yuqori panel',
            text: 'Qidiruv, bildirishnoma, chek chop etish (F8), tema va xodim menyusi. Eng chapdagi "Sayohat" belgisi bu qo\'llanmani qayta ochadi.'
        },
        {
            target: '#topbarTourBtn',
            title: 'Sayohat tugadi',
            text: 'Bu tugmani (yoki F1) bosib qo\'llanmani istalgan payt qaytadan ko\'rishingiz mumkin. Ish jarayonida savol tug\'ilsa shu yerdan boshlang!'
        }
    ],

    /* ── MENEJER: nazorat va tahlil ── */
    manager: [
        {
            page: 'page-dashboard', target: '#manager-dashboard .stat-grid',
            title: 'Manager Dashboard',
            text: 'Bugungi jami savdo, faol xodimlar soni va eng yaxshi kassir. Barchasi haqiqiy savdo ma\'lumotidan hisoblanadi.'
        },
        {
            page: 'page-dashboard', target: '#manager-employees',
            title: 'Xodimlar reytingi',
            text: 'Kim qancha sotgani bo\'yicha tartiblangan ro\'yxat. Savdo bo\'lmasa hamma ko\'rsatkich 0 bo\'lib turadi.'
        },
        {
            page: 'page-pos', target: '#posSearch',
            title: 'Kassa: qidiruv',
            text: 'Nomi yoki barkod bo\'yicha mahsulot topiladi. Kerak bo\'lsa menejer sifatida o\'zingiz ham savdo qabul qilishingiz mumkin.'
        },
        {
            target: '#catTabs',
            title: 'Kategoriya tugmalari',
            text: 'Doimiy kategoriyalar ro\'yxati — har birida nechta mahsulot borligi ko\'rinib turadi. Tugma bosilsa kassadagi ro\'yxat filtrlanadi.'
        },
        {
            target: '#cartItems',
            title: 'Savat va hisob-kitob',
            text: 'Savat, chegirma maydoni va to\'lov tugmasi. "To\'lovni qabul qilish" (F2) tugmasi savdoni yakunlaydi va hisobotlarga yozadi.'
        },
        {
            page: 'page-warehouse', target: '#warehouseTotalValue',
            title: 'Ombor nazorati',
            text: 'Zaxiraning umumiy qiymati va kam qolgan mahsulotlar soni. Bu ko\'rsatkichlar orqali tovar buyurtmasini rejalashtirasiz.'
        },
        {
            page: 'page-warehouse', target: '#warehouseTableBody',
            title: 'Zaxiralar jadvali',
            text: 'Har bir mahsulotning qoldig\'i, dona bahosi va jami qiymati. Kam qolgan qatorlar qizil rangda.'
        },
        {
            page: 'page-employees', target: '#employeesTable',
            title: 'Xodimlar boshqaruvi',
            text: 'Xodimlarning sotuvlari va daromadi. Bu yerdan yangi xodim qo\'shishingiz mumkin — ro\'yxat darhol yangilanadi.'
        },
        {
            page: 'page-employees', target: '#salary-stat-cards',
            title: 'Oylik maosh nazorati',
            text: 'Jami oylik xarajat, kechikkan va bugun to\'lanadigan to\'lovlar. Karta bosilganda filtr tugmalari jadvalni shunga moslab tozalaydi.'
        },
        {
            page: 'page-contracts', target: '#contractsTable',
            title: 'Shartnomalar',
            text: 'Administrator tomonidan tuzilgan shartnomalar, kafolat muddati va holati. Shartnoma qo\'lda tuziladi (chek asosida yoki qo\'lda kiritib), CSV tugmasi bilan hisobotga eksport qilinadi.'
        },
        {
            page: 'page-reports', target: '#monthChart',
            title: 'Hisobotlar: oylik savdo',
            text: 'Oxirgi 6 oyning savdo hajmi faqat haqiqiy to\'lovlardan hisoblanadi. Excel tugmasi yuklab beradi.'
        },
        {
            page: 'page-reports', target: '#employeeRank',
            title: 'Xodimlar reytingi jadvali',
            text: 'Medallar bilan eng yaxshi xodimlar. Ko\'rsatkichlar savdo tarixidan avtomatik yangilanadi.'
        },
        {
            page: 'page-discounts', target: '#discountsTableBody',
            title: 'Chegirmalar',
            text: 'Faol promo-kodlar va chegirma foizlari. Kampaniya qo\'shilmagan bo\'lsa jadval bo\'sh turadi.'
        },
        {
            target: '.topbar',
            title: 'Yuqori panel',
            text: 'Global qidiruv, murojaatlar, bildirishnomalar, tema va xodim menyusi.'
        },
        {
            target: '#topbarTourBtn',
            title: 'Sayohat tugadi',
            text: 'F1 yoki shu tugma bilan qo\'llanmani qaytadan ko\'rish mumkin. Endi hisobot va nazoratni bemalol boshqarasiz!'
        }
    ]
};

const Tour = (function () {
    'use strict';

    const SEEN_KEY = 'tp_tour_seen';

    let steps = [];
    let index = 0;
    let active = false;
    let currentTarget = null;
    let layer = null, spot = null, ring = null, tip = null, blockers = [];

    /* ── YORDAMCHI ─────────────────────────────────────────── */
    function currentRole() {
        try {
            return (typeof currentUser !== 'undefined' && currentUser) ? currentUser.role : null;
        } catch (e) { return null; }
    }

    function seenList() {
        try {
            const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e) { return []; }
    }

    function markSeen(role) {
        if (!role) return;
        try {
            const list = seenList();
            if (!list.includes(role)) {
                list.push(role);
                localStorage.setItem(SEEN_KEY, JSON.stringify(list));
            }
        } catch (e) { /* jim */ }
    }

    function notify(type, title, text) {
        try {
            if (typeof showNotif === 'function') showNotif(type, title, text);
        } catch (e) { /* jim */ }
    }

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function navFor(pageId) {
        return document.querySelector(`.nav-item[onclick*="'${pageId}'"]`);
    }

    /* ── DOM QATLAMINI QURISH ──────────────────────────────── */
    function ensureLayer() {
        if (layer) return;
        layer = document.createElement('div');
        layer.id = 'tourLayer';
        layer.innerHTML = `
            <div id="tourBlockers">
                <div class="tour-blocker" data-side="top"></div>
                <div class="tour-blocker" data-side="bottom"></div>
                <div class="tour-blocker" data-side="left"></div>
                <div class="tour-blocker" data-side="right"></div>
            </div>
            <div id="tourSpot"></div>
            <div id="tourRing"></div>
            <div id="tourTip" role="dialog" aria-live="polite">
                <div class="tour-tip-head">
                    <span class="tour-tip-counter" id="tourCounter"></span>
                    <button type="button" class="tour-tip-close" id="tourClose" title="Sayohatni tugatish (Esc)">&times;</button>
                </div>
                <h4 class="tour-tip-title" id="tourTitle"></h4>
                <p class="tour-tip-text" id="tourText"></p>
                <div class="tour-tip-progress"><div class="tour-tip-progress-fill" id="tourProgress"></div></div>
                <div class="tour-tip-foot">
                    <button type="button" class="btn btn-outline btn-sm" id="tourPrev">Orqaga</button>
                    <button type="button" class="btn btn-primary btn-sm" id="tourNext">Keyingi</button>
                </div>
            </div>`;
        document.body.appendChild(layer);

        spot = layer.querySelector('#tourSpot');
        ring = layer.querySelector('#tourRing');
        tip = layer.querySelector('#tourTip');
        blockers = Array.prototype.slice.call(layer.querySelectorAll('.tour-blocker'));

        layer.querySelector('#tourClose').addEventListener('click', function () { stop(true); });
        layer.querySelector('#tourPrev').addEventListener('click', prev);
        layer.querySelector('#tourNext').addEventListener('click', next);

        window.addEventListener('resize', onReflow);
        window.addEventListener('scroll', onReflow, true);
    }

    function onReflow() {
        if (!active) return;
        if (onReflow.timer) return;
        onReflow.timer = setTimeout(function () {
            onReflow.timer = null;
            paint();
        }, 80);
    }

    /* ── JOYLASHTIRISH (spotlight + tooltip) ───────────────── */
    function setBox(node, top, left, width, height) {
        node.style.top = Math.round(top) + 'px';
        node.style.left = Math.round(left) + 'px';
        node.style.width = Math.max(0, Math.round(width)) + 'px';
        node.style.height = Math.max(0, Math.round(height)) + 'px';
    }

    /* Maqsad ko'rinmasa (yopiq menyu, tor ekran) — nur qorayadi,
       tushuntirish ekran markazida ko'rsatiladi. Qadam tashlab ketilmaydi. */
    function showCentered() {
        if (!active || !layer) return;
        const W = window.innerWidth, H = window.innerHeight;
        if (spot) spot.style.display = 'none';
        if (ring) ring.style.display = 'none';
        layer.classList.add('tour-dim');
        setBox(blockers[0], 0, 0, W, H);
        setBox(blockers[1], 0, 0, 0, 0);
        setBox(blockers[2], 0, 0, 0, 0);
        setBox(blockers[3], 0, 0, 0, 0);
        const tipW = tip.offsetWidth || 340;
        const tipH = tip.offsetHeight || 200;
        tip.setAttribute('data-arrow', 'none');
        tip.style.top = Math.round(clamp((H - tipH) / 2, 12, Math.max(12, H - tipH - 12))) + 'px';
        tip.style.left = Math.round(clamp((W - tipW) / 2, 12, Math.max(12, W - tipW - 12))) + 'px';
    }

    function paint() {
        if (!active || !spot) return;
        if (!currentTarget) return showCentered();
        spot.style.display = '';
        ring.style.display = '';
        layer.classList.remove('tour-dim');
        const r = currentTarget.getBoundingClientRect();
        const W = window.innerWidth, H = window.innerHeight;
        const pad = 8;

        let top = r.top - pad;
        let left = r.left - pad;
        let width = r.width + pad * 2;
        let height = r.height + pad * 2;

        // Juda kichik elementlar ham ko'rinadigan bo'lsin
        if (width < 44) { left -= (44 - width) / 2; width = 44; }
        if (height < 30) { top -= (30 - height) / 2; height = 30; }

        // Ekrandan katta bloklar uchun faqat ko'rinadigan qismini ajratamiz,
        // aks holda butun ekran "yorug'" bo'lib qoladi
        const maxH = Math.min(H * 0.6, 520);
        const maxW = Math.min(W * 0.9, 1200);
        if (width > maxW) width = maxW;
        if (height > maxH) height = maxH;
        top = clamp(top, 8, Math.max(8, H - height - 8));
        left = clamp(left, 8, Math.max(8, W - width - 8));

        setBox(spot, top, left, width, height);
        setBox(ring, top, left, width, height);

        // Qorayishdan tashqari qolgan hududni bosib qo'yuvchi to'siqlar
        const bTop = clamp(top, 0, H);
        const bBottom = clamp(top + height, 0, H);
        const bLeft = clamp(left, 0, W);
        const bRight = clamp(left + width, 0, W);
        setBox(blockers[0], 0, 0, W, bTop);
        setBox(blockers[1], 0, bBottom, W, H - bBottom);
        setBox(blockers[2], bTop, 0, bLeft, bBottom - bTop);
        setBox(blockers[3], bTop, bRight, W - bRight, bBottom - bTop);

        // Tooltip joyi: pastda joy bo'lmasa tepaga
        const gap = 16;
        const tipW = tip.offsetWidth || 340;
        const tipH = tip.offsetHeight || 180;
        const desired = steps[index]?.pos || 'auto';
        const spaceBelow = H - (top + height);
        const spaceAbove = top;

        let tipTop;
        if (desired === 'top' || (desired === 'auto' && spaceBelow < tipH + gap && spaceAbove > spaceBelow)) {
            tipTop = top - tipH - gap;
        } else {
            tipTop = top + height + gap;
        }
        let tipLeft = left + width / 2 - tipW / 2;

        tipTop = clamp(tipTop, 12, Math.max(12, H - tipH - 12));
        tipLeft = clamp(tipLeft, 12, Math.max(12, W - tipW - 12));
        tip.style.top = Math.round(tipTop) + 'px';
        tip.style.left = Math.round(tipLeft) + 'px';
        tip.setAttribute('data-arrow', tipTop < top ? 'bottom' : 'top');
    }

    /* ── QADAMNI KO'RSATISH ────────────────────────────────── */
    function renderText() {
        const step = steps[index];
        if (!step) return;
        uiText('tourCounter', (index + 1) + ' / ' + steps.length);
        uiText('tourTitle', step.title || '');
        uiText('tourText', step.text || '');
        const fill = document.getElementById('tourProgress');
        if (fill) fill.style.width = Math.round(((index + 1) / steps.length) * 100) + '%';
        const prevBtn = document.getElementById('tourPrev');
        if (prevBtn) prevBtn.style.visibility = index === 0 ? 'hidden' : 'visible';
        const nextBtn = document.getElementById('tourNext');
        if (nextBtn) nextBtn.textContent = index === steps.length - 1 ? 'Tugatish' : 'Keyingi';
    }

    function uiText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function show(i) {
        if (!active) return;
        if (i < 0) return;
        if (i >= steps.length) { stop(true); return; }
        index = i;
        const step = steps[i];

        // Kerak bo'lsa sahifaga o'tamiz
        let wait = 0;
        if (step.page) {
            const current = document.querySelector('.page.active');
            if (!current || current.id !== step.page) {
                if (typeof goTo === 'function') goTo(step.page, navFor(step.page));
                wait = 320;
            }
        }
        // Kerak bo'lsa ichki varaqni (tab) ochamiz — masalan Sozlamalar → Xavfsizlik
        if (step.tab && typeof showTab === 'function') {
            const tabBtn = document.querySelector('.tabs .tab[onclick*="' + step.tab + '"]');
            showTab(step.tab, tabBtn);
            wait = Math.max(wait, 150);
        }
        renderText();
        setTimeout(function () { resolveTarget(i); }, wait);
    }

    function resolveTarget(i) {
        if (!active || index !== i) return;
        const step = steps[i];
        let el = null;
        try {
            el = step.target ? document.querySelector(step.target) : null;
            if (el) el = el.closest('.nav-item') || el;
        } catch (e) {
            el = null;
        }

        const rect = el ? el.getBoundingClientRect() : null;
        if (!el || !rect || rect.width === 0 || rect.height === 0) {
            // Maqsad hozir ko'rinmaydi — qadamni tashlab ketmaymiz,
            // tushuntirishni ekran markazida ko'rsatamiz.
            currentTarget = null;
            paint();
            return;
        }

        currentTarget = el;
        try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (e) { }
        setTimeout(function () {
            if (active && index === i) paint();
        }, 260);
    }

    /* ── BOSHQARUV ─────────────────────────────────────────── */
    function next() { if (active) show(index + 1); }
    function prev() { if (active) show(index - 1); }

    function start() {
        const role = currentRole();
        if (!isAvailable(role)) {
            notify('info', 'Sayohat yo\'q', 'Bu sahifa uchun qo\'llanma mavjud emas');
            return;
        }
        closeModals();
        ensureLayer();
        steps = TOUR_STEPS[role].slice();
        index = 0;
        active = true;
        layer.classList.add('active');
        markSeen(role);
        show(0);
    }

    function stop(markSeenRole) {
        active = false;
        currentTarget = null;
        if (layer) {
            layer.classList.remove('active');
            layer.classList.remove('tour-dim');
        }
        if (markSeenRole) markSeen(currentRole());
    }

    function closeModals() {
        document.querySelectorAll('.modal-overlay.open').forEach(function (m) {
            m.classList.remove('open');
        });
    }

    function isAvailable(role) {
        const r = role || currentRole();
        return !!(r && TOUR_STEPS[r] && TOUR_STEPS[r].length);
    }

    /** Birinchi kirishda avtomatik boshlash (faqat bir marta). */
    function maybeAutoStart() {
        const role = currentRole();
        if (!isAvailable(role)) return;
        if (seenList().includes(role)) return;
        setTimeout(function () {
            if (!active && isAvailable(currentRole())) start();
        }, 900);
    }

    /** Sayohat "ko'rilgan" belgisini tozalash — keyingi kirishda qayta boshlanadi. */
    function reset(role) {
        try {
            const r = role || currentRole();
            localStorage.setItem(SEEN_KEY, JSON.stringify(seenList().filter(x => x !== r)));
        } catch (e) { }
    }

    /* ── KLAVIATURA ────────────────────────────────────────── */
    document.addEventListener('keydown', function (e) {
        if (!active) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stop(true); return; }
        if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); next(); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); prev(); return; }
        // Sayohat paytida boshqa tezkor tugmalar ishlamasin
        if (/^F\d+$/.test(e.key) || e.key === 'Tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    return {
        startTour: start,
        start: start,
        stop: stop,
        next: next,
        prev: prev,
        maybeAutoStart: maybeAutoStart,
        reset: reset,
        isAvailable: isAvailable,
        isActive: function () { return active; }
    };
})();
