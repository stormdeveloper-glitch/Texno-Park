'use strict';

// ============================================================
// STATE
// ============================================================
let currentUser = null;
let cart = [];
let shopCart = [];
let payType = 'cash';
let editingProductId = null;
let salesChart = null, payChart = null, monthChart = null, incomeChart = null;
let lastCheckoutSale = null;

// AudioContext for sound feedback
let audioCtx = null;
function getAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}
function playBeep(freq = 880, dur = 0.1, type = 'sine', vol = 0.3) {
    if (!(document.getElementById('soundEnabled')?.checked ?? true)) return;
    try {
        const ctx = getAudio();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = type;
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
        osc.start(); osc.stop(ctx.currentTime + dur);
    } catch (e) { }
}
function playSuccess() { playBeep(880, 0.08); setTimeout(() => playBeep(1200, 0.12), 80); }
function playError() { playBeep(200, 0.3, 'sawtooth', 0.2); }
function playScan() { playBeep(1500, 0.06, 'square', 0.2); }
function playCheckout() { [440, 550, 660, 880].forEach((f, i) => setTimeout(() => playBeep(f, .1), i * 80)); }

function escapeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}

function safeJsonParse(raw, fallback) {
    try {
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
    } catch (e) {
        console.warn('JSON parse blocked:', e);
        return fallback;
    }
}

function cleanText(value, maxLen = 160) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/[<>]/g, '')
        .trim()
        .slice(0, maxLen);
}

