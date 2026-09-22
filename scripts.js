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
let clickPollingInterval = null;
let systemSettings = {
    clickMerchantId: '',
    clickServiceId: '',
    clickMerchantUserId: '',
    clickPhone: '',
    taxRate: 12,
    barcodeTimeout: 50,
    soundEnabled: true,
    autoPrint: true,
    // ── Shartnomalar ──
    contractWarrantyMonths: 12,
    // Shartnomalar AVTOMATIK tuzilmaydi — faqat administrator qo'lda tuzadi
    // (yoki savdo chekini tanlab bir marta import qiladi).
    contractSyncSeconds: 60,
    // ── To'lov tizimlari ──
    paymentDefaultProvider: 'cash',
    paymentPollSeconds: 3,
    paymentExpireMinutes: 15,
    paymeMerchantId: '',
    // ── Kompaniya (chek va fiskal chek sarlavhasi uchun) ──
    companyName: '',
    companyPhone: '',
    companyAddress: '',
    companyTin: '',
    // ── Xavfsizlik ──
    sessionTimeoutMin: 20,
    maxLoginAttempts: 5,
    lockMinutes: 5,
    securityLogLimit: 200
};

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

/* ============================================================
   [SECURITY-CORE-BEGIN]
   Sof (DOM'siz) xavfsizlik yadrosi: SHA-256, parol xeshi,
   kripto-token, doimiy vaqtli taqqoslash, XSS filtri.
   Bu blok Node.js'da ham test qilinishi mumkin.
   ============================================================ */
const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr32(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
        return Array.from(new TextEncoder().encode(String(str)));
    }
    const out = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else if (c >= 0xd800 && c <= 0xdbff) {
            const c2 = str.charCodeAt(++i);
            const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
}
function sha256Hex(input) {
    const bytes = utf8Bytes(input);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 4294967296);
    const lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);

    for (let i = 0; i < bytes.length; i += 64) {
        for (let j = 0; j < 16; j++) {
            w[j] = ((bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) |
                (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3]) >>> 0;
        }
        for (let j = 16; j < 64; j++) {
            const a15 = w[j - 15], a2 = w[j - 2];
            const s0 = (rotr32(a15, 7) ^ rotr32(a15, 18) ^ (a15 >>> 3)) >>> 0;
            const s1 = (rotr32(a2, 17) ^ rotr32(a2, 19) ^ (a2 >>> 10)) >>> 0;
            w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
        }
        let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (let j = 0; j < 64; j++) {
            const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const t1 = (h + S1 + ch + SHA256_K[j] + w[j]) >>> 0;
            const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(x => x.toString(16).padStart(8, '0')).join('');
}

function hashPassword(password, salt) {
    return sha256Hex(`${salt}::${String(password ?? '')}`);
}

function constantTimeEqual(a, b) {
    const x = String(a ?? ''), y = String(b ?? '');
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

function randomToken(bytes = 16) {
    const arr = new Uint8Array(Math.max(4, Math.min(64, bytes)));
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
    } else {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function makeSalt(prefix = 'tp') { return `${prefix}-${randomToken(12)}`; }

function hasXssPattern(value) {
    const text = String(value ?? '');
    return /<\s*script|<\/\s*script|<\s*iframe|<\s*object|<\s*embed|<\s*svg|javascript\s*:|vbscript\s*:/i.test(text) ||
        /\bon(error|load|click|mouseover|focus|submit|change|input)\s*=/i.test(text) ||
        /data\s*:\s*text\/html|%3cscript|&#x?0*3c;?/i.test(text);
}

function passwordStrength(pass) {
    const p = String(pass ?? '');
    let score = 0;
    if (p.length >= 6) score++;
    if (p.length >= 10) score++;
    if (/[A-Z]/.test(p) && /[a-z]/.test(p)) score++;
    if (/[0-9]/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;
    return Math.min(4, score);
}
/* ============================================================
   [SECURITY-CORE-END]
   ============================================================ */

// ============================================================
// XAVFSIZLIK JURNALI (audit log)
// ============================================================
let securityEvents = safeJsonParse(localStorage.getItem('tp_security_log') || '[]', []);
if (!Array.isArray(securityEvents)) securityEvents = [];

function securityLogLimit() {
    return Math.min(1000, Math.max(50, Number(systemSettings.securityLogLimit) || 200));
}

function securityLog(type, level, message, userName) {
    try {
        securityEvents.unshift({
            id: 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            time: new Date().toLocaleString('uz-UZ'),
            ts: Date.now(),
            type: cleanText(type, 60),
            level: ['low', 'medium', 'high', 'critical'].includes(level) ? level : 'low',
            message: cleanText(message, 240),
            user: cleanText(userName || (currentUser ? currentUser.name : 'Tizim'), 120)
        });
        if (securityEvents.length > securityLogLimit()) securityEvents.length = securityLogLimit();
        localStorage.setItem('tp_security_log', JSON.stringify(securityEvents));
        scheduleSyncWithBackend(); // bazaga ham yoziladi
    } catch (e) {
        console.warn('Xavfsizlik jurnaliga yozib bo\'lmadi:', e);
    }
    if (typeof renderSecurityPanel === 'function') renderSecurityPanel();
}

function securityStats() {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const last24 = securityEvents.filter(e => Number(e.ts) >= dayAgo);
    const failed = last24.filter(e => e.type === 'login-failed').length;
    const blocked = securityEvents.filter(e => ['sql-injection-block', 'xss-block', 'lockout', 'brute-force'].includes(e.type)).length;
    const highRisk = securityEvents.filter(e => ['high', 'critical'].includes(e.level)).length;
    const score = Math.max(40, 100 - failed * 5 - highRisk * 3);
    return { failed, blocked, total: securityEvents.length, score: Math.min(100, score) };
}

function validateSafeInput(label, value, maxLen = 160) {
    const text = cleanText(value, maxLen);
    if (hasSqlInjectionPattern(text)) {
        playError();
        showNotif('error', 'Xavfsizlik!', `${label} maydonida shubhali SQL belgilar topildi`);
        securityLog('sql-injection-block', 'high', `SQL injection urinishi bloklandi: ${label}`);
        return null;
    }
    if (hasXssPattern(String(value ?? ''))) {
        playError();
        showNotif('error', 'Xavfsizlik!', `${label} maydonida skript (XSS) kodi topildi — bloklandi`);
        securityLog('xss-block', 'high', `XSS urinishi bloklandi: ${label}`);
        return null;
    }
    return text;
}

// Bazada (va keshda) saqlanadigan rasm uchun maksimal hajm — server ham
// xuddi shu chegarani tekshiradi (app.py: IMAGE_DATA_LIMIT).
var MAX_IMAGE_DATA_LENGTH = 900 * 1024;

/** Bazada saqlanadigan base64 rasm (data URL) ni tekshiradi. */
function isImageDataUrl(value) {
    return typeof value === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(value);
}

/** Faqat http(s) havolalar (tashqi rasm manzillari). */
function safeImageLink(value) {
    const raw = cleanText(value, 500);
    if (!raw) return '';
    try {
        const url = new URL(raw, window.location.href);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (e) {
        return '';
    }
}

/**
 * Rasm manzilini xavfsiz ko'rinishga keltiradi.
 * Ikki xil manba qo'llanadi:
 *   1) data:image/... base64 — rasm to'g'ridan-to'g'ri bazada saqlanadi;
 *   2) http(s) havola — tashqi (CDN/ombor) rasm manzili.
 * Boshqa har qanday sxema (javascript:, blob:, svg+script va h.k.) rad etiladi.
 */
function safeImageUrl(value) {
    if (typeof value === 'string' && value.trim().toLowerCase().startsWith('data:')) {
        const raw = cleanText(value, MAX_IMAGE_DATA_LENGTH + 64);
        if (!isImageDataUrl(raw)) return '';
        return raw.length <= MAX_IMAGE_DATA_LENGTH ? raw : '';
    }
    return safeImageLink(value);
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
    if (isImageDataUrl(value)) return true;
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

/**
 * Rasmni brauzerda kichiklashtiradi va siqadi (max 1000px, WebP/JPEG).
 * Natija — bazaga to'g'ridan-to'g'ri saqlanadigan data URL (≤ 900 KB).
 */
function compressImageFile(file, maxSide = 1000, quality = 0.78) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Faylni o\'qib bo\'lmadi'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Rasm fayli buzilgan yoki formati qo\'llanmaydi'));
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    const width = Math.max(1, Math.round(img.width * scale));
                    const height = Math.max(1, Math.round(img.height * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    let dataUrl = canvas.toDataURL('image/webp', quality);
                    if (!isImageDataUrl(dataUrl)) dataUrl = canvas.toDataURL('image/jpeg', quality);

                    // 900 KB chegarasiga sig'maguncha sifatni pasaytiramiz
                    let q = quality;
                    while (dataUrl.length > MAX_IMAGE_DATA_LENGTH && q > 0.35) {
                        q -= 0.12;
                        dataUrl = canvas.toDataURL('image/jpeg', q);
                    }
                    if (dataUrl.length > MAX_IMAGE_DATA_LENGTH) {
                        reject(new Error('Rasm juda katta — kichikroq rasm tanlang'));
                        return;
                    }
                    resolve(dataUrl);
                } catch (e) {
                    reject(new Error('Rasmni qayta ishlab bo\'lmadi'));
                }
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

/** Rasm maydonidagi kichik ko'rinish (preview) ni yangilaydi. */
function updateProductImagePreview(value) {
    const box = document.getElementById('p-img-preview');
    if (!box) return;
    const src = productImageSrc(value);
    if (!src) {
        box.innerHTML = '<span style="font-size:11px">Rasm yo\'q</span>';
        return;
    }
    box.innerHTML = `<img src="${src}" alt="Mahsulot rasmi" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`;
}

/**
 * Mahsulot rasmini yuklaydi.
 * Asosiy yo'l: rasm brauzerda siqiladi va TO'G'RIDAN-TO'G'RI BAZAGA
 * saqlanadi (mahsulot yozuvi ichida). Server tomonida ham hajm/format
 * tekshiriladi (app.py: validate_sync_payload).
 */
async function uploadProductImageToBucket(input) {
    if (!requireRole('admin', 'manager')) return;
    const file = input?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        playError();
        showNotif('error', 'Xato!', 'Faqat rasm fayl yuklang');
        input.value = '';
        return;
    }
    if (file.size > 12 * 1024 * 1024) {
        playError();
        showNotif('error', 'Xato!', 'Rasm hajmi 12MB dan oshmasin');
        input.value = '';
        return;
    }

    const btn = document.getElementById('bucketUploadBtn');
    const previousHtml = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
        const dataUrl = await compressImageFile(file);
        const field = document.getElementById('p-img');
        if (field) field.value = dataUrl;
        updateProductImagePreview(dataUrl);
        playSuccess();
        const kb = Math.round(dataUrl.length / 1024);
        showNotif('success', 'Rasm tayyor!',
            `Rasm siqildi (${kb} KB) va mahsulot bilan birga bazaga saqlanadi`);
    } catch (e) {
        console.error('Rasm siqishda xatolik:', e);
        playError();
        showNotif('error', 'Yuklanmadi!', e?.message || 'Rasmni qayta ishlab bo\'lmadi');
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
        securityLog('access-denied', 'medium',
            `Ruxsat etilmagan amal: kerak [${roles.join(', ')}], mavjud [${currentUser?.role || 'mehmon'}]`);
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

/** Rasmni brauzer keshiga yozishdan oldin "yengillashtiradi".
 *  base64 rasmlar localStorage kvotasini (5 MB) tez to'ldiradi, shuning uchun
 *  keshga faqat havola saqlanadi; rasm o'zi bazadan qaytariladi. */
function productForCache(p) {
    if (p && isImageDataUrl(p.img)) {
        return { ...p, img: '', imgInDb: true };
    }
    return p;
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
    { id: 1, login: 'admin', salt: 'tp-adm-9x2', passHash: '847987bfe33b7e4354666fd0a6084ec34e6f09b60f673065a10735f8aa2b7057', name: 'Abdullayev Admin', role: 'admin', color: '#ff6b35' },
    { id: 2, login: 'cashier', salt: 'tp-csh-4k7', passHash: 'e3da606a986c263b7018487dfdbc9e8316898f0a1b68792106619ef867c97f41', name: 'Karimov Kassir', role: 'cashier', color: '#10B981' },
    { id: 3, login: 'manager', salt: 'tp-mng-3z8', passHash: '91416abaaa7af1470c242189d1cfe0d6658d1b2eee31a1fdcbd001426dfcc895', name: 'Toshmatov Menejer', role: 'manager', color: '#F59E0B' },
    { id: 7, login: 'customer', salt: 'tp-usr-6q1', passHash: 'dd550620e6c75f4d97bf3c4923f1c28b459b2df39f31600cf63e20d2b49b4819', name: 'Online Xaridor', role: 'customer', color: '#2563EB' },
    { id: 4, login: 'admin@texnopark.uz', salt: 'tp-adm-9x2', passHash: '847987bfe33b7e4354666fd0a6084ec34e6f09b60f673065a10735f8aa2b7057', name: 'Abdullayev Admin', role: 'admin', color: '#ff6b35' },
    { id: 5, login: 'cashier@texnopark.uz', salt: 'tp-csh-4k7', passHash: 'e3da606a986c263b7018487dfdbc9e8316898f0a1b68792106619ef867c97f41', name: 'Karimov Kassir', role: 'cashier', color: '#10B981' },
    { id: 6, login: 'manager@texnopark.uz', salt: 'tp-mng-3z8', passHash: '91416abaaa7af1470c242189d1cfe0d6658d1b2eee31a1fdcbd001426dfcc895', name: 'Toshmatov Menejer', role: 'manager', color: '#F59E0B' },
    { id: 8, login: 'customer@texnopark.uz', salt: 'tp-usr-6q1', passHash: 'dd550620e6c75f4d97bf3c4923f1c28b459b2df39f31600cf63e20d2b49b4819', name: 'Online Xaridor', role: 'customer', color: '#2563EB' },
];
const ROLES = { admin: 'Administrator', cashier: 'Kassa Xodimi', manager: 'Menejer', customer: 'Xaridor' };

// ============================================================
// KATEGORIYALAR — yagona manba (POS, do'kon, mahsulot formasi, hisobot)
// ============================================================
// Bu ro'yxat doimiy: mahsulot qo'shilmagan bo'lsa ham POS va do'konda
// barcha kategoriyalar ko'rinib turadi.
// Boshlang'ich (standart) kategoriyalar. Ro'yxat bazada `categories` kaliti
// sifatida saqlanadi va yuklashda o'sha yerdan tiklanadi.
const DEFAULT_CATEGORIES = [
    'Muzlatgichlar',
    'Kir Yuvish Mashinalari',
    'Konditsionerlar',
    'Televizorlar',
    'Changyutgichlar',
    'Pechlar',
    'Mikrotolqinli Pechlar',
    'Aksessuarlar'
];

let CATEGORIES = (function () {
    const saved = safeJsonParse(localStorage.getItem('tp_categories') || 'null', null);
    const list = Array.isArray(saved)
        ? saved.map(c => cleanText(c, 60)).filter(Boolean)
        : [];
    return list.length ? list : DEFAULT_CATEGORIES.slice();
})();

/** Kategoriyalar ro'yxatini saqlash (lokal + baza). */
function saveCategories() {
    try { localStorage.setItem('tp_categories', JSON.stringify(CATEGORIES)); } catch (e) { }
    scheduleSyncWithBackend();
}

const CATEGORY_EMOJI = {
    'Muzlatgichlar': '❄️',
    'Kir Yuvish Mashinalari': '🧺',
    'Konditsionerlar': '💨',
    'Televizorlar': '📺',
    'Changyutgichlar': '🌀',
    'Pechlar': '🔥',
    'Mikrotolqinli Pechlar': '📡',
    'Aksessuarlar': '🔌'
};

const CATEGORY_FA_ICON = {
    'Barchasi': 'fa-th-large',
    'Muzlatgichlar': 'fa-snowflake',
    'Kir Yuvish Mashinalari': 'fa-soap',
    'Konditsionerlar': 'fa-wind',
    'Televizorlar': 'fa-tv',
    'Changyutgichlar': 'fa-broom',
    'Pechlar': 'fa-fire',
    'Mikrotolqinli Pechlar': 'fa-wave-square',
    'Aksessuarlar': 'fa-plug'
};

function categoryEmoji(name) { return CATEGORY_EMOJI[name] || '📦'; }
function categoryFaIcon(name) { return CATEGORY_FA_ICON[name] || 'fa-box'; }

// ============================================================
// REAL MA'LUMOT REJIMI
// ============================================================
// Tizim namuna (demo) ma'lumotsiz ishlaydi: barcha ko'rsatkichlar 0 dan
// boshlanadi va faqat haqiqiy kiritilgan ma'lumot asosida o'sadi.
// Eski demo keshni bir marta tozalab tashlaymiz.
const DATA_VERSION = 'real-3';
if (localStorage.getItem('tp_data_version') !== DATA_VERSION) {     ['tp_products', 'tp_customers', 'tp_sales', 'tp_logs', 'tp_salary_records',
        'tp_salary_history', 'tp_contracts', 'tp_security_log', 'tp_sms_history'].forEach(k => localStorage.removeItem(k));
    localStorage.setItem('tp_data_version', DATA_VERSION);
}

// ── Xavfsiz parol saqlash (salted SHA-256, ochiq matn YO'Q) ──
const SECURE_USERS_KEY = 'tp_users_secure';

function secureUserOverrides() {
    const list = safeJsonParse(localStorage.getItem(SECURE_USERS_KEY) || '[]', []);
    return Array.isArray(list) ? list : [];
}

function findBaseUser(loginKey) {
    const key = String(loginKey || '').toLowerCase();
    return USERS.find(u => u.login.toLowerCase() === key) || null;
}

/**
 * Login va parolni tekshiradi.
 * Qaytaradi: { ok, user, reason, legacy }
 *  - reason: 'not-found' | 'wrong-password' | 'ok'
 *  - legacy: true bo'lsa eski base64 xesh ishlatilgan (avtomatik yuqoriga ko'tariladi)
 */
function verifyUserLogin(loginKey, password) {
    const base = findBaseUser(loginKey);
    if (!base) return { ok: false, reason: 'not-found' };

    const override = secureUserOverrides().find(u => String(u.login).toLowerCase() === base.login.toLowerCase());
    const salt = override?.salt || base.salt || 'tp-legacy';
    const expected = override?.passHash || base.passHash;

    // Eski (base64) xesh bilan moslik uchun zaxira tekshiruv
    const legacyMatch = !override && expected &&
        /^[A-Za-z0-9+/=]{4,}$/.test(expected) && expected.length % 4 === 0 &&
        constantTimeEqual(btoa(String(password ?? '')), expected);

    const modernMatch = constantTimeEqual(hashPassword(password, salt), expected);

    if (modernMatch) return { ok: true, reason: 'ok', user: base, legacy: false };
    if (legacyMatch) return { ok: true, reason: 'ok', user: base, legacy: true };
    return { ok: false, reason: 'wrong-password', user: base };
}

/** Parolni yangi salted xesh bilan saqlaydi (eski base64 xeshni almashtiradi). */
function storeUserPassword(loginKey, password, byUser) {
    const base = findBaseUser(loginKey);
    if (!base) return false;
    const salt = makeSalt('tp-' + base.role.slice(0, 3));
    const passHash = hashPassword(password, salt);
    const overrides = secureUserOverrides().filter(u => String(u.login).toLowerCase() !== base.login.toLowerCase());
    overrides.push({
        login: base.login, salt, passHash,
        updatedAt: new Date().toLocaleString('uz-UZ'),
        updatedBy: cleanText(byUser || (currentUser ? currentUser.name : 'Tizim'), 120)
    });
    try {
        localStorage.setItem(SECURE_USERS_KEY, JSON.stringify(overrides));
        return true;
    } catch (e) {
        console.warn('Parolni saqlab bo\'lmadi:', e);
        return false;
    }
}

// ============================================================
// DATA (with localStorage persistence)
// ============================================================
// Mahsulotlar — faqat real ma'lumot (demo yo'q, bo'sh ro'yxatdan boshlanadi)
let products = safeJsonParse(localStorage.getItem('tp_products') || 'null', null) || [];
products = Array.isArray(products) ? products.map(normalizeProduct).filter(p => p.name && p.price >= 0) : [];

// Mijozlar — faqat real ma'lumot (demo yo'q, bo'sh ro'yxatdan boshlanadi)
let customers = safeJsonParse(localStorage.getItem('tp_customers') || 'null', null) || [];
customers = Array.isArray(customers) ? customers.map(normalizeCustomer).filter(c => c.name && c.phone) : [];

// Xodimlar ro'yxati real foydalanuvchilardan (USERS) quriladi.
// Sotuvlar soni va daromad faqat haqiqiy savdo tarixidan hisoblanadi —
// boshlang'ich holatda hammasi 0.
let employees = USERS
    .filter(u => u.role === 'admin' || u.role === 'cashier' || u.role === 'manager')
    .filter((u, i, arr) => arr.findIndex(x => x.name === u.name) === i)
    .map(u => ({
        id: u.id,
        name: u.name,
        role: u.role,
        login: '—',
        status: 'active',
        sales: 0,
        total: 0
    }));

/** Haqiqiy savdo tarixidan xodimning ko'rsatkichlarini hisoblaydi. */
function employeeStats(emp) {
    const mine = salesHistory.filter(s => s.cashier === emp.name);
    const total = mine.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
    return { sales: mine.length, total };
}

let salesHistory = safeJsonParse(localStorage.getItem('tp_sales') || '[]', []);
let logs = safeJsonParse(localStorage.getItem('tp_logs') || '[]', []);
salesHistory = Array.isArray(salesHistory) ? salesHistory : [];
logs = Array.isArray(logs) ? logs : [];

// ============================================================
// SMS TEMPLATES (COMPLETED)
// ============================================================
const smsTemplates = [
    { title: 'Chegirma haqida', text: 'Hurmatli {ism}! Texno Parkda 20% chegirma kampaniyasi boshlandi. Muzlatgich, TV va konditsionerlarda katta chegirmalar. Tez keling!' },
    { title: 'Chek tasdiqlash', text: 'Hurmatli {ism}! Siz {summa} so\'mlik xarid qildingiz. Chek raqamingiz: {chek}. Xarid uchun rahmat! Texno Park.' },
    { title: 'Tug\'ilgan kun', text: 'Hurmatli {ism}! Tug\'ilgan kuningiz bilan qutlaymiz! 🎉 Sovg\'a sifatida keyingi xaridingizda 10% chegirma beramiz.' },
    { title: 'Yangi mahsulot', text: 'Hurmatli {ism}! Texno Parkda yangi {mahsulot} keldi. Narxi: {narx} so\'m. Soni cheklangan, bugun keling!' },
    { title: 'Qarz eslatma', text: 'Hurmatli {ism}! Qoldiq to\'lovingiz {summa} so\'m. Iltimos, {sana} gacha to\'lashingizni so\'raymiz. Texno Park.' },
    { title: 'Kafolat eslatma', text: 'Hurmatli {ism}! Sizning {mahsulot} qurilmangizning kafolati {sana} da tugaydi. Kafolatni uzaytirish uchun murojaat qiling.' },
];

// ============================================================
// OFFLINE MODE
// ============================================================
window.addEventListener('online', async () => {
    document.getElementById('offlineBar').classList.remove('show');
    showNotif('success', 'Online!', 'Internet aloqasi tiklandi');
    // Aloqa tiklanganda yozilmagan ma'lumotni darhol yuboramiz va
    // chiqmay qolgan fiskal cheklarni qayta urinamiz.
    try {
        if (typeof staffToken !== 'undefined' && staffToken) {
            if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
            if (await syncWithBackend() && typeof Fiscal !== 'undefined') Fiscal.scheduleRetry(0);
        }
    } catch (e) { console.warn('Online tiklanishida sinxronizatsiya xatosi:', e); }
});
window.addEventListener('offline', () => { document.getElementById('offlineBar').classList.add('show'); showNotif('error', 'Oflayn!', 'Internet aloqasi yo\'q. Tizim oflayn rejimda ishlaydi'); });

function saveToStorage() {
    try {
        localStorage.setItem('tp_products', JSON.stringify(products.map(productForCache)));
        localStorage.setItem('tp_customers', JSON.stringify(customers));
        localStorage.setItem('tp_sales', JSON.stringify(salesHistory));
        localStorage.setItem('tp_logs', JSON.stringify(logs));
        try { localStorage.setItem('tp_contracts', JSON.stringify(contracts)); } catch (e) { }
        syncWithBackend(); // Sync with SQLite Database
    } catch (e) {
        console.error('localStorage xatosi:', e);
        alert("Diqqat: Brauzer xotirasi to'ldi! Iltimos, Sozlamalar bo'limidan ma'lumotlarni eksport qilib zaxiralang yoki keraksiz ma'lumotlarni tozalang. Aks holda ma'lumotlaringiz saqlanmasligi mumkin.");
    }
}

// ============================================================
// CLOUDFLARE TURNSTILE (CAPTCHA) — bot himoyasi
// ============================================================
// Sayt kaliti (sitekey) serverdan `/api/config` orqali keladi; maxfiy kalit
// hech qachon brauzerga tushmaydi — tekshiruv serverda (siteverify) bo'ladi.
const TurnstileGate = (() => {
    let siteKey = '';
    let widgetId = null;
    let enforced = false;
    let loadPromise = null;

    function setStatus(text, isError) {
        const el = document.getElementById('turnstileStatus');
        if (!el) return;
        el.textContent = text || '';
        el.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--muted)';
    }

    function ensureScript() {
        if (loadPromise) return loadPromise;
        loadPromise = new Promise(resolve => {
            window.onTurnstileApiLoad = () => resolve(true);
            const s = document.createElement('script');
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileApiLoad';
            s.async = true;
            s.defer = true;
            s.onerror = () => {
                setStatus('CAPTCHA skripti yuklanmadi (tarmoq yoki CSP)', true);
                resolve(false);
            };
            document.head.appendChild(s);
            setTimeout(() => resolve(true), 8000);
        });
        return loadPromise;
    }

    async function init(config) {
        const wrap = document.getElementById('turnstileWrap');
        if (!wrap) return;
        siteKey = String(config?.turnstileSiteKey || '');
        enforced = !!config?.turnstileEnforced;
        if (!siteKey || !config?.turnstileEnabled) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'block';
        setStatus('Bot himoyasi yuklanmoqda...');
        await ensureScript();
        for (let i = 0; i < 40 && !window.turnstile; i++) {
            await new Promise(r => setTimeout(r, 200));
        }
        if (!window.turnstile || typeof window.turnstile.render !== 'function') {
            setStatus('CAPTCHA yuklanmadi — Sozlamalar → Xavfsizlik bo\'limini tekshiring', true);
            return;
        }
        try {
            widgetId = window.turnstile.render('#turnstileWidget', {
                sitekey: siteKey,
                theme: 'auto',
                callback: () => setStatus('✔ Himoya tasdiqlandi'),
                'expired-callback': () => setStatus('Tasdiq muddati tugadi — qayta belgilang'),
                'error-callback': () => setStatus('CAPTCHA xatosi — sahifani yangilang', true),
            });
            setStatus(enforced ? "Botlarga qarshi himoya — iltimos, tasdiqlang" : '');
        } catch (e) {
            console.warn('Turnstile render xatosi:', e);
            setStatus('CAPTCHA chizilmadi — sahifani yangilang', true);
        }
    }

    /** Joriy CAPTCHA tokeni (bo'sh bo'lsa hali tasdiqlanmagan). */
    function token() {
        try {
            if (widgetId === null || !window.turnstile) return '';
            return window.turnstile.getResponse(widgetId) || '';
        } catch (e) {
            return '';
        }
    }

    /** Har urinishdan keyin yangi token talab qilinadi. */
    function reset() {
        try {
            if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
        } catch (e) { }
        if (siteKey) setStatus('Qayta tasdiqlang');
    }

    return { init, token, reset, isEnforced: () => enforced, hasWidget: () => widgetId !== null };
})();

// ============================================================
// SERVER AVTORIZATSIYASI (token) — xodimlar uchun
// ============================================================
// Parol tekshiruvi serverda (app.py) bajariladi va brauzer faqat imzolangan
// tokenni saqlaydi. Server javob bermasa (oflayn), tizim lokal tekshiruvga
// qaytadi — o'shanda ma'lumot faqat shu brauzerda qoladi.
let staffToken = '';
try { staffToken = sessionStorage.getItem('tp_token') || ''; } catch (e) { staffToken = ''; }
let serverOnline = false;

function authHeaders(extra) {
    const headers = Object.assign({}, extra || {});
    if (staffToken) headers['Authorization'] = 'Bearer ' + staffToken;
    return headers;
}

function setStaffToken(token) {
    staffToken = String(token || '');
    try {
        if (staffToken) sessionStorage.setItem('tp_token', staffToken);
        else sessionStorage.removeItem('tp_token');
    } catch (e) { }
}

function clearStaffToken() {
    staffToken = '';
    serverOnline = false;
    try { sessionStorage.removeItem('tp_token'); } catch (e) { }
}

/** Server orqali login.
 *  401  => parol/login xato
 *  429  => juda ko'p urinish (brute-force himoyasi serverda)
 *  xato => oflayn rejim (lokal tekshiruvga qaytamiz) */
async function serverLogin(login, password) {
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                login: login,
                password: password,
                // Cloudflare Turnstile tokeni (sozlanmagan bo'lsa bo'sh qoladi)
                turnstileToken: (typeof TurnstileGate !== 'undefined' ? TurnstileGate.token() : '')
            })
        });
        const data = await res.json().catch(() => null);
        if (res.status === 401) return { ok: false, invalid: true, message: data?.message };
        if (res.status === 429) return { ok: false, blocked: true, message: data?.message };
        if (data?.code === 'captcha_failed') {
            return { ok: false, captcha: true, message: data?.message || 'CAPTCHA tasdiqlanmadi' };
        }
        if (!res.ok || !data?.token) return { ok: false, offline: true, message: data?.message };
        return { ok: true, user: data.user, token: data.token, mustChange: !!data.mustChangePassword };
    } catch (e) {
        return { ok: false, offline: true };
    }
}

/** Token eskirgan/bloklangan bo'lsa — xavfsiz tarzda sessiyani yopadi. */
function handleSessionExpired() {
    if (!staffToken) return;
    clearStaffToken();
    if (currentUser && currentUser.role !== 'customer') {
        showNotif('warning', 'Sessiya tugadi', 'Xavfsizlik uchun tizimga qaytadan kiring');
    }
}

// ============================================================
// BAZA BILAN SINXRONIZATSIYA
// ============================================================
// Barcha ma'lumot turlari bazada (`store_data` jadvali) saqlanadi:
// mahsulot, mijoz, savdo, log, shartnoma, sozlama, kategoriya, chegirma,
// SMS tarixi, maosh yozuvlari va xavfsizlik jurnali.
function readLocalJSON(key, fallback) {
    const parsed = safeJsonParse(localStorage.getItem(key) || 'null', null);
    return parsed === null ? fallback : parsed;
}

// Bazaga allaqachon yuborilgan rasmlar (takroran yubormaslik uchun).
// Rasm bir marta yuboriladi; keyingi sinxronizatsiyalarda `imgKeep: true`
// belgisi ketadi va server bazadagi rasmni o'zgarishsiz qoldiradi.
// Bu 900 KB'lik base64 rasmni har sekundda qayta yuborishni oldini oladi.
var _syncedImageKeys = new Set();
var _pendingImageKeys = [];

function productImageKey(p) {
    const img = p?.img || '';
    if (!isImageDataUrl(img)) return '';
    return `${p.id}:${img.length}:${img.slice(-40)}`;
}

/** Bazaga yuboriladigan to'liq holat (snapshot). */
function buildSyncPayload() {
    let contractsPayload = [];
    try { contractsPayload = Array.isArray(contracts) ? contracts : []; } catch (e) { contractsPayload = []; }

    _pendingImageKeys = [];
    const productsPayload = products.map(p => {
        const key = productImageKey(p);
        if (!key) return p;
        if (_syncedImageKeys.has(key)) return { ...p, img: '', imgKeep: true };
        _pendingImageKeys.push(key);
        return p;
    });

    return {
        products: productsPayload,
        customers: customers,
        sales: salesHistory,
        logs: logs,
        contracts: contractsPayload,
        settings: systemSettings,
        categories: CATEGORIES,
        discounts: readLocalJSON('tp_discounts', []),
        smsHistory: readLocalJSON('tp_sms_history', []),
        salaryRecords: readLocalJSON('tp_salary_records', []),
        salaryHistory: readLocalJSON('tp_salary_history', []),
        securityLog: readLocalJSON('tp_security_log', [])
    };
}

// Sync with backend API — faqat xodim tokeni bo'lsa yoziladi
/**
 * Bazaga yozish. Muvaffaqiyatli bo'lsa `true`, aks holda `false` qaytaradi.
 * 401 — sessiya tugagan; 403 — huquq yo'q (qayta urinish foydasiz).
 */
async function _pushSync() {
    try {
        const res = await fetchWithTimeout('/api/sync', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(buildSyncPayload())
        }, SYNC_TIMEOUT_MS);
        if (res.status === 401) {
            _pendingImageKeys = [];
            handleSessionExpired();
            return true;   // qayta urinish kerak emas — sessiya yangilanishi so'raladi
        }
        if (res.status === 403) {
            // Huquq yo'q / CAPTCHA bloklashi — sessiya o'chirilmaydi
            console.warn('Bazaga yozish rad etildi (403)');
            return true;   // takrorlash foydasiz
        }
        if (!res.ok) {
            console.warn('Bazaga yozishda xatolik (HTTP ' + res.status + ')');
            return false;  // 5xx kabi vaqtinchalik xatolar — qayta uriniladi
        }
        _pendingImageKeys.forEach(k => _syncedImageKeys.add(k));
        _pendingImageKeys = [];
        serverOnline = true;
        return true;
    } catch (e) {
        console.warn('Backend sync failed (offline or no backend):', e);
        serverOnline = false;
        return false;
    }
}

// Yozilmagan ma'lumot qolib ketmasligi uchun qayta urinish (1.5s → 60s)
var _syncRetryTimer = null;
var _syncRetryDelay = 1500;
var _syncDirty = false;

function _scheduleSyncRetry() {
    if (_syncRetryTimer || !staffToken) return;
    const delay = _syncRetryDelay;
    _syncRetryDelay = Math.min(Math.round(_syncRetryDelay * 2), 60000);
    _syncRetryTimer = setTimeout(async () => {
        _syncRetryTimer = null;
        if (!staffToken) return;
        if (await _pushSync()) {
            _syncDirty = false;
            _syncRetryDelay = 1500;
            if (typeof Fiscal !== 'undefined' && Fiscal.scheduleRetry) Fiscal.scheduleRetry();
        } else {
            _scheduleSyncRetry();
        }
    }, delay);
}

async function syncWithBackend() {
    if (!staffToken) return false;
    _syncDirty = true;
    const ok = await _pushSync();
    if (ok) {
        _syncDirty = false;
        _syncRetryDelay = 1500;
        if (_syncRetryTimer) { clearTimeout(_syncRetryTimer); _syncRetryTimer = null; }
    } else if (_syncDirty) {
        _scheduleSyncRetry();
    }
    return ok;
}

/**
 * Kutib turgan yozishni darhol serverga yuboradi.
 * Fiskal chek chiqarishdan oldin savdo server bazasida mavjud bo'lishi kerak.
 */
async function flushSyncNow() {
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    if (!staffToken) return false;
    await syncWithBackend();
    return true;
}

// Ketma-ket o'zgarishlarda bazaga bir marta yozish uchun (debounce)
// `var` — fayl boshida chaqirilsa ham xato bermasligi uchun
var _syncTimer = null;
function scheduleSyncWithBackend(delay = 1000) {
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => {
        _syncTimer = null;
        syncWithBackend();
    }, delay);
}

async function loadFromBackend() {
    try {
        // Fetch config from .env via Python API
        try {
            const configResponse = await fetch('/api/config');
            const config = await configResponse.json();
            if (config) {
                // Initialize Google Sign-in dynamically
                const btnContainer = document.getElementById("googleBtnContainer");
                if (config.googleClientId && window.google) {
                    window.google.accounts.id.initialize({
                        client_id: config.googleClientId,
                        callback: handleCredentialResponse,
                        context: 'signin',
                        ux_mode: 'popup',
                        auto_prompt: false
                    });
                    if (btnContainer) {
                        btnContainer.innerHTML = '';
                        window.google.accounts.id.renderButton(
                            btnContainer,
                            { type: "standard", shape: "pill", theme: "outline", text: "signin_with", size: "large", width: 320 }
                        );
                    }
                } else {
                    if (btnContainer) {
                        btnContainer.innerHTML = `
                            <button type="button" class="google-custom-btn" onclick="simulateGoogleSignIn()">
                                <i class="fab fa-google google-icon"></i>
                                <span>Google orqali kirish</span>
                            </button>
                        `;
                    }
                }

                // Cloudflare Turnstile (CAPTCHA) — bo'lsa login formasida ko'rsatiladi
                if (typeof TurnstileGate !== 'undefined') TurnstileGate.init(config);

                // Set Click API details from env if present
                if (config.clickMerchantId) systemSettings.clickMerchantId = config.clickMerchantId;
                if (config.clickServiceId) systemSettings.clickServiceId = config.clickServiceId;
                if (config.clickMerchantUserId) systemSettings.clickMerchantUserId = config.clickMerchantUserId;
                if (config.clickPhone) systemSettings.clickPhone = config.clickPhone;
                // Payme kassa ID (ochiq identifikator)
                if (config.paymeMerchantId) systemSettings.paymeMerchantId = config.paymeMerchantId;
                // Kafolat muddati .env'dan (agar lokal sozlama o'zgartirilmagan bo'lsa)
                if (config.warrantyMonths && !localStorage.getItem('tp_settings')) {
                    systemSettings.contractWarrantyMonths = Math.max(1, Number(config.warrantyMonths) || 12);
                }
            }
        } catch (err) {
            console.warn('Failed to load credentials from env config API:', err);
        }

        // To'liq baza faqat xodim tokeni bilan ochiladi (server RBAC)
        const response = await fetch('/api/data', { headers: authHeaders() });
        if (response.status === 401 || response.status === 403) {
            console.warn('Xodim tokeni yo\'q yoki eskirgan — faqat ommaviy katalog yuklanadi');
            clearStaffToken();
            await loadPublicCatalog();
            return;
        }
        const data = await response.json();
        serverOnline = true;
        // Bazadagi rasmlar haqiqiy holat — takror yuborish hisobini tozalaymiz
        _syncedImageKeys.clear();
        _pendingImageKeys = [];
        if (data && Object.keys(data).length > 0) {
            if (data.products) products = data.products.map(normalizeProduct);
            if (data.customers) customers = data.customers.map(normalizeCustomer);
            if (data.sales) salesHistory = data.sales;
            if (data.logs) logs = data.logs;
            if (Array.isArray(data.contracts)) {
                contracts = data.contracts.map(normalizeContract).filter(c => c && c.customer);
            }
            if (data.settings) systemSettings = { ...systemSettings, ...data.settings };

            // Boshqa bo'limlar ma'lumotini ham bazadan tiklaymiz
            // (kategoriya, chegirma, SMS tarixi, maosh, xavfsizlik jurnali)
            if (Array.isArray(data.categories)) {
                const cats = data.categories.map(c => cleanText(c, 60)).filter(Boolean);
                if (cats.length) {
                    CATEGORIES = cats;
                    localStorage.setItem('tp_categories', JSON.stringify(CATEGORIES));
                }
            }
            if (Array.isArray(data.discounts)) {
                discountCampaigns = data.discounts;
                localStorage.setItem('tp_discounts', JSON.stringify(discountCampaigns));
            }
            if (Array.isArray(data.smsHistory)) {
                try { localStorage.setItem('tp_sms_history', JSON.stringify(data.smsHistory)); } catch (e) { }
            }
            if (Array.isArray(data.salaryRecords)) {
                try { localStorage.setItem('tp_salary_records', JSON.stringify(data.salaryRecords)); } catch (e) { }
            }
            if (Array.isArray(data.salaryHistory)) {
                try { localStorage.setItem('tp_salary_history', JSON.stringify(data.salaryHistory)); } catch (e) { }
            }
            if (Array.isArray(data.securityLog)) {
                securityEvents = data.securityLog;
                try { localStorage.setItem('tp_security_log', JSON.stringify(securityEvents)); } catch (e) { }
            }

            // Save to local storage as fallback cache
            // (rasmlar oxirigacha faqat bazada saqlanadi — kesh kvotasini
            //  to'ldirmaslik uchun keshga havola yozilmaydi)
            localStorage.setItem('tp_products', JSON.stringify(products.map(productForCache)));
            localStorage.setItem('tp_customers', JSON.stringify(customers));
            localStorage.setItem('tp_sales', JSON.stringify(salesHistory));
            localStorage.setItem('tp_logs', JSON.stringify(logs));
            try { localStorage.setItem('tp_contracts', JSON.stringify(contracts)); } catch (e) { }

            // Re-render shop and UI components
            renderShop();
            renderCatTabs();
            renderProductGrid();
            renderProducts();
            renderCustomers();
            renderEmployees();
            renderSMS();
            renderLogs();
            renderReports();
            loadDashboard();
            renderCategoriesPage();
            renderWarehousePage();
            renderDiscountsPage();
            renderSecurityPanel();
            // Maosh moduli o'z holatini localStorage'dan qayta o'qiydi
            if (typeof SalaryModule !== 'undefined' && typeof SalaryModule.init === 'function') SalaryModule.init();
            if (document.getElementById('contractsTable')) Contracts.render();
            updateContractsBadge();
            await PaymentGateway.refreshConfig(false);

            console.log('Loaded data from backend successfully');
        } else {
            console.log('Backend database is empty. Seeding defaults...');
            await syncWithBackend();
        }
    } catch (e) {
        console.warn('Failed to load from backend. Using local storage:', e);
    }
}

/**
 * Ommaviy katalog — xaridor/mehmon uchun.
 * Server bu yerda faqat mahsulot va kategoriyalarni qaytaradi:
 * mijoz shaxsiy ma'lumotlari, savdo tarixi va jurnal YUBORILMAYDI.
 */
async function loadPublicCatalog() {
    try {
        const res = await fetch('/api/catalog');
        const data = await res.json().catch(() => null);
        if (!data) return;
        if (Array.isArray(data.products)) {
            products = data.products.map(normalizeProduct);
            localStorage.setItem('tp_products', JSON.stringify(products.map(productForCache)));
        }
        if (Array.isArray(data.categories) && data.categories.length) {
            const cats = data.categories.map(c => cleanText(c, 60)).filter(Boolean);
            if (cats.length) {
                CATEGORIES = cats;
                try { localStorage.setItem('tp_categories', JSON.stringify(CATEGORIES)); } catch (e) { }
            }
        }
        renderShop();
        renderCatTabs();
        renderProductGrid();
        renderProducts();
        renderCategoriesPage();
        renderWarehousePage();
        console.log('Ommaviy katalog yuklandi (mehmon rejimi)');
    } catch (e) {
        console.warn('Katalogni yuklab bo\'lmadi:', e);
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
    if (indicator) indicator.classList.add('scanning');
    const status = document.getElementById('barcodeStatus');
    if (status) status.textContent = `Skanerlandi: ${code}`;
    setTimeout(() => {
        if (indicator) indicator.classList.remove('scanning');
        if (status) status.textContent = 'Barkod skaner tayyor — USB/Bluetooth ulang';
    }, 1500);

    // Find by barcode or by code in name
    let p = products.find(x => x.barcode === code);
    if (!p) p = products.find(x => x.id === parseInt(code));
    if (!p) p = products.find(x => x.name.toLowerCase().includes(code.toLowerCase()));

    if (p) {
        addToCart(p.id, true); // isScan=true
        const pagePos = document.getElementById('page-pos');
        if (pagePos && pagePos.classList.contains('active')) {
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

function toggleEmployeeDropdown(e) {
    if (e) e.stopPropagation();
    const dp = document.getElementById('topbarEmployeeDropdown');
    if (!dp) return;
    const isShowing = dp.style.display === 'block';
    
    // Close other dropdowns first
    document.querySelectorAll('.employee-dropdown-menu').forEach(d => d.style.display = 'none');
    
    if (!isShowing) {
        dp.style.display = 'block';
        renderEmployeeDropdown();
    } else {
        dp.style.display = 'none';
    }
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
    const container = document.querySelector('.employee-dropdown-container');
    if (container && !container.contains(e.target)) {
        const dp = document.getElementById('topbarEmployeeDropdown');
        if (dp) dp.style.display = 'none';
    }
});

function renderEmployeeDropdown() {
    const dp = document.getElementById('topbarEmployeeDropdown');
    if (!dp) return;
    
    const isLoggedIn = currentUser && currentUser.role !== 'customer';
    
    let html = `
        <div class="employee-dropdown-item" onclick="showEmployeeProfile()">
            <i class="fas fa-user-circle" style="width:16px; margin-right:8px;"></i>
            <span>Profil</span>
        </div>
        <div class="employee-dropdown-item" onclick="goTo('page-settings', document.getElementById('nav-settings')); document.getElementById('topbarEmployeeDropdown').style.display='none';">
            <i class="fas fa-cog" style="width:16px; margin-right:8px;"></i>
            <span>Sozlamalar</span>
        </div>
        <div class="employee-dropdown-item" onclick="openEmployeeLogin(); document.getElementById('topbarEmployeeDropdown').style.display='none';">
            <i class="fas fa-sign-in-alt" style="width:16px; margin-right:8px;"></i>
            <span>Kirish</span>
        </div>
        <div class="employee-dropdown-item" onclick="triggerEmployeeRegistration()">
            <i class="fas fa-user-plus" style="width:16px; margin-right:8px;"></i>
            <span>Ro'yxatdan o'tish</span>
        </div>
    `;
    
    if (isLoggedIn) {
        html += `
            <div class="employee-dropdown-item logout" onclick="doLogout(); document.getElementById('topbarEmployeeDropdown').style.display='none';">
                <i class="fas fa-sign-out-alt" style="width:16px; margin-right:8px;"></i>
                <span>Tizimdan chiqish</span>
            </div>
        `;
    }
    
    dp.innerHTML = html;
}

function triggerEmployeeRegistration() {
    document.getElementById('topbarEmployeeDropdown').style.display = 'none';
    if (!currentUser || !['admin', 'manager'].includes(currentUser.role)) {
        playError();
        showNotif('error', 'Ruxsat yo\'q!', 'Faqat Admin yoki Menejer xodimlarni ro\'yxatdan o\'tkazishi mumkin');
        return;
    }
    goTo('page-employees', document.getElementById('nav-employees'));
    if (typeof openEmployeeModal === 'function') {
        openEmployeeModal();
    }
}

function showEmployeeProfile() {
    document.getElementById('topbarEmployeeDropdown').style.display = 'none';
    if (!currentUser || currentUser.role === 'customer') {
        showNotif('info', 'Profil ma\'lumoti', 'Foydalanuvchi: Online Xaridor (Mehmon seansi)');
        return;
    }
    alert(`Foydalanuvchi Profili:\n\nIsm: ${currentUser.name}\nLogin: ${currentUser.login}\nLavozim: ${ROLES[currentUser.role] || currentUser.role}`);
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
async function doLogin() {
    const u = cleanText(document.getElementById('loginUser')?.value, 80).toLowerCase();
    const p = document.getElementById('loginPass')?.value || '';

    if (hasSqlInjectionPattern(u) || hasSqlInjectionPattern(p) || hasXssPattern(u) || hasXssPattern(p)) {
        playError();
        showNotif('error', 'Xavfsizlik!', 'Login ma\'lumotlarida shubhali belgilar topildi');
        securityLog('login-injection-block', 'high', `Login maydonida shubhali belgilar: "${u.slice(0, 40)}"`);
        return;
    }

    // ── Brute-force himoyasi ──
    const guard = loginGuardStatus(u);
    if (guard.locked) {
        playError();
        showNotif('error', 'Kirish bloklangan!',
            `Juda ko'p noto'g'ri urinish. ${guard.minutes} daqiqadan keyin qayta urinib ko'ring.`);
        securityLog('lockout', 'high', `Bloklangan hisobga kirish urinishi: ${u}`);
        return;
    }

    const loginBtn = document.querySelector('#loginPage button[onclick*="doLogin"]');
    if (loginBtn) loginBtn.disabled = true;
    try {
        await attemptLogin(u, p);
    } finally {
        if (loginBtn) loginBtn.disabled = false;
        // Turnstile tokeni bir martalik — muvaffaqiyatsiz urinishdan keyin
        // yangisini olish uchun widget'ni tozalaymiz.
        if (typeof TurnstileGate !== 'undefined' && !currentUser) TurnstileGate.reset();
    }
}

/**
 * Login urinishi:
 *   1) avval SERVER tekshiradi (parol xeshi, hisob holati, RBAC) — token oladi;
 *   2) server javob bermasa (oflayn) — brauzerdagi lokal tekshiruv ishlatiladi.
 * Server javob berganda parol faqat serverda tekshiriladi.
 */
async function attemptLogin(u, p) {
    // Majburiy CAPTCHA yoqilgan bo'lsa — token bo'lmasa serverga yubormaymiz
    if (typeof TurnstileGate !== 'undefined' && TurnstileGate.isEnforced()
        && TurnstileGate.hasWidget() && !TurnstileGate.token()) {
        playError();
        showNotif('warning', 'Bot himoyasi', 'Iltimos, avval CAPTCHA ni tasdiqlang');
        return;
    }

    const server = await serverLogin(u, p);

    if (server.captcha) {
        playError();
        showNotif('error', 'CAPTCHA', server.message);
        securityLog('captcha-failed', 'medium', 'CAPTCHA tasdiqlanmadi');
        if (typeof TurnstileGate !== 'undefined') TurnstileGate.reset();
        return;
    }

    if (server.blocked) {
        playError();
        showNotif('error', 'Xavfsizlik!',
            server.message || 'Juda ko\'p urinish — birozdan so\'ng qayta harakat qiling');
        securityLog('brute-force', 'high', `Server login limiti ishga tushdi: ${u}`);
        return;
    }

    if (server.ok) {
        setStaffToken(server.token);
        serverOnline = true;
        clearLoginFailures(u);
        const local = findBaseUser(u);
        const role = ['admin', 'cashier', 'manager', 'customer'].includes(server.user?.role)
            ? server.user.role : 'customer';
        finishLogin({
            id: local?.id || Date.now(),
            login: cleanText(server.user?.login, 120) || u,
            name: cleanText(server.user?.name, 120) || u,
            role: role,
            color: local?.color || '#2563EB'
        });
        if (server.mustChange) {
            securityLog('weak-password', 'medium',
                'Standart parol bilan kirildi — almashtirish tavsiya etiladi');
            showNotif('warning', 'Parolni almashtiring',
                'Standart parol ishlatilmoqda — Sozlamalar bo\'limidan yangilang');
        }
        return;
    }

    if (server.invalid) {
        const info = registerLoginFailure(u);
        playError();
        if (info.locked) {
            showNotif('error', 'Hisob bloklandi!',
                `${systemSettings.lockMinutes} daqiqa davomida kirish bloklandi`);
        } else {
            showNotif('error', 'Xato!', `Login yoki parol noto'g'ri (${info.left} urinish qoldi)`);
        }
        return;
    }

    // ── Oflayn rejim: server javob bermadi ──
    console.warn('Server javob bermadi — oflayn tekshiruv ishlatiladi');
    const result = verifyUserLogin(u, p);
    if (!result.ok) {
        const info = registerLoginFailure(u);
        playError();
        if (info.locked) {
            showNotif('error', 'Hisob bloklandi!',
                `${systemSettings.lockMinutes} daqiqa davomida kirish bloklandi`);
        } else {
            showNotif('error', 'Xato!', `Login yoki parol noto'g'ri (${info.left} urinish qoldi)`);
        }
        return;
    }

    clearLoginFailures(u);
    // Eski base64 xesh topilsa — avtomatik kuchli xeshga o'tkazamiz
    if (result.legacy) {
        storeUserPassword(result.user.login, p, result.user.name);
        securityLog('password-upgraded', 'low', `${result.user.login} paroli salted SHA-256 xeshga o'tkazildi`);
    }
    finishLogin(result.user);
}

/** Login muvaffaqiyatli bo'lgach interfeysni tayyorlaydi. */
function finishLogin(user) {
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

    const topName = document.getElementById('topbarEmployeeName');
    if (topName) topName.textContent = user.name;

    Security.startSession(user);
    addLog('Kirish', `${user.name} tizimga kirdi`);
    initApp();
    playSuccess();
    showNotif('success', 'Xush kelibsiz! 👋', user.name + ' — ' + ROLES[user.role]);
    // Aloqa uzilgan paytda chiqmay qolgan fiskal cheklar bo'lsa — qayta urinamiz
    setTimeout(async () => {
        try {
            await Fiscal.loadState(true);
            if (Fiscal.isConfigured()) await Fiscal.retryLocalPending();
        } catch (e) { console.warn('Fiskal chekni tiklash xatosi:', e); }
    }, 2500);
}

function doLogout(force = false) {
    const user = currentUser;
    if (user && !force && !confirm('Tizimdan chiqmoqchimisiz?')) return;
    if (user) addLog('Chiqish', `${user.name} tizimdan chiqdi`);
    if (user) securityLog('logout', 'low', `${user.name} tizimdan chiqdi${force ? ' (majburiy)' : ''}`);
    // Server tokenini ham o'chiramiz (sessiya to'liq yopiladi)
    clearStaffToken();
    Security.endSession(force ? 'majburiy' : 'foydalanuvchi');
    currentUser = null; cart = []; shopCart = [];

    const topName = document.getElementById('topbarEmployeeName');
    if (topName) topName.textContent = 'Xodim';

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
    loadSettings();
    checkClickCallback();
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
    const rDateEl = document.getElementById('rDate');
    if (rDateEl) rDateEl.textContent = new Date().toLocaleDateString('uz-UZ');
    // Sessiya va xavfsizlik nazorati
    Security.init();
    // To'lov tizimlari (POS + online savdo)
    PaymentGateway.init();
    renderPayTypes();
    // Shartnomalar (avtomatik yaratish va sinxronlash)
    Contracts.init(); // faqat holatlarni yangilaydi, shartnoma yaratmaydi
    // Reveal functionality removed for classic tab behavior
    // Init salary module
    SalaryModule.init();
    // Sayohat tugmasi faqat qo'llanmasi bor panellar uchun (xaridorda ko'rinmaydi)
    const hasTour = typeof Tour !== 'undefined' && Tour.isAvailable();
    const tourBtn = document.getElementById('topbarTourBtn');
    if (tourBtn) tourBtn.style.display = hasTour ? '' : 'none';
    const helpTourBtn = document.getElementById('helpTourBtn');
    if (helpTourBtn) helpTourBtn.style.display = hasTour ? '' : 'none';
    // Har bir panel uchun sayohat (birinchi kirishda avtomatik)
    if (typeof Tour !== 'undefined') Tour.maybeAutoStart();
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
        securityLog('page-access-denied', 'medium', `Sahifaga kirish rad etildi: ${pageId}`);
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
        categories: ['Kategoriyalar', 'Kategoriyalar ro\'yxati va mahsulotlar soni'],
        warehouse: ['Ombor', 'Ombor zaxiralari va mahsulotlar hisobi'],
        discounts: ['Chegirmalar', 'Chegirma va promo-kodlar boshqaruvi'],
        contracts: ['Shartnomalar', 'Avtomatik shakllantiriladigan shartnomalar'],
        pos: ['Kassa (POS)', 'F2=To\'lov | Esc=Tozala | F3=Kassa | F8=Chek'],
        settings: ['Sozlamalar', 'Tizim sozlamalari'],
        assistant: ['AI Yordamchi', 'Bazadagi real ko\'rsatkichlar bo\'yicha yordamchi (admin)'],
    };
    if (titles[key]) {
        const t = document.getElementById('pageTitle');
        const st = document.getElementById('pageSubtitle');
        if (t) t.textContent = titles[key][0];
        if (st) st.textContent = titles[key][1];
    }

    // Dynamic page renders
    if (key === 'categories') { if (typeof renderCategoriesPage === 'function') renderCategoriesPage(); }
    if (key === 'warehouse') { if (typeof renderWarehousePage === 'function') renderWarehousePage(); }
    if (key === 'discounts') { if (typeof renderDiscountsPage === 'function') renderDiscountsPage(); }
    if (key === 'contracts') Contracts.render();
    if (key === 'pos') { renderPayTypes(); renderProductGrid(); }
    if (key === 'logs') renderSecurityPanel();
    if (key === 'settings') { Security.renderSettings(); PaymentGateway.renderSettings(); }
    if (key === 'assistant') { Assistant.init(); }

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
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const todaysSales = salesHistory.filter(s => isSameDay(s.date, now));
    const todaysTotal = todaySalesTotal();
    const dSales = document.getElementById('d-sales');
    if (dSales) dSales.textContent = fmt(todaysTotal) + ' so\'m';
    const dOrders = document.getElementById('d-orders');
    if (dOrders) dOrders.textContent = todaysSales.length;
    const dProducts = document.getElementById('d-products');
    if (dProducts) dProducts.textContent = products.length;

    const dCustomers = document.getElementById('d-customers');
    if (dCustomers) dCustomers.textContent = customers.length;

    const dProfit = document.getElementById('d-profit');
    if (dProfit) {
        const totalRevenue = salesHistory.reduce((a, b) => a + b.total, 0);
        const totalProfit = Math.round(totalRevenue * 0.20); // 20% profit margin
        dProfit.textContent = fmt(totalProfit) + ' so\'m';
    }

    const dEmployees = document.getElementById('d-employees');
    if (dEmployees) dEmployees.textContent = employees.length;

    // Stat kartalar ostidagi izohlar — barchasi haqiqiy ma'lumotdan
    const yTotal = salesTotalFor(s => isSameDay(s.date, yesterday));
    const up = todaysTotal >= yTotal;
    uiSetHtml('d-sales-change', yTotal > 0
        ? `<i class="fas fa-arrow-${up ? 'up' : 'down'}"></i> O'tgan kunga nisbatan ${Math.abs(Math.round(((todaysTotal - yTotal) / yTotal) * 100))}%`
        : `<i class="fas fa-clock"></i> O'tgan kun ma'lumoti yo'q`);
    uiSetHtml('d-orders-change', '<i class="fas fa-receipt"></i> O\'rtacha chek: ' + fmt(todaysSales.length ? Math.round(todaysTotal / todaysSales.length) : 0) + ' so\'m');
    uiSetHtml('d-customers-change', '<i class="fas fa-user-check"></i> Faol: ' + customers.filter(c => c.status === 'active').length + ' · VIP: ' + customers.filter(c => c.status === 'vip').length);
    uiSetHtml('d-products-change', '<i class="fas fa-triangle-exclamation"></i> Kam qolgan: ' + products.filter(p => p.stock < 5).length + ' ta');
    uiSetHtml('d-profit-change', '<i class="fas fa-percent"></i> Savdo hajmining 20% marjasi asosida');
    uiSetHtml('d-employees-change', '<i class="fas fa-id-badge"></i> Admin, kassir va menejerlar');

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
        const productSales = {};
        salesHistory.forEach(s => {
            if (s.items) {
                s.items.forEach(item => {
                    productSales[item.name] = (productSales[item.name] || 0) + item.qty;
                });
            }
        });
        
        // Faqat haqiqiy savdo: ma'lumot bo'lmasa ro'yxat bo'sh qoladi
        let topProds = Object.entries(productSales)
            .map(([name, qty]) => ({ name, sales: qty }))
            .sort((a, b) => b.sales - a.sales)
            .slice(0, 5);

        if (topProds.length === 0) {
            topP.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted)"><i class="fas fa-fire" style="font-size:26px;opacity:.3;display:block;margin-bottom:10px"></i>Hali sotuvlar yo\'q</div>';
            setTimeout(() => { initSalesChart(); initPayChart(); }, 100);
            return;
        }
        
        const maxSales = Math.max(...topProds.map(p => p.sales)) || 1;
        topProds = topProds.map(p => ({
            ...p,
            pct: Math.round((p.sales / maxSales) * 100)
        }));

        topP.innerHTML = topProds.map(p => `<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
        <span style="font-weight:600">${p.name}</span>
        <span style="color:var(--primary);font-weight:700">${p.sales} ta</span>
      </div>
      <div class="progress-bar" style="height:6px;border-radius:3px;background:var(--border);overflow:hidden"><div class="progress-fill" style="height:100%;width:${p.pct}%;background:linear-gradient(90deg,var(--primary),var(--warning))"></div></div>
    </div>`).join('');
    }
    setTimeout(() => { initSalesChart(); initPayChart(); }, 100);
}

function loadCashierDashboard() {
    const ts = salesHistory.filter(s => isSameDay(s.date, new Date()) && s.cashier === currentUser?.name);
    const total = ts.reduce((a, b) => a + (Number(b.total) || 0), 0);
    uiSetText('d-sales-cashier', fmt(total) + ' so\'m');
    uiSetText('d-orders-cashier', ts.length + ' ta');
    uiSetText('d-avg-cashier', fmt(ts.length ? Math.round(total / ts.length) : 0) + ' so\'m');
    uiSetHtml('d-sales-cashier-note', '<i class="fas fa-calendar-day"></i> Bugungi ko\'rsatkich');
    uiSetHtml('d-orders-cashier-note', '<i class="fas fa-receipt"></i> Bugungi cheklar');
    uiSetHtml('d-avg-cashier-note', '<i class="fas fa-calculator"></i> O\'rtacha hisob');
    const tbody = document.getElementById('cashier-sales');
    tbody.innerHTML = ts.map(s => `<tr>
    <td>#${String(s.id).padStart(4, '0')}</td>
    <td style="font-size:12px">${escapeHTML(s.time)}</td>
    <td style="color:var(--primary);font-weight:700">${fmt(s.total)} so'm</td>
    <td><span class="badge badge-blue">${escapeHTML(s.pay)}</span></td>
  </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">Bugun savdo yo\'q</td></tr>';
}

function loadManagerDashboard() {
    const now = new Date();
    const todayTotal = todaySalesTotal();
    const todayCount = salesHistory.filter(s => isSameDay(s.date, now)).length;

    const ranked = employees
        .map(e => ({ ...e, ...employeeStats(e) }))
        .sort((a, b) => b.total - a.total);

    uiSetText('m-sales', fmt(todayTotal) + " so'm");
    uiSetText('m-sales-change', todayCount + ' ta chek · ' + salesHistory.length + ' ta jami');
    uiSetText('m-employees', String(employees.length));
    uiSetText('m-employees-change', 'Admin, kassir va menejerlar');
    const top = ranked[0];
    uiSetText('m-top-cashier', top && top.total > 0 ? top.name : '—');
    uiSetText('m-top-cashier-change', top && top.total > 0 ? top.sales + ' ta sotuv · ' + fmt(top.total) + " so'm" : 'Hali savdo yo\'q');

    const tbody = document.getElementById('manager-employees');
    if (!tbody) return;
    tbody.innerHTML = ranked.map((e, i) => `<tr>
    <td><strong>${i + 1}</strong></td><td>${escapeHTML(e.name)}</td><td>${e.sales}</td>
    <td>${fmt(e.total)} so'm</td>
    <td><span class="badge ${e.status === 'active' ? 'badge-green' : 'badge-red'}">${e.status === 'active' ? 'Aktiv' : 'Nofaol'}</span></td>
  </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px">Xodimlar yo\'q</td></tr>';
}

/** Element matnini xavfsiz yangilash (element yo'q bo'lsa jim o'tadi). */
function uiSetText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/** Element HTML'ini xavfsiz yangilash. */
function uiSetHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

/** Bugungi savdo summasi (haqiqiy ma'lumot). */
function todaySalesTotal() {
    return salesTotalFor(s => isSameDay(s.date, new Date()));
}

// ============================================================
// CHARTS
// ============================================================
// ── Real ma'lumot yordamchilari (grafiklar uchun) ────────────
/**
 * Sana yozuvini o'qib, mumkin bo'lgan Date variantlarini qaytaradi.
 * Formatlar: YYYY-MM-DD, YYYY/MM/DD, DD.MM.YYYY, MM/DD/YYYY.
 * Muhim: mahalliy vaqt bo'yicha quriladi (ISO'ning UTC siljishi hisobga olinadi).
 */
function dateParts(dateStr) {
    const raw = String(dateStr || '').trim();
    const out = [];
    if (!raw) return out;

    const nums = raw.match(/\d+/g) || [];
    if (nums.length >= 3) {
        const year = Number(nums.find(n => n.length === 4));
        const rest = nums.filter(n => n.length !== 4).map(Number);
        if (year && rest.length >= 2) {
            // Oy oldinda kelgan format (YYYY-MM-DD, MM/DD/YYYY)
            out.push(new Date(year, rest[0] - 1, rest[1]));
            // Kun oldinda kelgan format (DD.MM.YYYY)
            out.push(new Date(year, rest[1] - 1, rest[0]));
        }
    }

    if (out.length === 0) {
        const direct = new Date(raw);
        if (!isNaN(direct.getTime())) out.push(direct);
    }
    return out;
}

function isSameMonth(dateStr, d) {
    return dateParts(dateStr).some(x => x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth());
}

function isSameDay(dateStr, d) {
    return dateParts(dateStr).some(x => x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate());
}

/** Bugungi savdo summasi (haqiqiy ma'lumot). */
function salesTotalFor(predicate) {
    return salesHistory.filter(predicate).reduce((sum, s) => sum + (Number(s.total) || 0), 0);
}

/** Oxirgi 7 kunlik savdo — kun belgisi va mln so'mdagi qiymat. */
function last7DaysSeries() {
    const names = ['Ya', 'Du', 'Se', 'Cho', 'Pa', 'Ju', 'Sh'];
    const out = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const total = salesTotalFor(s => isSameDay(s.date, d));
        out.push({ label: names[d.getDay()], total: +(total / 1000000).toFixed(2) });
    }
    return out;
}

/** Oxirgi 6 oylik savdo — oy belgisi va mln so'mdagi qiymat. */
function last6MonthsSeries() {
    const names = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyn', 'Iyl', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];
    const now = new Date();
    const out = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const total = salesTotalFor(s => isSameMonth(s.date, d));
        out.push({ label: names[d.getMonth()], total: +(total / 1000000).toFixed(2) });
    }
    return out;
}