function hasSqlInjectionPattern(value) {
    const text = String(value ?? '').toLowerCase();
    return /(--|\/\*|\*\/|;)/.test(text) ||
        /(['"]\s*(or|and)\s+['"]?\w+['"]?\s*=\s*['"]?\w+)/i.test(text) ||
        /\b(union\s+select|select\s+.+\s+from|drop\s+table|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(text);
}

function validateSafeInput(label, value, maxLen = 160) {
    const text = cleanText(value, maxLen);
    if (hasSqlInjectionPattern(text)) {
        playError();
        showNotif('error', 'Xavfsizlik!', `${label} maydonida shubhali SQL belgilar topildi`);
        return null;
    }
    return text;
}

function safeImageUrl(value) {
    const raw = cleanText(value, 500);
    if (!raw) return '';
    try {
        const url = new URL(raw, window.location.href);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (e) {
        return '';
    }
}

function getPostimageUrl(data) {
    const urls = [];
    const collect = value => {
        if (!value) return;
        if (typeof value === 'string') {
            const safe = safeImageUrl(value);
            if (safe) urls.push(safe);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }
        if (typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(data);
    return urls.find(isDisplayableImageUrl) ||
        urls.find(url => new URL(url).hostname.includes('postimg')) ||
        urls[0] ||
        '';
}

function isDisplayableImageUrl(value) {
    const url = safeImageUrl(value);
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.hostname.startsWith('i.') ||
            /\.(avif|bmp|gif|jpe?g|png|svg|webp)(\?.*)?$/i.test(parsed.pathname);
    } catch (e) {
        return false;
    }
}

function productImageSrc(value) {
    const url = safeImageUrl(value);
    return isDisplayableImageUrl(url) ? url : '';
}

async function uploadProductImageToPostimage(input) {
    if (!requireRole('admin')) return;
    const file = input?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        playError();
        showNotif('error', 'Xato!', 'Faqat rasm fayl yuklang');
        input.value = '';
        return;
    }
    if (file.size > 32 * 1024 * 1024) {
        playError();
        showNotif('error', 'Xato!', 'Rasm hajmi 32MB dan oshmasin');
        input.value = '';
        return;
    }

    const btn = document.getElementById('postimageUploadBtn');
    const previousHtml = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
        const form = new FormData();
        form.append('numfiles', '1');
        form.append('upload_session', String(Date.now()) + Math.random().toString().slice(1));
        form.append('file', file, file.name);

        const res = await fetch('https://postimages.org/json', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Cache-Control': 'no-cache',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: form,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || data?.error) throw new Error(data?.error || 'Postimage javob bermadi');

        const imageUrl = getPostimageUrl(data);
        if (!imageUrl) throw new Error('Rasm URL qaytmadi');

        document.getElementById('p-img').value = imageUrl;
        playSuccess();
        showNotif('success', 'Yuklandi!', 'Rasm Postimages ga yuklandi');
    } catch (e) {
        console.error('Postimage upload failed:', e);
        playError();
        showNotif('error', 'Yuklanmadi!', e?.message || 'Rasmni Postimages ga yuklab bo\'lmadi');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = previousHtml;
        }
        input.value = '';
    }
}

function csvCell(value) {
    const text = String(value ?? '');
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
}

function requireRole(...roles) {
    if (!currentUser || !roles.includes(currentUser.role)) {
        playError();
        showNotif('error', 'Ruxsat yo\'q!', 'Bu amal uchun huquq yetarli emas');
        return false;
    }
    return true;
}

function normalizeProduct(p) {
    return {
        id: Number(p?.id) || Date.now(),
        name: cleanText(p?.name, 120),
        cat: cleanText(p?.cat, 80) || 'Aksessuarlar',
        price: Math.max(0, Number(p?.price) || 0),
        stock: Math.max(0, Number(p?.stock) || 0),
        barcode: cleanText(p?.barcode, 64),
        img: safeImageUrl(p?.img),
        desc: cleanText(p?.desc, 300),
    };
}

function normalizeCustomer(c) {
    return {
        id: Number(c?.id) || Date.now(),
        name: cleanText(c?.name, 120),
        phone: cleanText(c?.phone, 40),
        email: cleanText(c?.email, 120),
        orders: Math.max(0, Number(c?.orders) || 0),
        total: Math.max(0, Number(c?.total) || 0),
        bonus: Math.max(0, Number(c?.bonus) || 0),
        status: ['active', 'vip', 'inactive'].includes(c?.status) ? c.status : 'active',
    };
}

// ============================================================
// USERS
// ============================================================
const USERS = [
    { id: 1, login: 'admin', passHash: 'MTIzNDU2', name: 'Abdullayev Admin', role: 'admin', color: '#ff6b35' },
    { id: 2, login: 'cashier', passHash: 'MTIzNDU2', name: 'Karimov Kassir', role: 'cashier', color: '#10B981' },
    { id: 3, login: 'manager', passHash: 'MTIzNDU2', name: 'Toshmatov Menejer', role: 'manager', color: '#F59E0B' },
    { id: 7, login: 'customer', passHash: 'MTIzNDU2', name: 'Online Xaridor', role: 'customer', color: '#2563EB' },
    { id: 4, login: 'admin@tehnopark.uz', passHash: 'MTIzNDU2', name: 'Abdullayev Admin', role: 'admin', color: '#ff6b35' },
    { id: 5, login: 'cashier@tehnopark.uz', passHash: 'MTIzNDU2', name: 'Karimov Kassir', role: 'cashier', color: '#10B981' },
    { id: 6, login: 'manager@tehnopark.uz', passHash: 'MTIzNDU2', name: 'Toshmatov Menejer', role: 'manager', color: '#F59E0B' },
    { id: 8, login: 'customer@tehnopark.uz', passHash: 'MTIzNDU2', name: 'Online Xaridor', role: 'customer', color: '#2563EB' },
];
const ROLES = { admin: 'Administrator', cashier: 'Kassa Xodimi', manager: 'Menejer', customer: 'Xaridor' };

// ============================================================
// DATA (with localStorage persistence)
// ============================================================
let products = safeJsonParse(localStorage.getItem('tp_products') || 'null', null) || [
    { id: 1, name: 'Samsung No Frost 350L', cat: 'Muzlatgichlar', price: 4500000, stock: 8, barcode: '8801643697571', img: '', desc: 'Samsung No Frost 350L quvvati' },
    { id: 2, name: 'LG Twin Wash 7kg', cat: 'Kir Yuvish Mashinalari', price: 3800000, stock: 12, barcode: '8806091782345', img: '', desc: 'LG Twin Wash avtomatik' },
    { id: 3, name: 'Artel 12000 BTU', cat: 'Konditsionerlar', price: 3200000, stock: 5, barcode: '4780020412345', img: '', desc: 'Artel konditsioner inverter' },
    { id: 4, name: 'Samsung 55" QLED', cat: 'Televizorlar', price: 7500000, stock: 4, barcode: '8801643123456', img: '', desc: 'Samsung 55 QLED 4K Smart TV' },
    { id: 5, name: 'Dyson V12 Slim', cat: 'Changyutgichlar', price: 4200000, stock: 7, barcode: '5025155032345', img: '', desc: 'Dyson simsiz changyutgich' },
    { id: 6, name: 'Bosch Termopot 5L', cat: 'Pechlar', price: 650000, stock: 20, barcode: '4242005078901', img: '', desc: 'Bosch elektr termopot' },
    { id: 7, name: 'Midea Mikroto\'lqinli', cat: 'Mikrotolqinli Pechlar', price: 980000, stock: 15, barcode: '6925210234567', img: '', desc: 'Midea 20L mikrotolqinli pech' },
    { id: 8, name: 'Artel 315L Muzlatgich', cat: 'Muzlatgichlar', price: 3100000, stock: 6, barcode: '4780020498765', img: '', desc: 'Artel No Frost muzlatgich' },
    { id: 9, name: 'Samsung 43" Crystal', cat: 'Televizorlar', price: 3600000, stock: 9, barcode: '8801643765432', img: '', desc: 'Samsung 43 Crystal UHD Smart TV' },
    { id: 10, name: 'Philips Fen 2000W', cat: 'Aksessuarlar', price: 280000, stock: 30, barcode: '8710103987654', img: '', desc: 'Philips saoch fen 2000W' },
];
products = Array.isArray(products) ? products.map(normalizeProduct).filter(p => p.name && p.price >= 0) : [];

let customers = safeJsonParse(localStorage.getItem('tp_customers') || 'null', null) || [
    { id: 1, name: 'Akbar Toshmatov', phone: '+998 90 111 2233', email: 'akbar@gmail.com', orders: 12, total: 45000000, bonus: 450, status: 'active' },
    { id: 2, name: 'Malika Yusupova', phone: '+998 91 222 3344', email: 'malika@gmail.com', orders: 8, total: 28000000, bonus: 280, status: 'vip' },
    { id: 3, name: 'Jasur Karimov', phone: '+998 93 333 4455', email: 'jasur@mail.ru', orders: 3, total: 9500000, bonus: 95, status: 'active' },
    { id: 4, name: 'Dilnoza Rahimova', phone: '+998 94 444 5566', email: '', orders: 1, total: 150000, bonus: 2, status: 'inactive' },
    { id: 5, name: 'Bobur Ismoilov', phone: '+998 97 555 6677', email: 'bobur@yahoo.com', orders: 20, total: 89000000, bonus: 890, status: 'vip' },
];
customers = Array.isArray(customers) ? customers.map(normalizeCustomer).filter(c => c.name && c.phone) : [];

let employees = [
    { id: 1, name: 'Abdullayev Admin', role: 'admin', sales: 89, total: 145000000, login: '08:30', status: 'active' },
    { id: 2, name: 'Karimov Kassir', role: 'cashier', sales: 47, total: 52000000, login: '09:00', status: 'active' },
    { id: 3, name: 'Toshmatov Menejer', role: 'manager', sales: 0, total: 0, login: '08:45', status: 'active' },
];

let salesHistory = safeJsonParse(localStorage.getItem('tp_sales') || '[]', []);
let logs = safeJsonParse(localStorage.getItem('tp_logs') || '[]', []);
salesHistory = Array.isArray(salesHistory) ? salesHistory : [];
logs = Array.isArray(logs) ? logs : [];

// ============================================================
// SMS TEMPLATES (COMPLETED)
// ============================================================
const smsTemplates = [
    { title: 'Chegirma haqida', text: 'Hurmatli {ism}! Tehno Parkda 20% chegirma kampaniyasi boshlandi. Muzlatgich, TV va konditsionerlarda katta chegirmalar. Tez keling!' },
    { title: 'Chek tasdiqlash', text: 'Hurmatli {ism}! Siz {summa} so\'mlik xarid qildingiz. Chek raqamingiz: {chek}. Xarid uchun rahmat! Tehno Park.' },
    { title: 'Tug\'ilgan kun', text: 'Hurmatli {ism}! Tug\'ilgan kuningiz bilan qutlaymiz! 🎉 Sovg\'a sifatida keyingi xaridingizda 10% chegirma beramiz.' },
    { title: 'Yangi mahsulot', text: 'Hurmatli {ism}! Tehno Parkda yangi {mahsulot} keldi. Narxi: {narx} so\'m. Soni cheklangan, bugun keling!' },
    { title: 'Qarz eslatma', text: 'Hurmatli {ism}! Qoldiq to\'lovingiz {summa} so\'m. Iltimos, {sana} gacha to\'lashingizni so\'raymiz. Tehno Park.' },
    { title: 'Kafolat eslatma', text: 'Hurmatli {ism}! Sizning {mahsulot} qurilmangizning kafolati {sana} da tugaydi. Kafolatni uzaytirish uchun murojaat qiling.' },
];

// ============================================================
// OFFLINE MODE
// ============================================================
window.addEventListener('online', () => { document.getElementById('offlineBar').classList.remove('show'); showNotif('success', 'Online!', 'Internet aloqasi tiklandi'); });
window.addEventListener('offline', () => { document.getElementById('offlineBar').classList.add('show'); showNotif('error', 'Oflayn!', 'Internet aloqasi yo\'q. Tizim oflayn rejimda ishlaydi'); });

function saveToStorage() {
    try {
        localStorage.setItem('tp_products', JSON.stringify(products));
        localStorage.setItem('tp_customers', JSON.stringify(customers));
        localStorage.setItem('tp_sales', JSON.stringify(salesHistory));
        localStorage.setItem('tp_logs', JSON.stringify(logs));
    } catch (e) {
        console.error('localStorage xatosi:', e);
        alert("Diqqat: Brauzer xotirasi to'ldi! Iltimos, Sozlamalar bo'limidan ma'lumotlarni eksport qilib zaxiralang yoki keraksiz ma'lumotlarni tozalang. Aks holda ma'lumotlaringiz saqlanmasligi mumkin.");
    }
}

// ============================================================
// BARCODE SCANNER — USB/Bluetooth optimized
// ============================================================
let barcodeBuffer = '';
let barcodeTimer = null;

document.addEventListener('keypress', e => {
    // Only in POS page, ignore when typing in inputs
    if (document.activeElement.tagName === 'TEXTAREA') return;
    if (document.activeElement.tagName === 'INPUT' &&
        document.activeElement.id !== 'posSearch' &&
        !document.getElementById('page-pos').classList.contains('active')) return;

    // Accumulate fast characters (barcode scanners send chars very quickly)
    barcodeBuffer += e.key;

    if (barcodeTimer) clearTimeout(barcodeTimer);
    barcodeTimer = setTimeout(() => {
        const code = barcodeBuffer.trim();
        barcodeBuffer = '';
        if (code.length >= 4) { // Valid barcode length
            processBarcodeInput(code);
        }
    }, 80); // 80ms = typical barcode scanner speed

    // Enter key = barcode complete
    if (e.key === 'Enter' && barcodeBuffer.length > 1) {
        clearTimeout(barcodeTimer);
        const code = barcodeBuffer.replace(/\n|\r/g, '').trim();
        barcodeBuffer = '';
        if (code.length >= 4) processBarcodeInput(code);
    }
});

function processBarcodeInput(code) {
    const indicator = document.getElementById('barcodeIndicator');
    indicator.classList.add('scanning');
    document.getElementById('barcodeStatus').textContent = `Skanerlandi: ${code}`;
    setTimeout(() => {
        indicator.classList.remove('scanning');
        document.getElementById('barcodeStatus').textContent = 'Barkod skaner tayyor — USB/Bluetooth ulang';
    }, 1500);

    // Find by barcode or by code in name
    let p = products.find(x => x.barcode === code);
    if (!p) p = products.find(x => x.id === parseInt(code));
    if (!p) p = products.find(x => x.name.toLowerCase().includes(code.toLowerCase()));

    if (p) {
        addToCart(p.id, true); // isScan=true
        if (document.getElementById('page-pos').classList.contains('active')) {
            goTo('page-pos', document.getElementById('navPos'));
        }
    } else {
        playError();
        showNotif('error', 'Topilmadi!', `Barkod: ${code} — mahsulot yo'q`);
    }
}

// ============================================================
// PASSWORD TOGGLE
// ============================================================
function togglePassword() {
    const inp = document.getElementById('loginPass');
    const ico = document.querySelector('#loginPage .pass-toggle i');
    if (!inp || !ico) return;
    if (inp.type === 'password') { inp.type = 'text'; ico.className = 'fas fa-eye-slash'; }
    else { inp.type = 'password'; ico.className = 'fas fa-eye'; }
}

function selectUser(role) {
    const loginUser = document.getElementById('loginUser');
    const loginPass = document.getElementById('loginPass');
    if (!loginUser || !loginPass) return;
    loginUser.value = role;
    if (role === 'customer') {
        loginPass.value = '123456';
        doLogin();
        return;
    }
    loginPass.focus();
}

function openEmployeeLogin() {
    const loginPage = document.getElementById('loginPage');
    const app = document.getElementById('app');
    if (loginPage) {
        loginPage.classList.add('active');
        loginPage.style.display = 'flex';
    }
    if (app) app.style.display = 'none';
    document.getElementById('loginUser')?.focus();
}

// ============================================================
// LOGIN
// ============================================================
function doLogin() {
    const u = cleanText(document.getElementById('loginUser')?.value, 80).toLowerCase();
    const p = document.getElementById('loginPass')?.value || '';
    if (hasSqlInjectionPattern(u) || hasSqlInjectionPattern(p)) {
        playError();
        showNotif('error', 'Xavfsizlik!', 'Login ma\'lumotlarida shubhali belgilar topildi');
        return;
    }
    const user = USERS.find(x => ['admin', 'cashier', 'manager', 'customer'].includes(x.role) && x.login === u && x.passHash === btoa(p));
    if (!user) { playError(); showNotif('error', 'Xato!', 'Login yoki parol noto\'g\'ri'); return; }

    currentUser = user;
    const loginPage = document.getElementById('loginPage');
    const app = document.getElementById('app');
    if (loginPage) {
        loginPage.classList.remove('active');
        loginPage.style.display = 'none';
    }
    if (app) {
        app.style.display = 'block';
        app.classList.toggle('market-mode', user.role === 'customer');
    }

    document.getElementById('sideUser').textContent = user.name;
    document.getElementById('sideRole').textContent = ROLES[user.role];
    const av = document.getElementById('sideAvatar');
    av.textContent = user.name[0];
    av.style.background = `linear-gradient(135deg,${user.color},#10B981)`;

    addLog('Kirish', `${user.name} tizimga kirdi`);
    initApp();
    playSuccess();
    showNotif('success', 'Xush kelibsiz! 👋', user.name + ' — ' + ROLES[user.role]);
}

function doLogout() {
    const user = currentUser;
    if (user && !confirm('Tizimdan chiqmoqchimisiz?')) return;
    if (user) addLog('Chiqish', `${user.name} tizimdan chiqdi`);
    currentUser = null; cart = []; shopCart = [];

    const loginPage = document.getElementById('loginPage');
    const app = document.getElementById('app');
    if (loginPage) {
        loginPage.classList.remove('active');
        loginPage.style.display = 'none';
    }
    if (app) {
        app.style.display = 'block';
        app.classList.add('market-mode');
    }

    const loginUser = document.getElementById('loginUser');
    const loginPass = document.getElementById('loginPass');
    if (loginUser) loginUser.value = '';
    if (loginPass) {
        loginPass.value = '';
        loginPass.type = 'password';
    }
    const toggleIcon = document.querySelector('#loginPage .pass-toggle i');
    if (toggleIcon) toggleIcon.className = 'fas fa-eye';
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    goTo('page-shop', document.getElementById('nav-shop'));
    setupRoleBasedNav();
}

// ============================================================
// INIT
// ============================================================
function initApp() {
    setupRoleBasedNav();
    initClock();
    loadDashboard();
    loadPOS();
    renderShop();
    renderProducts();
    renderCustomers();
    renderEmployees();
    renderSMS();
    renderLogs();
    renderReports();
    updateCustomerDropdown();
    document.getElementById('rDate').textContent = new Date().toLocaleDateString('uz-UZ');
    // Reveal functionality removed for classic tab behavior
    // Init salary module
    SalaryModule.init();
}

function showLoginScreen() {
    currentUser = null;
    const loginPage = document.getElementById('loginPage');
    const app = document.getElementById('app');

    if (loginPage) {
        loginPage.classList.add('active');
        loginPage.style.display = 'flex';
    }
    if (app) app.style.display = 'none';
}

// ============================================================
// ROLE-BASED NAVIGATION
// ============================================================
function setupRoleBasedNav() {
    const role = currentUser?.role || 'guest';
    document.querySelectorAll('.nav-item, .nav-section').forEach(el => {
        const raw = el.getAttribute('data-role') || 'admin,cashier,manager';
        const roles = raw.split(',').map(r => r.trim()).filter(Boolean);
        const visible = roles.includes(role) || roles.includes('all');
        if (visible) {
            el.classList.add('visible');
            el.style.display = '';
        } else {
            el.classList.remove('visible');
            el.style.display = 'none';
        }
    });

    const visibleItems = Array.from(document.querySelectorAll('.nav-item.visible'));
    if (visibleItems.length > 0) {
        visibleItems[0].classList.add('active');
    }
}

// ============================================================
// CLOCK
// ============================================================
function initClock() {
    const tick = () => {
        const now = new Date();
        document.getElementById('clock').textContent = now.toLocaleTimeString('uz-UZ');
    };
    tick();
    setInterval(tick, 1000);
}

// ============================================================
// NAVIGATION
// ============================================================
/*
  goTo(page, el)
  - page: navigatsiyadan kelgan kalit (masalan: 'sms', 'employees', 'pos')
  - el: agar mavjud bo'lsa, bosilgan nav-element (DOM node)

  Ushbu funksiya bir nechta strategiyalar orqali maqsad bo'limni topadi:
  1) "page-<key>" ko'rinishidagi ID
  2) to'g'ridan-to'g'ri <key> IDsi
  3) kichik harflarga o'tkazilgan va bo'shliqlar '-' ga o'zgartirilgan ID
  4) fallback: DOMda id ichida kalit so'zni o'z ichiga olgan birinchi element
  Topilgach `scrollIntoView({behavior:'smooth', block:'start'})` chaqiriladi.
*/
/*
  goTo(pageId, el) — qat'iy tab toggling
  - pageId: aniq element ID bo'lishi kerak (masalan: 'page-pos', 'page-dashboard')
  - el: bosilgan nav element (optional)

  Qoidalar:
  - Barcha `.page` dan `.active` olib tashlanadi
  - Agar `document.getElementById(pageId)` topilsa, faqat shu elementga `.active` qo'yiladi
  - Agar element topilmasa, hech narsa ochilmaydi (xatolik konsolga chiqadi)
  - Chart.js diagrammalarini moslashtirish uchun resize/update chaqiriladi
*/
function goTo(pageId, el) {
    if (!canAccessPage(pageId)) {
        playError();
        showNotif('error', 'Ruxsat yo\'q!', 'Bu sahifaga kirish huquqingiz yo\'q');
        return;
    }
    // 1) barcha page larni yopamiz
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    // 2) qat'iy ID tekshiruvi
    const target = document.getElementById(pageId);
    if (!target) {
        console.warn(`goTo: element topilmadi -> ${pageId}`);
        return;
    }

    // 3) faqat shu bo'limni ko'rsatamiz
    target.classList.add('active');

    // 4) sidebar nav holatini yangilaymiz
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (el) el.classList.add('active');

    // 5) sarlavha (title/subtitle) yangilash - key sifatida pageId dan qismini olamiz
    const key = pageId.replace(/^page-/, '');
    const titles = {
        dashboard: ['Dashboard', 'Xush kelibsiz, bugun ham yaxshi kun!'],
        shop: ['Do\'kon', 'Mahsulot tanlang va buyurtma bering'],
        pos: ['Kassa (POS)', "F2=To'lov | Esc=Tozala | F3=Kassa | F8=Chek"],
        products: ['Mahsulotlar', "Qo'shish, tahrirlash, o'chirish"],
        customers: ['Mijozlar', "Mijozlar ma'lumotlari"],
        employees: ['Xodimlar', "Xodimlar boshqaruvi"],
        salary: ['Oylik Maosh', "To'lov jadvali va holat nazorati"],
        reports: ['Hisobotlar', 'Savdo tahlili'],
        sms: ['SMS Tizimi', 'Mijozlarga SMS yuborish'],
        logs: ['Faollik Loglari', 'Barcha amallar tarixi'],
        settings: ['Sozlamalar', 'Tizim sozlamalari'],
    };
    if (titles[key]) {
        const t = document.getElementById('pageTitle');
        const st = document.getElementById('pageSubtitle');
        if (t) t.textContent = titles[key][0];
        if (st) st.textContent = titles[key][1];
    }

    // 6) chart va layout moslashuvlari
    // Agar sahifa grafiklarni o'z ichiga olsa, kerakli init/update funksiyalarni chaqiramiz
    try {
        // Mashhur chart init funksiyalarini sahifa ochilganda chaqiramiz (agar mavjud bo'lsa)
        if (key === 'reports') {
            if (typeof initMonthChart === 'function') initMonthChart();
            if (typeof initIncomeChart === 'function') initIncomeChart();
        }
        if (key === 'customers') {
            if (typeof initCustomerTypeChart === 'function') initCustomerTypeChart();
            if (typeof initPurchaseChart === 'function') initPurchaseChart();
        }
        if (key === 'salary') {
            if (typeof initSalaryHistoryChart === 'function') initSalaryHistoryChart();
            if (typeof SalaryModule !== 'undefined' && typeof SalaryModule.render === 'function') SalaryModule.render();
        }
    } catch (e) { console.warn('Chart init error', e); }

    // Chart.js uchun browser resize event yuboramiz, grafiklar adaptatsiya qilishi uchun
    setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 160);

    // 7) maxsus element fokuslari
    if (key === 'pos') document.getElementById('posSearch')?.focus();

    // 8) mobil qurilmalarda sidebarni yopish
    if (window.innerWidth < 900) document.getElementById('sidebar')?.classList.remove('open');
}

function canAccessPage(pageId) {
    if (!currentUser) return pageId === 'page-shop';
    const nav = Array.from(document.querySelectorAll('.nav-item')).find(item => {
        const handler = item.getAttribute('onclick') || '';
        return handler.includes(`'${pageId}'`) || handler.includes(`"${pageId}"`);
    });
    if (!nav) return true;
    const roles = (nav.getAttribute('data-role') || 'admin,cashier,manager').split(',').map(r => r.trim());
    return roles.includes(currentUser.role) || roles.includes('all');
}

function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.toggle('open');
}

// ============================================================
// SCROLL REVEAL HELPERS
// ============================================================
// Reveal helpers removed — tab-based UI restored.

// ============================================================
// THEME
// ============================================================
function syncThemeIcon() {
    const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const icon = document.getElementById('themeIcon');
    if (icon) icon.className = currentTheme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
}

function applySavedTheme() {
    const savedTheme = localStorage.getItem('tp_theme');
    const nextTheme = savedTheme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nextTheme);
    syncThemeIcon();
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('tp_theme', next);
    syncThemeIcon();
}