/** Mijozlar xarid summasi bo'yicha taqsimoti (haqiqiy ma'lumot). */
function customerSpendBuckets() {
    const buckets = [0, 0, 0, 0, 0];
    customers.forEach(c => {
        const t = Number(c.total) || 0;
        if (t < 5000000) buckets[0]++;
        else if (t < 10000000) buckets[1]++;
        else if (t < 20000000) buckets[2]++;
        else if (t < 50000000) buckets[3]++;
        else buckets[4]++;
    });
    return buckets;
}

function initSalesChart() {
    const canvas = document.getElementById('salesChart'); if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (salesChart) salesChart.destroy();
    const week7 = last7DaysSeries();
    
    // Create gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(255,107,53,0.35)');
    gradient.addColorStop(1, 'rgba(255,107,53,0.01)');

    salesChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: week7.map(d => d.label),
            datasets: [{
                label: 'Savdo (mln so\'m)', data: week7.map(d => d.total),
                borderColor: '#ff6b35', backgroundColor: gradient, fill: true, tension: .4,
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
    // Faqat haqiqiy to'lovlar: ma'lumot bo'lmasa grafik 0 bo'lib turadi
    payChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Naqd', 'Karta', 'Click', 'Kredit', 'Boshqa'],
            datasets: [{
                data: Object.values(totals),
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
    const months = last6MonthsSeries();
    monthChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: months.map(m => m.label),
            datasets: [{
                label: 'Savdo (mln so\'m)', data: months.map(m => m.total),
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
    const incomeMonths = last6MonthsSeries();
    incomeChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: incomeMonths.map(m => m.label),
            datasets: [
                { label: 'Daromad', data: incomeMonths.map(m => m.total), borderColor: '#10B981', tension: .4, fill: false, pointRadius: 4 }
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
                data: [
                    customers.filter(c => c.status === 'active').length,
                    customers.filter(c => c.status === 'vip').length,
                    customers.filter(c => c.status === 'inactive').length
                ],
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
                data: customerSpendBuckets(),
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
    if (document.getElementById('catTabs') && document.getElementById('productGrid')) {
        renderCatTabs();
        renderProductGrid();
    }
}

// POS kategoriya tugmalari — doimiy CATEGORIES ro'yxatidan quriladi,
// shuning uchun mahsulot bo'lmasa ham barcha bo'limlar ko'rinadi.
function renderCatTabs() {
    const el = document.getElementById('catTabs');
    if (!el) return;
    const cats = ['Barchasi', ...CATEGORIES];
    el.innerHTML = cats.map(c => {
        const count = c === 'Barchasi' ? products.length : products.filter(p => p.cat === c).length;
        const active = (c === 'Barchasi' && !posCat) || posCat === c;
        return `<button type="button" class="cat-tab ${active ? 'active' : ''}" data-cat="${escapeHTML(c)}" onclick='filterCat(${JSON.stringify(c)}, this)'>
            <i class="fas ${categoryFaIcon(c)}" style="margin-right:6px;font-size:11px"></i>${escapeHTML(c)}
            <span class="cat-tab-count" style="margin-left:6px;font-size:10px;opacity:.75">${count}</span>
        </button>`;
    }).join('');
}

function filterCat(cat, el) {
    posCat = cat === 'Barchasi' ? '' : cat;
    document.querySelectorAll('#catTabs .cat-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    renderProductGrid();
}

function searchProducts(q) { posFilter = q; renderProductGrid(); }
const debouncedSearch = debounce(searchProducts, 300);
const debouncedSearchProducts = debouncedSearch;

function syncShopSearch(value) {
    const input = document.getElementById('shopSearch');
    if (input) input.value = value;
    renderShop();
    renderSearchSuggestions(value);
}

function renderSearchSuggestions(value) {
    const suggestionsDiv = document.getElementById('searchSuggestions');
    if (!suggestionsDiv) return;

    const val = cleanText(value).trim().toLowerCase();
    if (!val) {
        suggestionsDiv.style.display = 'none';
        suggestionsDiv.innerHTML = '';
        return;
    }

    const matched = products.filter(p =>
        p.stock > 0 &&
        (p.name.toLowerCase().includes(val) || p.cat.toLowerCase().includes(val) || (p.barcode || '').includes(val))
    ).slice(0, 5);

    if (matched.length === 0) {
        suggestionsDiv.innerHTML = '<div style="padding:15px;text-align:center;color:var(--text-secondary)">Hech narsa topilmadi</div>';
        suggestionsDiv.style.display = 'block';
        return;
    }

    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🧺', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Mikrotolqinli Pechlar': '📡', 'Aksessuarlar': '🔌' };

    suggestionsDiv.innerHTML = matched.map(p => {
        const imgSrc = productImageSrc(p.img);
        const imgHTML = imgSrc
            ? `<img src="${escapeHTML(imgSrc)}" class="suggestion-img" onerror="this.style.display='none';this.parentNode.querySelector('.suggestion-placeholder').style.display='flex'">`
            : '';
        const placeholderHTML = `<div class="suggestion-img suggestion-placeholder" style="${imgSrc ? 'display:none' : 'display:flex'}">${icons[p.cat] || '📦'}</div>`;

        return `
            <div class="suggestion-item" onclick="selectSuggestion(${p.id})">
                <div class="suggestion-left">
                    <div style="position:relative;width:40px;height:40px;flex-shrink:0">
                        ${imgHTML}
                        ${placeholderHTML}
                    </div>
                    <div class="suggestion-info">
                        <span class="suggestion-name">${escapeHTML(p.name)}</span>
                        <span class="suggestion-cat">${escapeHTML(p.cat)}</span>
                    </div>
                </div>
                <div class="suggestion-right">
                    <span class="suggestion-price">${fmt(p.price)} so'm</span>
                    <button class="suggestion-add-btn" onclick="event.stopPropagation(); addToShopCart(${p.id})">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    suggestionsDiv.style.display = 'block';
}

function selectSuggestion(id) {
    const p = products.find(x => x.id === id);
    if (p) {
        const marketSearch = document.getElementById('marketSearch');
        if (marketSearch) marketSearch.value = p.name;
        const shopSearch = document.getElementById('shopSearch');
        if (shopSearch) shopSearch.value = p.name;
        renderShop();
    }
    hideSearchSuggestions();
}

function hideSearchSuggestions() {
    const suggestionsDiv = document.getElementById('searchSuggestions');
    if (suggestionsDiv) {
        suggestionsDiv.style.display = 'none';
    }
}

// Close search suggestions on click outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.market-search')) {
        hideSearchSuggestions();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        hideSearchSuggestions();
    }
});

function renderShop() {
    const grid = document.getElementById('shopProductGrid');
    const tabs = document.getElementById('shopCatSidebarList');
    if (!grid || !tabs) return;

    shopFilter = cleanText(document.getElementById('shopSearch')?.value || shopFilter, 80).toLowerCase();
    // Kategoriyalar doimiy ro'yxatdan — mahsulot soni 0 bo'lsa ham ko'rinadi
    const cats = ['Barchasi', ...CATEGORIES];

    tabs.innerHTML = cats.map(c => {
        const count = c === 'Barchasi' ? products.length : products.filter(p => p.cat === c).length;
        return `<button type="button" class="cat-tab ${(!shopCat && c === 'Barchasi') || shopCat === c ? 'active' : ''}" data-cat="${escapeHTML(c)}" onclick='filterShopCat(${JSON.stringify(c)}, this)'>
            <i class="fas ${categoryFaIcon(c)}"></i>
            <span>${escapeHTML(c)}</span>
            <span style="margin-left:auto;font-size:10px;opacity:.7">${count}</span>
        </button>`;
    }).join('');

    const icons = CATEGORY_EMOJI;
    const list = products.filter(p =>
        (!shopCat || p.cat === shopCat) &&
        p.stock > 0 &&
        (!shopFilter || p.name.toLowerCase().includes(shopFilter) || (p.barcode || '').includes(shopFilter))
    );

    // Apply sorting selection
    const sortVal = document.getElementById('shopSortSelect')?.value || 'default';
    if (sortVal === 'price-asc') {
        list.sort((a, b) => a.price - b.price);
    } else if (sortVal === 'price-desc') {
        list.sort((a, b) => b.price - a.price);
    } else if (sortVal === 'name-asc') {
        list.sort((a, b) => a.name.localeCompare(b.name));
    }

    grid.innerHTML = list.map(p => {
        const catImages = {
            'Muzlatgichlar': 'https://images.unsplash.com/photo-1571175432247-fe3702b899f1?auto=format&fit=crop&w=400&q=80',
            'Kir Yuvish Mashinalari': 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=400&q=80',
            'Konditsionerlar': 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=400&q=80',
            'Televizorlar': 'https://images.unsplash.com/photo-1593305841991-05c297ba4575?auto=format&fit=crop&w=400&q=80',
            'Changyutgichlar': 'https://images.unsplash.com/photo-1558317374-067fb5f30001?auto=format&fit=crop&w=400&q=80',
            'Pechlar': 'https://images.unsplash.com/photo-1578643463396-0997cb5328c1?auto=format&fit=crop&w=400&q=80',
            'Mikrotolqinli Pechlar': 'https://images.unsplash.com/photo-1574269909862-7e1d70bb8078?auto=format&fit=crop&w=400&q=80',
            'Aksessuarlar': 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=400&q=80'
        };
        const rawImgSrc = productImageSrc(p.img);
        const imgSrc = rawImgSrc || catImages[p.cat] || 'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=400&q=80';
        
        // Mock rating details
        const rating = (4.4 + ((p.id * 3) % 7) * 0.1).toFixed(1);
        const reviewCount = (p.id * 7 + 12);
        
        // Mock installment
        const monthlyInst = Math.round(p.price / 12);
        
        return `
    <div class="product-card shop-product-card" onclick="addToShopCart(${p.id})" style="position:relative; background:var(--card); border:1px solid var(--border); border-radius:var(--radius-md); overflow:hidden; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); cursor:pointer; display:flex; flex-direction:column; justify-content:space-between; height:100%">
      <div>
        <span class="product-card-badge" style="position:absolute;top:10px;left:10px;background:rgba(15,23,42,0.75);backdrop-filter:blur(6px);padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;color:var(--primary);z-index:2;border:1px solid rgba(255,255,255,0.05)">${escapeHTML(p.cat)}</span>
        <div style="width:100%;height:180px;overflow:hidden;position:relative;background:#1e293b">
          <img class="product-card-img" src="${escapeHTML(imgSrc)}" alt="${escapeHTML(p.name)}" onerror="this.parentNode.querySelector('.product-card-img-placeholder').style.display='flex';this.style.display='none'" style="width:100%;height:100%;object-fit:cover;transition:transform 0.5s ease">
          <div class="product-card-img-placeholder" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:36px;background:var(--border)">
            ${icons[p.cat] || '📦'}
          </div>
        </div>
        <div class="product-card-body" style="padding:14px 14px 0 14px;position:relative">
          <!-- Rating -->
          <div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;font-size:12px;color:#fbbf24">
            <i class="fas fa-star"></i>
            <span style="font-weight:700;color:var(--text)">${rating}</span>
            <span style="color:var(--text-secondary)">(${reviewCount} sharh)</span>
          </div>
          <div class="product-card-name" style="font-weight:700;font-size:14px;color:var(--text);margin-bottom:6px;min-height:36px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHTML(p.name)}</div>
          
          <!-- Installment Tag -->
          <div style="display:inline-block;background:rgba(249,115,22,0.08);border:1px solid rgba(249,115,22,0.15);color:var(--primary);font-size:11px;font-weight:700;padding:3px 6px;border-radius:4px;margin-bottom:8px">
            ${fmt(monthlyInst)} so'm/oyiga
          </div>
        </div>
      </div>
      
      <div style="padding:0 14px 14px 14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px">
          <div>
            <div class="product-card-price" style="font-weight:800;color:var(--text);font-size:16px;line-height:1">${fmt(p.price)} so'm</div>
            <div class="product-card-stock" style="font-size:11px;color:var(--text-secondary);margin-top:4px">Qoldiq: <strong style="color:var(--success)">${p.stock} ta</strong></div>
          </div>
          <button type="button" class="product-add-btn" onclick="(event||window.event).stopPropagation(); addToShopCart(${p.id})" style="background:var(--primary);color:white;width:34px;height:34px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.2s;box-shadow:0 4px 10px rgba(249,115,22,0.3)"><i class="fas fa-cart-plus"></i></button>
        </div>
      </div>
    </div>`;
    }).join('') || '<div style="text-align:center;padding:60px;color:var(--muted);grid-column:1/-1"><div style="font-size:48px;margin-bottom:16px;opacity:.3">🔍</div><p>Mahsulot topilmadi</p></div>';
    updateShopCart();
}

function filterShopCat(cat, el) {
    shopCat = cat === 'Barchasi' ? '' : cat;
    document.querySelectorAll('#shopCatSidebarList .cat-tab').forEach(t => t.classList.remove('active'));
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

function showCartView() {
    const catalog = document.getElementById('shopCatalogView');
    const cart = document.getElementById('shopCartView');
    if (catalog) catalog.style.display = 'none';
    if (cart) {
        cart.style.display = 'block';
        updateShopCart();
    }
}

function showCatalogView() {
    const catalog = document.getElementById('shopCatalogView');
    const cart = document.getElementById('shopCartView');
    if (catalog) catalog.style.display = 'block';
    if (cart) cart.style.display = 'none';
}

function removeItemFromShopCart(id) {
    shopCart = shopCart.filter(x => x.id !== id);
    updateShopCart();
    saveToStorage();
}

function updateShopCart() {
    const box = document.getElementById('uzumCartItems');
    if (!box) return;
    const count = shopCart.reduce((s, x) => s + x.qty, 0);
    const total = shopCart.reduce((s, x) => s + x.price * x.qty, 0);

    const countText = document.getElementById('uzumCartCountText');
    const summaryCount = document.getElementById('uzumSummaryCount');
    const summarySubtotal = document.getElementById('uzumSummarySubtotal');
    const summaryTotal = document.getElementById('uzumSummaryTotal');

    if (countText) countText.textContent = count + ' ta mahsulot';
    if (summaryCount) summaryCount.textContent = count;
    if (summarySubtotal) summarySubtotal.textContent = fmt(total) + ' so\'m';
    if (summaryTotal) summaryTotal.textContent = fmt(total) + ' so\'m';

    // Free delivery progress updates
    const targetVal = 15000000;
    const progressFill = document.getElementById('uzumDeliveryProgressFill');
    const progressVal = document.getElementById('uzumDeliveryProgressValue');
    const progressText = document.getElementById('uzumDeliveryProgressText');
    if (progressFill && progressVal && progressText) {
        const pct = Math.min(100, Math.round((total / targetVal) * 100));
        progressFill.style.width = pct + '%';
        progressVal.textContent = pct + '%';
        if (pct >= 100) {
            progressText.innerHTML = '<span style="color:var(--success)">Tabriklaymiz! Bepul yetkazish mavjud! 🎉</span>';
        } else {
            progressText.textContent = `Bepul yetkazish uchun yana ${fmt(targetVal - total)} so'm xarid qiling`;
        }
    }

    if (!shopCart.length) {
        box.innerHTML = '<div class="cart-empty" style="text-align:center;padding:60px 20px;color:var(--text-secondary)"><i class="fas fa-shopping-basket" style="font-size:48px;margin-bottom:14px;opacity:0.3;color:var(--text-secondary)"></i><p style="font-size:16px;font-weight:700">Savatingiz hozircha bo\'sh</p><p style="font-size:13px;margin-top:6px;opacity:0.7">Katalog sahifasidan mahsulotlar qo\'shing</p></div>';
        const recGrid = document.getElementById('uzumRecommendationsGrid');
        if (recGrid) renderUzumRecommendations();
        return;
    }

    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🧺', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Mikrotolqinli Pechlar': '📡', 'Aksessuarlar': '🔌' };
    box.innerHTML = shopCart.map(item => {
        const p = products.find(x => x.id === item.id) || item;
        const originalPrice = Math.round(item.price * 1.25);
        const imgSrc = productImageSrc(item.img);

        const imgHTML = imgSrc
            ? `<img src="${escapeHTML(imgSrc)}" class="uzum-item-img" onerror="this.style.display='none';this.parentNode.querySelector('.uzum-placeholder').style.display='flex'" alt="">`
            : '';
        const placeholderHTML = `<div class="uzum-item-img uzum-placeholder" style="${imgSrc ? 'display:none' : 'display:flex'}; align-items:center; justify-content:center; font-size:30px; background:var(--border)">${icons[item.cat] || '📦'}</div>`;

        return `
            <div class="uzum-cart-item">
                <div class="uzum-item-left">
                    <div style="position:relative; width:76px; height:76px; flex-shrink:0;">
                        ${imgHTML}
                        ${placeholderHTML}
                    </div>
                    <div class="uzum-item-info">
                        <span class="uzum-item-name">${escapeHTML(item.name)}</span>
                        <span class="uzum-item-cat">${escapeHTML(item.cat)}</span>
                    </div>
                </div>
                
                <div class="uzum-item-right">
                    <div class="uzum-item-qty">
                        <button class="qty-btn" onclick="changeShopQty(${item.id}, -1)">-</button>
                        <span class="qty-num">${item.qty}</span>
                        <button class="qty-btn" onclick="changeShopQty(${item.id}, 1)">+</button>
                    </div>
                    <div class="uzum-item-price-block">
                        <div class="uzum-item-price">${fmt(item.price * item.qty)} so'm</div>
                        <div class="uzum-item-old-price">${fmt(originalPrice * item.qty)} so'm</div>
                    </div>
                    <button class="uzum-item-del-btn" onclick="removeItemFromShopCart(${item.id})">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    renderUzumRecommendations();
}

function renderUzumRecommendations() {
    const grid = document.getElementById('uzumRecommendationsGrid');
    if (!grid) return;

    const cartItemIds = new Set(shopCart.map(item => item.id));
    let list = [];

    if (shopCart.length > 0) {
        const cartCats = new Set(shopCart.map(item => item.cat));
        list = products.filter(p => !cartItemIds.has(p.id) && p.stock > 0 && cartCats.has(p.cat));
    }

    if (list.length < 4) {
        const extra = products.filter(p => !cartItemIds.has(p.id) && p.stock > 0 && !list.some(x => x.id === p.id));
        list = [...list, ...extra];
    }

    list = list.slice(0, 4);
    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🧺', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Mikrotolqinli Pechlar': '📡', 'Aksessuarlar': '🔌' };

    if (list.length === 0) {
        grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-secondary)">Tavsiyalar mavjud emas</p>';
        return;
    }

    grid.innerHTML = list.map(p => {
        const imgSrc = productImageSrc(p.img);
        return `
            <div class="product-card shop-product-card" onclick="addToShopCart(${p.id}); showNotif('success', 'Savatga qo\\'shildi', '${escapeHTML(p.name)}')">
                <span class="product-card-badge" style="position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;color:var(--primary);z-index:2;border:1px solid rgba(255,255,255,0.05)">${escapeHTML(p.cat)}</span>
                <div style="width:100%;height:160px;overflow:hidden;position:relative;border-radius:8px">
                    ${imgSrc
                ? `<img class="product-card-img" src="${escapeHTML(imgSrc)}" alt="${escapeHTML(p.name)}" onerror="this.parentNode.querySelector('.product-card-img-placeholder').style.display='flex';this.style.display='none'" style="width:100%;height:100%;object-fit:cover;">`
                : ''}
                    <div class="product-card-img-placeholder" style="${imgSrc ? 'display:none' : 'display:flex'};width:100%;height:100%;align-items:center;justify-content:center;font-size:36px;background:var(--border)">
                        ${icons[p.cat] || '📦'}
                    </div>
                </div>
                <div class="product-card-body" style="padding:14px;position:relative">
                    <div class="product-card-name" style="font-weight:700;font-size:15px;margin-bottom:6px;min-height:36px">${escapeHTML(p.name)}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
                        <div>
                            <div class="product-card-price" style="font-weight:800;color:var(--text);font-size:16px">${fmt(p.price)} so'm</div>
                            <div class="product-card-stock" style="font-size:12px;color:var(--text-secondary)">Qoldiq: <strong style="color:var(--success)">${p.stock} ta</strong></div>
                        </div>
                        <button type="button" class="product-add-btn" onclick="(event||window.event).stopPropagation(); addToShopCart(${p.id}); showNotif('success', 'Savatga qo\\'shildi', '${escapeHTML(p.name)}')" style="background:var(--primary);color:white;width:32px;height:32px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.2s"><i class="fas fa-plus"></i></button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function checkoutUzumOrder() {
    if (!shopCart.length) { playError(); showNotif('error', 'Savat bo\'sh!', 'Mahsulot tanlang'); return; }

    const phoneInput = document.getElementById('uzumCartPhone');
    const phone = phoneInput ? phoneInput.value.trim() : '';
    if (!phone) {
        playError();
        showNotif('error', 'Xato!', 'Iltimos, telefon raqamingizni kiriting');
        if (phoneInput) phoneInput.focus();
        return;
    }

    const subtotal = shopCart.reduce((s, x) => s + x.price * x.qty, 0);
    const paySelectValue = document.getElementById('uzumPayType')?.value;
    const selectedPay = PAYMENT_PROVIDERS[paySelectValue] ? paySelectValue : 'cash';
    const selectedProvider = PAYMENT_PROVIDERS[selectedPay];
    const isOnline = isOnlineProvider(selectedPay);
    if (isOnline && !providerActive(selectedPay)) {
        playError();
        showNotif('error', `${selectedProvider.label} sozlanmagan`,
            'Iltimos, boshqa to\'lov usulini tanlang yoki qo\'llab-quvvatlashga murojaat qiling');
        return;
    }
    const saleId = salesHistory.length + 1;
    const sale = {
        id: saleId,
        items: JSON.parse(JSON.stringify(shopCart)),
        subtotal,
        disc: 0,
        discAmt: 0,
        total: subtotal,
        pay: selectedProvider.label,
        provider: selectedPay,
        time: new Date().toLocaleTimeString('uz-UZ'),
        date: new Date().toLocaleDateString('uz-UZ'),
        cashier: 'Online do\'kon',
        customer: (currentUser?.role === 'customer' ? currentUser.name : 'Online xaridor') + ` (${phone})`,
        customerId: null,
        status: isOnline ? 'pending' : 'paid'
    };

    if (!isOnline) {
        shopCart.forEach(ci => {
            const p = products.find(x => x.id === ci.id);
            if (p) p.stock = Math.max(0, p.stock - ci.qty);
        });
    }
    salesHistory.push(sale);
    lastCheckoutSale = sale;
    saveToStorage();
    addLog('Online buyurtma', `#${saleId} — ${fmt(subtotal)} so'm (${sale.pay})`);
    shopCart = [];

    // Clear phone input
    if (phoneInput) phoneInput.value = '';

    showCatalogView();
    renderShop();
    renderProducts();
    if (typeof renderProductsTable === 'function') renderProductsTable();
    if (typeof renderSalesHistory === 'function') renderSalesHistory();

    playCheckout();
    if (isOnline) {
        // Online to'lov tasdiqlangach chek va shartnoma shakllanadi
        showNotif('info', 'To\'lov kutilmoqda', `${fmt(subtotal)} so'm — ${selectedProvider.label}`);
        PaymentGateway.start(sale, selectedPay);
        return;
    }
    renderReceipt(sale);
    openModal('checkoutModal');
    // Shartnoma AVTOMATIK tuzilmaydi — administrator «Shartnomalar» bo'limida
    // «Qo'lda shartnoma» yoki «Cheklardan import» orqali o'zi tuzadi.
    showNotif('success', 'Buyurtma qabul qilindi!', `${fmt(subtotal)} so'm — ${sale.pay}`);
}

function renderProductGrid() {
    const el = document.getElementById('productGrid');
    if (!el) return;
    const q = cleanText(posFilter, 80).toLowerCase();
    const list = products.filter(p =>
        (!posCat || p.cat === posCat) &&
        (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q))
    );
    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🫧', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Mikrotolqinli Pechlar': '📡', 'Aksessuarlar': '🔌' };
    el.innerHTML = list.map(p => {
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
    const provider = PAYMENT_PROVIDERS[t];
    if (!provider) return;
    if (isOnlineProvider(t) && !providerActive(t)) {
        playError();
        showNotif('error', `${provider.label} sozlanmagan`,
            'Bu tizim uchun merchant kalitlari serverda kiritilmagan. Sozlamalar → To\'lov tizimlari.');
        securityLog('payment-provider-unconfigured', 'medium', `${provider.label} tanlandi (sozlanmagan)`);
        return;
    }
    payType = t;
    document.querySelectorAll('.pay-type').forEach(x => x.classList.remove('active'));
    if (el) el.classList.add('active');
    // Show/hide credit panel when Kredit selected
    const panel = document.getElementById('creditPanel');
    if (panel) {
        if (t === 'credit') { panel.style.display = 'block'; panel.classList.add('open'); }
        else { panel.style.display = 'none'; panel.classList.remove('open'); }
    }
    renderProviderStatus();
    // Recalculate credit values when switching
    try { updateCreditCalculations(); } catch (e) { }
}

/** Kredit (muddatli to'lov) ma'lumotlarini o'qiydi */
function readCreditInfo() {
    const subtotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
    const disc = Math.min(100, Math.max(0, parseFloat(document.getElementById('discountInput')?.value) || 0));
    const totalAfter = Math.max(0, subtotal - subtotal * disc / 100);
    let down = Math.max(0, Number(document.getElementById('creditDown')?.value) || 0);
    if (down > totalAfter) down = totalAfter;
    const months = Math.max(1, Number(document.getElementById('creditMonths')?.value) || 6);
    const remaining = Math.max(0, totalAfter - down);
    return { down, months, remaining, monthly: Math.ceil(remaining / months) };
}

function checkout() {
    if (!requireRole('admin', 'cashier', 'manager')) return;
    if (cart.length === 0) { playError(); showNotif('error', 'Savat bo\'sh!', 'Mahsulot qo\'shing'); return; }

    const providerId = PAYMENT_PROVIDERS[payType] ? payType : 'cash';
    const provider = PAYMENT_PROVIDERS[providerId];
    const isOnline = isOnlineProvider(providerId);
    if (isOnline && !providerActive(providerId)) {
        playError();
        showNotif('error', `${provider.label} sozlanmagan`,
            'Bu to\'lov tizimi uchun server kalitlari kiritilmagan. Naqd yoki karta bilan davom eting.');
        return;
    }

    const disc = parseFloat(document.getElementById('discountInput')?.value) || 0;
    const subtotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
    const discAmt = subtotal * disc / 100;
    const total = subtotal - discAmt;

    // Naqd/karta to'lovida kassir to'lovni qabul qilganini tasdiqlashi shart —
    // shundan keyingina savdo `paid` bo'ladi va fiskal chek chiqadi.
    if (!isOnline) {
        const accepted = confirm(`To'lov qabul qilindimi?\n\n${fmt(total)} so'm — ${provider.label}\n\n` +
            `OK — to'lov tasdiqlanadi va fiskal chek (QR-kod) chiqariladi.\n` +
            `Bekor qilish — savdo saqlanmaydi va chek chiqmaydi.`);
        if (!accepted) {
            playError();
            showNotif('warning', 'To\'lov tasdiqlanmadi', 'Savdo saqlanmadi — chek chiqarilmadi');
            return;
        }
    }

    // Get selected customer
    const custSel = document.getElementById('cartCustomer');
    const custId = custSel ? parseInt(custSel.value) : null;
    const cust = customers.find(c => c.id === custId);

    const saleId = salesHistory.length + 1;
    const sale = {
        id: saleId, items: JSON.parse(JSON.stringify(cart)),
        subtotal, disc, discAmt, total,
        pay: provider.label,
        provider: providerId,
        time: new Date().toLocaleTimeString('uz-UZ'),
        date: new Date().toLocaleDateString('uz-UZ'),
        cashier: currentUser?.name || 'Noma\'lum',
        customer: cust?.name || 'Noma\'lum',
        customerId: custId || null,
        credit: providerId === 'credit' ? readCreditInfo() : null,
        status: isOnline ? 'pending' : 'paid'
    };
    salesHistory.push(sale);
    lastCheckoutSale = sale;

    // Ombor faqat darhol to'lanadigan usullarda kamayadi
    if (!isOnline) {
        cart.forEach(ci => {
            const p = products.find(x => x.id === ci.id);
            if (p) p.stock = Math.max(0, p.stock - ci.qty);
        });
    }

    // Update customer bonus
    if (cust) {
        cust.orders++;
        cust.total += total;
        cust.bonus += Math.floor(total / 10000);
    }

    saveToStorage();
    addLog('Savdo', `Chek #${saleId} — ${fmt(total)} so'm (${provider.label})`);
    playCheckout();

    if (isOnline) {
        // Online to'lov: tasdiqlangach ombor, chek va shartnoma yangilanadi
        clearCart();
        loadDashboard();
        renderProductGrid();
        showNotif('info', 'To\'lov kutilmoqda', `${fmt(total)} so'm — ${provider.label}`);
        PaymentGateway.start(sale, providerId);
        return;
    }

    renderReceipt(sale);
    openModal('checkoutModal');
    clearCart();
    loadDashboard();
    renderProductGrid();
    // Shartnoma AVTOMATIK tuzilmaydi — administrator «Shartnomalar» bo'limida
    // «Qo'lda shartnoma» yoki «Cheklardan import» orqali o'zi tuzadi.
    showNotif('success', '✅ To\'lov qabul qilindi!', `${fmt(total)} so'm — ${provider.label}`);
    finishPaidSale(sale);
}

/**
 * To'lov tasdiqlangandan keyingi qadam: fiskal chek (QR-kod) chiqarish.
 * Chek faqat shu yerdan keyin chop etiladi — tastiqsiz chek chiqmaydi.
 */
async function finishPaidSale(sale) {
    if (!sale || sale.status !== 'paid') return;
    try { await Fiscal.loadState(); } catch (e) { }
    if (Fiscal.isConfigured()) {
        showNotif('info', 'Fiskal chek', 'OFD orqali QR-kodli chek shakllantirilmoqda...');
        const res = await Fiscal.issue(sale);
        renderReceipt(sale);
        if (!res.ok) {
            playError();
            showNotif('error', 'Fiskal chek chiqmadi', sale.fiscalError || 'OFD javob bermadi');
            // Aloqa uzilgan bo'lsa — bir necha daqiqadan keyin o'zi qayta urinadi
            Fiscal.scheduleRetry();
        } else {
            showNotif('success', 'Fiskal chek tayyor', `QR-kodli chek: ${sale.fiscalNumber || ''}`);
        }
    } else {
        renderReceipt(sale);
    }
    if (document.getElementById('autoPrint')?.checked && Fiscal.canPrint(sale).ok) {
        setTimeout(printReceipt, 500);
    }
}

function renderReceipt(sale) {
    const items = sale.items.map(i =>
        `<div class="r-row"><span>${escapeHTML(i.name)} x${i.qty}</span><span>${fmt(i.price * i.qty)}</span></div>`
    ).join('');

    const isPending = (sale.status === 'pending');
    const statusHeader = isPending ? `
    <div class="payment-success" style="background:rgba(245,158,11,0.1);border-color:rgba(245,158,11,0.2)">
      <div class="success-icon" style="background:#F59E0B;color:white;box-shadow:0 0 10px rgba(245,158,11,0.3)">⏳</div>
      <h2 style="color:#F59E0B">To'lov Kutilmoqda</h2>
      <p style="color:var(--text-secondary)">Click orqali to'lov kutilmoqda — ${sale.time}</p>
      <div class="payment-amount" style="color:#F59E0B">${fmt(sale.total)} so'm</div>
    </div>` : `
    <div class="payment-success">
      <div class="success-icon">✓</div>
      <h2>To'lov Tasdiqlandi!</h2>
      <p>${escapeHTML(sale.cashier)} tomonidan — ${sale.time}</p>
      <div class="payment-amount">${fmt(sale.total)} so'm</div>
    </div>`;

    // Kompaniya ma'lumotlari — Sozlamalar → Kompaniya (qattiq yozilgan ma'lumot yo'q)
    const coName = systemSettings.companyName || 'Kompaniya nomi kiritilmagan';
    const coLines = [systemSettings.companyAddress, systemSettings.companyPhone]
        .filter(Boolean).map(escapeHTML).join('<br>');
    const coTinLine = systemSettings.companyTin ? `<br>STIR: ${escapeHTML(systemSettings.companyTin)}` : '';

    const html = `
    ${statusHeader}
    <div class="receipt" id="receiptForPrint" ${isPending ? 'style="display:none;"' : ''}>
      <h2>${escapeHTML(coName)}</h2>
      <div class="r-center">${coLines || 'Manzil kiritilmagan'}${coTinLine}</div>
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
      <div class="r-row"><span>To'lov turi:</span><span>${escapeHTML(sale.pay)}</span></div>
      <div class="r-barcode">||| ${String(sale.id).padStart(8, '0')} |||</div>
      ${isPending ? '' : Fiscal.statusLine(sale)}
      ${isPending ? '' : Fiscal.qrBlock(sale)}
      <hr>
      <div class="r-center">Rahmat xarid uchun! 🙏<br>⭐⭐⭐⭐⭐</div>
    </div>`;

    let clickBox = '';
    if (sale.pay === 'Click') {
        const clickUrl = getClickUrl(sale.total, sale.id);
        const ussdCode = `*880*1*${systemSettings.clickServiceId || '33303'}*${sale.total}#`;
        if (isPending) {
            clickBox = `
            <div class="click-payment-box" style="margin-top:20px;padding:24px;border-radius:16px;background:rgba(0,162,235,0.06);border:1px solid rgba(0,162,235,0.2);text-align:center;font-family:'Inter',sans-serif">
              <div class="click-spinner" style="width:40px;height:40px;border:4px solid rgba(0,162,235,0.1);border-top-color:#00a2eb;border-radius:50%;animation:click-spin 1s linear infinite;margin:0 auto 16px;"></div>
              <style>
                @keyframes click-spin { to { transform: rotate(360deg); } }
              </style>
              <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px">
                <strong style="color:#00a2eb;font-size:16px;letter-spacing:0.5px">CLICK TO'LOVI KUTILMOQDA</strong>
              </div>
              <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">Iltimos, ochilgan oynada to'lovni tasdiqlang yoki quyidagi QR kodni skanerlang. To'lov amalga oshirilgach, chek avtomatik ravishda tayyor bo'ladi.</p>
              
              <div style="background:white;padding:8px;display:inline-block;border-radius:10px;margin-bottom:16px;box-shadow:0 4px 12px rgba(0,0,0,0.1)">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(clickUrl)}" alt="Click QR Code" style="display:block;width:150px;height:150px">
              </div>
              
              <div style="margin-bottom:16px">
                <a href="javascript:void(0)" onclick="openClickPopup('${clickUrl}')" class="btn" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;background:#00a2eb;color:white;border:none;padding:12px 24px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px;box-shadow:0 4px 10px rgba(0,162,235,0.2);transition:all 0.2s">
                  <i class="fas fa-external-link-alt"></i> Oynani qayta ochish
                </a>
              </div>
              
              <div style="font-size:11px;color:var(--text-muted);border-top:1px dashed var(--border);padding-top:12px">
                <div>Click Lite (USSD) orqali:</div>
                <code style="display:inline-block;margin-top:4px;padding:4px 8px;background:var(--bg);border-radius:6px;font-weight:700;color:var(--primary);font-size:12px">${ussdCode}</code>
              </div>
            </div>`;
        } else {
            clickBox = `
            <div class="click-payment-box" style="margin-top:20px;padding:16px;border-radius:12px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);text-align:center;">
              <div style="color:#10B981;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;gap:6px">
                <i class="fas fa-check-circle"></i> Click To'lovi Muvaffaqiyatli Yakunlandi
              </div>
            </div>`;
        }
    }

    document.getElementById('receiptContent').innerHTML = html + clickBox + Fiscal.actionBox(sale);
    // Chop etish maydoniga ham aynan shu ko'rinish tushadi (QR rasm bilan)
    document.getElementById('printArea').innerHTML = `<div class="receipt">${document.getElementById('receiptForPrint')?.innerHTML || ''}</div>`;
    Fiscal.applyPrintState(sale);
}

function openClickPopup(url) {
    const width = 520;
    const height = 650;
    const left = (window.screen.width / 2) - (width / 2);
    const top = (window.screen.height / 2) - (height / 2);
    window.open(url, 'ClickPaymentPopup', `width=${width},height=${height},top=${top},left=${left},resizable=yes,scrollbars=yes,status=no,location=no`);
}

function startClickPaymentPolling(saleId) {
    if (clickPollingInterval) clearInterval(clickPollingInterval);
    
    clickPollingInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/payment/status/${saleId}`);
            const data = await res.json();
            
            if (data.status === 'paid') {
                clearInterval(clickPollingInterval);
                clickPollingInterval = null;
                
                const sale = salesHistory.find(s => s.id === saleId);
                if (sale) {
                    sale.status = 'paid';
                    sale.items.forEach(ci => {
                        const p = products.find(x => x.id === ci.id);
                        if (p) p.stock = Math.max(0, p.stock - ci.qty);
                    });
                    
                    saveToStorage();
                    playSuccess();
                    showNotif('success', 'To\'lov tasdiqlandi!', `Click to'lovi muvaffaqiyatli qabul qilindi (Buyurtma #${saleId})`);
                    
                    renderReceipt(sale);
                    finishPaidSale(sale);
                    renderProducts();
                    renderProductGrid();
                    renderShop();
                    if (typeof renderSalesHistory === 'function') renderSalesHistory();
                    if (typeof renderProductsTable === 'function') renderProductsTable();
                }
            }
        } catch (e) {
            console.warn("Error polling payment status:", e);
        }
    }, 3000);
}

async function printReceipt() {
    const sale = lastCheckoutSale;
    if (!sale) { window.print(); return; }

    // 1) To'lov tasdiqlanganini va fiskal chek borligini tekshiramiz
    let gate = Fiscal.canPrint(sale);
    if (!gate.ok && sale.status === 'paid' && Fiscal.isConfigured() && !sale.fiscalSign) {
        // Fiskal chek hali chiqarilmagan — avtomatik chiqarib ko'ramiz
        showNotif('info', 'Fiskal chek', 'OFD orqali chek shakllantirilmoqda...');
        await Fiscal.issue(sale);
        renderReceipt(sale);
        gate = Fiscal.canPrint(sale);
    }
    if (!gate.ok) {
        playError();
        showNotif('error', 'Chek chop etilmadi', gate.reason);
        return;
    }
    if (!gate.fiscal) {
        showNotif('warning', 'Fiskal emas', 'Fiskal modul sozlanmagan — chek QR-kodsiz chiqarildi');
    }

    const area = document.getElementById('printArea');
    // Chek 80mm rejimida — shartnoma A4 rejimi qolib ketmasin
    if (area) area.classList.remove('contract-mode');
    if (area) {
        area.style.display = 'block';
        window.print();
        area.style.display = 'none';
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
    // Filtrda doim barcha kategoriyalar turadi (doimiy ro'yxat)
    const sel = document.getElementById('catFilter');
    if (sel) {
        sel.innerHTML = '<option value="">Barcha</option>' + CATEGORIES
            .map(c => `<option value="${escapeHTML(c)}"${currentCategory === c ? ' selected' : ''}>${escapeHTML(c)}</option>`)
            .join('');
    }
    const cnt = document.getElementById('productCount');
    const list = products.filter(p =>
        (!currentCategory || p.cat === currentCategory) &&
        (!productFilter2 || p.name.toLowerCase().includes(productFilter2.toLowerCase()))
    );
    if (cnt) cnt.textContent = list.length;
    const icons = CATEGORY_EMOJI;
    document.getElementById('productsTable').innerHTML = list.map(p => {
        const imgSrc = productImageSrc(p.img);
        return `<tr>
    <td>
      ${imgSrc
                ? `<img src="${escapeHTML(imgSrc)}" style="width:46px;height:36px;border-radius:8px;object-fit:cover;background:var(--border)" onerror="this.style.display='none'">`
                : `<div style="width:46px;height:36px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:20px">${icons[p.cat] || '📦'}</div>`}
    </td>
    <td><strong>${escapeHTML(p.name)}</strong>${p.ikpu ? '' : ' <span class="badge badge-red" title="Fiskal chek chiqmaydi">IKPU yo\'q</span>'}<br><small style="color:var(--muted)">${escapeHTML(p.desc || '')}</small></td>
    <td><span class="badge badge-blue">${escapeHTML(p.cat)}</span></td>
    <td style="font-weight:700;color:var(--primary)">${fmt(p.price)} so'm</td>
    <td><span class="${p.stock < 5 ? 'badge badge-red' : 'badge badge-green'}">${p.stock} dona</span></td>
    <td><span class="badge ${p.stock > 0 ? 'badge-green' : 'badge-red'}">${p.stock > 0 ? 'Bor' : 'Tugagan'}</span></td>
    <td>
      <button class="btn btn-outline btn-sm" onclick="openProductModal(${p.id})"><i class="fas fa-edit"></i></button>
      <button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="deleteProduct(${p.id})"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Hali mahsulot yo\'q — “Yangi Mahsulot” tugmasi bilan qo\'shing</td></tr>';
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
            document.getElementById('p-ikpu').value = p.ikpu || '';
            document.getElementById('p-package').value = p.packageCode || '';
            document.getElementById('p-vat').value = String(p.vatPercent ?? 12);
        }
    } else {
        ['p-name', 'p-price', 'p-stock', 'p-img', 'p-desc', 'p-barcode', 'p-ikpu', 'p-package'].forEach(i => document.getElementById(i).value = '');
        document.getElementById('p-vat').value = '12';
    }
    updateProductImagePreview(document.getElementById('p-img')?.value || '');
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
    if (!name || !price) { playError(); showNotif('error', 'Xato!', 'Nomi va narxini to\'ldiring'); return; }
    // ── Soliq maydonlari: fiskal chek (QR-kod) chiqishi uchun majburiy ──
    const ikpu = (document.getElementById('p-ikpu').value || '').replace(/\D/g, '').slice(0, 17);
    const packageCode = (document.getElementById('p-package').value || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    const vatParsed = parseFloat(document.getElementById('p-vat').value);
    const vatPercent = Number.isFinite(vatParsed) ? vatParsed : 12;
    if (ikpu.length !== 17) {
        playError();
        showNotif('error', 'IKPU (MXIK) xato',
            'IKPU kodi 17 xonali bo\'lishi shart — soliq organi talab qiladi');
        return;
    }
    if (!packageCode) {
        playError();
        showNotif('error', 'Qadoqlash kodi yo\'q', 'Fiskal chek uchun qadoqlash kodi kiritilishi shart');
        return;
    }
    const taxFields = { ikpu, packageCode, vatPercent };
    if (editingProductId) {
        const p = products.find(x => x.id === editingProductId);
        if (p) Object.assign(p, { name, cat, price, stock, img, desc, barcode }, taxFields);
        addLog('Mahsulot', `"${name}" tahrirlandi`);
        showNotif('success', 'Saqlandi!', 'Mahsulot yangilandi');
    } else {
        products.push(Object.assign({ id: Date.now(), name, cat, price, stock, img, desc, barcode }, taxFields));
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

    // Stat kartalar — faqat haqiqiy mijozlar sonidan
    uiSetText('c-total', customers.length);
    uiSetText('c-active', customers.filter(c => c.status === 'active').length);
    uiSetText('c-vip', customers.filter(c => c.status === 'vip').length);
    uiSetText('c-inactive', customers.filter(c => c.status === 'inactive').length);
    updateCustomersBadge();

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
  </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Hali mijozlar yo\'q — “Yangi Mijoz” tugmasi bilan qo\'shing</td></tr>';
}

/** Menyudagi mijozlar sonini haqiqiy ma'lumot bilan yangilaydi. */
function updateCustomersBadge() {
    uiSetText('navCustomersBadge', customers.length);
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
    const list = employees.map(e => ({ ...e, ...employeeStats(e) }));
    const maxTotal = Math.max(...list.map(e => e.total), 1);
    uiSetHtml('employeesTable', list.map(e => `<tr>
    <td>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="avatar" style="background:linear-gradient(135deg,#8B5CF6,#EC4899);color:white">${escapeHTML(e.name[0] || '?')}</div>
        <strong>${escapeHTML(e.name)}</strong>
      </div>
    </td>
    <td><span class="badge badge-blue">${escapeHTML(ROLES[e.role] || e.role)}</span></td>
    <td>${e.sales} ta</td>
    <td>
      <div style="margin-bottom:4px;font-weight:700">${fmt(e.total)} so'm</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, (e.total / maxTotal) * 100)}%;background:linear-gradient(90deg,var(--primary),var(--warning))"></div></div>
    </td>
    <td>${escapeHTML(e.login)}</td>
    <td><span class="badge ${e.status === 'active' ? 'badge-green' : 'badge-red'}">${e.status === 'active' ? 'Aktiv' : 'Nofaol'}</span></td>
  </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Xodimlar yo\'q</td></tr>');
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
    const ranked = employees.map(e => ({ ...e, ...employeeStats(e) })).sort((a, b) => b.total - a.total);
    const el = document.getElementById('employeeRank');
    if (!el) return;
    if (ranked.length === 0) {
        el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">Xodimlar yo\'q</td></tr>';
        return;
    }
    const maxTotal = Math.max(...ranked.map(e => e.total), 1);
    el.innerHTML = ranked.map((e, i) => `<tr>
    <td><span style="font-weight:800;color:${i === 0 ? '#F59E0B' : i === 1 ? '#9CA3AF' : i === 2 ? '#CD7C2F' : 'var(--muted)'}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span></td>
    <td><div style="display:flex;align-items:center;gap:10px"><div class="avatar" style="background:linear-gradient(135deg,#8B5CF6,#EC4899);color:white">${escapeHTML(e.name[0])}</div>${escapeHTML(e.name)}</div></td>
    <td>${e.sales}</td>
    <td style="font-weight:700;color:var(--primary)">${fmt(e.total)} so'm</td>
    <td><div class="progress-bar" style="width:120px"><div class="progress-fill" style="width:${Math.min(100, (e.total / maxTotal) * 100)}%;background:var(--primary)"></div></div></td>
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

    // Qabul qiluvchilar ro'yxati — haqiqiy mijozlar soni bilan
    const toSel = document.getElementById('smsTo');
    if (toSel) {
        const active = customers.filter(c => c.status === 'active').length;
        const vip = customers.filter(c => c.status === 'vip').length;
        const inactive = customers.filter(c => c.status === 'inactive').length;
        toSel.innerHTML = [
            `Barcha Mijozlar (${customers.length})`,
            `VIP Mijozlar (${vip})`,
            `Faol Mijozlar (${active})`,
            `Nofaol Mijozlar (${inactive})`
        ].map(o => `<option>${escapeHTML(o)}</option>`).join('');
    }

    // SMS tarixi — faqat haqiqiy yuborilgan xabarlar
    const hist = document.getElementById('smsHistory');
    if (hist) {
        const smsHistory = safeJsonParse(localStorage.getItem('tp_sms_history') || '[]', []);
        hist.innerHTML = (Array.isArray(smsHistory) ? smsHistory : []).map(s => `<tr>
    <td style="color:var(--muted);font-size:12px">${escapeHTML(s.time)}</td>
    <td>${escapeHTML(s.to)}</td>
    <td style="font-size:12px;color:var(--muted)">${escapeHTML(s.text)}</td>
    <td><span class="badge badge-green">${escapeHTML(s.status)}</span></td>
  </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px">Hali SMS yuborilmagan</td></tr>';
    }
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
    // Haqiqiy yuborilgan xabarlar tarixini saqlash
    const sent = safeJsonParse(localStorage.getItem('tp_sms_history') || '[]', []);
    const history = Array.isArray(sent) ? sent : [];
    history.unshift({
        time: new Date().toLocaleTimeString('uz-UZ'),
        to: cleanText(to, 120),
        text: cleanText(text.substring(0, 60) + (text.length > 60 ? '...' : ''), 200),
        status: 'yuborildi'
    });
    try { localStorage.setItem('tp_sms_history', JSON.stringify(history.slice(0, 100))); } catch (e) { }
    scheduleSyncWithBackend(); // SMS tarixi bazaga saqlanadi
    playSuccess();
    showNotif('success', 'SMS Yuborildi! ✓', `${to} ga SMS muvaffaqiyatli yuborildi`);
    renderSMS();
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
    scheduleSyncWithBackend(); // bazaga ham yoziladi
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
    scheduleSyncWithBackend();
    renderLogs();
    showNotif('info', 'Tozalandi', 'Loglar o\'chirildi');
}

// ============================================================
// SETTINGS
// ============================================================
function showTab(id, el) {
    document.querySelectorAll('[id^="tab-"]').forEach(t => {
        t.style.display = 'none';
    });
    const tab = document.getElementById(id);
    if (tab) tab.style.display = 'block';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    // Xavfsizlik varag'i ochilganda faol sessiyalar serverdan yangilanadi
    if (id === 'tab-security' && typeof Security !== 'undefined') {
        if (typeof Security.loadServerSessions === 'function') Security.loadServerSessions();
        if (typeof Security.loadCloudflareStatus === 'function') Security.loadCloudflareStatus();
        if (typeof Security.loadFiscalStatus === 'function') Security.loadFiscalStatus(true);
    }
}

function loadSettings() {
    const saved = localStorage.getItem('tp_settings');
    if (saved) {
        systemSettings = safeJsonParse(saved, systemSettings);
    }

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = Boolean(val); };

    setVal('companyName', systemSettings.companyName || '');
    setVal('companyPhone', systemSettings.companyPhone || '');
    setVal('companyAddress', systemSettings.companyAddress || '');
    setVal('companyTin', systemSettings.companyTin || '');
    setVal('clickMerchantId', systemSettings.clickMerchantId || '');
    setVal('clickServiceId', systemSettings.clickServiceId || '');
    setVal('clickMerchantUserId', systemSettings.clickMerchantUserId || '');
    setVal('clickPhone', systemSettings.clickPhone || '');
    setVal('taxRate', systemSettings.taxRate ?? 12);
    setVal('barcodeTimeout', systemSettings.barcodeTimeout ?? 50);
    setChecked('soundEnabled', systemSettings.soundEnabled ?? true);
    setChecked('autoPrint', systemSettings.autoPrint ?? true);
}

function saveSettings() {
    if (!requireRole('admin')) return;

    const getVal = (id) => document.getElementById(id)?.value || '';
    const getChecked = (id) => document.getElementById(id)?.checked ?? false;

    systemSettings.companyName = cleanText(getVal('companyName'), 120);
    systemSettings.companyPhone = cleanText(getVal('companyPhone'), 40);
    systemSettings.companyAddress = cleanText(getVal('companyAddress'), 200);
    systemSettings.companyTin = cleanText(getVal('companyTin'), 20);
    systemSettings.clickMerchantId = cleanText(getVal('clickMerchantId'), 40);
    systemSettings.clickServiceId = cleanText(getVal('clickServiceId'), 40);
    systemSettings.clickMerchantUserId = cleanText(getVal('clickMerchantUserId'), 40);
    systemSettings.clickPhone = cleanText(getVal('clickPhone'), 40);
    systemSettings.taxRate = parseFloat(getVal('taxRate')) || 0;
    systemSettings.barcodeTimeout = parseInt(getVal('barcodeTimeout')) || 50;
    systemSettings.soundEnabled = getChecked('soundEnabled');
    systemSettings.autoPrint = getChecked('autoPrint');

    localStorage.setItem('tp_settings', JSON.stringify(systemSettings));
    scheduleSyncWithBackend(); // sozlamalar bazaga yoziladi

    addLog('Sozlama', 'Tizim sozlamalari saqlandi');
    playSuccess();
    showNotif('success', 'Saqlandi!', 'Sozlamalar muvaffaqiyatli saqlandi');
}

function getClickUrl(amount, saleId) {
    const serviceId = systemSettings.clickServiceId || '33303';
    const merchantId = systemSettings.clickMerchantId || '24564';
    const returnUrl = window.location.origin + window.location.pathname;
    return `https://my.click.uz/services/pay?service_id=${encodeURIComponent(serviceId)}&merchant_id=${encodeURIComponent(merchantId)}&amount=${encodeURIComponent(amount)}&transaction_param=${encodeURIComponent(saleId)}&return_url=${encodeURIComponent(returnUrl)}`;
}

function checkClickCallback() {
    const params = new URLSearchParams(window.location.search);
    const clickTransId = params.get('click_trans_id');
    const merchantTransId = params.get('merchant_trans_id');
    const amount = params.get('amount');

    if (clickTransId && merchantTransId && amount) {
        const orderId = parseInt(merchantTransId);
        const paidAmount = parseFloat(amount);

        // Find the sale in history
        const sale = salesHistory.find(s => s.id === orderId);
        if (sale) {
            // Check if amount matches and status is pending
            if (Math.abs(sale.total - paidAmount) < 0.01) {
                if (sale.status === 'pending') {
                    // Update status
                    sale.status = 'paid';

                    // Deduct stock for all items
                    sale.items.forEach(ci => {
                        const p = products.find(x => x.id === ci.id);
                        if (p) p.stock = Math.max(0, p.stock - ci.qty);
                    });

                    saveToStorage();
                    addLog('To\'lov', `Click orqali to'lov qabul qilindi: Order #${orderId} — ${fmt(paidAmount)} so'm`);
                    playSuccess();
                    showNotif('success', 'To\'lov tasdiqlandi!', `Click to'lovi muvaffaqiyatli qabul qilindi (Order #${orderId})`);

                    // Clean URL query parameters so refresh doesn't replay the verification
                    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
                    window.history.replaceState({ path: cleanUrl }, '', cleanUrl);

                    // Render receipt and show modal
                    renderReceipt(sale);
                    openModal('checkoutModal');
                    renderProducts();
                    renderProductGrid();
                    renderShop();
                } else if (sale.status === 'paid') {
                    showNotif('warning', 'Eslatma', `Ushbu buyurtma (#${orderId}) allaqachon to'langan.`);
                    // Clean URL parameters anyway
                    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
                    window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
                }
            } else {
                showNotif('error', 'Xavfsizlik xatosi!', `To'lov summasi mos kelmadi! Kutilgan: ${fmt(sale.total)} so'm, To'langan: ${fmt(paidAmount)} so'm`);
            }
        } else {
            showNotif('error', 'Buyurtma topilmadi!', `ID: ${orderId} bo'lgan buyurtma tizimda topilmadi.`);
        }
    }
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
    a.download = `TexnoPark_Backup_${new Date().toLocaleDateString('uz-UZ').replace(/\//g, '-')}.json`;
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
function closeModal(id) {
    document.getElementById(id).classList.remove('open');
    if (id === 'checkoutModal' && clickPollingInterval) {
        clearInterval(clickPollingInterval);
        clickPollingInterval = null;
    }
}
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

    // F1 — Sayohat (xodimlar uchun qo'llanma) yoki Yordam oynasi
    if (e.key === 'F1') {
        e.preventDefault();
        if (typeof Tour !== 'undefined' && Tour.isAvailable()) Tour.startTour();
        else openModal('helpModal');
    }
    // F2 — Checkout (from POS)
    if (e.key === 'F2') {
        e.preventDefault();
        const pagePos = document.getElementById('page-pos');
        if (pagePos && pagePos.classList.contains('active')) checkout();
    }
    // F3 — Go to POS
    if (e.key === 'F3') {
        e.preventDefault();
        const pagePos = document.getElementById('page-pos');
        if (pagePos) goTo('page-pos', document.getElementById('navPos'));
    }
    // F8 — Print receipt
    if (e.key === 'F8') { e.preventDefault(); printReceipt(); }
    // Escape — Close modals / clear cart
    if (e.key === 'Escape') {
        const openModals = document.querySelectorAll('.modal-overlay.open');
        if (openModals.length > 0) { openModals.forEach(m => m.classList.remove('open')); }
        else if (!inInput) {
            const pagePos = document.getElementById('page-pos');
            if (pagePos && pagePos.classList.contains('active')) clearCart();
        }
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
        // Maosh ma'lumotlari ham bazaga yoziladi
        if (typeof scheduleSyncWithBackend === 'function') scheduleSyncWithBackend();
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
        // Demo maosh yozuvlari yo'q: jadval bo'sh boshlanadi va faqat
        // real qo'shilgan xodimlar bo'yicha to'ladi.
        return [];
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
        a.download = `TexnoPark_Maosh_${new Date().toLocaleDateString('uz-UZ').replace(/\//g, '-')}.csv`;
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

/* ============================================================
   XAVFSIZLIK MODULI — sessiya, brute-force, parol, audit
   ============================================================ */
let currentSession = null;
let sessionWatchTimer = null;
let sessionWarned = false;
const SESSION_KEY = 'tp_session';
const LOGIN_GUARD_KEY = 'tp_login_guard';

function sessionTimeoutMs() {
    return Math.max(1, Number(systemSettings.sessionTimeoutMin) || 20) * 60000;
}

function minPasswordLength() { return 6; }

// ── Brute-force (login urinishlari) nazorati ──────────────
function loginGuardStore() {
    const store = safeJsonParse(localStorage.getItem(LOGIN_GUARD_KEY) || '{}', {});
    return store && typeof store === 'object' ? store : {};
}

function saveLoginGuardStore(store) {
    try { localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify(store)); } catch (e) { }
}

function loginGuardStatus(loginKey) {
    const key = String(loginKey || '').toLowerCase();
    const store = loginGuardStore();
    const rec = store[key];
    const maxAttempts = Math.max(3, Math.min(10, Number(systemSettings.maxLoginAttempts) || 5));
    if (!rec) return { locked: false, attempts: 0, left: maxAttempts, minutes: 0 };
    const lockUntil = Number(rec.lockUntil) || 0;
    if (lockUntil > Date.now()) {
        return {
            locked: true,
            attempts: Number(rec.attempts) || 0,
            left: 0,
            minutes: Math.max(1, Math.ceil((lockUntil - Date.now()) / 60000))
        };
    }
    if (lockUntil && lockUntil <= Date.now()) {
        delete store[key];
        saveLoginGuardStore(store);
        return { locked: false, attempts: 0, left: maxAttempts, minutes: 0 };
    }
    return {
        locked: false,
        attempts: Number(rec.attempts) || 0,
        left: Math.max(0, maxAttempts - (Number(rec.attempts) || 0)),
        minutes: 0
    };
}

function registerLoginFailure(loginKey) {
    const key = String(loginKey || '').toLowerCase() || 'nomalum';
    const store = loginGuardStore();
    const maxAttempts = Math.max(3, Math.min(10, Number(systemSettings.maxLoginAttempts) || 5));
    const lockMinutes = Math.max(1, Math.min(60, Number(systemSettings.lockMinutes) || 5));
    const rec = store[key] || { attempts: 0, lockUntil: 0, firstTry: Date.now() };
    rec.attempts = (Number(rec.attempts) || 0) + 1;
    rec.lastTry = Date.now();
    let locked = false;
    if (rec.attempts >= maxAttempts) {
        rec.lockUntil = Date.now() + lockMinutes * 60000;
        rec.attempts = 0;
        locked = true;
    }
    store[key] = rec;
    saveLoginGuardStore(store);

    if (locked) {
        securityLog('lockout', 'critical', `Hisob bloklandi (${key}) — ${lockMinutes} daqiqa, ${maxAttempts} noto'g'ri urinish`);
    } else {
        securityLog('login-failed', 'medium',
            `${key} uchun noto'g'ri parol (${rec.attempts}/${maxAttempts})`);
    }
    return { locked, left: Math.max(0, maxAttempts - rec.attempts) };
}

function clearLoginFailures(loginKey) {
    const key = String(loginKey || '').toLowerCase();
    const store = loginGuardStore();
    if (store[key]) {
        delete store[key];
        saveLoginGuardStore(store);
    }
}

// ── Sessiya boshqaruvi ────────────────────────────────────
function startSession(user) {
    const now = Date.now();
    currentSession = {
        token: randomToken(32),
        userId: Number(user?.id) || 0,
        login: String(user?.login || ''),
        role: String(user?.role || ''),
        issuedAt: now,
        lastActivity: now,
        expiresAt: now + sessionTimeoutMs()
    };
    sessionWarned = false;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession)); } catch (e) { }
    securityLog('login-success', 'low', `${user?.name || user?.login} tizimga kirdi (${user?.role})`);
    updateSessionIndicators();
}

function touchSession() {
    if (!currentSession) return;
    const now = Date.now();
    // Bloklangan/eskirgan sessiyani tiklamaymiz
    if (currentSession.expiresAt <= now) return;
    currentSession.lastActivity = now;
    currentSession.expiresAt = now + sessionTimeoutMs();
    sessionWarned = false;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession)); } catch (e) { }
}