// ============================================================
// DASHBOARD
// ============================================================
function loadDashboard() {
    ['admin-dashboard', 'cashier-dashboard', 'manager-dashboard'].forEach(id => document.getElementById(id).style.display = 'none');
    const role = currentUser?.role || 'cashier';
    if (role === 'admin') { document.getElementById('admin-dashboard').style.display = 'block'; loadAdminDashboard(); }
    else if (role === 'cashier') { document.getElementById('cashier-dashboard').style.display = 'block'; loadCashierDashboard(); }
    else if (role === 'manager') { document.getElementById('manager-dashboard').style.display = 'block'; loadManagerDashboard(); }
    else if (role === 'customer') { goTo('page-shop', document.getElementById('nav-shop')); }
}

function loadAdminDashboard() {
    const today = new Date().toLocaleDateString('uz-UZ');
    const todaysSales = salesHistory.filter(s => s.date === today);
    const todaysTotal = todaysSales.reduce((a, b) => a + b.total, 0);
    const dSales = document.getElementById('d-sales');
    if (dSales) dSales.textContent = fmt(todaysTotal) + ' so\'m';
    const dOrders = document.getElementById('d-orders');
    if (dOrders) dOrders.textContent = todaysSales.length;
    const dProducts = document.getElementById('d-products');
    if (dProducts) dProducts.textContent = products.length;

    const tbody = document.getElementById('recentSales');
    if (tbody) {
        const recent = [...salesHistory].reverse().slice(0, 8);
        tbody.innerHTML = recent.map(s => `<tr>
      <td>#${String(s.id).padStart(4, '0')}</td>
      <td>${escapeHTML(s.customer || 'Noma\'lum')}</td>
      <td style="color:var(--accent);font-weight:700">${fmt(s.total)} so'm</td>
      <td><span class="badge badge-blue">${escapeHTML(s.pay)}</span></td>
      <td style="color:var(--muted);font-size:12px">${escapeHTML(s.time)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px">Hali sotuvlar yo\'q</td></tr>';
    }

    const topP = document.getElementById('topProducts');
    if (topP) {
        const topProds = [{ name: 'Samsung Muzlatgich', sales: 23, pct: 90 }, { name: 'LG Kir Mashinasi', sales: 18, pct: 70 }, { name: 'Artel Konditsioner', sales: 15, pct: 60 }, { name: 'Samsung TV', sales: 8, pct: 32 }, { name: 'Dyson Changyutgich', sales: 6, pct: 24 }];
        topP.innerHTML = topProds.map(p => `<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
        <span style="font-weight:600">${p.name}</span>
        <span style="color:var(--primary)">${p.sales} ta</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${p.pct}%;background:linear-gradient(90deg,var(--primary),var(--warning))"></div></div>
    </div>`).join('');
    }
    setTimeout(() => { initSalesChart(); initPayChart(); }, 100);
}

function loadCashierDashboard() {
    const today = new Date().toLocaleDateString('uz-UZ');
    const ts = salesHistory.filter(s => s.date === today && s.cashier === currentUser?.name);
    const total = ts.reduce((a, b) => a + b.total, 0);
    document.getElementById('d-sales-cashier').textContent = fmt(total) + ' so\'m';
    document.getElementById('d-orders-cashier').textContent = ts.length + ' ta';
    document.getElementById('d-avg-cashier').textContent = fmt(ts.length ? Math.round(total / ts.length) : 0) + ' so\'m';
    const tbody = document.getElementById('cashier-sales');
    tbody.innerHTML = ts.map(s => `<tr>
    <td>#${String(s.id).padStart(4, '0')}</td>
    <td style="font-size:12px">${escapeHTML(s.time)}</td>
    <td style="color:var(--primary);font-weight:700">${fmt(s.total)} so'm</td>
    <td><span class="badge badge-blue">${escapeHTML(s.pay)}</span></td>
  </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">Bugun savdo yo\'q</td></tr>';
}

function loadManagerDashboard() {
    const tbody = document.getElementById('manager-employees');
    const empData = [
        { name: 'Abdullayev Admin', sales: 89, total: 145000000, status: 'Aktiv' },
        { name: 'Karimov Kassir', sales: 47, total: 52000000, status: 'Aktiv' },
        { name: 'Toshmatov Menejer', sales: 0, total: 0, status: 'Aktiv' },
    ];
    tbody.innerHTML = empData.map((e, i) => `<tr>
    <td><strong>${i + 1}</strong></td><td>${e.name}</td><td>${e.sales}</td>
    <td>${fmt(e.total)} so'm</td>
    <td><span class="badge badge-green">${e.status}</span></td>
  </tr>`).join('');
}

// ============================================================
// CHARTS
// ============================================================
function initSalesChart() {
    const ctx = document.getElementById('salesChart'); if (!ctx) return;
    if (salesChart) salesChart.destroy();
    salesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Du', 'Se', 'Cho', 'Pa', 'Ju', 'Sh', 'Ya'],
            datasets: [{
                label: 'Savdo (mln so\'m)', data: [8.2, 12.5, 9.8, 15.3, 11.2, 18.4, 14.5],
                borderColor: '#ff6b35', backgroundColor: 'rgba(255,107,53,.1)', fill: true, tension: .4,
                pointBackgroundColor: '#ff6b35', pointRadius: 5, pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } }, y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } } }
        }
    });
}

function initPayChart() {
    const ctx = document.getElementById('payChart'); if (!ctx) return;
    if (payChart) payChart.destroy();
    // Real data from sales
    const totals = { naqd: 0, karta: 0, click: 0, kredit: 0, boshqa: 0 };
    salesHistory.forEach(s => {
        if (s.pay === 'Naqd') totals.naqd += s.total;
        else if (s.pay === 'Karta') totals.karta += s.total;
        else if (s.pay === 'Click') totals.click += s.total;
        else if (s.pay === 'Kredit') totals.kredit += s.total;
        else totals.boshqa += s.total;
    });
    const hasData = Object.values(totals).some(v => v > 0);
    payChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Naqd', 'Karta', 'Click', 'Kredit', 'Boshqa'],
            datasets: [{
                data: hasData ? [totals.naqd, totals.karta, totals.click, totals.kredit, totals.boshqa] : [35, 28, 20, 12, 5],
                backgroundColor: ['#ff6b35', '#10B981', '#2563EB', '#8B5CF6', '#F59E0B'], borderWidth: 0, borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: '#9CA3AF', padding: 16 } } }
        }
    });
}

function initMonthChart() {
    const ctx = document.getElementById('monthChart'); if (!ctx) return;
    if (monthChart) monthChart.destroy();
    monthChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyn'],
            datasets: [{
                label: 'Savdo (mln so\'m)', data: [45, 62, 38, 71, 55, 89],
                backgroundColor: 'rgba(255,107,53,.7)', borderRadius: 8
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } }, y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } } }
        }
    });
}

function initIncomeChart() {
    const ctx = document.getElementById('incomeChart'); if (!ctx) return;
    if (incomeChart) incomeChart.destroy();
    incomeChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyn'],
            datasets: [
                { label: 'Daromad', data: [45, 62, 38, 71, 55, 89], borderColor: '#10B981', tension: .4, fill: false, pointRadius: 4 },
                { label: 'Xarajat', data: [20, 25, 18, 30, 22, 35], borderColor: '#EF4444', tension: .4, fill: false, pointRadius: 4 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#9CA3AF' } } },
            scales: { x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } }, y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } } }
        }
    });
}

// Customer Charts
let customerTypeChart = null, purchaseChart = null;

function initCustomerTypeChart() {
    const ctx = document.getElementById('customerTypeChart'); if (!ctx) return;
    if (customerTypeChart) customerTypeChart.destroy();
    customerTypeChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Faol', 'VIP', 'Nofaol'],
            datasets: [{
                data: [89, 23, 12],
                backgroundColor: ['#10B981', '#F59E0B', '#EF4444'],
                borderWidth: 0,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#9CA3AF', padding: 16, font: { size: 13 } }
                }
            }
        }
    });
}

function initPurchaseChart() {
    const ctx = document.getElementById('purchaseChart'); if (!ctx) return;
    if (purchaseChart) purchaseChart.destroy();
    purchaseChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['1-5 M', '5-10 M', '10-20 M', '20-50 M', '50+ M'],
            datasets: [{
                label: 'Mijozlar soni',
                data: [34, 28, 31, 22, 9],
                backgroundColor: 'rgba(249,115,22,.8)',
                borderRadius: 6,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } },
                y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF' } }
            }
        }
    });
}

// ============================================================
// POS
// ============================================================
function debounce(fn, delay = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

let posFilter = '';
let posCat = '';
let shopFilter = '';
let shopCat = '';

function loadPOS() {
    renderCatTabs();
    renderProductGrid();
}

function renderCatTabs() {
    const cats = ['Barchasi', ...new Set(products.map(p => p.cat))];
    document.getElementById('catTabs').innerHTML = cats.map(c =>
        `<button class="cat-tab ${c === 'Barchasi' ? 'active' : ''}" onclick='filterCat(${JSON.stringify(c)}, this)'>${escapeHTML(c)}</button>`
    ).join('');
}

function filterCat(cat, el) {
    posCat = cat === 'Barchasi' ? '' : cat;
    document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    renderProductGrid();
}

function searchProducts(q) { posFilter = q; renderProductGrid(); }
const debouncedSearch = debounce(searchProducts, 300);
const debouncedSearchProducts = debouncedSearch;

function syncShopSearch(value) {
    const input = document.getElementById('shopSearch');
    if (input) input.value = value;
    renderShop();
}

function renderShop() {
    const grid = document.getElementById('shopProductGrid');
    const tabs = document.getElementById('shopCatTabs');
    if (!grid || !tabs) return;

    shopFilter = cleanText(document.getElementById('shopSearch')?.value || shopFilter, 80).toLowerCase();
    const cats = ['Barchasi', ...new Set(products.map(p => p.cat))];
    tabs.innerHTML = cats.map(c =>
        `<button class="cat-tab ${(!shopCat && c === 'Barchasi') || shopCat === c ? 'active' : ''}" onclick='filterShopCat(${JSON.stringify(c)}, this)'>${escapeHTML(c)}</button>`
    ).join('');

    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🧺', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Mikrotolqinli Pechlar': '📡', 'Aksessuarlar': '🔌' };
    const list = products.filter(p =>
        p.stock > 0 &&
        (!shopCat || p.cat === shopCat) &&
        (!shopFilter || p.name.toLowerCase().includes(shopFilter) || (p.barcode || '').includes(shopFilter))
    );

    grid.innerHTML = list.map(p => {
        const imgSrc = productImageSrc(p.img);
        return `
    <div class="product-card shop-product-card" onclick="addToShopCart(${p.id})">
      ${imgSrc
                ? `<img class="product-card-img" src="${escapeHTML(imgSrc)}" alt="${escapeHTML(p.name)}" onerror="this.parentNode.querySelector('.product-card-img-placeholder').style.display='flex';this.style.display='none'">`
                : ''}
      <div class="product-card-img-placeholder" style="${imgSrc ? 'display:none' : ''}">
        ${icons[p.cat] || '📦'}
      </div>
      <div class="product-card-body">
        <div class="product-card-name">${escapeHTML(p.name)}</div>
        <div class="product-card-price">${fmt(p.price)} so'm</div>
        <div class="product-card-stock">Qoldiq: <strong>${p.stock}</strong></div>
        <button type="button" class="product-add-btn" onclick="(event||window.event).stopPropagation(); addToShopCart(${p.id})">+</button>
      </div>
    </div>`;
    }).join('') || '<div style="text-align:center;padding:60px;color:var(--muted);grid-column:1/-1"><div style="font-size:48px;margin-bottom:16px;opacity:.3">🔍</div><p>Mahsulot topilmadi</p></div>';
    updateShopCart();
}

function filterShopCat(cat, el) {
    shopCat = cat === 'Barchasi' ? '' : cat;
    document.querySelectorAll('#shopCatTabs .cat-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    renderShop();
}

function addToShopCart(id) {
    const p = products.find(x => x.id === id);
    if (!p || p.stock <= 0) { playError(); showNotif('error', 'Xato!', 'Mahsulot qolmadi'); return; }
    const ex = shopCart.find(x => x.id === id);
    if (ex) {
        if (ex.qty >= p.stock) { playError(); showNotif('error', 'Yetarli emas!', 'Qoldiq tugadi'); return; }
        ex.qty++;
    } else {
        shopCart.push({ id: p.id, name: p.name, price: p.price, qty: 1, img: p.img, cat: p.cat });
    }
    updateShopCart();
    playSuccess();
    showNotif('success', 'Savatga qo\'shildi', p.name);
}

function changeShopQty(id, delta) {
    const item = shopCart.find(x => x.id === id);
    const product = products.find(x => x.id === id);
    if (!item || !product) return;
    item.qty += delta;
    if (item.qty <= 0) shopCart = shopCart.filter(x => x.id !== id);
    if (item.qty > product.stock) item.qty = product.stock;
    updateShopCart();
}

function clearShopCart() {
    shopCart = [];
    updateShopCart();
    showNotif('info', 'Savat tozalandi', 'Barcha mahsulotlar olib tashlandi');
}

function updateShopCart() {
    const box = document.getElementById('shopCartItems');
    if (!box) return;
    const count = shopCart.reduce((s, x) => s + x.qty, 0);
    const total = shopCart.reduce((s, x) => s + x.price * x.qty, 0);
    const countEl = document.getElementById('shopCartCount');
    const totalEl = document.getElementById('shopCartTotal');
    if (countEl) countEl.textContent = count + ' ta mahsulot';
    if (totalEl) totalEl.textContent = fmt(total) + ' so\'m';

    if (!shopCart.length) {
        box.innerHTML = '<div class="cart-empty"><i class="fas fa-shopping-basket"></i><p>Savat bo\'sh</p></div>';
        return;
    }

    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🧺', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Aksessuarlar': '🔌' };
    box.innerHTML = shopCart.map(item => {
        const imgSrc = productImageSrc(item.img);
        return `
    <div class="cart-item">
      ${imgSrc ? `<img class="cart-item-img" src="${escapeHTML(imgSrc)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" alt="">` : ''}
      <div class="cart-item-img" style="display:${imgSrc ? 'none' : 'flex'};align-items:center;justify-content:center;font-size:22px;background:var(--border)">${icons[item.cat] || '📦'}</div>
      <div class="cart-item-info">
        <div class="cart-item-name">${escapeHTML(item.name)}</div>
        <div class="cart-item-price">${fmt(item.price)} so'm/dona</div>
      </div>
      <div class="cart-qty">
        <button class="qty-btn" onclick="changeShopQty(${item.id},-1)">−</button>
        <span class="qty-num">${item.qty}</span>
        <button class="qty-btn" onclick="changeShopQty(${item.id},1)">+</button>
      </div>
    </div>`;
    }).join('');
}

function checkoutShopOrder() {
    if (!shopCart.length) { playError(); showNotif('error', 'Savat bo\'sh!', 'Mahsulot tanlang'); return; }

    const subtotal = shopCart.reduce((s, x) => s + x.price * x.qty, 0);
    const payLabels = { click: 'Click', card: 'Karta', cash: 'Naqd' };
    const selectedPay = document.getElementById('shopPayType')?.value || 'click';
    const saleId = salesHistory.length + 1;
    const sale = {
        id: saleId,
        items: JSON.parse(JSON.stringify(shopCart)),
        subtotal,
        disc: 0,
        discAmt: 0,
        total: subtotal,
        pay: payLabels[selectedPay] || 'Click',
        time: new Date().toLocaleTimeString('uz-UZ'),
        date: new Date().toLocaleDateString('uz-UZ'),
        cashier: 'Online do\'kon',
        customer: currentUser?.role === 'customer' ? currentUser.name : 'Online xaridor',
        customerId: null,
    };

    shopCart.forEach(ci => {
        const p = products.find(x => x.id === ci.id);
        if (p) p.stock = Math.max(0, p.stock - ci.qty);
    });
    salesHistory.push(sale);
    lastCheckoutSale = sale;
    saveToStorage();
    addLog('Online buyurtma', `#${saleId} — ${fmt(subtotal)} so'm (${sale.pay})`);
    shopCart = [];
    renderShop();
    renderProducts();
    renderProductGrid();
    renderReceipt(sale);
    openModal('checkoutModal');
    playCheckout();
    showNotif('success', 'Buyurtma qabul qilindi!', `${fmt(subtotal)} so'm — ${sale.pay}`);
}

function renderProductGrid() {
    const q = cleanText(posFilter, 80).toLowerCase();
    const list = products.filter(p =>
        (!posCat || p.cat === posCat) &&
        (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q))
    );
    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🫧', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Mikrotolqinli Pechlar': '📡', 'Aksessuarlar': '🔌' };
    document.getElementById('productGrid').innerHTML = list.map(p => {
        const imgSrc = productImageSrc(p.img);
        return `
    <div class="product-card" onclick="addToCart(${p.id})">
      ${imgSrc
            ? `<img class="product-card-img" src="${escapeHTML(imgSrc)}" alt="${escapeHTML(p.name)}" onerror="this.parentNode.querySelector('.product-card-img-placeholder').style.display='flex';this.style.display='none'">`
            : ''}
      <div class="product-card-img-placeholder" style="${imgSrc ? 'display:none' : ''}">
        ${icons[p.cat] || '📦'}
      </div>
      <div class="product-card-body">
        <div class="product-card-name">${escapeHTML(p.name)}</div>
        <div class="product-card-price">${fmt(p.price)} so'm</div>
        <div class="product-card-stock" style="${p.stock < 5 ? 'color:var(--danger)' : ''}">
          ${p.stock < 5 ? '⚠️ ' : ''}Qoldiq: <strong>${p.stock}</strong>
        </div>
        <button type="button" class="product-add-btn" onclick="(event||window.event).stopPropagation(); addToCart(${p.id})">+</button>
      </div>
    </div>
  `;
    }).join('') || '<div style="text-align:center;padding:60px;color:var(--muted);grid-column:1/-1"><div style="font-size:48px;margin-bottom:16px;opacity:.3">🔍</div><p>Mahsulot topilmadi</p></div>';
}

function updateCustomerDropdown() {
    const sel = document.getElementById('cartCustomer');
    if (!sel) return;
    sel.innerHTML = '<option value="">Mijoz tanlanmagan</option>' +
        customers.map(c => `<option value="${Number(c.id)}">${escapeHTML(c.name)} (${escapeHTML(c.phone)})</option>`).join('');
}

function addToCartWithEvent(event, id) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    addToCart(id);
}

function openProductModalWithEvent(event, id) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    openProductModal(id);
}

function deleteProductWithEvent(event, id) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    deleteProduct(id);
}

function addToCart(id, isScan = false) {
    const p = products.find(x => x.id === id);
    if (!p || p.stock <= 0) { playError(); showNotif('error', 'Xato!', 'Mahsulot qolmadi'); return; }
    const ex = cart.find(x => x.id === id);
    if (ex) {
        if (ex.qty >= p.stock) { playError(); showNotif('error', 'Yetarli emas!', 'Qoldiq tugadi'); return; }
        ex.qty++;
    } else {
        cart.push({ id: p.id, name: p.name, price: p.price, qty: 1, img: p.img, cat: p.cat });
    }
    updateCart();
    if (isScan) playScan(); else playSuccess();
    showNotif('success', isScan ? '📷 Skanerlandi!' : '✅ Qo\'shildi!', p.name + ' — ' + fmt(p.price) + ' so\'m');
}

function removeFromCart(id) {
    cart = cart.filter(x => x.id !== id);
    updateCart();
}

function changeQty(id, delta) {
    const item = cart.find(x => x.id === id);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) removeFromCart(id);
    else updateCart();
}

function updateCart() {
    const disc = Math.min(100, Math.max(0, parseFloat(document.getElementById('discountInput')?.value) || 0));
    const TAX_RATE = parseFloat(document.getElementById('taxRate')?.value || 12) / 100;
    const subtotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
    const taxAmt = subtotal * TAX_RATE;
    const discAmt = subtotal * disc / 100;
    const total = subtotal - discAmt; // tax is included in price (display only)

    const cartCount = document.getElementById('cartCount');
    const cartSubtotal = document.getElementById('cartSubtotal');
    const cartTax = document.getElementById('cartTax');
    const cartDiscountShow = document.getElementById('cartDiscountShow');
    const cartTotal = document.getElementById('cartTotal');

    const totalItems = cart.reduce((s, x) => s + x.qty, 0);
    if (cartCount) cartCount.textContent = totalItems + ' ta mahsulot';
    if (cartSubtotal) cartSubtotal.textContent = fmt(subtotal) + ' so\'m';
    if (cartTax) cartTax.textContent = fmt(taxAmt) + ' so\'m';
    if (cartDiscountShow) cartDiscountShow.textContent = '-' + fmt(discAmt) + ' so\'m';
    if (cartTotal) cartTotal.textContent = fmt(total) + ' so\'m';

    const container = document.getElementById('cartItems');
    if (!container) return;
    if (cart.length === 0) {
        container.innerHTML = '<div class="cart-empty"><i class="fas fa-shopping-basket"></i><p>Savat bo\'sh</p><small style="font-size:11px;margin-top:4px">F3 — Kassaga o\'tish</small></div>';
        return;
    }

    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🫧', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Aksessuarlar': '🔌' };
    container.innerHTML = cart.map(item => {
        const imgSrc = productImageSrc(item.img);
        return `
    <div class="cart-item">
      ${imgSrc
            ? `<img class="cart-item-img" src="${escapeHTML(imgSrc)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" alt="">`
            : ''}
      <div class="cart-item-img" style="display:${imgSrc ? 'none' : 'flex'};align-items:center;justify-content:center;font-size:22px;background:var(--border)">${icons[item.cat] || '📦'}</div>
      <div class="cart-item-info">
        <div class="cart-item-name">${escapeHTML(item.name)}</div>
        <div class="cart-item-price">${fmt(item.price)} so'm/dona</div>
      </div>
      <div class="cart-qty">
        <button class="qty-btn" onclick="changeQty(${item.id},-1)">−</button>
        <span class="qty-num">${item.qty}</span>
        <button class="qty-btn" onclick="changeQty(${item.id},1)">+</button>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <div class="cart-item-total">${fmt(item.price * item.qty)}</div>
        <button class="cart-item-del" onclick="removeFromCart(${item.id})"><i class="fas fa-times"></i></button>
      </div>
    </div>
  `;
    }).join('');
    // Animate newest item
    const items = container.querySelectorAll('.cart-item');
    if (items.length) items[items.length - 1].classList.add('cart-item-new');
    // Update credit calculations if credit panel is visible
    try { updateCreditCalculations(); } catch (e) { }
}

// ===== Kredit (Muddatli to'lov) hisoblashlari =====
function updateCreditCalculations() {
    const panel = document.getElementById('creditPanel');
    if (!panel) return;
    // Compute subtotal and discount similar to updateCart
    const subtotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
    const disc = Math.min(100, Math.max(0, parseFloat(document.getElementById('discountInput')?.value) || 0));
    const discAmt = subtotal * disc / 100;
    const totalAfterDisc = Math.max(0, subtotal - discAmt);

    const downInput = document.getElementById('creditDown');
    const monthsSel = document.getElementById('creditMonths');
    const remainingEl = document.getElementById('creditRemaining');
    const monthlyEl = document.getElementById('creditMonthly');
    if (!downInput || !monthsSel || !remainingEl || !monthlyEl) return;

    let down = parseFloat(downInput.value) || 0;
    if (down < 0) down = 0;
    if (down > totalAfterDisc) down = totalAfterDisc;
    // Update input if clamped
    downInput.value = Math.round(down);

    const remaining = Math.max(0, totalAfterDisc - down);
    const months = parseInt(monthsSel.value) || 3;
    const monthly = months > 0 ? Math.ceil(remaining / months) : remaining;

    remainingEl.textContent = fmt(remaining) + " so'm";
    monthlyEl.textContent = fmt(monthly) + " so'm / oy";
}

function clearCart() {
    cart = [];
    const di = document.getElementById('discountInput');
    if (di) di.value = '';
    updateCart();
    showNotif('info', 'Savat tozalandi', 'Barcha mahsulotlar o\'chirildi');
}