function endSession(reason) {
    if (currentSession) {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
    }
    currentSession = null;
    sessionWarned = false;
    updateSessionIndicators();
    if (reason && reason !== 'foydalanuvchi') {
        securityLog('session-ended', 'low', `Sessiya yopildi: ${reason}`);
    }
}

function sessionRemainingText() {
    if (!currentSession || !currentUser) return 'Faol emas';
    const remain = currentSession.expiresAt - Date.now();
    if (remain <= 0) return 'Tugagan';
    const m = Math.floor(remain / 60000);
    const s = Math.floor((remain % 60000) / 1000);
    return `${m} daq ${String(s).padStart(2, '0')} sek`;
}
let securityInitLogged = false;
let lastTouchTs = 0;

function touchSessionThrottled() {
    const now = Date.now();
    if (now - lastTouchTs < 5000) return;
    lastTouchTs = now;
    touchSession();
}

function persistSystemSettings() {
    try { localStorage.setItem('tp_settings', JSON.stringify(systemSettings)); } catch (e) { }
    if (typeof syncWithBackend === 'function') syncWithBackend();
}

function sanitizePassword(value) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function updateSessionIndicators() {
    const text = sessionRemainingText();
    const info = document.getElementById('securitySessionInfo');
    if (info) info.textContent = currentUser ? text : 'Faol emas';
    const status = document.getElementById('secSessionStatus');
    if (status) {
        status.value = currentUser
            ? `${currentUser.name} — ${ROLES[currentUser.role] || currentUser.role} | ${text}`
            : 'Sessiya faol emas';
    }
}