function setPayType(t, el) {
    payType = t;
    document.querySelectorAll('.pay-type').forEach(x => x.classList.remove('active'));
    if (el) el.classList.add('active');
    // Show/hide credit panel when Kredit selected
    const panel = document.getElementById('creditPanel');
    if (panel) {
        if (t === 'credit') { panel.style.display = 'block'; panel.classList.add('open'); }
        else { panel.style.display = 'none'; panel.classList.remove('open'); }
    }
    // Recalculate credit values when switching
    try { updateCreditCalculations(); } catch (e) { }
}

function checkout() {
    if (!requireRole('admin', 'cashier', 'manager')) return;
    if (cart.length === 0) { playError(); showNotif('error', 'Savat bo\'sh!', 'Mahsulot qo\'shing'); return; }
    const disc = parseFloat(document.getElementById('discountInput')?.value) || 0;
    const subtotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
    const discAmt = subtotal * disc / 100;
    const total = subtotal - discAmt;
    const payLabels = { cash: 'Naqd', card: 'Karta', click: 'Click', credit: 'Kredit', transfer: 'O\'tkazma' };

    // Get selected customer
    const custSel = document.getElementById('cartCustomer');
    const custId = custSel ? parseInt(custSel.value) : null;
    const cust = customers.find(c => c.id === custId);

    const saleId = salesHistory.length + 1;
    const sale = {
        id: saleId, items: JSON.parse(JSON.stringify(cart)),
        subtotal, disc, discAmt, total,
        pay: payLabels[payType],
        time: new Date().toLocaleTimeString('uz-UZ'),
        date: new Date().toLocaleDateString('uz-UZ'),
        cashier: currentUser?.name || 'Noma\'lum',
        customer: cust?.name || 'Noma\'lum',
        customerId: custId || null,
    };
    salesHistory.push(sale);
    lastCheckoutSale = sale;

    // Update stock
    cart.forEach(ci => {
        const p = products.find(x => x.id === ci.id);
        if (p) p.stock = Math.max(0, p.stock - ci.qty);
    });

    // Update customer bonus
    if (cust) {
        cust.orders++;
        cust.total += total;
        cust.bonus += Math.floor(total / 10000);
    }

    saveToStorage();
    addLog('Savdo', `Chek #${saleId} — ${fmt(total)} so'm (${payLabels[payType]})`);
    playCheckout();
    renderReceipt(sale);
    openModal('checkoutModal');
    clearCart();
    loadDashboard();
    renderProductGrid();
    if (document.getElementById('autoPrint')?.checked) setTimeout(printReceipt, 500);
    showNotif('success', '✅ To\'lov amalga oshirildi!', `${fmt(total)} so'm — ${payLabels[payType]}`);
}

function renderReceipt(sale) {
    const items = sale.items.map(i =>
        `<div class="r-row"><span>${escapeHTML(i.name)} x${i.qty}</span><span>${fmt(i.price * i.qty)}</span></div>`
    ).join('');
    const html = `
    <div class="payment-success">
      <div class="success-icon">✓</div>
      <h2>To'lov Qabul Qilindi!</h2>
      <p>${escapeHTML(sale.cashier)} tomonidan — ${sale.time}</p>
      <div class="payment-amount">${fmt(sale.total)} so'm</div>
    </div>
    <div class="receipt" id="receiptForPrint">
      <h2>TEHNO PARK</h2>
      <div class="r-center">Chilonzor 12, Toshkent<br>+998 90 123 45 67<br>www.tehnopark.uz</div>
      <hr>
      <div class="r-row"><span>Chek #:</span><span>${String(sale.id).padStart(5, '0')}</span></div>
      <div class="r-row"><span>Sana:</span><span>${sale.date}</span></div>
      <div class="r-row"><span>Vaqt:</span><span>${sale.time}</span></div>
      <div class="r-row"><span>Kassir:</span><span>${escapeHTML(sale.cashier)}</span></div>
      <div class="r-row"><span>Mijoz:</span><span>${escapeHTML(sale.customer)}</span></div>
      <hr>
      ${items}
      <hr>
      <div class="r-row"><span>Jami:</span><span>${fmt(sale.subtotal)}</span></div>
      ${sale.disc > 0 ? `<div class="r-row"><span>Chegirma (${sale.disc}%):</span><span>-${fmt(sale.discAmt)}</span></div>` : ''}
      <div class="r-row r-total"><span>TO'LOV:</span><span>${fmt(sale.total)} so'm</span></div>
      <div class="r-row"><span>To'lov turi:</span><span>${sale.pay}</span></div>
      <div class="r-barcode">||| ${String(sale.id).padStart(8, '0')} |||</div>
      <hr>
      <div class="r-center">Rahmat xarid uchun! 🙏<br>⭐⭐⭐⭐⭐</div>
    </div>`;
    document.getElementById('receiptContent').innerHTML = html;
    // Also put in printArea
    document.getElementById('printArea').innerHTML = `<div class="receipt">${document.getElementById('receiptForPrint')?.innerHTML || ''}</div>`;
}

function printReceipt() {
    if (lastCheckoutSale) {
        document.getElementById('printArea').style.display = 'block';
        window.print();
        document.getElementById('printArea').style.display = 'none';
    } else {
        window.print();
    }
}

function newSale() {
    goTo('page-pos', document.getElementById('navPos'));
    document.getElementById('posSearch').focus();
}

// ============================================================
// PRODUCTS PAGE
// ============================================================
let currentCategory = '', productFilter2 = '';

function renderProducts() {
    const cats = [...new Set(products.map(p => p.cat))];
    const sel = document.getElementById('catFilter');
    if (sel) sel.innerHTML = '<option value="">Barcha</option>' + cats.map(c => `<option>${escapeHTML(c)}</option>`).join('');
    const cnt = document.getElementById('productCount');
    const list = products.filter(p =>
        (!currentCategory || p.cat === currentCategory) &&
        (!productFilter2 || p.name.toLowerCase().includes(productFilter2.toLowerCase()))
    );
    if (cnt) cnt.textContent = list.length;
    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🫧', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Aksessuarlar': '🔌' };
    document.getElementById('productsTable').innerHTML = list.map(p => {
        const imgSrc = productImageSrc(p.img);
        return `<tr>
    <td>
      ${imgSrc
            ? `<img src="${escapeHTML(imgSrc)}" style="width:46px;height:36px;border-radius:8px;object-fit:cover;background:var(--border)" onerror="this.style.display='none'">`
            : `<div style="width:46px;height:36px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:20px">${icons[p.cat] || '📦'}</div>`}
    </td>
    <td><strong>${escapeHTML(p.name)}</strong><br><small style="color:var(--muted)">${escapeHTML(p.desc || '')}</small></td>
    <td><span class="badge badge-blue">${escapeHTML(p.cat)}</span></td>
    <td style="font-weight:700;color:var(--primary)">${fmt(p.price)} so'm</td>
    <td><span class="${p.stock < 5 ? 'badge badge-red' : 'badge badge-green'}">${p.stock} dona</span></td>
    <td><span class="badge ${p.stock > 0 ? 'badge-green' : 'badge-red'}">${p.stock > 0 ? 'Bor' : 'Tugagan'}</span></td>
    <td>
      <button class="btn btn-outline btn-sm" onclick="openProductModal(${p.id})"><i class="fas fa-edit"></i></button>
      <button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="deleteProduct(${p.id})"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`;
    }).join('');
}

function filterByCategory(val) { currentCategory = val; renderProducts(); }
function filterProducts(q) { productFilter2 = q; renderProducts(); }
const debouncedFilterProducts = debounce(filterProducts, 300);

function openProductModal(id) {
    if (!requireRole('admin')) return;
    editingProductId = id || null;
    document.getElementById('productModalTitle').textContent = id ? 'Mahsulotni Tahrirlash' : 'Yangi Mahsulot';
    if (id) {
        const p = products.find(x => x.id === id);
        if (p) {
            document.getElementById('p-name').value = p.name;
            document.getElementById('p-cat').value = p.cat;
            document.getElementById('p-price').value = p.price;
            document.getElementById('p-stock').value = p.stock;
            document.getElementById('p-img').value = p.img || '';
            document.getElementById('p-desc').value = p.desc || '';
            document.getElementById('p-barcode').value = p.barcode || '';
        }
    } else {
        ['p-name', 'p-price', 'p-stock', 'p-img', 'p-desc', 'p-barcode'].forEach(i => document.getElementById(i).value = '');
    }
    openModal('productModal');
}

function saveProduct() {
    if (!requireRole('admin')) return;
    const name = validateSafeInput('Mahsulot nomi', document.getElementById('p-name').value, 120);
    const cat = validateSafeInput('Kategoriya', document.getElementById('p-cat').value, 80);
    const price = parseInt(document.getElementById('p-price').value) || 0;
    const stock = parseInt(document.getElementById('p-stock').value) || 0;
    const img = safeImageUrl(document.getElementById('p-img').value);
    const desc = validateSafeInput('Tavsif', document.getElementById('p-desc').value, 300);
    const barcode = validateSafeInput('Barkod', document.getElementById('p-barcode').value, 64);
    if (name === null || cat === null || desc === null || barcode === null) return;
    if (!name || !price) { playError(); showNotif('error', 'Xato!', 'Nomi va narxi to\'ldiring'); return; }
    if (editingProductId) {
        const p = products.find(x => x.id === editingProductId);
        if (p) Object.assign(p, { name, cat, price, stock, img, desc, barcode });
        addLog('Mahsulot', `"${name}" tahrirlandi`);
        showNotif('success', 'Saqlandi!', 'Mahsulot yangilandi');
    } else {
        products.push({ id: Date.now(), name, cat, price, stock, img, desc, barcode });
        addLog('Mahsulot', `"${name}" qo'shildi`);
        showNotif('success', 'Qo\'shildi!', name + ' mahsulot qo\'shildi');
    }
    saveToStorage();
    closeModal('productModal');
    renderProducts();
    renderCatTabs();
    renderProductGrid();
}

function deleteProduct(id) {
    if (!requireRole('admin')) return;
    if (!confirm('Mahsulotni o\'chirishni xohlaysizmi?')) return;
    const p = products.find(x => x.id === id);
    products = products.filter(x => x.id !== id);
    saveToStorage();
    addLog('Mahsulot', `"${p?.name}" o'chirildi`);
    showNotif('info', 'O\'chirildi!', 'Mahsulot o\'chirildi');
    renderProducts();
    renderProductGrid();
}

// ============================================================
// CUSTOMERS
// ============================================================
let customerFilter = '';
function filterCustomers(q) { customerFilter = q; renderCustomers(); }
const debouncedFilterCustomers = debounce(filterCustomers, 300);

function renderCustomers() {
    const list = customers.filter(c =>
        !customerFilter || c.name.toLowerCase().includes(customerFilter.toLowerCase()) || c.phone.includes(customerFilter)
    );
    document.getElementById('customersTable').innerHTML = list.map(c => `<tr>
    <td>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="avatar" style="background:linear-gradient(135deg,var(--primary),var(--warning));color:white">${escapeHTML(c.name[0])}</div>
        <div><strong>${escapeHTML(c.name)}</strong><br><small style="color:var(--muted)">${escapeHTML(c.email || '')}</small></div>
      </div>
    </td>
    <td>${escapeHTML(c.phone)}</td>
    <td>${c.orders} marta</td>
    <td style="font-weight:700;color:var(--accent)">${fmt(c.total)} so'm</td>
    <td><span class="badge badge-yellow">${c.bonus} ball</span></td>
    <td><span class="badge ${c.status === 'vip' ? 'badge-yellow' : c.status === 'active' ? 'badge-green' : 'badge-red'}">${c.status === 'vip' ? '👑 VIP' : c.status === 'active' ? 'Faol' : 'Nofaol'}</span></td>
    <td>
      <button class="btn btn-outline btn-sm" onclick='sendSMSTo(${JSON.stringify(c.phone)}, ${JSON.stringify(c.name)})'><i class="fas fa-sms"></i></button>
      <button class="btn btn-outline btn-sm" style="margin-left:6px" onclick="deleteCustomer(${c.id})"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('');
}

function openCustomerModal() {
    if (!requireRole('admin', 'cashier')) return;
    openModal('customerModal');
}
function saveCustomer() {
    if (!requireRole('admin', 'cashier')) return;
    const name = validateSafeInput('Mijoz ismi', document.getElementById('c-name').value, 120);
    const phone = validateSafeInput('Telefon', document.getElementById('c-phone').value, 40);
    const email = validateSafeInput('Email', document.getElementById('c-email').value, 120);
    const addr = validateSafeInput('Manzil', document.getElementById('c-addr')?.value || '', 180);
    if (name === null || phone === null || email === null || addr === null) return;
    if (!name || !phone) { playError(); showNotif('error', 'Xato!', 'Ism va telefon majburiy'); return; }
    customers.push({ id: Date.now(), name, phone, email, addr, orders: 0, total: 0, bonus: 0, status: 'active' });
    saveToStorage();
    addLog('Mijoz', `"${name}" qo'shildi`);
    showNotif('success', 'Qo\'shildi!', name + ' mijoz qo\'shildi');
    closeModal('customerModal');
    renderCustomers();
    updateCustomerDropdown();
}

function deleteCustomer(id) {
    if (!requireRole('admin', 'cashier')) return;
    if (!confirm('Mijozni o\'chirmoqchimisiz?')) return;
    customers = customers.filter(x => x.id !== id);
    saveToStorage();
    renderCustomers();
    updateCustomerDropdown();
    showNotif('info', 'O\'chirildi!', 'Mijoz o\'chirildi');
}

function sendSMSTo(phone, name) {
    goTo('page-sms', document.querySelectorAll('.nav-item')[8]);
    setTimeout(() => {
        const t = document.getElementById('smsText');
        if (t) { t.value = `Hurmatli ${name}! `; t.focus(); }
    }, 300);
    showNotif('info', 'SMS', 'SMS bo\'limiga o\'tildi');
}

// ============================================================
// EMPLOYEES
// ============================================================
function renderEmployees() {
    document.getElementById('employeesTable').innerHTML = employees.map(e => `<tr>
    <td>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="avatar" style="background:linear-gradient(135deg,#8B5CF6,#EC4899);color:white">${escapeHTML(e.name[0])}</div>
        <strong>${escapeHTML(e.name)}</strong>
      </div>
    </td>
    <td><span class="badge badge-blue">${escapeHTML(ROLES[e.role])}</span></td>
    <td>${e.sales} ta</td>
    <td>
      <div style="margin-bottom:4px;font-weight:700">${fmt(e.total)} so'm</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(e.total / 2000000, 100)}%;background:linear-gradient(90deg,var(--primary),var(--warning))"></div></div>
    </td>
    <td>${escapeHTML(e.login)}</td>
    <td><span class="badge badge-green">Aktiv</span></td>
  </tr>`).join('');
}
function openEmployeeModal() {
    if (!requireRole('admin', 'manager')) return;
    SalaryModule.openAddModal('Yangi Xodim');
}

// ============================================================
// REPORTS
// ============================================================
function renderReports() {
    renderEmployeeRank();
    setTimeout(() => { initMonthChart(); initIncomeChart(); }, 50);
}

function renderEmployeeRank() {
    const ranked = [...employees].sort((a, b) => b.total - a.total);
    const el = document.getElementById('employeeRank');
    if (!el) return;
    el.innerHTML = ranked.map((e, i) => `<tr>
    <td><span style="font-weight:800;color:${i === 0 ? '#F59E0B' : i === 1 ? '#9CA3AF' : i === 2 ? '#CD7C2F' : 'var(--muted)'}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span></td>
    <td><div style="display:flex;align-items:center;gap:10px"><div class="avatar" style="background:linear-gradient(135deg,#8B5CF6,#EC4899);color:white">${escapeHTML(e.name[0])}</div>${escapeHTML(e.name)}</div></td>
    <td>${e.sales}</td>
    <td style="font-weight:700;color:var(--primary)">${fmt(e.total)} so'm</td>
    <td><div class="progress-bar" style="width:120px"><div class="progress-fill" style="width:${Math.min(100, e.total / 1500000)}%;background:var(--primary)"></div></div></td>
  </tr>`).join('');
}

function loadReport() { showNotif('info', 'Filtrlandi!', 'Hisobot yangilandi'); renderReports(); }
function exportReport(type) { showNotif('success', 'Export!', type.toUpperCase() + ' yuklanmoqda...'); }

// ============================================================
// SMS
// ============================================================
function renderSMS() {
    const tmpl = document.getElementById('smsTemplates');
    if (tmpl) tmpl.innerHTML = smsTemplates.map((t, i) => `
    <div class="sms-template" onclick="useSmsTemplate(${i})">
      <h4>${escapeHTML(t.title)}</h4>
      <p>${escapeHTML(t.text.substring(0, 60))}...</p>
    </div>`).join('');

    const cnt = document.getElementById('smsCount');
    const txt = document.getElementById('smsText');
    if (txt && cnt) {
        txt.addEventListener('input', function () {
            cnt.textContent = this.value.length + '/160 belgi';
            cnt.style.color = this.value.length > 140 ? 'var(--danger)' : 'var(--muted)';
        });
    }

    const hist = document.getElementById('smsHistory');
    if (hist) hist.innerHTML = [
        { time: '10:30', to: 'Barcha Mijozlar (124)', text: 'Chegirma kampaniyasi boshlandi...', status: 'yuborildi' },
        { time: '09:15', to: 'VIP Mijozlar (23)', text: 'Samsung TV\'da 15% chegirma...', status: 'yuborildi' },
        { time: 'Kecha', to: 'Malika Yusupova', text: 'Xarid uchun rahmat...', status: 'yuborildi' },
    ].map(s => `<tr>
    <td style="color:var(--muted);font-size:12px">${s.time}</td>
    <td>${s.to}</td>
    <td style="font-size:12px;color:var(--muted)">${s.text}</td>
    <td><span class="badge badge-green">${s.status}</span></td>
  </tr>`).join('');
}

function useSmsTemplate(i) {
    document.querySelectorAll('.sms-template').forEach(t => t.classList.remove('selected'));
    document.querySelectorAll('.sms-template')[i]?.classList.add('selected');
    const txt = document.getElementById('smsText');
    const cnt = document.getElementById('smsCount');
    if (txt) { txt.value = smsTemplates[i].text; if (cnt) cnt.textContent = smsTemplates[i].text.length + '/160 belgi'; }
}

function sendSMS() {
    if (currentUser?.role !== 'admin') { playError(); showNotif('error', 'Xato!', 'Faqat Administrator SMS yuborishi mumkin'); return; }
    const text = validateSafeInput('SMS matni', document.getElementById('smsText')?.value || '', 160);
    const to = cleanText(document.getElementById('smsTo')?.options[document.getElementById('smsTo').selectedIndex].text, 120);
    if (text === null) return;
    if (!text) { playError(); showNotif('error', 'Xato!', 'SMS matni yozing'); return; }
    if (text.length > 160) { playError(); showNotif('error', 'Xato!', 'SMS 160 belgidan oshib ketdi'); return; }
    addLog('SMS', `SMS yuborildi: ${to} | "${text.substring(0, 40)}..."`);
    playSuccess();
    showNotif('success', 'SMS Yuborildi! ✓', `${to} ga SMS muvaffaqiyatli yuborildi`);
    document.getElementById('smsText').value = '';
    document.getElementById('smsCount').textContent = '0/160 belgi';
    document.querySelectorAll('.sms-template').forEach(t => t.classList.remove('selected'));
}

// ============================================================
// LOGS
// ============================================================
function addLog(action, detail) {
    logs.unshift({
        time: new Date().toLocaleTimeString('uz-UZ'),
        user: cleanText(currentUser?.name || 'Tizim', 120),
        action: cleanText(action, 80),
        detail: cleanText(detail, 240)
    });
    if (logs.length > 200) logs.pop();
    localStorage.setItem('tp_logs', JSON.stringify(logs));
    const logsTable = document.getElementById('logsTable');
    if (logsTable) renderLogs();
}

function renderLogs() {
    const el = document.getElementById('logsTable');
    if (!el) return;
    el.innerHTML = logs.slice(0, 50).map(l => `<tr>
    <td style="color:var(--muted);font-size:12px;white-space:nowrap">${escapeHTML(l.time)}</td>
    <td><span class="badge badge-blue">${escapeHTML(l.user)}</span></td>
    <td><strong>${escapeHTML(l.action)}</strong></td>
    <td style="color:var(--muted);font-size:13px">${escapeHTML(l.detail)}</td>
  </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--muted)">Log yo\'q</td></tr>';
}

function clearLogs() {
    if (!requireRole('admin')) return;
    if (!confirm('Barcha loglarni tozalash?')) return;
    logs = [];
    localStorage.removeItem('tp_logs');
    renderLogs();
    showNotif('info', 'Tozalandi', 'Loglar o\'chirildi');
}

// ============================================================
// SETTINGS
// ============================================================
function showTab(id, el) {
    ['tab-company', 'tab-system', 'tab-sms', 'tab-receipt'].forEach(t => {
        const el2 = document.getElementById(t);
        if (el2) el2.style.display = 'none';
    });
    const tab = document.getElementById(id);
    if (tab) tab.style.display = 'block';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
}

function saveSettings() {
    if (!requireRole('admin')) return;
    addLog('Sozlama', 'Tizim sozlamalari saqlandi');
    playSuccess();
    showNotif('success', 'Saqlandi!', 'Sozlamalar muvaffaqiyatli saqlandi');
}

function exportData() {
    if (!requireRole('admin')) return;
    const data = {
        products, customers, salesHistory, logs,
        exportDate: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TehnoPark_Backup_${new Date().toLocaleDateString('uz-UZ').replace(/\//g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showNotif('success', 'Eksport!', 'Ma\'lumotlar muvaffaqiyatli yuklandi');
}

function importData(input) {
    if (!requireRole('admin')) return;
    if (!input.files || !input.files[0]) return;
    if (input.files[0].size > 2 * 1024 * 1024) {
        input.value = '';
        showNotif('error', 'Xato!', 'Backup fayl 2MB dan oshmasligi kerak');
        return;
    }
    if (!confirm('Diqqat! Joriy ma\'lumotlar fayldagi ma\'lumotlar bilan almashtiriladi. Davom etasizmi?')) {
        input.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = safeJsonParse(e.target.result, null);
            if (!data || typeof data !== 'object') throw new Error('Invalid backup');
            if (data.products) {
                if (!Array.isArray(data.products)) throw new Error('Invalid products');
                products = data.products.map(normalizeProduct).filter(p => p.name);
            }
            if (data.customers) {
                if (!Array.isArray(data.customers)) throw new Error('Invalid customers');
                customers = data.customers.map(normalizeCustomer).filter(c => c.name && c.phone);
            }
            if (data.salesHistory) salesHistory = Array.isArray(data.salesHistory) ? data.salesHistory : [];
            if (data.logs) logs = Array.isArray(data.logs) ? data.logs.map(l => ({
                time: cleanText(l?.time, 40),
                user: cleanText(l?.user, 120),
                action: cleanText(l?.action, 80),
                detail: cleanText(l?.detail, 240),
            })) : [];
            saveToStorage();
            alert("Ma'lumotlar muvaffaqiyatli tiklandi! Tizim qayta yuklanadi.");
            location.reload();
        } catch (err) {
            showNotif('error', 'Xato!', 'Fayl formati noto\'g\'ri');
        }
        input.value = '';
    };
    reader.readAsText(input.files[0]);
}

// ============================================================
// MODAL
// ============================================================
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

// ============================================================
// NOTIFICATIONS
// ============================================================
function showNotif(type, title, msg, options = {}) {
    const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle', warning: 'fa-exclamation-triangle' };
    const safeType = icons[type] ? type : 'info';
    const allowHTML = Boolean(options.allowHTML);
    const safeTitle = escapeHTML(String(title ?? ''));
    const safeMsg = allowHTML ? String(msg ?? '') : escapeHTML(String(msg ?? ''));
    const el = document.createElement('div');
    el.className = 'notif';
    el.innerHTML = `<div class="notif-icon ${safeType}"><i class="fas ${icons[safeType]}"></i></div>
    <div style="flex:1"><div class="notif-title">${safeTitle}</div><div class="notif-msg">${safeMsg}</div></div>
    <button onclick="this.parentNode.remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:2px">×</button>`;
    const container = document.getElementById('notifContainer');
    container.appendChild(el);
    setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 300); }, 4000);
}

function toggleNotif() {
    showNotif('info', '📢 Bildirishnomalar', '3 ta yangi xabar: 1 ta kam qolgan mahsulot, 2 ta VIP mijoz xaridi');
}

// ============================================================
// UTILS
// ============================================================
function fmt(n) { return Math.round(n).toLocaleString('uz-UZ'); }

function globalSearch(q) {
    if (!q || q.length < 2) return;
    const foundProducts = products.filter(x => x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5);
    const foundCustomers = customers.filter(x => x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5);

    let msg = '';
    if (foundProducts.length > 0) {
        msg += `<b>📦 Mahsulotlar:</b><br>` + foundProducts.map(p => `${escapeHTML(p.name)} — ${fmt(p.price)} so'm`).join('<br>');
    }
    if (foundCustomers.length > 0) {
        if (msg) msg += '<br><br>';
        msg += `<b>👤 Mijozlar:</b><br>` + foundCustomers.map(c => `${escapeHTML(c.name)} — ${escapeHTML(c.phone)}`).join('<br>');
    }

    if (msg) {
        showNotif('info', 'Natijalar', msg, { allowHTML: true });
    } else if (q.length > 3) {
        showNotif('error', 'Topilmadi', 'Natija yo\'q: ' + escapeHTML(q));
    }
}

function previewLogo(input) {
    if (input.files && input.files[0]) showNotif('success', 'Logo!', 'Logo muvaffaqiyatli yuklandi');
}

// ============================================================
// KEYBOARD HOTKEYS
// ============================================================
document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    const inInput = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

    // F1 — Help
    if (e.key === 'F1') { e.preventDefault(); openModal('helpModal'); }
    // F2 — Checkout (from POS)
    if (e.key === 'F2') { e.preventDefault(); if (document.getElementById('page-pos').classList.contains('active')) checkout(); }
    // F3 — Go to POS
    if (e.key === 'F3') { e.preventDefault(); goTo('page-pos', document.getElementById('navPos')); }
    // F8 — Print receipt
    if (e.key === 'F8') { e.preventDefault(); printReceipt(); }
    // Escape — Close modals / clear cart
    if (e.key === 'Escape') {
        const openModals = document.querySelectorAll('.modal-overlay.open');
        if (openModals.length > 0) { openModals.forEach(m => m.classList.remove('open')); }
        else if (!inInput && document.getElementById('page-pos').classList.contains('active')) { clearCart(); }
    }
    // Ctrl+F — Focus global search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('globalSearchInput')?.focus();
    }
    // Enter on login
    if (e.key === 'Enter' && document.getElementById('loginPage').style.display !== 'none') {
        doLogin();
    }
});