const Security = {
    /** Modulni ishga tushirish: sessiyani tiklash + harakatsizlikni kuzatish */
    init() {
        if (sessionWatchTimer) clearInterval(sessionWatchTimer);
        this.restoreSession();
        sessionWatchTimer = setInterval(() => this.checkSession(), 15000);
        ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach(evt => {
            document.addEventListener(evt, touchSessionThrottled, { passive: true });
        });
        this.renderSettings();
        renderSecurityPanel();
        updateSessionIndicators();
        if (!securityInitLogged) {
            securityInitLogged = true;
            securityLog('security-ready', 'low',
                'Xavfsizlik yadrosi faol: salted SHA-256, brute-force himoyasi, sessiya nazorati, XSS/SQL filtri');
        }
    },

    /** Sahifa yangilanganda amaldagi sessiyani tiklaydi (faqat muddati o'tmagan bo'lsa) */
    restoreSession() {
        if (currentUser) return;
        const sess = safeJsonParse(sessionStorage.getItem(SESSION_KEY) || 'null', null);
        if (!sess || !sess.login || !sess.expiresAt) return;
        if (Number(sess.expiresAt) <= Date.now()) {
            try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
            securityLog('session-expired', 'low', 'Saqlangan sessiya muddati tugagan — qayta kirish talab qilinadi');
            return;
        }
        const user = findBaseUser(sess.login);
        if (!user) return;
        currentUser = user;
        currentSession = sess;
        loginWithUser(user);
        addLog('Sessiya tiklandi', `${user.name} sessiyasi qayta tiklandi`);
        securityLog('session-restored', 'low', `${user.name} sessiyasi tiklandi (token: ...${String(sess.token).slice(-6)})`);
    },

    /** Harakatsizlikni tekshiradi va kerak bo'lsa sessiyani yopadi */
    checkSession() {
        if (!currentSession || !currentUser) { updateSessionIndicators(); return; }
        const now = Date.now();
        const idle = now - Number(currentSession.lastActivity || 0);
        if (now >= Number(currentSession.expiresAt) || idle >= sessionTimeoutMs()) {
            securityLog('session-timeout', 'medium',
                `Harakatsizlik (${Math.round(idle / 60000)} daqiqa) sababli sessiya yopildi`);
            doLogout(true);
            showNotif('warning', 'Sessiya yopildi',
                'Uzoq vaqt harakat bo\'lmadi — xavfsizlik uchun tizimdan chiqdingiz');
            return;
        }
        const remain = Number(currentSession.expiresAt) - now;
        if (remain <= 60000 && !sessionWarned) {
            sessionWarned = true;
            showNotif('warning', 'Sessiya tugayapti',
                '60 soniyadan keyin avtomatik chiqasiz. Davom etish uchun ekranni bosing.');
        }
        updateSessionIndicators();
    },

    /** Sessiyani boshlash (doLogin / Google kirish uchun) */
    startSession(user) {
        startSession(user);
    },

    /** Sessiyani yakunlash */
    endSession(reason) {
        endSession(reason);
        const info = document.getElementById('securitySessionInfo');
        if (info) info.textContent = 'Faol emas';
    },

    /** Xavfsizlik sozlamalari formasini to'ldirish */
    renderSettings() {
        const idle = document.getElementById('secIdleTimeout');
        if (idle) idle.value = String(Number(systemSettings.sessionTimeoutMin) || 20);
        const maxA = document.getElementById('secMaxAttempts');
        if (maxA) maxA.value = String(Number(systemSettings.maxLoginAttempts) || 5);
        const lockM = document.getElementById('secLockMinutes');
        if (lockM) lockM.value = String(Number(systemSettings.lockMinutes) || 5);
        const logL = document.getElementById('secLogLimit');
        if (logL) logL.value = String(Number(systemSettings.securityLogLimit) || 200);
        renderSecurityChecklist();
        updateSessionIndicators();
        this.loadServerSessions();
        this.loadCloudflareStatus();
    },

    /** Serverdagi faol sessiyalar va login/chiqish tarixini yuklaydi (faqat admin). */
    async loadServerSessions(notify = false) {
        const summary = document.getElementById('serverSessionSummary');
        const body = document.getElementById('sessionsTableBody');
        if (!body) return;
        if (!currentUser || currentUser.role !== 'admin') {
            if (summary) summary.textContent = 'Bu panel faqat administrator uchun.';
            body.innerHTML = '';
            return;
        }
        if (!staffToken) {
            if (summary) summary.textContent = 'Oflayn rejim — server sessiyalari ko\'rinmaydi.';
            body.innerHTML = '';
            return;
        }
        if (summary && !notify) summary.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Yuklanmoqda...';
        try {
            const res = await fetch('/api/security/sessions', { headers: authHeaders() });
            if (res.status === 401 || res.status === 403) {
                handleSessionExpired();
                if (summary) summary.textContent = 'Ruxsat yo\'q — tizimga qaytadan kiring.';
                return;
            }
            const data = await res.json().catch(() => null);
            if (!data || !Array.isArray(data.sessions)) {
                if (summary) summary.textContent = 'Ma\'lumot olinmadi.';
                return;
            }
            renderServerSessions(data);
            if (notify) showNotif('success', 'Yangilandi', `${data.count} ta faol sessiya`);
        } catch (e) {
            console.warn('Sessiyalarni yuklab bo\'lmadi:', e);
            if (summary) summary.textContent = 'Serverga ulanib bo\'lmadi (oflayn rejim).';
        }
    },

    /** Cloudflare va sayt domeni holatini ko'rsatadi (SITE_DOMAIN asosida). */
    async loadCloudflareStatus() {
        const box = document.getElementById('cloudflareStatusBox');
        if (!box) return;
        if (!currentUser || currentUser.role !== 'admin') {
            box.textContent = 'Bu panel faqat administrator uchun.';
            return;
        }
        try {
            const data = await apiRequest('/api/security/status');
            const site = data?.site || {};
            const cf = data?.cloudflare || {};
            const sync = cf.domainSync || {};
            const turnstile = cf.turnstileConfigured
                ? ('sozlangan' + (cf.turnstileEnforced ? ' · majburiy' : ' · ixtiyoriy'))
                : 'sozlanmagan';
            const rows = [
                ['Sayt domeni (.env)', site.domain || '(sozlanmagan)'],
                ['Kanonik yo\'naltirish', site.canonicalRedirect ? 'yoqilgan' : 'o\'chirilgan'],
                ['Ruxsat etilgan hostlar', (site.trustedHosts || []).join(', ') || '(cheklanmagan)'],
                ['CORS manbalari', (site.corsOrigins || []).join(', ') || 'barchasi'],
                ['Cloudflare proksi', cf.behindCloudflare ? 'ha (CF-Ray aniqlandi)' : 'yo\'q'],
                ['Haqiqiy mijoz IP', cf.realClientIp || '—'],
                ['Turnstile (CAPTCHA)', turnstile],
                ['Domen sinxronizatsiyasi', `${sync.state || '—'}${sync.message ? ' — ' + sync.message : ''}`],
                ['Widget domenlari', (sync.domains || []).join(', ') || '—'],
            ];
            box.innerHTML = rows.map(([k, v]) => `
                <div style="display:flex;gap:12px;padding:7px 0;border-bottom:1px solid var(--border)">
                  <span style="min-width:200px;color:var(--text-muted)">${escapeHTML(k)}</span>
                  <strong style="font-weight:600">${escapeHTML(String(v))}</strong>
                </div>`).join('');
        } catch (e) {
            box.textContent = 'Holatni olib bo\'lmadi: ' + (e?.message || e);
        }
    },

    /** Fiskal chek (QR-kod) holatini va chiqarilmagan cheklar ro'yxatini ko'rsatadi. */
    async loadFiscalStatus(force) {
        const box = document.getElementById('fiscalStatusBox');
        const pendingBox = document.getElementById('fiscalPendingBox');
        if (!box) return;
        if (!currentUser || currentUser.role !== 'admin') {
            box.textContent = 'Bu panel faqat administrator uchun.';
            if (pendingBox) pendingBox.innerHTML = '';
            return;
        }
        if (!staffToken) {
            box.textContent = 'Server bilan aloqa yo\'q — fiskal holat serverdan olinadi.';
            return;
        }
        try {
            const data = await apiRequest('/api/fiscal/status', { headers: authHeaders() });
            Fiscal.state = data?.fiscal || null;
            const st = data?.fiscal || {};
            const provider = st.provider === 'disabled' ? 'ulanmagan (disabled)' : (st.provider || '—');
            const rows = [
                ['Provayder (FISCAL_PROVIDER)', provider],
                ['Sozlangan', st.configured ? 'ha' : 'yo\'q — .env to\'ldirilishi kerak'],
                ['Majburiylik (FISCAL_REQUIRED)', st.required ? 'majburiy — QR-kodsiz chek chiqmaydi' : 'ixtiyoriy'],
                ['Savdogar ID', st.merchantIdMasked || '(bo\'sh)'],
                ['Maxfiy kalit', st.secretMasked || '(bo\'sh)'],
                ['Kassa (terminal)', st.terminalId || '—'],
                ['Standart QQS', (st.defaultVatPercent ?? 12) + ' %'],
                ['Kompaniya (chek sarlavhasi)', st.companyName || '(Sozlamalar → Kompaniya da to\'ldirilmagan)'],
                ['STIR (INN)', st.companyTin || '(kiritilmagan)'],
            ];
            box.innerHTML = rows.map(([k, v]) => `
                <div style="display:flex;gap:12px;padding:7px 0;border-bottom:1px solid var(--border)">
                  <span style="min-width:220px;color:var(--text-muted)">${escapeHTML(k)}</span>
                  <strong style="font-weight:600">${escapeHTML(String(v))}</strong>
                </div>`).join('');

            if (!pendingBox) return;
            const pending = await apiRequest('/api/fiscal/pending', { headers: authHeaders() });
            const list = pending?.sales || [];
            if (!list.length) {
                pendingBox.innerHTML = `<div style="color:var(--text-muted);font-size:12px">
                    Fiskal cheki chiqarilmagan to'langan savdo yo'q. ✓</div>`;
                return;
            }
            pendingBox.innerHTML = `
                <div style="font-size:13px;font-weight:600;margin-bottom:8px">Chek chiqarilmagan savdolar: ${list.length}</div>
                <div class="table-wrap">
                  <table>
                    <thead><tr><th>Chek</th><th>Summa</th><th>Sana</th><th>Kassir</th><th>Holat</th></tr></thead>
                    <tbody>${list.slice(-10).map(s => `<tr>
                      <td>#${escapeHTML(String(s.id))}</td>
                      <td>${fmt(s.total || 0)} so'm</td>
                      <td>${escapeHTML(String(s.date || '—'))}</td>
                      <td>${escapeHTML(String(s.cashier || '—'))}</td>
                      <td>${escapeHTML(String(s.fiscalError || s.fiscalStatus || 'chek yo\'q'))}</td>
                    </tr>`).join('')}</tbody>
                  </table>
                </div>`;
        } catch (e) {
            box.textContent = 'Holatni olib bo\'lmadi: ' + (e?.message || e);
        }
    },

    /** SITE_DOMAIN ni Cloudflare Turnstile widgetiga qo'shishni ishga tushiradi. */
    async syncCloudflareDomain() {
        if (!requireRole('admin')) return;
        if (!staffToken) {
            showNotif('error', 'Oflayn rejim', 'Bu amal server bilan aloqa talab qiladi');
            return;
        }
        try {
            const res = await fetch('/api/cloudflare/sync-domain', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                showNotif('warning', 'Cloudflare', data?.message || 'Domenni qo\'shib bo\'lmadi');
            } else {
                showNotif('success', 'Cloudflare', data?.message || 'Domen widgetga qo\'shildi');
            }
            this.loadCloudflareStatus();
        } catch (e) {
            console.warn('Cloudflare sinxronizatsiyasi xatosi:', e);
            showNotif('error', 'Xato', 'Serverga ulanib bo\'lmadi');
        }
    },

    /** Tanlangan sessiyani masofadan yopadi (o'z sessiyasi yopilmaydi). */
    async revokeSession(jti) {
        if (!requireRole('admin')) return;
        if (!staffToken) {
            showNotif('error', 'Oflayn rejim', 'Sessiyani yopish uchun server kerak');
            return;
        }
        if (!confirm('Shu qurilmadagi sessiya yopiladi va u qayta kirishi kerak bo\'ladi. Davom etamizmi?')) return;
        try {
            const res = await fetch('/api/security/sessions/revoke', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ jti: jti })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                showNotif('error', 'Xato', data?.message || 'Sessiyani yopib bo\'lmadi');
                return;
            }
            securityLog('session-revoked', 'medium', 'Administrator masofadan sessiya yopdi');
            showNotif('success', 'Sessiya yopildi', data?.message || 'Qurilma qayta kirishi kerak');
            this.loadServerSessions();
        } catch (e) {
            console.warn('Sessiyani yopishda xatolik:', e);
            showNotif('error', 'Xato', 'Serverga ulanib bo\'lmadi');
        }
    }
};

/** Faol sessiyalar va login urinishlari jadvallarini chizadi (admin panel). */
function renderServerSessions(data) {
    const summary = document.getElementById('serverSessionSummary');
    const body = document.getElementById('sessionsTableBody');
    const attemptBody = document.getElementById('loginAttemptsTableBody');
    const sessions = data.sessions || [];

    if (summary) {
        const meCount = sessions.filter(s => s.current).length;
        summary.innerHTML = `<span class="badge badge-blue">${sessions.length} faol sessiya</span>
            <span class="badge badge-green" style="margin-left:6px">Shu qurilma aniqlandi: ${meCount}</span>`;
    }

    if (body) {
        body.innerHTML = sessions.map(s => `<tr>
    <td><strong>${escapeHTML(s.device || '—')}</strong>${s.current ? ' <span class="badge badge-green">Shu qurilma</span>' : ''}</td>
    <td>${escapeHTML(s.name || s.login || '—')}<br>
      <small style="color:var(--muted)">${escapeHTML(ROLES[s.role] || s.role || '—')}</small></td>
    <td><code style="font-size:12px">${escapeHTML(s.ip || '—')}</code></td>
    <td style="font-size:12px;color:var(--muted);white-space:nowrap">${escapeHTML(s.created || '—')}</td>
    <td style="font-size:12px;color:var(--muted);white-space:nowrap">${escapeHTML(s.lastSeen || '—')}</td>
    <td>${s.current
                ? '<span class="badge">Joriy sessiya</span>'
                : `<button class="btn btn-danger" onclick="Security.revokeSession('${escapeHTML(String(s.jti || ''))}')"><i class="fas fa-power-off"></i> Yopish</button>`}</td>
  </tr>`).join('') ||
            '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">Faol sessiya yo\'q</td></tr>';
    }

    if (attemptBody) {
        attemptBody.innerHTML = (data.attempts || []).map(a => {
            const lv = SEC_LEVEL_BADGES[a.level] || SEC_LEVEL_BADGES.low;
            return `<tr>
    <td style="font-size:12px;color:var(--muted);white-space:nowrap">${escapeHTML(a.time)}</td>
    <td><code style="font-size:12px">${escapeHTML(a.ip)}</code></td>
    <td><span class="badge ${lv[0]}">${escapeHTML(a.type)}</span></td>
    <td style="font-size:12px;color:var(--muted)">${escapeHTML(a.message)}</td>
    <td><span class="badge badge-blue">${escapeHTML(a.user)}</span></td>
  </tr>`;
        }).join('') ||
            '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">Login hodisalari yo\'q</td></tr>';
    }
}
const SEC_LEVEL_BADGES = {
    low: ['badge-green', 'Past'],
    medium: ['badge-yellow', "O'rta"],
    high: ['badge-orange', 'Yuqori'],
    critical: ['badge-red', 'Kritik']
};

function downloadCSV(content, filenamePrefix) {
    const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Loglar sahifasidagi xavfsizlik monitoring panelini yangilaydi */
function renderSecurityPanel() {
    const stats = securityStats();
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('securityScore', stats.score);
    setText('securityFailed', stats.failed);
    setText('securityBlocked', stats.blocked);
    setText('securityEventsCount', stats.total);

    const note = document.getElementById('securityScoreNote');
    if (note) {
        note.className = 'stat-change ' + (stats.score >= 85 ? 'up' : 'down');
        note.innerHTML = stats.score >= 85
            ? '<i class="fas fa-circle-check"></i> Himoya faol'
            : '<i class="fas fa-triangle-exclamation"></i> Diqqat talab qiladi';
    }

    const tbody = document.getElementById('securityTable');
    if (tbody) {
        tbody.innerHTML = securityEvents.slice(0, 50).map(e => {
            const lv = SEC_LEVEL_BADGES[e.level] || SEC_LEVEL_BADGES.low;
            return `<tr>
    <td style="color:var(--muted);font-size:12px;white-space:nowrap">${escapeHTML(e.time)}</td>
    <td><span class="badge ${lv[0]}">${lv[1]}</span></td>
    <td><strong>${escapeHTML(e.type)}</strong></td>
    <td style="color:var(--muted);font-size:13px">${escapeHTML(e.message)}</td>
    <td><span class="badge badge-blue">${escapeHTML(e.user)}</span></td>
  </tr>`;
        }).join('') ||
            '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">Xavfsizlik hodisalari yo\'q — tizim himoyada ✅</td></tr>';
    }
    updateSessionIndicators();
}

/** Xavfsizlik sozlamalaridagi "Himoya choralari" ro'yxati */
function renderSecurityChecklist() {
    const box = document.getElementById('securityChecklist');
    if (!box) return;
    const overrides = secureUserOverrides();
    const items = [
        { ok: true, label: 'Parollar salted SHA-256 xeshda saqlanadi (ochiq matn yo\'q)' },
        { ok: true, label: `Brute-force himoyasi: ${Number(systemSettings.maxLoginAttempts) || 5} noto'g'ri urinish → ${Number(systemSettings.lockMinutes) || 5} daqiqa blok` },
        { ok: true, label: `Sessiya nazorati: ${Number(systemSettings.sessionTimeoutMin) || 20} daqiqa harakatsizlikda avtomatik chiqish` },
        { ok: true, label: 'XSS va SQL injection filtri barcha kiritish maydonlarida' },
        { ok: true, label: `Xavfsizlik audit jurnali faol (${securityEvents.length} hodisa saqlanmoqda)` },
        { ok: window.location.protocol === 'https:', label: window.location.protocol === 'https:' ? 'HTTPS ulanish faol' : 'HTTPS yoqilmagan — serverda TLS yoqish tavsiya etiladi' },
        { ok: overrides.length > 0, label: overrides.length > 0 ? `Standart parollar almashtirilgan (${overrides.length} hisob)` : 'Standart parollar hali almashtirilmagan — Sozlamalar → Xavfsizlik bo\'limida almashtiring' }
    ];
    box.innerHTML = items.map(i => `
  <div class="sec-check ${i.ok ? 'ok' : 'warn'}">
    <i class="fas ${i.ok ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
    <span>${escapeHTML(i.label)}</span>
  </div>`).join('');
}
function clearSecurityLog() {
    if (!requireRole('admin')) return;
    if (!confirm('Xavfsizlik jurnalini tozalash?')) return;
    securityEvents = securityEvents.slice(0, 3);
    try { localStorage.setItem('tp_security_log', JSON.stringify(securityEvents)); } catch (e) { }
    scheduleSyncWithBackend();
    renderSecurityPanel();
    showNotif('info', 'Tozalandi', 'Xavfsizlik jurnali tozalandi');
}

function exportSecurityLogCSV() {
    if (!requireRole('admin')) return;
    const header = ['Vaqt', 'Daraja', 'Hodisa', 'Tafsilot', 'Foydalanuvchi'];
    const rows = securityEvents.map(e => [e.time, e.level, e.type, e.message, e.user]);
    const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
    downloadCSV(csv, 'xavfsizlik_jurnali');
    showNotif('success', 'Eksport!', 'Xavfsizlik jurnali CSV faylga yuklandi');
}

function openSecurityLog() {
    goTo('page-logs', document.getElementById('nav-logs'));
    renderSecurityPanel();
}

function saveSecuritySettings() {
    if (!requireRole('admin')) return;
    const idle = Number(document.getElementById('secIdleTimeout')?.value) || 20;
    systemSettings.sessionTimeoutMin = Math.max(1, Math.min(120, idle));
    systemSettings.maxLoginAttempts = Math.max(3, Math.min(10, Number(document.getElementById('secMaxAttempts')?.value) || 5));
    systemSettings.lockMinutes = Math.max(1, Math.min(60, Number(document.getElementById('secLockMinutes')?.value) || 5));
    systemSettings.securityLogLimit = Math.max(50, Math.min(1000, Number(document.getElementById('secLogLimit')?.value) || 200));
    persistSystemSettings();
    touchSession();
    renderSecurityChecklist();
    securityLog('security-settings', 'medium',
        `Xavfsizlik sozlamalari yangilandi: sessiya ${systemSettings.sessionTimeoutMin} daq, ${systemSettings.maxLoginAttempts} urinish, blok ${systemSettings.lockMinutes} daq`);
    addLog('Xavfsizlik', 'Xavfsizlik sozlamalari saqlandi');
    playSuccess();
    showNotif('success', 'Saqlandi!', 'Xavfsizlik sozlamalari yangilandi');
}

async function changePassword() {
    if (!currentUser) { playError(); showNotif('error', 'Xato!', 'Avval tizimga kiring'); return; }
    const oldPass = sanitizePassword(document.getElementById('secOldPass')?.value);
    const newPass = sanitizePassword(document.getElementById('secNewPass')?.value);
    const conf = sanitizePassword(document.getElementById('secNewPass2')?.value);

    if (!oldPass || !newPass || !conf) {
        playError(); showNotif('error', 'Xato!', 'Barcha parol maydonlarini to\'ldiring'); return;
    }
    if (newPass.length < minPasswordLength()) {
        playError(); showNotif('error', 'Zaif parol!', `Parol kamida ${minPasswordLength()} belgidan iborat bo'lsin`); return;
    }
    if (newPass !== conf) {
        playError(); showNotif('error', 'Xato!', 'Yangi parollar bir xil emas'); return;
    }
    if (newPass === oldPass) {
        playError(); showNotif('error', 'Xato!', 'Yangi parol joriy paroldan farq qilishi kerak'); return;
    }
    const check = verifyUserLogin(currentUser.login, oldPass);
    if (!check.ok) {
        playError();
        securityLog('password-change-failed', 'high', `${currentUser.login} uchun joriy parol noto'g'ri kiritildi`);
        showNotif('error', 'Rad etildi!', 'Joriy parol noto\'g\'ri');
        return;
    }
    // Parol server bazasida ham yangilanadi (login serverda tekshiriladi)
    if (staffToken) {
        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    login: currentUser.login,
                    currentPassword: oldPass,
                    newPassword: newPass
                })
            });
            const data = await res.json().catch(() => null);
            if (res.ok && data?.token) {
                setStaffToken(data.token);
            } else if (res.status === 401 || res.status === 403) {
                playError();
                showNotif('error', 'Rad etildi!', data?.message || 'Server parolni qabul qilmadi');
                return;
            } else if (!res.ok) {
                console.warn('Serverda parolni yangilab bo\'lmadi (HTTP ' + res.status + ')');
            }
        } catch (e) {
            console.warn('Serverda parolni yangilash imkonsiz (oflayn):', e);
        }
    }

    if (!storeUserPassword(currentUser.login, newPass, currentUser.name)) {
        playError(); showNotif('error', 'Xato!', 'Parolni saqlab bo\'lmadi'); return;
    }
    const strength = passwordStrength(newPass);
    securityLog('password-change', 'high', `${currentUser.login} paroli almashtirildi (kuchlilik: ${strength}/4)`);
    addLog('Xavfsizlik', `Parol almashtirildi (${currentUser.login})`);
    ['secOldPass', 'secNewPass', 'secNewPass2'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    renderSecurityChecklist();
    playSuccess();
    showNotif('success', 'Parol yangilandi! 🔐',
        strength >= 3 ? 'Parolingiz kuchli va xavfsiz saqlandi' : 'Parol yangilandi. Yana kuchliroq parol tavsiya etiladi');
}

async function forceLogoutAll() {
    if (!requireRole('admin')) return;
    if (!confirm('Barcha sessiyalar (barcha qurilmalarda) yopiladi va qayta kirish talab qilinadi. Davom etamizmi?')) return;

    // Serverda token imzo kaliti almashtiriladi — barcha eski tokenlar
    // darhol kuchsiz bo'ladi (brauzerlardagi sessiyalar ham).
    if (staffToken) {
        try {
            await fetch('/api/auth/logout-all', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' })
            });
        } catch (e) {
            console.warn('Server sessiyalarini yopib bo\'lmadi (oflayn):', e);
        }
    }

    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
    try { localStorage.removeItem(LOGIN_GUARD_KEY); } catch (e) { }
    securityLog('force-logout-all', 'high', 'Administrator barcha sessiyalarni yopdi');
    doLogout(true);
    showNotif('info', 'Sessiyalar yopildi', 'Xavfsizlik uchun qayta kirish talab qilinadi');
}
/* ============================================================
   TO'LOV TIZIMLARI MODULI (Click, Payme, Paynet, Uzum, Paylov...)
   Barcha maxfiy kalitlar faqat serverda (.env) saqlanadi.
   ============================================================ */