// ============================================================
// SALARY MODULE — Oylik Maoshlarni Rejalashtirish
// Modulli JS: SalaryModule namespace
// ============================================================
const SalaryModule = (() => {
    'use strict';

    // ── PRIVATE STATE ──────────────────────────────────────────
    let salaryRecords = [];         // Xodimlar maosh ma'lumotlari
    let paymentHistory = [];        // Barcha to'lovlar tarixi
    let currentFilter = 'all';      // Active filter
    let searchQuery = '';           // Search string
    let editingId = null;           // Currently editing record id
    let payingId = null;            // Currently paying record id
    let salaryChart = null;         // Chart.js instance

    const STORAGE_KEY_RECORDS = 'tp_salary_records';
    const STORAGE_KEY_HISTORY = 'tp_salary_history';

    const ROLE_LABELS = {
        admin: 'Administrator',
        cashier: 'Kassa Xodimi',
        manager: 'Menejer',
        storekeeper: 'Omborchi',
        security: 'Xavfsizlik',
    };

    const PAY_METHOD_LABELS = {
        cash: '💵 Naqd',
        card: '💳 Plastik karta',
        click: '📱 Click',
        transfer: '🏦 Bank o\'tkazma',
    };

    const ROLE_COLORS = {
        admin: 'linear-gradient(135deg,#8B5CF6,#EC4899)',
        cashier: 'linear-gradient(135deg,#10B981,#059669)',
        manager: 'linear-gradient(135deg,#F59E0B,#D97706)',
        storekeeper: 'linear-gradient(135deg,#3B82F6,#1D4ED8)',
        security: 'linear-gradient(135deg,#EF4444,#B91C1C)',
    };

    // ── PERSISTENCE ────────────────────────────────────────────
    function save() {
        try {
            localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(salaryRecords));
            localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(paymentHistory));
        } catch (e) { console.error('Salary save error:', e); }
    }

    function load() {
        try {
            const r = localStorage.getItem(STORAGE_KEY_RECORDS);
            const h = localStorage.getItem(STORAGE_KEY_HISTORY);
            salaryRecords = r ? safeJsonParse(r, defaultRecords()) : defaultRecords();
            paymentHistory = h ? safeJsonParse(h, []) : [];
            if (!Array.isArray(salaryRecords)) salaryRecords = defaultRecords();
            if (!Array.isArray(paymentHistory)) paymentHistory = [];
        } catch (e) {
            salaryRecords = defaultRecords();
            paymentHistory = [];
        }
    }

    function defaultRecords() {
        const today = new Date();
        const fmt = d => d.toISOString().split('T')[0];
        const nextDate = (dayOfMonth) => {
            const d = new Date(today.getFullYear(), today.getMonth(), dayOfMonth);
            if (d < today) d.setMonth(d.getMonth() + 1);
            return fmt(d);
        };
        return [
            { id: 1, name: 'Abdullayev Admin', role: 'admin', salary: 5500000, payDay: 5, nextDate: nextDate(5), method: 'card', card: '8600 0101 2345 6789', status: 'pending', createdAt: fmt(today) },
            { id: 2, name: 'Karimov Kassir', role: 'cashier', salary: 3200000, payDay: 1, nextDate: nextDate(1), method: 'card', card: '8600 9876 5432 1000', status: 'pending', createdAt: fmt(today) },
            { id: 3, name: 'Toshmatov Menejer', role: 'manager', salary: 4500000, payDay: 3, nextDate: nextDate(3), method: 'transfer', card: '', status: 'pending', createdAt: fmt(today) },
        ];
    }

    // ── STATUS CALCULATION ─────────────────────────────────────
    function calcStatus(rec) {
        if (rec.status === 'paid') return 'paid';
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const next = new Date(rec.nextDate); next.setHours(0, 0, 0, 0);
        const diff = Math.round((next - today) / 86400000); // days
        if (diff < 0) return 'overdue';
        if (diff === 0) return 'today';
        return 'pending';
    }

    function statusLabel(status) {
        return {
            pending: '<span class="salary-badge salary-badge-pending"><i class="fas fa-clock"></i> Kutilmoqda</span>',
            today: '<span class="salary-badge salary-badge-today"><i class="fas fa-bell"></i> Bugun to\'lanadi</span>',
            overdue: '<span class="salary-badge salary-badge-overdue"><i class="fas fa-exclamation-triangle"></i> Kechikkan</span>',
            paid: '<span class="salary-badge salary-badge-paid"><i class="fas fa-check-circle"></i> To\'langan</span>',
        }[status] || '';
    }

    function daysUntil(dateStr) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const next = new Date(dateStr); next.setHours(0, 0, 0, 0);
        return Math.round((next - today) / 86400000);
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function formatMoney(n) {
        return Math.round(n).toLocaleString('uz-UZ') + ' so\'m';
    }

    function monthLabel(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        const months = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
        return months[d.getMonth()] + ' ' + d.getFullYear();
    }

    // ── FILTER & SEARCH ────────────────────────────────────────
    function getFiltered() {
        const monthVal = document.getElementById('salary-month-filter')?.value || '';
        return salaryRecords.filter(rec => {
            const s = calcStatus(rec);
            const matchFilter = (currentFilter === 'all') || (s === currentFilter);
            const matchSearch = !searchQuery ||
                rec.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                (ROLE_LABELS[rec.role] || '').toLowerCase().includes(searchQuery.toLowerCase());
            const matchMonth = !monthVal || rec.nextDate.startsWith(monthVal);
            return matchFilter && matchSearch && matchMonth;
        });
    }

    // ── RENDER STATS ───────────────────────────────────────────
    function renderStats() {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const statuses = salaryRecords.map(r => calcStatus(r));
        const totalMonthlyCost = salaryRecords.reduce((s, r) => s + r.salary, 0);
        const overdueCount = statuses.filter(s => s === 'overdue').length;
        const todayCount = statuses.filter(s => s === 'today').length;
        const paidThisMonth = paymentHistory.filter(p => {
            const d = new Date(p.paidAt);
            const n = new Date();
            return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
        });
        const paidTotal = paidThisMonth.reduce((s, p) => s + p.amount, 0);

        const el = document.getElementById('salary-stat-cards');
        if (!el) return;
        el.innerHTML = `
      <div class="salary-stat-card" style="--accent-color:#f97316">
        <div class="salary-stat-icon" style="background:rgba(249,115,22,.12);color:#fb923c"><i class="fas fa-money-bill-trend-up"></i></div>
        <div class="salary-stat-num">${formatMoney(totalMonthlyCost)}</div>
        <div class="salary-stat-label">Umumiy oylik xarajat</div>
      </div>
      <div class="salary-stat-card" style="--accent-color:#22c55e">
        <div class="salary-stat-icon" style="background:rgba(34,197,94,.12);color:#4ade80"><i class="fas fa-check-double"></i></div>
        <div class="salary-stat-num">${formatMoney(paidTotal)}</div>
        <div class="salary-stat-label">Bu oy to'langan</div>
      </div>
      <div class="salary-stat-card" style="--accent-color:#3b82f6">
        <div class="salary-stat-icon" style="background:rgba(59,130,246,.12);color:#60a5fa"><i class="fas fa-bell"></i></div>
        <div class="salary-stat-num">${todayCount} ta</div>
        <div class="salary-stat-label">Bugun to'lanishi kerak</div>
      </div>
      <div class="salary-stat-card" style="--accent-color:#ef4444">
        <div class="salary-stat-icon" style="background:rgba(239,68,68,.12);color:#f87171"><i class="fas fa-triangle-exclamation"></i></div>
        <div class="salary-stat-num">${overdueCount} ta</div>
        <div class="salary-stat-label">Kechikkan to'lovlar</div>
      </div>
    `;

        // Update urgent badge in sidebar
        const badge = document.getElementById('salary-urgent-badge');
        if (badge) {
            const urgentCount = overdueCount + todayCount;
            if (urgentCount > 0) {
                badge.textContent = urgentCount;
                badge.style.display = '';
                badge.style.background = overdueCount > 0 ? 'var(--danger)' : 'var(--info)';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    // ── RENDER TABLE ───────────────────────────────────────────
    function renderTable() {
        const list = getFiltered();
        const tbody = document.getElementById('salaryTableBody');
        if (!tbody) return;

        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="font-size:40px;margin-bottom:12px;opacity:.2">💰</div>
        <p style="font-weight:600">Ma'lumot topilmadi</p>
      </td></tr>`;
            return;
        }

        tbody.innerHTML = list.map((rec, idx) => {
            const status = calcStatus(rec);
            const days = daysUntil(rec.nextDate);
            const rowClass = status === 'today' ? 'salary-row-today' :
                status === 'overdue' ? 'salary-row-overdue' :
                    status === 'paid' ? 'salary-row-paid' : '';

            // Progress (days until pay out of 30)
            const maxDays = 30;
            const pct = status === 'paid' ? 100 :
                status === 'overdue' ? 100 :
                    Math.max(0, Math.round((1 - days / maxDays) * 100));
            const progressColor = status === 'paid' ? '#22c55e' :
                status === 'overdue' ? '#ef4444' :
                    status === 'today' ? '#3b82f6' : 'var(--primary)';

            const daysText = status === 'paid' ? '✓ To\'landi' :
                status === 'overdue' ? `${Math.abs(days)} kun kech` :
                    status === 'today' ? '⚡ Bugun!' :
                        `${days} kun qoldi`;

            const avatarLetter = rec.name.trim()[0] || '?';
            const avatarGrad = ROLE_COLORS[rec.role] || 'linear-gradient(135deg,#64748b,#475569)';

            return `<tr class="${rowClass}">
        <td style="color:var(--text-muted);font-size:12px;font-weight:600">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:38px;height:38px;border-radius:11px;background:${avatarGrad};display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:white;flex-shrink:0">${escapeHTML(avatarLetter)}</div>
            <div>
              <div style="font-weight:700;font-size:13px">${escapeHTML(rec.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${escapeHTML(PAY_METHOD_LABELS[rec.method] || rec.method)}</div>
            </div>
          </div>
        </td>
        <td>
          <span class="badge badge-blue" style="font-size:11px">${escapeHTML(ROLE_LABELS[rec.role] || rec.role)}</span>
        </td>
        <td>
          <span style="font-weight:800;color:var(--primary);font-size:14px">${formatMoney(rec.salary)}</span>
        </td>
        <td>
          <div style="font-weight:600;font-size:13px">${formatDate(rec.nextDate)}</div>
          <div style="font-size:11px;color:${status === 'overdue' ? 'var(--danger)' : status === 'today' ? '#60a5fa' : 'var(--text-muted)'};margin-top:2px;font-weight:600">${daysText}</div>
        </td>
        <td>${statusLabel(status)}</td>
        <td style="min-width:140px">
          <div class="salary-progress-wrap">
            <div class="salary-progress-bar">
              <div class="salary-progress-fill" style="width:${pct}%;background:${progressColor}"></div>
            </div>
            <span class="salary-progress-label" style="color:${progressColor}">${pct}%</span>
          </div>
        </td>
        <td>
          <div style="display:flex;gap:6px">
            ${status !== 'paid' ? `
            <button class="btn btn-success btn-sm" onclick="SalaryModule.openPayModal(${rec.id})" title="To'lash">
              <i class="fas fa-check"></i> To'lash
            </button>` : `
            <button class="btn btn-outline btn-sm" onclick="SalaryModule.openPayModal(${rec.id})" title="Ko'rish">
              <i class="fas fa-eye"></i>
            </button>`}
            <button class="btn btn-outline btn-sm" onclick="SalaryModule.openEditModal(${rec.id})" title="Tahrirlash">
              <i class="fas fa-edit"></i>
            </button>
            <button class="btn btn-danger btn-sm" onclick="SalaryModule.deleteRecord(${rec.id})" title="O'chirish">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>`;
        }).join('');
    }

    // ── RENDER RECENT PAYMENTS ─────────────────────────────────
    function renderRecentPayments() {
        const el = document.getElementById('salary-recent-list');
        const cnt = document.getElementById('salary-recent-count');
        if (!el) return;

        const recent = [...paymentHistory].reverse().slice(0, 20);
        if (cnt) cnt.textContent = `${paymentHistory.length} ta to'lov`;

        if (recent.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:10px;opacity:.2">📋</div>
        <p>Hali to'lovlar amalga oshirilmagan</p>
      </div>`;
            return;
        }

        el.innerHTML = recent.map(p => `
      <div class="salary-history-item">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          <div style="width:32px;height:32px;border-radius:9px;background:rgba(34,197,94,.12);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">✓</div>
          <div style="min-width:0">
            <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHTML(p.empName)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${escapeHTML(p.month)} · ${formatDate(p.paidAt)}</div>
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-weight:800;color:#4ade80;font-size:13px">${formatMoney(p.amount)}</div>
          <div style="font-size:10px;color:var(--text-muted)">${escapeHTML(PAY_METHOD_LABELS[p.method] || p.method)}</div>
        </div>
      </div>
    `).join('');
    }

    // ── RENDER SALARY CHART ────────────────────────────────────
    function renderChart() {
        const ctx = document.getElementById('salaryHistoryChart');
        if (!ctx) return;
        if (salaryChart) { salaryChart.destroy(); salaryChart = null; }

        // Group payments by month
        const byMonth = {};
        paymentHistory.forEach(p => {
            const key = monthLabel(p.paidAt);
            byMonth[key] = (byMonth[key] || 0) + p.amount;
        });

        // Last 6 months (fill missing with 0)
        const months = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const m = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'][d.getMonth()];
            months.push({ label: m + ' ' + d.getFullYear(), key: m + ' ' + d.getFullYear() });
        }

        salaryChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: months.map(m => m.label),
                datasets: [{
                    label: 'To\'langan maosh (so\'m)',
                    data: months.map(m => byMonth[m.key] || 0),
                    backgroundColor: 'rgba(34,197,94,0.65)',
                    borderColor: '#22c55e',
                    borderWidth: 1,
                    borderRadius: 8,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9CA3AF', font: { size: 11 } } },
                    y: {
                        grid: { color: 'rgba(255,255,255,.05)' }, ticks: {
                            color: '#9CA3AF', font: { size: 11 },
                            callback: v => (v / 1000000).toFixed(1) + ' M'
                        }
                    }
                }
            }
        });
    }

    // ── POPULATE MONTH FILTER ──────────────────────────────────
    function populateMonthFilter() {
        const sel = document.getElementById('salary-month-filter');
        if (!sel) return;
        const months = [];
        const now = new Date();
        for (let i = 0; i < 12; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const labels = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
            months.push({ val, label: labels[d.getMonth()] + ' ' + d.getFullYear() });
        }
        sel.innerHTML = '<option value="">Barcha oylar</option>' +
            months.map(m => `<option value="${m.val}">${m.label}</option>`).join('');
    }

    // ── FULL RE-RENDER ─────────────────────────────────────────
    function render() {
        renderStats();
        renderTable();
        renderRecentPayments();
        renderChart();
        populateMonthFilter();
    }

    // ── PAY MODAL ──────────────────────────────────────────────
    function openPayModal(id) {
        const rec = salaryRecords.find(r => r.id === id);
        if (!rec) return;
        payingId = id;
        const status = calcStatus(rec);
        const avatarGrad = ROLE_COLORS[rec.role] || 'linear-gradient(135deg,#64748b,#475569)';

        // Fill employee info
        const avatarEl = document.getElementById('salary-modal-avatar');
        if (avatarEl) { avatarEl.textContent = rec.name[0]; avatarEl.style.background = avatarGrad; }
        setText('salary-modal-name', rec.name);
        setText('salary-modal-role', ROLE_LABELS[rec.role] || rec.role);
        setHTML('salary-modal-status-badge', statusLabel(status));
        setHTML('salary-modal-amount', formatMoney(rec.salary));
        setText('salary-modal-cur-month', monthLabel(rec.nextDate));
        setText('salary-modal-cur-date', formatDate(rec.nextDate));
        setHTML('salary-modal-cur-status', statusLabel(status));
        setHTML('salary-modal-total-due', `<strong style="color:var(--primary)">${formatMoney(rec.salary)}</strong>`);

        // Next date default: same day next month
        const nextD = new Date(rec.nextDate);
        nextD.setMonth(nextD.getMonth() + 1);
        const nextDateInput = document.getElementById('salary-modal-next-date');
        if (nextDateInput) nextDateInput.value = nextD.toISOString().split('T')[0];

        // Pay amount default
        const payAmtInput = document.getElementById('salary-modal-pay-amount');
        if (payAmtInput) payAmtInput.value = '';

        // Note
        const noteInput = document.getElementById('salary-modal-note');
        if (noteInput) noteInput.value = '';

        // Modal title & pay button
        setText('salaryModalTitle', status === 'paid' ? 'To\'lov Tarixi' : 'Maosh To\'lash');
        const payBtn = document.getElementById('salary-pay-btn');
        if (payBtn) {
            payBtn.style.display = status === 'paid' ? 'none' : '';
        }

        // Payment history
        renderModalHistory(rec.id);
        openModal('salaryPayModal');
    }

    function renderModalHistory(empId) {
        const el = document.getElementById('salary-modal-history');
        if (!el) return;
        const hist = paymentHistory.filter(p => p.empId === empId).reverse().slice(0, 8);
        if (hist.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px">Hali to'lovlar yo'q</div>`;
            return;
        }
        el.innerHTML = hist.map(p => `
      <div class="salary-history-item">
        <div>
          <div style="font-weight:600;font-size:12px">${escapeHTML(p.month)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${formatDate(p.paidAt)} · ${escapeHTML(p.note || 'Izohsiz')}</div>
        </div>
        <span class="salary-badge salary-badge-paid">${formatMoney(p.amount)}</span>
      </div>
    `).join('');
    }

    function markPaid() {
        const rec = salaryRecords.find(r => r.id === payingId);
        if (!rec) return;

        const nextDateVal = document.getElementById('salary-modal-next-date')?.value;
        const payAmtVal = parseFloat(document.getElementById('salary-modal-pay-amount')?.value) || rec.salary;
        const noteVal = validateSafeInput('Izoh', document.getElementById('salary-modal-note')?.value || '', 180);
        if (noteVal === null) return;

        if (!nextDateVal) {
            showNotif('error', 'Xato!', 'Keyingi to\'lov sanasini kiriting');
            return;
        }

        const today = new Date().toISOString().split('T')[0];

        // Add to payment history
        paymentHistory.push({
            id: Date.now(),
            empId: rec.id,
            empName: rec.name,
            amount: payAmtVal,
            month: monthLabel(rec.nextDate),
            paidAt: today,
            method: rec.method,
            note: noteVal,
        });

        // Update record
        rec.nextDate = nextDateVal;
        rec.status = 'pending'; // reset to pending for next cycle

        save();
        if (typeof addLog === 'function') addLog('Maosh', `${rec.name} — ${formatMoney(payAmtVal)} to'landi`);
        if (typeof playCheckout === 'function') playCheckout();
        showNotif('success', '✅ To\'lov amalga oshirildi!', `${rec.name}: ${formatMoney(payAmtVal)}`);
        closeModal('salaryPayModal');
        render();
    }

    // ── ADD / EDIT MODAL ───────────────────────────────────────
    function openAddModal(title = 'Yangi Xodim') {
        editingId = null;
        setText('salaryAddModalTitle', title);
        ['sal-emp-name', 'sal-amount', 'sal-card'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const dd = document.getElementById('sal-pay-day'); if (dd) dd.value = 1;
        const fd = document.getElementById('sal-first-date');
        if (fd) {
            const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1);
            fd.value = d.toISOString().split('T')[0];
        }
        openModal('salaryAddModal');
    }

    function openEditModal(id) {
        const rec = salaryRecords.find(r => r.id === id);
        if (!rec) return;
        editingId = id;
        setText('salaryAddModalTitle', 'Xodim Maosh Sozlamasini Tahrirlash');
        setVal('sal-emp-name', rec.name);
        setVal('sal-amount', rec.salary);
        setVal('sal-pay-day', rec.payDay);
        setVal('sal-first-date', rec.nextDate);
        setVal('sal-card', rec.card || '');
        setVal('sal-emp-role', rec.role);
        setVal('sal-pay-method', rec.method);
        openModal('salaryAddModal');
    }

    function saveEmployee() {
        if (!requireRole('admin', 'manager')) return;
        const name = validateSafeInput('Xodim ismi', document.getElementById('sal-emp-name')?.value || '', 120);
        const salary = parseInt(document.getElementById('sal-amount')?.value) || 0;
        const payDay = parseInt(document.getElementById('sal-pay-day')?.value) || 1;
        const firstDate = document.getElementById('sal-first-date')?.value;
        const role = cleanText(document.getElementById('sal-emp-role')?.value || 'cashier', 40);
        const method = cleanText(document.getElementById('sal-pay-method')?.value || 'cash', 40);
        const card = validateSafeInput('Karta raqami', document.getElementById('sal-card')?.value || '', 40);

        if (name === null || card === null) return;
        if (!name) { if (typeof playError === 'function') playError(); showNotif('error', 'Xato!', 'Ism majburiy'); return; }
        if (!salary) { if (typeof playError === 'function') playError(); showNotif('error', 'Xato!', 'Maosh miqdorini kiriting'); return; }
        if (!firstDate) { if (typeof playError === 'function') playError(); showNotif('error', 'Xato!', 'To\'lov sanasini kiriting'); return; }

        if (editingId) {
            const rec = salaryRecords.find(r => r.id === editingId);
            if (rec) Object.assign(rec, { name, salary, payDay, nextDate: firstDate, role, method, card });
            if (typeof addLog === 'function') addLog('Maosh', `"${name}" sozlamalari yangilandi`);
            showNotif('success', 'Yangilandi!', name + ' ma\'lumotlari saqlandi');
        } else {
            const recordId = Date.now();
            salaryRecords.push({
                id: recordId, name, role, salary, payDay,
                nextDate: firstDate, method, card,
                status: 'pending',
                createdAt: new Date().toISOString().split('T')[0],
            });
            employees.push({ id: recordId + 1, name, role, sales: 0, total: 0, login: '—', status: 'active' });
            if (typeof addLog === 'function') addLog('Maosh', `"${name}" maosh jadvali qo'shildi`);
            showNotif('success', 'Qo\'shildi!', name + ' maosh jadvaliga qo\'shildi');
            if (typeof renderEmployees === 'function') renderEmployees();
        }

        save();
        closeModal('salaryAddModal');
        render();
    }

    // ── DELETE ─────────────────────────────────────────────────
    function deleteRecord(id) {
        if (!requireRole('admin', 'manager')) return;
        const rec = salaryRecords.find(r => r.id === id);
        if (!rec) return;
        if (!confirm(`"${rec.name}" maosh jadvalidan o'chirilsinmi?`)) return;
        salaryRecords = salaryRecords.filter(r => r.id !== id);
        save();
        if (typeof addLog === 'function') addLog('Maosh', `"${rec.name}" maosh jadvalidan o'chirildi`);
        showNotif('info', 'O\'chirildi!', rec.name + ' o\'chirildi');
        render();
    }

    // ── FILTER BUTTON ──────────────────────────────────────────
    function setFilter(f, btnEl) {
        currentFilter = f;
        document.querySelectorAll('.salary-filter-btn').forEach(b => b.classList.remove('active'));
        if (btnEl) btnEl.classList.add('active');
        renderTable();
    }

    function applyFilter() { renderTable(); }

    function search(q) {
        searchQuery = q;
        renderTable();
    }

    // ── EXPORT CSV ─────────────────────────────────────────────
    function exportCSV() {
        if (!requireRole('admin', 'manager')) return;
        const header = ['#', 'Ism', 'Rol', 'Oylik Maosh', 'Keyingi Sana', 'Holat', 'To\'lov Usuli'];
        const rows = salaryRecords.map((rec, i) => [
            i + 1, rec.name, ROLE_LABELS[rec.role] || rec.role, rec.salary,
            rec.nextDate, calcStatus(rec), PAY_METHOD_LABELS[rec.method] || rec.method,
        ]);
        const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `TehnoPark_Maosh_${new Date().toLocaleDateString('uz-UZ').replace(/\//g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        showNotif('success', 'Eksport!', 'CSV fayl yuklandi');
    }

    // ── HELPERS ────────────────────────────────────────────────
    function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
    function setHTML(id, val) { const el = document.getElementById(id); if (el) el.innerHTML = val; }
    function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }

    // ── INIT ───────────────────────────────────────────────────
    function init() {
        load();
        render();
    }

    // ── PUBLIC API ─────────────────────────────────────────────
    return { init, render, openPayModal, markPaid, openAddModal, openEditModal, saveEmployee, deleteRecord, setFilter, applyFilter, search, exportCSV };
})();

applySavedTheme();
initApp();
goTo('page-shop', document.getElementById('nav-shop'));