const PAYMENT_PROVIDERS = {
    cash: {
        id: 'cash', label: 'Naqd', kind: 'offline', icon: 'fa-money-bill-wave', color: '#10B981',
        env: null, note: 'Kassa naqd puli'
    },
    card: {
        id: 'card', label: 'Karta', kind: 'terminal', icon: 'fa-credit-card', color: '#3B82F6',
        env: null, note: 'Bank POS terminali orqali'
    },
    click: {
        id: 'click', label: 'Click', kind: 'online', icon: 'fa-mobile-screen-button', color: '#00A2EB',
        env: 'CLICK_MERCHANT_ID, CLICK_SERVICE_ID, CLICK_SECRET_KEY',
        note: "Click Up / Click Pass orqali to'lov"
    },
    payme: {
        id: 'payme', label: 'Payme', kind: 'online', icon: 'fa-wallet', color: '#00CCCC',
        env: 'PAYME_MERCHANT_ID (kassa ID), PAYME_KEY',
        note: "Payme kassa orqali to'lov (checkout.paycom.uz)"
    },
    paynet: {
        id: 'paynet', label: 'Paynet', kind: 'agent', icon: 'fa-network-wired', color: '#F59E0B',
        env: 'PAYNET_MERCHANT_ID, PAYNET_SERVICE_ID, PAYNET_KEY',
        note: "Paynet agentlik/terminal tarmog'i orqali (order kodi bilan)"
    },
    uzum: {
        id: 'uzum', label: 'Uzum Bank', kind: 'online', icon: 'fa-store', color: '#7B2FF7',
        env: 'UZUM_MERCHANT_ID, UZUM_KEY, UZUM_CHECKOUT_URL',
        note: "Uzum Bank to'lov sahifasi (hosted checkout)"
    },
    paylov: {
        id: 'paylov', label: 'Paylov', kind: 'online', icon: 'fa-hand-holding-dollar', color: '#22C55E',
        env: 'PAYLOV_MERCHANT_ID, PAYLOV_KEY, PAYLOV_CHECKOUT_URL',
        note: "Paylov to'lov sahifasi (hosted checkout)"
    },
    credit: {
        id: 'credit', label: 'Kredit', kind: 'installment', icon: 'fa-calendar-check', color: '#8B5CF6',
        env: null, note: "Muddatli to'lov (boshlang'ich to'lov + oylik)"
    },
    transfer: {
        id: 'transfer', label: "O'tkazma", kind: 'offline', icon: 'fa-building-columns', color: '#94A3B8',
        env: null, note: "Bank o'tkazmasi (hisob raqamiga)"
    }
};
const ONLINE_PAYMENT_KINDS = ['online', 'agent'];

function paymentKind(providerId) {
    return PAYMENT_PROVIDERS[providerId]?.kind || 'offline';
}

function isOnlineProvider(providerId) {
    return ONLINE_PAYMENT_KINDS.includes(paymentKind(providerId));
}

let paymentConfig = {
    loaded: false,
    serverOnline: false,
    providers: {},
    defaultProvider: 'cash',
    lastCheck: null
};

function providerActive(providerId) {
    const p = PAYMENT_PROVIDERS[providerId];
    if (!p) return false;
    if (!isOnlineProvider(providerId)) return true; // naqd/karta/kredit/o'tkazma har doim ishlaydi
    // Server sozlamasi bo'lmasa ham lokal rejimda urinib ko'rish mumkin (fallback havola)
    const cfg = paymentConfig.providers?.[providerId];
    return cfg ? Boolean(cfg.enabled) : false;
}

/** POS'dagi to'lov tugmalarini hisobga moslab qayta chizadi */
function renderPayTypes() {
    const grid = document.getElementById('payTypesGrid');
    if (!grid) return;
    const ids = Object.keys(PAYMENT_PROVIDERS);
    if (!ids.includes(payType)) payType = 'cash';

    grid.innerHTML = ids.map(id => {
        const p = PAYMENT_PROVIDERS[id];
        const active = id === payType ? ' active' : '';
        const disabled = providerActive(id) ? '' : ' pay-type-disabled';
        const title = providerActive(id)
            ? `${p.label} — ${p.note}`
            : `${p.label} — serverda sozlanmagan. Sozlamalar → To'lov tizimlari bo'limida ulang.`;
        return `<button type="button" class="pay-type${active}${disabled}" data-provider="${id}" title="${escapeHTML(title)}"
      onclick="setPayType('${id}',this)"><i class="fas ${p.icon}"></i>${escapeHTML(p.label)}</button>`;
    }).join('');
    renderProviderStatus();
}

/** Tanlangan to'lov tizimi haqida qisqa holat ma'lumoti */
function renderProviderStatus() {
    const box = document.getElementById('payProviderStatus');
    if (!box) return;
    const p = PAYMENT_PROVIDERS[payType];
    if (!p) { box.innerHTML = ''; return; }
    const ok = providerActive(payType);
    box.innerHTML = `
    <span class="pps-dot" style="background:${ok ? 'var(--success)' : 'var(--warning)'}"></span>
    <span><strong>${escapeHTML(p.label)}</strong> — ${escapeHTML(ok ? p.note : 'sozlanmagan (naqd/karta ishlatasiz)')}</span>`;
}

/** Do'kon savatidagi to'lov turi ro'yxatini to'ldiradi */
function renderShopPayOptions() {
    const sel = document.getElementById('uzumPayType');
    if (!sel) return;
    const current = sel.value || systemSettings.paymentDefaultProvider || 'click';
    sel.innerHTML = Object.keys(PAYMENT_PROVIDERS).map(id => {
        const p = PAYMENT_PROVIDERS[id];
        const disabled = providerActive(id) ? '' : 'disabled';
        return `<option value="${id}" ${disabled}>${escapeHTML(p.label)}${providerActive(id) ? '' : ' (sozlanmagan)'}</option>`;
    }).join('');
    const has = Array.from(sel.options).some(o => o.value === current && !o.disabled);
    sel.value = has ? current : (Array.from(sel.options).find(o => !o.disabled)?.value || 'cash');
}
// --- API aloqa sozlamalari: har bir so'rovda taymer (abadiy kutib qolmasin) ---
const API_TIMEOUT_MS = 15000;      // oddiy so'rovlar
const SYNC_TIMEOUT_MS = 25000;     // katta ma'lumot yuborish

/**
 * Taymer bilan fetch. Server javob bermasa so'rov to'xtatiladi va
 * xato qaytariladi — interfeys osilib qolmaydi.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : API_TIMEOUT_MS;
    if (typeof AbortController === 'undefined') return fetch(url, options);
    const opts = Object.assign({}, options || {});
    const controller = new AbortController();
    if (opts.signal && typeof opts.signal.addEventListener === 'function') {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    opts.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, opts);
    } finally {
        clearTimeout(timer);
    }
}

async function apiRequest(path, options) {
    let res;
    try {
        res = await fetchWithTimeout(path, options, API_TIMEOUT_MS);
    } catch (e) {
        if (e?.name === 'AbortError') {
            throw new Error('Server javob bermadi (vaqt tugadi) — qayta urinib ko\'ring');
        }
        throw new Error('Serverga ulanib bo\'lmadi — internet aloqasini tekshiring');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || `Server xatosi (${res.status})`);
    return data;
}

// ============================================================
// FISKAL CHEK (QR-KODLI CHEK) — O'zbekiston qonunchiligi talabi
// ============================================================
//  • chek FAQAT to'lov tasdiqlangandan keyin (status === 'paid') chiqadi;
//  • QR-kod (fiskal belgi) faqat OFD javobidan olinadi — server beradi;
//  • fiskal modul sozlanmagan va majburiy bo'lsa chek chop etilmaydi.
const Fiscal = {
    state: null,

    /** Serverdagi fiskal modul holatini oladi (provider, sozlangan yoki yo'q). */
    async loadState(force) {
        if (this.state && !force) return this.state;
        try {
            const data = await apiRequest('/api/fiscal/status', { headers: authHeaders() });
            this.state = data?.fiscal || { configured: false, required: true };
        } catch (e) {
            this.state = { configured: false, required: true, message: e?.message || 'Serverga ulanib bo\'lmadi' };
        }
        return this.state;
    },

    isConfigured() { return Boolean(this.state?.configured); },
    isRequired() { return this.state?.required !== false; },

    /** Savdo uchun fiskal chek chiqaradi (server orqali) va savdoga yozadi. */
    async issue(sale, options) {
        const opts = options || {};
        if (!sale) return { ok: false, fiscalError: 'Savdo topilmadi' };
        if (sale.status !== 'paid') {
            return { ok: false, fiscalStatus: 'payment_not_confirmed',
                     fiscalError: 'To\'lov tasdiqlanmaguncha fiskal chek chiqarilmaydi' };
        }
        if (sale.fiscalSign && sale.fiscalUrl && !opts.force) {
            return { ok: true, fiscalUrl: sale.fiscalUrl, fiscalSign: sale.fiscalSign,
                     fiscalNumber: sale.fiscalNumber, cached: true };
        }
        if (!staffToken) {
            return { ok: false, fiscalError: 'Server bilan aloqa yo\'q — fiskal chek faqat server orqali chiqadi' };
        }
        try {
            // Savdo avval server bazasiga yoziladi (aks holda chek topilmaydi)
            try { await flushSyncNow(); } catch (e) { }
            const post = () => fetch('/api/fiscal/receipt', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ saleId: sale.id, force: Boolean(opts.force) })
            });
            let res = await post();
            if (res.status === 404) {
                // Yozish hali serverga yetib bormagan — qisqa kutib qayta urinamiz
                await new Promise(r => setTimeout(r, 900));
                await flushSyncNow().catch(() => { });
                res = await post();
            }
            const data = await res.json().catch(() => null);
            const fiscal = data?.fiscal || {};
            Object.assign(sale, {
                fiscalStatus: fiscal.fiscalStatus || 'failed',
                fiscalProvider: fiscal.fiscalProvider || '',
                fiscalUrl: fiscal.fiscalUrl || '',
                fiscalSign: fiscal.fiscalSign || '',
                fiscalNumber: fiscal.fiscalNumber || '',
                fiscalDeviceId: fiscal.fiscalDeviceId || '',
                fiscalTime: fiscal.fiscalTime || '',
                fiscalTotal: fiscal.fiscalTotal || sale.total,
                fiscalError: fiscal.fiscalError || (fiscal.ok ? '' : (data?.message || 'Fiskal chek chiqmadi'))
            });
            if (fiscal.ok) saveToStorage();
            return Object.assign({ ok: Boolean(fiscal.ok) }, fiscal);
        } catch (e) {
            sale.fiscalStatus = 'failed';
            sale.fiscalError = e?.message || 'Fiskal modulga ulanib bo\'lmadi';
            return { ok: false, fiscalStatus: 'failed', fiscalError: sale.fiscalError };
        }
    },

    /** Chekni chop etish mumkinmi? (asosiy himoya shu yerda) */
    canPrint(sale) {
        if (!sale) return { ok: false, reason: 'Chek topilmadi' };
        if (sale.status !== 'paid') {
            return { ok: false, reason: 'To\'lov hali tasdiqlanmagan — chek chiqarilmaydi' };
        }
        if (sale.fiscalSign && sale.fiscalUrl) return { ok: true, fiscal: true };
        if (this.isConfigured()) {
            return { ok: false, reason: 'Fiskal chek hali chiqarilmagan — «QR chekni chiqarish» tugmasini bosing' };
        }
        if (this.isRequired()) {
            return { ok: false, reason: 'Fiskal modul sozlanmagan (.env: FISCAL_PROVIDER, FISCAL_API_URL, ' +
                       'FISCAL_SECRET_KEY) — QR-kodsiz chek chop etilmaydi' };
        }
        // Modul ixtiyoriy (FISCAL_REQUIRED=false) — chek "FISKAL EMAS" belgisi bilan chiqadi
        return { ok: true, fiscal: false };
    },

    /** Fiskal holat qatori (chek ichida ko'rsatiladi). */
    statusLine(sale) {
        if (!sale) return '';
        if (sale.status !== 'paid') {
            return '<div class="r-center" style="color:#F59E0B">TO\'LOV TASDIQLANMAGAN — CHEK EMAS</div>';
        }
        if (sale.fiscalSign && sale.fiscalUrl) {
            const link = escapeHTML(sale.fiscalUrl);
            return `<div class="r-center" style="font-size:11px">Fiskal chek: ${escapeHTML(sale.fiscalNumber || '—')}<br>` +
                `<span style="word-break:break-all">${link}</span></div>`;
        }
        if (!this.isConfigured()) {
            return this.isRequired()
                ? '<div class="r-center" style="color:#EF4444">FISKAL MODUL SOZLANMAGAN — CHEK YAROQSIZ</div>'
                : '<div class="r-center" style="color:#EF4444">FISKAL EMAS (QR yo\'q)</div>';
        }
        return '<div class="r-center" style="color:#EF4444">FISKAL CHEK CHIQARILMAGAN</div>';
    },

    /** QR-kod (fiskal belgi) rasm manzilini tayyorlaydi — mahalliy generatsiya. */
    qrDataUrl(text) {
        if (!text || typeof QRCode === 'undefined') return '';
        try {
            const holder = document.createElement('div');
            holder.style.display = 'none';
            document.body.appendChild(holder);
            new QRCode(holder, { text: String(text), width: 220, height: 220,
                                 correctLevel: QRCode.CorrectLevel.M });
            // Kutubxona rasmni asinxron to'ldiradi — shuning uchun avval
            // to'g'ridan-to'g'ri canvas'dan o'qiymiz (u sinxron chiziladi).
            let src = '';
            const canvas = holder.querySelector('canvas');
            try { if (canvas) src = canvas.toDataURL('image/png'); } catch (e) { src = ''; }
            if (!src.startsWith('data:image')) {
                const img = holder.querySelector('img');
                src = img?.src || '';
            }
            holder.remove();
            return src.startsWith('data:image') ? src : '';
        } catch (e) {
            return '';
        }
    },

    /** QR-kod bloki (chekda majburiy) — faqat tasdiqlangan fiskal chek uchun. */
    qrBlock(sale) {
        if (!sale?.fiscalSign && !sale?.fiscalUrl) return '';
        const payload = sale.fiscalUrl || sale.fiscalSign;
        const dataUrl = this.qrDataUrl(payload);
        const inner = dataUrl
            ? `<img src="${dataUrl}" alt="Fiskal QR" style="width:150px;height:150px;display:block">`
            : `<div style="font-size:10px;word-break:break-all">${escapeHTML(payload)}</div>`;
        return `
        <hr>
        <div class="r-center" style="margin:6px 0">
          <div style="display:inline-block;background:#fff;padding:6px;border-radius:8px">${inner}</div>
          <div style="font-size:11px;margin-top:6px;font-weight:700">FISKAL CHEK — QR-KODNI SKANERLANG</div>
          <div style="font-size:10px">Fiskal belgi: ${escapeHTML(sale.fiscalNumber || '—')}</div>
          ${sale.fiscalDeviceId ? `<div style="font-size:10px">Kassa: ${escapeHTML(sale.fiscalDeviceId)}</div>` : ''}
        </div>`;
    },

    /** Chek ostidagi fiskal holat bloki (holat, xato, qayta urinish). */
    actionBox(sale) {
        if (!sale) return '';
        if (sale.status !== 'paid') {
            return `
            <div style="margin-top:16px;padding:14px;border-radius:12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3)">
              <strong style="color:#F59E0B;font-size:13px">⏳ To'lov tasdiqlanmadi — chek chiqmaydi</strong>
              <p style="font-size:12px;color:var(--text-secondary);margin-top:6px">
                To'lov to'liq tasdiqlangach fiskal chek (QR-kod) avtomatik shakllanadi va chop etish mumkin bo'ladi.
              </p>
            </div>`;
        }
        if (sale.fiscalSign && sale.fiscalUrl) {
            return `
            <div style="margin-top:16px;padding:14px;border-radius:12px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25)">
              <strong style="color:#10B981;font-size:13px">✓ Fiskal chek tayyor (QR-kod bilan)</strong>
              <p style="font-size:12px;color:var(--text-secondary);margin-top:6px">
                Fiskal belgi: <b>${escapeHTML(sale.fiscalNumber || '—')}</b>
                ${sale.fiscalProvider ? ' · ' + escapeHTML(sale.fiscalProvider) : ''}
              </p>
              <a href="${escapeHTML(sale.fiscalUrl)}" target="_blank" rel="noopener noreferrer"
                 style="font-size:12px;color:var(--primary);word-break:break-all">${escapeHTML(sale.fiscalUrl)}</a>
            </div>`;
        }
        const missing = !this.isConfigured();
        const hint = missing
            ? 'Fiskal modul sozlanmagan: <code>.env</code> da <code>FISCAL_PROVIDER</code>, <code>FISCAL_API_URL</code>, ' +
              '<code>FISCAL_MERCHANT_ID</code>, <code>FISCAL_SECRET_KEY</code> ni to\'ldiring (batafsil: FISCAL.md).'
            : 'OFD javob bermadi yoki mahsulotda IKPU (MXIK) / qadoqlash kodi to\'liq emas.';
        return `
        <div style="margin-top:16px;padding:14px;border-radius:12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3)">
          <strong style="color:#EF4444;font-size:13px">✗ Fiskal chek chiqarilmadi — chek chop etilmaydi</strong>
          ${sale.fiscalError ? `<p style="font-size:12px;color:var(--text-secondary);margin-top:6px">${escapeHTML(sale.fiscalError)}</p>` : ''}
          <p style="font-size:12px;color:var(--text-secondary);margin-top:6px">${hint}</p>
          <button class="btn btn-outline" style="margin-top:10px" onclick="Fiscal.retryLast()">
            <i class="fas fa-rotate"></i> QR chekni qayta chiqarish
          </button>
        </div>`;
    },

    /** «QR chekni qayta chiqarish» tugmasi. */
    async retryLast() {
        const sale = lastCheckoutSale;
        if (!sale) return;
        showNotif('info', 'Fiskal chek', 'OFD orqali qayta urinilmoqda...');
        const res = await this.issue(sale, { force: true });
        renderReceipt(sale);
        if (res.ok) { playSuccess(); showNotif('success', 'Fiskal chek tayyor', sale.fiscalNumber || ''); }
        else { playError(); showNotif('error', 'Fiskal chek chiqmadi', sale.fiscalError || ''); }
    },

    /** Chek modalining «Chek Chop» tugmasini holatiga moslaydi. */
    applyPrintState(sale) {
        const btn = document.getElementById('printReceiptBtn');
        if (!btn) return;
        const gate = this.canPrint(sale);
        btn.disabled = !gate.ok;
        btn.style.opacity = gate.ok ? '1' : '0.55';
        btn.style.cursor = gate.ok ? 'pointer' : 'not-allowed';
        btn.title = gate.ok
            ? (gate.fiscal ? 'Fiskal chekni chop etish' : 'Fiskal modul sozlanmagan — QR yo\'q')
            : gate.reason;
    },

    /**
     * Chiqmay qolgan (masalan aloqa uzilganda) fiskal cheklarni o'zi qayta urinadi.
     * Faqat to'langan va fiskal belgisi yo'q savdolar, bir martada 5 tagacha.
     */
    async retryLocalPending() {
        if (!staffToken || navigator.onLine === false) return 0;
        if (!this.isConfigured()) return 0;
        const pending = (salesHistory || []).filter(s =>
            s && s.status === 'paid' && !s.fiscalSign && (s.fiscalError || s.fiscalStatus === 'failed')
        ).slice(0, 5);
        let done = 0;
        for (const sale of pending) {
            const res = await this.issue(sale);
            if (res.ok) done++;
        }
        if (done) {
            if (lastCheckoutSale) renderReceipt(lastCheckoutSale);
            showNotif('success', 'Fiskal cheklar', `${done} ta chek keyin chiqarildi (QR-kod tayyor)`);
            if (typeof renderSalesHistory === 'function') renderSalesHistory();
        }
        return done;
    },

    /** Xato bo'lganda chekni keyinroq qayta urinish uchun rejalashtiradi. */
    scheduleRetry(delayMs) {
        if (this._retryTimer || this._retryAttempts >= 6) return;
        const delay = Number.isFinite(delayMs) ? delayMs : Math.min(30000 * (this._retryAttempts + 1), 120000);
        this._retryTimer = setTimeout(async () => {
            this._retryTimer = null;
            this._retryAttempts = (this._retryAttempts || 0) + 1;
            const done = await this.retryLocalPending();
            if (!done) this.scheduleRetry();
            else this._retryAttempts = 0;
        }, delay);
    },

    _retryTimer: null,
    _retryAttempts: 0,

    /** Qaytarilmagan fiskal cheklarni chiqaradi (faqat admin). */
    async issuePending() {
        if (!requireRole('admin')) return;
        if (!staffToken) { showNotif('error', 'Oflayn rejim', 'Fiskal chek server orqali chiqadi'); return; }
        try {
            const data = await apiRequest('/api/fiscal/pending/run', {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}'
            });
            showNotif('success', 'Fiskal cheklar', `${data.issued} ta chek chiqarildi, ${data.failed} ta xato`);
            await loadFromBackend();
            Security.loadFiscalStatus(true);
        } catch (e) {
            showNotif('error', 'Xato', e?.message || 'Cheklarni chiqarib bo\'lmadi');
        }
    }
};

const PaymentGateway = {
    pending: null,
    lastPollError: '',

    async init() {
        this.renderSettings();
        await this.refreshConfig(false);
        renderShopPayOptions();
    },

    /** Serverdan yoqilgan to'lov tizimlari ro'yxatini oladi (maxfiy kalitlar yuborilmaydi) */
    async refreshConfig(notify = false) {
        try {
            const data = await apiRequest('/api/payments/config');
            paymentConfig.loaded = true;
            paymentConfig.serverOnline = true;
            paymentConfig.providers = data?.providers || {};
            paymentConfig.defaultProvider = data?.defaultProvider || 'cash';
            paymentConfig.lastCheck = new Date().toLocaleString('uz-UZ');
            // Serverda standart to'lov tizimi belgilangan bo'lsa va lokal sozlama yo'q bo'lsa — uni olamiz
            if (!localStorage.getItem('tp_settings') && PAYMENT_PROVIDERS[paymentConfig.defaultProvider]) {
                systemSettings.paymentDefaultProvider = paymentConfig.defaultProvider;
            }
            securityLog('payment-config', 'low',
                `To'lov tizimlari konfiguratsiyasi olindi: ${Object.keys(paymentConfig.providers).filter(k => paymentConfig.providers[k].enabled).join(', ') || 'faqat offline'}`);
            if (notify) showNotif('success', 'Ulanish tekshirildi', 'Server to\'lov tizimlari holati yangilandi');
        } catch (e) {
            paymentConfig.loaded = true;
            paymentConfig.serverOnline = false;
            paymentConfig.providers = {};
            if (notify) {
                showNotif('warning', 'Backend javob bermadi',
                    'Online to\'lovlar uchun app.py serveri ishlab turishi kerak. Naqd/karta ishlayveradi.');
            }
        }
        renderPayTypes();
        renderShopPayOptions();
        this.renderProviderList();
        return paymentConfig;
    },

    /** Online to'lovni boshlash (POS va do'kon uchun umumiy oqim) */
    async start(sale, providerId) {
        const amount = Number(sale?.total) || 0;
        const p = PAYMENT_PROVIDERS[providerId];
        if (!p || amount <= 0) {
            playError();
            showNotif('error', 'Xato!', 'To\'lov ma\'lumotlari to\'g\'ri emas');
            return false;
        }
        if (!providerActive(providerId)) {
            playError();
            showNotif('error', `${p.label} sozlanmagan`,
                'Bu tizim uchun merchant kalitlari serverda kiritilmagan. Naqd yoki karta bilan davom eting.');
            securityLog('payment-provider-unconfigured', 'medium', `${p.label} sozlanmagan holda ishlatishga urinish`);
            return false;
        }

        this.stopPolling();
        this.pending = {
            sale, provider: providerId, amount,
            orderId: null, payUrl: '', timer: null, startedAt: Date.now(), expiresAt: null
        };

        const amountEl = document.getElementById('paymentModalAmount');
        if (amountEl) amountEl.textContent = fmt(amount) + " so'm";
        const logoEl = document.getElementById('paymentProviderLogo');
        if (logoEl) {
            logoEl.innerHTML = `<span class="ppl-badge" style="background:${p.color}22;color:${p.color};border:1px solid ${p.color}55">
        <i class="fas ${p.icon}"></i> ${escapeHTML(p.label)}</span>`;
        }
        const titleEl = document.getElementById('paymentModalTitle');
        if (titleEl) titleEl.innerHTML = `<i class="fas ${p.icon}" style="color:${p.color};margin-right:8px"></i>${escapeHTML(p.label)} orqali to'lov`;
        openModal('paymentModal');
        this.setModalState('pending', 'Server bilan aloqa o\'rnatilmoqda...');
        const manualBtn = document.getElementById('paymentManualBtn');
        if (manualBtn) manualBtn.style.display = (currentUser?.role === 'admin') ? 'block' : 'none';

        try {
            // Savdo serverda mavjud bo'lishi shart — summani server o'zi tekshiradi
            await syncWithBackend();
            const data = await apiRequest('/api/payments/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    saleId: sale.id,
                    provider: providerId,
                    returnUrl: window.location.origin + window.location.pathname + '?payment=return'
                })
            });
            this.pending.orderId = data?.orderId || null;
            this.pending.payUrl = data?.payUrl || '';
            this.pending.expiresAt = data?.expiresAt || null;
            this.renderModalLink();
            this.setModalState('pending', `To'lov kutilmoqda — order: <b>${escapeHTML(String(this.pending.orderId))}</b>`);
            this.startPolling();
            return true;
        } catch (e) {
            console.warn('Payment create failed:', e);
            securityLog('payment-create-failed', 'medium', `${p.label}: ${e.message}`);
            const fallback = buildLocalPayLink(providerId, amount, sale.id);
            if (fallback) {
                this.pending.orderId = 'LOCAL-' + sale.id + '-' + String(Date.now()).slice(-5);
                this.pending.payUrl = fallback;
                this.renderModalLink();
                this.setModalState('pending',
                    'Server javob bermadi — havola orqali to\'lov. Tasdiqlash kassir/admin tomonidan qo\'lda amalga oshiriladi.');
                this.startPolling();
                return true;
            }
            this.setModalState('error',
                `Online to'lovni boshlab bo'lmadi (${escapeHTML(e.message)}). Naqd yoki karta bilan davom eting.`);
            playError();
            return false;
        }
    },
    /** Modal ichida havola, QR va USSD kodni chizadi */
    renderModalLink() {
        const url = this.pending?.payUrl || '';
        const input = document.getElementById('paymentLinkInput');
        if (input) input.value = url;

        const wrap = document.getElementById('paymentQrWrap');
        if (wrap) {
            wrap.innerHTML = '';
            if (!url) {
                wrap.innerHTML = '<div class="pay-qr-fallback">Havola mavjud emas</div>';
            } else if (typeof QRCode !== 'undefined') {
                try {
                    new QRCode(wrap, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
                } catch (e) {
                    wrap.innerHTML = `<div class="pay-qr-fallback">${escapeHTML(url)}</div>`;
                }
            } else {
                wrap.innerHTML = `<div class="pay-qr-fallback">${escapeHTML(url)}</div>`;
            }
        }

        const ussdWrap = document.getElementById('paymentUssdWrap');
        const ussdEl = document.getElementById('paymentUssd');
        if (ussdWrap && ussdEl) {
            const ussd = buildProviderUssd(this.pending?.provider, this.pending?.amount);
            if (ussd) {
                ussdEl.textContent = ussd;
                ussdWrap.style.display = 'block';
            } else {
                ussdWrap.style.display = 'none';
            }
        }
    },

    /** Modal holati: pending | error | paid | expired */
    setModalState(state, note) {
        const badge = document.getElementById('paymentStatusBadge');
        const noteEl = document.getElementById('paymentModalNote');
        const map = {
            pending: ['badge-yellow', '⏳ Kutilmoqda'],
            error: ['badge-red', '❌ Xato'],
            paid: ['badge-green', '✅ To\'landi'],
            expired: ['badge-gray', '⌛ Muddati tugadi']
        };
        const [cls, label] = map[state] || map.pending;
        if (badge) badge.innerHTML = `<span class="badge ${cls}">${label}</span>`;
        if (noteEl && note) noteEl.innerHTML = note;
    },

    startPolling() {
        this.stopPolling();
        const seconds = Math.max(2, Math.min(60, Number(systemSettings.paymentPollSeconds) || 3));
        const expireMs = Math.max(1, Math.min(120, Number(systemSettings.paymentExpireMinutes) || 15)) * 60000;
        if (!this.pending) return;
        if (!this.pending.expiresAt) this.pending.expiresAt = Date.now() + expireMs;

        this.pending.timer = setInterval(async () => {
            if (!this.pending) { this.stopPolling(); return; }
            const now = Date.now();
            const total = Math.max(1, this.pending.expiresAt - this.pending.startedAt);
            const pct = Math.min(100, Math.round(((now - this.pending.startedAt) / total) * 100));
            const fill = document.getElementById('paymentProgressFill');
            if (fill) fill.style.width = pct + '%';

            if (now > this.pending.expiresAt) {
                this.setModalState('expired', 'To\'lov muddati tugadi. Qaytadan urinib ko\'ring.');
                this.stopPolling(true);
                return;
            }
            await this.checkStatus(true);
        }, seconds * 1000);
    },

    stopPolling(keepPending = false) {
        if (this.pending?.timer) clearInterval(this.pending.timer);
        if (this.pending) this.pending.timer = null;
        if (!keepPending) { /* pending hisobot uchun saqlanadi */ }
    },

    /** To'lov holatini serverdan tekshiradi */
    async checkStatus(silent = false) {
        if (!this.pending?.orderId) return 'not_found';
        const { orderId, sale, provider } = this.pending;
        try {
            if (String(orderId).startsWith('LOCAL-')) {
                // Backend yo'q rejimida savdo holatini tekshiramiz
                const data = await apiRequest('/api/data');
                const found = (data?.sales || []).find(s => Number(s.id) === Number(sale.id));
                if (found && found.status === 'paid') {
                    this.stopPolling();
                    PaymentGateway.onPaid(sale.id, provider, orderId, found.txnId || null, false);
                    return 'paid';
                }
                return 'pending';
            }
            const data = await apiRequest('/api/payments/status/' + encodeURIComponent(orderId));
            const status = data?.status || 'pending';
            if (status === 'paid') {
                this.stopPolling();
                PaymentGateway.onPaid(sale.id, provider, orderId, data?.txnId || null, false);
                return 'paid';
            }
            if (status === 'cancelled') {
                this.setModalState('error', 'To\'lov bekor qilindi (to\'lov tizimi tomonidan).');
                this.stopPolling(true);
            }
            return status;
        } catch (e) {
            this.lastPollError = e.message;
            if (!silent) showNotif('warning', 'Tekshirilmadi', e.message);
            return 'unknown';
        }
    },
    async checkNow() {
        if (!this.pending) { showNotif('info', 'Ma\'lumot yo\'q', 'Avval to\'lovni boshlang'); return; }
        showNotif('info', 'Tekshirilmoqda...', 'To\'lov holati serverdan so\'ralmoqda');
        const status = await this.checkStatus(false);
        if (status === 'pending') showNotif('warning', 'Hali to\'lanmadi', 'To\'lov tasdiqlanishini kuting');
        if (status === 'not_found') showNotif('error', 'Topilmadi', 'To\'lov yozuvi topilmadi');
    },

    openLink() {
        const url = this.pending?.payUrl;
        if (!url) { showNotif('error', 'Havola yo\'q', 'To\'lov havolasi mavjud emas'); return; }
        window.open(url, 'PaymentPopup', 'width=520,height=680,resizable=yes,scrollbars=yes');
    },

    async copyLink() {
        const url = this.pending?.payUrl;
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            showNotif('success', 'Nusxa olindi', 'To\'lov havolasi nusxalandi');
        } catch (e) {
            const input = document.getElementById('paymentLinkInput');
            if (input) { input.select(); input.setSelectionRange(0, url.length); }
            showNotif('info', 'Qo\'lda nusxalang', 'Ctrl+C bosing');
        }
    },

    /** Kassir to'lovni bekor qiladi (savdo 'to'lanmagan' holatida qoladi) */
    cancel() {
        if (!this.pending) { this.closeModal(); return; }
        if (!confirm('To\'lovni bekor qilmoqchimisiz? Savdo "to\'lanmagan" holatida saqlanadi.')) return;
        const { sale, provider, orderId } = this.pending;
        addLog('To\'lov bekor', `#${sale?.id} — ${PAYMENT_PROVIDERS[provider]?.label || provider} (${orderId || '—'})`);
        securityLog('payment-cancelled', 'medium', `#${sale?.id} to'lovi bekor qilindi (${provider})`);
        this.stopPolling(true);
        this.closeModal();
        showNotif('warning', 'Bekor qilindi', 'Savdo to\'lanmagan holatda saqlandi');
        if (typeof renderSalesHistory === 'function') renderSalesHistory();
    },

    closeModal() {
        closeModal('paymentModal');
    },

    /** Xavfsizlik uchun: qo'lda tasdiqlash faqat admin uchun */
    manualConfirm() {
        if (!requireRole('admin')) return;
        if (!this.pending?.sale) { showNotif('info', 'Ma\'lumot yo\'q', 'Faol to\'lov topilmadi'); return; }
        if (!confirm('To\'lov qo\'lda tasdiqlansinmi? Bu amal xavfsizlik jurnaliga yoziladi.')) return;
        this.stopPolling();
        this.onPaid(this.pending.sale.id, this.pending.provider, this.pending.orderId, 'MANUAL', true);
    },
    /** To'lov tasdiqlanganda savdoni yopadi, ombor va shartnomani yangilaydi */
    onPaid(saleId, providerId, orderId, txnId, manual) {
        const sale = salesHistory.find(s => Number(s.id) === Number(saleId));
        if (!sale) { showNotif('error', 'Topilmadi', `#${saleId} savdo topilmadi`); return; }
        if (sale.status === 'paid') {
            closeModal('paymentModal');
            showNotif('info', 'Allaqachon to\'langan', `#${saleId} savdo tasdiqlangan`);
            return;
        }
        sale.status = 'paid';
        sale.paidAt = new Date().toLocaleString('uz-UZ');
        sale.paymentOrderId = orderId || null;
        sale.txnId = txnId || null;
        sale.provider = providerId;
        sale.pay = PAYMENT_PROVIDERS[providerId]?.label || sale.pay;
        sale.manualConfirm = Boolean(manual);

        // Online to'lov tasdiqlangandan keyingina ombor kamayadi
        (sale.items || []).forEach(ci => {
            const pr = products.find(x => x.id === ci.id);
            if (pr) pr.stock = Math.max(0, pr.stock - ci.qty);
        });

        lastCheckoutSale = sale;
        saveToStorage();
        addLog('To\'lov', `#${saleId} — ${fmt(sale.total)} so'm (${sale.pay}${orderId ? ', order: ' + orderId : ''})`);
        if (manual) {
            securityLog('payment-manual-confirm', 'high',
                `#${saleId} to'lovi qo'lda tasdiqlandi (${sale.pay}, order: ${orderId || '—'})`);
        } else {
            securityLog('payment-confirmed', 'low', `#${saleId} to'lovi server orqali tasdiqlandi (${sale.pay})`);
        }

        // Shartnoma avtomatik shakllanadi
        // Shartnoma AVTOMATIK tuzilmaydi — administrator «Shartnomalar» bo'limida
    // «Qo'lda shartnoma» yoki «Cheklardan import» orqali o'zi tuzadi.

        closeModal('paymentModal');
        renderReceipt(sale);
        openModal('checkoutModal');
        playCheckout();
        showNotif('success', '✅ To\'lov tasdiqlandi!', `${fmt(sale.total)} so'm — ${sale.pay}`);
        renderProducts();
        renderProductGrid();
        renderShop();
        loadDashboard();
        // Fiskal chek (QR-kod) chiqariladi, chek FAQAT shundan keyin chop etiladi
        finishPaidSale(sale);
        this.stopPolling(true);
    },

    /** Sozlamalar bo'limidagi maydonlarni to'ldiradi */
    renderSettings() {
        const def = document.getElementById('paymentDefaultProvider');
        if (def) {
            def.innerHTML = Object.keys(PAYMENT_PROVIDERS)
                .map(id => `<option value="${id}">${escapeHTML(PAYMENT_PROVIDERS[id].label)}</option>`).join('');
            def.value = systemSettings.paymentDefaultProvider || 'cash';
        }
        const warranty = document.getElementById('contractWarrantyMonths');
        if (warranty) warranty.value = String(Number(systemSettings.contractWarrantyMonths) || 12);
        const poll = document.getElementById('paymentPollSeconds');
        if (poll) poll.value = String(Number(systemSettings.paymentPollSeconds) || 3);
        const exp = document.getElementById('paymentExpireMinutes');
        if (exp) exp.value = String(Number(systemSettings.paymentExpireMinutes) || 15);
        this.renderProviderList();
    },

    /** Sozlamalar → To'lov tizimlari jadvalini chizadi */
    renderProviderList() {
        const tbody = document.getElementById('paymentProvidersList');
        if (!tbody) return;
        tbody.innerHTML = Object.values(PAYMENT_PROVIDERS).map(p => {
            const online = isOnlineProvider(p.id);
            const cfg = paymentConfig.providers?.[p.id];
            let statusBadge = '<span class="badge badge-green">Ichki (offline)</span>';
            if (online) {
                if (!paymentConfig.serverOnline) statusBadge = '<span class="badge badge-gray">Server ulanmagan</span>';
                else if (cfg?.enabled) statusBadge = '<span class="badge badge-green">Ulangan ✅</span>';
                else statusBadge = '<span class="badge badge-yellow">Sozlanmagan ⚠️</span>';
            }
            return `<tr>
      <td><strong>${escapeHTML(p.label)}</strong><div style="font-size:11px;color:var(--muted)">${escapeHTML(p.note)}</div></td>
      <td><span class="badge badge-blue">${escapeHTML(p.kind)}</span></td>
      <td>${statusBadge}</td>
      <td style="font-size:12px;color:var(--muted)">${p.env ? `<code>${escapeHTML(p.env)}</code>` : '—'}</td>
      <td>${providerActive(p.id) ? '<span class="badge badge-green">Faol</span>' : '<span class="badge badge-gray">O\'chirilgan</span>'}</td>
    </tr>`;
        }).join('');
    }
};

/** To'lov/kliring sozlamalarini saqlaydi (maxfiy kalitlar serverda qoladi) */
function savePaymentPreferences() {
    if (!requireRole('admin')) return;
    systemSettings.paymentDefaultProvider = document.getElementById('paymentDefaultProvider')?.value || 'cash';
    systemSettings.contractWarrantyMonths = Math.max(1, Math.min(120, Number(document.getElementById('contractWarrantyMonths')?.value) || 12));
    systemSettings.paymentPollSeconds = Math.max(2, Math.min(60, Number(document.getElementById('paymentPollSeconds')?.value) || 3));
    systemSettings.paymentExpireMinutes = Math.max(1, Math.min(120, Number(document.getElementById('paymentExpireMinutes')?.value) || 15));
    // Shartnomalar qo'lda tuziladi — avtomatik rejim sozlamasi yo'q
    persistSystemSettings();
    renderShopPayOptions();
    renderPayTypes();
    securityLog('payment-settings', 'medium',
        `Savdo sozlamalari saqlandi: standart ${systemSettings.paymentDefaultProvider}, kafolat ${systemSettings.contractWarrantyMonths} oy`);
    addLog('Sozlama', 'To\'lov va shartnoma sozlamalari saqlandi');
    playSuccess();
    showNotif('success', 'Saqlandi!', 'To\'lov va shartnoma sozlamalari yangilandi');
}
/**
 * Backend mavjud bo'lmaganda ishlatiladigan zaxira havola.
 * Faqat ochiq (maxfiy bo'lmagan) merchant ID'lar bilan quriladi.
 * Tasdiqlash bu holatda faqat admin tomonidan qo'lda amalga oshiriladi.
 */
function buildLocalPayLink(providerId, amount, saleId) {
    const amountNum = Math.round(Number(amount) || 0);
    const amountTiyin = amountNum * 100;
    const orderId = 'TP-' + saleId + '-' + String(Date.now()).slice(-5);
    const returnUrl = encodeURIComponent(window.location.origin + window.location.pathname);
    try {
        if (providerId === 'click') {
            const serviceId = systemSettings.clickServiceId || '';
            const merchantId = systemSettings.clickMerchantId || '';
            if (!serviceId || !merchantId) return '';
            return `https://my.click.uz/services/pay?service_id=${encodeURIComponent(serviceId)}` +
                `&merchant_id=${encodeURIComponent(merchantId)}&amount=${amountNum}` +
                `&transaction_param=${encodeURIComponent(orderId)}&return_url=${returnUrl}`;
        }
        if (providerId === 'payme') {
            const merchantId = systemSettings.paymeMerchantId || '';
            if (!merchantId) return '';
            const payload = `m=${merchantId};ac.order_id=${orderId};a=${amountTiyin};l=uz;c=${returnUrl}`;
            return 'https://checkout.paycom.uz/' + btoa(payload);
        }
        return '';
    } catch (e) {
        return '';
    }
}

function buildProviderUssd(providerId, amount) {
    const amountNum = Math.round(Number(amount) || 0);
    if (providerId === 'click') {
        const serviceId = systemSettings.clickServiceId || '33303';
        return `*880*1*${serviceId}*${amountNum}#`;
    }
    return '';
}
/* ============================================================
   SHARTNOMALAR MODULI — savdo/online buyurtma asosida AVTOMATIK
   shakllantiriladi, raqam va kafolat muddati o'zi hisoblanadi.
   ============================================================ */
let contracts = safeJsonParse(localStorage.getItem('tp_contracts') || 'null', null);
if (!Array.isArray(contracts)) contracts = [];
contracts = contracts.map(normalizeContract).filter(c => c && c.customer);
let contractsSyncTimer = null;
let editingContractId = null;

const CONTRACT_STATUS = {
    active: { label: 'Faol', badge: 'badge-green' },
    expiring: { label: 'Muddati yaqin', badge: 'badge-yellow' },
    expired: { label: "Muddati o'tgan", badge: 'badge-red' },
    cancelled: { label: 'Bekor qilingan', badge: 'badge-gray' }
};

const CONTRACT_TYPES = [
    'Savdo shartnomasi',
    'Online buyurtma shartnomasi',
    'Xizmat ko\'rsatish shartnomasi',
    'Kafolat shartnomasi',
    'Muddatli to\'lov shartnomasi',
    'Yetkazib berish shartnomasi'
];

function isoDate(date = new Date()) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateISO(iso) {
    if (!iso) return '—';
    const parts = String(iso).split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : String(iso);
}

function addMonthsISO(iso, months) {
    const d = new Date(String(iso) + 'T00:00:00');
    if (isNaN(d.getTime())) return isoDate();
    d.setMonth(d.getMonth() + Number(months || 0));
    return isoDate(d);
}

function uzDateToISO(str) {
    const m = String(str || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function extractPhone(text) {
    const m = String(text || '').match(/\+?\d[\d\s\-()]{6,}/);
    return m ? m[0].trim() : '';
}

function contractStatusFor(endDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(String(endDate) + 'T00:00:00');
    if (isNaN(end.getTime())) return 'active';
    const days = Math.round((end - today) / 86400000);
    if (days < 0) return 'expired';
    if (days <= 30) return 'expiring';
    return 'active';
}

function normalizeContract(c) {
    if (!c || typeof c !== 'object') return null;
    const warranty = Math.min(120, Math.max(1, Number(c.warrantyMonths) || Number(systemSettings.contractWarrantyMonths) || 12));
    const start = /^\d{4}-\d{2}-\d{2}$/.test(c.startDate) ? c.startDate : isoDate();
    const end = /^\d{4}-\d{2}-\d{2}$/.test(c.endDate) ? c.endDate : addMonthsISO(start, warranty);
    const status = Object.keys(CONTRACT_STATUS).includes(c.status) ? c.status : 'active';
    return {
        id: Number(c.id) || Date.now(),
        number: cleanText(c.number, 40) || ('SH-' + new Date().getFullYear() + '-0001'),
        type: cleanText(c.type, 80) || 'Savdo shartnomasi',
        saleId: c.saleId != null && c.saleId !== '' ? Number(c.saleId) : null,
        customer: cleanText(c.customer, 120) || '',
        phone: cleanText(c.phone, 40),
        items: Array.isArray(c.items) ? c.items.slice(0, 50).map(i => ({
            name: cleanText(i?.name, 120),
            qty: Math.max(1, Number(i?.qty) || 1),
            price: Math.max(0, Number(i?.price) || 0)
        })) : [],
        subject: cleanText(c.subject, 300),
        amount: Math.max(0, Number(c.amount) || 0),
        payType: cleanText(c.payType, 40),
        warrantyMonths: warranty,
        startDate: start,
        endDate: end,
        status,
        auto: Boolean(c.auto),
        createdBy: cleanText(c.createdBy, 120),
        createdAt: cleanText(c.createdAt, 40) || new Date().toLocaleString('uz-UZ'),
        note: cleanText(c.note, 300),
        printed: Math.max(0, Number(c.printed) || 0)
    };
}

function saveContracts() {
    try {
        localStorage.setItem('tp_contracts', JSON.stringify(contracts));
    } catch (e) {
        console.warn('Shartnomalarni saqlab bo\'lmadi:', e);
    }
    scheduleSyncWithBackend(); // shartnomalar bazaga yoziladi
}

function nextContractNumber() {
    const prefix = `SH-${new Date().getFullYear()}-`;
    let max = 0;
    contracts.forEach(c => {
        const m = String(c.number || '').match(new RegExp('^' + prefix + '(\\d+)$'));
        if (m) max = Math.max(max, Number(m[1]));
    });
    return prefix + String(max + 1).padStart(4, '0');
}

function contractItemsSummary(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '';
    const head = list.slice(0, 3).map(i => `${i.name} x${i.qty}`).join(', ');
    return list.length > 3 ? `${head} va yana ${list.length - 3} ta` : head;
}
/**
 * Shartnoma formasidagi ro'yxatlarni to'ldiradi: oxirgi savdo cheklari va
 * mavjud mijozlar (admin uchun qulaylik; hech narsa avtomatik yaratilmaydi).
 */
function populateContractEditSources() {
    const saleSel = document.getElementById('ct-sale');
    if (saleSel) {
        const recent = salesHistory.slice(-60).reverse();
        saleSel.innerHTML = '<option value="">— chek tanlanmagan (qo\'lda kiritish) —</option>' +
            recent.map(s => `<option value="${Number(s.id)}">#${Number(s.id)} · ` +
                `${escapeHTML(cleanText(s.customer, 40) || 'Mijozsiz')} · ` +
                `${fmt(Number(s.total) || 0)} so'm</option>`).join('');
        saleSel.value = '';
    }
    const list = document.getElementById('contractCustomerList');
    if (list) {
        list.innerHTML = customers.slice(0, 200).map(c =>
            `<option value="${escapeHTML(c.name)}">${escapeHTML(c.phone || '')}</option>`).join('');
    }
}

/** Chek tanlanganda forma maydonlarini o'sha chekdan to'ldiradi (admin tanlovi) */
function applyContractSaleSelection() {
    const saleId = Number(document.getElementById('ct-sale')?.value) || 0;
    if (!saleId) return;
    const sale = salesHistory.find(s => Number(s.id) === saleId);
    if (!sale) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    if (sale.customer) set('ct-customer', cleanText(sale.customer, 120));
    const phone = extractPhone(sale.customer || '');
    if (phone) set('ct-phone', phone);
    set('ct-amount', String(Number(sale.total) || 0));
    const summary = contractItemsSummary(sale.items);
    if (summary) set('ct-subject', summary);
    const typeSel = document.getElementById('ct-type');
    if (typeSel) {
        const t = /online/i.test(String(sale.cashier || ''))
            ? 'Online buyurtma shartnomasi' : 'Savdo shartnomasi';
        if (Array.from(typeSel.options).some(o => o.value === t)) typeSel.value = t;
    }
}

/**
 * Savdo chekidan shartnoma yasaydi.
 * DIQQAT: bu funksiya faqat administratorning aniq amali bilan chaqiriladi
 * (`Contracts.importFromSales` yoki shartnoma formasidagi chekni tanlash) —
 * hech qanday avtomatik yaratish yo'q.
 */
function buildContractFromSale(sale, byAdmin = true) {
    const warranty = Number(systemSettings.contractWarrantyMonths) || 12;
    const start = uzDateToISO(sale?.date) || isoDate();
    const customer = cleanText(sale?.customer, 120) || 'Noma\'lum mijoz';
    const isOnline = /online/i.test(String(sale?.cashier || '') + ' ' + customer);
    return normalizeContract({
        id: Date.now() + Math.floor(Math.random() * 1000),
        number: nextContractNumber(),
        type: isOnline ? 'Online buyurtma shartnomasi' : 'Savdo shartnomasi',
        saleId: sale?.id != null ? sale.id : null,
        customer,
        phone: extractPhone(customer),
        items: sale?.items || [],
        subject: contractItemsSummary(sale?.items),
        amount: sale?.total,
        payType: sale?.pay,
        warrantyMonths: warranty,
        startDate: start,
        endDate: addMonthsISO(start, warranty),
        status: 'active',
        auto: true,
        createdBy: byAdmin ? (currentUser?.name || 'Administrator') : (sale?.cashier || 'Tizim'),
        createdAt: new Date().toLocaleString('uz-UZ'),
        note: byAdmin ? 'Administrator tasdig\'i bilan chek asosida tuzilgan'
                      : 'Savdo asosida shakllantirilgan'
    });
}

/** Kafolat muddati bo'yicha holatlarni avtomatik yangilaydi */
function refreshContractStatuses() {
    let changed = 0;
    contracts.forEach(c => {
        if (c.status === 'cancelled') return;
        const next = contractStatusFor(c.endDate);
        if (next !== c.status) {
            c.status = next;
            changed++;
        }
    });
    return changed;
}

function updateContractsBadge() {
    const badge = document.getElementById('navContractsBadge');
    if (badge) badge.textContent = String(contracts.length);
    const autoEl = document.getElementById('contractAutoCount');
    if (autoEl) {
        const fromReceipts = contracts.filter(c => c.auto || c.saleId != null).length;
        autoEl.textContent = `${contracts.length} ta (${fromReceipts} ta chek asosida)`;
    }
    const lastSync = document.getElementById('contractLastSync');
    if (lastSync) lastSync.textContent = new Date().toLocaleTimeString('uz-UZ');
}

const Contracts = {
    /**
     * Modulni ishga tushirish.
     * MUHIM: shartnoma hech qachon avtomatik yaratilmaydi — faqat
     * administrator «Qo'lda shartnoma» tugmasi orqali o'zi tuzadi.
     * Bu yerda faqat kafolat muddati holatlari yangilanadi.
     */
    init() {
        this.syncAll(false);
        if (contractsSyncTimer) clearInterval(contractsSyncTimer);
        const seconds = Math.max(15, Math.min(600, Number(systemSettings.contractSyncSeconds) || 60));
        contractsSyncTimer = setInterval(() => this.syncAll(false), seconds * 1000);
    },

    /** Kafolat muddati holatlarini yangilaydi (shartnoma yaratmaydi) */
    syncAll(manual = false) {
        const changed = refreshContractStatuses();
        if (changed) {
            saveContracts();
            addLog('Shartnoma', `${changed} ta shartnoma holati yangilandi`);
        }
        updateContractsBadge();
        if (document.getElementById('contractsTable')) this.render();
        if (manual) {
            playSuccess();
            showNotif('success', 'Yangilandi',
                changed ? `${changed} ta shartnoma holati yangilandi`
                        : 'Barcha shartnoma holatlari joyida');
        }
        return { created: 0, changed };
    },

    /**
     * Savdo chekidan shartnoma tuzish — faqat administrator qaroriga ko'ra,
     * qo'lda ishga tushiriladi (tasdiqlash so'raladi).
     */
    importFromSales() {
        if (!requireRole('admin')) return;
        const existing = new Set(contracts.filter(c => c.saleId != null).map(c => Number(c.saleId)));
        const candidates = salesHistory.filter(s => s && Number(s.total) > 0 && !existing.has(Number(s.id)));
        if (!candidates.length) {
            showNotif('info', 'Yangi yozuv yo\'q', 'Barcha savdo cheklari uchun shartnoma allaqachon tuzilgan');
            return;
        }
        if (!confirm(`${candidates.length} ta savdo cheki uchun shartnoma tuzilsinmi?\n\n` +
            'Har bir shartnoma chekdagi mijoz, summa va kafolat muddati bilan yaratiladi.')) return;
        let created = 0;
        candidates.slice(-200).forEach(sale => {
            const contract = buildContractFromSale(sale, true);
            if (!contract) return;
            contracts.push(contract);
            existing.add(Number(sale.id));
            created++;
        });
        if (created) {
            refreshContractStatuses();
            saveContracts();
            addLog('Shartnoma', `${created} ta shartnoma savdo cheklaridan qo'lda yaratildi`);
            securityLog('contracts-imported', 'low',
                `${created} ta shartnoma administrator tomonidan cheklardan yaratildi`);
            playSuccess();
            showNotif('success', 'Tayyor', `${created} ta shartnoma yaratildi`);
        }
        updateContractsBadge();
        this.render();
    },

    getFiltered() {
        const q = cleanText(document.getElementById('contractSearch')?.value, 80).toLowerCase();
        const status = document.getElementById('contractStatusFilter')?.value || '';
        const type = document.getElementById('contractTypeFilter')?.value || '';
        return contracts.filter(c => {
            if (status && c.status !== status) return false;
            if (type === 'auto' && !c.auto) return false;
            if (type === 'manual' && c.auto) return false;
            if (q) {
                const hay = `${c.number} ${c.customer} ${c.phone} ${c.subject} ${c.type}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        }).sort((a, b) => Number(b.id) - Number(a.id));
    },
    stats() {
        return {
            total: contracts.length,
            active: contracts.filter(c => c.status === 'active').length,
            expiring: contracts.filter(c => c.status === 'expiring').length,
            expired: contracts.filter(c => c.status === 'expired').length,
            amount: contracts.filter(c => c.status !== 'cancelled').reduce((s, c) => s + c.amount, 0)
        };
    },

    /** Shartnomalar sahifasini (statistika + jadval) chizadi */
    render() {
        const s = this.stats();
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setText('contractTotal', s.total);
        setText('contractActive', s.active);
        setText('contractExpiring', s.expiring);
        setText('contractExpired', s.expired);

        const tbody = document.getElementById('contractsTable');
        if (!tbody) { updateContractsBadge(); return; }
        // Shartnomalarni faqat administrator tahrirlaydi/o'chiradi
        const canManage = currentUser?.role === 'admin';
        const isAdmin = canManage;
        const list = this.getFiltered();

        tbody.innerHTML = list.map(c => {
            const st = CONTRACT_STATUS[c.status] || CONTRACT_STATUS.active;
            return `<tr>
      <td>
        <strong>${escapeHTML(c.number)}</strong>
        <div style="font-size:11px;color:var(--muted)">
          ${c.auto ? '<i class="fas fa-wand-magic-sparkles"></i> Avtomatik' : '<i class="fas fa-pen"></i> Qo\'lda'}
          ${c.saleId ? ' • Chek #' + Number(c.saleId) : ''}
        </div>
      </td>
      <td>${escapeHTML(c.customer)}
        <div style="font-size:11px;color:var(--muted)">${escapeHTML(c.phone || '—')}</div>
      </td>
      <td><span class="badge badge-blue">${escapeHTML(c.type)}</span></td>
      <td style="font-weight:700;color:var(--primary)">${fmt(c.amount)} so'm</td>
      <td style="font-size:12px">${fmtDateISO(c.startDate)} → ${fmtDateISO(c.endDate)}
        <div style="font-size:11px;color:var(--muted)">${c.warrantyMonths} oy kafolat</div>
      </td>
      <td><span class="badge ${st.badge}">${st.label}</span></td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" onclick="Contracts.view(${c.id})" title="Ko'rish"><i
              class="fas fa-eye"></i></button>
          <button class="btn btn-outline btn-sm" onclick="Contracts.print(${c.id})" title="Chop etish"><i
              class="fas fa-print"></i></button>
          ${canManage ? `<button class="btn btn-outline btn-sm" onclick="Contracts.edit(${c.id})" title="Tahrirlash"><i
              class="fas fa-pen"></i></button>` : ''}
          ${isAdmin ? `<button class="btn btn-danger btn-sm" onclick="Contracts.remove(${c.id})" title="O'chirish"><i
              class="fas fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
        }).join('') ||
            '<tr><td colspan="7" style="text-align:center;padding:28px;color:var(--muted)">Shartnoma yo\'q — yuqoridagi «Qo\'lda shartnoma» tugmasi bilan o\'zingiz tuzasiz</td></tr>';
        updateContractsBadge();
    },

    openAddModal() {
        // Shartnoma tuzish huquqi faqat administratorda
        if (!requireRole('admin')) return;
        editingContractId = null;
        const title = document.getElementById('contractModalTitle');
        if (title) title.innerHTML = '<i class="fas fa-file-signature" style="color:var(--primary);margin-right:8px"></i>Yangi shartnoma (qo\'lda)';
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        set('ct-customer', '');
        set('ct-phone', '');
        set('ct-amount', '');
        set('ct-start', isoDate());
        set('ct-warranty', String(Number(systemSettings.contractWarrantyMonths) || 12));
        set('ct-subject', '');
        set('ct-note', '');
        const typeSel = document.getElementById('ct-type');
        if (typeSel) {
            typeSel.innerHTML = CONTRACT_TYPES.map(t => `<option>${escapeHTML(t)}</option>`).join('');
            typeSel.value = 'Xizmat ko\'rsatish shartnomasi';
        }
        populateContractEditSources();
        openModal('contractModal');
    },

    edit(id) {
        if (!requireRole('admin')) return;
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        editingContractId = c.id;
        const title = document.getElementById('contractModalTitle');
        if (title) title.innerHTML = `<i class="fas fa-pen" style="color:var(--primary);margin-right:8px"></i>${escapeHTML(c.number)} — tahrirlash`;
        const typeSel = document.getElementById('ct-type');
        if (typeSel) {
            typeSel.innerHTML = CONTRACT_TYPES.map(t => `<option>${escapeHTML(t)}</option>`).join('');
            typeSel.value = CONTRACT_TYPES.includes(c.type) ? c.type : CONTRACT_TYPES[0];
        }
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        set('ct-customer', c.customer);
        set('ct-phone', c.phone);
        set('ct-amount', String(c.amount));
        set('ct-start', c.startDate);
        set('ct-warranty', String(c.warrantyMonths));
        set('ct-subject', c.subject);
        set('ct-note', c.note);
        openModal('contractModal');
    },
    /** Qo'lda kiritilgan shartnomani saqlaydi (faqat administrator) */
    save() {
        if (!requireRole('admin')) return;
        const customer = validateSafeInput('Mijoz F.I.Sh', document.getElementById('ct-customer')?.value, 120);
        if (customer === null) return;
        if (!customer.trim()) {
            playError(); showNotif('error', 'Xato!', 'Mijoz ismini kiriting'); return;
        }
        const phone = validateSafeInput('Telefon', document.getElementById('ct-phone')?.value, 40);
        if (phone === null) return;
        const saleId = Number(document.getElementById('ct-sale')?.value) || null;
        const subject = validateSafeInput('Shartnoma predmeti', document.getElementById('ct-subject')?.value, 300);
        if (subject === null) return;
        const note = validateSafeInput('Izoh', document.getElementById('ct-note')?.value, 300);
        if (note === null) return;

        const type = cleanText(document.getElementById('ct-type')?.value, 80) || CONTRACT_TYPES[2];
        const amount = Math.max(0, Number(document.getElementById('ct-amount')?.value) || 0);
        const startInput = document.getElementById('ct-start')?.value || '';
        const start = /^\d{4}-\d{2}-\d{2}$/.test(startInput) ? startInput : isoDate();
        const warranty = Math.min(120, Math.max(1, Number(document.getElementById('ct-warranty')?.value) || 12));
        const endDate = addMonthsISO(start, warranty);

        if (editingContractId) {
            const c = contracts.find(x => Number(x.id) === Number(editingContractId));
            if (!c) return;
            Object.assign(c, {
                customer, phone, type, amount, subject, note,
                warrantyMonths: warranty, startDate: start, endDate,
                status: c.status === 'cancelled' ? 'cancelled' : contractStatusFor(endDate)
            });
            addLog('Shartnoma', `${c.number} tahrirlandi`);
            showNotif('success', 'Saqlandi!', `${c.number} yangilandi`);
        } else {
            const contract = normalizeContract({
                id: Date.now(),
                number: nextContractNumber(),
                type, customer, phone, subject, amount,
                warrantyMonths: warranty, startDate: start, endDate,
                status: contractStatusFor(endDate),
                saleId: saleId,
                auto: Boolean(saleId),
                createdBy: currentUser?.name || 'Admin',
                createdAt: new Date().toLocaleString('uz-UZ'),
                note: note || (saleId ? `Chek #${saleId} asosida tuzilgan (admin)`
                                     : 'Qo\'lda kiritilgan shartnoma')
            });
            contracts.unshift(contract);
            addLog('Shartnoma', `${contract.number} tuzildi (${contract.customer})`);
            showNotif('success', 'Qo\'shildi!', `${contract.number} yaratildi`);
        }
        saveContracts();
        closeModal('contractModal');
        playSuccess();
        this.render();
    },
    /** Shartnoma tafsilotlarini modalda ko'rsatadi */
    view(id) {
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        const st = CONTRACT_STATUS[c.status] || CONTRACT_STATUS.active;
        const canManage = currentUser?.role === 'admin';
        const isAdmin = canManage;
        const itemsHtml = c.items.length
            ? `<table class="contract-items-table"><thead><tr><th>Mahsulot</th><th>Soni</th><th>Narxi</th><th>Jami</th></tr></thead>
         <tbody>${c.items.map(i => `<tr><td>${escapeHTML(i.name)}</td><td>${i.qty}</td>
           <td>${fmt(i.price)}</td><td>${fmt(i.price * i.qty)}</td></tr>`).join('')}</tbody></table>`
            : `<p style="color:var(--muted);font-size:13px">${escapeHTML(c.subject || 'Mahsulot/xizmat kiritilmagan')}</p>`;

        const title = document.getElementById('contractViewTitle');
        if (title) title.innerHTML = `<i class="fas fa-file-contract" style="color:var(--primary);margin-right:8px"></i>${escapeHTML(c.number)}`;
        const body = document.getElementById('contractViewBody');
        if (body) {
            body.innerHTML = `
      <div class="contract-view-head">
        <div>
          <div class="cv-label">Mijoz</div>
          <div class="cv-value">${escapeHTML(c.customer)}</div>
          <div class="cv-sub">${escapeHTML(c.phone || 'Telefon kiritilmagan')}</div>
        </div>
        <div style="text-align:right">
          <span class="badge ${st.badge}">${st.label}</span>
          <div class="cv-sub" style="margin-top:6px">${c.auto ? 'Avtomatik yaratilgan' : 'Qo\'lda kiritilgan'}</div>
        </div>
      </div>
      <div class="cv-grid">
        <div><span class="cv-label">Shartnoma turi</span><b>${escapeHTML(c.type)}</b></div>
        <div><span class="cv-label">Summa</span><b>${fmt(c.amount)} so'm</b></div>
        <div><span class="cv-label">To'lov usuli</span><b>${escapeHTML(c.payType || '—')}</b></div>
        <div><span class="cv-label">Kafolat muddati</span><b>${c.warrantyMonths} oy</b></div>
        <div><span class="cv-label">Boshlanish</span><b>${fmtDateISO(c.startDate)}</b></div>
        <div><span class="cv-label">Tugash</span><b>${fmtDateISO(c.endDate)}</b></div>
        <div><span class="cv-label">Yaratgan</span><b>${escapeHTML(c.createdBy || '—')}</b></div>
        <div><span class="cv-label">Yaratilgan vaqt</span><b>${escapeHTML(c.createdAt)}</b></div>
      </div>
      <div style="margin:14px 0 8px"><span class="cv-label">Shartnoma predmeti</span></div>
      ${itemsHtml}
      ${c.note ? `<div class="contract-note"><i class="fas fa-circle-info"></i> ${escapeHTML(c.note)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="Contracts.print(${c.id})"><i class="fas fa-print"></i> Chop etish</button>
        ${canManage ? `<button class="btn btn-outline btn-sm" onclick="closeModal('contractViewModal');Contracts.edit(${c.id})"><i class="fas fa-pen"></i> Tahrirlash</button>` : ''}
        ${canManage && c.status !== 'cancelled' ? `<button class="btn btn-outline btn-sm" onclick="Contracts.extend(${c.id})"><i class="fas fa-calendar-plus"></i> Kafolatni uzaytirish</button>` : ''}
        ${isAdmin && c.status !== 'cancelled' ? `<button class="btn btn-danger btn-sm" onclick="Contracts.cancelContract(${c.id})"><i class="fas fa-ban"></i> Bekor qilish</button>` : ''}
      </div>`;
        }
        openModal('contractViewModal');
    },
    /** Shartnomani chop etish uchun tayyorlaydi (A4 print) */
    print(id) {
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        const area = document.getElementById('printArea');
        if (!area) { window.print(); return; }
        area.innerHTML = buildContractPrintHTML(c);
        // Chek (80mm) o'rniga A4 hujjat rejimi
        area.classList.add('contract-mode');
        area.style.display = 'block';
        c.printed = (c.printed || 0) + 1;
        saveContracts();
        addLog('Shartnoma', `${c.number} chop etishga yuborildi`);
        setTimeout(() => {
            window.print();
            setTimeout(() => {
                area.style.display = 'none';
                area.innerHTML = '';
                area.classList.remove('contract-mode');
            }, 600);
        }, 200);
    },

    /** Kafolat muddatini avtomatik uzaytiradi */
    extend(id) {
        if (!requireRole('admin', 'manager')) return;
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        const extra = Number(systemSettings.contractWarrantyMonths) || 12;
        if (!confirm(`${c.number} kafolati ${extra} oyga uzaytirilsinmi?`)) return;
        const base = contractStatusFor(c.endDate) === 'expired' ? isoDate() : c.endDate;
        c.endDate = addMonthsISO(base, extra);
        c.warrantyMonths = Math.min(120, c.warrantyMonths + extra);
        c.status = contractStatusFor(c.endDate);
        c.note = cleanText(`${c.note ? c.note + ' | ' : ''}Kafolat uzaytirildi (+${extra} oy, ${new Date().toLocaleDateString('uz-UZ')})`, 300);
        saveContracts();
        addLog('Shartnoma', `${c.number} kafolati ${extra} oyga uzaytirildi`);
        securityLog('contract-extended', 'medium', `${c.number} kafolati uzaytirildi (+${extra} oy)`);
        closeModal('contractViewModal');
        playSuccess();
        showNotif('success', 'Uzaytirildi!', `Yangi tugash sanasi: ${fmtDateISO(c.endDate)}`);
        this.render();
    },

    /** Shartnomani bekor qiladi (faqat admin) */
    cancelContract(id) {
        if (!requireRole('admin')) return;
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        const reason = prompt('Bekor qilish sababini kiriting:', 'Mijoz talabiga ko\'ra');
        if (reason === null) return;
        const safeReason = cleanText(reason, 160) || 'Sabab ko\'rsatilmagan';
        c.status = 'cancelled';
        c.note = cleanText(`${c.note ? c.note + ' | ' : ''}Bekor qilindi: ${safeReason}`, 300);
        saveContracts();
        addLog('Shartnoma', `${c.number} bekor qilindi (${safeReason})`);
        securityLog('contract-cancelled', 'high', `${c.number} bekor qilindi: ${safeReason}`);
        closeModal('contractViewModal');
        playSuccess();
        showNotif('info', 'Bekor qilindi', `${c.number} bekor qilindi`);
        this.render();
    },

    /** Shartnomani butunlay o'chiradi (faqat admin) */
    remove(id) {
        if (!requireRole('admin')) return;
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        if (!confirm(`${c.number} shartnomasini butunlay o'chirmoqchimisiz?`)) return;
        contracts = contracts.filter(x => Number(x.id) !== Number(id));
        saveContracts();
        addLog('Shartnoma', `${c.number} o'chirildi (${c.customer})`);
        securityLog('contract-deleted', 'high', `${c.number} o'chirildi`);
        showNotif('info', 'O\'chirildi', `${c.number} o'chirildi`);
        this.render();
    },

    /** CSV eksport */
    exportCSV() {
        if (!requireRole('admin', 'manager')) return;
        const header = ['Shartnoma №', 'Mijoz', 'Telefon', 'Turi', 'Summa', 'To\'lov usuli',
            'Boshlanish', 'Tugash', 'Kafolat (oy)', 'Holat', 'Yaratilgan', 'Manba'];
        const rows = this.getFiltered().map(c => [
            c.number, c.customer, c.phone, c.type, c.amount, c.payType,
            fmtDateISO(c.startDate), fmtDateISO(c.endDate), c.warrantyMonths,
            (CONTRACT_STATUS[c.status]?.label || c.status), c.createdAt, c.auto ? 'Avtomatik' : 'Qo\'lda'
        ]);
        const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
        downloadCSV(csv, 'shartnomalar');
        showNotif('success', 'Eksport!', `${rows.length} ta shartnoma CSV faylga yuklandi`);
    }
};
/** Chop etish uchun rasmiy shartnoma hujjati (A4 HTML) */
function buildContractPrintHTML(c) {
    const itemsRows = c.items.length
        ? c.items.map((i, idx) => `<tr><td>${idx + 1}</td><td>${escapeHTML(i.name)}</td><td>${i.qty}</td>
        <td>${fmt(i.price)}</td><td>${fmt(i.price * i.qty)}</td></tr>`).join('')
        : `<tr><td>1</td><td>${escapeHTML(c.subject || '—')}</td><td>1</td><td>${fmt(c.amount)}</td><td>${fmt(c.amount)}</td></tr>`;
    const st = CONTRACT_STATUS[c.status] || CONTRACT_STATUS.active;
    return `
  <div class="contract-doc">
    <div class="cd-head">
      <div class="cd-brand">TEXNO PARK</div>
      <div class="cd-sub">Chilonzor 12, Toshkent • +998 90 123 45 67 • www.texnopark.uz</div>
    </div>
    <h1 class="cd-title">${escapeHTML(c.type)}</h1>
    <div class="cd-meta">
      <div><b>Shartnoma raqami:</b> ${escapeHTML(c.number)}</div>
      <div><b>Sana:</b> ${fmtDateISO(c.startDate)}</div>
      <div><b>Holat:</b> ${st.label}</div>
      <div><b>Kafolat:</b> ${c.warrantyMonths} oy (${fmtDateISO(c.endDate)} gacha)</div>
    </div>
    <div class="cd-parties">
      <div><b>Ijrochi:</b> "Texno Park" MChJ, INN 123456789</div>
      <div><b>Buyurtmachi:</b> ${escapeHTML(c.customer)}${c.phone ? ', tel: ' + escapeHTML(c.phone) : ''}</div>
    </div>
    <table class="cd-table">
      <thead><tr><th>#</th><th>Mahsulot / xizmat</th><th>Soni</th><th>Narxi (so'm)</th><th>Jami (so'm)</th></tr></thead>
      <tbody>${itemsRows}</tbody>
      <tfoot><tr><td colspan="4" class="cd-right">UMUMIY SUMMA:</td><td><b>${fmt(c.amount)}</b></td></tr></tfoot>
    </table>
    <div class="cd-terms">
      <p>1. Ijrochi yuqorida ko'rsatilgan tovar/xizmatlarni sifatli va kelishilgan muddatda taqdim etishga majbur.</p>
      <p>2. Buyurtmachi to'lovni ${escapeHTML(c.payType || 'kelishilgan usul')} orqali amalga oshiradi.</p>
      <p>3. Kafolat muddati ${c.warrantyMonths} oy: ${fmtDateISO(c.startDate)} — ${fmtDateISO(c.endDate)}.</p>
      <p>4. Kafolat muddatida zavod nuqsoni aniqlansa, ta'mirlash yoki almashtirish bepul amalga oshiriladi.</p>
      ${c.note ? `<p>5. Qo'shimcha shartlar: ${escapeHTML(c.note)}</p>` : ''}
    </div>
    <div class="cd-signs">
      <div><b>Ijrochi:</b> ____________________ / Texno Park /</div>
      <div><b>Buyurtmachi:</b> ____________________ / ${escapeHTML(c.customer)} /</div>
    </div>
    <div class="cd-foot">
      Shartnoma tizim tomonidan avtomatik shakllantirildi • ${escapeHTML(c.createdAt)} • Mas'ul: ${escapeHTML(c.createdBy || '—')}
    </div>
  </div>`;
}
/* [CONTRACTS-MODULE-END] */

applySavedTheme();
initApp();
goTo('page-shop', document.getElementById('nav-shop'));

// ============================================================
// DYNAMIC RENDER FUNCTIONS FOR NEW PAGES
// ============================================================
function renderCategoriesPage() {
    const counts = {};
    CATEGORIES.forEach(c => { counts[c] = 0; });
    products.forEach(p => {
        if (counts[p.cat] === undefined) counts[p.cat] = 0;
        counts[p.cat] += 1;
    });
    const tbody = document.getElementById('categoriesTableBody');
    if (!tbody) return;
    const list = Object.keys(counts).map((cat, i) => `
        <tr>
            <td>${i + 1}</td>
            <td><strong>${categoryEmoji(cat)} ${escapeHTML(cat)}</strong></td>
            <td>${counts[cat]} ta mahsulot</td>
            <td>
                <button class="btn btn-outline btn-sm" onclick="viewCategoryProducts('${escapeHTML(cat)}')"><i class="fas fa-eye"></i> Ko'rish</button>
            </td>
        </tr>
    `).join('');
    tbody.innerHTML = list || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Kategoriyalar yo\'q</td></tr>';
}

/** Kategoriyadagi mahsulotlarni do'konda ko'rsatadi. */
function viewCategoryProducts(cat) {
    shopCat = cat;
    goTo('page-shop', document.getElementById('nav-shop'));
    const search = document.getElementById('shopSearch');
    if (search) search.value = '';
    shopFilter = '';
    renderShop();
}

function renderWarehousePage() {
    const lowStock = products.filter(p => p.stock < 5);
    const totalValue = products.reduce((acc, p) => acc + (p.price * p.stock), 0);

    const valEl = document.getElementById('warehouseTotalValue');
    if (valEl) valEl.textContent = fmt(totalValue) + ' so\'m';

    const lowEl = document.getElementById('warehouseLowStockCount');
    if (lowEl) lowEl.textContent = lowStock.length + ' ta';

    const tbody = document.getElementById('warehouseTableBody');
    if (!tbody) return;

    tbody.innerHTML = products.map((p, i) => `
        <tr>
            <td>${i + 1}</td>
            <td><strong>${escapeHTML(p.name)}</strong></td>
            <td><span class="badge">${escapeHTML(p.cat)}</span></td>
            <td style="font-weight:700;color:${p.stock < 5 ? 'var(--danger)' : 'var(--success)'}">${p.stock} ta</td>
            <td>${fmt(p.price)} so'm</td>
            <td style="font-weight:700">${fmt(p.price * p.stock)} so'm</td>
        </tr>
    `).join('');
}

// Chegirma kampaniyalari — faqat real kiritilgan kampaniyalar (demo yo'q)
let discountCampaigns = safeJsonParse(localStorage.getItem('tp_discounts') || '[]', []);
if (!Array.isArray(discountCampaigns)) discountCampaigns = [];

function renderDiscountsPage() {
    const tbody = document.getElementById('discountsTableBody');
    if (!tbody) return;
    if (discountCampaigns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">Hali chegirma kampaniyalari yo\'q</td></tr>';
        return;
    }
    tbody.innerHTML = discountCampaigns.map((d, i) => `
        <tr>
            <td>${i + 1}</td>
            <td><strong>${escapeHTML(d.name)}</strong></td>
            <td><code style="padding:4px 8px;background:var(--bg);border-radius:6px;font-weight:700;color:var(--primary)">${escapeHTML(d.code)}</code></td>
            <td style="font-weight:700;color:var(--accent)">${d.pct}%</td>
            <td><span class="badge ${d.status === 'Faol' ? 'badge-green' : 'badge-red'}">${d.status}</span></td>
        </tr>
    `).join('');
}

// ============================================================
// AI YORDAMCHI (faqat admin)
// ============================================================
// Server (app.py: /api/assistant/chat) bazadan faqat AGREGAT ko'rsatkichlarni
// o'qiydi va javob qaytaradi. Mijoz shaxsiy ma'lumotlari, parollar va
// kalitlar hech qachon yuborilmaydi; har bir savol xavfsizlik jurnaliga yoziladi.
const Assistant = (() => {
    const history = [];
    let busy = false;

    function formatAnswer(text) {
        return escapeHTML(String(text ?? '')).replace(/\n/g, '<br>');
    }

    function money(n) {
        const num = Math.max(0, Number(n) || 0);
        return num.toLocaleString('uz-UZ').replace(/ /g, ' ') + " so'm";
    }

    /** Lokal (oflayn) ko'rsatkichlar — javob bilan birga ko'rsatiladi. */
    function localStats() {
        const today = new Date().toISOString().slice(0, 10);
        const todaySales = (salesHistory || []).filter(s => s && String(s.date || '').startsWith(today));
        return {
            mahsulot_soni: products.length,
            savdo_soni: (salesHistory || []).length,
            bugungi_daromad_som: todaySales.reduce((sum, s) => sum + (Number(s.total) || 0), 0),
            mijoz_soni: customers.length,
        };
    }

    function renderStats(stats) {
        const box = document.getElementById('ai-stats');
        if (!box) return;
        const s = stats || localStats();
        const cards = [
            ['fa-boxes-stacked', '#60A5FA', 'rgba(59,130,246,.15)', s.mahsulot_soni, 'Mahsulot turi'],
            ['fa-receipt', '#34D399', 'rgba(16,185,129,.15)', s.savdo_soni, 'Jami savdo'],
            ['fa-coins', '#ff8a5b', 'rgba(255,107,53,.15)', money(s.bugungi_daromad_som || 0), 'Bugungi daromad'],
            ['fa-users', '#d8b4fe', 'rgba(168,85,247,.15)', s.mijoz_soni, 'Mijozlar'],
        ];
        box.innerHTML = cards.map(([icon, color, bg, value, label]) => `
            <div class="stat-card">
              <div class="stat-icon" style="background:${bg};color:${color}"><i class="fas ${icon}"></i></div>
              <div class="stat-num">${escapeHTML(String(value))}</div>
              <div class="stat-label">${label}</div>
            </div>
        `).join('');
    }

    function bubble(role, text, source) {
        if (role === 'user') {
            return `<div style="align-self:flex-end;max-width:78%;background:var(--primary);color:#fff;padding:11px 15px;border-radius:14px 14px 4px 14px;font-size:13px;line-height:1.55">${formatAnswer(text)}</div>`;
        }
        if (role === 'error') {
            return `<div style="align-self:flex-start;max-width:82%;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#FCA5A5;padding:11px 15px;border-radius:14px 14px 14px 4px;font-size:13px;line-height:1.55"><i class="fas fa-triangle-exclamation"></i> ${formatAnswer(text)}</div>`;
        }
        const tag = source === 'llm'
            ? '<span class="badge badge-blue" style="margin-left:8px">LLM</span>'
            : '<span class="badge" style="margin-left:8px">Lokal tahlil</span>';
        return `<div style="align-self:flex-start;max-width:82%;background:var(--bg);border:1px solid var(--border);padding:11px 15px;border-radius:14px 14px 14px 4px;font-size:13px;line-height:1.6">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px"><i class="fas fa-robot"></i> AI Yordamchi${tag}</div>
            ${formatAnswer(text)}
        </div>`;
    }

    function render() {
        const chat = document.getElementById('ai-chat');
        if (!chat) return;
        if (!history.length) {
            chat.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:13px;padding:26px 10px">
                <div style="font-size:34px;margin-bottom:8px">🤖</div>
                Salom! Men bazadagi real ko'rsatkichlar asosida javob beraman.<br>
                Pastdagi tayyor savollardan birini tanlang yoki o'zingiz yozing.
            </div>`;
        } else {
            chat.innerHTML = history.map(m => bubble(m.role, m.text, m.source)).join('') +
                (busy ? `<div style="align-self:flex-start;color:var(--text-muted);font-size:13px"><i class="fas fa-spinner fa-spin"></i> Tahlil qilinmoqda...</div>` : '');
        }
        chat.scrollTop = chat.scrollHeight;
    }

    function setBadge(text, className) {
        const badge = document.getElementById('ai-source-badge');
        if (!badge) return;
        badge.textContent = text;
        badge.className = 'badge' + (className ? ' ' + className : '');
    }

    async function send(text) {
        const question = String(text || '').trim().slice(0, 1200);
        const field = document.getElementById('ai-input');
        if (!question || busy) return;

        history.push({ role: 'user', text: question });
        if (field) field.value = '';
        busy = true;
        setBadge('Tahlil qilinmoqda...', 'badge-blue');
        render();

        try {
            const res = await fetch('/api/assistant/chat', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    message: question,
                    history: history
                        .filter(m => m.role === 'user' || m.role === 'assistant')
                        .slice(-7, -1)
                        .map(m => ({ role: m.role, content: m.text }))
                })
            });
            const data = await res.json().catch(() => null);

            if (res.status === 401 || res.status === 403) {
                handleSessionExpired();
                history.push({ role: 'error', text: 'Ruxsat yo\'q. Faqat admin AI yordamchidan foydalanadi — qaytadan kiring.' });
                return;
            }
            if (res.status === 429) {
                history.push({ role: 'error', text: data?.message || 'Savollar chegarasi oshib ketdi — birozdan so\'ng urinib ko\'ring.' });
                return;
            }
            if (!res.ok || !data?.answer) {
                history.push({ role: 'error', text: data?.message || 'Serverdan javob olinmadi. Keyinroq qayta urinib ko\'ring.' });
                return;
            }

            history.push({ role: 'assistant', text: data.answer, source: data.source });
            renderStats(data.stats);
        } catch (e) {
            console.error('AI so\'rovida xatolik:', e);
            history.push({ role: 'error', text: 'Serverga ulanib bo\'lmadi (oflayn rejim).' });
        } finally {
            busy = false;
            setBadge(serverOnline ? 'Server bilan bog\'langan' : 'Oflayn rejim', serverOnline ? 'badge-green' : '');
            render();
        }
    }

    function sendFromInput() {
        const field = document.getElementById('ai-input');
        send(field ? field.value : '');
    }

    function askQuick(btn) {
        send(btn?.textContent || '');
    }

    function reset() {
        history.length = 0;
        render();
    }

    /** Sahifa ochilganda sozlanadi (matn maydonidagi Enter tugmasi). */
    function init() {
        const field = document.getElementById('ai-input');
        if (field && !field.dataset.aiBound) {
            field.dataset.aiBound = '1';
            field.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(field.value);
                }
            });
        }
        renderStats();
        render();
    }

    return { init, render, renderStats, send, sendFromInput, askQuick, reset };
})();

// ============================================================
// GOOGLE OAUTH SIGN-IN
// ============================================================
function handleCredentialResponse(response) {
    try {
        const responsePayload = decodeJwtResponse(response.credential);
        const name = responsePayload.name || 'Google Xaridor';
        const email = responsePayload.email || 'google_user@gmail.com';
        const picture = responsePayload.picture || '';

        currentUser = {
            id: Date.now(),
            login: email,
            name: name,
            role: 'customer',
            color: '#2563EB',
            picture: picture
        };

        loginWithUser(currentUser);
        addLog('Google Kirish', `Google orqali kirdi: ${name} (${email})`);
        showNotif('success', 'Google orqali kirdingiz! 👋', name);
    } catch (e) {
        console.error('Google Sign-In error:', e);
        playError();
        showNotif('error', 'Google Kirish xatosi', 'Tizimga kirib bo\'lmadi');
    }
}

function decodeJwtResponse(token) {
    var base64Url = token.split('.')[1];
    var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    var jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
}

function toggleShopCatSidebar() {
    const sidebar = document.getElementById('shopCatSidebar');
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
    }
}

function loginWithUser(user) {
    // Google yoki sessiya tiklash orqali kirganda sessiya ochilishini kafolatlaymiz
    if (user && !currentSession) startSession(user);
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
    document.getElementById('sideRole').textContent = ROLES[user.role] || 'Xaridor';
    const av = document.getElementById('sideAvatar');
    if (av) {
        if (user.picture) {
            av.innerHTML = `<img src="${user.picture}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
        } else {
            av.textContent = user.name[0];
            av.style.background = `linear-gradient(135deg,${user.color || '#2563EB'},#10B981)`;
        }
    }

    initApp();
    playSuccess();
}

function toggleEmployeesDropdown(el) {
    const submenu = document.getElementById('employees-submenu');
    const arrow = el.querySelector('.submenu-arrow');
    if (submenu) {
        const isOpen = submenu.classList.toggle('open');
        submenu.style.display = isOpen ? 'flex' : 'none';
        if (arrow) {
            arrow.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
        }
    }
}

function openProfileModal() {
    if (!currentUser) {
        showNotif('warning', 'Tizimga kirilmagan', 'Avval tizimga kiring.');
        return;
    }
    const name = currentUser.name;
    const role = currentUser.role;
    const login = currentUser.login;

    const av = document.getElementById('profileModalAvatar');
    if (av) {
        if (currentUser.picture) {
            av.innerHTML = `<img src="${currentUser.picture}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
        } else {
            av.textContent = name[0];
            av.style.background = `linear-gradient(135deg,${currentUser.color || '#2563EB'},#10B981)`;
        }
    }

    const nameEl = document.getElementById('profileModalName');
    if (nameEl) nameEl.textContent = name;

    const roleEl = document.getElementById('profileModalRole');
    if (roleEl) roleEl.textContent = ROLES[role] || 'Xaridor';

    const loginEl = document.getElementById('profileModalLogin');
    if (loginEl) loginEl.textContent = login;

    const roleLabelEl = document.getElementById('profileModalRoleLabel');
    if (roleLabelEl) roleLabelEl.textContent = ROLE_LABELS[role] || 'Xaridor';

    openModal('profileModal');
}

// ============================================================
// INTERACTIVE ELEMENTS (SLIDER & FAQ ACCORDION)
// ============================================================
let currentSlide = 0;
let slideInterval;

function setSlide(index) {
    currentSlide = index;
    const wrapper = document.getElementById('slideWrapper');
    if (wrapper) {
        wrapper.style.transform = `translateX(-${index * 33.333}%)`;
    }

    // Update dots
    const dots = document.querySelectorAll('.slider-dot');
    dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });
}

function startSlideShow() {
    if (slideInterval) clearInterval(slideInterval);
    slideInterval = setInterval(() => {
        currentSlide = (currentSlide + 1) % 3;
        setSlide(currentSlide);
    }, 5000); // Change slide every 5 seconds
}

// Start slideshow and load data on load
document.addEventListener('DOMContentLoaded', () => {
    startSlideShow();
    loadFromBackend();
});
// Fallback if DOMContentLoaded already fired
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startSlideShow();
    loadFromBackend();
}

function toggleFaq(el) {
    const item = el.parentElement;
    const answer = item.querySelector('.faq-answer');

    // Close other FAQ items
    document.querySelectorAll('.faq-item').forEach(i => {
        if (i !== item) {
            i.classList.remove('open');
            const ans = i.querySelector('.faq-answer');
            if (ans) ans.style.maxHeight = null;
        }
    });

    const isOpen = item.classList.toggle('open');
    if (isOpen && answer) {
        answer.style.maxHeight = answer.scrollHeight + "px";
    } else if (answer) {
        answer.style.maxHeight = null;
    }
}

function simulateGoogleSignIn() {
    showNotif('info', 'Google Login', 'Google orqali tizimga kirish simulyatsiya qilinmoqda...');
    setTimeout(() => {
        const googleUser = {
            id: 9,
            login: 'google-user',
            name: 'Google Foydalanuvchi',
            role: 'customer',
            color: '#4285F4'
        };
        currentUser = googleUser;
        
        const topName = document.getElementById('topbarEmployeeName');
        if (topName) topName.textContent = googleUser.name;
        
        document.getElementById('sideUser').textContent = googleUser.name;
        document.getElementById('sideRole').textContent = ROLES[googleUser.role];
        const av = document.getElementById('sideAvatar');
        if (av) {
            av.textContent = googleUser.name[0];
            av.style.background = `linear-gradient(135deg,${googleUser.color},#10B981)`;
        }
        
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
        
        initApp();
        playSuccess();
        showNotif('success', 'Muvaffaqiyatli!', 'Google orqali tizimga kirildi');
    }, 800);
}

// ============================================================
// COMPLAINTS & SUGGESTIONS (REPORT SYSTEM)
// ============================================================
function openReportModal() {
    const reportForm = document.getElementById('reportForm');
    if (reportForm) reportForm.reset();
    
    // Auto-fill contact info if user is logged in
    const contactInput = document.getElementById('reportContact');
    if (contactInput && currentUser) {
        contactInput.value = `${currentUser.name} (${currentUser.role})`;
    }
    
    openModal('reportModal');
}

async function submitReport(event) {
    if (event) event.preventDefault();
    
    const type = document.getElementById('reportType')?.value || 'complaint';
    const message = document.getElementById('reportMessage')?.value || '';
    const contact = document.getElementById('reportContact')?.value || '';
    
    if (!message.trim()) {
        playError();
        showNotif('error', 'Xato!', 'Iltimos, xabarni kiriting');
        return;
    }
    
    const newReport = {
        type,
        message,
        contact,
        date: new Date().toLocaleDateString('uz-UZ'),
        time: new Date().toLocaleTimeString('uz-UZ'),
        user: currentUser ? currentUser.name || currentUser.login : 'Mehmon'
    };

    try {
        const response = await fetch('/api/reports', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(newReport)
        });
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.message || 'Murojaatni yuborib bo\'lmadi');
        }

        // Also save to local storage as cache
        const reports = safeJsonParse(localStorage.getItem('tp_reports') || '[]', []);
        newReport.id = reports.length + 1;
        reports.push(newReport);
        localStorage.setItem('tp_reports', JSON.stringify(reports));
        
        // Add to system log
        const typeLabels = { complaint: 'Shikoyat', bug: 'Xatolik', suggestion: 'Taklif' };
        addLog('Murojaat qabul qilindi', `${typeLabels[type]} — ${message.substring(0, 30)}...`);
        
        closeModal('reportModal');
        playSuccess();
        showNotif('success', 'Yuborildi!', 'Murojaatingiz muvaffaqiyatli yuborildi. Rahmat!');
    } catch (e) {
        console.error('Failed to submit report to database:', e);
        // Fallback to local storage if offline
        const reports = safeJsonParse(localStorage.getItem('tp_reports') || '[]', []);
        newReport.id = reports.length + 1;
        reports.push(newReport);
        localStorage.setItem('tp_reports', JSON.stringify(reports));
        
        // Add to system log
        const typeLabels = { complaint: 'Shikoyat', bug: 'Xatolik', suggestion: 'Taklif' };
        addLog('Murojaat saqlandi (offline)', `${typeLabels[type]} — ${message.substring(0, 30)}...`);

        closeModal('reportModal');
        playSuccess(); // still show success because we cached it locally
        showNotif('warning', 'Oflayn saqlandi!', 'Murojaat lokal keshda saqlandi (tarmoq xatosi).');
    }
}

