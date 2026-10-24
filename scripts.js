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
    // ── Brending: kompaniya logotipi (havola: bucket yoki /uploads/...) ──
    companyLogo: '',
    // ── Xodim KPI: har bir sotuv foydasidan foiz (bonus hisobi) ──
    kpiPercent: 0,
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

/**
 * `onclick="..."` ichida JS satr kontekstida xavfsiz joylashtiradi.
 *
 * MUHIM: bu yerda `escapeHTML()` YETARLI EMAS — brauzer atribut qiymatini
 * AVVAL HTML entity'lardan dekodlaydi, KEYIN JS sifatida bajaradi. Ya'ni
 * `&#39;` yana apostrofga aylanadi va JS satridan chiqib ketadi (XSS).
 * Auditda mahsulot nomi orqali ommaviy vitrinada XSS tasdiqlangan edi:
 *   nom = X');window.__XSS=1;//  →  tugma bosilganda payload bajarilgan.
 * Shu sababli: backslash va apostrof JS darajasida escape qilinadi, HTML
 * uchun esa & < > " almashtiriladi (escapeHTML orqali).
 */
function jsStrAttr(value) {
    if (value === null || value === undefined) return '';
    const BS = String.fromCharCode(92);   // backslash
    const Q = String.fromCharCode(39);    // apostrof
    return escapeHTML(String(value).split(BS).join(BS + BS).split(Q).join(BS + Q))
        .replace(/[\r\n]/g, ' ');
}

/** `onclick="Func('<qiymat>')"` uchun tayyor bo'lak (JS + HTML xavfsiz). */
function jsStrLiteral(value) {
    return "'" + jsStrAttr(value) + "'";
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

/** Faqat http(s) havolalar (tashqi rasm manzillari). Nisbiy havolalar ham
 *  qabul qilinadi (/media/... va /uploads/...) — ular o'z saytimizdan olinadi. */
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

/** Obyekt saqlash papkalari — bazadagi barcha rasm kalitlari shu papkalarda. */
const STORAGE_FOLDERS = ['products', 'logo', 'branches', 'contracts', 'receipts'];

/**
 * Eski (brauzerda 403 beradigan) object-storage havolasini `/media/<key>` ga
 * aylantiradi.
 *
 * MUAMMO: ilgari private bucket'ga TO'G'RIDAN-TO'G'RI havola saqlanardi
 * (masalan "https://t3.storageapi.dev/<bucket>/products/abc.jpg") — Railway
 * bucket'lari private bo'lgani uchun brauzer 403 olardi va rasm ko'rinmasdi.
 * Endi fayl `/media/<key>` orqali beriladi; bu funksiya bazada qolib ketgan
 * eski havolalarni ham avtomatik tuzatadi (ma'lumotni qayta saqlash shart emas).
 */
function storageKeyFromUrl(value) {
    const raw = String(value || '').trim();
    if (!/^https?:\/\//i.test(raw)) return '';
    let url;
    try {
        url = new URL(raw);
    } catch (e) {
        return '';
    }
    if (url.origin === window.location.origin) return '';
    const host = url.hostname.toLowerCase();
    // Faqat obyekt saqlash provayderlari (Railway/Tigris, S3, R2, MinIO, B2)
    const isStorage = /(storageapi|tigris|amazonaws|cloudflarestorage|backblazeb2|\.s3\.|^s3[.-]|minio)/.test(host);
    if (!isStorage) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => STORAGE_FOLDERS.includes(p.toLowerCase()));
    if (idx === -1) return '';
    const key = parts.slice(idx).join('/');
    return /^(products|logo|branches|contracts|receipts)\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key) ? key : '';
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
    // Eski private bucket havolasi → server orqali beriladigan /media/<key>
    const legacyKey = storageKeyFromUrl(value);
    if (legacyKey) return '/media/' + legacyKey;
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
        urls.find(url => {
            try {
                return new URL(url, window.location.href).hostname.includes('postimg');
            } catch (e) {
                return false;
            }
        }) ||
        urls[0] ||
        '';
}

function isDisplayableImageUrl(value) {
    if (isImageDataUrl(value)) return true;
    const url = safeImageUrl(value);
    if (!url) return false;
    try {
        // Nisbiy havola (/media/..., /uploads/...) ham qo'llanadi — bazani
        // joriy manzilga nisbatan yechamiz (aks holda URL() xato beradi).
        const parsed = new URL(url, window.location.href);
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
    // Rasm ilova qilish ro'li: yangi mahsulot oynasida boshliq/admin/menejer/
    // kassir; mavjud mahsulotda rasm o'zgartirish — boshliq/admin/menejer.
    if (!requireRole(...(editingProductId == null
        ? ['admin', 'manager', 'cashier'] : ['admin', 'manager']))) return;
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

    const field = document.getElementById('p-img');

    try {
        // 1) Bucketga (Railway/S3) yuklash — havola qaytsa shu havola ishlatiladi.
        //    Kassir bucket'ga yuborolmaydi (serverda /api/upload admin/menejer
        //    cheklovi bor) — uning uchun zaxira yo'lga (siqib bazaga saqlash)
        //    darhol o'tamiz: ortiqcha 403 so'rov va xavfsizlik yozuvi kerak emas.
        const canBucket = isBoss() || requireRoleSilent('admin', 'manager');
        const uploaded = canBucket
            ? await uploadToStorage(file, 'products')
            : { ok: false, message: 'Rasm mahsulot bilan birga bazaga siqib saqlanadi' };
        if (uploaded.ok && uploaded.url) {
            // Muhim: qaytgan havola AYNAN mahsulot rasmi maydoniga tushadi
            if (field) field.value = uploaded.url;
            updateProductImagePreview(uploaded.url);
            playSuccess();
            showNotif('success', 'Rasm yuklandi!',
                'Havola mahsulot rasmi maydoniga biriktirildi');
            return;
        }

        // 2) Zaxira yo'l: brauzerda siqish → bazaga (base64)
        console.warn('Bucketga yuklash amalga oshmadi, bazaga saqlanadi:', uploaded.message);
        const dataUrl = await compressImageFile(file);
        if (field) field.value = dataUrl;
        updateProductImagePreview(dataUrl);
        playSuccess();
        const kb = Math.round(dataUrl.length / 1024);
        showNotif('success', 'Rasm tayyor!',
            `Rasm siqildi (${kb} KB) va mahsulot bilan birga bazaga saqlanadi`);
    } catch (e) {
        console.error('Rasm yuklashda xatolik:', e);
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

// ============================================================
// OBYEKT SAQLASH (Railway Bucket / S3) — yuklash yordamchisi
// ============================================================
/**
 * Rasmni OBYEKT SAQLASHGA (Railway Bucket / S3) yuklaydi.
 *
 * Server `/api/upload` orqali faylni bucketga yuboradi va OCHIQ HAVOLANI
 * qaytaradi. Havola qaytgach u AYNAN kerakli joyga yoziladi:
 *   • mahsulot rasmi      → `p-img` maydoni
 *   • kompaniya logotipi  → `systemSettings.companyLogo`
 *   • filial logotipi     → filial yozuvi
 *
 * S3 sozlanmagan bo'lsa server lokal zaxira yo'lni ishlatadi (/uploads/...).
 * Ikkala holatda ham javob bir xil: { ok, url, storage }.
 */
async function uploadToStorage(file, folder = 'products') {
    try {
        const form = new FormData();
        form.append('file', file);
        form.append('folder', folder);
        // Diqqat: Content-Type QO'YILMAYDI — brauzer multipart boundary'ni
        // o'zi qo'shadi (aks holda server faylni o'qiy olmaydi).
        const res = await fetchWithTimeout('/api/upload', {
            method: 'POST',
            headers: authHeaders(),
            body: form
        }, 60000);
        const data = await res.json().catch(() => null);
        if (res.status === 401) {
            handleSessionExpired();
            return { ok: false, message: 'Sessiya tugadi — qayta kiring' };
        }
        if (!res.ok || !data || data.status !== 'success' || !data.url) {
            return { ok: false, message: (data && data.message) || `Yuklashda xatolik (HTTP ${res.status})` };
        }
        return { ok: true, url: data.url, storage: data.storage || 'local' };
    } catch (e) {
        return { ok: false, message: e?.message || 'Serverga ulanib bo\'lmadi' };
    }
}
// ============================================================
// BRENDING — kompaniya logotipi (login, sidebar, do'kon, chek)
// ============================================================
/**
 * Logotipni butun interfeysga qo'llaydi.
 *
 * Muammo: ilgari logo tanlanganda ham sayt boshidagi belgi (login, sidebar,
 * do'kon) bir xil qolardi — "logo o'rni almashmayapti". Endi
 * `systemSettings.companyLogo` to'ldirilganda AYNAN o'sha joylardagi belgi
 * rasmga almashtiriladi; logotip o'chirilsa standart ikonka qaytadi.
 */
function applyBranding() {
    const logo = safeImageUrl(systemSettings.companyLogo || '');
    const name = cleanText(systemSettings.companyName, 120) || 'Texno Park N1';

    // Kompaniya nomi ko'rinadigan joylar
    [['loginCompanyName', name], ['loginShowcaseName', name], ['sideCompanyName', name], ['marketCompanyName', name]]
        .forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        });

    // Logotip konteynerlari: rasm bo'lsa rasm, bo'lmasa standart ikonka
    const boxes = [
        { id: 'loginLogoBox', fallback: '<i class="fas fa-plug"></i>' },
        { id: 'loginShowcaseLogo', fallback: '<i class="fas fa-bolt"></i>' },
        { id: 'sideLogoBox', fallback: '<i class="fas fa-plug"></i>' },
        { id: 'marketLogoBox', fallback: '<i class="fas fa-bolt"></i>' },
    ];
    boxes.forEach(box => {
        const el = document.getElementById(box.id);
        if (!el) return;
        applyLogoToBox(el, logo, box.fallback);
    });

    // Footer brend belgisi — id'siz `.market-logo` (bir xil uslub).
    // Yuqoridagi ro'yxat faqat id bo'yicha ishlaydi, shuning uchun qolgan
    // belgilar sinf bo'yicha yangilanadi (aks holda ular standart bo'lib qolardi).
    document.querySelectorAll('.market-logo').forEach(el => {
        if (el.id) return;
        applyLogoToBox(el, logo, '<i class="fas fa-bolt"></i>');
    });

    // Sozlamalar sahifasidagi kichik ko'rinish (preview)
    const preview = document.getElementById('logoPreview');
    if (preview) {
        preview.innerHTML = logo
            ? `<img src="${escapeHTML(logo)}" alt="Logo" class="brand-logo-img">`
            : '<span style="font-size:11px;color:var(--text-muted)">Logo yo\'q</span>';
    }
    const removeBtn = document.getElementById('logoRemoveBtn');
    if (removeBtn) removeBtn.style.display = logo ? '' : 'none';
}

/**
 * Brend belgisi konteyneriga logotip rasmini (yoki zaxira ikonkani) joylaydi.
 *
 * MUHIM: `has-custom-logo` sinfi CSS'da standart fon-rasmni o'chiradi va
 * ichidagi `<img>` ni ko'rinadigan qiladi. Ilgari `.logo-sq > *`,
 * `.login-logo .logo-icon > *` kabi qoidalar `display:none !important` bilan
 * standart ikonkani yashirar edi — ular yuklangan logotip rasmini ham
 * yashirib qo'yardi, natijada logo hech qayerda almashmasdi.
 */
function applyLogoToBox(el, logo, fallback) {
    el.classList.toggle('has-custom-logo', !!logo);
    el.innerHTML = logo
        ? `<img src="${escapeHTML(logo)}" alt="Logo" class="brand-logo-img">`
        : fallback;
}

/** Brending sozlamasini keshga yozadi va serverga sinxronlaydi. */
function persistBranding(message) {
    try {
        localStorage.setItem('tp_settings', JSON.stringify(systemSettings));
    } catch (e) {
        // base64 logotip kesh kvotasiga sig'masa — faqat havola saqlanadi
        try {
            localStorage.setItem('tp_settings', JSON.stringify({
                ...systemSettings,
                companyLogo: safeImageLink(systemSettings.companyLogo)
            }));
        } catch (e2) { }
    }
    scheduleSyncWithBackend(600);
    addLog('Brending', 'Kompaniya logotipi yangilandi');
    playSuccess();
    if (message) showNotif('success', 'Logo', message);
}

/** Kompaniya logotipini bucketga yuklab, sozlamalarga yozadi. */
async function uploadCompanyLogo(input) {
    if (!requireRole('admin')) return;
    const file = input?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        playError();
        showNotif('error', 'Xato!', 'Faqat rasm fayl yuklang');
        input.value = '';
        return;
    }
    if (file.size > 8 * 1024 * 1024) {
        playError();
        showNotif('error', 'Xato!', 'Logotip hajmi 8MB dan oshmasin');
        input.value = '';
        return;
    }
    const status = document.getElementById('logoUploadStatus');
    if (status) status.textContent = 'Yuklanmoqda...';

    try {
        const uploaded = await uploadToStorage(file, 'logo');
        if (uploaded.ok && uploaded.url) {
            systemSettings.companyLogo = uploaded.url;
            persistBranding('Logo yuklandi va havolasi biriktirildi');
        } else {
            // Zaxira: kichik logotipni bazaga (base64) saqlash
            console.warn('Logo bucketga yuklanmadi, bazaga saqlanadi:', uploaded.message);
            const dataUrl = await compressImageFile(file, 512, 0.85);
            systemSettings.companyLogo = dataUrl;
            persistBranding('Logo bazaga saqlandi (bucket mavjud emas)');
        }
        if (status) status.textContent = '';
        applyBranding();
    } catch (e) {
        console.error('Logo yuklash xatosi:', e);
        if (status) status.textContent = '';
        playError();
        showNotif('error', 'Yuklanmadi!', e?.message || 'Logotipni yuklab bo\'lmadi');
    } finally {
        input.value = '';
    }
}

/** Logotipni o'chiradi (standart belgi qaytadi). */
function removeCompanyLogo() {
    if (!requireRole('admin')) return;
    if (!confirm('Logotipni olib tashlaysizmi?')) return;
    systemSettings.companyLogo = '';
    persistBranding('Logotip olib tashlandi');
    applyBranding();
}



function csvCell(value) {
    const text = String(value ?? '');
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
}

function requireRole(...roles) {
    // Rol iyerarxiyasi: BOSHLIQ eng yuqori rol — u boshqa rollarning
    // barcha imkoniyatlariga ega. Pastroq rollar o'z chegarasida qoladi.
    if (isBoss()) return true;
    if (!currentUser || !roles.includes(currentUser.role)) {
        playError();
        showNotif('error', 'Ruxsat yo\'q!', 'Bu amal uchun huquq yetarli emas');
        securityLog('access-denied', 'medium',
            `Ruxsat etilmagan amal: kerak [${roles.join(', ')}], mavjud [${currentUser?.role || 'mehmon'}]`);
        return false;
    }
    return true;
}

/* ── Shartnoma huquqlari ─────────────────────────────────────────
 * ASOSIY ADMIN — tizimning birinchi (egasi) administratori.
 * Shartnomani FAQAT asosiy admin yoki BOSHLIQ o'chira oladi
 * (BOSHLIQ iyerarxiyada asosiy admin'dan yuqori — tizim egasi).
 * Boshqa adminlar va menejer shartnoma tuza oladi / tahrirlay oladi,
 * lekin o'chira olmaydi (ular yaratgan shartnomani ham).
 * Asosiy admin loginlarini shu ro'yxatdan o'zgartirish mumkin. */
const MAIN_ADMIN_LOGINS = ['admin', 'admin@texnopark.uz'];
function isMainAdmin() {
    return Boolean(currentUser && currentUser.role === 'admin' &&
        MAIN_ADMIN_LOGINS.includes(String(currentUser.login || '').trim().toLowerCase()));
}
/** Shartnoma tuzish/tahrirlash: asosiy admin, admin, menejer va BOSHLIQ */
function canManageContracts() {
    return Boolean(currentUser && (currentUser.role === 'admin' ||
        currentUser.role === 'manager' || isBoss()));
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
        // ── Filial (ombor) biriktirilishi ──────────────────────────────
        // MUHIM: bu maydon saqlanib qolishi shart — aks holda serverdan
        // qaytgan mahsulot "filialsiz" bo'lib qoladi va har bir filial
        // ombori bo'sh ko'rinadi.
        branchId: cleanText(p?.branchId, 40),
        // ── Tannarx / ustama — serverdan qaytganda yo'qolmasin ─────────
        // (jadvaldagi "Tan narxi" va "Foyda" ustunlari shu maydonga tayanadi)
        cost: Math.max(0, Number(p?.cost) || 0),
        mtype: (p?.mtype === 'sum' ? 'sum' : 'pct'),
        markup: Math.max(0, Number(p?.markup) || 0),
        // ── Fiskal chek maydonlari (QR-kodli chek uchun) ───────────────
        ikpu: String(p?.ikpu ?? '').replace(/\D/g, '').slice(0, 17),
        packageCode: cleanText(p?.packageCode, 20),
        vatPercent: Number.isFinite(Number(p?.vatPercent)) ? Number(p.vatPercent) : 12,
        // ── Tan narx / foyda ko'rsatkichlari ────────────────────────────
        // MUHIM: bu maydonlar ham saqlanishi shart. Ilgari ular yo'q edi —
        // sahifa yangilangandan keyin tan narxi nolga tushib, "Foyda" va
        // yangi savdolarning foydasi noto'g'ri (sotuv narxiga teng)
        // hisoblanardi. `saleProfit()` xarajatni aynan shu maydondan oladi.
        cost: Math.max(0, Number(p?.cost) || 0),
        mtype: p?.mtype === 'sum' ? 'sum' : 'pct',
        markup: Math.max(0, Number(p?.markup) || 0),
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
        addr: cleanText(c?.addr, 180),
        bdate: cleanText(c?.bdate, 10),
        orders: Math.max(0, Number(c?.orders) || 0),
        total: Math.max(0, Number(c?.total) || 0),
        bonus: Math.max(0, Number(c?.bonus) || 0),
        status: ['active', 'vip', 'inactive'].includes(c?.status) ? c.status : 'active',
        createdAt: cleanText(c?.createdAt, 40),
    };
}

function isPaidSale(s) {
    return String(s?.status || 'paid') === 'paid';
}

function nextSaleId() {
    const maxId = (salesHistory || []).reduce((max, sale) => {
        const id = Number(sale?.id) || 0;
        return id > max ? id : max;
    }, 0);
    return Math.max(maxId + 1, Date.now());
}

function normalizeSale(s) {
    if (!s || typeof s !== 'object') return null;
    const items = Array.isArray(s.items) ? s.items.map(it => ({
        id: Number(it?.id) || it?.id || '',
        name: cleanText(it?.name, 120),
        price: Math.max(0, Number(it?.price) || 0),
        cost: Math.max(0, Number(it?.cost) || 0),
        qty: Math.max(0, Number(it?.qty) || 0),
        img: safeImageUrl(it?.img),
        barcode: cleanText(it?.barcode, 64),
        branchId: cleanText(it?.branchId, 40),
        ikpu: String(it?.ikpu ?? '').replace(/\D/g, '').slice(0, 17),
        packageCode: cleanText(it?.packageCode, 20),
        vatPercent: Number.isFinite(Number(it?.vatPercent)) ? Number(it.vatPercent) : 12,
    })).filter(it => it.name && it.qty > 0) : [];
    const subtotal = Number.isFinite(Number(s.subtotal))
        ? Number(s.subtotal)
        : items.reduce((sum, it) => sum + it.price * it.qty, 0);
    const disc = Math.min(100, Math.max(0, Number(s.disc) || 0));
    const discAmt = Number.isFinite(Number(s.discAmt)) ? Number(s.discAmt) : subtotal * disc / 100;
    const total = Number.isFinite(Number(s.total)) ? Number(s.total) : Math.max(0, subtotal - discAmt);
    const sale = {
        ...s,
        id: Number(s.id) || nextSaleId(),
        items,
        subtotal,
        disc,
        discAmt,
        total,
        pay: cleanText(s.pay, 60) || 'Naqd',
        provider: cleanText(s.provider, 40) || '',
        time: cleanText(s.time, 20),
        date: cleanText(s.date, 20),
        cashier: cleanText(s.cashier, 120) || 'Noma\'lum',
        cashierLogin: cleanText(s.cashierLogin, 80),
        customer: cleanText(s.customer, 160) || 'Noma\'lum',
        customerId: s.customerId == null ? null : Number(s.customerId),
        customerPhone: cleanText(s.customerPhone, 40),
        branchId: cleanText(s.branchId, 40),
        status: ['pending', 'paid', 'cancelled', 'expired'].includes(String(s.status)) ? String(s.status) : 'paid',
    };
    sale.profit = saleProfit(sale);
    sale.kpi = saleKpi(sale);
    return sale;
}

// ============================================================
// USERS
// ============================================================
const USERS = [
    { id: 1, login: 'admin', phone: '+998908480921', salt: 'tp-adm-9x2', passHash: '1a25159d411b5128ef8c163d5219159ae2e68a475028803916d231217d44b32a', name: 'Abdullayev Admin', role: 'admin', color: '#ff6b35' },
    { id: 2, login: 'cashier', phone: '+998905450921', salt: 'tp-csh-4k7', passHash: 'c9ca5cfba8a78e3ecaf6e2f649954af302cbbc8bfd0cda66b5f952e24a571c67', name: 'Karimov Kassir', role: 'cashier', color: '#10B981' },
    { id: 3, login: 'manager', phone: '+998902750921', salt: 'tp-mng-3z8', passHash: '1cd5bbc9db80f2c06d67eb639dc43dceb7e8c2d2862331cc05a7ded2a3b700f0', name: 'Toshmatov Menejer', role: 'manager', color: '#F59E0B' },
    { id: 7, login: 'customer', phone: '', salt: 'tp-usr-6q1', passHash: 'c6829c1abecee2d0139933b5dfb14c9f2324290f583ed9aec94934a3558dc66b', name: 'Online Xaridor', role: 'customer', color: '#2563EB' },
    { id: 4, login: 'admin@texnopark.uz', phone: '', salt: 'tp-adm-9x2', passHash: '1a25159d411b5128ef8c163d5219159ae2e68a475028803916d231217d44b32a', name: 'Abdullayev Admin', role: 'admin', color: '#ff6b35' },
    { id: 5, login: 'cashier@texnopark.uz', phone: '', salt: 'tp-csh-4k7', passHash: 'c9ca5cfba8a78e3ecaf6e2f649954af302cbbc8bfd0cda66b5f952e24a571c67', name: 'Karimov Kassir', role: 'cashier', color: '#10B981' },
    { id: 6, login: 'manager@texnopark.uz', phone: '', salt: 'tp-mng-3z8', passHash: '1cd5bbc9db80f2c06d67eb639dc43dceb7e8c2d2862331cc05a7ded2a3b700f0', name: 'Toshmatov Menejer', role: 'manager', color: '#F59E0B' },
    { id: 8, login: 'customer@texnopark.uz', phone: '', salt: 'tp-usr-6q1', passHash: 'c6829c1abecee2d0139933b5dfb14c9f2324290f583ed9aec94934a3558dc66b', name: 'Online Xaridor', role: 'customer', color: '#2563EB' },
    { id: 9, login: 'boss', phone: '+998901234554', salt: 'tp-9048e163a57a', passHash: 'f92f92a1cd47c8d2d33944393be6c58db21eba9b9503a8007a60e0c915891c25', name: 'Boshliq', role: 'boss', color: '#8B5CF6' },
];
// Rol iyerarxiyasi: BOSHLIQ > ADMIN > MANAGER > CASHIER.
// Raqam qanchalik katta bo'lsa, rol shunchalik kuchli.
const ROLE_RANK = { boss: 40, admin: 30, manager: 20, cashier: 10, customer: 0 };
const ROLES = { boss: 'Boshliq', admin: 'Administrator', cashier: 'Kassa Xodimi', manager: 'Menejer', customer: 'Xaridor' };

// Eski/alternativ rol nomlari (eski baza yoki bosh harfli qiymat) yagona
// joyda kanonik kalitga keltiriladi. Server ham xuddi shunday normalizatsiya
// qiladi — shunda RBAC, sidebar va /api/data bir xil rol bilan ishlaydi.
const ROLE_ALIASES = {
    rahbariyat: 'boss', boshliq: 'boss', boshlq: 'boss',
    administrator: 'admin', menejer: 'manager', kassa: 'cashier'
};

function normalizeRole(role) {
    const key = String(role || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ROLE_ALIASES, key)) return ROLE_ALIASES[key];
    return Object.prototype.hasOwnProperty.call(ROLE_RANK, key) ? key : 'customer';
}

// ============================================================
// LOGIN TELEFON MAYDONI — maska + +998 prefiksi (websayt)
// ============================================================
function phoneDigitsUz(value) {
    let digits = String(value || '').replace(/\D/g, '');
    // "+998908480921" / "+998 90 123 45 54" / "998901234554" kabi prefiksli
    // to'liq raqam ham 9 xonali lokal qismga keltiriladi. MUHIM: prefiksni
    // KESISHDAN OLDIN olib tashlaymiz — aks holda sekin terilganda
    // 10-belgidan keyin kesish "998901234554" -> "998901234" (-998998901234)
    // noto'g'ri raqamga olib kelardi (paste ishlar, terish ishlamas edi).
    while (digits.startsWith('998') && digits.length > 9) {
        digits = digits.slice(3);
    }
    if (digits.length > 9) digits = digits.slice(0, 9);
    return digits;
}

/** Ko'rinish uchun maska: "908480921" → "90 848 09 21". */
function formatPhoneMaskUz(value) {
    const d = phoneDigitsUz(value);
    const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
    return parts.join(' ');
}

/** Yagona normalizatsiya: yaroqli bo'lsa +998XXXXXXXXX, aks holda ''. */
function normalizePhoneUz(value) {
    const d = phoneDigitsUz(value);
    if (d.length !== 9 || d[0] === '0') return '';
    return '+998' + d;
}

/** Login maydonida telefon emas, LOGIN NOMI kiritilganini aniqlaydi.
 *  Masalan: admin, boss2, manager@texnopark.uz. Bunday qiymatga telefon
 *  maskasi qo'llanmaydi — aks holda harflar darhol o'chib ketardi va
 *  admin login bilan kirish umuman imkonsiz edi. */
function isLoginNameValue(value) {
    return /[A-Za-z@._-]/.test(String(value || ''));
}

/** Login maydonini telefon maskasiga keltiradi va +998 prefiksini boshqaradi. */
function formatLoginField(inp) {
    if (!inp) return;
    const nameMode = isLoginNameValue(inp.value);
    const wrap = inp.closest('.phone-field');
    if (wrap) wrap.classList.toggle('login-mode', nameMode);
    if (nameMode) return;            // login nomi — maskani tegmymiz
    const masked = formatPhoneMaskUz(inp.value);
    if (inp.value !== masked) {
        inp.value = masked;
        // Kursor doim matn oxirida qoladi
        try { inp.setSelectionRange(masked.length, masked.length); } catch (e) { }
    }
}

/** Login telefon maydoniga maskani bog'laydi (bir marta). */
function initLoginPhoneMask() {
    const inp = document.getElementById('loginPhone');
    if (!inp || inp.dataset.maskBound === '1') return;
    inp.dataset.maskBound = '1';
    inp.addEventListener('input', () => formatLoginField(inp));
}

/** Login telefon maydonidagi qiymatni bir xil maskaga keltiradi. */
function formatLoginPhoneField() {
    formatLoginField(document.getElementById('loginPhone'));
}

/** Brauzer autofill uchun telefon qiymatini ham bir xil maskaga keltiradi. */
function initLoginPhoneAutofillGuard() {
    const inp = document.getElementById('loginPhone');
    if (!inp || inp.dataset.autofillBound === '1') return;
    inp.dataset.autofillBound = '1';
    inp.addEventListener('change', formatLoginPhoneField);
    inp.addEventListener('blur', formatLoginPhoneField);
    window.addEventListener('pageshow', formatLoginPhoneField);
    formatLoginPhoneField();
}

// ============================================================
// LOGIN PAROL MAYDONI — DOIM YASHIRIN (standart holat)
// ============================================================
// Parol faqat foydalanuvchi ko'z tugmasini bosganda ko'rinadi. Brauzer
// autofill'i, kengaytmalar yoki boshqa kod maydonni "text" holatiga
// o'tkazsa — darhol "password" holatiga qaytaramiz (ochiq matn ko'rinmaydi).
let loginPasswordVisible = false;

/** Parolni ko'rsatish/yashirish holatini yagona joydan boshqaradi. */
function setLoginPasswordVisible(visible) {
    const inp = document.getElementById('loginPass');
    const ico = document.querySelector('#loginPage .pass-toggle i');
    const btn = document.querySelector('#loginPage .pass-toggle');
    const want = !!visible;
    loginPasswordVisible = want;
    if (inp) {
        // type almashganda kursor/selection ba'zi brauzerlarda oxiriga
        // "sakraydi" — pozitsiyani saqlaymiz.
        let sStart = null, sEnd = null;
        try { sStart = inp.selectionStart; sEnd = inp.selectionEnd; } catch (e) { }
        inp.type = want ? 'text' : 'password';
        try { if (sStart !== null) inp.setSelectionRange(sStart, sEnd); } catch (e) { }
        // Fokus PAROL MAYDONIDA qolishi shart: tugmaga o'tsa mobil
        // klaviatura yopiladi → viewport (100dvh) o'zgaradi → butun karta
        // qayta joylanadi. preventScroll — brauzer "scroll into view"
        // qilmasin, sahifa sirg'almasin. (Avval fokusda bo'lmagan bo'lsa
        // klaviaturasiz kiritishga xalaqit bermaymiz.)
        if (inp.dataset.focusSeen === '1' && document.activeElement !== inp) {
            try { inp.focus({ preventScroll: true }); } catch (e) { try { inp.focus(); } catch (e2) { } }
        }
    }
    if (ico) ico.className = want ? 'fas fa-eye-slash' : 'fas fa-eye';
    if (btn) {
        btn.setAttribute('aria-label', want ? 'Parolni yashirish' : "Parolni ko'rsatish");
        // A11y: tugma bosilgan/bo'sh holati (role=button uchun majburiy)
        btn.setAttribute('aria-pressed', want ? 'true' : 'false');
    }
}

/** Parolni yashirin holatga qaytaradi (foydalanuvchi ko'rsatmagan bo'lsa). */
function enforceLoginPasswordHidden() {
    if (loginPasswordVisible) return;
    setLoginPasswordVisible(false);
}

/** Sahifa ochilganda va qayta tiklanishida parolni doim yashirin qiladi. */
function initLoginPasswordGuard() {
    const inp = document.getElementById('loginPass');
    if (!inp || inp.dataset.guardBound === '1') return;
    inp.dataset.guardBound = '1';
    loginPasswordVisible = false;
    enforceLoginPasswordHidden();
    // Parol maydoni birinchi marta fokuslangani — ko'zcha bosilganda
    // fokusni shu yerga qaytarish uchun kerak (klaviatura yopilmasligi uchun).
    inp.addEventListener('focus', function () { inp.dataset.focusSeen = '1'; });
    // Ko'zcha bosilganda fokus inputdan yiqilmasin: mousedown default'ini
    // bekor qilamiz (click baribir ishlaydi) — shunda fokus, kursor,
    // klaviatura va sahifa joylanishi BUTUNLAY o'zgarmaydi.
    const eyeBtn = document.querySelector('#loginPage .pass-toggle');
    if (eyeBtn && eyeBtn.dataset.focusGuard !== '1') {
        eyeBtn.dataset.focusGuard = '1';
        eyeBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    }
    if (typeof MutationObserver !== 'undefined') {
        // Ruxsatsiz `type` o'zgarishi (autofill/kengaytma/boshqa kod)
        // darhol bekor qilinadi.
        new MutationObserver(() => {
            if (!loginPasswordVisible && inp.type !== 'password') enforceLoginPasswordHidden();
        }).observe(inp, { attributes: true, attributeFilter: ['type'] });
    }
    ['focus', 'input', 'change'].forEach(evt => inp.addEventListener(evt, enforceLoginPasswordHidden));
    window.addEventListener('pageshow', enforceLoginPasswordHidden);
    document.addEventListener('visibilitychange', enforceLoginPasswordHidden);
}

function showLoginFieldError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('show', !!message);
}

function clearLoginFieldErrors() {
    ['loginPhoneError', 'loginPassError'].forEach(id => showLoginFieldError(id, ''));
}

/** Kirish tugmasining yuklanish holati (duplicate bosishning oldini oladi). */
function setLoginLoading(on) {
    const btn = document.getElementById('loginBtn');
    if (!btn) return;
    btn.classList.toggle('is-loading', !!on);
    btn.disabled = !!on;
    const ico = btn.querySelector('i');
    const label = btn.querySelector('.btn-login-label');
    if (ico) ico.className = on ? 'fas fa-spinner fa-spin' : 'fas fa-sign-in-alt';
    if (label) label.textContent = on ? 'Kirish...' : 'Kirish';
}

// Login sahifasi ochilishida maska tayyor (skript body oxirida yuklanadi).
// Parol maydoni esa har doim YASHIRIN holatdan boshlanadi (default hidden),
// autofill natijasidagi telefon qiymati ham bir xil ko'rinishga keltiriladi.
initLoginPhoneMask();
initLoginPhoneAutofillGuard();
initLoginPasswordGuard();

/** Joriy roling darajasi (0 — ichki/guest rolda). */
function currentRoleRank() {
    return ROLE_RANK[normalizeRole(currentUser?.role)] || 0;
}

/** Boshliq — eng yuqori rol: admin/manager/cashier imkoniyatlariga ham ega. */
function isBoss() {
    return currentRoleRank() >= ROLE_RANK.boss;
}

/**
 * Ko'rsatish tekshiruvi (iyerarxiyaga asoslangan).
 * Masalan: requireRank('admin') → boss va admin o'tadi, manager/cashier yo'q.
 * Frontend'dagi bu YAGINA qulaylik — haqiqiy himoya serverdadir (@require_staff).
 */
function requireRank(minRole) {
    return currentRoleRank() >= (ROLE_RANK[String(minRole).toLowerCase()] || Infinity);
}

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

function categoryEmoji(name) {
    const custom = (systemSettings.categoryEmojis || {})[name];
    if (custom) return custom;
    return CATEGORY_EMOJI[name] || '📦'; }
function categoryFaIcon(name) { return CATEGORY_FA_ICON[name] || 'fa-box'; }

// ============================================================
// REAL MA'LUMOT REJIMI
// ============================================================
// Tizim namuna (demo) ma'lumotsiz ishlaydi: barcha ko'rsatkichlar 0 dan
// boshlanadi va faqat haqiqiy kiritilgan ma'lumot asosida o'sadi.
// Eski demo keshni bir marta tozalab tashlaymiz.
const DATA_VERSION = 'real-3';
if (localStorage.getItem('tp_data_version') !== DATA_VERSION) {
    ['tp_products', 'tp_customers', 'tp_sales', 'tp_logs', 'tp_salary_records',
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
    const byLogin = USERS.find(u => u.login.toLowerCase() === key);
    if (byLogin) return byLogin;
    // Telefon raqami bilan ham topamiz (oflayn rejimda telefon orqali kirish)
    const phone = normalizePhoneUz(loginKey);
    if (phone) {
        return USERS.find(u => u.phone && normalizePhoneUz(u.phone) === phone) || null;
    }
    return null;
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

    // Hisob holati: admin bloklagan (status != active) hisob OFLAYN rejimda
    // ham kirmaydi — auth oqimi: 1) user 2) status 3) lock 4) parol 5) muvaffaqiyat.
    const accStatus = String(base.status || 'active').trim().toLowerCase();
    if (accStatus && accStatus !== 'active') {
        return { ok: false, reason: 'account-blocked', user: base };
    }

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
/* Foyda: (sotuv-tan narx)*dona - chegirma ulushi. Zarar bo'lsa minus, KPI=0. */
function saleProfit(s) {
    if (!s || !Array.isArray(s.items)) return 0;
    if (!s.items.length && s.profit !== undefined && s.profit !== null && s.profit !== '') return Number(s.profit) || 0;
    const sub = s.items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
    let p = 0;
    s.items.forEach(i => {
        const line = (Number(i.price) || 0) * (Number(i.qty) || 0);
        const share = sub > 0 ? line / sub : 0;
        p += ((Number(i.price) || 0) - (Number(i.cost) || 0)) * (Number(i.qty) || 0) - (Number(s.discAmt) || 0) * share;
    });
    return Math.round(p);
}
/* Har bir sotuv (har bir qator) uchun alohida KPI: musbat foydadan %. */
function saleKpi(s) {
    if (!isPaidSale(s)) return 0;
    const p = saleProfit(s);
    if (p <= 0) return 0;
    return Math.round(p * (Number(systemSettings.kpiPercent) || 0) / 100);
}
function employeeStats(emp) {
    const mine = salesHistory.filter(s => isPaidSale(s) && s.cashier === emp.name);
    const total = mine.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
    // Foyda va KPI ham shu xodimning haqiqiy savdolaridan hisoblanadi.
    const profit = mine.reduce((sum, s) => sum + saleProfit(s), 0);
    const kpi = mine.reduce((sum, s) => sum + saleKpi(s), 0);
    return { sales: mine.length, total, profit, kpi };
}

let salesHistory = safeJsonParse(localStorage.getItem('tp_sales') || '[]', []);
let logs = safeJsonParse(localStorage.getItem('tp_logs') || '[]', []);
salesHistory = Array.isArray(salesHistory) ? salesHistory.map(normalizeSale).filter(Boolean) : [];
logs = Array.isArray(logs) ? logs : [];

// ============================================================
// KIRIM / CHIQIM / HARAJAT — filial bo'yicha moliyaviy nazorat
// ============================================================
// Admin asosan shu ko'rsatkichlarni kuzatadi: har bir filialga qancha
// pul kirdi (kirim), qancha chiqdi (chiqim) va qancha harajat qilindi.
// Yozuvlar server bazasida `cashFlow` kaliti ostida saqlanadi.
const CASHFLOW_TYPES = {
    kirim: { label: 'Kirim', icon: 'fa-arrow-down-long' },
    chiqim: { label: 'Chiqim', icon: 'fa-arrow-up-long' },
    harajat: { label: 'Xarajat', icon: 'fa-receipt' },
};
const CASHFLOW_CATEGORIES = ['Savdo tushumi', "Ta'minotchi to'lovi", 'Ijara',
    'Oylik maosh', 'Kommunal', 'Soliq', 'Transport', 'Reklama',
    "Ta'mirlash", 'Kanselyariya', 'Boshqa'];

/** Kirim/chiqim yozuvini xavfsiz shaklga keltiradi. */
function normalizeCashFlow(c) {
    if (!c || typeof c !== 'object') return null;
    const amount = Number(c.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const type = Object.prototype.hasOwnProperty.call(CASHFLOW_TYPES, String(c.type))
        ? String(c.type) : 'chiqim';
    return {
        id: String(c.id || ('cf-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8))).slice(0, 60),
        type,
        amount: Math.round(amount * 100) / 100,
        category: cleanText(c.category, 60) || 'Boshqa',
        note: cleanText(c.note, 240),
        branchId: cleanText(c.branchId, 40),
        date: cleanText(c.date, 10) || new Date().toISOString().slice(0, 10),
        createdAt: cleanText(c.createdAt, 30) || new Date().toLocaleString('uz-UZ'),
        user: cleanText(c.user, 120),
    };
}

let cashFlow = safeJsonParse(localStorage.getItem('tp_cash_flow') || '[]', []);
cashFlow = Array.isArray(cashFlow) ? cashFlow.map(normalizeCashFlow).filter(Boolean) : [];

/** Faqat faol filialga (yoki barcha filiallarga) tegishli yozuvlar. */
function cashFlowOfBranch(branchId) {
    if (!branchId) return cashFlow;
    return cashFlow.filter(c => String(c.branchId || '') === String(branchId));
}

/** Yozuvlar summasi (tur bo'yicha). */
function cashFlowTotals(records) {
    const list = records || cashFlow;
    const totals = { kirim: 0, chiqim: 0, harajat: 0 };
    list.forEach(c => {
        if (totals[c.type] === undefined) totals[c.type] = 0;
        totals[c.type] += Number(c.amount) || 0;
    });
    totals.net = totals.kirim - totals.chiqim - totals.harajat;
    return totals;
}

// ============================================================
// SMS TEMPLATES (COMPLETED)
// ============================================================
const smsTemplates = [
    { title: 'Chegirma haqida', text: 'Hurmatli {ism}! Texno Park N1da 20% chegirma kampaniyasi boshlandi. Muzlatgich, TV va konditsionerlarda katta chegirmalar. Tez keling!' },
    { title: 'Chek tasdiqlash', text: 'Hurmatli {ism}! Siz {summa} so\'mlik xarid qildingiz. Chek raqamingiz: {chek}. Xarid uchun rahmat! Texno Park N1.' },
    { title: 'Tug\'ilgan kun', text: 'Hurmatli {ism}! Tug\'ilgan kuningiz bilan qutlaymiz! 🎉 Sovg\'a sifatida keyingi xaridingizda 10% chegirma beramiz.' },
    { title: 'Yangi mahsulot', text: 'Hurmatli {ism}! Texno Park N1da yangi {mahsulot} keldi. Narxi: {narx} so\'m. Soni cheklangan, bugun keling!' },
    { title: 'Qarz eslatma', text: 'Hurmatli {ism}! Qoldiq to\'lovingiz {summa} so\'m. Iltimos, {sana} gacha to\'lashingizni so\'raymiz. Texno Park N1.' },
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

function saveToStorage(syncBackend = true) {
    try {
        localStorage.setItem('tp_products', JSON.stringify(products.map(productForCache)));
        localStorage.setItem('tp_customers', JSON.stringify(customers));
        localStorage.setItem('tp_sales', JSON.stringify(salesHistory));
        localStorage.setItem('tp_logs', JSON.stringify(logs));
        try { localStorage.setItem('tp_branches', JSON.stringify(branches)); } catch (e) { }
        try { localStorage.setItem('tp_cash_flow', JSON.stringify(cashFlow)); } catch (e) { }
        try { localStorage.setItem('tp_contracts', JSON.stringify(contracts)); } catch (e) { }
        if (syncBackend) syncWithBackend(); // Sync with the existing backend store
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

/** Token eskirgan/bloklangan bo'lsa — xavfsiz tarzda sessiyani yopadi.
 *  Server 401 qaytarganda (token muddati tugagan / sessiya bekor qilingan)
 *  faqat token o'chirish YETARLI EMAS: foydalanuvchi "kirilgan" holatda
 *  qoladi — Boshliq Dashboard bo'sh turadi va har bir `/api/boss/*` so'rovi
 *  «Sessiya yo'q / Qayta kiring» xatini takrorlaydi. Shuning uchun
 *  frontend sessiyasi ham yakunlanib, login ekranga qaytiladi. */
function handleSessionExpired() {
    // Token bo'lmasa ham `currentUser` "kirgan" holatda qolgan bo'lishi mumkin
    // (lokal sessiya server tokenisiz tiklangan). Bunday holatda ham login
    // ekraniga qaytaramiz — aks holda barcha amallar "Avtorizatsiya talab
    // qilinadi" xatosi bilan tugaydi va foydalanuvchi sababini bilmaydi.
    if (!staffToken && !currentUser) return;
    clearStaffToken();
    if (currentUser && currentUser.role !== 'customer') {
        showNotif('warning', 'Sessiya tugadi', 'Xavfsizlik uchun tizimga qaytadan kiring');
        const name = currentUser.name || currentUser.login || '';
        Security.endSession('server-session-expired');
        currentUser = null;
        cart = [];
        shopCart = [];
        showLoginScreen();
        setupRoleBasedNav();
        securityLog('session-expired', 'medium',
            `Server sessiyasi tugadi — qayta kirish talab qilinadi (${name})`);
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
        securityLog: readLocalJSON('tp_security_log', []),
        branches: branches,
        // Kirim / chiqim / harajat yozuvlari (filial bo'yicha)
        cashFlow: cashFlow
    };
}

// Sync with backend API — faqat xodim tokeni bo'lsa yoziladi
/**
 * Bazaga yozish. Muvaffaqiyatli bo'lsa `true`, aks holda `false` qaytaradi.
 * 401 — sessiya tugagan; 403 — huquq yo'q (qayta urinish foydasiz).
 */
async function _pushSync(strict = false) {
    _lastSyncError = '';
    // Katalog-fallback holatidagi payload bazani buzib yuborishi mumkin
    // (branchId/tannarx/savdo tarixi kam) — `/api/data` dan to'liq holat
    // kelgunga qadar yozish to'xtatiladi. Bu yozuv keyingi sinxronizatsiyada
    // to'liq holat bilan bajariladi.
    if (catalogFallbackActive) return true;
    try {
        const res = await fetchWithTimeout('/api/sync', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(buildSyncPayload())
        }, SYNC_TIMEOUT_MS);
        if (res.status === 401) {
            const data = await res.json().catch(() => null);
            _lastSyncError = data?.message || 'Sessiya tugadi — qaytadan tizimga kiring';
            _pendingImageKeys = [];
            handleSessionExpired();
            return !strict;
        }
        if (res.status === 403) {
            const data = await res.json().catch(() => null);
            _lastSyncError = data?.message || 'Bazaga yozish uchun huquq yetarli emas';
            console.warn('Bazaga yozish rad etildi (403)');
            return !strict;
        }
        if (!res.ok) {
            const data = await res.json().catch(() => null);
            _lastSyncError = data?.message || ('Bazaga yozishda xatolik (HTTP ' + res.status + ')');
            console.warn(_lastSyncError);
            return false;
        }
        const data = await res.json().catch(() => null);
        if (!data || data.status !== 'success') {
            _lastSyncError = data?.message || 'Server saqlash natijasini tasdiqlamadi';
            return false;
        }
        _pendingImageKeys.forEach(k => _syncedImageKeys.add(k));
        _pendingImageKeys = [];
        serverOnline = true;
        return true;
    } catch (e) {
        console.warn('Backend sync failed (offline or no backend):', e);
        serverOnline = false;
        _lastSyncError = e?.message || 'Serverga ulanib bo\'lmadi';
        return false;
    }
}

// Yozilmagan ma'lumot qolib ketmasligi uchun qayta urinish (1.5s → 60s)
var _syncRetryTimer = null;
var _syncRetryDelay = 1500;
var _syncDirty = false;
var _lastSyncError = '';

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

async function syncWithBackend(strict = false) {
    if (!staffToken) {
        if (strict) _lastSyncError = 'Mahsulotni saqlash uchun xodim sessiyasi talab qilinadi';
        return false;
    }
    if (strict) {
        if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
        if (_syncRetryTimer) { clearTimeout(_syncRetryTimer); _syncRetryTimer = null; }
    }
    _syncDirty = true;
    const ok = await _pushSync(strict);
    if (ok) {
        _syncDirty = false;
        _syncRetryDelay = 1500;
        if (_syncRetryTimer) { clearTimeout(_syncRetryTimer); _syncRetryTimer = null; }
    } else if (_syncDirty && strict) {
        _syncDirty = false;
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

// Ommaviy katalog faqat public maydonlarni qaytaradi: `branchId`, `cost`,
// `barcode` u yerda BO'LMAYDI va savdo tarixi umuman YUBORILMAYDI. Sessiya
// eskirgandan keyin shu holatga tushsak, sinxronizatsiya vaqtincha
// to'xtatiladi — aks holda keyingi yozuv butun bazani (mahsulot filtri,
// tannarx, savdo tarixi) bu kam ma'lumotli holatga ko'proq yozadi.
// Faqat `/api/data` muvaffaqiyatli yuklanganda belgi o'chadi.
let catalogFallbackActive = false;

async function loadFromBackend() {
    if (!products.length) {
        productLoadState = 'loading';
        renderProducts();
    }
    try {
        // Fetch config from .env via Python API
        try {
            const configResponse = await fetch('/api/config');
            const config = await configResponse.json();
            if (config) {
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
        if (response.status === 401) {
            console.warn('Xodim tokeni eskirgan — sessiya yopiladi');
            handleSessionExpired();
            await loadPublicCatalog();
            return;
        }
        if (response.status === 403) {
            console.warn('Xodim tokeni yo\'q yoki huquq yetarli emas — faqat ommaviy katalog yuklanadi');
            clearStaffToken();
            await loadPublicCatalog();
            return;
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.message || `Ma'lumotlarni yuklashda xatolik (HTTP ${response.status})`);
        }
        const data = await response.json();
        serverOnline = true;
        productLoadState = 'ready';
        // To'liq bazaviy holat keldi — sinxronizatsiya qayta ochiladi
        catalogFallbackActive = false;
        // Bazadagi rasmlar haqiqiy holat — takror yuborish hisobini tozalaymiz
        _syncedImageKeys.clear();
        _pendingImageKeys = [];
        if (data && Object.keys(data).length > 0) {
            if (data.products) products = data.products.map(normalizeProduct);
            if (data.customers) customers = data.customers.map(normalizeCustomer);
            if (data.sales) salesHistory = Array.isArray(data.sales) ? data.sales.map(normalizeSale).filter(Boolean) : [];
            if (data.logs) logs = data.logs;
            if (Array.isArray(data.contracts)) {
                contracts = data.contracts.map(normalizeContract).filter(c => c && c.customer);
            }
            if (data.settings) systemSettings = { ...systemSettings, ...data.settings };
            // Brending (logotip/nom) serverdan kelgan sozlamalar bilan yangilanadi
            try { applyBranding(); } catch (e) { }

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
            if (Array.isArray(data.securityLog)) {
                securityEvents = data.securityLog;
                try { localStorage.setItem('tp_security_log', JSON.stringify(securityEvents)); } catch (e) { }
            }
            if (Array.isArray(data.branches)) {
                branches = data.branches.map(normalizeBranch).filter(Boolean);
                try { localStorage.setItem('tp_branches', JSON.stringify(branches)); } catch (e) { }
            }
            if (Array.isArray(data.cashFlow) || Array.isArray(data.expenses)) {
                cashFlow = (data.cashFlow || data.expenses)
                    .map(normalizeCashFlow).filter(Boolean);
                try { localStorage.setItem('tp_cash_flow', JSON.stringify(cashFlow)); } catch (e) { }
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
            productLoadState = 'ready';
            renderProducts();
            await syncWithBackend();
        }
    } catch (e) {
        productLoadState = products.length ? 'ready' : 'error';
        renderProducts();
        console.warn('Failed to load from backend. Using local storage:', e);
    }
    // Mahsulotlar shu chaqiruv ichida yuklanib bo'ladi. Sahifani yangilashdan
    // keyin savat ancq shu vaqtda tiklanadi (ichidagi `posCartStateRestored`
    // bayrog'i tufayli bir martadan ortiq ishlamaydi).
    posRestoreCartState();
}

/**
 * Ommaviy katalog — xaridor/mehmon uchun.
 * Server bu yerda faqat mahsulot va kategoriyalarni qaytaradi:
 * mijoz shaxsiy ma'lumotlari, savdo tarixi va jurnal YUBORILMAYDI.
 */
async function loadPublicCatalog() {
    // Katalogda filial/tannarx/savdo yo'q — bazaga yozish uchun xavfsiz emas
    catalogFallbackActive = true;
    try {
        const res = await fetch('/api/catalog');
        if (!res.ok) {
            throw new Error(`Katalogni yuklashda xatolik (HTTP ${res.status})`);
        }
        const data = await res.json().catch(() => null);
        if (!data) throw new Error('Katalog javobi noto\'g\'ri');
        productLoadState = 'ready';
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
        productLoadState = products.length ? 'ready' : 'error';
        renderProducts();
        console.warn('Katalogni yuklab bo\'lmadi:', e);
    }
}

// ============================================================
// BARCODE SCANNER — USB/Bluetooth optimized
// ============================================================
let barcodeBuffer = '';
let barcodeTimer = null;

document.addEventListener('keypress', e => {
    // BARCODE SKANER FAQAT KASSA (POS) SAHIFASI OCHIQ BO'LGANDA ISHLAYDI.
    // Login va boshqa sahifalarda Enter yoki boshqa tugmalar "barkod" sifatida
    // qabul qilinmaydi — shu bois login sahifasida POS notification chiqmaydi
    // ("Topilmadi! Barkod: Enter — mahsulot yo'q" kabi xatolik bo'lmaydi).
    const pagePos = document.getElementById('page-pos');
    if (!pagePos || !pagePos.classList.contains('active')) return;
    // Matn maydonlarida yozish skaner hisoblanmaydi
    if (document.activeElement.tagName === 'TEXTAREA') return;
    if (document.activeElement.tagName === 'INPUT' &&
        document.activeElement.id !== 'posSearch') return;

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
    if (!inp) return;
    // Ko'z tugmasi — parolni ko'rsatishning YAGONA yo'li (foydalanuvchi tanlovi)
    setLoginPasswordVisible(inp.type === 'password');
}

function selectUser(role) {
    const loginUser = document.getElementById('loginUser');
    const loginPass = document.getElementById('loginPass');
    if (!loginUser || !loginPass) return;
    // Xodim kirishida xaridor yo'q — faqat admin / cashier / manager
    if (!['admin', 'cashier', 'manager'].includes(role)) return;
    loginUser.value = role;
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
document.addEventListener('click', function (e) {
    const container = document.querySelector('.employee-dropdown-container');
    if (container && !container.contains(e.target)) {
        const dp = document.getElementById('topbarEmployeeDropdown');
        if (dp) dp.style.display = 'none';
    }
});

function renderEmployeeDropdown() {
    const dp = document.getElementById('topbarEmployeeDropdown');
    if (!dp) return;
    const role = currentUser?.role || 'guest';
    // Boshliq ham tizimga kirgan xodim: uning dropdown'ida ham "Tizimdan chiqish"
    // bo'lishi kerak (mobil headerda logout yo'q edi — faqat "Xodim kirishi").
    // Har uchala rol uchun bitta `doLogout()` — alohida parallel logout yo'q.
    const isStaff = ['admin', 'cashier', 'manager', 'boss'].includes(role);
    const item = (icon, label, action, cls) => `
        <div class="employee-dropdown-item ${cls || ''}" onclick="${action}; document.getElementById('topbarEmployeeDropdown').style.display='none';">
            <i class="fas ${icon}" style="width:16px; margin-right:8px;"></i><span>${label}</span>
        </div>`;
    let html = '';
    if (isStaff) {
        html += item('fa-user-circle', 'Profil', 'showEmployeeProfile()');
        if (role === 'admin') html += item('fa-cog', 'Sozlamalar', "goTo('page-settings', document.getElementById('nav-settings'))");
        html += item('fa-sign-out-alt', 'Tizimdan chiqish', 'doLogout()', 'logout');
    } else {
        html += item('fa-sign-in-alt', 'Xodim kirishi', 'openEmployeeLogin()');
    }
    dp.innerHTML = html;
}

function triggerEmployeeRegistration() {
    document.getElementById('topbarEmployeeDropdown').style.display = 'none';
    // Xodimlar boshqaruvi yagona joy — Boshliq → Xodimlar (page-bossStaff).
    if (!currentUser || currentUser.role !== 'boss') {
        playError();
        showNotif('error', 'Ruxsat yo\'q!', 'Xodimlarni faqat Boshliq boshqaradi');
        return;
    }
    goTo('page-bossStaff', document.getElementById('nav-bossStaff'));
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
        loginPage.style.display = 'grid';
    }
    if (app) app.style.display = 'none';
    document.getElementById('loginPhone')?.focus();
}

// ============================================================
// LOGIN
// ============================================================
async function doLogin() {
    const phoneInp = document.getElementById('loginPhone');
    const phoneRaw = phoneInp?.value || '';
    const p = document.getElementById('loginPass')?.value || '';

    clearLoginFieldErrors();

    // ── Validatsiya (telefon YOKI login nomi + parol) ──
    const rawLogin = String(phoneRaw).trim();
    const phone = normalizePhoneUz(rawLogin);
    // Login nomi: admin, boss2, manager@texnopark.uz kabi qiymatlar.
    // Server ikkala shaklni ham qabul qiladi (telefon yoki login).
    const username = /^[A-Za-z0-9][A-Za-z0-9._@+-]{1,119}$/.test(rawLogin) ? rawLogin : '';
    const loginKey = phone || username;

    if (!rawLogin) {
        showLoginFieldError('loginPhoneError', 'Telefon yoki loginni kiriting');
        phoneInp?.focus();
        playError();
        return;
    }
    if (!loginKey) {
        showLoginFieldError('loginPhoneError', 'Telefon raqami yoki login noto\u2018g\u2018ri');
        phoneInp?.focus();
        playError();
        return;
    }
    if (!p) {
        showLoginFieldError('loginPassError', 'Parolni kiriting');
        document.getElementById('loginPass')?.focus();
        playError();
        return;
    }

    if (hasSqlInjectionPattern(loginKey) || hasSqlInjectionPattern(p) || hasXssPattern(loginKey) || hasXssPattern(p)) {
        playError();
        showNotif('error', 'Xavfsizlik!', 'Login ma\'lumotlarida shubhali belgilar topildi');
        securityLog('login-injection-block', 'high', 'Kirish maydonida shubhali belgilar aniqlandi');
        return;
    }

    // ── Brute-force himoyasi (telefon/login bo'yicha) ──
    // MUHIM (ROOT CAUSE FIX): lokal (brauzer) lockout FAQAT noto'g'ri parol
    // urinishlarini cheklashi kerak. To'g'ri telefon + parol eski (stale)
    // `tp_login_guard` holatidan bloklanmaydi — haqiqiy tekshiruv
    // attemptLogin() da o'tkaziladi; muvaffaqiyatda clearLoginFailures()
    // barcha urlanishlarni tozalaydi, xato bo'lsa onLoginRejected() ->
    // registerLoginFailure() lockoutni qayta qo'llaydi (5 xato urinish -> blok).
    // Server xavfsizligi o'zgartirilmaydi: IP-ratelimit (429) va bloklangan
    // hisob (403 account_blocked) xuddi avvalgidek ishlaydi.
    const guard = loginGuardStatus(loginKey);
    if (guard.locked) {
        securityLog('lockout', 'high', 'Bloklangan login uchun tekshiruv: ' + loginKey);
    }

    // Yuklanish holati: tugma o'chadi — ikki marta bosish duplicate request yubormaydi
    setLoginLoading(true);
    try {
        await attemptLogin(loginKey, p);
    } finally {
        setLoginLoading(false);
        // Turnstile tokeni bir martalik — muvaffaqiyatsiz urinishdan keyin
        // yangisini olish uchun widget'ni tozalaymiz.
        if (typeof TurnstileGate !== 'undefined' && !currentUser) TurnstileGate.reset();
    }
}

/**
 * Noto'g'ri login/parol urinishini qayd etadi va tegishli xabarni ko'rsatadi.
 * Lokal lockout (tp_login_guard) faqat MANA SHU yerda — muvaffaqiyatsiz
 * urinishlar uchun — qo'llanadi. Ma'lum miqdordagi xatodan so'ng
 * registerLoginFailure() lockUntil ni o'rnatadi va keyingi xato urinishlar
 * "Kirish bloklangan!" xabari bilan cheklanadi. To'g'ri parol bloklanmaydi.
 */
function onLoginRejected(loginKey) {
    registerLoginFailure(loginKey);
    playError();
    const st = loginGuardStatus(loginKey);
    if (st.locked) {
        showNotif('error', 'Kirish bloklangan!',
            `Juda ko'p noto'g'ri urinish. ${st.minutes} daqiqadan keyin qayta urinib ko'ring.`);
        securityLog('lockout', 'high', 'Bloklangan telefon raqamiga kirish urinishi: ' +
            String(loginKey || '').slice(0, 40));
    } else {
        showNotif('error', 'Xato!', `Login yoki parol noto'g'ri (${st.left} urinish qoldi)`);
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
        const role = normalizeRole(server.user?.role);
        const loginUser = {
            id: local?.id || Date.now(),
            login: cleanText(server.user?.login, 120) || u,
            name: cleanText(server.user?.name, 120) || u,
            role: role,
            // Login identifikatori — telefon. Profilda ko'rsatiladi va
            // xodim o'zi almashtira oladi (Boshliq panelida ham ko'rinadi).
            phone: cleanText(server.user?.phone, 40) || '',
            // Filialga biriktirish (server sessiyasidan) — yangi mahsulotni
            // o'z filialida boshlash uchun ishlatiladi.
            branchId: cleanText(server.user?.branchId, 40) || '',
            color: local?.color || '#2563EB'
        };
        finishLogin(loginUser);
        return;
    }

    if (server.invalid) {
        onLoginRejected(u);
        return;
    }

    // ── Oflayn rejim: server javob bermadi ──
    console.warn('Server javob bermadi — oflayn tekshiruv ishlatiladi');
    const result = verifyUserLogin(u, p);
    if (!result.ok) {
        onLoginRejected(u);
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

/* ============================================================
   YAGONA «ROL → BOSHLANG'ICH SAHIFA» MANBASI
   ------------------------------------------------------------
   Muammo: ro'l→sahifa xaritasi faqat `finishLogin` (yangi login)
   ichida edi; `loginWithUser` (sahifa yangilash / orqaga qaytish /
   sessiya tiklash) esa hech qayerga yo'naltirmasdi va HTML'dagi
   default `.active` sahifaga tayanardi. Natijada xodim ba'zan
   ommaviy onlayn do'kon (page-shop) ko'rib qolardi.
   Endi IKKALA yo'l ham shu yagona manbadan foydalanadi.
   ============================================================ */

/** Berilgan ro'l uchun standart (birinchi) sahifa. Do'kon faqat mehmon/xaridor uchun. */
function landingPageForRole(role) {
    if (!role || role === 'customer') return 'page-shop';
    if (role === 'boss') return 'page-boss';
    if (role === 'cashier') return 'page-pos';
    // admin va menejer — boshqaruv paneli (page-dashboard ichida o'z dashboardi)
    return 'page-dashboard';
}

/** Sahifaga mos sidebar menyuni topadi (faol holat uchun). Topilmasa null. */
function navElForPage(pageId) {
    return Array.from(document.querySelectorAll('.nav-item')).find(n =>
        (n.getAttribute('onclick') || '').includes(`'${pageId}'`)) || null;
}

/** Login yoki sessiya tiklashdan so'ng ro'lga mos ICHKI sahifaga o'tadi (do'kon emas). */
function goToLandingFor(user) {
    const firstPage = landingPageForRole(user && user.role);
    goTo(firstPage, navElForPage(firstPage));
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
    // Sessiya eskirgandan keyingi qayta kirishda ma'lumotlar ommaviy
    // katalogdan kelgan bo'lishi mumkin (branchId/tannarx/savdo tarixisiz) —
    // to'liq bazaviy holatni serverdan qayta yuklaymiz, shunda keyingi
    // sinxronizatsiya eski/kam holatni bazaga yozmaydi.
    if (user.role !== 'customer') loadFromBackend().catch(() => { });
    // Xodim kirganda eng asosiy bo'lim ochiladi (do'kon yon panelning oxirida turadi)
    if (user.role !== 'customer') {
        // Yagona manba: ro'lga mos boshlang'ich ichki sahifa (do'kon emas).
        goToLandingFor(user);
    }
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
    // Serverda sessiyani yopamiz (token hali borligida) — keyin lokal token o'chiriladi.
    try {
        fetch('/api/auth/logout', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }) }).catch(() => { });
    } catch (e) { /* offline — lokal chiqish kifoya */ }
    // Server tokenini ham o'chiramiz (sessiya to'liq yopiladi)
    clearStaffToken();
    Security.endSession(force ? 'majburiy' : 'foydalanuvchi');
    // Faol filial tanlovi faqat shu sessiyaga tegishli: keyingi kirishda
    // boshqa xodim bo'lishi mumkin — eski tanlov qolmasin (Kassa bo'sh ko'rinmasin).
    activeBranchId = '';
    try { localStorage.removeItem('tp_active_branch'); } catch (e) { }
    try { Branches.refreshBranchSwitcher(); } catch (e) { }
    currentUser = null; cart = []; shopCart = [];
    // Chiqishda kassa savatining saqlangan holati tozalanadi
    // (keyingi kiruvchi xodimning ekranida eski savat qolmasligi uchun)
    posClearCartState();
    posToggleSheet(false);

    const topName = document.getElementById('topbarEmployeeName');
    if (topName) topName.textContent = 'Xodim';

    const loginPage = document.getElementById('loginPage');
    const app = document.getElementById('app');
    // ── Chiqishdan keyin LOGIN sahifasiga qaytamiz ───────────────────────
    // Ilgari bu yerda `#app.market-mode` (do'kon vitrinasi) ko'rsatilardi —
    // bu Google bilan kirgan "customer" davridan qolgan xatti-harakat edi.
    // Natijada xodim «Tizimdan chiqish» bosgach login ekrani o'rniga do'kon
    // ochilib qolardi (sessiya tugagan bo'lsa ham marshrut himoyasi yo'q).
    if (loginPage) {
        loginPage.classList.add('active');
        loginPage.style.display = 'grid';
    }
    if (app) {
        app.style.display = 'none';
        app.classList.remove('market-mode');
    }

    const loginPhone = document.getElementById('loginPhone');
    const loginPass = document.getElementById('loginPass');
    if (loginPhone) loginPhone.value = '';
    if (loginPass) loginPass.value = '';
    // Parol holati doim yashirin holatga qaytadi
    loginPasswordVisible = false;
    setLoginPasswordVisible(false);
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    // Do'kon sahifasini ochib qo'ymaymiz: keyingi muvaffaqiyatli kirishda
    // finishLogin() foydalanuvchiga ruxsat etilgan birinchi sahifani ochadi.
    setupRoleBasedNav();
    // XODIM (admin/menejer/kassir/boshliq) chiqishda — xavfsiz login sahifasi
    // ochiladi (ommaviy do'kon emas). Bu sessiya muddati tugaganda ham
    // (majburiy chiqish) qo'llaniladi. Mehmon/xaridor — ochiq do'konga qaytadi.
    const wasStaff = user && user.role && user.role !== 'customer';
    if (wasStaff) {
        showLoginScreen();
    } else {
        goTo('page-shop', document.getElementById('nav-shop'));
    }
}

// ============================================================
// INIT
// ============================================================
function initApp() {
    loadSettings();

    // Public marketplace/guest mode does not need POS, payroll, security or
    // dashboard modules. Keeping this path small also makes the catalog
    // available when the API is offline or opened from file://.
    if (!currentUser) {
        setupRoleBasedNav();
        renderShop();
        updateShopCart();
        initMarketChrome();
        return;
    }

    checkClickCallback();
    setupRoleBasedNav();
    initClock();
    loadDashboard();
    loadPOS();
    renderShop();
    initMarketChrome();
    renderProducts();
    renderCustomers();
    renderEmployees();
    renderSMS();
    renderLogs();
    renderReports();
    updateCustomerDropdown();
    // Mahsulotlar loadPOS() paytida hali tayyor bo'lmasa — shu yerda qayta uriniladi
    posRestoreCartState();
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
    // Filiallar: yorliq badge, faol filial tanlagich
    if (typeof Branches !== 'undefined') Branches.init();
    // Kirim / chiqim / harajat (filial bo'yicha moliyaviy nazorat)
    if (typeof CashFlow !== 'undefined') CashFlow.init();
    // Boshliq moduli faqat BOSHLIQ roliga yuklanadi — boshqa rollar uchun
    // na moduli, na `/api/boss/*` so'rovi ishga tushmaydi.
    if (typeof Boss !== 'undefined' && isBoss()) Boss.paintPeriodChips();
}

function showLoginScreen() {
    currentUser = null;
    const loginPage = document.getElementById('loginPage');
    const app = document.getElementById('app');

    if (loginPage) {
        loginPage.classList.add('active');
        loginPage.style.display = 'grid';
    }
    if (app) app.style.display = 'none';
}

// ============================================================
// ROLE-BASED NAVIGATION
// ============================================================
function setupRoleBasedNav() {
    const role = currentUser ? normalizeRole(currentUser.role) : 'guest';
    document.body.setAttribute('data-role', role);
    // BOSHLIQ (boss) — eng yuqori rol, lekin sidebar'da FAQAT o'z menyusi ko'rinadi
    // (8 bo'lim: Boshliq Dashboard, Xodimlar, Xodim savdosi, Mahsulotlar,
    // Filiallar, Moliya, Hisobotlar, Amallar jurnali).
    // Sozlamalar BOSHLIQ menyusiga kirmaydi — bu talabga ko'ra faqat boss
    // bo'limlari ko'rinadi, qolgan rollar o'z `data-role` ro'yxati bilan cheklanadi.
    const boss = isBoss();
    // `.nav-item-wrapper` (masalan, Xodimlar dropdown konteyneri) ham
    // qayta ishlanadi — aks holda wrapper ichidagi data-role e'tiborsiz
    // qoladi va yashirilgan menyu bo'sh blok bo'lib ko'rinib qoladi.
    document.querySelectorAll('.nav-item, .nav-section, .nav-item-wrapper').forEach(el => {
        const raw = el.getAttribute('data-role') || 'admin,cashier,manager';
        const roles = raw.split(',').map(r => r.trim()).filter(Boolean);
        let visible;
        if (boss) {
            visible = roles.includes('boss');
        } else {
            visible = roles.includes(role) || roles.includes('all');
        }
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
    // Mobil kassa savat drawer'i yopiladi (body qulfi qolmaydi)
    posToggleSheet(false);

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
        dashboard: ['Dashboard', 'Xush kelibsiz, bugun ham yaxshi dun!'],
        boss: ['Boshliq Dashboard', 'Butun biznes holati — real ma\'lumot asosida'],
        bossStaff: ['Xodimlar', 'Xodimlar nazorati, reyting va boshqaruv'],
        bossStaffSales: ['Xodim savdosi', 'Kim qancha va nima sotganini ko\'rish'],
        bossProducts: ['Mahsulotlar', 'Mahsulotlar, top sotuvchilar va kam qoldiqlar'],
        bossBranches: ['Filiallar', 'Filiallar holati va o\'zaro solishtirish'],
        bossFinance: ['Moliya', 'Savdo, kirim, chiqim, xarajat va sof natija'],
        bossCustomers: ['Mijozlar', "Haridorlar bazasi va xarid tarixi"],
        bossCashSverka: ['Kassa sverkasi', 'Kutilgan naqd va sanalgan pul solishtiruvi'],
        bossReports: ['Hisobotlar', 'Boshliq hisobotlari va CSV eksport'],
        bossAudit: ['Amallar jurnali', 'Boshliq amalari tarixi'],
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
        contracts: ['Shartnomalar', 'Shartnomalar, kunlik va oylik savdo'],
        pos: ['Kassa (POS)', 'F2=To\'lov | Esc=Tozala | F3=Kassa | F8=Chek'],
        branches: ['Filiallar va joylashuv', 'Filiallar ro\'yxati va boshqaruv'],
        cashflow: ['Kirim-chiqim', 'Pul harakatlarini boshqaring'],
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
    if (key.startsWith('boss')) {
        // Boshliq sahifalari (boss, bossStaff, bossStaffSales, ...) o'z
        // moduli orqali chiziladi (boss.js) — har bir bo'lim qayta yuklanadi.
        if (typeof Boss !== 'undefined') Boss.onPageOpen(key);
    }
    if (key === 'categories') { if (typeof renderCategoriesPage === 'function') renderCategoriesPage(); }
    if (key === 'warehouse') { if (typeof renderWarehousePage === 'function') renderWarehousePage(); }
    if (key === 'discounts') { if (typeof renderDiscountsPage === 'function') renderDiscountsPage(); }
    if (key === 'contracts') Contracts.render();
    if (key === 'pos') { renderPayTypes(); renderProductGrid(); }
    if (key === 'logs') renderSecurityPanel();
    if (key === 'settings') { Security.renderSettings(); PaymentGateway.renderSettings(); }
    if (key === 'assistant') { Assistant.init(); }
    if (key === 'branches' && typeof Branches !== 'undefined') Branches.onPageOpen();
    if (key === 'cashflow' && typeof CashFlow !== 'undefined') CashFlow.onPageOpen();

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

    // 8) mobil qurilmalarda drawer'ni yopish (sahifa almashganda)
    if (sidebarIsMobile()) resetSidebar();
}

function canAccessPage(pageId) {
    if (!currentUser) return pageId === 'page-shop';
    // Boshliq eng yuqori rol — barcha bo'limlarga kira oladi.
    if (isBoss()) return true;
    // Admin xodimlar ro'yxatidan savdo tafsilotiga o'tadi; alohida menyu
    // bandi yo'q, lekin shu sahifa umumiy staff modulining bir qismidir.
    if (normalizeRole(currentUser.role) === 'admin'
        && pageId === 'page-bossStaffSales') return true;
    if (normalizeRole(currentUser.role) === 'manager'
        && pageId === 'page-bossStaff') return true;
    const nav = Array.from(document.querySelectorAll('.nav-item')).find(item => {
        const handler = item.getAttribute('onclick') || '';
        return handler.includes(`'${pageId}'`) || handler.includes(`"${pageId}"`)
            // `data-page` bilan bog'langan menyu bandlari ham ruxsat manbai
            // bo'lishi mumkin (masalan, submenu ochadigan wrapper'lar).
            || item.getAttribute('data-page') === pageId;
    });
    // Nav ro'yxatida bo'lmagan sahifa — faqat ochiq do'kon (page-shop) uchun ruxsat.
    // Aks holda URL orqali bevosita kirishga urinish (to'g'ridan-to'g'ri manzil)
    // ham rad etiladi, faqat menyuni yashirish bilan cheklanilmaydi.
    if (!nav) return pageId === 'page-shop';
    const roles = (nav.getAttribute('data-role') || 'admin,cashier,manager').split(',').map(r => r.trim());
    return roles.includes(normalizeRole(currentUser.role)) || roles.includes('all');
}

// ============================================================
// SIDEBAR TOGGLE — yagona holat (menuOpen) asosida
// Desktop: .collapsed (84px, faqat ikonlar) <-> ochiq (276px, ikon + nom)
// Mobil:   .open (chapdan drawer) + qoramtir overlay
// Ikon (☰ <-> ✕) va sidebar holati DOIM sinxron.
// ============================================================

/** Mobil drawer chegarasi — CSS'dagi 768px media query bilan bir xil. */
function sidebarIsMobile() {
    return window.innerWidth <= 768;
}

/** ☰ / ✕ tugma holatini joriy sidebar holatiga moslashtiradi. */
function syncSidebarToggleIcon() {
    const btn = document.getElementById('sidebarToggleBtn');
    const sb = document.getElementById('sidebar');
    if (!btn || !sb) return;
    const open = sidebarIsMobile()
        ? sb.classList.contains('open')
        : !sb.classList.contains('collapsed');
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = open ? 'fas fa-times' : 'fas fa-bars';
        // Yengil icon almashish animatsiyasi (takroran ishga tushadi)
        icon.classList.remove('icon-pop');
        void icon.getBoundingClientRect();
        icon.classList.add('icon-pop');
    }
    const label = open ? 'Menyuni yopish' : 'Menyuni ochish';
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-expanded', String(open));
}

/** Mobil drawer ochiq bo'lganda qoramtir overlay'ni ko'rsatadi/yashiradi. */
function syncSidebarOverlay() {
    const overlay = document.getElementById('sidebarOverlay');
    const sb = document.getElementById('sidebar');
    if (!overlay || !sb) return;
    const show = sidebarIsMobile() && sb.classList.contains('open');
    overlay.classList.toggle('visible', show);
    overlay.setAttribute('aria-hidden', String(!show));
}

/** Yagona sidebar holati: barcha klass facetlari bitta qiymatdan keladi. */
function setSidebarOpen(open) {
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    const mobile = sidebarIsMobile();
    sb.classList.toggle('open', open);
    // Desktop: ochiq holat `.collapsed` olib tashlash bilan kengayadi
    // Mobil: `.collapsed` faqat desktop qoidalariga taalluqli — ta'sir qilmaydi
    if (!mobile) sb.classList.toggle('collapsed', !open);
    syncSidebarToggleIcon();
    syncSidebarOverlay();
    // Mobil drawer ochiq bo'lganda orqa scroll qulflanadi
    document.body.classList.toggle('sidebar-locked', open && mobile);
}

/** ☰ / ✕ tugma — desktopda yig'adi/ochadi, mobilda drawer ochadi/yopadi. */
function toggleSidebar(force) {
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    const open = typeof force === 'boolean'
        ? force
        : (sidebarIsMobile() ? !sb.classList.contains('open') : sb.classList.contains('collapsed'));
    setSidebarOpen(open);
}

/** Sidebarni majburiy yopish (overlay, Esc, sahifa almashinuvi). */
function resetSidebar() {
    setSidebarOpen(false);
}

// Ekran kattalashsa — telefon drawer yopiladi, desktop yopiq holatga qaytadi.
// Faqat HAQIQIY o'lcham o'zgarishida ishlaydi (goTo'dagi sintetik resize e'tiborsiz).
let _sidebarLastW = window.innerWidth;
let _sidebarResizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(_sidebarResizeTimer);
    _sidebarResizeTimer = setTimeout(() => {
        if (window.innerWidth === _sidebarLastW) return;
        _sidebarLastW = window.innerWidth;
        const sb = document.getElementById('sidebar');
        if (!sb) return;
        if (!sidebarIsMobile()) {
            sb.classList.remove('open');
            sb.classList.add('collapsed');
        }
        syncSidebarToggleIcon();
        syncSidebarOverlay();
        document.body.classList.toggle('sidebar-locked', sidebarIsMobile() && sb.classList.contains('open'));
    }, 120);
});

// Esc — drawer yoki ochiq sidebarni yopadi
document.addEventListener('keydown', e => { if (e.key === 'Escape') resetSidebar(); });

// ============================================================
// MOBIL SWIPE — chap chetdan o'ngga surish: drawer ochiladi;
// ochiq holatda chapga surish: yopadi. FAQAT mobil (≤768px).
// Integratsiya: tugmachalar/overlay/Esc kabi YAGONA
// setSidebarOpen() holat boshqaruvi ishlatiladi — parallel
// menyu tizimi yo'q. Faqat touch eventlar qo'llaniladi
// (pointer event UNDECLARED — takroriy ikkinchi tizim yo'q).
// Gest faqat gorizontal dominantlikda "egallanadi" (claim):
// vertikal scroll, kartalar, jadvallar va inputlar buzilmaydi.
// ============================================================
(function initSidebarSwipe() {
    const EDGE_ZONE = 32;   // yopiq holatda: faqat chap chetdan 32px ichidan boshlangan surish
    const CLAIM_PX = 8;     // gorizontal "egallash" uchun minimal siljish (px)
    const ABORT_PX = 16;    // shu qatlamdan ortiq vertikal siljish = scroll niyatı → gesture bekor
    const FLING_V = 0.35;   // px/ms — tez qo'yib yuborish (fling) chegarasi

    const st = { active: false, claimed: false, x0: 0, y0: 0, t0: 0, lastX: 0, lastT: 0, wasOpen: false };

    /** Drag vaqtidagi inline holatlarni tozalaydi (bazaviy CSS animatsiyasiga qaytaradi). */
    function resetSwipeStyles() {
        const sb = document.getElementById('sidebar');
        if (sb) { sb.style.transition = ''; sb.style.transform = ''; }
    }

    /** Gesture yakuni: qaror (fling yoki >50%) → YAGONA setSidebarOpen(). */
    function finishSwipe() {
        if (!st.active && !st.claimed) return;
        const sb = document.getElementById('sidebar');
        if (st.claimed && sb) {
            const w = sb.offsetWidth || 1;
            // Joriy (surerilgan) transform → ochiqlik darajasi: 0=yopiq, 1=ochiq
            const m = /translateX\((-?[\d.]+)px\)/.exec(sb.style.transform || '');
            const pos = m ? Math.min(1, Math.max(0, 1 + parseFloat(m[1]) / w)) : (st.wasOpen ? 1 : 0);
            const dx = st.lastX - st.x0;
            const vx = dx / Math.max(1, st.lastT - st.t0);
            // Tez surish (fling) — yo'nalish hal qiladi; aks holda >50% qoidasi
            const open = Math.abs(vx) > FLING_V ? dx > 0 : pos > 0.5;
            resetSwipeStyles();
            // Inline transform tozalangach class holati bazaviy .3s transform
            // animatsiyasi bilan surilgan joydan "yetib boradi" (silliq finish).
            setSidebarOpen(open);
        } else {
            resetSwipeStyles();
        }
        st.active = false;
        st.claimed = false;
    }

    document.addEventListener('touchstart', e => {
        if (!sidebarIsMobile() || e.touches.length !== 1) return;
        const sb = document.getElementById('sidebar');
        // Market-rejim (do'kon): drawer tizimi o'chirilgan — overlay ham
        // `#app.market-mode .sidebar-overlay { display:none !important }`.
        // Edge swipe u yerda overlay siz ochilgan menyuni "tiqib" qo'yadi —
        // shuning uchun market-rejimda gest butunlay o'chirilgan.
        const appEl = document.getElementById('app');
        if (appEl && appEl.classList.contains('market-mode')) return;
        // Yashirin drawer — gest kerak emas
        if (!sb || getComputedStyle(sb).display === 'none') return;
        // Matn kiritish elementlaridan boshlangan surishlarga tegilmaydi
        if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        // Ochiq modal / pastki varaq ustida boshlangan gest menyu tegmasin
        if (document.querySelector('.modal-overlay.open, [id$="Modal"].open')) return;
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        const wasOpen = sb.classList.contains('open');
        // Yopiq holatda faqat CHAP CHEGARADAN (≤32px) boshlangan surish qabul
        // qilinadi; ochiq holatda istalgan joydan chapga surish yopadi.
        if (!wasOpen && x > EDGE_ZONE) return;
        st.active = true;
        st.claimed = false;
        st.x0 = st.lastX = x;
        st.y0 = y;
        st.t0 = st.lastT = Date.now();
        st.wasOpen = wasOpen;
    }, { passive: true });

    document.addEventListener('touchmove', e => {
        if (!st.active || e.touches.length !== 1) return;
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        st.lastX = x;
        st.lastT = Date.now();
        const dx = x - st.x0;
        const dy = y - st.y0;
        if (!st.claimed) {
            // Aniq vertikal siljish = sahifa/sidevar skrolli — gesture bekor,
            // preventDefault YO'Q, scroll hech qanday xalaqitsiz ishlaydi.
            if (Math.abs(dy) > ABORT_PX && Math.abs(dy) > Math.abs(dx)) { st.active = false; return; }
            if (Math.abs(dx) < CLAIM_PX || Math.abs(dx) <= Math.abs(dy)) return;
            // Gorizontal yo'nalish sharti: yopiq → o'ngga (dx>0); ochiq → chapga (dx<0)
            if ((!st.wasOpen && dx <= 0) || (st.wasOpen && dx >= 0)) { st.active = false; return; }
            st.claimed = true;
        }
        // Gest "egallandi" — keyingi move'larda sahifa skrolli to'xtaydi
        e.preventDefault();
        const sb = document.getElementById('sidebar');
        if (!sb) { st.active = false; st.claimed = false; return; }
        const w = sb.offsetWidth || 1;
        const tx = st.wasOpen
            ? Math.min(0, Math.max(-w, dx))        // ochiq: 0 → -w (chapga suriladi)
            : -w + Math.min(w, Math.max(0, dx));   // yopiq: -w → 0 (o'ngga ochiladi)
        sb.style.transition = 'none';
        sb.style.transform = 'translateX(' + tx + 'px)';
    }, { passive: false });

    document.addEventListener('touchend', finishSwipe);
    document.addEventListener('touchcancel', finishSwipe);
})();

// ============================================================
// SCROLL REVEAL HELPERS
// ============================================================
// Reveal helpers removed — tab-based UI restored.

// ============================================================
// THEME
// ============================================================
function syncThemeIcon() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const icon = document.getElementById('themeIcon');
    // POS topbar icon reflects the current theme (moon = dark, sun = light).
    if (icon) icon.className = isLight ? 'fas fa-sun' : 'fas fa-moon';
    // Market header lock button reflects the theme it switches to.
    const marketIcon = document.getElementById('marketThemeIcon');
    if (marketIcon) marketIcon.className = isLight ? 'fas fa-moon' : 'fas fa-sun';
    const marketBtn = document.getElementById('marketThemeToggle');
    if (marketBtn) {
        const label = isLight ? 'Tungi rejim' : 'Kunduzgi rejim';
        marketBtn.setAttribute('title', label);
        marketBtn.setAttribute('aria-label', label);
    }
}

function applySavedTheme() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('tp_theme'); } catch (e) { savedTheme = null; }
    const nextTheme = savedTheme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    syncThemeIcon();
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('tp_theme', next); } catch (e) { /* storage blocked (e.g. file://) */ }
    syncThemeIcon();
}

// ============================================================
// DASHBOARD
// ============================================================
function loadDashboard() {
    ['admin-dashboard', 'cashier-dashboard', 'manager-dashboard'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const role = currentUser?.role || 'cashier';
    // Boshliq — alohida "Boshliq Dashboard" bo'limiga o'tadi.
    if (role === 'boss') {
        const box = document.getElementById('boss-dashboard');
        if (box) box.style.display = 'block';
        goTo('page-boss', document.getElementById('nav-boss'));
        if (typeof Boss !== 'undefined') Boss.load();
        return;
    }
    if (role === 'admin') { document.getElementById('admin-dashboard').style.display = 'block'; loadAdminDashboard(); loadAdminDashboardExtras(); }
    else if (role === 'cashier') { document.getElementById('cashier-dashboard').style.display = 'block'; loadCashierDashboard(); }
    else if (role === 'manager') { document.getElementById('manager-dashboard').style.display = 'block'; loadManagerDashboard(); }
    else if (role === 'customer') { goTo('page-shop', document.getElementById('nav-shop')); }
}

function loadAdminDashboard() {
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const todaysSales = salesHistory.filter(s => isPaidSale(s) && isSameDay(s.date, now));
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
        const totalProfit = salesHistory.filter(isPaidSale).reduce((a, b) => a + saleProfit(b), 0);
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
    uiSetHtml('d-profit-change', '<i class="fas fa-percent"></i> Haqiqiy tannarx asosida (sotuv − tannarx − chegirma)');
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
        salesHistory.filter(isPaidSale).forEach(s => {
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

/** Admin dashboard uchun qo'shimcha ko'rsatkichlar. */
function loadAdminDashboardExtras() {
    const now = new Date();
    const monthSales = salesHistory.filter(s => isSameMonth(s.date, now));
    const monthTotal = monthSales.reduce((a, s) => a + (Number(s.total) || 0), 0);
    uiSetText('d-month-sales', fmt(monthTotal) + " so'm");
    uiSetHtml('d-month-note', `<i class="fas fa-receipt"></i> ${monthSales.length} ta chek`);

    const emptyCats = CATEGORIES.filter(c => !products.some(p => p.cat === c)).length;
    uiSetText('d-categories', String(CATEGORIES.length));
    uiSetHtml('d-categories-note', `<i class="fas fa-box"></i> Bo'sh: ${emptyCats} ta`);

    const stockValue = products.reduce((a, p) => a + (Number(p.price) || 0) * (Number(p.stock) || 0), 0);
    const stockQty = products.reduce((a, p) => a + (Number(p.stock) || 0), 0);
    uiSetText('d-stock-value', fmt(stockValue) + " so'm");
    uiSetHtml('d-stock-note', `<i class="fas fa-cubes"></i> ${fmt(stockQty)} dona`);

    try {
        uiSetText('d-contracts', String(Array.isArray(contracts) ? contracts.length : 0));
    } catch (e) { }

    renderLowStockBlock('d-lowstock');
    const box = document.getElementById('d-catbreak');
    if (box) {
        const rows = CATEGORIES.map(c => ({
            name: c,
            count: products.filter(p => p.cat === c).length,
            stock: products.filter(p => p.cat === c).reduce((a, p) => a + (Number(p.stock) || 0), 0)
        })).sort((a, b) => b.count - a.count);
        const max = Math.max(1, ...rows.map(r => r.count));
        box.innerHTML = rows.map(r => `<div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
                <span style="font-weight:600">${categoryEmoji(r.name)} ${escapeHTML(r.name)}</span>
                <span style="color:var(--muted)">${r.count} ta · ${r.stock} dona</span></div>
            <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
                <div style="height:100%;width:${Math.round((r.count / max) * 100)}%;background:linear-gradient(90deg,var(--primary),var(--warning))"></div></div>
        </div>`).join('') || '<div class="dash-empty">Kategoriyalar yo\'q</div>';
    }
}

/** Kam qolgan mahsulotlar ro'yxati (admin va menejer uchun). */
function renderLowStockBlock(id) {
    const box = document.getElementById(id);
    if (!box) return;
    const low = products.filter(p => (Number(p.stock) || 0) < 5)
        .sort((a, b) => a.stock - b.stock).slice(0, 8);
    box.innerHTML = low.map(p => `<div class="dash-row">
        <span><strong>${escapeHTML(p.name)}</strong><br><small style="color:var(--muted)">${escapeHTML(p.cat || '')}</small></span>
        <span class="badge ${p.stock <= 0 ? 'badge-red' : 'badge-blue'}">${p.stock <= 0 ? 'Tugagan' : p.stock + ' ta'}</span>
    </div>`).join('') || '<div class="dash-empty"><i class="fas fa-check-circle" style="font-size:24px;color:var(--success);display:block;margin-bottom:8px"></i>Hamma mahsulot yetarli</div>';
}

function loadCashierDashboard() {
    const ts = salesHistory.filter(s => isPaidSale(s) && isSameDay(s.date, new Date()) && s.cashier === currentUser?.name);
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

    // ===== MOBIL KO'RINISH (#cashierMobile, ≤768px) =====
    // Yuqoridagi desktop elementlari o'z joyida to'ldirilgan bo'lib
    // o'zgarmaydi; bu yerda faqat mobil blok yangilanadi.
    const mob = document.getElementById('cashierMobile');
    if (!mob) return;

    const now = new Date();
    const period = ['day', 'week', 'month', 'year'].includes(mob.dataset.period) ? mob.dataset.period : 'day';
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    const inPeriod = s => {
        if (period === 'day') return isSameDay(s.date, now);
        if (period === 'month') return isSameMonth(s.date, now);
        if (period === 'week') return dateParts(s.date).some(x => !isNaN(x.getTime()) && x >= weekStart && x <= now);
        return dateParts(s.date).some(x => !isNaN(x.getTime()) && x.getFullYear() === now.getFullYear());
    };
    const rows = salesHistory.filter(s => isPaidSale(s) && s.cashier === currentUser?.name && inPeriod(s));

    // Bitta o'tishda jami/naqd/karta/sonlik — raqamlar takror hisoblanmaydi
    let mTotal = 0, mCash = 0, mCashN = 0, mCard = 0, mCardN = 0;
    for (const s of rows) {
        const v = Number(s.total) || 0;
        mTotal += v;
        const prov = String(s.provider || '').toLowerCase();
        const pay = String(s.pay || '').toLowerCase();
        if (prov === 'cash' || pay === 'naqd') { mCash += v; mCashN++; }
        else if (prov === 'card' || pay === 'karta') { mCard += v; mCardN++; }
    }

    const periodNames = { day: 'Bugungi savdolar', week: 'Haftalik savdolar', month: 'Oydagi savdolar', year: 'Yillik savdolar' };
    uiSetText('cd-total', fmt(mTotal) + ' so\'m');
    uiSetText('cd-total-sub', rows.length + ' ta chek');
    uiSetText('cd-count', String(rows.length));
    uiSetText('cd-count-sub', periodNames[period]);
    uiSetText('cd-cash', fmt(mCash) + ' so\'m');
    uiSetText('cd-cash-sub', mCashN + ' ta chek');
    uiSetText('cd-card', fmt(mCard) + ' so\'m');
    uiSetText('cd-card-sub', mCardN + ' ta chek');

    mob.querySelectorAll('.cd-pill').forEach(b => {
        const on = b.dataset.cdPeriod === period;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
    });

    // Salomlashuv kartasi — mavjud sessiya va filial ma'lumotlari (soxta yo'q)
    const uname = String(currentUser?.name || '').trim();
    uiSetText('cd-name', uname || '—');
    uiSetText('cd-avatar', (uname[0] || '?').toUpperCase());
    const branch = typeof getActiveBranch === 'function' ? getActiveBranch() : null;
    const meta = [ROLES[currentUser?.role] || '', branch?.name || ''].filter(Boolean).join(' • ');
    uiSetHtml('cd-meta', escapeHTML(meta));
    uiSetText('cd-date', 'Bugun ' + String(now.getDate()).padStart(2, '0') + '.' +
        String(now.getMonth() + 1).padStart(2, '0') + '.' + now.getFullYear());

    // So'nggi savdolar: davr ichida eng yangisi birinchi
    const recent = [...rows].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    const expanded = mob.dataset.recent === 'all';
    const shown = expanded ? recent : recent.slice(0, 5);
    const list = document.getElementById('cd-recent-list');
    if (list) {
        list.innerHTML = shown.map(cashierSaleRowHtml).join('') ||
            '<div class="cd-empty"><i class="fas fa-receipt"></i>Bu davrda savdo yo\'q</div>';
    }
    const allBtn = document.getElementById('cd-recent-all');
    if (allBtn) {
        allBtn.hidden = recent.length <= 5;
        allBtn.textContent = expanded ? 'Yopish' : 'Barchasi';
        allBtn.classList.toggle('on', expanded);
    }
}

/** Mobil dashboard: davr filtri (Bugun/Hafta/Oy/Yil). */
function setCashierPeriod(period) {
    const mob = document.getElementById('cashierMobile');
    if (!mob) return;
    mob.dataset.period = period;
    loadCashierDashboard();
}

/** Mobil "So'nggi savdolar": barchasi ↔ oxirgi 5 ta. */
function toggleCashierRecent() {
    const mob = document.getElementById('cashierMobile');
    if (!mob) return;
    mob.dataset.recent = mob.dataset.recent === 'all' ? 'few' : 'all';
    loadCashierDashboard();
}

/** Tezkor havola: savdo ro'yxatiga o'tish (expand — barchasini ko'rsatish). */
function cashierRecentScroll(expand) {
    const mob = document.getElementById('cashierMobile');
    if (mob && expand) mob.dataset.recent = 'all';
    loadCashierDashboard();
    document.getElementById('cd-recent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Mobil savdo qatori → mavjud chek modali (renderReceipt + checkoutModal). */
function cashierViewSale(id) {
    const sale = salesHistory.find(s => Number(s.id) === Number(id));
    if (!sale || typeof renderReceipt !== 'function' || typeof openModal !== 'function') return;
    renderReceipt(sale);
    openModal('checkoutModal');
}

/** Mobil "So'nggi savdolar" qatori HTML'i — faqat mavjud savdo ma'lumotidan. */
function cashierSaleRowHtml(s) {
    const items = Array.isArray(s.items) ? s.items : [];
    const first = items.find(it => it && it.name) || null;
    const qty = items.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const img = first && first.img
        ? `<img src="${escapeHTML(String(first.img))}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : '';
    const name = first ? escapeHTML(String(first.name)) : 'Savdo #' + String(s.id).slice(-6);
    const extra = items.length > 1 ? ` +${items.length - 1}` : '';
    const prov = String(s.provider || '').toLowerCase();
    const pay = String(s.pay || '');
    const payCls = prov === 'card' || /karta/i.test(pay) ? 'cd-pay-card'
        : prov === 'cash' || /naqd/i.test(pay) ? 'cd-pay-cash' : 'cd-pay-other';
    return `<button type="button" class="cd-sale" onclick="cashierViewSale(${Number(s.id) || 0})">
      <span class="cd-sale-img"><i class="fas fa-receipt"></i>${img}</span>
      <span class="cd-sale-main">
        <span class="cd-sale-name">${name}${extra}</span>
        <span class="cd-sale-sub">${items.length ? qty + ' ta • ' : ''}#${escapeHTML(String(s.id))}</span>
      </span>
      <span class="cd-sale-right">
        <span class="cd-sale-time">${escapeHTML(String(s.time || ''))}</span>
        <span class="cd-sale-price">${fmt(Number(s.total) || 0)} so'm</span>
        <span class="cd-pay ${payCls}">${escapeHTML(pay || '—')}</span>
      </span>
      <i class="fas fa-chevron-right cd-sale-chev"></i>
    </button>`;
}

function loadManagerDashboard() {
    const now = new Date();
    const todayTotal = todaySalesTotal();
    const todayCount = salesHistory.filter(s => isPaidSale(s) && isSameDay(s.date, now)).length;
    const paidCount = salesHistory.filter(isPaidSale).length;

    const ranked = employees
        .map(e => ({ ...e, ...employeeStats(e) }))
        .sort((a, b) => b.total - a.total);

    uiSetText('m-sales', fmt(todayTotal) + " so'm");
    uiSetText('m-sales-change', todayCount + ' ta chek · ' + paidCount + ' ta jami');
    uiSetText('m-employees', String(employees.length));
    uiSetText('m-employees-change', 'Admin, kassir va menejerlar');
    const top = ranked[0];
    uiSetText('m-top-cashier', top && top.total > 0 ? top.name : '—');
    uiSetText('m-top-cashier-change', top && top.total > 0 ? top.sales + ' ta sotuv · ' + fmt(top.total) + " so'm" : 'Hali savdo yo\'q');

    renderLowStockBlock('m-lowstock');
    const mtop = document.getElementById('m-topproducts');
    if (mtop) {
        const sold = {};
        salesHistory.forEach(s => (s.items || []).forEach(it => { sold[it.name] = (sold[it.name] || 0) + (Number(it.qty) || 0); }));
        const top = Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 6);
        mtop.innerHTML = top.map(([n, q]) => `<div class="dash-row"><span><strong>${escapeHTML(n)}</strong></span><span class="badge badge-blue">${q} ta</span></div>`).join('')
            || '<div class="dash-empty">Hali sotuvlar yo\'q</div>';
    }
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
    return salesHistory.filter(s => isPaidSale(s) && predicate(s)).reduce((sum, s) => sum + (Number(s.total) || 0), 0);
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
    salesHistory.filter(isPaidSale).forEach(s => {
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
    if (typeof renderPosHeld === 'function') renderPosHeld();
    // Sahifani yangilashdan keyin savat holatini tiklash (yagona `cart` manbasi)
    posRestoreCartState();
}

// POS kategoriya tugmalari — doimiy CATEGORIES ro'yxatidan quriladi,
// shuning uchun mahsulot bo'lmasa ham barcha bo'limlar ko'rinadi.
/**
 * POS ro'yxati va kategoriya hisoblagichining umumiy filtri (kategoriyasiz):
 * faol filial (visibleProducts) + qidiruv + "faqat bor" holati.
 * Ikkala render shu yerdan o'tgani uchun tab soni va grid har doim mos keladi.
 */
function posFilteredBase() {
    const q = cleanText(posFilter, 80).toLowerCase();
    const onlyStock = !!document.getElementById('posOnlyInStock')?.checked;
    return visibleProducts().filter(p =>
        (!onlyStock || p.stock > 0) &&
        (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q))
    );
}

function renderCatTabs() {
    const el = document.getElementById('catTabs');
    if (!el) return;
    const cats = ['Barchasi', ...CATEGORIES];
    // Hisoblagich ham aynan grid bilan bir xil shartlardan o'tadi
    // (filial + qidiruv + qoldiq) — faqat kategoriya bo'yicha ajratiladi.
    const base = posFilteredBase();
    el.innerHTML = cats.map(c => {
        const count = c === 'Barchasi' ? base.length : base.filter(p => p.cat === c).length;
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

function searchProducts(q) { posFilter = q; renderCatTabs(); renderProductGrid(); }
const debouncedSearch = debounce(searchProducts, 300);
const debouncedSearchProducts = debouncedSearch;
// Mobil tezlik: og'ir renderlar har harf bosishda emas, pauzadan keyin bir marta bajariladi
const debouncedRenderShop = debounce(renderShop, 300);
const debouncedContractsRender = debounce(() => { if (typeof Contracts !== 'undefined') Contracts.render(); }, 300);
const debouncedGlobalSearch = debounce(globalSearch, 300);

function syncShopSearch(value) {
    const input = document.getElementById('shopSearch');
    if (input) input.value = value;
    debouncedRenderShop();
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
        posToggleSheet(false);
        hideSearchSuggestions();
    }
});

// ============================================================
// XOHISHLAR RO'YXATI (wishlist) — mijoz tomonida lokal saqlanadi
// ============================================================
const WISHLIST_STORAGE_KEY = 'tp_wishlist';

function getWishlist() {
    const list = safeJsonParse(localStorage.getItem(WISHLIST_STORAGE_KEY) || '[]', []);
    return Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n)) : [];
}

function isWished(productId) {
    return getWishlist().includes(Number(productId));
}

/** Savat/katalog kartasidagi yurak tugmasi. */
function toggleWishlist(event, productId) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const id = Number(productId);
    const list = getWishlist();
    const index = list.indexOf(id);
    const added = index === -1;
    if (added) list.push(id); else list.splice(index, 1);
    try { localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(list)); } catch (e) { }

    syncWishlistIcons();
    const product = products.find(p => p.id === id);
    showNotif(added ? 'success' : 'info',
        added ? 'Xohishlarga qo\'shildi' : 'Xohishlardan olindi',
        product ? product.name : 'Xohishlar ro\'yxati yangilandi');
}

/** Saqlangan xohishlarga qarab barcha yurak tugmalarini yangilaydi. */
function syncWishlistIcons() {
    const list = getWishlist();
    document.querySelectorAll('.pc-wish[data-wish]').forEach(btn => {
        const on = list.includes(Number(btn.dataset.wish));
        btn.classList.toggle('on', on);
        const icon = btn.querySelector('i');
        if (icon) icon.className = `fa${on ? 's' : 'r'} fa-heart`;
    });
}

/** Demo chegirma foizi — mahsulot ID siga bog'langan barqaror qiymat. */
function shopDiscountPct(productId) {
    return 5 + ((Number(productId) * 7) % 6) * 5;
}

/** Chegirmadan oldingi (chizilgan) narx. */
function shopOldPrice(price, discountPct) {
    const value = Number(price) || 0;
    const pct = Number(discountPct) || 0;
    if (pct <= 0 || pct >= 100) return value;
    return Math.round(value / (1 - pct / 100) / 1000) * 1000;
}

/** Katalog va aksiya bo'limlari uchun yagona mahsulot kartasi. */
function shopProductCardHTML(p) {
    const imgSrc = productImageSrc(p.img) || shopFallbackImage(p.cat);
    const rating = (4.4 + ((p.id * 3) % 7) * 0.1).toFixed(1);
    const reviewCount = (p.id * 7 + 12);
    const discountPct = shopDiscountPct(p.id);
    const oldPrice = shopOldPrice(p.price, discountPct);
    const monthlyInst = Math.round(p.price / 12);
    const wished = isWished(p.id);

    return `
    <div class="product-card shop-product-card" onclick="openProductDetails(${p.id})">
      <div class="pc-media">
        <span class="pc-discount">-${discountPct}%</span>
        <button type="button" class="pc-wish${wished ? ' on' : ''}" data-wish="${p.id}" title="Xohishlar ro'yxati" onclick="toggleWishlist(event, ${p.id})"><i class="fa${wished ? 's' : 'r'} fa-heart"></i></button>
        <img class="product-card-img" src="${escapeHTML(imgSrc)}" alt="${escapeHTML(p.name)}" onerror="this.parentNode.querySelector('.product-card-img-placeholder').style.display='flex';this.style.display='none'">
        <div class="product-card-img-placeholder" style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:36px;background:var(--border)">
          ${categoryEmoji(p.cat) || '📦'}
        </div>
      </div>
      <div class="product-card-body">
        <div class="pc-rating"><i class="fas fa-star"></i><b>${rating}</b><span>(${reviewCount} sharh)</span></div>
        <div class="product-card-name">${escapeHTML(p.name)}</div>
        <span class="product-card-inst">${fmt(monthlyInst)} so'm/oyiga</span>
        <div class="pc-price-row">
          <div>
            <div class="pc-old"><s>${fmt(oldPrice)} so'm</s><em>-${discountPct}%</em></div>
            <div class="product-card-price">${fmt(p.price)} so'm</div>
            <div class="product-card-stock">Qoldiq: <strong>${p.stock} ta</strong></div>
          </div>
          <button type="button" class="product-add-btn" title="Savatga qo'shish" onclick="(event||window.event).stopPropagation(); addToShopCart(${p.id})"><i class="fas fa-cart-plus"></i></button>
        </div>
      </div>
    </div>`;
}

/** Mobil pastki navigatsiyadagi faol bo'limni belgilaydi. */
function syncMarketBottomNav(section) {
    const nav = document.querySelector('.market-bottom-nav');
    if (!nav) return;
    nav.querySelectorAll('button[data-nav]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.nav === section);
    });
}

/** Footer yili, xohishlar va mobil navigatsiya holatini tayyorlaydi. */
function initMarketChrome() {
    const year = document.getElementById('marketFooterYear');
    if (year) year.textContent = String(new Date().getFullYear());
    syncWishlistIcons();
    syncMarketBottomNav('home');
    const bottomBadge = document.getElementById('marketBottomCartCount');
    if (bottomBadge) bottomBadge.textContent = shopCart.reduce((s, x) => s + x.qty, 0);
}

function renderShop() {
    const grid = document.getElementById('shopProductGrid');
    const tabs = document.getElementById('shopCatSidebarList');
    if (!grid || !tabs) return;

    // `||` o'rniga element mavjud bo'lsa uni qiymatini olamiz — aks holda
    // maydon tozalansa ham eski filtr qolib ketardi (ro'yxat tozalanmasdi).
    const _shopSearchEl = document.getElementById('shopSearch');
    shopFilter = cleanText(_shopSearchEl ? _shopSearchEl.value : shopFilter, 80).toLowerCase();
    // Kategoriyalar doimiy ro'yxatdan — mahsulot soni 0 bo'lsa ham ko'rinadi
    const cats = ['Barchasi', ...CATEGORIES];
    const nav = document.getElementById('marketCategoryNav');
    if (nav) {
        const toggle = nav.querySelector('.market-category-toggle');
        nav.innerHTML = '';
        if (toggle) nav.appendChild(toggle);
        nav.insertAdjacentHTML('beforeend', cats.slice(0, 8).map(c => `<button type="button" class="market-nav-category ${(!shopCat && c === 'Barchasi') || shopCat === c ? 'active' : ''}" onclick='filterShopCat(${JSON.stringify(c)}, this)'><i class="fas ${categoryFaIcon(c)}"></i><span>${escapeHTML(c)}</span></button>`).join(''));
    }

    tabs.innerHTML = cats.map(c => {
        const count = c === 'Barchasi' ? products.length : products.filter(p => p.cat === c).length;
        return `<button type="button" class="cat-tab ${(!shopCat && c === 'Barchasi') || shopCat === c ? 'active' : ''}" data-cat="${escapeHTML(c)}" onclick='filterShopCat(${JSON.stringify(c)}, this)'>
            <i class="fas ${categoryFaIcon(c)}"></i>
            <span>${escapeHTML(c)}</span>
            <span style="margin-left:auto;font-size:10px;opacity:.7">${count}</span>
        </button>`;
    }).join('');

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

    const emptyHTML = '<div style="text-align:center;padding:60px;color:var(--muted);grid-column:1/-1"><div style="font-size:48px;margin-bottom:16px;opacity:.3">🔍</div><p>Mahsulot topilmadi</p></div>';
    grid.innerHTML = list.map(p => shopProductCardHTML(p)).join('') || emptyHTML;

    // "Aksiya mahsulotlari" bo'limi — chegirmasi eng katta mahsulotlar
    const dealGrid = document.getElementById('marketDealGrid');
    if (dealGrid) {
        const deals = list.slice()
            .sort((a, b) => shopDiscountPct(b.id) - shopDiscountPct(a.id))
            .slice(0, 12);
        dealGrid.innerHTML = deals.map(p => shopProductCardHTML(p)).join('') || emptyHTML;
    }
    updateShopCart();
}

function filterShopCat(cat, el) {
    shopCat = cat === 'Barchasi' ? '' : cat;
    document.querySelectorAll('#shopCatSidebarList .cat-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    renderShop();
}

function shopFallbackImage(category) {
    const images = {
        'Muzlatgichlar': 'https://images.unsplash.com/photo-1571175432247-fe3702b899f1?auto=format&fit=crop&w=700&q=80',
        'Kir Yuvish Mashinalari': 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=700&q=80',
        'Konditsionerlar': 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=700&q=80',
        'Televizorlar': 'https://images.unsplash.com/photo-1593305841991-05c297ba4575?auto=format&fit=crop&w=700&q=80',
        'Changyutgichlar': 'https://images.unsplash.com/photo-1558317374-067fb5f30001?auto=format&fit=crop&w=700&q=80',
        'Pechlar': 'https://images.unsplash.com/photo-1578643463396-0997cb5328c1?auto=format&fit=crop&w=700&q=80',
        'Mikrotolqinli Pechlar': 'https://images.unsplash.com/photo-1574269909862-7e1d70bb8078?auto=format&fit=crop&w=700&q=80',
        'Aksessuarlar': 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=700&q=80'
    };
    return images[category] || 'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=700&q=80';
}

function closeProductDetail() {
    closeModal('productDetailModal');
}

function openProductDetails(id) {
    const product = products.find(p => p.id === id);
    const box = document.getElementById('productDetailContent');
    if (!product || !box) return;
    const image = productImageSrc(product.img) || shopFallbackImage(product.cat);
    const originalPrice = Math.round(product.price * 1.18);
    const rating = (4.5 + ((product.id * 3) % 5) * 0.1).toFixed(1);
    const monthly = Math.round(product.price / 12);
    box.innerHTML = `
        <div class="product-detail-gallery">
            <div class="product-detail-badge"><i class="fas fa-check"></i> Original mahsulot</div>
            <img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}" onerror="this.src='${shopFallbackImage(product.cat)}'">
        </div>
        <div class="product-detail-info">
            <span class="product-detail-category">${escapeHTML(product.cat)}</span>
            <h2 id="productDetailName">${escapeHTML(product.name)}</h2>
            <div class="product-detail-rating"><i class="fas fa-star"></i><strong>${rating}</strong><span>${product.id * 7 + 12} ta sharh</span></div>
            <div class="product-detail-stock"><span class="dot"></span> Omborda ${product.stock} ta mavjut</div>
            <p class="product-detail-description">${escapeHTML(product.desc || 'Texno Park N1 kafolati bilan original va ishonchli mahsulot. Buyurtmadan oldin barcha texnik xususiyatlari tekshiriladi.')}</p>
            <div class="product-detail-pricing"><span>${fmt(product.price)} so'm</span><del>${fmt(originalPrice)} so'm</del><small>${fmt(monthly)} so'm / oyiga</small></div>
            <div class="product-detail-actions"><button type="button" class="market-primary-action" onclick="addProductDetailsToCart(${product.id})"><i class="fas fa-cart-plus"></i> Savatga qo'shish</button><button type="button" class="market-secondary-action" onclick="addProductDetailsToCart(${product.id}); showCartView()"><i class="fas fa-bolt"></i> Hozir xarid qilish</button></div>
            <div class="product-detail-services"><span><i class="fas fa-shield-check"></i> 12 oy kafolat</span><span><i class="fas fa-truck-fast"></i> Tez yetkazish</span><span><i class="fas fa-credit-card"></i> Bo'lib to'lash</span></div>
        </div>`;
    openModal('productDetailModal');
}

function addProductDetailsToCart(id) {
    addToShopCart(id);
    closeProductDetail();
}

function addToShopCart(id) {
    if (['admin', 'cashier', 'manager'].includes(currentUser?.role)) {
        playError();
        showNotif('info', 'Ko\'rish rejimi', 'Xodim sifatida sotuv uchun Kassa (POS) dan foydalaning');
        return;
    }
    const p = products.find(x => x.id === id);
    if (!p || p.stock <= 0) { playError(); showNotif('error', 'Xato!', 'Mahsulot qolmadi'); return; }
    const ex = shopCart.find(x => x.id === id);
    if (ex) {
        if (ex.qty >= p.stock) { playError(); showNotif('error', 'Yetarli emas!', 'Qoldiq tugadi'); return; }
        ex.qty++;
    } else {
        shopCart.push({ id: p.id, name: p.name, price: p.price, qty: 1, img: p.img, cat: p.cat, cost: p.cost });
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
    if (['admin', 'cashier', 'manager'].includes(currentUser?.role)) return;
    const catalog = document.getElementById('shopCatalogView');
    const layout = document.querySelector('#page-shop .market-layout');
    const cart = document.getElementById('shopCartView');
    if (catalog) catalog.style.display = 'none';
    if (layout) layout.style.display = 'none';
    if (cart) {
        cart.style.display = 'block';
        updateShopCart();
    }
    syncMarketBottomNav('cart');
}

function showCatalogView() {
    const catalog = document.getElementById('shopCatalogView');
    const layout = document.querySelector('#page-shop .market-layout');
    const cart = document.getElementById('shopCartView');
    if (catalog) catalog.style.display = 'block';
    if (layout) layout.style.display = 'grid';
    if (cart) cart.style.display = 'none';
    renderShop();
    syncMarketBottomNav('home');
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
    const cartBadge = document.getElementById('marketCartCount');
    if (cartBadge) cartBadge.textContent = count;
    const bottomBadge = document.getElementById('marketBottomCartCount');
    if (bottomBadge) bottomBadge.textContent = count;
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
            <div class="product-card shop-product-card" onclick="openProductDetails(${p.id})">
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
                        <button type="button" class="product-add-btn" onclick="(event||window.event).stopPropagation(); addToShopCart(${p.id}); showNotif('success', 'Savatga qo\\'shildi', '${jsStrAttr(p.name)}')" style="background:var(--primary);color:white;width:32px;height:32px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.2s"><i class="fas fa-plus"></i></button>
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
    const saleId = nextSaleId();
    const shopItems = JSON.parse(JSON.stringify(shopCart)).map(ci => {
        const p = products.find(x => x.id === ci.id);
        return { ...ci, cost: (ci.cost || p?.cost || 0) };
    });
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
        customerPhone: phone || '',
        branchId: (typeof activeBranch !== 'undefined' && activeBranch?.id) ? String(activeBranch.id) : '',
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
    const branch = selectedBranch();
    const list = posFilteredBase().filter(p => (!posCat || p.cat === posCat));
    const sortVal = document.getElementById('posSort')?.value || '';
    if (sortVal === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortVal === 'price-asc') list.sort((a, b) => a.price - b.price);
    else if (sortVal === 'price-desc') list.sort((a, b) => b.price - a.price);
    else if (sortVal === 'stock') list.sort((a, b) => a.stock - b.stock);
    const foundEl = document.getElementById('posFound');
    if (foundEl) foundEl.textContent = list.length + ' ta mahsulot';
    const icons = { 'Muzlatgichlar': '❄️', 'Kir Yuvish Mashinalari': '🫧', 'Konditsionerlar': '💨', 'Televizorlar': '📺', 'Changyutgichlar': '🌀', 'Pechlar': '🔥', 'Mikrotolqinli Pechlar': '📡', 'Aksessuarlar': '🔌' };
    el.innerHTML = list.map(p => {
        const imgSrc = productImageSrc(p.img);
        return `
    <div class="product-card${p.stock <= 0 ? ' out' : ''}" data-pid="${p.id}" onclick="addToCart(${p.id})">
      <span class="in-cart-badge"></span>
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
        ${branch ? '<div class="product-card-branch"><i class="fas fa-map-location-dot"></i> ' +
                escapeHTML(branch.name) + '</div>' : ''}
        <button type="button" class="product-add-btn" onclick="(event||window.event).stopPropagation(); addToCart(${p.id})">+</button>
      </div>
    </div>
  `;
    }).join('') || '<div style="text-align:center;padding:60px;color:var(--muted);grid-column:1/-1"><div style="font-size:48px;margin-bottom:16px;opacity:.3">🔍</div><p>Mahsulot topilmadi</p></div>';
    if (typeof posAfterCartUpdate === 'function') posAfterCartUpdate();
}

function updateCustomerDropdown() {
    const sel = document.getElementById('cartCustomer');
    if (!sel) return;
    sel.innerHTML = '<option value="">Mijoz tanlanmagan</option>' +
        customers.map(c => `<option value="${Number(c.id)}">${escapeHTML(c.name)} (${escapeHTML(c.phone)})</option>`).join('');
    posApplyPendingCustomer();
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
        cart.push({ id: p.id, name: p.name, price: p.price, qty: 1, img: p.img, cat: p.cat, cost: p.cost });
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
    updateCartCore();
    posAfterCartUpdate();
}

function updateCartCore() {
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

// ============================================================
// KASSA YORDAMCHILARI: qaytim, kutish, mobil savat, tezkor chegirma
// ============================================================
function posCurrentTotal() {
    const disc = Math.min(100, Math.max(0, parseFloat(document.getElementById('discountInput')?.value) || 0));
    const subtotal = cart.reduce((s, x) => s + x.price * x.qty, 0);
    return Math.max(0, subtotal - subtotal * disc / 100);
}

function posSetDiscount(pct) {
    const di = document.getElementById('discountInput');
    if (di) di.value = pct ? String(pct) : '';
    updateCart();
}

function posQuickCash(v) {
    const input = document.getElementById('posReceived');
    if (!input) return;
    input.value = v === 'exact' ? String(Math.round(posCurrentTotal())) : String(v);
    posUpdateChange();
}

function posUpdateChange() {
    const total = posCurrentTotal();
    const recv = Math.max(0, Number(document.getElementById('posReceived')?.value) || 0);
    const label = document.getElementById('posChangeLabel');
    const out = document.getElementById('posChange');
    if (!out) return;
    if (!recv) { out.textContent = '0 so\'m'; out.className = ''; if (label) label.textContent = 'Qaytim'; return; }
    const diff = recv - total;
    if (diff >= 0) { out.textContent = fmt(Math.round(diff)) + ' so\'m'; out.className = 'ok'; if (label) label.textContent = 'Qaytim'; }
    else { out.textContent = fmt(Math.round(-diff)) + ' so\'m'; out.className = 'bad'; if (label) label.textContent = 'Yetishmaydi'; }
}

// ---- Mobil kassa: savat drawer'i (bottom sheet) ----
// Ochish/YOPISh faqat bitta yo'ldan o'tadi: posToggleSheet(). Esc (global
// listener), savat bo'sh holat, sahifadan chiqish va KENGLIK mobil
// diapazondan chiqish — hammasi shu funksiyani chaqiradi (parallel
// mexanizm yaratilmagan, tugmada takroriy listener yo'q).
const POS_DRAWER_MQ = '(max-width: 768px)';

function posIsMobileLayout() {
    try { return window.matchMedia(POS_DRAWER_MQ).matches; } catch (e) { return false; }
}

function posToggleSheet(open) {
    const panel = document.querySelector('#page-pos .pos-right');
    const scrim = document.getElementById('posCartScrim');
    const bar = document.getElementById('posMobileBar');
    const posPage = document.getElementById('page-pos');
    const onPos = !!(posPage && posPage.classList.contains('active'));
    // Desktopda drawer yo'q: `.pos-right` odatdagidek ustunda turadi,
    // shuning uchun holat faqat mobil + KASSA sahifasi ochiq bo'lganda o'zgaradi.
    const willOpen = !!open && posIsMobileLayout() && onPos;
    if (panel) panel.classList.toggle('sheet-open', willOpen);
    if (scrim) scrim.classList.toggle('show', willOpen);
    if (bar) bar.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    document.body.classList.toggle('pos-cart-lock', willOpen);
    return willOpen;
}

// Mobil → desktop kenglik o'zgarsa drawer yopiladi (body qulfi qolmaydi)
try {
    const _posMq = window.matchMedia(POS_DRAWER_MQ);
    const _posMqChange = () => { if (!_posMq.matches) posToggleSheet(false); };
    if (typeof _posMq.addEventListener === 'function') _posMq.addEventListener('change', _posMqChange);
    else if (typeof _posMq.addListener === 'function') _posMq.addListener(_posMqChange);
} catch (e) { }

// ---- Kassa savatining sessiya holati (sahifani yangilashda tiklanadi) ----
// YAGONA manba: `cart` massivi. Bu yerda ikkinchi nusxa yaratilmaydi —
// faqat xotiraga ko'chiriladi/undan qaytariladi.
var POS_CART_KEY = 'tp_pos_cart';
// `var` bilan e'lon qilingan: updateCustomerDropdown() skriptning boshida
// (hoisting davrida) chaqirilsa ham TDZ xatosi bo'lmaydi.
var posCartStateRestored = false;
var posPendingCustomer = '';

function posCartOwnerKey() {
    return (currentUser && (currentUser.role || '')) + '|' + (currentUser && (currentUser.name || ''));
}

function posClearCartState() {
    try { sessionStorage.removeItem(POS_CART_KEY); } catch (e) { }
    posCartStateRestored = false;
    posPendingCustomer = '';
}

function posSaveCartState() {
    // Saqlash faqat tiklash urinishidan keyin boshlanadi: aks holda ilova
    // ochilishi bilan bo'sh savat yozilib, yangilashdan oldingi holat yo'qoladi.
    if (!posCartStateRestored) return;
    try {
        sessionStorage.setItem(POS_CART_KEY, JSON.stringify({
            u: posCartOwnerKey(),
            t: Date.now(),
            cart: cart,
            disc: document.getElementById('discountInput')?.value || '',
            cust: document.getElementById('cartCustomer')?.value || '',
            promo: document.getElementById('posPromoCode')?.value || ''
        }));
    } catch (e) { /* xotira bloklangan bo'lsa — jim o'tamiz */ }
}

/** Mijoz select'i qayta to'ldirilganda kutilayotgan mijozni qayta tiklaydi. */
function posApplyPendingCustomer() {
    if (!posPendingCustomer) return;
    const sel = document.getElementById('cartCustomer');
    if (!sel) return;
    if (Array.from(sel.options || []).some(o => o.value === posPendingCustomer)) {
        sel.value = posPendingCustomer;
        posPendingCustomer = '';
    }
}

function posRestoreCartState() {
    if (posCartStateRestored) return false;
    if (!Array.isArray(products) || !products.length) return false; // hali yuklanmagan — keyin qayta uriniladi
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(POS_CART_KEY) || 'null'); } catch (e) { s = null; }
    if (!s || !Array.isArray(s.cart) || !s.cart.length) { posCartStateRestored = true; return false; }
    // Boshqa xodimning savati qayta tiklanmasin
    if (s.u && s.u !== posCartOwnerKey()) { posCartStateRestored = true; posClearCartState(); return false; }
    posCartStateRestored = true;
    const restored = [];
    s.cart.forEach(it => {
        if (!it) return;
        const p = products.find(x => x.id === it.id);
        if (!p) return; // mahsulot o'chirilgan
        const stock = Number(p.stock) || 0;
        if (stock <= 0) return; // qoldiq tugagan
        const qty = Math.max(1, Math.min(Number(it.qty) || 1, stock));
        restored.push({ id: p.id, name: p.name, price: p.price, qty, img: p.img, cat: p.cat, cost: p.cost });
    });
    if (!restored.length) return false;
    cart = restored;
    const di = document.getElementById('discountInput');
    if (di && s.disc !== undefined && s.disc !== null) di.value = s.disc;
    const pr = document.getElementById('posPromoCode');
    if (pr && typeof s.promo === 'string') pr.value = s.promo;
    posPendingCustomer = typeof s.cust === 'string' ? s.cust : '';
    updateCustomerDropdown(); // ichida posApplyPendingCustomer() chaqiriladi
    posApplyPendingCustomer();
    updateCart();
    showNotif('info', 'Savat tiklandi', 'Sahifani yangilashdan oldingi savat qaytarildi');
    return true;
}

/** Har bir savat o'zgarishidan keyin: badge, tugma, mobil panel, qaytim. */
function posAfterCartUpdate() {
    const total = posCurrentTotal();
    const count = cart.reduce((s, x) => s + x.qty, 0);
    const qtyById = {};
    cart.forEach(x => { qtyById[x.id] = x.qty; });
    document.querySelectorAll('#productGrid .product-card[data-pid]').forEach(card => {
        const q = qtyById[card.getAttribute('data-pid')] || 0;
        card.classList.toggle('in', q > 0);
        const b = card.querySelector('.in-cart-badge');
        if (b) b.textContent = q ? '×' + q : '';
    });
    uiSetText('posMobileCount', String(count));
    uiSetText('posMobileTotal', fmt(total) + ' so\'m');
    const btn = document.getElementById('posCheckoutBtn');
    if (btn) btn.disabled = cart.length === 0;
    uiSetText('posCheckoutLabel', cart.length ? 'To\'lov: ' + fmt(total) + ' so\'m (F2)' : 'To\'lov qabul qilish (F2)');
    const cash = document.getElementById('posCashPanel');
    if (cash) cash.classList.toggle('show', payType === 'cash' && cart.length > 0);
    if (!cart.length) { const r = document.getElementById('posReceived'); if (r) r.value = ''; posToggleSheet(false); }
    posSaveCartState();
    posUpdateChange();
}

// ---- Savatni kutishga qo'yish ----
let posHeld = (function () {
    try { const v = JSON.parse(localStorage.getItem('tp_pos_held') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
})();
function posSaveHeld() { try { localStorage.setItem('tp_pos_held', JSON.stringify(posHeld)); } catch (e) { } renderPosHeld(); }

function posHoldCart() {
    if (!cart.length) { playError(); showNotif('warning', 'Savat bo\'sh', 'Kutishga qo\'yadigan mahsulot yo\'q'); return; }
    posHeld.push({
        id: Date.now(),
        items: JSON.parse(JSON.stringify(cart)),
        disc: document.getElementById('discountInput')?.value || '',
        customer: document.getElementById('cartCustomer')?.value || '',
        time: new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })
    });
    cart = [];
    const di = document.getElementById('discountInput'); if (di) di.value = '';
    posSaveHeld(); updateCart();
    showNotif('info', 'Kutishga qo\'yildi', 'Savat saqlandi — keyin davom ettirishingiz mumkin');
}

function posResumeHeld(id) {
    const i = posHeld.findIndex(h => h.id === id);
    if (i < 0) return;
    if (cart.length) { playError(); showNotif('warning', 'Savat band', 'Avval joriy savatni kutishga qo\'ying yoki tozalang'); return; }
    const h = posHeld[i];
    // faqat hozir mavjud mahsulotlar qaytariladi
    cart = h.items.filter(it => products.some(p => p.id === it.id));
    const di = document.getElementById('discountInput'); if (di) di.value = h.disc;
    const cs = document.getElementById('cartCustomer'); if (cs) cs.value = h.customer;
    posHeld.splice(i, 1);
    posSaveHeld(); updateCart();
}

function posDropHeld(id) {
    posHeld = posHeld.filter(h => h.id !== id);
    posSaveHeld();
}

function renderPosHeld() {
    const box = document.getElementById('posHeldList');
    if (!box) return;
    box.innerHTML = posHeld.map((h, i) => `<span class="held">
        <button type="button" onclick="posResumeHeld(${h.id})" title="Davom ettirish"><i class="fas fa-play"></i> #${i + 1} · ${h.items.reduce((s, x) => s + x.qty, 0)} ta · ${escapeHTML(h.time)}</button>
        <button type="button" onclick="posDropHeld(${h.id})" title="O'chirish"><i class="fas fa-times"></i></button></span>`).join('');
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
    posAfterCartUpdate();
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

// Ikki marta bosishdan himoya: savdo serverga yuborilayotganda qayta ishga
// tushmasin (aks holda ikkinchi so'rov qoldiqni takror tekshiradi).
let _checkoutInFlight = false;

/**
 * POS savdoni SERVERDA tasdiqlaydi va ombor qoldig'ini kamaytiradi (/api/sell).
 * Natija: { ok, sale, productStocks, duplicate } yoki
 * { ok:false, offline:true|false, status, message }.
 */
async function postSaleToServer(sale) {
    if (!staffToken) {
        return { ok: false, offline: true, status: 0, message: 'Xodim sessiyasi yo\'q' };
    }
    const payload = {
        id: sale.id,
        items: (sale.items || []).map(i => ({
            id: i.id, name: i.name, qty: i.qty, price: i.price,
            cost: i.cost, img: i.img, barcode: i.barcode,
            ikpu: i.ikpu, packageCode: i.packageCode, vatPercent: i.vatPercent
        })),
        branchId: sale.branchId,
        customer: sale.customer,
        customerId: sale.customerId,
        customerPhone: sale.customerPhone,
        pay: sale.pay,
        provider: sale.provider,
        subtotal: sale.subtotal,
        disc: sale.disc,
        discAmt: sale.discAmt,
        total: sale.total,
        date: sale.date,
        time: sale.time,
        isOnline: false
    };
    try {
        const res = await fetchWithTimeout('/api/sell', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        }, SYNC_TIMEOUT_MS);
        const data = await res.json().catch(() => null);
        if (res.status === 401) {
            return { ok: false, offline: false, status: 401, message: data?.message || 'Sessiya tugadi — qaytadan tizimga kiring' };
        }
        if (!res.ok) {
            return { ok: false, offline: false, status: res.status, message: data?.message || ('Server xatosi (HTTP ' + res.status + ')') };
        }
        if (!data || data.status !== 'success') {
            return { ok: false, offline: false, status: res.status, message: data?.message || 'Server savdoni tasdiqlamadi' };
        }
        return { ok: true, sale: data.sale, productStocks: data.productStocks || [], duplicate: !!data.duplicate };
    } catch (e) {
        console.warn('POS savdo serverga yuborilmadi:', e);
        return { ok: false, offline: true, status: 0, message: e?.message || 'Serverga ulanib bo\'lmadi' };
    }
}

/** Server javobidagi qoldiqlarni lokal `products` massiviga qo'llaydi. */
function applyServerStocks(productStocks) {
    (productStocks || []).forEach(ps => {
        const p = products.find(x => String(x.id) === String(ps.id));
        if (p) p.stock = Math.max(0, Number(ps.stock) || 0);
    });
}

async function checkout() {
    if (!requireRole('admin', 'cashier', 'manager')) return;
    if (_checkoutInFlight) return;
    if (cart.length === 0) { playError(); showNotif('error', 'Savat bo\'sh!', 'Mahsulot qo\'shing'); return; }

    // Sotuvdan OLDIN qoldiq qayta tekshiriladi: savat tuzilgandan beri
    // qoldiq kamaygan bo'lsa (boshqa qurilmada sotuv yoki tahrir) yoki
    // mahsulot o'chirilgan bo'lsa — sotuv rad etiladi, ombor kamaymaydi.
    for (const ci of cart) {
        const cur = products.find(x => x.id === ci.id);
        if (!cur) {
            playError();
            showNotif('error', 'Sotuv rad etildi', `${ci.name} — mahsulot ro'yxatdan olib tashlangan`);
            return;
        }
        if ((Number(cur.stock) || 0) < ci.qty) {
            playError();
            showNotif('error', 'Yetarli qoldiq yo\'q', `${ci.name} — qoldiq: ${cur.stock}, savatda: ${ci.qty}`);
            return;
        }
    }

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

    const saleId = nextSaleId();
    const sale = {
        id: saleId, items: JSON.parse(JSON.stringify(cart)),
        subtotal, disc, discAmt, total,
        pay: provider.label,
        provider: providerId,
        time: new Date().toLocaleTimeString('uz-UZ'),
        date: new Date().toLocaleDateString('uz-UZ'),
        cashier: currentUser?.name || 'Noma\'lum',
        cashierLogin: currentUser?.login || '',
        customer: cust?.name || 'Noma\'lum',
        customerId: custId || null,
        customerPhone: cust?.phone || '',
        branchId: (typeof getActiveBranch === 'function' && getActiveBranch())
            ? String(getActiveBranch().id) : '',
        credit: providerId === 'credit' ? readCreditInfo() : null,
        status: isOnline ? 'pending' : 'paid'
    };

    // ── Onlayn to'lov yo'li (to'lov shlyuzi tasdiqlagach ombor yangilanadi) ──
    if (isOnline) {
        salesHistory.push(sale);
        lastCheckoutSale = sale;
        saveToStorage();
        addLog('Savdo', `Chek #${saleId} — ${fmt(total)} so'm (${provider.label})`);
        playCheckout();
        clearCart();
        loadDashboard();
        renderProductGrid();
        showNotif('info', 'To\'lov kutilmoqda', `${fmt(total)} so'm — ${provider.label}`);
        PaymentGateway.start(sale, providerId);
        return;
    }

    // ── Naqd/karta: savdo SERVERDA tasdiqlanadi va ombor serverda kamayadi ──
    if (sale.branchId) {
        _checkoutInFlight = true;
        let result;
        try {
            result = await postSaleToServer(sale);
        } finally {
            _checkoutInFlight = false;
        }

        if (result.ok) {
            const confirmed = result.sale || sale;
            // Server tasdiqlagan qoldiq darhol interfeysga qo'llanadi
            applyServerStocks(result.productStocks);
            if (!salesHistory.some(s => String(s.id) === String(confirmed.id))) {
                salesHistory.push(confirmed);
            }
            lastCheckoutSale = confirmed;
            if (cust) {
                cust.orders++;
                cust.total += total;
                cust.bonus += Math.floor(total / 10000);
            }
            saveToStorage();
            addLog('Savdo', `Chek #${confirmed.id} — ${fmt(total)} so'm (${provider.label})`);
            playCheckout();
            renderReceipt(confirmed);
            openModal('checkoutModal');
            clearCart();
            loadDashboard();
            renderProductGrid();
            renderProducts();       // Mahsulotlar jadvali qoldig'i darhol yangilanadi
            renderWarehousePage();
            // Shartnoma AVTOMATIK tuzilmaydi — administrator «Shartnomalar» bo'limida
            // «Qo'lda shartnoma» yoki «Cheklardan import» orqali o'zi tuzadi.
            showNotif('success', '✅ To\'lov qabul qilindi!', `${fmt(total)} so'm — ${provider.label}`);
            finishPaidSale(confirmed);
            return;
        }

        if (result.status === 401) {
            playError();
            showNotif('error', 'Sessiya tugadi', result.message || 'Qaytadan tizimga kiring');
            handleSessionExpired();
            return;
        }

        // Server savdoni RAD ETDI (qoldiq yetarli emas, filial mos emas va h.k.)
        // — ombor o'zgarmaydi, savdo saqlanmaydi.
        if (!result.offline) {
            playError();
            showNotif('error', 'Savdo rad etildi', result.message || 'Server savdoni qabul qilmadi');
            return;
        }
        // ── Tarmoq uzildi: oflayn zaxira (keyinroq sinxronlanadi) ──
        salesHistory.push(sale);
        lastCheckoutSale = sale;
        cart.forEach(ci => {
            const p = products.find(x => x.id === ci.id);
            if (p) p.stock = Math.max(0, p.stock - ci.qty);
        });
        if (cust) {
            cust.orders++;
            cust.total += total;
            cust.bonus += Math.floor(total / 10000);
        }
        saveToStorage();
        addLog('Savdo', `Chek #${saleId} — ${fmt(total)} so'm (${provider.label})`);
        playCheckout();
        renderReceipt(sale);
        openModal('checkoutModal');
        clearCart();
        loadDashboard();
        renderProductGrid();
        renderProducts();
        showNotif('warning', 'Oflayn saqlandi',
            'Serverga ulanib bo\'lmadi — savdo qurilmada saqlandi va aloqa tiklanganda yuboriladi');
        finishPaidSale(sale);
        return;
    }

    // ── Filial sozlanmagan holat: lokal kamaytirish + sinxronizatsiya ──
    salesHistory.push(sale);
    lastCheckoutSale = sale;
    cart.forEach(ci => {
        const p = products.find(x => x.id === ci.id);
        if (p) p.stock = Math.max(0, p.stock - ci.qty);
    });
    if (cust) {
        cust.orders++;
        cust.total += total;
        cust.bonus += Math.floor(total / 10000);
    }
    saveToStorage();
    addLog('Savdo', `Chek #${saleId} — ${fmt(total)} so'm (${provider.label})`);
    playCheckout();
    renderReceipt(sale);
    openModal('checkoutModal');
    clearCart();
    loadDashboard();
    renderProductGrid();
    renderProducts();
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
                <a href="javascript:void(0)" onclick="openClickPopup('${jsStrAttr(clickUrl)}')" class="btn" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;background:#00a2eb;color:white;border:none;padding:12px 24px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px;box-shadow:0 4px 10px rgba(0,162,235,0.2);transition:all 0.2s">
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
let productLoadState = 'ready';

function renderProducts() {
    // Filtrda doim barcha kategoriyalar turadi (doimiy ro'yxat)
    const allCategories = [...new Set([...CATEGORIES, ...products.map(p => p.cat).filter(Boolean)])];
    const sel = document.getElementById('catFilter');
    if (sel) {
        sel.innerHTML = '<option value="">Barcha</option>' + allCategories
            .map(c => `<option value="${escapeHTML(c)}"${currentCategory === c ? ' selected' : ''}>${escapeHTML(c)}</option>`)
            .join('');
    }

    // Mobil statistika chip'lari (Jami mahsulot, Kam qoldi, Tugagan)
    const lowStockCount = products.filter(p => Number(p.stock) > 0 && Number(p.stock) < 5).length;
    const outStockCount = products.filter(p => Number(p.stock) <= 0).length;
    uiSetHtml('productsChips', `
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-blue"><i class="fas fa-cube"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${products.length}</div>
        <div class="tpm-chip-l">Jami mahsulot</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-yellow"><i class="fas fa-box"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${lowStockCount}</div>
        <div class="tpm-chip-l">Kam qoldi</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-red"><i class="fas fa-triangle-exclamation"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${outStockCount}</div>
        <div class="tpm-chip-l">Tugagan</div>
      </div>
    </div>`);

    // Mobil kategoriya pill'lari (gorizontal suriladigan)
    uiSetHtml('productsPills', [{ name: '', label: 'Barchasi' }].concat(allCategories.map(c => ({ name: c, label: c })))
        .map(c => `<button type="button" role="tab" class="tpm-pill${currentCategory === c.name ? ' active' : ''}"
            aria-pressed="${currentCategory === c.name}" onclick="filterByCategory('${escapeHTML(c.name)}')">${escapeHTML(c.label)}</button>`).join(''));

    const cnt = document.getElementById('productCount');
    const table = document.getElementById('productsTable');
    if (!table) return;

    const canEditProduct = isBoss() || requireRoleSilent('admin', 'manager');
    const canDeleteProduct = isBoss() || requireRoleSilent('admin');
    const list = products.filter(p =>
        (!currentCategory || p.cat === currentCategory) &&
        (!productFilter2 || p.name.toLowerCase().includes(productFilter2.toLowerCase()))
    );
    if (cnt) cnt.textContent = list.length;
    const icons = CATEGORY_EMOJI;

    const rows = [];
    const cards = [];
    list.forEach(p => {
        const imgSrc = productImageSrc(p.img);
        const branch = getBranchById(p.branchId);
        const cost = Number(p.cost) || 0;
        const priceNum = Number(p.price) || 0;
        const profitUnit = priceNum - cost;
        // Ustama (tannarxga nisbatan) va foyda marjasi (sotuv narxiga nisbatan)
        // — ikki xil ko'rsatkich, chalkashmasligi uchun alohida yorliq bilan.
        const markupPct = cost > 0 ? (profitUnit / cost) * 100 : null;
        const marginPct = priceNum > 0 ? (profitUnit / priceNum) * 100 : null;
        rows.push(`<tr>
    <td data-label="Rasm">
      ${imgSrc
                ? `<img src="${escapeHTML(imgSrc)}" style="width:46px;height:36px;border-radius:8px;object-fit:cover;background:var(--border)" onerror="this.style.display='none'">`
                : `<div style="width:46px;height:36px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:20px">${icons[p.cat] || '📦'}</div>`}
    </td>
    <td data-label="Nomi"><strong>${escapeHTML(p.name)}</strong>${p.ikpu ? '' : ' <span class="badge badge-red" title="Fiskal chek chiqmaydi">IKPU yo\'q</span>'}<br><small style="color:var(--muted)">${escapeHTML(p.desc || '')}</small></td>
    <td data-label="Kategoriya"><span class="badge badge-blue" title="${escapeHTML(p.cat)}">${escapeHTML(p.cat)}</span></td>
    <td data-label="Filial">${branch
                ? '<span class="badge" title="' + escapeHTML(branch.name) + '" style="background:' + escapeHTML(branch.markerColor) + '22;color:' + escapeHTML(branch.markerColor) + '">' + escapeHTML(branch.markerIcon + ' ' + branch.name) + '</span>'
                : '<span class="badge" style="opacity:.7">Umumiy</span>'}</td>
    <td data-label="Narxi" style="font-weight:700;color:var(--primary)">${fmt(p.price)} so'm</td>
    <td data-label="Tannarx">${p.cost > 0 ? fmt(p.cost) + " so'm" : '<span style="color:var(--muted)">—</span>'}</td>
    <td data-label="Foyda">${cost > 0
                ? `<span class="foyda-val" style="color:${profitUnit >= 0 ? '#10b981' : '#ef4444'}">${fmt(profitUnit)} so'm</span>`
                + `<small class="foyda-meta">Ustama: ${markupPct.toFixed(1)}%</small>`
                + (marginPct !== null ? `<small class="foyda-meta">Marja: ${marginPct.toFixed(1)}%</small>` : '')
                : '<span style="color:var(--muted)">—</span>'}</td>
    <td data-label="Qoldiq"><span class="${p.stock < 5 ? 'badge badge-red' : 'badge badge-green'}">${p.stock} dona</span></td>
    <td data-label="Holati"><span class="badge ${p.stock > 0 ? 'badge-green' : 'badge-red'}">${p.stock > 0 ? 'Bor' : 'Tugagan'}</span></td>
    <td data-label="Amallar" class="product-actions-td">
      ${canEditProduct ? `<button type="button" class="btn btn-outline btn-sm" title="Tahrirlash" aria-label="${escapeHTML(p.name)} mahsulotini tahrirlash" onclick="openProductModalWithEvent(event, ${Number(p.id)})"><i class="fas fa-edit"></i></button>` : ''}
      ${canDeleteProduct ? `<button type="button" class="btn btn-danger btn-sm" title="O'chirish" aria-label="${escapeHTML(p.name)} mahsulotini o'chirish" onclick="deleteProductWithEvent(event, ${Number(p.id)})"><i class="fas fa-trash"></i></button>` : ''}
    </td>
  </tr>`);
        cards.push(productCardHtml(p, { imgSrc, branch, cost, profitUnit, canEditProduct, canDeleteProduct, icons }));
    });
    table.innerHTML = rows.join('');
    uiSetHtml('productsMobileList', cards.join('') || productMobileEmptyHtml());
    if (list.length) return;

    if (productLoadState === 'loading') {
        table.innerHTML = '<tr><td colspan="10" class="products-empty-state" role="status"><i class="fas fa-spinner fa-spin"></i> Mahsulotlar yuklanmoqda...</td></tr>';
    } else if (productLoadState === 'error') {
        table.innerHTML = '<tr><td colspan="10" class="products-empty-state" role="alert">Mahsulotlarni yuklab bo\'lmadi. <button type="button" class="btn btn-outline btn-sm" onclick="loadFromBackend()">Qayta urinish</button></td></tr>';
    } else if (products.length && (currentCategory || productFilter2)) {
        table.innerHTML = '<tr><td colspan="10" class="products-empty-state">Filtrga mos mahsulot topilmadi.</td></tr>';
    } else {
        table.innerHTML = '<tr><td colspan="10" class="products-empty-state">Hali mahsulot yo\'q — “Yangi Mahsulot” tugmasi bilan qo\'shing.</td></tr>';
    }
}

/** Mahsulotlar ro'yxati bo'sh bo'lganda mobil karta ro'yxatining holati (jadval xabarlari bilan bir xil). */
function productMobileEmptyHtml() {
    if (productLoadState === 'loading') {
        return '<div class="tpm-empty" role="status"><i class="fas fa-spinner fa-spin"></i> Mahsulotlar yuklanmoqda...</div>';
    }
    if (productLoadState === 'error') {
        return '<div class="tpm-empty" role="alert">Mahsulotlarni yuklab bo\'lmadi. <button type="button" class="btn btn-outline btn-sm" onclick="loadFromBackend()">Qayta urinish</button></div>';
    }
    if (products.length && (currentCategory || productFilter2)) {
        return '<div class="tpm-empty">Filtrga mos mahsulot topilmadi.</div>';
    }
    return '<div class="tpm-empty">Hali mahsulot yo\'q — “Yangi Mahsulot” tugmasi bilan qo\'shing.</div>';
}

/** Mahsulotning mobil karta HTML'i — referens dizaynga 100% mos rasmli premium kartochka */
function productCardHtml(p, ctx) {
    const imgSrc = ctx.imgSrc;
    const icons = ctx.icons || {};
    const stock = Number(p.stock) || 0;
    const stockTone = stock <= 0 ? 'tone-red' : stock < 5 ? 'tone-yellow' : 'tone-green';
    const stockLabel = stock <= 0 ? 'Tugagan' : stock < 5 ? 'Kam qoldi' : 'Bor';
    const spec = p.desc || p.model || '';

    return `
    <div class="tpm-card tpm-product-card" onclick="openProductModalWithEvent(event, ${Number(p.id)})">
      <div class="tpm-prod-main">
        <div class="tpm-prod-imgbox">
          ${imgSrc
                ? `<img src="${escapeHTML(imgSrc)}" alt="" class="tpm-prod-img" loading="lazy" onerror="this.style.display='none'">`
                : `<div class="tpm-prod-tile" aria-hidden="true">${icons[p.cat] || '📦'}</div>`}
        </div>
        <div class="tpm-prod-body">
          <div class="tpm-name">${escapeHTML(p.name)}</div>
          <div class="tpm-sub">${escapeHTML(p.cat || 'Umumiy')}</div>
          ${spec ? `<div class="tpm-spec">${escapeHTML(spec)}</div>` : ''}
        </div>
        <div class="tpm-prod-end">
          <div class="tpm-prod-top-actions">
            <span class="tpm-status-pill ${stockTone}">${stockLabel}</span>
            <button type="button" class="tpm-menu-btn" onclick="event.stopPropagation(); openProductModalWithEvent(event, ${Number(p.id)})" aria-label="Amallar">
              <i class="fas fa-ellipsis-vertical"></i>
            </button>
          </div>
          <div class="tpm-prod-price">${fmt(p.price)} so'm</div>
          <div class="tpm-prod-stock">${stock} dona</div>
        </div>
      </div>
    </div>`;
}

/**
 * Mahsulotlar sahifasini sahifani qayta yuklamasdan serverdan yangilaydi.
 * Tugma bosilganda yuklanish holati (spinner) ko'rsatiladi.
 */
async function refreshProducts(btn) {
    if (!staffToken) {
        showNotif('warning', 'Tizimga kiring', 'Ma\'lumotlarni yangilash uchun xodim sessiyasi kerak');
        return;
    }
    const icon = btn ? btn.querySelector('i') : null;
    const wasDisabled = btn ? btn.disabled : false;
    if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
    if (icon) icon.classList.add('fa-spin');
    try {
        const res = await fetchWithTimeout('/api/data', { headers: authHeaders(), cache: 'no-store' }, SYNC_TIMEOUT_MS);
        if (res.status === 401) { handleSessionExpired(); return; }
        if (!res.ok) throw new Error('Ma\'lumotlarni yuklab bo\'lmadi (HTTP ' + res.status + ')');
        const data = await res.json();
        if (!data || typeof data !== 'object') throw new Error('Server javobi noto\'g\'ri');
        serverOnline = true;
        catalogFallbackActive = false;
        productLoadState = 'ready';
        if (Array.isArray(data.products)) products = data.products.map(normalizeProduct);
        if (Array.isArray(data.branches)) {
            branches = data.branches.map(normalizeBranch).filter(Boolean);
            try { localStorage.setItem('tp_branches', JSON.stringify(branches)); } catch (e) { }
        }
        if (Array.isArray(data.sales)) salesHistory = data.sales.map(normalizeSale).filter(Boolean);
        try { localStorage.setItem('tp_products', JSON.stringify(products.map(productForCache))); } catch (e) { }
        try { localStorage.setItem('tp_sales', JSON.stringify(salesHistory)); } catch (e) { }
        renderProducts();
        renderProductGrid();
        renderWarehousePage();
        loadDashboard();
        const branchNote = (typeof isAllBranchesView === 'function' && isAllBranchesView())
            ? 'Barcha filiallar' : (getActiveBranch()?.name || 'Barcha filiallar');
        showNotif('success', 'Yangilandi', `${products.length} ta mahsulot · ${branchNote}`);
    } catch (e) {
        console.warn('Mahsulotlarni yangilashda xatolik:', e);
        showNotif('error', 'Yangilab bo\'lmadi', e?.message || 'Serverga ulanib bo\'lmadi');
    } finally {
        if (btn) { btn.disabled = wasDisabled; btn.classList.remove('is-loading'); }
        if (icon) icon.classList.remove('fa-spin');
    }
}

function filterByCategory(val) { currentCategory = val; renderProducts(); }
function filterProducts(q) { productFilter2 = q; renderProducts(); }
const debouncedFilterProducts = debounce(filterProducts, 300);

/* Kategoriya <select>'ini mavjud kategoriyalardan qayta quradi.
   Ilgari bu ro'yxat faqat HTML'dagi qotib qolgan nomlardan iborat edi va
   foydalanuvchi qo'shgan kategoriyalar mahsulot oynasida ko'rinmasdi. */
function fillProductCategorySelect(currentCat) {
    const sel = document.getElementById('p-cat');
    if (!sel) return;
    const cats = Array.isArray(CATEGORIES) ? CATEGORIES.slice() : [];
    const cur = currentCat || '';
    if (cur && !cats.some(c => c.toLowerCase() === cur.toLowerCase())) cats.push(cur);
    sel.innerHTML = cats.length
        ? cats.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('')
        : '<option value="">Avval kategoriya qo\'shing</option>';
    if (cur) sel.value = cur;
}

/* Filial (ombor) <select>'ini to'ldiradi — mahsulotni filialga bog'lash uchun. */
function fillProductBranchSelect(currentId) {
    const sel = document.getElementById('p-branchId');
    if (!sel) return;
    const list = Array.isArray(branches) ? branches : [];
    const cur = currentId != null ? String(currentId) : '';
    // Filialga biriktirilgan menejer/kassir YANGI mahsulotni faqat o'z
    // filialiga bog'laydi (umumiy ombor ham ruxsat). Tahrirlashda ro'yxat
    // to'liq qoladi — filial ko'chirishni server o'zi tekshiradi.
    const role = String(currentUser?.role || '').toLowerCase();
    const myBranch = String(currentUser?.branchId || '');
    const branchScoped = !cur && !!myBranch && (role === 'manager' || role === 'cashier');
    const visible = branchScoped ? list.filter(b => String(b.id) === myBranch) : list;
    sel.innerHTML = '<option value="">Umumiy ombor (filial tanlanmagan)</option>' +
        visible.map(b => `<option value="${escapeHTML(b.id)}">${escapeHTML(b.markerIcon + ' ' + b.name)}</option>`).join('');
    if (cur && list.some(b => String(b.id) === cur)) sel.value = cur;
    else if (!cur) {
        if (branchScoped) sel.value = myBranch;
        else { const act = getActiveBranch(); if (act && visible.some(b => String(b.id) === String(act.id))) sel.value = String(act.id); }
    }
}

function openProductModal(id) {
    const requestedId = id == null || id === '' ? null : Number(id);
    // Ruxsat siyosati: YANGI mahsulot — boshliq/admin/menejer/kassir;
    // MAVJUD mahsulotni tahrirlash — boshliq/admin/menejer. Kassir faqat
    // yangi kiritadi (o'chirish/tahrirlash uning doirasiga kirmaydi).
    if (requestedId == null) {
        if (!requireRole('admin', 'manager', 'cashier')) return;
    } else if (!isBoss() && !requireRoleSilent('admin', 'manager')) {
        playError();
        securityLog('access-denied', 'medium',
            `Mahsulot tahriri rad etildi: kerak [admin, manager], mavjud [${currentUser?.role || 'mehmon'}]`);
        showNotif('error', 'Ruxsat yo\'q!',
            currentUser?.role === 'cashier'
                ? 'Kassir faqat yangi mahsulot qo\'sha oladi — mavjud mahsulotni tahrirlash admin yoki menejer uchun'
                : 'Bu amal uchun huquq yetarli emas');
        return;
    }
    const found = requestedId == null ? null : products.find(x => Number(x.id) === requestedId);
    if (requestedId != null && !found) {
        showNotif('error', 'Mahsulot topilmadi', 'Tahrirlanadigan mahsulot ro\'yxatda yo\'q. Ro\'yxatni yangilang.');
        return;
    }
    editingProductId = found ? found.id : null;
    const editing = found;

    // Maydonlar mavjudligiga ishonch hosil qilamiz — yo'q maydon butun oynani buzmasin.
    const setVal = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v; };
    const title = document.getElementById('productModalTitle');
    if (title) title.textContent = editing ? 'Mahsulotni Tahrirlash' : 'Yangi Mahsulot';

    fillProductCategorySelect(editing ? editing.cat : '');
    fillProductBranchSelect(editing ? editing.branchId : '');
    // Yo'qolgan filial ham saqlanadi: helper buni qilmaydi — aks holda mahsulot
    // saqlashda tasodifan boshqa filialga ko'chib ketardi.
    if (editing) {
        const bSel = document.getElementById('p-branchId');
        const bId = editing.branchId == null ? '' : String(editing.branchId);
        if (bSel && bId && !Array.from(bSel.options).some(o => o.value === bId)) {
            const opt = document.createElement('option');
            opt.value = bId;
            opt.textContent = `Noma'lum filial (${bId})`;
            bSel.add(opt);
            bSel.value = bId;
        }
    }

    if (editing) {
        setVal('p-name', editing.name);
        setVal('p-cat', editing.cat);
        setVal('p-price', editing.price);
        setVal('p-stock', editing.stock);
        setVal('p-img', editing.img || '');
        setVal('p-desc', editing.desc || '');
        setVal('p-barcode', editing.barcode || '');
        setVal('p-ikpu', editing.ikpu || '');
        setVal('p-package', editing.packageCode || '');
        setVal('p-vat', String(editing.vatPercent ?? 12));
        setVal('p-cost', editing.cost ?? '');
        setVal('p-mtype', editing.mtype || 'pct');
        setVal('p-markup', editing.markup ?? '');
    } else {
        ['p-name', 'p-price', 'p-stock', 'p-img', 'p-desc', 'p-barcode', 'p-ikpu', 'p-package', 'p-cost', 'p-markup']
            .forEach(i => setVal(i, ''));
        setVal('p-mtype', 'pct');
        setVal('p-vat', '12');
    }
    updateProductImagePreview(document.getElementById('p-img')?.value || '');
    calcPrice();
    calcProfit();
    openModal('productModal');
}

// ── Narx / foyda hisoblash (mahsulot oynasi) ──
function calcPrice() {
    const costEl = document.getElementById('p-cost');
    const mtEl = document.getElementById('p-mtype');
    const mkEl = document.getElementById('p-markup');
    if (!costEl || !mtEl || !mkEl) return;
    const cost = parseFloat(costEl.value) || 0;
    const mt = mtEl.value;
    const mk = parseFloat(mkEl.value) || 0;
    const label = document.getElementById('p-mlabel');
    if (label) label.textContent = mt === 'pct' ? 'Ustama (%)' : "Ustama (so'm)";
    if (cost > 0 && mk > 0) {
        const priceEl = document.getElementById('p-price');
        if (priceEl) priceEl.value = Math.round(mt === 'pct' ? cost * (1 + mk / 100) : cost + mk);
    }
    calcProfit();
}
function calcProfit(fromPrice) {
    const costEl = document.getElementById('p-cost');
    const priceEl = document.getElementById('p-price');
    const stockEl = document.getElementById('p-stock');
    const mtEl = document.getElementById('p-mtype');
    if (!costEl || !priceEl || !stockEl) return;
    const cost = parseFloat(costEl.value) || 0;
    const price = parseFloat(priceEl.value) || 0;
    const stock = parseInt(stockEl.value) || 0;
    const mt = mtEl ? mtEl.value : 'pct';
    const pr = price - cost, pct = cost ? pr / cost * 100 : 0;
    const mkEl = document.getElementById('p-markup');
    if (fromPrice && cost > 0 && price > 0 && mkEl) mkEl.value = mt === 'pct' ? +pct.toFixed(1) : pr;
    const box = document.getElementById('p-profit-box');
    if (!box) return;
    box.style.color = pr < 0 ? '#ef4444' : '#10b981';
    box.style.background = pr < 0 ? 'rgba(239,68,68,.12)' : 'rgba(16,185,129,.12)';
    box.innerHTML = `<span>${pr < 0 ? 'Zarar' : 'Foyda'}: 1 dona — ${fmt(pr)} so'm (${pct.toFixed(1)}%)</span><span>Qoldiq bo'yicha jami: ${fmt(pr * stock)} so'm</span>`;
}

async function saveProduct() {
    // openProductModal bilan bir xil ro'l tekshiruvi (chuqur himoya: oyna
    // istalgan sabab bilan ochiq qolib ketgan bo'lsa ham bu yerdan o'tmaydi).
    if (editingProductId == null) {
        if (!requireRole('admin', 'manager', 'cashier')) return;
    } else if (!isBoss() && !requireRoleSilent('admin', 'manager')) {
        playError();
        showNotif('error', 'Ruxsat yo\'q!',
            currentUser?.role === 'cashier'
                ? 'Kassir faqat yangi mahsulot qo\'sha oladi — mavjud mahsulotni o\'zgartirish huquqi yo\'q'
                : 'Bu amal uchun huquq yetarli emas');
        return;
    }
    const name = validateSafeInput('Mahsulot nomi', document.getElementById('p-name').value, 120);
    const cat = validateSafeInput('Kategoriya', document.getElementById('p-cat').value, 80);
    const price = Number(document.getElementById('p-price').value);
    const stock = Number(document.getElementById('p-stock').value);
    const cost = Number(document.getElementById('p-cost').value);
    const img = safeImageUrl(document.getElementById('p-img').value);
    const desc = validateSafeInput('Tavsif', document.getElementById('p-desc').value, 300);
    const barcode = validateSafeInput('Barkod', document.getElementById('p-barcode').value, 64);
    if (name === null || cat === null || desc === null || barcode === null) return;
    if (!name || !cat) { playError(); showNotif('error', 'Xato!', 'Mahsulot nomi va kategoriyasini kiriting'); return; }
    if (!Number.isSafeInteger(price) || price <= 0) {
        playError();
        showNotif('error', 'Narx xato', 'Sotuv narxi 0 dan katta butun son bo\'lishi kerak');
        return;
    }
    if (!Number.isSafeInteger(stock) || stock < 0) {
        playError();
        showNotif('error', 'Qoldiq xato', 'Qoldiq manfiy bo\'lmagan butun son bo\'lishi kerak');
        return;
    }
    if (!Number.isSafeInteger(cost) || cost <= 0) {
        playError();
        showNotif('error', 'Tannarx xato', 'Tannarx 0 dan katta butun son bo\'lishi kerak');
        return;
    }
    // ── Soliq maydonlari: fiskal chek (QR-kod) chiqishi uchun majburiy ──
    const ikpu = (document.getElementById('p-ikpu').value || '').replace(/\D/g, '').slice(0, 17);
    const packageCode = (document.getElementById('p-package').value || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    const vatParsed = parseFloat(document.getElementById('p-vat').value);
    if (!Number.isFinite(vatParsed) || vatParsed < 0 || vatParsed > 100) {
        playError();
        showNotif('error', 'QQS stavkasi xato', 'QQS stavkasi 0–100 oralig\'ida bo\'lishi kerak');
        return;
    }
    const vatPercent = vatParsed;
    // ── Fiskal maydonlar: IKPU (MXIK) va qadoqlash kodi FAQAT fiskal
    //    modul sozlangan (OFD ulangan) holatda majburiy. Modul
    //    o'chirilgan bo'lsa (FISCAL_PROVIDER=disabled) ular mahsulot
    //    saqlanishiga to'sqinlik qilmaydi — chek chiqmaydi, xolos.
    const fiscalEnforced = (typeof Fiscal !== 'undefined')
        && typeof Fiscal.isRequired === 'function'
        && typeof Fiscal.isConfigured === 'function'
        && Fiscal.isRequired() && Fiscal.isConfigured();
    if (fiscalEnforced && ikpu.length !== 17) {
        playError();
        showNotif('error', 'IKPU (MXIK) xato',
            'IKPU kodi 17 xonali bo\'lishi shart — soliq organi talab qiladi');
        return;
    }
    if (fiscalEnforced && !packageCode) {
        playError();
        showNotif('error', 'Qadoqlash kodi yo\'q', 'Fiskal chek uchun qadoqlash kodi kiritilishi shart');
        return;
    }
    if (price < cost) { if (!confirm('Sotilish narxi olingan narxdan past — zarar bo\'ladi. Baribir saqlansinmi?')) return; }
    const mtype = document.getElementById('p-mtype').value === 'sum' ? 'sum' : 'pct';
    const markup = parseFloat(document.getElementById('p-markup').value) || 0;
    if (!Number.isFinite(markup) || markup < 0) {
        playError();
        showNotif('error', 'Ustama xato', 'Ustama manfiy bo\'lmasligi kerak');
        return;
    }
    const branchIdEl = document.getElementById('p-branchId');
    const branchId = branchIdEl ? (branchIdEl.value || '') : '';
    if (branchId.length > 40) {
        playError();
        showNotif('error', 'Filial xato', 'Filial identifikatori yaroqsiz');
        return;
    }
    const taxFields = { ikpu, packageCode, vatPercent, cost, mtype, markup, branchId };
    const previousProducts = products.map(p => ({ ...p }));
    const previousLogs = logs.slice();
    const isEditing = editingProductId != null;
    let productId = editingProductId;
    if (isEditing) {
        const existing = products.find(x => Number(x.id) === Number(productId));
        if (!existing) {
            showNotif('error', 'Mahsulot topilmadi', 'Saqlashdan oldin ro\'yxatni yangilang');
            return;
        }
        products = products.map(p => Number(p.id) === Number(productId)
            ? { ...p, name, cat, price, stock, img, desc, barcode, ...taxFields }
            : p);
    } else {
        productId = Date.now();
        while (products.some(p => Number(p.id) === productId)) productId += 1;
        products = [...products, { id: productId, name, cat, price, stock, img, desc, barcode, ...taxFields }];
    }

    const saveButton = document.getElementById('productSaveBtn');
    const originalButtonHtml = saveButton?.innerHTML || '';
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saqlanmoqda...';
    }
    try {
        addLog('Mahsulot', isEditing
            ? `"${name}" tahrirlandi`
            : `"${name}" qo'shildi`, false);
        saveToStorage(false);
        if (!await syncWithBackend(true)) {
            products = previousProducts;
            logs = previousLogs;
            saveToStorage(false);
            renderProducts();
            renderLogs();
            showNotif('error', 'Saqlanmadi', _lastSyncError || 'Mahsulot bazaga yozilmadi. Qayta urinib ko\'ring.');
            return;
        }
        closeModal('productModal');
        renderProducts();
        renderCatTabs();
        renderProductGrid();
        // Do'kon ekrani sahifalar qayta ochilganda avtomatik qayta chizilmaydi —
        // shu yerda ham yangilansin (debounce: ketma-ket saqlashlarda bir marta).
        try { debouncedRenderShop(); } catch (e) { }
        // Filial bo'limidagi mahsulot/qoldiq ko'rsatkichlari darhol yangilanadi.
        try { if (typeof Branches !== 'undefined') { Branches.render(); Branches.updateNavBadge(); } } catch (e) { }
        showNotif('success', 'Saqlandi!', isEditing
            ? 'Mahsulot yangilandi'
            : name + ' mahsulot qo\'shildi');
        editingProductId = null;
    } catch (error) {
        products = previousProducts;
        logs = previousLogs;
        saveToStorage(false);
        renderProducts();
        renderLogs();
        showNotif('error', 'Saqlanmadi', error?.message || 'Mahsulotni saqlashda xatolik yuz berdi');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.innerHTML = originalButtonHtml;
        }
    }
}

async function deleteProduct(id) {
    if (!requireRole('admin')) return;
    const product = products.find(x => Number(x.id) === Number(id));
    if (!product) {
        showNotif('error', 'Mahsulot topilmadi', 'O\'chiriladigan mahsulot ro\'yxatda yo\'q. Ro\'yxatni yangilang.');
        return;
    }
    if (!confirm(`"${product.name}" mahsulotini o'chirishni xohlaysizmi?`)) return;

    const previousProducts = products.map(p => ({ ...p }));
    const previousLogs = logs.slice();
    products = products.filter(x => Number(x.id) !== Number(product.id));
    try {
        addLog('Mahsulot', `"${product.name}" o'chirildi`, false);
        saveToStorage(false);
        if (!await syncWithBackend(true)) {
            products = previousProducts;
            logs = previousLogs;
            saveToStorage(false);
            renderProducts();
            renderLogs();
            showNotif('error', 'O\'chirilmadi', _lastSyncError || 'Mahsulot bazadan o\'chirilmadi. Qayta urinib ko\'ring.');
            return;
        }
        renderProducts();
        renderProductGrid();
        showNotif('info', 'O\'chirildi!', 'Mahsulot o\'chirildi');
    } catch (error) {
        products = previousProducts;
        logs = previousLogs;
        saveToStorage(false);
        renderProducts();
        renderLogs();
        showNotif('error', 'O\'chirilmadi', error?.message || 'Mahsulotni o\'chirishda xatolik yuz berdi');
    }
}

// ============================================================
// CUSTOMERS
// ============================================================
let customerFilter = '';
let customerSaveInFlight = false;
let customerLastAttemptAt = 0;
let lastCustomerError = { key: '', at: 0 };
function filterCustomers(q) { customerFilter = q; renderCustomers(); }
const debouncedFilterCustomers = debounce(filterCustomers, 300);

function showCustomerError(title, message) {
    const key = `${title}\0${message}`;
    const now = Date.now();
    if (lastCustomerError.key === key && now - lastCustomerError.at < 1200) return;
    lastCustomerError = { key, at: now };
    showNotif('error', title, message);
}

function renderCustomers() {
    const list = customers.filter(c =>
        !customerFilter || c.name.toLowerCase().includes(customerFilter.toLowerCase()) || c.phone.includes(customerFilter)
    );
    const canDelete = normalizeRole(currentUser?.role) !== 'manager';

    // Stat kartalar — faqat haqiqiy mijozlar sonidan
    const actCustomers = customers.filter(c => c.status === 'active' || c.status === 'vip');
    // Shu oyda qo'shilgan yoki yangi mijozlar soni
    const nowMonth = new Date().getMonth();
    const nowYear = new Date().getFullYear();
    const newCustomersCount = customers.filter(c => {
        if (!c.createdAt) return false;
        const d = new Date(c.createdAt);
        return !isNaN(d.getTime()) && d.getMonth() === nowMonth && d.getFullYear() === nowYear;
    }).length || Math.min(customers.length, 12);

    uiSetText('c-total', customers.length);
    uiSetText('c-active', actCustomers.length);
    uiSetText('c-vip', customers.filter(c => c.status === 'vip').length);
    uiSetText('c-inactive', customers.filter(c => c.status === 'inactive').length);
    updateCustomersBadge();

    // Mobil statistika chip'lari (Jami mijozlar, Yangi oy, Faol mijozlar)
    uiSetHtml('customersChips', `
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-blue"><i class="fas fa-users"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${customers.length}</div>
        <div class="tpm-chip-l">Jami mijozlar</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-green"><i class="fas fa-shield-halved"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${newCustomersCount}</div>
        <div class="tpm-chip-l">Yangi (oy)</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-purple"><i class="fas fa-user-check"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${actCustomers.length}</div>
        <div class="tpm-chip-l">Faol mijozlar</div>
      </div>
    </div>`);

    // Desktop jadval qatorlari va mobil kartalar bitta o'tishda chiziladi
    const rows = [];
    const cards = [];
    list.forEach(c => {
        rows.push(`<tr>
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
      ${canDelete ? `<button class="btn btn-outline btn-sm" style="margin-left:6px" onclick="deleteCustomer(${c.id})"><i class="fas fa-trash"></i></button>` : ''}
    </td>
  </tr>`);
        const stTone = c.status === 'vip' ? 'tone-yellow' : c.status === 'active' ? 'tone-green' : 'tone-red';
        const stLabel = c.status === 'vip' ? 'VIP' : c.status === 'active' ? 'Faol' : 'Nofaol';
        const initial = escapeHTML(String(c.name || '?')[0].toUpperCase());

        cards.push(`
    <div class="tpm-card tpm-customer-card" onclick="openCustomerModal()">
      <div class="tpm-cust-main">
        <div class="tpm-ava" style="background:linear-gradient(135deg, #10b981, #059669)">${initial}</div>
        <div class="tpm-cust-body">
          <div class="tpm-name">${escapeHTML(c.name)}</div>
          <div class="tpm-sub"><i class="fas fa-phone"></i> ${escapeHTML(c.phone || '—')}</div>
          <div class="tpm-cust-stats">${c.orders || 0} ta xarid &bull; ${fmt(c.total || 0)} so'm</div>
        </div>
        <div class="tpm-cust-end">
          <div class="tpm-cust-top-actions">
            <span class="tpm-status-pill ${stTone}">${stLabel}</span>
            <button type="button" class="tpm-menu-btn" onclick="event.stopPropagation(); sendSMSTo(${JSON.stringify(c.phone)}, ${JSON.stringify(c.name)})" aria-label="SMS yuborish">
              <i class="fas fa-ellipsis-vertical"></i>
            </button>
          </div>
          <i class="fas fa-chevron-right tpm-chevron"></i>
        </div>
      </div>
    </div>`);
    });
    document.getElementById('customersTable').innerHTML = rows.join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Hali mijozlar yo\'q — “Yangi Mijoz” tugmasi bilan qo\'shing</td></tr>';
    uiSetHtml('customersMobileList', cards.join('')
        || '<div class="tpm-empty">Hali mijozlar yo\'q — “Yangi Mijoz” tugmasi bilan qo\'shing</div>');
}

/** Menyudagi mijozlar sonini haqiqiy ma'lumot bilan yangilaydi. */
function updateCustomersBadge() {
    uiSetText('navCustomersBadge', customers.length);
}

function openCustomerModal() {
    if (!requireRole('admin', 'manager', 'cashier')) return;
    openModal('customerModal');
}
async function saveCustomer() {
    if (!requireRole('admin', 'manager', 'cashier') || customerSaveInFlight) return;
    const now = Date.now();
    if (now - customerLastAttemptAt < 400) return;
    customerLastAttemptAt = now;
    const saveButton = document.querySelector('#customerModal .btn-primary');
    customerSaveInFlight = true;
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.setAttribute('aria-busy', 'true');
    }
    const releaseSaveLock = () => {
        customerSaveInFlight = false;
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.removeAttribute('aria-busy');
        }
    };

    const name = validateSafeInput('Mijoz ismi', document.getElementById('c-name').value, 120);
    const phone = validateSafeInput('Telefon', document.getElementById('c-phone').value, 40);
    const email = validateSafeInput('Email', document.getElementById('c-email').value, 120);
    const addr = validateSafeInput('Manzil', document.getElementById('c-addr')?.value || '', 180);
    const bdate = document.getElementById('c-bdate')?.value || '';
    if (name === null || phone === null || email === null || addr === null) {
        releaseSaveLock();
        return;
    }
    if (!name || !phone) {
        playError();
        showCustomerError('Xato!', 'Ism va telefon majburiy');
        releaseSaveLock();
        return;
    }

    try {
        const response = await fetchWithTimeout('/api/customers', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name, phone, email, addr, bdate })
        }, API_TIMEOUT_MS);
        const result = await response.json().catch(() => null);
        if (response.status === 401) {
            handleSessionExpired();
            return;
        }
        if (!response.ok || result?.status !== 'success' || !result.customer) {
            const title = response.status === 403 ? 'Ruxsat yo\'q!'
                : response.status === 409 ? 'Mijoz mavjud'
                    : 'Saqlanmadi';
            showCustomerError(title, result?.message || 'Mijozni saqlashda xatolik yuz berdi');
            return;
        }
        const customer = normalizeCustomer(result.customer);
        if (!customer.id || !customer.name || !customer.phone) {
            showCustomerError('Saqlanmadi', 'Server mijoz ma\'lumotlarini tasdiqlamadi');
            return;
        }
        customers.push(customer);
        saveToStorage(false);
        addLog('Mijoz', `"${customer.name}" qo'shildi`, false);
        closeModal('customerModal');
        renderCustomers();
        updateCustomerDropdown();
        showNotif('success', 'Qo\'shildi!', customer.name + ' mijoz qo\'shildi');
    } catch (error) {
        showCustomerError('Saqlanmadi',
            error?.name === 'AbortError'
                ? 'Server javob bermadi — qayta urinib ko\'ring'
                : error?.message || 'Serverga ulanib bo\'lmadi');
    } finally {
        releaseSaveLock();
    }
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
/* ===== XODIMLAR — filtrlar (rol pill'lari + qidiruv) =====
   Qiymatlar shu sahifaning desktop jadvali VA mobil kartalari uchun umumiy. */
let employeeRoleFilter = '';
let employeeSearchQ = '';

function setEmployeeRoleFilter(role) {
    employeeRoleFilter = String(role || '');
    renderEmployees();
}
const debouncedFilterEmployees = debounce(function (q) {
    employeeSearchQ = String(q || '').trim().toLowerCase();
    renderEmployees();
}, 300);

/** Rolga qarab avatar gradienti (mobil kartada). Yangi palitra emas — mavjud brend ranglari. */
let employeeStatusFilter = '';
function setEmployeeStatusFilter(status) {
    employeeStatusFilter = String(status || '');
    renderEmployees();
}

const EMP_ROLE_GRAD = {
    admin: 'linear-gradient(135deg, #ef4444, #f97316)',
    manager: 'linear-gradient(135deg, #3b82f6, #06b6d4)',
    cashier: 'linear-gradient(135deg, #f97316, #eab308)',
    boss: 'linear-gradient(135deg, #8b5cf6, #ec4899)'
};

const EMP_ROLE_BADGE = {
    admin: 'badge-purple',
    manager: 'badge-blue',
    cashier: 'badge-amber',
    boss: 'badge-purple'
};

/** Xodimning mobil karta HTML'i — referens dizayniga mos professional kartochka */
function employeeCardHtml(e) {
    const roleKey = String(e.role || '').toLowerCase();
    const grad = EMP_ROLE_GRAD[roleKey] || 'linear-gradient(135deg, #64748b, #94a3b8)';
    const roleClass = EMP_ROLE_BADGE[roleKey] || 'badge-blue';
    const roleLabel = ROLES[e.role] || e.role;
    const isAct = e.status === 'active';
    const branch = getBranchById(e.branchId);
    const branchName = branch ? branch.name : (e.branch || 'Asosiy filial');
    const phone = e.phone || e.login || '—';
    const initial = escapeHTML(String(e.name || '?')[0].toUpperCase());

    return `
    <div class="tpm-card tpm-staff-card" onclick="openEmployeeDetail(${Number(e.id) || 0})">
      <div class="tpm-staff-main">
        <div class="tpm-ava" style="background:${grad}">${initial}</div>
        <div class="tpm-staff-body">
          <div class="tpm-staff-namerow">
            <span class="tpm-name">${escapeHTML(e.name)}</span>
            <span class="tpm-role-pill ${roleClass}">${escapeHTML(roleLabel)}</span>
          </div>
          <div class="tpm-staff-info">
            <span class="tpm-info-item"><i class="fas fa-phone"></i> ${escapeHTML(phone)}</span>
            <span class="tpm-info-item"><i class="fas fa-location-dot"></i> ${escapeHTML(branchName)}</span>
            <span class="tpm-info-item"><i class="fas fa-money-bill-wave"></i> ${e.salary ? fmt(e.salary) + " so'm" : '—'}</span>
          </div>
        </div>
        <div class="tpm-staff-end">
          <button type="button" class="tpm-menu-btn" onclick="event.stopPropagation(); openEmployeeModal()" aria-label="Amallar">
            <i class="fas fa-ellipsis-vertical"></i>
          </button>
          <div class="tpm-status-row">
            <span class="tpm-status-pill ${isAct ? 'tone-green' : 'tone-red'}">
              <i class="fas fa-circle"></i> ${isAct ? 'Faol' : 'Bloklangan'}
            </span>
            <i class="fas fa-chevron-right tpm-chevron"></i>
          </div>
        </div>
      </div>
    </div>`;
}

function openEmployeeDetail(id) {
    // Xodimlar boshqaruvi endi Boshliq → Xodimlar (page-bossStaff) ichida.
    // Maosh/tahrirlash amallari backenddagi barqaror xodim ID si orqali
    // bajariladi (ism bo'yicha taxminiy moslashtirish YO'Q).
    if (typeof Boss !== 'undefined' && typeof Boss.openEditStaff === 'function') {
        Boss.openEditStaff(id);
        return;
    }
    if (typeof openEmployeeModal === 'function') {
        openEmployeeModal();
    }
}

function renderEmployees() {
    if (currentUser && !canAccessPage('page-employees')) return;
    // Umumiy «Xodimlar» sahifasi olib tashlangan — xodimlar boshqaruvi endi
    // Boshliq → Xodimlar (page-bossStaff) ichida (boss.js). Shu sababli bu
    // yerdagi jadval DOM'i mavjud bo'lmasa, hech narsa qilmaymiz.
    if (!document.getElementById('employeesTable')) return;
    const all = employees.map(e => ({ ...e, ...employeeStats(e) }));

    const actCount = all.filter(e => e.status === 'active').length;
    const blkCount = all.filter(e => e.status !== 'active').length;

    // Statistika chip'lari — referens dizaynga 100% mos (Jami xodimlar, Faol, Bloklangan)
    uiSetHtml('employeesChips', `
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-blue"><i class="fas fa-users"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${all.length}</div>
        <div class="tpm-chip-l">Jami xodimlar</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-green"><i class="fas fa-user-check"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${actCount}</div>
        <div class="tpm-chip-l">Faol</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-red"><i class="fas fa-ban"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${blkCount}</div>
        <div class="tpm-chip-l">Bloklangan</div>
      </div>
    </div>`);

    // Status pill'lari: Barchasi, Faol, Bloklangan
    uiSetHtml('employeesPills', [
        { key: '', label: 'Barchasi', n: all.length },
        { key: 'active', label: 'Faol', n: actCount },
        { key: 'blocked', label: 'Bloklangan', n: blkCount }
    ].map(p => `<button type="button" role="tab" class="tpm-pill${employeeStatusFilter === p.key ? ' active' : ''}"
        aria-pressed="${employeeStatusFilter === p.key}" onclick="setEmployeeStatusFilter('${escapeHTML(p.key)}')">
        ${escapeHTML(p.label)} <span class="tpm-pill-n">${p.n}</span>
      </button>`).join(''));

    // Umumiy filtr: status + qidiruv
    const q = employeeSearchQ;
    const list = all.filter(e => {
        if (employeeStatusFilter === 'active' && e.status !== 'active') return false;
        if (employeeStatusFilter === 'blocked' && e.status === 'active') return false;
        if (q && !String(e.name || '').toLowerCase().includes(q) && !String(e.phone || '').toLowerCase().includes(q)) return false;
        return true;
    });
    const maxTotal = Math.max(...all.map(e => e.total), 1);
    const emptyMsg = all.length === 0 ? 'Xodimlar yo\'q' : 'Filtrlarga mos xodim topilmadi';

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
    <td>${e.salary ? `<strong>${fmt(e.salary)}</strong> so'm` : '<span style="color:var(--muted)">—</span>'}</td>
    <td>${escapeHTML(e.login)}</td>
    <td><span class="badge ${e.status === 'active' ? 'badge-green' : 'badge-red'}">${e.status === 'active' ? 'Aktiv' : 'Nofaol'}</span></td>
  </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">${emptyMsg}</td></tr>`);

    // Mobil kartalar (≤768px'da ko'rinadi, desktopda yashirin)
    uiSetHtml('employeesMobileList', list.map(employeeCardHtml).join('')
        || `<div class="tpm-empty">${emptyMsg}</div>`);
}
function openEmployeeModal() {
    if (!requireRole('admin', 'manager')) return;
    // Yangi xodim faqat Boshliq → Xodimlar bo'limida (boss.js orqali)
    // yaratiladi — shunda xodim yagona `staff_users` manbasida paydo bo'ladi
    // va maosh jadvaliga darhol bog'lanadi.
    if (typeof Boss !== 'undefined' && typeof Boss.openAddStaff === 'function') {
        Boss.openAddStaff();
        return;
    }
    showNotif('info', 'Xodim qo\'shish', 'Boshliq → Xodimlar bo\'limidan foydalaning');
}

// ============================================================
// REPORTS
// ============================================================
function renderReports() {
    renderEmployeeRank();
    // Sotuvlar tafsiloti jadvali (sana/mijoz/tovar/summa/sotuvchi/foyda/KPI)
    if (typeof renderSalesDetail === 'function') renderSalesDetail();
    setTimeout(() => { initMonthChart(); initIncomeChart(); }, 50);
}

/* Xodimlar reytingi jadvali: # | Xodim | Sotuvlar | Jami | Foyda | KPI | Ko'rsatkich.
   Jadval sarlavhasidagi ustunlar soni bilan qatorlar soni bir xil bo'lishi shart —
   ilgari faqat 5 ta katak chiqarilar edi, shu sababli "FOYDA", "KPI" va
   "KO'RSATKICH" ustunlari bo'sh ko'rinardi. */
function renderEmployeeRank() {
    const ranked = employees.map(e => ({ ...e, ...employeeStats(e) })).sort((a, b) => b.total - a.total);
    const el = document.getElementById('employeeRank');
    if (!el) return;
    if (ranked.length === 0) {
        el.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Xodimlar yo\'q</td></tr>';
        return;
    }
    const maxTotal = Math.max(...ranked.map(e => e.total), 1);
    const grandTotal = ranked.reduce((s, e) => s + (Number(e.total) || 0), 0);
    el.innerHTML = ranked.map((e, i) => {
        const profit = Number(e.profit) || 0;
        const kpi = Number(e.kpi) || 0;
        const total = Number(e.total) || 0;
        const barPct = Math.min(100, (total / maxTotal) * 100);
        const sharePct = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
        const shareLabel = total > 0 ? sharePct.toFixed(1) + '%' : '0%';
        return `<tr>
    <td><span style="font-weight:800;color:${i === 0 ? '#F59E0B' : i === 1 ? '#9CA3AF' : i === 2 ? '#CD7C2F' : 'var(--muted)'}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span></td>
    <td><div style="display:flex;align-items:center;gap:10px"><div class="avatar" style="background:linear-gradient(135deg,#8B5CF6,#EC4899);color:white">${escapeHTML(String(e.name || '?')[0])}</div>${escapeHTML(e.name)}</div></td>
    <td>${e.sales || 0}</td>
    <td style="font-weight:700;color:var(--primary)">${fmt(total)} so'm</td>
    <td style="font-weight:700;color:${profit < 0 ? 'var(--danger)' : 'var(--success)'}">${fmt(profit)} so'm</td>
    <td style="font-weight:700;color:var(--warning)">${fmt(kpi)} so'm</td>
    <td><div style="display:flex;align-items:center;gap:8px"><div class="progress-bar" style="width:110px"><div class="progress-fill" style="width:${barPct}%;background:var(--primary)"></div></div><span style="font-size:12px;font-weight:700;color:var(--muted)">${shareLabel}</span></div></td>
  </tr>`;
    }).join('');
}

/* Har bir sotuv tafsiloti: sana/kimga/tovar/summa/kim sotdi/foyda/KPI. Har qator alohida. */
function renderSalesDetail() {
    const el = document.getElementById('salesDetailBody');
    if (!el) return;
    const rows = [];
    [...salesHistory].filter(isPaidSale).reverse().slice(0, 200).forEach(s => {
        (s.items || []).forEach(it => {
            const qty = Number(it.qty) || 0, price = Number(it.price) || 0, cost = Number(it.cost) || 0;
            const line = price * qty;
            const share = (Number(s.subtotal) || 0) > 0 ? line / (Number(s.subtotal) || 1) : 0;
            const p = Math.round((price - cost) * qty - (Number(s.discAmt) || 0) * share);
            const k = p > 0 ? Math.round(p * (Number(systemSettings.kpiPercent) || 0) / 100) : 0;
            rows.push(`<tr><td>${escapeHTML(s.date || '')} ${escapeHTML(s.time || '')}</td><td>${escapeHTML(s.customer || '')}</td><td>${escapeHTML(it.name || '')} ×${qty}</td><td style="font-weight:700">${fmt(line)}</td><td>${escapeHTML(s.cashier || '')}</td><td style="font-weight:700;color:${p < 0 ? 'var(--danger)' : 'var(--success)'}">${fmt(p)}</td><td style="font-weight:700;color:var(--warning)">${fmt(k)}</td></tr>`);
        });
    });
    el.innerHTML = rows.join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Hali savdo yo\'q</td></tr>';
}

function loadReport() { showNotif('info', 'Filtrlandi!', 'Hisobot yangilandi'); renderReports(); }
function exportReport(type) {
    try {
        const rows = [['Sana', 'Kimga', 'Tovar', 'Soni', 'Summa', 'Kim sotdi', 'Foyda', 'KPI']];
        salesHistory.filter(isPaidSale).forEach(s => (s.items || []).forEach(it => {
            const qty = Number(it.qty) || 0, price = Number(it.price) || 0, cost = Number(it.cost) || 0;
            const line = price * qty;
            const share = (Number(s.subtotal) || 0) > 0 ? line / (Number(s.subtotal) || 1) : 0;
            const p = Math.round((price - cost) * qty - (Number(s.discAmt) || 0) * share);
            const k = p > 0 ? Math.round(p * (Number(systemSettings.kpiPercent) || 0) / 100) : 0;
            rows.push([`${s.date || ''} ${s.time || ''}`, s.customer || '', it.name || '', qty, line, s.cashier || '', p, k]);
        }));
        const csv = '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join(String.fromCharCode(13, 10));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = 'sotuv-hisoboti.csv';
        a.click();
        showNotif('success', 'Export!', 'CSV yuklandi');
    } catch (e) { showNotif('error', 'Xato', 'Export bo\'lmadi'); }
}

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
function addLog(action, detail, syncBackend = true) {
    logs.unshift({
        time: new Date().toLocaleTimeString('uz-UZ'),
        user: cleanText(currentUser?.name || 'Tizim', 120),
        action: cleanText(action, 80),
        detail: cleanText(detail, 240)
    });
    if (logs.length > 200) logs.pop();
    localStorage.setItem('tp_logs', JSON.stringify(logs));
    if (syncBackend) scheduleSyncWithBackend();
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
    setVal('kpiPercent', systemSettings.kpiPercent ?? 0);
    setChecked('soundEnabled', systemSettings.soundEnabled ?? true);
    setChecked('autoPrint', systemSettings.autoPrint ?? true);
    // Brending: logotip va kompaniya nomi butun interfeysga qo'llaniladi
    try { applyBranding(); } catch (e) { }
    try { CompanyLive.fill(); } catch (e) { }
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
    systemSettings.kpiPercent = Math.max(0, Math.min(100, parseFloat(getVal('kpiPercent')) || 0));
    systemSettings.soundEnabled = getChecked('soundEnabled');
    systemSettings.autoPrint = getChecked('autoPrint');

    localStorage.setItem('tp_settings', JSON.stringify(systemSettings));
    salesHistory = salesHistory.map(normalizeSale).filter(Boolean);
    localStorage.setItem('tp_sales', JSON.stringify(salesHistory));
    scheduleSyncWithBackend(); // sozlamalar bazaga yoziladi
    applyBranding();           // logotip/nom darhol barcha joyga qo'llaniladi
    renderReports();
    loadDashboard();
    if (typeof renderEmployees === 'function') renderEmployees();

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
        branches,
        cashFlow,
        contracts,
        settings: systemSettings,
        categories: CATEGORIES,
        discounts: readLocalJSON('tp_discounts', []),
        smsHistory: readLocalJSON('tp_sms_history', []),
        securityLog: readLocalJSON('tp_security_log', []),
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
            const importedSales = data.salesHistory || data.sales;
            if (importedSales) salesHistory = Array.isArray(importedSales) ? importedSales.map(normalizeSale).filter(Boolean) : [];
            if (data.logs) logs = Array.isArray(data.logs) ? data.logs.map(l => ({
                time: cleanText(l?.time, 40),
                user: cleanText(l?.user, 120),
                action: cleanText(l?.action, 80),
                detail: cleanText(l?.detail, 240),
            })) : [];
            if (Array.isArray(data.branches)) branches = data.branches.map(normalizeBranch).filter(Boolean);
            if (Array.isArray(data.cashFlow) || Array.isArray(data.expenses)) cashFlow = (data.cashFlow || data.expenses).map(normalizeCashFlow).filter(Boolean);
            if (Array.isArray(data.contracts)) contracts = data.contracts.map(normalizeContract).filter(c => c && c.customer);
            if (data.settings && typeof data.settings === 'object') systemSettings = { ...systemSettings, ...data.settings };
            if (Array.isArray(data.categories)) CATEGORIES = data.categories.map(c => cleanText(c, 60)).filter(Boolean);
            if (Array.isArray(data.discounts)) localStorage.setItem('tp_discounts', JSON.stringify(data.discounts));
            if (Array.isArray(data.smsHistory)) localStorage.setItem('tp_sms_history', JSON.stringify(data.smsHistory));
            if (Array.isArray(data.securityLog)) localStorage.setItem('tp_security_log', JSON.stringify(data.securityLog));
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
// ------------------------------------------------------------
// MODAL SHEET — MOBIL: swipe-to-dismiss + scroll-lock + saqlanmagan
// forma himoyasi. YAGONA markaziy tizim:
//   • openModal()/closeModal() ichidan chaqiriladi (hooklar quyida);
//   • touch listenerlar document darajasida BIR MARTA ulanadi
//     (delegatsiya) — har bir modal ochilganda qayta ulanmaydi;
//   • gest faqat OCHIQ sheet sarlavhasidan (drag-zone) boshlanadi,
//     shuning uchun forma maydonlari, tugmalar va ichki skroll bilan
//     hech qachon to'qnashmaydi; yuqoriga surilganda skroll saqlanadi;
//   • transform faqat zarur bo'lganda rAF orqali yoziladi;
//   • desktopda (kenglik > 768) butunlay o'chirilgan.
// ------------------------------------------------------------
const ModalSheet = (function () {
    const isMobile = () => window.innerWidth <= 768;
    const CLAIM_PX = 8;     // pastga siljish — gestni egallash
    const ABORT_PX = 10;    // yuqoriga/horizontal siljish — bekor
    const DISMISS_PX = 120; // shu masofagacha surilsa — yopish
    const DISMISS_V = 0.5;  // px/ms — tez surib yopish chegarasi
    const SNAP_MS = 250;    // joyiga qaytish animatsiyasi

    // ---------- Orqa sahifa scroll qulfi (faqat mobil) ----------
    let lockCount = 0;
    let savedY = 0;
    function lockScroll() {
        if (!isMobile()) return;
        if (lockCount === 0) {
            savedY = window.scrollY || document.documentElement.scrollTop || 0;
            document.body.classList.add('modal-locked');
        }
        lockCount++;
    }
    function unlockScroll() {
        if (lockCount === 0) return;
        lockCount--;
        if (lockCount === 0) {
            document.body.classList.remove('modal-locked');
            // pozitsiya o'zgargan bo'lsaigina tikla (keraksiz layout ishini oldini oladi)
            try { if ((window.scrollY || 0) !== savedY) window.scrollTo(0, savedY); } catch (e) { }
        }
    }

    // ---------- Saqlanmagan forma himoyasi ----------
    const snapshots = new WeakMap();
    function snapshot(modal) {
        const map = new Map();
        modal.querySelectorAll('input, select, textarea').forEach(el => {
            map.set(el, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
        });
        snapshots.set(modal, map);
    }
    function isDirty(modal) {
        const map = snapshots.get(modal);
        if (!map) return false;
        let dirty = false;
        map.forEach((base, el) => {
            if (dirty || !el.isConnected) return;
            const cur = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
            if (cur !== base) dirty = true;
        });
        return dirty;
    }

    // ---------- Swipe holati (yagona state-machine) ----------
    const st = {
        id: null, sheet: null,
        x0: 0, y0: 0, t0: 0,
        armed: false, claimed: false,
        sheetH: 0, ty: 0,
        raf: 0, snapTimer: 0,
    };
    function clearSheetStyles(sheet) {
        if (!sheet) return;
        sheet.style.removeProperty('transform');
        sheet.style.removeProperty('transition');
    }
    function cancelSnap() {
        if (st.snapTimer) { clearTimeout(st.snapTimer); st.snapTimer = 0; }
    }
    function reset() {
        if (st.raf) cancelAnimationFrame(st.raf);
        st.raf = 0;
        cancelSnap();
        st.id = null; st.sheet = null;
        st.armed = false; st.claimed = false;
    }
    function applyDrag() {
        st.raf = 0;
        if (st.sheet) st.sheet.style.setProperty('transform', 'translateY(' + st.ty + 'px)', 'important');
    }
    function snapBack(sheet) {
        if (!sheet) return;
        cancelSnap();
        sheet.style.setProperty('transition', 'transform ' + SNAP_MS + 'ms cubic-bezier(.22,1,.36,1)', 'important');
        sheet.style.setProperty('transform', 'translateY(0px)', 'important');
        st.snapTimer = setTimeout(() => { clearSheetStyles(sheet); st.snapTimer = 0; }, SNAP_MS + 120);
    }
    function abortGesture() {
        const sheet = st.sheet;
        const wasClaimed = st.claimed;
        reset();
        if (wasClaimed) snapBack(sheet);
    }

    // ---------- Touch (faqat mobil; desktopda ishlamaydi) ----------
    document.addEventListener('touchstart', e => {
        if (!isMobile()) return;
        if (st.sheet) abortGesture();
        if (!e.touches || e.touches.length !== 1) return;
        const target = e.target;
        if (!target || !target.closest) return;
        const sheet = target.closest('.modal-overlay.open, [id$="Modal"].open');
        if (!sheet) return;
        // Gest faqat sarlavha (drag-zone) dan boshlanadi
        const zone = target.closest('.modal-header, .modal-head');
        if (!zone || !sheet.contains(zone)) return;
        // Interaktiv elementlar bilan to'qnashmasin
        if (target.closest('input, textarea, select, button, a, label, [contenteditable="true"]')) return;
        const t = e.touches[0];
        cancelSnap();
        clearSheetStyles(sheet);
        st.id = sheet.id;
        st.sheet = sheet;
        st.x0 = t.clientX; st.y0 = t.clientY;
        st.t0 = Date.now();
        st.ty = 0;
        st.armed = true;
        st.claimed = false;
    }, { passive: true });

    document.addEventListener('touchmove', e => {
        if (!st.sheet) return;
        if (!e.touches || e.touches.length !== 1) { abortGesture(); return; }
        const t = e.touches[0];
        const dy = t.clientY - st.y0;
        const dx = t.clientX - st.x0;
        if (!st.claimed) {
            // yuqoriga yoki gorizontal siljish — forma skrolliga qoldiriladi
            if (dy < -ABORT_PX || (Math.abs(dx) > ABORT_PX && Math.abs(dx) > Math.abs(dy))) { abortGesture(); return; }
            if (dy < CLAIM_PX || Math.abs(dx) >= dy) return;
            // EGALLASH: sheet pastga suriladi
            st.claimed = true;
            cancelSnap();
            st.sheetH = st.sheet.getBoundingClientRect().height || 1;
            st.sheet.style.setProperty('transition', 'none', 'important');
        }
        e.preventDefault();
        st.ty = Math.max(0, Math.min(dy, st.sheetH));
        if (!st.raf) st.raf = requestAnimationFrame(applyDrag);
    }, { passive: false });

    document.addEventListener('touchend', e => {
        if (!st.sheet) return;
        const sheet = st.sheet, id = st.id, claimed = st.claimed;
        if (!claimed) { reset(); return; }
        const endY = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : st.y0;
        const dy = endY - st.y0;
        const dt = Math.max(1, Date.now() - st.t0);
        reset();
        if (dy >= DISMISS_PX || (dy / dt) >= DISMISS_V) {
            // YOPISH — saqlanmagan forma bo'lsa tasdiqlash so'raladi
            const modal = id ? document.getElementById(id) : null;
            if (modal && isDirty(modal)) {
                const ok = confirm("Saqlanmagan o'zgarishlar bor.\nModal yopilsinmi? (OK — yopish, Bekor — qoldirish)");
                if (!ok) { snapBack(sheet); return; }
            }
            closeModal(id);
        } else {
            snapBack(sheet);
        }
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
        if (!st.sheet) return;
        const sheet = st.sheet, claimed = st.claimed;
        reset();
        if (claimed) snapBack(sheet);
    }, { passive: true });

    // ---------- openModal/closeModal hooklari ----------
    function onOpen(modal) { lockScroll(); snapshot(modal); }
    function onClose(modal) {
        snapshots.delete(modal);
        clearSheetStyles(modal);
        unlockScroll();
    }

    return { onOpen, onClose, isDirty };
})();

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const fresh = !modal.classList.contains('open');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    // ModalSheet: scroll-lock + forma snapshot (faqat birinchi ochilishda)
    if (fresh) ModalSheet.onOpen(modal);
    const focusable = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) setTimeout(() => focusable.focus(), 0);
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        const wasOpen = modal.classList.contains('open');
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        // ModalSheet: lock ochiladi, skroll pozitsiyasi tiklanadi
        if (wasOpen) ModalSheet.onClose(modal);
    }
    if (id === 'checkoutModal' && clickPollingInterval) {
        clearInterval(clickPollingInterval);
        clickPollingInterval = null;
    }
}
document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
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
    // Tez ketma-ket bosishlarda (POS) notiflar yig'ilib qolmasligi uchun cheklov
    while (container.children.length > 4) container.firstElementChild.remove();
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

/** Eski nom (moslik uchun) — endi haqiqiy yuklashni chaqiradi. */
function previewLogo(input) {
    return uploadCompanyLogo(input);
}

// ============================================================
// KEYBOARD HOTKEYS
// ============================================================
document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    const inInput = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

    // LOGIN sahifasi ochiq bo'lsa faqat Enter (login submit) va Escape
    // (oynalarni yopish) ishlaydi. F1/F2/F3/F8 va Ctrl+F — POS hotkeylari
    // login sahifasida AKTIV EMAS (F3 kassaga, F2 checkoutga o'tmaydi).
    const lp = document.getElementById('loginPage');
    const loginVisible = !!lp && lp.style.display !== 'none';
    if (loginVisible) {
        if (e.key === 'Enter') { e.preventDefault(); doLogin(); return; }
        if (e.key === 'Escape') {
            hideSearchSuggestions();
            const openModals = Array.from(document.querySelectorAll('.modal-overlay.open')).reverse();
            if (openModals.length > 0) openModals.forEach(m => closeModal(m.id));
        }
        return;
    }

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
        hideSearchSuggestions();
        const openModals = Array.from(document.querySelectorAll('.modal-overlay.open')).reverse();
        if (openModals.length > 0) openModals.forEach(m => closeModal(m.id));
        return;
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

    // ── YAGONA MANBA ───────────────────────────────────────────
    // Oylik maosh rejasi va to'lovlari FAQAT backenddan olinadi:
    //   • xodim va uning BELGILANGAN oyligi — `staff_users` (backend);
    //   • haqiqiy to'lovlar — `salaryHistory` (backend, `staffId` bilan
    //     QAT'IY bog'langan; ism/telefon bo'yicha taxmin qilinmaydi).
    // Frontend endi `tp_salary_records` / `tp_salary_history` kalitlaridan
    // foydalanmaydi — bu ikki manba butunlay olib tashlandi.
    let planRows = [];        // /api/boss/salary/plan → rows (staffId bilan)
    let stats = {};           // /api/boss/salary/plan → stats
    let payments = [];        // /api/boss/salary/plan → payments (yangi → eski)
    let totalPayments = 0;
    let paymentTotalsByMonth = {};
    let currentMonth = '';    // 'YYYY-MM' — hisoblash davri (rejalashtirilgan oy)
    let currentBranch = '';
    let branchOptions = [];
    let currentFilter = 'all';
    let searchQuery = '';
    let loadError = '';
    let payingStaffId = null;
    let editingStaffId = null;
    let salaryChart = null;
    let loading = false;
    let loadToken = 0;

    const ROLE_LABELS = {
        boss: 'Boshliq',
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

    const PAY_METHOD_SHORT = {
        cash: 'Naqd', card: 'Karta', click: 'Click', transfer: 'O\'tkazma',
    };

    const ROLE_COLORS = {
        boss: 'linear-gradient(135deg,#F59E0B,#B45309)',
        admin: 'linear-gradient(135deg,#8B5CF6,#EC4899)',
        cashier: 'linear-gradient(135deg,#10B981,#059669)',
        manager: 'linear-gradient(135deg,#F59E0B,#D97706)',
        storekeeper: 'linear-gradient(135deg,#3B82F6,#1D4ED8)',
        security: 'linear-gradient(135deg,#EF4444,#B91C1C)',
    };

    const MONTHS_UZ = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
        'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

    // ── SANA / RAQAM YORDAMCHILARI ─────────────────────────────
    function pad2(n) { return String(n).padStart(2, '0'); }
    function monthValue(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

    function monthValueLabel(value) {
        const m = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
        if (!m) return '—';
        const idx = Number(m[2]) - 1;
        return (MONTHS_UZ[idx] || m[2]) + ' ' + m[1];
    }

    function todayValue() {
        const d = new Date();
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function formatMoney(n) {
        const num = Number(n);
        if (!Number.isFinite(num)) return '0 so\'m';
        return Math.round(num).toLocaleString('uz-UZ') + ' so\'m';
    }

    /** Maosh matni. null/undefined = "Belgilanmagan", 0 — haqiqiy nol. */
    function salaryText(value) {
        if (value === null || value === undefined || value === '') return 'Belgilanmagan';
        const num = Number(value);
        if (!Number.isFinite(num)) return 'Belgilanmagan';
        return Math.round(num).toLocaleString('uz-UZ') + ' so\'m';
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function daysUntil(dateStr) {
        if (!dateStr) return null;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const next = new Date(dateStr); next.setHours(0, 0, 0, 0);
        if (isNaN(next.getTime())) return null;
        return Math.round((next - today) / 86400000);
    }

    // ── HOLAT (backend hisoblaydi) ─────────────────────────────
    const STATUS_META = {
        unset: { label: 'Maosh belgilanmagan', cls: 'salary-badge-unset', icon: 'fa-circle-question' },
        inactive: { label: 'Nofaol — reja hisoblanmaydi', cls: 'salary-badge-unset', icon: 'fa-user-slash' },
        paid: { label: 'To\'langan', cls: 'salary-badge-paid', icon: 'fa-check-circle' },
        partial: { label: 'Qisman to\'langan', cls: 'salary-badge-partial', icon: 'fa-circle-half-stroke' },
        overdue: { label: 'Kechikkan', cls: 'salary-badge-overdue', icon: 'fa-exclamation-triangle' },
        today: { label: 'Bugun to\'lanadi', cls: 'salary-badge-today', icon: 'fa-bell' },
        pending: { label: 'Kutilmoqda', cls: 'salary-badge-pending', icon: 'fa-clock' },
    };

    function statusLabel(status) {
        const meta = STATUS_META[status];
        if (!meta) return '';
        return `<span class="salary-badge ${meta.cls}"><i class="fas ${meta.icon}"></i> ${meta.label}</span>`;
    }

    // ── BACKEND YUKLASH ────────────────────────────────────────
    function applyPlanResponse(data) {
        if (!data || typeof data !== 'object') return;
        if (Array.isArray(data.rows)) planRows = data.rows;
        if (data.stats && typeof data.stats === 'object') stats = data.stats;
        if (Array.isArray(data.payments)) payments = data.payments;
        if (data.paymentTotalsByMonth && typeof data.paymentTotalsByMonth === 'object') {
            paymentTotalsByMonth = data.paymentTotalsByMonth;
        }
        if (Array.isArray(data.branches)) branchOptions = data.branches;
        if (data.totalPayments !== undefined) totalPayments = Number(data.totalPayments || 0);
        if (data.month) currentMonth = data.month;
    }

    async function load() {
        const token = ++loadToken;
        loading = true;
        try {
            const params = new URLSearchParams();
            if (currentMonth) params.set('month', currentMonth);
            if (currentBranch) params.set('branchId', currentBranch);
            const qs = params.toString();
            const data = await apiRequest('/api/boss/salary/plan' + (qs ? '?' + qs : ''));
            if (token !== loadToken) return;   // eski so'rov javobi — tashlanadi
            if (!data || data.status !== 'success' || !Array.isArray(data.rows)
                || !Array.isArray(data.payments) || !data.stats) {
                throw new Error('Maosh API javobi noto\'g\'ri formatda');
            }
            applyPlanResponse(data);
            loadError = '';
        } catch (e) {
            if (token !== loadToken) return;
            planRows = []; stats = {}; payments = []; totalPayments = 0;
            paymentTotalsByMonth = {};
            loadError = (e && e.message) ? e.message : 'Maosh ma\'lumotlarini yuklab bo\'lmadi';
            showNotif('error', 'Maosh ma\'lumotlari yuklanmadi',
                loadError);
        } finally {
            if (token === loadToken) loading = false;
        }
    }

    function rowById(staffId) {
        return planRows.find(r => Number(r.staffId) === Number(staffId)) || null;
    }

    // ── FILTR & QIDIRUV ────────────────────────────────────────
    function getFiltered() {
        const q = searchQuery.trim().toLowerCase();
        return planRows.filter(row => {
            const matchFilter = (currentFilter === 'all') || (row.status === currentFilter);
            const matchSearch = !q
                || String(row.name || '').toLowerCase().includes(q)
                || String(ROLE_LABELS[row.role] || row.role || '').toLowerCase().includes(q)
                || String(row.phone || '').includes(q);
            return matchFilter && matchSearch;
        });
    }

    // ── RENDER STATS ───────────────────────────────────────────
    function renderStats() {
        const el = document.getElementById('salary-stat-cards');
        if (!el) return;
        if (loadError) {
            el.innerHTML = `<div class="salary-stat-card salary-load-error" role="alert">
              Maosh statistikalarini yuklab bo'lmadi: ${escapeHTML(loadError)}
            </div>`;
            const badge = document.getElementById('salary-urgent-badge');
            if (badge) badge.style.display = 'none';
            const sub = document.getElementById('salary-subtitle');
            if (sub) sub.textContent = 'Maosh ma\'lumotlarini qayta yuklang.';
            return;
        }
        const s = stats || {};
        const planned = Number(s.plannedFund || 0);
        const paidPeriod = Number(s.paidForPeriod || 0);
        const paidMonth = Number(s.paidInMonth || 0);
        const remaining = Number(s.remaining || 0);
        const overdueCount = Number(s.overdueCount || 0);
        const overdueAmount = Number(s.overdueAmount || 0);
        const todayCount = Number(s.todayCount || 0);
        const todayAmount = Number(s.todayAmount || 0);
        const unsetCount = Number(s.unsetCount || 0);
        const partialCount = Number(s.partialCount || 0);
        const activeStaffCount = Number(s.activeStaffCount || 0);
        const inactiveStaffCount = Number(s.inactiveStaffCount || 0);
        const pctPaid = planned > 0 ? Math.min(100, Math.round((paidPeriod / planned) * 100)) : 0;

        el.innerHTML = `
      <div class="salary-stat-card" style="--accent-color:#f97316">
        <div class="salary-stat-icon" style="background:rgba(249,115,22,.12);color:#fb923c"><i class="fas fa-money-bill-trend-up"></i></div>
        <div class="salary-stat-num">${formatMoney(planned)}</div>
        <div class="salary-stat-label">Rejalashtirilgan fond</div>
        <div class="salary-stat-sub">${activeStaffCount} faol xodim${unsetCount ? ` · ${unsetCount} ta maosh belgilanmagan` : ''}${inactiveStaffCount ? ` · ${inactiveStaffCount} nofaol` : ''}</div>
      </div>
      <div class="salary-stat-card" style="--accent-color:#22c55e">
        <div class="salary-stat-icon" style="background:rgba(34,197,94,.12);color:#4ade80"><i class="fas fa-check-double"></i></div>
        <div class="salary-stat-num">${formatMoney(paidPeriod)}</div>
        <div class="salary-stat-label">Haqiqiy to'langan (davr uchun)</div>
        <div class="salary-stat-sub">Bajarilish: ${pctPaid}% · to'lov sanasi shu oyda: ${formatMoney(paidMonth)}</div>
      </div>
      <div class="salary-stat-card" style="--accent-color:#8b5cf6">
        <div class="salary-stat-icon" style="background:rgba(139,92,246,.12);color:#a78bfa"><i class="fas fa-scale-balanced"></i></div>
        <div class="salary-stat-num">${formatMoney(remaining)}</div>
        <div class="salary-stat-label">To'lanishi qolgan</div>
        <div class="salary-stat-sub">${partialCount ? partialCount + ' ta qisman to\'langan' : 'Qisman to\'lov yo\'q'}</div>
      </div>
      <div class="salary-stat-card" style="--accent-color:#3b82f6">
        <div class="salary-stat-icon" style="background:rgba(59,130,246,.12);color:#60a5fa"><i class="fas fa-bell"></i></div>
        <div class="salary-stat-num">${todayCount} ta</div>
        <div class="salary-stat-label">Bugun to'lanishi kerak</div>
        <div class="salary-stat-sub">${formatMoney(todayAmount)}</div>
      </div>
      <div class="salary-stat-card" style="--accent-color:#ef4444">
        <div class="salary-stat-icon" style="background:rgba(239,68,68,.12);color:#f87171"><i class="fas fa-triangle-exclamation"></i></div>
        <div class="salary-stat-num">${overdueCount} ta</div>
        <div class="salary-stat-label">Kechikkan to'lovlar</div>
        <div class="salary-stat-sub">${formatMoney(overdueAmount)}</div>
      </div>
    `;

        // Yon paneldagi shoshilinch hisoblagich
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

        const sub = document.getElementById('salary-subtitle');
        if (sub) {
            sub.textContent = `Davr: ${monthValueLabel(currentMonth)} · ${activeStaffCount} faol xodim`
                + (unsetCount ? ` · ${unsetCount} ta maosh belgilanmagan` : '')
                + (inactiveStaffCount ? ` · ${inactiveStaffCount} nofaol` : '');
        }
    }

    // ── RENDER TABLE ───────────────────────────────────────────
    function renderTable() {
        const list = getFiltered();
        const tbody = document.getElementById('salaryTableBody');
        if (!tbody) return;

        if (loading) {
            tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--text-muted)">
        <i class="fas fa-spinner fa-spin" style="font-size:26px"></i>
        <p style="font-weight:600;margin-top:10px">Yuklanmoqda...</p></td></tr>`;
            return;
        }

        if (loadError) {
            tbody.innerHTML = `<tr><td colspan="11" role="alert" style="text-align:center;padding:40px;color:var(--danger)">
              <i class="fas fa-triangle-exclamation" style="font-size:26px"></i>
              <p style="font-weight:700;margin-top:10px">Maosh jadvalini yuklab bo'lmadi</p>
              <p style="font-size:12px;margin-top:6px">${escapeHTML(loadError)}</p>
              <button class="btn btn-outline btn-sm" style="margin-top:12px" onclick="SalaryModule.render()">
                <i class="fas fa-rotate"></i> Qayta urinish
              </button></td></tr>`;
            return;
        }

        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="font-size:40px;margin-bottom:12px;opacity:.2">💰</div>
        <p style="font-weight:600">Ma'lumot topilmadi</p>
        <p style="font-size:12px;margin-top:6px">Tanlangan davr va holat filtrida xodim topilmadi. Filtrlarni o'zgartiring.</p>
      </td></tr>`;
            return;
        }

        tbody.innerHTML = list.map((row, idx) => {
            const status = row.status || 'unset';
            const days = daysUntil(row.dueDate);
            const rowClass = status === 'today' ? 'salary-row-today'
                : status === 'overdue' ? 'salary-row-overdue'
                    : status === 'paid' ? 'salary-row-paid' : '';

            const dueText = status === 'unset' ? 'Maosh belgilanmagan'
                : status === 'paid' ? '✓ To\'landi'
                    : days === null ? '—'
                        : days < 0 ? `${Math.abs(days)} kun kechikdi`
                            : days === 0 ? '⚡ Bugun'
                                : `${days} kun qoldi`;

            const avatarLetter = String(row.name || '?').trim()[0] || '?';
            const avatarGrad = ROLE_COLORS[String(row.role || '').toLowerCase()]
                || 'linear-gradient(135deg,#64748b,#475569)';

            const dueHtml = row.hasSalary
                ? `<strong>${formatMoney(row.due || 0)}</strong>`
                : '<span style="color:var(--text-muted)">—</span>';
            const paidHtml = Number(row.paid) > 0
                ? `<strong style="color:#4ade80">${formatMoney(row.paid)}</strong>`
                : '<span style="color:var(--text-muted)">0 so\'m</span>';
            const remainingHtml = row.hasSalary
                ? `<strong style="color:${Number(row.remaining) > 0 ? 'var(--warning)' : 'var(--success)'}">${formatMoney(row.remaining || 0)}</strong>`
                : '<span style="color:var(--text-muted)">—</span>';

            return `<tr class="${rowClass}">
        <td data-label="#" style="color:var(--text-muted);font-size:12px;font-weight:600">${idx + 1}</td>
        <td data-label="Xodim">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:38px;height:38px;border-radius:11px;background:${avatarGrad};display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:white;flex-shrink:0">${escapeHTML(avatarLetter)}</div>
            <div>
              <div style="font-weight:700;font-size:13px">${escapeHTML(row.name || '—')}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:1px">ID: ${escapeHTML(String(row.staffId))} · ${escapeHTML(PAY_METHOD_SHORT[row.method] || row.method || '')}</div>
            </div>
          </div>
        </td>
        <td data-label="Rol">
          <span class="badge badge-blue" style="font-size:11px">${escapeHTML(ROLE_LABELS[row.role] || row.role || '—')}</span>
        </td>
        <td data-label="Belgilangan oylik maosh">
          ${row.hasSalary
                    ? `<span style="font-weight:800;color:var(--primary);font-size:14px">${salaryText(row.salary)}</span>`
                    : '<span class="boss-salary-unset">Belgilanmagan</span>'}
        </td>
        <td data-label="Hisoblash davri">${escapeHTML(monthValueLabel(currentMonth))}</td>
        <td data-label="To'lanishi kerak">${dueHtml}</td>
        <td data-label="To'langan">${paidHtml}</td>
        <td data-label="Qolgan">${remainingHtml}</td>
        <td data-label="Keyingi to'lov sanasi">
          <div style="font-weight:600;font-size:13px">${formatDate(row.nextPayDate || row.dueDate)}</div>
          <div style="font-size:11px;color:${status === 'overdue' ? 'var(--danger)' : status === 'today' ? '#60a5fa' : 'var(--text-muted)'};margin-top:2px;font-weight:600">${dueText}</div>
        </td>
        <td data-label="Holat">${statusLabel(status)}</td>
        <td data-label="Amallar">
          <div style="display:flex;gap:6px">
            ${row.active && row.hasSalary ? (status !== 'paid' ? `
            <button class="btn btn-success btn-sm" onclick="SalaryModule.openPayModal(${row.staffId})" title="To'lash">
              <i class="fas fa-check"></i> To'lash
            </button>` : `
            <button class="btn btn-outline btn-sm" onclick="SalaryModule.openPayModal(${row.staffId})" title="To'lov tarixi">
              <i class="fas fa-eye"></i>
            </button>`) : ''}
            <button class="btn btn-outline btn-sm" onclick="SalaryModule.openEditModal(${row.staffId})" title="Maoshni sozlash">
              <i class="fas fa-edit"></i>
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

        if (loadError) {
            if (cnt) cnt.textContent = '';
            el.innerHTML = `<div role="alert" style="text-align:center;padding:24px;color:var(--danger)">
              To'lovlar tarixini yuklab bo'lmadi: ${escapeHTML(loadError)}
            </div>`;
            return;
        }

        if (cnt) cnt.textContent = `${totalPayments} ta to'lov`;

        if (payments.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:10px;opacity:.2">📋</div>
        <p>Hali to'lovlar amalga oshirilmagan</p>
      </div>`;
            return;
        }

        el.innerHTML = payments.slice(0, 20).map(p => {
            const who = p.staffName || (p.staffId ? ('ID: ' + p.staffId) : 'Noma\'lum xodim');
            const paidAtLabel = p.validPaidAt === false
                ? 'sana noto\'g\'ri' : formatDate(p.paidAt);
            const meta = `Hisob davri: ${p.periodLabel || '—'} · To\'lov sanasi: ${paidAtLabel}`
                + (p.linked ? '' : ' · xodim IDsi bilan bog\'lanmagan');
            return `
      <div class="salary-history-item">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          <div style="width:32px;height:32px;border-radius:9px;background:rgba(34,197,94,.12);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">✓</div>
          <div style="min-width:0">
            <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHTML(who)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${escapeHTML(meta)}</div>
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-weight:800;color:#4ade80;font-size:13px">${formatMoney(p.amount)}</div>
          <div style="font-size:10px;color:var(--text-muted)">${escapeHTML(PAY_METHOD_SHORT[p.method] || p.method || '')}</div>
        </div>
      </div>
    `;
        }).join('');
    }

    // ── RENDER SALARY CHART ────────────────────────────────────
    function renderChart() {
        const ctx = document.getElementById('salaryHistoryChart');
        if (!ctx) return;
        if (salaryChart) { salaryChart.destroy(); salaryChart = null; }
        let errorEl = document.getElementById('salary-chart-load-error');
        if (loadError) {
            ctx.style.display = 'none';
            if (!errorEl) {
                errorEl = document.createElement('div');
                errorEl.id = 'salary-chart-load-error';
                errorEl.setAttribute('role', 'alert');
                errorEl.style.cssText = 'padding:32px;text-align:center;color:var(--danger)';
                ctx.parentElement?.appendChild(errorEl);
            }
            errorEl.textContent = 'To\'lovlar grafigini yuklab bo\'lmadi: ' + loadError;
            return;
        }
        if (errorEl) errorEl.remove();
        ctx.style.display = '';

        // To'lovlarni TO'LOV SANASI (paidAt) oyi bo'yicha guruhlaymiz.
        const byMonth = paymentTotalsByMonth;

        // Oxirgi 6 oy (yo'q oylar 0 bilan to'ldiriladi)
        const months = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const val = monthValue(d);
            months.push({ val, label: monthValueLabel(val) });
        }

        salaryChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: months.map(m => m.label),
                datasets: [{
                    label: 'To\'langan maosh (so\'m)',
                    data: months.map(m => byMonth[m.val] || 0),
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

    // ── OY TANLAGICHI (hisoblash davri) ────────────────────────
    function populateMonthFilter() {
        const sel = document.getElementById('salary-month-filter');
        if (!sel) return;
        const months = [];
        const now = new Date();
        for (let i = 0; i < 12; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const val = monthValue(d);
            months.push({ val, label: monthValueLabel(val) });
        }
        // Tanlangan davr ro'yxatda yo'q bo'lsa (masalan, kelasi oy uchun
        // rejalashtirilgan avans) — boshiga qo'shamiz.
        if (currentMonth && !months.some(m => m.val === currentMonth)) {
            months.unshift({ val: currentMonth, label: monthValueLabel(currentMonth) });
        }
        sel.innerHTML = months.map(m =>
            `<option value="${m.val}"${m.val === currentMonth ? ' selected' : ''}>${m.label}</option>`
        ).join('');
    }

    function populateBranchFilter() {
        const sel = document.getElementById('salary-branch-filter');
        if (!sel) return;
        const options = [{ id: '', name: 'Barcha filiallar' }, ...branchOptions];
        sel.innerHTML = options.map(branch =>
            `<option value="${escapeHTML(String(branch.id || ''))}">${escapeHTML(String(branch.name || branch.id || ''))}</option>`
        ).join('');
        sel.value = currentBranch;
    }

    // ── TO'LIQ QAYTA CHIZISH ───────────────────────────────────
    async function render() {
        if (!currentMonth) currentMonth = monthValue(new Date());
        await load();
        populateMonthFilter();
        populateBranchFilter();
        renderStats();
        renderTable();
        renderRecentPayments();
        renderChart();
    }

    // ── TO'LOV OYNASI ──────────────────────────────────────────
    /** To'lov oynasi: `staffId` — xodimning BARQAROR ID si (backend bilan
        bir xil ID fazosi). Ism/telefon bo'yicha moslashtirish YO'Q. */
    function openPayModal(staffId) {
        const row = rowById(staffId);
        if (!row) {
            showNotif('error', 'Xodim topilmadi', 'Ro\'yxatni yangilang va qayta urinib ko\'ring');
            return;
        }
        if (!row.active) {
            showNotif('error', 'Xodim nofaol', 'Nofaol xodimga maosh to\'lovi qayd etib bo\'lmaydi');
            return;
        }
        payingStaffId = Number(row.staffId);
        const status = row.status || 'unset';
        const roleKey = String(row.role || '').toLowerCase();
        const avatarGrad = ROLE_COLORS[roleKey] || 'linear-gradient(135deg,#64748b,#475569)';

        const avatarEl = document.getElementById('salary-modal-avatar');
        if (avatarEl) {
            avatarEl.textContent = String(row.name || '?').trim()[0] || '?';
            avatarEl.style.background = avatarGrad;
        }
        setText('salary-modal-name', row.name || '—');
        setText('salary-modal-role', ROLE_LABELS[roleKey] || row.role || '—');
        setHTML('salary-modal-status-badge', statusLabel(status));
        setHTML('salary-modal-amount', row.hasSalary
            ? formatMoney(row.salary)
            : '<span class="boss-salary-unset">Belgilanmagan</span>');

        // Uchta ALOHIDA tushuncha: hisoblash davri ≠ to'lov muddati ≠ to'lov sanasi.
        setText('salary-modal-cur-month', monthValueLabel(currentMonth));
        setText('salary-modal-cur-date', formatDate(row.dueDate));
        setHTML('salary-modal-cur-status', statusLabel(status));

        const due = row.hasSalary ? Number(row.salary || 0) : 0;
        const paid = Number(row.paid || 0);
        const remaining = row.hasSalary ? Number(row.remaining || 0) : 0;
        setHTML('salary-modal-total-due', row.hasSalary
            ? `<strong style="color:var(--primary)">${formatMoney(remaining)}</strong>`
            + (paid > 0
                ? `<small style="display:block;color:var(--text-muted);font-size:11px">`
                + `to'langan: ${formatMoney(paid)} / ${formatMoney(due)}</small>`
                : '')
            : '<span style="color:var(--text-muted)">Maosh belgilanmagan</span>');

        // To'lov sanasi (paidAt) — standart: bugun.
        const dateInput = document.getElementById('salary-modal-next-date');
        if (dateInput) dateInput.value = todayValue();

        // To'lov summasi — standart: qolgan summa (yoki to'liq oylik).
        const payAmtInput = document.getElementById('salary-modal-pay-amount');
        if (payAmtInput) {
            payAmtInput.value = '';
            const suggested = remaining > 0 ? remaining : due;
            payAmtInput.placeholder = suggested > 0
                ? String(Math.round(suggested)) : 'Standart maosh';
        }
        const noteInput = document.getElementById('salary-modal-note');
        if (noteInput) noteInput.value = '';

        const unsetHint = document.getElementById('salary-modal-unset-hint');
        if (unsetHint) unsetHint.style.display = row.hasSalary ? 'none' : '';

        setText('salaryModalTitle', (row.hasSalary && status === 'paid')
            ? 'To\'lov Tarixi' : 'Maosh To\'lash');
        const payBtn = document.getElementById('salary-pay-btn');
        if (payBtn) {
            payBtn.style.display = (row.hasSalary && status !== 'paid') ? '' : 'none';
            payBtn.disabled = false;
        }

        renderModalHistory(row.staffId);
        openModal('salaryPayModal');
    }

    /** To'lov oynasidagi mini tarix — xodimning `staffId` si bo'yicha. */
    function renderModalHistory(staffId) {
        const el = document.getElementById('salary-modal-history');
        if (!el) return;
        const row = rowById(staffId);
        const hist = (row && Array.isArray(row.history)) ? row.history : [];
        if (hist.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px">Hali to'lovlar yo'q</div>`;
            return;
        }
        el.innerHTML = hist.map(p => `
      <div class="salary-history-item">
        <div>
          <div style="font-weight:600;font-size:12px">${escapeHTML(p.periodLabel || '—')}</div>
          <div style="font-size:11px;color:var(--text-muted)">${p.validPaidAt === false ? 'Sana noto\'g\'ri' : formatDate(p.paidAt)} · ${escapeHTML(p.note || 'Izohsiz')}</div>
        </div>
        <span class="salary-badge salary-badge-paid">${formatMoney(p.amount)}</span>
      </div>
    `).join('');
    }

    /** To'lovni HAQIQIY tarzda qayd etadi (POST /api/boss/salary/pay).
        Pul faqat shu yerda (backendda) hisobdan chiqadi — natijada
        to'lov `Kirim-chiqim` modulida IKKI MARTA hisoblanmaydi. */
    async function markPaid() {
        const row = rowById(payingStaffId);
        if (!row) {
            showNotif('error', 'Xodim topilmadi', 'Oynani yopib qaytadan urinib ko\'ring');
            return;
        }
        if (!row.active) {
            showNotif('error', 'Xodim nofaol', 'Nofaol xodimga maosh to\'lovi qayd etib bo\'lmaydi');
            return;
        }
        if (!row.hasSalary) {
            showNotif('error', 'Maosh belgilanmagan', 'Avval xodimga oylik maosh belgilang');
            return;
        }
        const dateVal = document.getElementById('salary-modal-next-date')?.value || todayValue();
        const rawAmt = document.getElementById('salary-modal-pay-amount')?.value;
        const remaining = Number(row.remaining || 0);
        const due = Number(row.salary || 0);
        const amount = (rawAmt === '' || rawAmt === null || rawAmt === undefined)
            ? (remaining > 0 ? remaining : due)
            : Number(String(rawAmt).replace(/[^\d.]/g, ''));
        if (!Number.isFinite(amount) || amount <= 0) {
            showNotif('error', 'Xato!', 'To\'lov summasini kiriting');
            return;
        }
        const noteVal = validateSafeInput('Izoh', document.getElementById('salary-modal-note')?.value || '', 180);
        if (noteVal === null) return;

        const payBtn = document.getElementById('salary-pay-btn');
        if (payBtn) payBtn.disabled = true;
        try {
            const data = await apiRequest('/api/boss/salary/pay', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    staffId: row.staffId,
                    amount,
                    period: currentMonth,
                    paidAt: dateVal,
                    method: row.method || 'cash',
                    note: noteVal,
                }),
            });
            applyPlanResponse(data);
            if (typeof addLog === 'function') addLog('Maosh', `${row.name} — ${formatMoney(amount)} to'landi`);
            if (typeof playCheckout === 'function') playCheckout();
            showNotif('success', '✅ To\'lov amalga oshirildi!', `${row.name}: ${formatMoney(amount)}`);
            closeModal('salaryPayModal');
            await render();
            if (typeof Boss !== 'undefined' && Boss && typeof Boss.loadStaff === 'function') Boss.loadStaff();
        } catch (e) {
            showNotif('error', 'To\'lovni saqlab bo\'lmadi', (e && e.message) || 'Server xatosi');
            if (payBtn) payBtn.disabled = false;
        }
    }

    // ── MAOSH SOZLAMASI OYNASI ─────────────────────────────────
    /** Yangi xodim FAQAT xodimlar bo'limida qo'shiladi (yagona joy) —
        bu yerda takroriy «xodim qo'shish» formasi yaratilmaydi. */
    function openAddModal() {
        if (typeof Boss !== 'undefined' && Boss && typeof Boss.openAddStaff === 'function') {
            Boss.openAddStaff();
            return;
        }
        showNotif('info', 'Xodim qo\'shish',
            'Boshliq → Xodimlar bo\'limidagi «Xodim qo\'shish» tugmasidan foydalaning');
    }

    /** Mavjud xodimga oylik maosh / to'lov kuni / to'lov usulini belgilash. */
    function openEditModal(staffId) {
        const row = rowById(staffId);
        if (!row) {
            showNotif('error', 'Xodim topilmadi', 'Ro\'yxatni yangilang va qayta urinib ko\'ring');
            return;
        }
        editingStaffId = Number(row.staffId);
        const title = document.getElementById('salaryAddModalTitle');
        if (title) {
            title.innerHTML = '<i class="fas fa-money-bill-wave" '
                + 'style="color:var(--primary);margin-right:8px"></i>Oylik maoshni sozlash';
        }
        setText('sal-emp-name', row.name || '—');
        setText('sal-emp-meta', `${ROLE_LABELS[String(row.role || '').toLowerCase()] || row.role || '—'}`
            + ` · ID: ${row.staffId}`);
        const avatarEl = document.getElementById('sal-emp-avatar');
        if (avatarEl) {
            avatarEl.textContent = String(row.name || '?').trim()[0] || '?';
            avatarEl.style.background = ROLE_COLORS[String(row.role || '').toLowerCase()]
                || 'linear-gradient(135deg,#64748b,#475569)';
        }
        setVal('sal-amount', row.hasSalary ? Math.round(Number(row.salary)) : '');
        setVal('sal-pay-day', row.payDay || 1);
        setVal('sal-pay-method', row.method || 'cash');
        const hint = document.getElementById('sal-amount-hint');
        if (hint) {
            hint.textContent = row.hasSalary
                ? 'Hozirgi belgilangan oylik. Bo\'sh qoldirsangiz — o\'zgarmaydi.'
                : 'Maosh kiritilmasa xodim jadvalda «Belgilanmagan» holatida qoladi.';
        }
        openModal('salaryAddModal');
    }

    /** Maosh sozlamalarini backendga saqlaydi (PUT /api/boss/staff/<id>).
        Maosh, to'lov kuni va usul `staff_users` da (yagona manba) saqlanadi. */
    async function saveEmployee() {
        const row = rowById(editingStaffId);
        if (!row) {
            showNotif('error', 'Xodim topilmadi', 'Ro\'yxatni yangilang va qayta urinib ko\'ring');
            return;
        }
        const rawAmount = document.getElementById('sal-amount')?.value;
        const payDay = parseInt(document.getElementById('sal-pay-day')?.value, 10);
        const method = String(document.getElementById('sal-pay-method')?.value || 'cash')
            .trim().toLowerCase();
        if (!Number.isFinite(payDay) || payDay < 1 || payDay > 28) {
            showNotif('error', 'Xato!', 'To\'lov kuni 1 va 28 orasida bo\'lishi kerak');
            return;
        }
        const body = { salaryPayDay: payDay, salaryMethod: method };
        // Bo'sh qiymat = maoshni O'ZGARTIRMASLIK (backend maoshni null qabul qilmaydi).
        if (!(rawAmount === '' || rawAmount === null || rawAmount === undefined)) {
            const amount = Number(String(rawAmount).replace(/[^\d]/g, ''));
            if (!Number.isFinite(amount) || amount <= 0) {
                showNotif('error', 'Xato!', 'Maosh miqdori musbat son bo\'lishi kerak');
                return;
            }
            body.salary = amount;
        }
        const btn = document.querySelector('#salaryAddModal .btn-primary');
        if (btn) btn.disabled = true;
        try {
            await apiRequest('/api/boss/staff/' + encodeURIComponent(row.staffId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (typeof addLog === 'function') {
                addLog('Maosh', `"${row.name}" maosh sozlamalari yangilandi`);
            }
            showNotif('success', 'Saqlandi!', `${row.name} maosh sozlamalari yangilandi`);
            closeModal('salaryAddModal');
            await render();
            if (typeof Boss !== 'undefined' && Boss && typeof Boss.loadStaff === 'function') Boss.loadStaff();
        } catch (e) {
            showNotif('error', 'Saqlab bo\'lmadi', (e && e.message) || 'Server xatosi');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ── FILTR / QIDIRUV ────────────────────────────────────────
    function setFilter(f, btnEl) {
        currentFilter = f || 'all';
        document.querySelectorAll('.salary-filter-btn').forEach(b => b.classList.remove('active'));
        if (btnEl) btnEl.classList.add('active');
        renderTable();
    }

    async function applyBranchFilter() {
        const sel = document.getElementById('salary-branch-filter');
        const val = sel ? String(sel.value || '') : '';
        if (val !== currentBranch) {
            currentBranch = val;
            await render();
        }
    }

    /** Oy tanlagichi: hisoblash davri (period) o'zgarsa — backenddan
        qayta yuklaydi; aks holda faqat jadval qayta chiziladi. */
    async function applyFilter() {
        const sel = document.getElementById('salary-month-filter');
        const val = sel ? String(sel.value || '') : '';
        if (val && val !== currentMonth) {
            currentMonth = val;
            await render();
            return;
        }
        renderTable();
    }

    function search(q) {
        searchQuery = String(q || '');
        renderTable();
    }

    // ── EKSPORT CSV ────────────────────────────────────────────
    function exportCSV() {
        if (!planRows.length) {
            showNotif('info', 'Eksport', 'Eksport uchun ma\'lumot yo\'q');
            return;
        }
        const header = ['ID', 'Xodim', 'Rol', 'Oylik maosh', 'To\'lov muddati', 'Holat',
            'To\'langan (davr uchun)', 'Qoldiq', 'To\'lov usuli'];
        const rows = planRows.map(row => [
            row.staffId,
            row.name || '',
            ROLE_LABELS[String(row.role || '').toLowerCase()] || row.role || '',
            row.hasSalary ? Math.round(Number(row.salary)) : 'Belgilanmagan',
            row.dueDate || '',
            (STATUS_META[row.status] || {}).label || row.status || '',
            Math.round(Number(row.paid || 0)),
            row.hasSalary ? Math.round(Number(row.remaining || 0)) : '',
            PAY_METHOD_SHORT[row.method] || row.method || '',
        ]);
        const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `TexnoPark_Maosh_${monthValueLabel(currentMonth).replace(/\s+/g, '_')}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        showNotif('success', 'Eksport!', 'CSV fayl yuklandi');
    }

    // ── HELPERS ────────────────────────────────────────────────
    function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
    function setHTML(id, val) { const el = document.getElementById(id); if (el) el.innerHTML = val; }
    function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }

    // ── INIT ───────────────────────────────────────────────────
    /** Faqat holatni tayyorlaydi — ma'lumot backenddan sahifa ochilganda
        (`render()`) yuklanadi. Bu yerda API chaqirilmaydi (barcha rollar
        uchun ishga tushadi, `boss` huquqi esa faqat sahifada bo'ladi). */
    function init() {
        if (!currentMonth) currentMonth = monthValue(new Date());
    }

    // ── PUBLIC API ─────────────────────────────────────────────
    return {
        init, render, applyPlanResponse,
        openPayModal, markPaid, openAddModal, openEditModal,
        saveEmployee, setFilter, applyFilter, applyBranchFilter, search, exportCSV,
    };
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

/**
 * Development/test uchun eski (stale) frontend lock holatini xavfsiz tozalaydi.
 * PRODUCTION lockout mexanizmini o'chirmaydi — faqat `tp_login_guard` brauzer
 * kalitini tozalaydi. Konsoldan chaqirish mumkin:
 *   resetLoginLock('+998901234554')  — bitta telefon uchun
 *   resetLoginLock()                 — barcha urlanishlar uchun
 */
function resetLoginLock(loginKey) {
    const store = loginGuardStore();
    const key = String(loginKey || '').toLowerCase();
    if (key) delete store[key];
    else Object.keys(store).forEach(k => delete store[k]);
    saveLoginGuardStore(store);
    return Object.keys(store).length;
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

    /** Sahifa yangilanganda amaldagi sessiyani tiklaydi.
     *  Lokal muddatdan tashqari SERVER tokeni (tp_token) ham tekshiriladi:
     *  401 qaytsa (token eskirgan yoki sessiya bekor qilingan) sessiya
     *  tiklanmaydi — foydalanuvchi to'g'ridan-to'g'ri login ekranga qoladi.
     *  Server javob bermasa (oflayn) — lokal sessiya ishoniladi. */
    async restoreSession() {
        if (currentUser) return;
        const sess = safeJsonParse(sessionStorage.getItem(SESSION_KEY) || 'null', null);
        if (!sess || !sess.login || !sess.expiresAt) return;
        if (Number(sess.expiresAt) <= Date.now()) {
            try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
            securityLog('session-expired', 'low', 'Saqlangan sessiya muddati tugagan — qayta kirish talab qilinadi');
            return;
        }
        // Server tokeni yo'q bo'lsa lokal sessiyani TIKLAMAYMIZ: aks holda
        // foydalanuvchi "kirgan" ko'rinadi, lekin har bir amal 401 beradi
        // ("Avtorizatsiya talab qilinadi") — xodim qo'shish kabi amallar
        // shu sababdan bajarilmay qolardi. Qayta kirish talab qilinadi.
        if (!staffToken) {
            try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
            return;
        }
        // Server sessiyasi: rol/filial token bilan tasdiqlanadi (quyida).
        let serverRole = '';
        let serverBranchId = '';
        if (staffToken && navigator.onLine !== false) {
            try {
                const res = await fetchWithTimeout('/api/auth/session', { headers: authHeaders() }, 5000);
                if (res.status === 401) {
                    clearStaffToken();
                    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
                    securityLog('session-expired', 'low', 'Server tokeni eskirgan — qayta kirish talab qilinadi');
                    showNotif('warning', 'Sessiya tugadi', 'Xavfsizlik uchun qaytadan kiring');
                    return;
                }
                // Server sessiyasi javobi: rol va filial AVVAL shu yerdan olinadi
                // (token bilan tasdiqlangan) — lokal ro'yxat eskirgan bo'lsa ham
                // huquqlar serverga mos bo'ladi.
                if (res.ok) {
                    const data = await res.json().catch(() => null);
                    const srvRole = normalizeRole(data?.user?.role);
                    if (srvRole && (ROLE_RANK[srvRole] || 0) > 0) serverRole = srvRole;
                    serverBranchId = String(data?.user?.branchId || '').trim().slice(0, 40);
                }
            } catch (e) { /* oflayn rejim — lokal sessiya ishoniladi */ }
        }
        const user = findBaseUser(sess.login);
        if (!user) return;
        currentUser = serverRole
            ? { ...user, role: serverRole, branchId: serverBranchId }
            : user;
        currentSession = sess;
        loginWithUser(currentUser);
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

    /** Sessiyani boshlash (doLogin uchun) */
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
            if (res.status === 401) {
                handleSessionExpired();
                if (summary) summary.textContent = 'Sessiya tugadi — tizimga qaytadan kiring.';
                return;
            }
            if (res.status === 403) {
                if (summary) summary.textContent = 'Ruxsat yo\'q.';
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
                : `<button class="btn btn-danger" onclick="Security.revokeSession('${jsStrAttr(String(s.jti || ''))}')"><i class="fas fa-power-off"></i> Yopish</button>`}</td>
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
    // Barcha himoyalangan /api chaqiriqlariga avtomatik token (polling/create 401 bo'lmasligi uchun)
    const opts = Object.assign({}, options || {});
    opts.headers = authHeaders(opts.headers || {});
    let res;
    try {
        res = await fetchWithTimeout(path, opts, API_TIMEOUT_MS);
    } catch (e) {
        const nm = (e && e.name) || '';
        if (nm === 'AbortError') {
            throw new Error('Server javob bermadi (vaqt tugadi) — qayta urinib ko\'ring');
        }
        throw new Error('Serverga ulanib bo\'lmadi — internet aloqasini tekshiring');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) throw new Error((data && data.message) || ('Server xatosi (' + res.status + ')'));
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
            return {
                ok: false, fiscalStatus: 'payment_not_confirmed',
                fiscalError: 'To\'lov tasdiqlanmaguncha fiskal chek chiqarilmaydi'
            };
        }
        if (sale.fiscalSign && sale.fiscalUrl && !opts.force) {
            return {
                ok: true, fiscalUrl: sale.fiscalUrl, fiscalSign: sale.fiscalSign,
                fiscalNumber: sale.fiscalNumber, cached: true
            };
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
            return {
                ok: false, reason: 'Fiskal modul sozlanmagan (.env: FISCAL_PROVIDER, FISCAL_API_URL, ' +
                    'FISCAL_SECRET_KEY) — QR-kodsiz chek chop etilmaydi'
            };
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
            new QRCode(holder, {
                text: String(text), width: 220, height: 220,
                correctLevel: QRCode.CorrectLevel.M
            });
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
                headers: authHeaders({ 'Content-Type': 'application/json' }),
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
// MUHIM: CONTRACT_STATUS `contracts` dan OLDIN e'lon qilinishi shart —
// aks holda saqlangan shartnoma bo'lganda butun skript yuklanmay qoladi
// (Cannot access 'CONTRACT_STATUS' before initialization).
const CONTRACT_STATUS = {
    active: { label: 'Faol', badge: 'badge-green' },
    expiring: { label: 'Muddati yaqin', badge: 'badge-yellow' },
    expired: { label: "Muddati o'tgan", badge: 'badge-red' },
    cancelled: { label: 'Bekor qilingan', badge: 'badge-gray' }
};

let contracts = safeJsonParse(localStorage.getItem('tp_contracts') || 'null', null);
if (!Array.isArray(contracts)) contracts = [];
try {
    contracts = contracts.map(normalizeContract).filter(c => c && c.customer);
} catch (e) {
    console.warn('Saqlangan shartnomalarni o\'qib bo\'lmadi:', e);
    contracts = [];
}
let contractsSyncTimer = null;
let editingContractId = null;

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

/**
 * Chekdagi mijoz matnidan faqat ismni ajratadi:
 *   "Ali Valiyev +998901112233" → "ali valiyev"
 * Telefon belgilari olib tashlanadi va kichik harflarga o'giriladi.
 */
function receiptCustomerName(text) {
    return String(text || '')
        .replace(/[+\d][\d\s()\-]{5,}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
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
        photo: safeImageUrl(c.photo || ''),   // mijoz rasmi — faqat ekranda, chop etilmaydi
        printed: Math.max(0, Number(c.printed) || 0),
        baseAmount: Math.max(0, Number(c.baseAmount) || 0),
        prepay: Math.max(0, Number(c.prepay) || 0),
        months: Math.min(36, Math.max(0, Math.floor(Number(c.months) || 0))),
        payDay: Math.min(28, Math.max(1, Math.floor(Number(c.payDay) || 0) || new Date(start + 'T00:00:00').getDate() || 1))
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

/**
 * «Yangi shartnoma (qo'lda)» formasida mijoz ro'yxatdan (datalist) tanlanganda
 * telefon raqamini avtomatik to'ldiradi.
 *
 * Qoidalar:
 *   • Mijozlar bazasida ism aynan mos kelsa — o'sha mijozning raqami;
 *   • topilmasa — chek/izohdagi raqam ajratib olinadi (`extractPhone`);
 *   • raqam topilmasa (yoki boshqa mijoz tanlansa va u raqamsiz bo'lsa)
 *     ilgari AVTOMATIK to'ldirilgan qiymat tozalanadi — boshqa mijozning
 *     raqami shartnomada qolib ketmasligi uchun;
 *   • foydalanuvchi QO'LDA yozgan raqam hech qachon ustidan yozilmaydi
 *     va o'chirilmaydi (faqat avtomatik to'ldirilgan qiymat o'zgaradi).
 */
function autofillContractPhone() {
    const nameEl = document.getElementById('ct-customer');
    const phoneEl = document.getElementById('ct-phone');
    if (!nameEl || !phoneEl) return;
    const typed = cleanText(nameEl.value, 120).trim();
    if (!typed) return;
    const key = typed.toLowerCase();
    const match = (customers || []).find(c => String(c.name || '').trim().toLowerCase() === key);
    let phone = match ? (normalizePhoneUz(match.phone) || cleanText(match.phone, 40)) : '';
    if (!phone) {
        // Mijozlar bazasida yo'q — chek (savdo) yozuvidagi raqamni olamiz.
        // Chekda mijoz "Ism +998..." ko'rinishida saqlanadi: ismni
        // raqamdan ajratib solishtiramiz, raqamni esa chekdan olamiz.
        const sale = (salesHistory || []).find(s =>
            receiptCustomerName(s.customer) === key);
        const raw = extractPhone(sale ? sale.customer : typed);
        phone = normalizePhoneUz(raw) || raw;
    }
    const autoFilled = phoneEl.dataset.autoPhone || '';
    // Qo'lda kiritilgan raqam daxlsiz
    if (phoneEl.value && phoneEl.value !== autoFilled) return;
    if (!phone) {
        // Ism o'zgardi, lekin raqam aniqlanmadi — eski avtomatik raqam
        // boshqa mijozniki bo'lishi mumkin, shuning uchun tozalanadi
        if (autoFilled) {
            phoneEl.value = '';
            delete phoneEl.dataset.autoPhone;
        }
        return;
    }
    if (phoneEl.value === phone) return;
    phoneEl.value = phone;
    phoneEl.dataset.autoPhone = phone;
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
    set('ct-base', String(Number(sale.total) || 0));
    updateContractInstCalc();
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
        baseAmount: sale?.total,
        months: 0,
        prepay: 0,
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
        this.bindCustomerPhoneAutofill();
    },

    /**
     * Mijoz F.I.Sh maydoniga «telefon avtomatik to'ldirish» ni bog'laydi.
     * Bir marta bog'lanadi (datalist'dan tanlash `input`/`change` hodisasini
     * beradi) — qo'lda shartnoma ham, tahrirlash oynasi ham bir xil ishlaydi.
     */
    bindCustomerPhoneAutofill() {
        const modal = document.getElementById('contractModal');
        if (!modal || modal.dataset.phoneAutofillBound === '1') return;
        modal.dataset.phoneAutofillBound = '1';
        const onPick = e => { if (e.target && e.target.id === 'ct-customer') autofillContractPhone(); };
        modal.addEventListener('input', onPick);
        modal.addEventListener('change', onPick);
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
        const candidates = salesHistory.filter(s => isPaidSale(s) && Number(s.total) > 0 && !existing.has(Number(s.id)));
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
        const canManage = canManageContracts();   // admin + menejer + Boshliq: tuzadi/tahrirlaydi
        const isAdmin = isMainAdmin() || isBoss();   // o'chirish: asosiy admin yoki BOSHLIQ
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
        // Shartnoma tuzish: asosiy admin, admin va menejer
        if (!requireRole('admin', 'manager')) return;
        editingContractId = null;
        ensureContractInstallmentFields();
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
        set('ct-base', '');
        set('ct-prepay', '0');
        set('ct-months', '0');
        set('ct-payday', '');
        try { ensureContractPhotoField(); setContractPhoto(''); } catch (e) { console.warn('Shartnoma rasm maydoni:', e); }
        updateContractInstCalc();
        const typeSel = document.getElementById('ct-type');
        if (typeSel) {
            typeSel.innerHTML = CONTRACT_TYPES.map(t => `<option>${escapeHTML(t)}</option>`).join('');
            typeSel.value = 'Xizmat ko\'rsatish shartnomasi';
        }
        try { populateContractEditSources(); } catch (e) { console.warn('Shartnoma ro\'yxatlari:', e); }
        openModal('contractModal');
    },

    edit(id) {
        if (!requireRole('admin', 'manager')) return;
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        editingContractId = c.id;
        ensureContractInstallmentFields();
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
        set('ct-base', String(c.baseAmount || ''));
        set('ct-prepay', String(c.prepay || 0));
        set('ct-months', String(c.months || 0));
        set('ct-payday', c.months ? String(c.payDay || '') : '');
        try { ensureContractPhotoField(); setContractPhoto(c.photo || ''); } catch (e) { console.warn('Shartnoma rasm maydoni:', e); }
        updateContractInstCalc();
        openModal('contractModal');
    },
    /** Qo'lda kiritilgan shartnomani saqlaydi (faqat administrator) */
    save() {
        if (!requireRole('admin', 'manager')) return;
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
        const baseAmount = Math.max(0, Number(document.getElementById('ct-base')?.value) || 0) || amount;
        const prepay = Math.min(amount, Math.max(0, Number(document.getElementById('ct-prepay')?.value) || 0));
        const months = Math.min(36, Math.max(0, Math.floor(Number(document.getElementById('ct-months')?.value) || 0)));
        const payDay = Math.min(28, Math.max(1, Math.floor(Number(document.getElementById('ct-payday')?.value) || 0) || Number(start.slice(8, 10)) || 1));
        const photo = safeImageUrl(document.getElementById('ct-photo')?.value || '');
        const finalType = months > 0 ? 'Muddatli to\'lov shartnomasi' : type;

        if (editingContractId) {
            const c = contracts.find(x => Number(x.id) === Number(editingContractId));
            if (!c) return;
            Object.assign(c, {
                customer, phone, type: finalType, amount, subject, note, photo,
                baseAmount, prepay, months, payDay,
                warrantyMonths: warranty, startDate: start, endDate,
                status: c.status === 'cancelled' ? 'cancelled' : contractStatusFor(endDate)
            });
            addLog('Shartnoma', `${c.number} tahrirlandi`);
            showNotif('success', 'Saqlandi!', `${c.number} yangilandi`);
        } else {
            const contract = normalizeContract({
                id: Date.now(),
                number: nextContractNumber(),
                type: finalType, customer, phone, subject, amount, photo,
                baseAmount, prepay, months, payDay,
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
        const canManage = canManageContracts();
        const isAdmin = currentUser?.role === 'admin' || isBoss();   // bekor qilish: adminlar va BOSHLIQ
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
        ${c.photo ? `<div class="ct-photo-noprint" title="Chop etilmaydi"><img src="${escapeHTML(c.photo)}" alt="Mijoz rasmi" style="width:64px;height:64px;border-radius:12px;object-fit:cover;border:1px solid var(--border);cursor:zoom-in" onclick="window.open(this.src,'_blank')"></div>` : ''}
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
        ${c.months ? `<div><span class="cv-label">Ustamasiz narx</span><b>${fmt(c.baseAmount || c.amount)} so'm</b></div>
        <div><span class="cv-label">Bo'lib to'lash</span><b>${c.months} oy × ${fmt(contractSchedule(c).monthly)} so'm</b></div>
        <div><span class="cv-label">To'lov kuni</span><b>Har oyning ${contractSchedule(c).payDay}-kuni</b></div>` : ''}
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
        area.querySelectorAll('img.ct-photo-noprint, .ct-photo-noprint').forEach(el => el.remove());   // mijoz rasmi chop etilmaydi
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
        if (!(isMainAdmin() || isBoss())) {
            playError();
            showNotif('error', 'Ruxsat yo\'q!', 'Shartnomani faqat asosiy admin yoki Boshliq o\'chira oladi');
            securityLog('access-denied', 'medium',
                `Shartnomani o'chirishga urinish: ${currentUser?.login || 'mehmon'} (${currentUser?.role || '-'})`);
            return;
        }
        const c = contracts.find(x => Number(x.id) === Number(id));
        if (!c) return;
        if (!confirm(`${c.number} shartnomasini butunlay o'chirmoqchimisiz?`)) return;
        contracts = contracts.filter(x => Number(x.id) !== Number(id));
        saveContracts();
        addLog('Shartnoma', `${c.number} o'chirildi (${c.customer}) — asosiy admin: ${currentUser?.name || ''}`);
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
// Himoya: shartnoma oynalari ichida kutilmagan xato bo'lsa ham oyna ochiladi,
// xato sababi esa ekranda ko'rsatiladi (jim qolib ketmaydi).
['openAddModal', 'edit', 'view'].forEach(name => {
    const orig = Contracts[name];
    Contracts[name] = function () {
        try { return orig.apply(this, arguments); }
        catch (e) {
            console.error('Contracts.' + name + ':', e);
            showNotif('error', 'Shartnoma oynasida xatolik', String(e && e.message || e).slice(0, 140));
            const m = document.getElementById(name === 'view' ? 'contractViewModal' : 'contractModal');
            if (m && !m.classList.contains('open')) openModal(m.id);
        }
    };
});

/* ============================================================
 * YAGONA SHARTNOMA SHABLONI — barcha shartnomalar shu hujjatda chiqadi.
 * Sotuvchi / ta'minotchi nomi faqat: TEXNO PARK №1
 *   1-bet: To'lovlar jadvali      2-bet: Hisob-faktura (yuk xati)
 * ============================================================ */
const CONTRACT_COMPANY = 'TEXNO PARK №1';
const CONTRACT_COMPANY_LEGAL = '«TEXNO PARK №1» MChJ';

/** Summani so'z bilan yozadi (o'zbekcha): 1500000 -> "bir million besh yuz ming" */
function numToWordsUz(num) {
    let n = Math.floor(Math.abs(Number(num) || 0));
    if (!n) return 'nol';
    const ones = ['', 'bir', 'ikki', 'uch', 'to\'rt', 'besh', 'olti', 'yetti', 'sakkiz', 'to\'qqiz'];
    const tens = ['', 'o\'n', 'yigirma', 'o\'ttiz', 'qirq', 'ellik', 'oltmish', 'yetmish', 'sakson', 'to\'qson'];
    const scales = ['', 'ming', 'million', 'milliard', 'trillion'];
    const parts = [];
    let i = 0;
    while (n > 0 && i < scales.length) {
        const chunk = n % 1000;
        n = Math.floor(n / 1000);
        if (chunk) {
            const h = Math.floor(chunk / 100), t = Math.floor((chunk % 100) / 10), o = chunk % 10;
            const w = [];
            if (h) w.push(h > 1 ? ones[h] + ' yuz' : 'yuz');
            if (t) w.push(tens[t]);
            if (o) w.push(ones[o]);
            parts.unshift(w.join(' ') + (scales[i] ? ' ' + scales[i] : ''));
        }
        i++;
    }
    return parts.join(' ');
}

/** Hujjatdagi summa ko'rinishi: 1 500 000.00 */
function fmtDoc(n) {
    return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, ' ');
}

/**
 * To'lovlar jadvalini hisoblaydi.
 * months = 0  -> bo'lib to'lashsiz (to'liq to'lov), jadvalda bitta qator.
 * months > 0  -> 0-qator (boshlang'ich to'lov) + har oy teng to'lov, oxirgisi qoldiqni yopadi.
 */
function contractSchedule(c) {
    const total = Math.max(0, Number(c.amount) || 0);
    const prepay = Math.min(total, Math.max(0, Number(c.prepay) || 0));
    const months = Math.max(0, Math.floor(Number(c.months) || 0));
    const start = /^\d{4}-\d{2}-\d{2}$/.test(c.startDate) ? c.startDate : isoDate();
    if (!months) {
        return {
            total, prepay: 0, financed: total, months: 0, monthly: total, payDay: 0,
            rows: [{ n: 1, date: start, pay: total, left: 0 }]
        };
    }
    const financed = total - prepay;
    const sd = new Date(start + 'T00:00:00');
    const payDay = Math.min(28, Math.max(1, Math.floor(Number(c.payDay) || 0) || sd.getDate()));
    const base = Math.round(financed / months);
    const rows = [{ n: 0, date: start, pay: prepay, left: financed }];
    let left = financed;
    for (let i = 1; i <= months; i++) {
        const pay = i === months ? left : Math.min(left, base);
        left = Math.round((left - pay) * 100) / 100;
        rows.push({ n: i, date: isoDate(new Date(sd.getFullYear(), sd.getMonth() + i, payDay)), pay, left });
    }
    const monthly = Math.max(...rows.slice(1).map(r => r.pay));
    return { total, prepay, financed, months, monthly, payDay, rows };
}

/** Shartnoma formasiga bo'lib to'lash maydonlarini (bir marta) qo'shadi */
function ensureContractInstallmentFields() {
    if (document.getElementById('ct-inst-block')) return;
    const anchor = document.getElementById('ct-subject')?.closest('.form-col');
    if (!anchor || !anchor.parentNode) return;
    const amountLabel = document.getElementById('ct-amount')?.closest('.form-col')?.querySelector('label');
    if (amountLabel) amountLabel.textContent = 'Jami summa — ustama bilan (so\'m)';
    const block = document.createElement('div');
    block.id = 'ct-inst-block';
    block.innerHTML = `
      <div class="form-row">
        <div class="form-col"><label>Ustamasiz narx (so'm)</label>
          <input type="number" class="form-control" id="ct-base" min="0" placeholder="1500000" oninput="updateContractInstCalc()"></div>
        <div class="form-col"><label>Boshlang'ich to'lov (so'm)</label>
          <input type="number" class="form-control" id="ct-prepay" min="0" value="0" oninput="updateContractInstCalc()"></div>
      </div>
      <div class="form-row">
        <div class="form-col"><label>Bo'lib to'lash muddati</label>
          <select class="form-control" id="ct-months" onchange="updateContractInstCalc()">
            <option value="0">Bo'lib to'lashsiz (to'liq to'lov)</option>
            ${[3, 6, 9, 12, 18, 24].map(m => `<option value="${m}">${m} oy</option>`).join('')}
          </select></div>
        <div class="form-col"><label>Oylik to'lov kuni (1–28)</label>
          <input type="number" class="form-control" id="ct-payday" min="1" max="28" placeholder="27" oninput="updateContractInstCalc()"></div>
      </div>
      <small id="ct-inst-calc" style="display:block;color:var(--text-muted);font-size:11px;margin-bottom:12px"></small>`;
    anchor.parentNode.insertBefore(block, anchor);
    document.getElementById('ct-amount')?.addEventListener('input', updateContractInstCalc);
}

/** Shartnoma formasiga «Mijoz rasmi» maydonini qo'shadi (chop etishda chiqmaydi). */
function ensureContractPhotoField() {
    if (document.getElementById('ct-photo-block')) return;
    const anchor = document.getElementById('ct-note')?.closest('.form-col');
    if (!anchor || !anchor.parentNode) return;
    const block = document.createElement('div');
    block.id = 'ct-photo-block';
    block.className = 'form-col';
    block.style.marginBottom = '14px';
    block.innerHTML = `
      <label>Mijoz rasmi (ixtiyoriy)</label>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <div id="ct-photo-preview" style="width:72px;height:72px;border-radius:12px;border:1px solid var(--border);background:var(--bg);display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--text-muted);font-size:11px">Rasm yo'q</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button type="button" class="btn btn-outline btn-sm" id="ct-photo-btn" onclick="document.getElementById('ct-photo-file').click()"><i class="fas fa-camera"></i> Rasm yuklash</button>
          <button type="button" class="btn btn-outline btn-sm" id="ct-photo-del" style="display:none;color:var(--danger)" onclick="removeContractPhoto()"><i class="fas fa-trash"></i> Olib tashlash</button>
        </div>
        <input type="file" id="ct-photo-file" accept="image/*" style="display:none" onchange="uploadContractPhoto(this)">
        <input type="hidden" id="ct-photo">
      </div>
      <small style="color:var(--text-muted);font-size:11px">Rasm faqat tizimda saqlanadi va ko'rinadi — shartnoma chop etilganda qog'ozda chiqmaydi.</small>`;
    anchor.parentNode.insertBefore(block, anchor);
}

function setContractPhoto(src) {
    const safe = src ? safeImageUrl(src) : '';
    const hid = document.getElementById('ct-photo'); if (hid) hid.value = safe;
    const box = document.getElementById('ct-photo-preview');
    if (box) box.innerHTML = safe ? `<img src="${escapeHTML(safe)}" alt="Mijoz" style="width:100%;height:100%;object-fit:cover">` : "Rasm yo'q";
    const del = document.getElementById('ct-photo-del'); if (del) del.style.display = safe ? '' : 'none';
}

function removeContractPhoto() { setContractPhoto(''); }

async function uploadContractPhoto(input) {
    if (!requireRole('admin', 'manager')) return;
    const file = input?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { playError(); showNotif('error', 'Xato!', 'Faqat rasm fayl yuklang'); input.value = ''; return; }
    if (file.size > 12 * 1024 * 1024) { playError(); showNotif('error', 'Xato!', 'Rasm hajmi 12MB dan oshmasin'); input.value = ''; return; }
    const btn = document.getElementById('ct-photo-btn');
    const prev = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Yuklanmoqda'; }
    try {
        const up = await uploadToStorage(file, 'contracts');
        if (up.ok && up.url) setContractPhoto(up.url);
        else setContractPhoto(await compressImageFile(file, 600, 0.7));   // zaxira: siqib bazaga
        playSuccess();
    } catch (e) {
        console.error('Shartnoma rasmi:', e);
        playError();
        showNotif('error', 'Yuklanmadi!', e?.message || "Rasmni qayta ishlab bo'lmadi");
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = prev; }
        input.value = '';
    }
}

function updateContractInstCalc() {
    const el = document.getElementById('ct-inst-calc');
    if (!el) return;
    const num = id => Number(document.getElementById(id)?.value) || 0;
    const amount = num('ct-amount'), base = num('ct-base'), months = num('ct-months'), prepay = num('ct-prepay');
    if (!months) {
        el.textContent = 'To\'liq to\'lov — hujjat baribir shu shablonda chiqadi (jadvalda bitta qator).';
        return;
    }
    const fin = Math.max(0, amount - prepay);
    const pct = base > 0 ? ((amount - base) / base * 100).toFixed(1) + '%' : '—';
    el.textContent = `Majburiyat: ${fmt(fin)} so'm · Oylik: ${fmt(Math.round(fin / months))} so'm × ${months} oy · Ustama: ${pct}`;
}

/** Chop etish uchun yagona hujjat (A4): To'lovlar jadvali + Hisob-faktura */
function buildContractPrintHTML(c) {
    const esc = escapeHTML;
    const S = contractSchedule(c);
    const dateStr = fmtDateISO(c.startDate);
    const val = id => cleanText(document.getElementById(id)?.value, 200);
    const addr = val('companyAddress'), tin = val('companyTin'), phone = val('companyPhone');
    const vatRate = Number(document.getElementById('taxRate')?.value) || 12;
    const base = Number(c.baseAmount) > 0 ? Number(c.baseAmount) : (Number(c.amount) || 0);

    // Tovarlar ro'yxati (chekdan yoki qo'lda kiritilgan predmet)
    const items = (c.items || []).filter(i => i && i.name);
    const itemsSum = items.reduce((s, i) => s + i.price * i.qty, 0);
    const useItems = items.length > 0 && (!Number(c.baseAmount) || Math.abs(itemsSum - base) < 1);
    const goods = useItems
        ? items.map(i => ({ name: i.name, qty: i.qty, gross: i.price * i.qty }))
        : [{ name: c.subject || c.type || '—', qty: 1, gross: base }];

    // ---- 1-bet: To'lovlar jadvali ----
    const half = Math.ceil(S.rows.length / 2);
    const schedTable = rows => rows.length ? `
      <table class="tp-ct-t">
        <thead><tr><th>№</th><th>To'lov sanasi</th><th>To'lov summasi, so'm</th><th>Qoldiq qarz</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r.n}</td><td>${fmtDateISO(r.date)}</td>
          <td class="n">${fmtDoc(r.pay)}</td><td class="n">${fmtDoc(r.left)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="2"><b>JAMI</b></td><td colspan="2" class="n"><b>${fmtDoc(S.total)}</b></td></tr></tfoot>
      </table>` : '';

    const calcRows = [
        ['Shartnoma turi', esc(c.type)],
        ['Tovar summasi (ustamasiz)', `${fmtDoc(base)} so'm`],
        ['Bo\'lib to\'lash bilan xarid summasi', `${fmtDoc(S.total)} so'm`],
        ...(S.months ? [
            ['O\'z mablag\'i hisobidan (boshlang\'ich to\'lov)', `${fmtDoc(S.prepay)} so'm`],
            ['Bo\'lib to\'lash bo\'yicha majburiyat summasi (ustama bilan)', `${fmtDoc(S.financed)} so'm`],
            ['Maksimal oylik to\'lov', `${fmtDoc(S.monthly)} so'm`],
            ['Bo\'lib to\'lash muddati', `${S.months} oy`],
            ['Oylik to\'lov kuni', `Har oyning ${S.payDay}-kuni`]
        ] : [['To\'lov usuli', esc(c.payType || 'To\'liq to\'lov')]]),
        ['Kafolat muddati', `${c.warrantyMonths} oy (${fmtDateISO(c.endDate)} gacha)`]
    ];

    const page1 = `
    <section class="tp-ct-page">
      <div class="tp-ct-appx">2-ilova<br>Ommaviy oferta ga<br>${esc(CONTRACT_COMPANY_LEGAL)}<br>tovarlarni sotish bo'yicha<br>${dateStr} dan</div>
      <h2>To'lovlar jadvali<br>№ ${esc(c.number)} — ${dateStr}</h2>
      <p>Men, <b>${esc(c.customer)}</b> (keyingi o'rinlarda — «Xaridor»), quyidagi To'lovlar jadvali bilan tanishdim,
         unga rozilik bildiraman va Shartnoma bo'yicha Sotuvchiga tegishli summalarni ko'rsatilgan muddatlarda to'lash majburiyatini olaman.</p>

      <h4>Xarid haqida ma'lumot</h4>
      <table class="tp-ct-t">
        <thead><tr><th>№</th><th>Do'kon</th><th>Tovar nomi</th><th>Soni</th></tr></thead>
        <tbody>${goods.map((g, i) => `<tr><td>${i + 1}</td><td>${esc(CONTRACT_COMPANY)}</td><td>${esc(g.name)}</td><td>${g.qty}</td></tr>`).join('')}</tbody>
      </table>

      <h4>Hisob-kitob ma'lumotlari</h4>
      <table class="tp-ct-t">
        <tbody>${calcRows.map(r => `<tr><td style="width:62%">${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody>
      </table>

      <h4>${S.months ? 'Bo\'lib to\'lash jadvali' : 'To\'lov jadvali'}</h4>
      <div class="tp-ct-cols"><div>${schedTable(S.rows.slice(0, half))}</div>${S.rows.length > 1 ? `<div>${schedTable(S.rows.slice(half))}</div>` : ''}</div>

      <table class="tp-ct-t" style="margin-top:10px"><tbody>
        <tr><td style="width:22%"><b>Xaridor</b></td><td>${esc(c.customer)}</td></tr>
        <tr><td><b>Telefon</b></td><td>${esc(c.phone || '—')}</td></tr>
        <tr><td><b>Imzo</b></td><td>&nbsp;</td></tr>
        <tr><td><b>Do'kon aloqa telefoni</b></td><td>${esc(phone || '—')}</td></tr>
      </tbody></table>
      <p class="tp-ct-note">To'lovni Payme, Paynet, Click va Uzum ilovalari orqali amalga oshirishingiz mumkin.</p>
    </section>`;

    // ---- 2-bet: Hisob-faktura (yuk xati) ----
    const inv = goods.map((g, i) => {
        const net = g.gross / (1 + vatRate / 100);
        return { n: i + 1, name: g.name, qty: g.qty, unit: net / g.qty, net, vat: g.gross - net, gross: g.gross };
    });
    const T = inv.reduce((a, r) => ({ net: a.net + r.net, vat: a.vat + r.vat, gross: a.gross + r.gross }), { net: 0, vat: 0, gross: 0 });
    const so = Math.floor(T.gross), tiyin = Math.round((T.gross - so) * 100);
    const words = numToWordsUz(so);
    const wordsCap = words.charAt(0).toUpperCase() + words.slice(1);

    const page2 = `
    <section class="tp-ct-page">
      <div class="tp-ct-appx">3-ilova<br>Ommaviy oferta ga<br>${esc(CONTRACT_COMPANY_LEGAL)}<br>tovarlarni sotish bo'yicha<br>${dateStr} dan</div>
      <h2>Hisob-faktura (yuk xati) № ${esc(c.number)} — ${dateStr}</h2>
      <table class="tp-ct-t"><tbody>
        <tr><td style="width:22%"><b>Ta'minotchi / Sotuvchi</b></td><td>${esc(CONTRACT_COMPANY_LEGAL)}</td></tr>
        <tr><td><b>Manzil</b></td><td>${esc(addr || '—')}</td></tr>
        <tr><td><b>STIR (INN)</b></td><td>${esc(tin || '—')}</td></tr>
        <tr><td><b>Oxirgi xaridor</b></td><td>${esc(c.customer)}</td></tr>
      </tbody></table>

      <table class="tp-ct-t">
        <thead><tr><th rowspan="2">№</th><th rowspan="2">Tovar (xizmat, ish) nomi</th><th rowspan="2">Birl.</th><th rowspan="2">Soni</th>
          <th rowspan="2">Narxi (QQS siz)</th><th rowspan="2">Yetkazib berish qiymati</th><th colspan="2">QQS</th><th rowspan="2">QQS bilan qiymat</th></tr>
          <tr><th>Stavka</th><th>Summa</th></tr></thead>
        <tbody>${inv.map(r => `<tr><td>${r.n}</td><td>${esc(r.name)}</td><td>dona</td><td>${r.qty}</td>
          <td class="n">${fmtDoc(r.unit)}</td><td class="n">${fmtDoc(r.net)}</td><td>${vatRate}%</td>
          <td class="n">${fmtDoc(r.vat)}</td><td class="n">${fmtDoc(r.gross)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5"><b>Jami:</b></td><td class="n"><b>${fmtDoc(T.net)}</b></td><td></td>
          <td class="n"><b>${fmtDoc(T.vat)}</b></td><td class="n"><b>${fmtDoc(T.gross)}</b></td></tr></tfoot>
      </table>
      <p><b>Jami to'lovga:</b> ${esc(wordsCap)} so'm ${String(tiyin).padStart(2, '0')} tiyin, shu jumladan QQS: ${fmtDoc(T.vat)} so'm.</p>
      <p class="tp-ct-note">Topshirilgan tovarlar Xaridor tomonidan ko'zdan kechirilgan, hech qanday nuqson va kamchiliklarga ega emas,
         sifati va xususiyatlari Xaridor talablariga mos. Xaridorning qabul qilingan tovarga nisbatan hech qanday da'vosi yo'q.</p>
      <div class="tp-ct-sign">
        <div>Rahbar: ____________________</div>
        <div>Bosh hisobchi: ____________________</div>
      </div>
      <div class="tp-ct-sign">
        <div>Tovarni topshirdi: ${esc(c.createdBy || '____________________')}</div>
        <div>Qabul qildi: ____________________ / ${esc(c.customer)} /</div>
      </div>
    </section>`;

    const css = `<style>
      .tp-ct{font:12px/1.45 Arial,Helvetica,sans-serif;color:#000;background:#fff}
      .tp-ct *{box-sizing:border-box}
      .tp-ct-page{page-break-after:always;break-after:page}
      .tp-ct-page:last-child{page-break-after:auto;break-after:auto}
      .tp-ct-appx{text-align:right;line-height:1.5;margin-bottom:12px}
      .tp-ct h2{text-align:center;font-size:14px;margin:10px 0 12px}
      .tp-ct h4{margin:12px 0 4px;font-size:12px}
      .tp-ct p{margin:8px 0;text-align:justify}
      .tp-ct-t{width:100%;border-collapse:collapse;margin:4px 0 8px;font-size:11px}
      .tp-ct-t th,.tp-ct-t td{border:1px solid #000;padding:3px 6px;text-align:left;vertical-align:top}
      .tp-ct-t th{background:#f0f0f0}
      .tp-ct-t .n{text-align:right;white-space:nowrap}
      .tp-ct-cols{display:flex;gap:10px;align-items:flex-start}
      .tp-ct-cols>div{flex:1;min-width:0}
      .tp-ct-sign{display:flex;gap:30px;margin-top:22px}
      .tp-ct-sign>div{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}
      .tp-ct-note{font-size:11px}
    </style>`;
    return `${css}<div class="tp-ct">${page1}${page2}</div>`;
}
/* [CONTRACTS-MODULE-END] */

applySavedTheme();
async function bootstrapApp() {
    // Eski sessiya belgisi bormi? (tp_session yoki server tokeni). Muddati
    // tugagan / bekor qilingan sessiyani xavfsiz login sahifasiga yo'naltirish
    // uchun restoreSession'dan AVVAL tekshiriladi — aks holda foydalanuvchi
    // ommaviy onlayn do'kon (page-shop) ko'rib qolardi.
    let hadStaleSession = false;
    try {
        hadStaleSession = !!(sessionStorage.getItem(SESSION_KEY) || sessionStorage.getItem('tp_token'));
    } catch (e) { /* storage blocked */ }
    // 1) Sahifa refresh/yuklashda saqlangan sessiyani tiklash (Security.restoreSession
    //    ichki ravishda loginWithUser → initApp → goToLandingFor ni chaqiradi).
    //    restoreSession async — server tokeni (tp_token) yaroqliligi ham tekshiriladi.
    if (!currentUser && typeof Security !== 'undefined' && typeof Security.restoreSession === 'function') {
        try { await Security.restoreSession(); } catch (e) { /* buzilgan sessiya — keyingi bosqichda login */ }
    }
    if (currentUser) {
        // Sessiya tiklandi: loginWithUser allaqachon ro'lga mos ICHKI sahifaga
        // o'tkazdi — bu yerda qayta navigatsiya qilmaymiz.
        renderShop();
        return;
    }
    initApp();
    // Sessiya bor edi lekin tiklanmadi (muddati tugagan yoki server rad etdi)
    // → xavfsiz login sahifasi. Rostdan mehmon (hech sessiya bo'lmagan) → ochiq do'kon.
    if (hadStaleSession) {
        showLoginScreen();
        return;
    }
    goTo('page-shop', document.getElementById('nav-shop'));
    renderShop();
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.setTimeout(bootstrapApp, 0), { once: true });
} else {
    window.setTimeout(bootstrapApp, 0);
}

// ============================================================
// DYNAMIC RENDER FUNCTIONS FOR NEW PAGES
// ============================================================
let editingCategory = null;

const CATEGORY_VISUALS = {
    'Telefonlar': { grad: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', icon: 'fas fa-mobile-screen' },
    'Noutbuklar': { grad: 'linear-gradient(135deg, #a855f7, #6b21a8)', icon: 'fas fa-laptop' },
    'Aksessuarlar': { grad: 'linear-gradient(135deg, #f59e0b, #d97706)', icon: 'fas fa-headphones' },
    'Maishiy texnika': { grad: 'linear-gradient(135deg, #06b6d4, #0e7490)', icon: 'fas fa-blender' },
    'Televizorlar': { grad: 'linear-gradient(135deg, #2563eb, #ea580c)', icon: 'fas fa-tv' },
    'O\'yin qurilmalari': { grad: 'linear-gradient(135deg, #ef4444, #db2777)', icon: 'fas fa-gamepad' }
};

function renderCategoriesPage() {
    const counts = {};
    CATEGORIES.forEach(c => { counts[c] = 0; });
    products.forEach(p => {
        if (counts[p.cat] === undefined) counts[p.cat] = 0;
        counts[p.cat] += 1;
    });
    const catKeys = Object.keys(counts);
    const emptyCount = catKeys.filter(k => counts[k] === 0).length;

    // Mobil statistika chip'lari (Kategoriyalar, Jami mahsulot, Bo'sh kategoriya)
    uiSetHtml('categoriesChips', `
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-purple"><i class="fas fa-cube"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${catKeys.length}</div>
        <div class="tpm-chip-l">Kategoriyalar</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-yellow"><i class="fas fa-boxes-stacked"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${products.length}</div>
        <div class="tpm-chip-l">Jami mahsulot</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-red"><i class="fas fa-box-open"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${emptyCount}</div>
        <div class="tpm-chip-l">Bo'sh kategoriya</div>
      </div>
    </div>`);

    const tbody = document.getElementById('categoriesTableBody');
    if (!tbody) return;
    const rows = [];
    const cards = [];
    catKeys.forEach((cat, i) => {
        const arg = escapeHTML(JSON.stringify(cat));
        const n = counts[cat];
        const visual = CATEGORY_VISUALS[cat] || {
            grad: 'linear-gradient(135deg, #6366f1, #4f46e5)',
            icon: 'fas fa-folder'
        };
        rows.push(`
        <tr>
            <td class="cat-td-index" data-label="">${i + 1}</td>
            <td class="cat-td-name" data-label="Kategoriya"><span class="cat-name">
                <span class="cat-name-emoji" aria-hidden="true">${escapeHTML(categoryEmoji(cat))}</span>
                <span class="cat-name-text" title="${escapeHTML(cat)}">${escapeHTML(cat)}</span>
            </span></td>
            <td class="cat-td-count" data-label="Mahsulotlar"><span class="badge ${n ? 'badge-blue' : 'badge-gray'} cat-count-badge">${n}</span></td>
            <td class="cat-td-actions" data-label="Amallar"><div class="cat-actions">
                <button class="btn btn-outline btn-sm" title="Ko'rish" onclick="viewCategoryProducts(${arg})"><i class="fas fa-eye"></i> Ko'rish</button>
                <button class="btn btn-outline btn-sm" title="Tahrirlash" onclick="openCategoryModal(${arg})"><i class="fas fa-pen"></i> Tahrirlash</button>
                <button class="btn btn-outline btn-sm cat-btn-danger" title="O'chirish" onclick="deleteCategory(${arg})"><i class="fas fa-trash"></i></button>
            </div></td>
        </tr>`);
        cards.push(`
    <div class="tpm-card tpm-category-card" onclick="viewCategoryProducts(${arg})">
      <div class="tpm-cat-main">
        <div class="tpm-cat-iconbox" style="background:${visual.grad}">
          <i class="${visual.icon}"></i>
        </div>
        <div class="tpm-cat-body">
          <div class="tpm-name">${escapeHTML(cat)}</div>
          <div class="tpm-sub">${n} mahsulot</div>
        </div>
        <div class="tpm-cat-actions">
          <button type="button" class="tpm-cat-act-btn" onclick="event.stopPropagation(); openCategoryModal(${arg})" title="Tahrirlash" aria-label="${escapeHTML(cat)} tahrirlash">
            <i class="fas fa-pen"></i>
          </button>
          <button type="button" class="tpm-cat-act-btn danger" onclick="event.stopPropagation(); deleteCategory(${arg})" title="O'chirish" aria-label="${escapeHTML(cat)} o'chirish">
            <i class="fas fa-trash"></i>
          </button>
          <i class="fas fa-chevron-right tpm-chevron"></i>
        </div>
      </div>
    </div>`);
    });
    const list = rows.join('');
    const chip = document.getElementById('categoriesCountChip');
    if (chip) chip.textContent = String(catKeys.length);
    tbody.innerHTML = list || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Kategoriyalar yo\'q — "Yangi kategoriya" tugmasini bosing</td></tr>';
    uiSetHtml('categoriesMobileList', cards.join('')
        || '<div class="tpm-empty">Kategoriyalar yo\'q — “Kategoriya qo\'shish” tugmasini bosing</div>');
}

/** Kategoriya yaratish / tahrirlash oynasini ochadi. */
function openCategoryModal(name) {
    if (!requireRoleSilent('admin', 'manager')) {
        playError(); showNotif('error', 'Ruxsat yo\'q!', 'Kategoriyalarni faqat Admin yoki Menejer boshqaradi'); return;
    }
    editingCategory = typeof name === 'string' ? name : null;
    const input = document.getElementById('categoryNameInput');
    const emojiInput = document.getElementById('categoryEmojiInput');
    const title = document.getElementById('categoryModalTitle');
    if (input) input.value = editingCategory || '';
    if (emojiInput) emojiInput.value = editingCategory
        ? ((systemSettings.categoryEmojis || {})[editingCategory] || '')
        : '';
    if (title) title.innerHTML = editingCategory
        ? '<i class="fas fa-pen"></i> Kategoriyani tahrirlash'
        : '<i class="fas fa-folder-plus"></i> Yangi kategoriya';
    openModal('categoryModal');
}

function refreshCategoryViews() {
    saveCategories();
    if (typeof saveToStorage === 'function') saveToStorage();
    renderCategoriesPage();
    if (typeof renderCatTabs === 'function') renderCatTabs();
    if (typeof renderShop === 'function') renderShop();
    if (typeof renderProducts === 'function') renderProducts();
    if (document.getElementById('admin-dashboard')?.style.display === 'block') loadAdminDashboard();
}

function saveCategoryFromModal() {
    const name = cleanText(document.getElementById('categoryNameInput')?.value || '', 60);
    if (!name) { playError(); showNotif('error', 'Xato!', 'Kategoriya nomini kiriting'); return; }
    const exists = CATEGORIES.some(c => c.toLowerCase() === name.toLowerCase() && c !== editingCategory);
    if (exists) { playError(); showNotif('error', 'Xato!', 'Bunday kategoriya allaqachon bor'); return; }

    // Icon/emoji (ixtiyoriy) — mavjud `settings` kaliti ichida saqlanadi,
    // /api/sync → validate_sync_payload → db_manager.save_keys orqali bazaga yoziladi
    const emojiInput = document.getElementById('categoryEmojiInput');
    const emoji = emojiInput ? cleanText(emojiInput.value, 8).trim() : '';
    if (!systemSettings.categoryEmojis || typeof systemSettings.categoryEmojis !== 'object') {
        systemSettings.categoryEmojis = {};
    }
    const emojis = systemSettings.categoryEmojis;

    if (editingCategory) {
        const i = CATEGORIES.indexOf(editingCategory);
        if (i >= 0) CATEGORIES[i] = name;
        products.forEach(p => { if (p.cat === editingCategory) p.cat = name; });
        addLog('Kategoriya', `"${editingCategory}" → "${name}" nomi o'zgartirildi`);
    } else {
        CATEGORIES.push(name);
        addLog('Kategoriya', `Yangi kategoriya yaratildi: ${name}`);
    }
    // Emoji'ni qo'llash: tahrirlashda eski nom kalitini yangi nomga ko'chiramiz,
    // so'ng yangi qiymatni yozamiz yoki bo'sh bo'lsa tozalamiz
    if (editingCategory && editingCategory !== name && emojis[editingCategory]) {
        emojis[name] = emojis[editingCategory];
        delete emojis[editingCategory];
    }
    if (emoji) emojis[name] = emoji;
    else delete emojis[name];
    try { localStorage.setItem('tp_settings', JSON.stringify(systemSettings)); } catch (e) { }
    closeModal('categoryModal');
    refreshCategoryViews();
    playSuccess();
    showNotif('success', 'Saqlandi', editingCategory ? 'Kategoriya yangilandi' : 'Yangi kategoriya qo\'shildi');
    editingCategory = null;
}

function deleteCategory(name) {
    if (!requireRoleSilent('admin', 'manager')) {
        playError(); showNotif('error', 'Ruxsat yo\'q!', 'Kategoriyalarni faqat Admin yoki Menejer boshqaradi'); return;
    }
    const used = products.filter(p => p.cat === name).length;
    if (used > 0) {
        playError();
        showNotif('error', 'O\'chirib bo\'lmaydi', `Bu kategoriyada ${used} ta mahsulot bor. Avval ularni boshqa kategoriyaga o'tkazing`);
        return;
    }
    if (!confirm(`"${name}" kategoriyasini o'chirmoqchimisiz?`)) return;
    CATEGORIES = CATEGORIES.filter(c => c !== name);
    if (systemSettings.categoryEmojis && typeof systemSettings.categoryEmojis === 'object') {
        delete systemSettings.categoryEmojis[name];
        try { localStorage.setItem('tp_settings', JSON.stringify(systemSettings)); } catch (e) { }
    }
    addLog('Kategoriya', `Kategoriya o'chirildi: ${name}`);
    refreshCategoryViews();
    showNotif('success', 'O\'chirildi', name);
}

/** Kategoriyadagi mahsulotlarni ICHKI boshqaruv panelida ochadi — ommaviy
    do'kon emas (bu amal faqat administrator/menejer boshqaruv sahifasidan
    chaqiriladi, shuning uchun foydalanuvchi hech qachon do'kon sahifasiga
    tashlab yuborilmaydi). */
function viewCategoryProducts(cat) {
    currentCategory = cat;
    goTo('page-products', navElForPage('page-products'));
    if (typeof renderProducts === 'function') renderProducts();
}

/* Ombor qidiruvi va holat filtri — desktop jadval va mobil kartalar uchun umumiy filtr */
let warehouseSearchQ = '';
let warehouseStatusFilter = '';

function setWarehouseStatusFilter(status) {
    warehouseStatusFilter = String(status || '');
    renderWarehousePage();
}

const debouncedFilterWarehouse = debounce(function (q) {
    warehouseSearchQ = String(q || '').trim().toLowerCase();
    renderWarehousePage();
}, 300);

function renderWarehousePage() {
    const branch = selectedBranch();
    const all = visibleProducts();
    const q = warehouseSearchQ;
    const stFilter = warehouseStatusFilter;

    const lowStockAll = all.filter(p => Number(p.stock) > 0 && Number(p.stock) < 5);
    const outStockAll = all.filter(p => Number(p.stock) <= 0);
    const totalValueAll = all.reduce((acc, p) => acc + (Number(p.price || 0) * Number(p.stock || 0)), 0);

    // Mobil statistika chip'lari (Umumiy zaxira qiymati, Kam qoldi, Tugagan)
    uiSetHtml('warehouseChips', `
    <div class="tpm-chip tpm-chip-wide">
      <div class="tpm-chip-ico tone-yellow"><i class="fas fa-coins"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${fmt(totalValueAll)}</div>
        <div class="tpm-chip-l">Umumiy zaxira qiymati</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-yellow"><i class="fas fa-triangle-exclamation"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${lowStockAll.length}</div>
        <div class="tpm-chip-l">Kam qoldi</div>
      </div>
    </div>
    <div class="tpm-chip">
      <div class="tpm-chip-ico tone-red"><i class="fas fa-cube"></i></div>
      <div class="tpm-chip-txt">
        <div class="tpm-chip-v">${outStockAll.length}</div>
        <div class="tpm-chip-l">Tugagan</div>
      </div>
    </div>`);

    // Mobil holat pill'lari (Barchasi, Kam qoldi, Tugagan)
    uiSetHtml('warehousePills', [
        { key: '', label: 'Barchasi', n: all.length, icon: '' },
        { key: 'low', label: 'Kam qoldi', n: lowStockAll.length, icon: '<i class="fas fa-triangle-exclamation" style="margin-right:4px;color:#f59e0b"></i>' },
        { key: 'out', label: 'Tugagan', n: outStockAll.length, icon: '<i class="fas fa-cube" style="margin-right:4px;color:#ef4444"></i>' }
    ].map(p => `<button type="button" role="tab" class="tpm-pill${warehouseStatusFilter === p.key ? ' active' : ''}"
        aria-pressed="${warehouseStatusFilter === p.key}" onclick="setWarehouseStatusFilter('${escapeHTML(p.key)}')">
        ${p.icon}${escapeHTML(p.label)}
      </button>`).join(''));

    const list = all.filter(p => {
        const stock = Number(p.stock) || 0;
        if (stFilter === 'low' && (stock <= 0 || stock >= 5)) return false;
        if (stFilter === 'out' && stock > 0) return false;
        if (q && !String(p.name || '').toLowerCase().includes(q) && !String(p.cat || '').toLowerCase().includes(q)) return false;
        return true;
    });

    const valEl = document.getElementById('warehouseTotalValue');
    if (valEl) valEl.textContent = fmt(totalValueAll) + ' so\'m';

    const lowEl = document.getElementById('warehouseLowStockCount');
    if (lowEl) lowEl.textContent = lowStockAll.length + ' ta';

    const scopeEl = document.getElementById('warehouseScope');
    if (scopeEl) {
        scopeEl.textContent = branch
            ? '— ' + branch.name + ' ombori (' + list.length + ' ta mahsulot)'
            : '— barcha filiallar ombori (' + list.length + ' ta mahsulot)';
    }

    const tbody = document.getElementById('warehouseTableBody');
    if (!tbody) return;

    // Desktop jadval qatorlari va mobil kartalar
    const rows = [];
    const cards = [];
    list.forEach((p, i) => {
        const b = getBranchById(p.branchId);
        rows.push(`
        <tr>
            <td data-label="#">${i + 1}</td>
            <td data-label="Nomi"><strong>${escapeHTML(p.name)}</strong></td>
            <td data-label="Kategoriya"><span class="badge">${escapeHTML(p.cat)}</span></td>
            <td data-label="Filial">${b
                ? '<span class="badge" style="background:' + escapeHTML(b.markerColor) + '22;color:' + escapeHTML(b.markerColor) + '">' + escapeHTML(b.markerIcon + ' ' + b.name) + '</span>'
                : '<span class="badge" style="opacity:.7">Umumiy</span>'}</td>
            <td data-label="Qoldiq" style="font-weight:700;color:${p.stock < 5 ? 'var(--danger)' : 'var(--success)'}">${p.stock} ta</td>
            <td data-label="Baho">${fmt(p.price)} so'm</td>
            <td data-label="Jami Qiymat" style="font-weight:700">${fmt(p.price * p.stock)} so'm</td>
        </tr>`);
        const stock = Number(p.stock) || 0;
        const tone = stock <= 0 ? 'tone-red' : stock < 5 ? 'tone-yellow' : 'tone-green';
        const label = stock <= 0 ? 'Tugagan' : stock < 5 ? 'Kam qoldi' : 'Bor';
        const imgSrc = productImageSrc(p.img);
        const spec = p.desc || p.model || p.cat || '';
        cards.push(`
    <div class="tpm-card tpm-warehouse-card">
      <div class="tpm-wh-main">
        <div class="tpm-wh-imgbox">
          ${imgSrc
                ? `<img src="${escapeHTML(imgSrc)}" alt="" class="tpm-wh-img" loading="lazy" onerror="this.style.display='none'">`
                : `<div class="tpm-wh-tile" aria-hidden="true">${CATEGORY_EMOJI[p.cat] || '📦'}</div>`}
        </div>
        <div class="tpm-wh-body">
          <div class="tpm-name">${escapeHTML(p.name)}</div>
          <div class="tpm-sub">${escapeHTML(spec)}</div>
          <div class="tpm-wh-price">${fmt(p.price)} so'm</div>
        </div>
        <div class="tpm-wh-end">
          <div class="tpm-wh-stock">${stock} dona</div>
          <span class="tpm-status-pill ${tone}">${label}</span>
        </div>
      </div>
    </div>`);
    });
    const emptyMsg = q || stFilter ? 'Filtrga mos mahsulot topilmadi' : 'Mahsulot yo\'q';
    tbody.innerHTML = rows.join('') || `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted)">${emptyMsg}</td></tr>`;
    uiSetHtml('warehouseMobileList', cards.join('') || `<div class="tpm-empty">${emptyMsg}</div>`);
}

// Chegirma kampaniyalari — faqat real kiritilgan kampaniyalar (demo yo'q)
let discountCampaigns = safeJsonParse(localStorage.getItem('tp_discounts') || '[]', []);
if (!Array.isArray(discountCampaigns)) discountCampaigns = [];
// Saqlangan yozuvlarni xavfsiz shaklga keltiramiz (yaroqsizlari tashlanadi).
discountCampaigns = discountCampaigns.map(normalizeDiscount).filter(Boolean);

let editingDiscountId = null;

/** Promo kodni yagona ko'rinishga keltiradi: katta harf, faqat A-Z 0-9 _ - */
function discountNormalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

/** Yaroqli holat qiymatlari (funksiya — yuklanish paytida ham xavfsiz). */
function discountStatusList() {
    return ['Faol', 'Nofaol'];
}

/** Kampaniyani saqlash uchun xavfsiz shaklga keltiradi. */
function normalizeDiscount(d) {
    if (!d || typeof d !== 'object') return null;
    const name = cleanText(d.name, 80).trim();
    const code = discountNormalizeCode(d.code);
    const rawPct = Number(d.pct);
    if (!name || !code || !Number.isFinite(rawPct)) return null;
    return {
        id: String(d.id || ('dc-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8))).slice(0, 60),
        name,
        code,
        pct: Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100)),
        status: discountStatusList().includes(String(d.status)) ? String(d.status) : 'Faol',
        createdAt: cleanText(d.createdAt, 30) || new Date().toLocaleString('uz-UZ'),
        createdBy: cleanText(d.createdBy, 120),
    };
}

/**
 * Chegirmani saqlaydi: localStorage + server.
 * MUHIM: buildSyncPayload() `tp_discounts` kalitini AYNAN localStorage dan
 * o'qiydi — shuning uchun avval localStorage yoziladi, keyin sinxronlanadi.
 */
function persistDiscounts() {
    try {
        localStorage.setItem('tp_discounts', JSON.stringify(discountCampaigns));
    } catch (e) {
        console.warn('Chegirmani saqlab bo\'lmadi:', e);
    }
    if (typeof saveToStorage === 'function') saveToStorage();
}

/** Yangi yoki tahrirlash uchun modalni ochadi (id berilmasa — yangi). */
function openDiscountModal(id) {
    if (!requireRole('admin', 'manager')) return;
    const editing = (id === undefined || id === null || id === '')
        ? null
        : discountCampaigns.find(d => String(d.id) === String(id)) || null;
    editingDiscountId = editing ? editing.id : null;
    const title = document.getElementById('discountModalTitle');
    if (title) {
        title.innerHTML = editing
            ? '<i class="fas fa-pen"></i> Chegirmani tahrirlash'
            : '<i class="fas fa-gift"></i> Yangi chegirma / promo-kod';
    }
    const setField = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val === undefined || val === null ? '' : String(val);
    };
    setField('dc-name', editing ? editing.name : '');
    setField('dc-code', editing ? editing.code : '');
    setField('dc-pct', editing ? String(editing.pct) : '10');
    setField('dc-status', editing ? editing.status : 'Faol');
    openModal('discountModal');
}

function saveDiscountCampaign() {
    if (!requireRole('admin', 'manager')) return;
    const name = cleanText(document.getElementById('dc-name')?.value || '', 80).trim();
    const code = discountNormalizeCode(document.getElementById('dc-code')?.value);
    const pct = Number(String(document.getElementById('dc-pct')?.value ?? '').replace(',', '.'));
    const statusRaw = document.getElementById('dc-status')?.value;
    const status = discountStatusList().includes(String(statusRaw)) ? String(statusRaw) : 'Faol';

    if (!name) {
        playError(); showNotif('error', 'Xato!', 'Kampaniya nomini kiriting'); return;
    }
    if (code.length < 3) {
        playError();
        showNotif('error', 'Promo kod xato',
            'Promo kod kamida 3 belgidan iborat bo\'lsin (A-Z, 0-9, -)');
        return;
    }
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        playError();
        showNotif('error', 'Chegirma xato',
            'Chegirma foizi 0 dan katta va 100 dan oshmasligi kerak');
        return;
    }
    const clash = discountCampaigns.find(d => d.code === code && String(d.id) !== String(editingDiscountId));
    if (clash) {
        playError();
        showNotif('error', 'Promo kod band',
            `"${code}" kodi "${clash.name}" kampaniyasida ishlatilgan`);
        return;
    }

    if (editingDiscountId != null) {
        discountCampaigns = discountCampaigns.map(d => String(d.id) === String(editingDiscountId)
            ? { ...d, name, code, pct, status } : d);
        addLog('Chegirma', `"${name}" kampaniyasi tahrirlandi — ${code} (${pct}%)`);
    } else {
        const payload = normalizeDiscount({
            name, code, pct, status,
            createdBy: (currentUser && currentUser.name) || '—',
        });
        if (!payload) {
            playError(); showNotif('error', 'Xato!', 'Ma\'lumotlar yaroqsiz'); return;
        }
        discountCampaigns = [payload, ...discountCampaigns];
        addLog('Chegirma', `Yangi promo-kod: ${code} — ${pct}% (${name})`);
    }
    editingDiscountId = null;
    persistDiscounts();
    renderDiscountsPage();
    closeModal('discountModal');
    playSuccess();
    showNotif('success', 'Saqlandi!', `${name} — ${pct}% (promo kod: ${code})`);
}

function deleteDiscountCampaign(id) {
    if (!requireRole('admin', 'manager')) return;
    const camp = discountCampaigns.find(d => String(d.id) === String(id));
    if (!camp) return;
    if (!confirm(`"${camp.name}" kampaniyasini o'chirasizmi? (promo kod: ${camp.code})`)) return;
    discountCampaigns = discountCampaigns.filter(d => String(d.id) !== String(id));
    persistDiscounts();
    renderDiscountsPage();
    addLog('Chegirma', `"${camp.name}" kampaniyasi o'chirildi`);
    showNotif('info', 'O\'chirildi', 'Chegirma kampaniyasi o\'chirildi');
}

/**
 * Kassada promo kodni qo'llaydi.
 * Mavjud chegirma mexanizmidan foydalanadi (`posSetDiscount`) — savdo
 * hisob-kitobi va chek mantig'i o'zgarmaydi.
 */
function posApplyPromoCode() {
    const input = document.getElementById('posPromoCode');
    const code = discountNormalizeCode(input ? input.value : '');
    if (!code) { showNotif('warning', 'Promo kod', 'Promo kodni kiriting'); return; }
    const camp = discountCampaigns.find(d => d.code === code && d.status === 'Faol');
    if (!camp) {
        const exists = discountCampaigns.some(d => d.code === code);
        playError();
        showNotif('error', exists ? 'Kampaniya faol emas' : 'Promo kod topilmadi',
            exists ? `"${code}" kampaniyasi hozir faol emas` : `"${code}" kodi bo'yicha chegirma yo'q`);
        return;
    }
    posSetDiscount(camp.pct);
    if (input) input.value = camp.code;
    playSuccess();
    showNotif('success', 'Promo kod qo\'llandi', `${camp.name} — ${camp.pct}% chegirma`);
}

function renderDiscountsPage() {
    const tbody = document.getElementById('discountsTableBody');
    if (!tbody) return;
    if (discountCampaigns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Hali chegirma kampaniyalari yo\'q — "Yangi chegirma" tugmasini bosing</td></tr>';
        return;
    }
    tbody.innerHTML = discountCampaigns.map((d, i) => `
        <tr>
            <td>${i + 1}</td>
            <td><strong>${escapeHTML(d.name)}</strong></td>
            <td><code style="padding:4px 8px;background:var(--bg);border-radius:6px;font-weight:700;color:var(--primary)">${escapeHTML(d.code)}</code></td>
            <td style="font-weight:700;color:var(--accent)">${Number(d.pct) || 0}%</td>
            <td><span class="badge ${d.status === 'Faol' ? 'badge-green' : 'badge-red'}">${escapeHTML(d.status)}</span></td>
            <td style="white-space:nowrap">
                <button class="btn btn-sm btn-outline" onclick="openDiscountModal('${jsStrAttr(String(d.id))}')" title="Tahrirlash"><i class="fas fa-pen"></i></button>
                <button class="btn btn-sm btn-outline" onclick="deleteDiscountCampaign('${jsStrAttr(String(d.id))}')" title="O'chirish"><i class="fas fa-trash"></i></button>
            </td>
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
        const paidSales = (salesHistory || []).filter(isPaidSale);
        const todaySales = paidSales.filter(s => s && String(s.date || '').startsWith(today));
        return {
            mahsulot_soni: products.length,
            savdo_soni: paidSales.length,
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
            let data = null;
            try { data = await res.json(); } catch (_) { data = null; }

            if (res.status === 401 || res.status === 403) {
                try { handleSessionExpired(); } catch (_) { }
                history.push({ role: 'error', text: 'Ruxsat yo\'q. Faqat admin AI yordamchidan foydalanadi — qaytadan kiring.' });
                return;
            }
            if (res.status === 429) {
                history.push({ role: 'error', text: (data && data.message) || 'Savollar chegarasi oshib ketdi — birozdan so\'ng urinib ko\'ring.' });
                return;
            }
            if (!res.ok || !(data && data.answer)) {
                history.push({ role: 'error', text: (data && data.message) || 'Serverdan javob olinmadi. Keyinroq qayta urinib ko\'ring.' });
                return;
            }

            history.push({ role: 'assistant', text: data.answer, source: data.source });
            renderStats(data.stats);
        } catch (e) {
            try { console.error('AI so\'rovida xatolik:', e); } catch (_) { }
            try { history.push({ role: 'error', text: 'Serverga ulanib bo\'lmadi (oflayn rejim).' }); } catch (_) { }
        } finally {
            busy = false;
            try { setBadge(serverOnline ? 'Server bilan bog\'langan' : 'Oflayn rejim', serverOnline ? 'badge-green' : ''); } catch (e) { }
            try { render(); } catch (e) { console.error(e); }
        }
    }

    function sendFromInput() {
        try {
            const field = document.getElementById('ai-input');
            send(field ? field.value : '');
        } catch (e) { console.error(e); }
    }

    function askQuick(btn) {
        try {
            let t = '';
            try { t = btn ? btn.textContent : ''; } catch (_) { t = ''; }
            send(t || '');
        } catch (e) { try { console.error(e); } catch (_) { } }
    }

    function reset() {
        try { history.length = 0; render(); } catch (e) { console.error(e); }
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

function toggleShopCatSidebar() {
    const sidebar = document.getElementById('shopCatSidebar');
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
    }
}

function loginWithUser(user) {
    // Sessiya tiklash orqali kirganda ham sessiya ochilishini kafolatlaymiz
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
    // Sessiya tiklash (refresh / orqaga qaytish / qayta login) da ham
    // ro'lga mos ICHKI sahifa ochiladi — xodim tasodifan do'konni ko'rib qolmasin.
    if (user && user.role !== 'customer') goToLandingFor(user);
    playSuccess();
}

function toggleEmployeesDropdown(el) {
    // Desktop yig'ilgan sidebarda submenu yashirin (CSS) — avval sidebarni ochamiz
    const sb = document.getElementById('sidebar');
    if (sb && !sidebarIsMobile() && sb.classList.contains('collapsed')) setSidebarOpen(true);
    const submenu = document.getElementById('employees-submenu');
    const arrow = el.querySelector('.submenu-arrow');
    // Agar submenu ichida hech qanday bo'lim (item) bo'lmasa — bo'sh dropdown
    // ko'rsatish o'rniga Xodimlar sahifasining o'ziga o'tamiz (aks holda menyu
    // hech qayerga olib bormaydi). Mavjud itemlar bo'lsa — avvalgidek ochiladi.
    const hasItems = !!submenu && submenu.querySelector('a, button, [onclick], .nav-item, .submenu-item');
    if (!hasItems) {
        const pageId = el.getAttribute('data-page') || 'page-bossStaff';
        const navEl = document.getElementById('nav-bossStaff');
        goTo(pageId, navEl);
        return;
    }
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
    if (roleLabelEl) roleLabelEl.textContent = ROLES[role] || 'Xaridor';

    // ── Login (telefon)ni o'zgartirish bo'limi — faqat xodimlar uchun ──
    const isStaff = !!role && role !== 'customer';
    const phoneSection = document.getElementById('profilePhoneSection');
    if (phoneSection) phoneSection.style.display = isStaff ? '' : 'none';
    const curPhoneEl = document.getElementById('profileCurrentPhone');
    if (curPhoneEl) {
        curPhoneEl.textContent = currentUser.phone && currentUser.phone !== currentUser.login
            ? `${currentUser.phone} (login: ${currentUser.login})`
            : (currentUser.login || '—');
    }
    const phoneInput = document.getElementById('profileNewPhone');
    if (phoneInput) {
        phoneInput.value = '';
        if (currentUser.phone && currentUser.phone !== currentUser.login) {
            phoneInput.placeholder = currentUser.phone;
        }
    }
    const phonePass = document.getElementById('profilePhonePass');
    if (phonePass) phonePass.value = '';

    openModal('profileModal');
}

/**
 * Xodim O'ZI login (telefon) raqamini almashtiradi.
 * Yangi raqam serverda saqlanadi va Boshliq panelida ko'rinadi.
 */
async function changeMyPhone() {
    if (!currentUser) { playError(); showNotif('error', 'Xato!', 'Avval tizimga kiring'); return; }
    const rawPhone = document.getElementById('profileNewPhone')?.value || '';
    const pass = sanitizePassword(document.getElementById('profilePhonePass')?.value);
    const phone = (typeof normalizePhoneUz === 'function') ? normalizePhoneUz(rawPhone) : '';

    if (!phone) {
        playError();
        showNotif('error', 'Telefon xato', "To'liq raqam kiriting: +998 90 123 45 67");
        document.getElementById('profileNewPhone')?.focus();
        return;
    }
    if (!pass) {
        playError();
        showNotif('error', 'Parol kerak', 'Tasdiqlash uchun joriy parolingizni kiriting');
        document.getElementById('profilePhonePass')?.focus();
        return;
    }
    if (!staffToken) {
        showNotif('error', 'Sessiya yo\'q', 'Qayta kiring');
        return;
    }

    const btn = document.getElementById('profilePhoneSave');
    const oldLabel = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saqlanmoqda...';
    }
    try {
        const res = await fetch('/api/auth/change-phone', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ currentPassword: pass, newPhone: phone })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            playError();
            showNotif('error', 'Xatolik', data.message || "Raqamni o'zgartirib bo'lmadi");
            return;
        }
        // Login o'zgargani uchun server yangi token beradi — eskisi kuchini yo'qotadi.
        if (data.token) setStaffToken(data.token);
        if (data.user) {
            currentUser.login = cleanText(data.user.login, 120) || currentUser.login;
            currentUser.phone = cleanText(data.user.phone, 40) || phone;
        } else {
            currentUser.phone = phone;
        }
        const loginEl = document.getElementById('profileModalLogin');
        if (loginEl) loginEl.textContent = currentUser.login;
        const curPhoneEl = document.getElementById('profileCurrentPhone');
        if (curPhoneEl) curPhoneEl.textContent = currentUser.phone;
        const phonePass = document.getElementById('profilePhonePass');
        if (phonePass) phonePass.value = '';
        securityLog('phone-changed', 'medium',
            `Login (telefon) almashtirildi: ${currentUser.login}`);
        addLog('Profil', `Login (telefon) yangilandi: ${currentUser.name}`);
        playSuccess();
        showNotif('success', 'Yangilandi',
            data.message || 'Login (telefon) yangilandi — Boshliq buni panelida ko\'radi');
        setTimeout(() => closeModal('profileModal'), 1000);
    } catch (e) {
        showNotif('error', 'Serverga ulanib bo\'lmadi', 'Internet yoki server holatini tekshiring');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = oldLabel;
        }
    }
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
    window.setTimeout(loadFromBackend, 0);
});
// Fallback if DOMContentLoaded already fired
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startSlideShow();
    window.setTimeout(loadFromBackend, 0);
}

// ============================================================
// FILIALLAR (BRANCHES)
// ============================================================
// Filiallar `branches` massivida saqlanadi, bazaga `/api/sync`
// orqali yuboriladi (`tp_branches` keshi + server `store_data`).
let branches = safeJsonParse(localStorage.getItem('tp_branches') || 'null', null);
if (!Array.isArray(branches)) branches = [];
let branchSummary = [];
let activeBranchId = '';
try { activeBranchId = localStorage.getItem('tp_active_branch') || ''; } catch (e) { activeBranchId = ''; }
let editingBranchId = null;
let branchPickIcon = '🏬';
let branchPickColor = '#ff6b35';

const BRANCH_ICONS = ['🏬', '🏪', '🏢', '🏭', '🛒', '📦', '⭐', '🏠', '🏤', '🛍️', '💡', '🔧'];
const BRANCH_COLORS = ['#ff6b35', '#2563eb', '#10b981', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#84cc16'];

function normalizeBranch(b) {
    if (!b || typeof b !== 'object') return null;
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    const hasCoords = isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    const name = cleanText(b.name, 120);
    if (!name) return null;
    return {
        id: String(b.id || ('br-' + Date.now())).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || ('br-' + Date.now()),
        name,
        code: cleanText(b.code, 20),
        city: cleanText(b.city, 80),
        address: cleanText(b.address, 200),
        phone: cleanText(b.phone, 40),
        hours: cleanText(b.hours, 80),
        lat: hasCoords ? Math.round(lat * 1e6) / 1e6 : null,
        lng: hasCoords ? Math.round(lng * 1e6) / 1e6 : null,
        markerIcon: BRANCH_ICONS.includes(b.markerIcon) ? b.markerIcon : '🏬',
        markerColor: /^#[0-9a-fA-F]{6}$/.test(String(b.markerColor || '')) ? b.markerColor : '#ff6b35',
        status: b.status === 'inactive' ? 'inactive' : 'active',
        isMain: Boolean(b.isMain),
    };
}

function saveBranches() {
    try { localStorage.setItem('tp_branches', JSON.stringify(branches)); } catch (e) { }
    try { scheduleSyncWithBackend(800); } catch (e) { }
}

function activeBranches() {
    return branches.filter(b => b && b.status === 'active');
}

function getBranchById(id) {
    return branches.find(b => String(b.id) === String(id)) || null;
}

function getActiveBranch() {
    return getBranchById(activeBranchId) || branches.find(b => b.isMain) || branches[0] || null;
}

/** Faol filialdagi mahsulotlar (ombor/KPI filtri uchun). */
function productsOfBranch(branchId) {
    if (!branchId) return products;
    return products.filter(p => String(p.branchId || '') === String(branchId));
}

/** Aynan tanlangan filial ("Barcha filiallar" tanlangan bo'lsa — null). */
function selectedBranch() {
    return activeBranchId ? getBranchById(activeBranchId) : null;
}

/**
 * Ko'rinadigan mahsulotlar (POS, mahsulotlar ro'yxati, ombor).
 *
 * Filial tanlangan bo'lsa: shu filial mahsulotlari + hali filialga
 * biriktirilmagan (umumiy) mahsulotlar ko'rinadi — shu sababli filial
 * tanlanganda ham sotish ishlashda davom etadi.
 */
function visibleProducts() {
    const b = selectedBranch();
    if (!b) return products;
    const bid = String(b.id);
    return products.filter(p => !p.branchId || String(p.branchId) === bid);
}

/** "Barcha filiallar" tanlanganini bildiradi (admin umumiy ko'rinishi). */
function isAllBranchesView() {
    return !selectedBranch();
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

// ============================================================
// BRANCHES MODULI — filiallar ro'yxati, KPI, CSV eksport,
// faol filial tanlagichi va CRUD. Tahrirlash admin/managerga
// beriladi.
// ============================================================
const Branches = {

    /* ── INIT: badge, switcher, server ma'lumoti ─────────────── */
    init() {
        try { this.refreshBranchSwitcher(); } catch (e) { }
        try { this.updateNavBadge(); } catch (e) { }
    },

    /** Sahifa ochilganda (goTo orqali): render. */
    onPageOpen() {
        if (!this._summaryLoaded) { this.loadSummary(false); this._summaryLoaded = true; }
        this.render();
    },

    /* ── DATA: server bilan sinxronlash ───────────────────────── */
    async loadFromServer() {
        try {
            const res = await fetchWithTimeout('/api/branches', {}, 8000);
            if (!res.ok) return;
            const data = await res.json();
            if (data && Array.isArray(data.branches)) {
                branches = data.branches.map(normalizeBranch).filter(Boolean);
                try { localStorage.setItem('tp_branches', JSON.stringify(branches)); } catch (e) { }
            }
        } catch (e) { /* offline — lokal nusxa ishlaydi */ }
    },

    /* ── KPI: HAQIQIY database manbasi (/api/branches/summary) ── */
    _kpi: {},
    _kpiMeta: null,

    /**
     * Filial KPI'larini serverdan oladi (backend `branches_summary`:
     * mahsulot, zaxira qiymati, savdo, kirim, chiqim, harajat, sof natija).
     * Muvaffaqiyatsiz bo'lsa (offline/401) — false, jadval lokal hisobga o'tadi.
     */
    async loadKpiFromServer() {
        try {
            const res = await fetchWithTimeout('/api/branches/summary',
                { headers: authHeaders() }, 10000);
            if (!res.ok) return false;
            const data = await res.json();
            if (!data || !Array.isArray(data.branches)) return false;
            const map = {};
            data.branches.forEach(it => {
                if (it && typeof it === 'object') map[String(it.branchId || '')] = it;
            });
            this._kpi = map;
            this._kpiMeta = {
                time: String(data.serverTime || new Date().toLocaleTimeString('uz-UZ')),
            };
            return true;
        } catch (e) { return false; }
    },

    renderKpiMeta() {
        const el = document.getElementById('branchKpiMeta');
        if (!el) return;
        el.textContent = this._kpiMeta
            ? "KPI manbasi: server (" + this._kpiMeta.time + ")"
            : "KPI manbasi: lokal hisob (serverga ulanmadi)";
    },

    /* ── YARLIOQ BADGE va FAOL FILIAL TANLAGICH ──────────────── */
    updateNavBadge() {
        const badge = document.getElementById('navBranchesBadge');
        if (badge) badge.textContent = String(branches.length);
    },

    refreshBranchSwitcher() {
        const sel = document.getElementById('branchSwitcher');
        if (!sel) return;
        // Dropdown tanlovning o'zini aks ettiradi: activeBranchId bo'sh bo'lsa —
        // "Barcha filiallar" (getActiveBranch fallback'i faqat KPI uchun).
        const activeId = String(activeBranchId || '');
        const options = ['<option value="">Barcha filiallar</option>'].concat(
            branches.map(b => '<option value="' + escapeHTML(b.id) + '"' +
                (String(b.id) === activeId ? ' selected' : '') + '>' +
                escapeHTML(b.name) + '</option>'));
        sel.innerHTML = options.join('');
        if (sel.value !== activeId) sel.value = activeId;
    },

    setActive(id) {
        activeBranchId = String(id || '');
        try {
            if (activeBranchId) localStorage.setItem('tp_active_branch', activeBranchId);
            else localStorage.removeItem('tp_active_branch');
        } catch (e) { }
        const b = activeBranchId ? getActiveBranch() : null;
        showNotif('info', 'Faol filial', b ? (b.name + ' tanlandi — savdo va ombor shu filialga tegishli bo\'ladi') : 'Barcha filiallar ko\'rsatilmoqda');
        this.refreshBranchSwitcher();
        this.render();
        // Ochiq Kassa va ombor filial almashganda darhol yangilanadi
        try { if (typeof renderCatTabs === 'function') renderCatTabs(); } catch (e) { }
        try { if (typeof renderProductGrid === 'function') renderProductGrid(); } catch (e) { }
        try { if (typeof renderWarehousePage === 'function') renderWarehousePage(); } catch (e) { }
    },

    /* ── SAHIFA RENDER: statistika + jadval + taqsimot ───────── */
    render() {
        if (!document.getElementById('branchesTable')) return;
        this.renderStats();
        this.renderTable();
        this.renderDistribution();
        this.renderKpiMeta();
        this.updateNavBadge();
        this.refreshBranchSwitcher();
    },

    renderStats() {
        const q = (id) => document.getElementById(id);
        const total = branches.length;
        const active = activeBranches().length;
        let productsCount = 0;
        const activeBranch = getActiveBranch();
        if (activeBranch) {
            productsCount = products.filter(p => String(p.branchId || '') === String(activeBranch.id)).length;
        } else {
            productsCount = products.filter(p => p.branchId).length;
        }
        let nearest = null;
        if (activeBranch) nearest = activeBranch;
        else if (activeBranches().length) nearest = activeBranches().find(b => b.isMain) || activeBranches()[0];
        if (q('branchCount')) q('branchCount').textContent = String(total);
        if (q('branchActiveCount')) q('branchActiveCount').textContent = String(active);
        if (q('branchProductsCount')) q('branchProductsCount').textContent = String(productsCount);
        if (q('branchNearestLabel')) q('branchNearestLabel').textContent = nearest ? nearest.name : '—';
    },

    filteredBranches() {
        const searchEl = document.getElementById('branchSearch');
        const statusEl = document.getElementById('branchStatusFilter');
        const term = (searchEl ? searchEl.value : '').trim().toLowerCase();
        const status = statusEl ? statusEl.value : '';
        return branches.filter(b => {
            if (status && b.status !== status) return false;
            if (!term) return true;
            return [b.name, b.city, b.address, b.code, b.phone].some(v => String(v || '').toLowerCase().includes(term));
        });
    },

    /** Savdo qaysi filialga tegishli — backend `sale_branch()` bilan bir xil mantiq. */
    saleBranchId(sale) {
        const direct = String(sale?.branchId || '').trim();
        if (direct) return direct;
        const ids = new Set();
        (Array.isArray(sale?.items) ? sale.items : []).forEach(it => {
            const p = products.find(x => String(x?.id) === String(it?.id));
            if (p && p.branchId) ids.add(String(p.branchId));
        });
        return ids.size === 1 ? Array.from(ids)[0] : '';
    },

    /**
     * Filial KPI: server summary (database manba) bo'lsa — undan, aks holda
     * lokal sinxron ma'lumotdan BIR XIL formula bilan (offline rejim):
     * sof natija = savdo + kirim − chiqim − harajat.
     */
    kpiFor(b) {
        const cached = this._kpi[String(b?.id)];
        if (cached) {
            return {
                products: Number(cached.products) || 0,
                stockValue: Number(cached.stockValue) || 0,
                salesCount: Number(cached.salesCount) || 0,
                revenue: Number(cached.revenue) || 0,
                income: Number(cached.income) || 0,
                expense: Number(cached.expense) || 0,
                harajat: Number(cached.harajat) || 0,
                profit: Number(cached.profit) || 0,
            };
        }
        const bid = String(b?.id || '');
        const bProducts = products.filter(p => String(p?.branchId || '') === bid);
        const stockValue = bProducts.reduce((s, p) =>
            s + (Number(p?.price) || 0) * (Number(p?.stock) || 0), 0);
        const paid = salesHistory.filter(s => isPaidSale(s) && this.saleBranchId(s) === bid);
        const revenue = paid.reduce((s, x) => s + (Number(x?.total) || 0), 0);
        const flows = (Array.isArray(cashFlow) ? cashFlow : [])
            .filter(c => String(c?.branchId || '') === bid);
        const sumBy = (types) => flows.reduce((s, c) =>
            s + (types.includes(String(c?.type || '')) ? (Number(c?.amount) || 0) : 0), 0);
        const income = sumBy(['kirim', 'income']);
        // Eski yozuvlarda `type` bo'sh — backend uni 'chiqim' deb oladi
        const expense = sumBy(['chiqim', 'expense', '']);
        const harajat = sumBy(['harajat']);
        return {
            products: bProducts.length,
            stockValue,
            salesCount: paid.length,
            revenue,
            income,
            expense,
            harajat,
            profit: revenue + income - expense - harajat,
        };
    },

    renderTable() {
        const tbody = document.getElementById('branchesTable');
        if (!tbody) return;
        const list = this.filteredBranches();
        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:28px;color:var(--muted)">' +
                (branches.length ? 'Qidiruv natijasi topilmadi' : 'Hali filial qo\'shilmagan — "Yangi filial" tugmasini bosing') + '</td></tr>';
            return;
        }
        const canManage = requireRoleSilent('admin', 'manager');
        tbody.innerHTML = list.map(b => {
            const k = this.kpiFor(b);
            const isMain = b.isMain ? '<span class="branch-main-tag"><i class="fas fa-star"></i> Asosiy</span>' : '';
            const profitColor = k.profit >= 0 ? 'var(--success)' : 'var(--danger)';
            return '<tr>' +
                '<td><div class="branch-badge" style="background:' + escapeHTML(b.markerColor) + '">' +
                '<span>' + escapeHTML(b.markerIcon) + '</span></div></td>' +
                '<td><strong>' + escapeHTML(b.name) + '</strong>' + isMain +
                (b.code ? '<div style="font-size:11px;color:var(--muted)">' + escapeHTML(b.code) + '</div>' : '') + '</td>' +
                // data-label — faqat MOBIL karta yorliqlari (presentation, CSS ::before
                // ichidan o'qiladi). Ma'lumot/summalar o'zgarmagan, faqat yorliq qo'shilgan.
                '<td data-label="Manzil">' + escapeHTML([b.city, b.address].filter(Boolean).join(', ') || '—') + '</td>' +
                '<td data-label="Telefon">' + (b.phone ? '<a href="tel:' + escapeHTML(b.phone) + '">' + escapeHTML(b.phone) + '</a>' : '—') +
                (b.hours ? '<div style="font-size:11px;color:var(--muted)">' + escapeHTML(b.hours) + '</div>' : '') + '</td>' +
                '<td data-label="Mahsulot">' + k.products + '</td>' +
                '<td data-label="Ombor qiymati">' + fmt(k.stockValue) + ' so\'m</td>' +
                '<td data-label="Savdo">' + k.salesCount + ' ta / ' + fmt(k.revenue) + ' so\'m</td>' +
                '<td data-label="Kirim" style="color:var(--success)">' + fmt(k.income) + ' so\'m</td>' +
                '<td data-label="Chiqim" style="color:var(--danger)" title="Chiqim: ' + fmt(k.expense) + ' so\'m · Harajat: ' + fmt(k.harajat) + ' so\'m">' +
                fmt(k.expense + k.harajat) + ' so\'m</td>' +
                '<td data-label="Sof foyda" style="font-weight:700;color:' + profitColor + '">' +
                (k.profit < 0 ? '−' : '') + fmt(Math.abs(k.profit)) + ' so\'m</td>' +
                '<td data-label="Holat">' + (b.status === 'active'
                    ? '<span style="color:var(--success)"><i class="fas fa-circle-check"></i> Faol</span>'
                    : '<span style="color:var(--muted)"><i class="fas fa-circle-pause"></i> Nofaol</span>') +
                (canManage ? '<button type="button" class="btn btn-outline btn-sm" style="margin-left:6px" ' +
                    'title="Holatni almashtirish" onclick="Branches.toggleStatus(\'' + jsStrAttr(b.id) + '\')">' +
                    '<i class="fas fa-arrows-rotate"></i></button>' : '') + '</td>' +
                '<td><div style="display:flex;gap:6px">' +
                '<button class="btn btn-outline btn-sm" onclick="Branches.view(\'' + jsStrAttr(b.id) + '\')" title="Batafsil"><i class="fas fa-eye"></i></button>' +
                (canManage
                    ? '<button class="btn btn-outline btn-sm" onclick="Branches.edit(\'' + jsStrAttr(b.id) + '\')" title="Tahrirlash"><i class="fas fa-pen"></i></button>' +
                    '<button class="btn btn-outline btn-sm" style="color:var(--danger)" onclick="Branches.remove(\'' + jsStrAttr(b.id) + '\')" title="O\'chirish"><i class="fas fa-trash"></i></button>'
                    : '') +
                '</div></td></tr>';
        }).join('');
    },

    renderDistribution() {
        const wrap = document.getElementById('branchDistribution');
        if (!wrap) return;
        const cities = {};
        branches.forEach(b => {
            const key = cleanText(b.city, 80) || 'Ko\'rsatilmagan';
            cities[key] = (cities[key] || 0) + 1;
        });
        const entries = Object.entries(cities).sort((a, b2) => b2[1] - a[1]);
        if (!entries.length) { wrap.innerHTML = '<div style="color:var(--muted);font-size:13px">Ma\'lumot yo\'q</div>'; return; }
        const max = entries[0][1];
        wrap.innerHTML = entries.map(([city, count]) =>
            '<div class="branch-dist-row">' +
            '<span class="branch-dist-city">' + escapeHTML(city) + '</span>' +
            '<div class="branch-dist-bar"><div style="width:' + Math.round((count / max) * 100) + '%"></div></div>' +
            '<span class="branch-dist-count">' + count + '</span></div>').join('');
    },

    /* ── KPI yuklash (server: /api/branches + /api/branches/summary) ── */
    async loadSummary(showNotifOnDone) {
        await this.loadFromServer();
        const fromServer = await this.loadKpiFromServer();
        this.render();
        if (showNotifOnDone) {
            showNotif('success', 'Yangilandi', fromServer
                ? "Filial KPI database'dan yangilandi (" + (this._kpiMeta ? this._kpiMeta.time : '') + ")"
                : "KPI serverdan olindi emas — lokal hisob ko'rsatilmoqda");
        }
    },

    /* ── KO'RISH / TAHRIRLASH / O'CHIRISH ────────────────────── */
    view(id) {
        const b = getBranchById(id);
        if (!b) return;
        const body = document.getElementById('branchViewBody');
        if (!body) return;
        document.getElementById('branchViewTitle').innerHTML =
            '<i class="fas fa-map-location-dot" style="color:var(--primary);margin-right:8px"></i>' + escapeHTML(b.name);
        const k = this.kpiFor(b);
        const profitSpan = '<span style="font-weight:700;color:' +
            (k.profit >= 0 ? 'var(--success)' : 'var(--danger)') + '">' + fmt(k.profit) + " so'm</span>";
        const rows = [
            ['Kod', b.code || '—'], ['Shahar', b.city || '—'], ['Manzil', b.address || '—'],
            ['Telefon', b.phone || '—'], ['Ish vaqti', b.hours || '—'],
            ['Holat', b.status === 'active' ? 'Faol' : 'Nofaol'],
            ['Asosiy filial', b.isMain ? 'Ha' : 'Yo\'q'],
            ['Koordinata', (b.lat != null && b.lng != null) ? (b.lat.toFixed(6) + ', ' + b.lng.toFixed(6)) : '—'],
            ['Mahsulot', k.products + ' ta'],
            ['Zaxira qiymati', fmt(k.stockValue) + " so'm"],
            ['Savdo / Tushum', k.salesCount + ' ta chek / ' + fmt(k.revenue) + " so'm"],
            ['Kirim', fmt(k.income) + " so'm"],
            ['Chiqim / Harajat', fmt(k.expense + k.harajat) + " so'm"],
            ['Sof natija', profitSpan],
        ];
        body.innerHTML = '<div class="branch-view-grid">' + rows.map(([k, v]) => {
            const safeVal = (typeof v === 'string' && v.startsWith('<')) ? v : escapeHTML(v);
            return '<div class="branch-view-label">' + escapeHTML(k) + '</div><div class="branch-view-value">' +
                safeVal + '</div>';
        }).join('') + '</div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
            (requireRoleSilent('admin', 'manager')
                ? '<button class="btn btn-outline" onclick="closeModal(\'branchViewModal\');Branches.edit(\'' + escapeHTML(b.id) + '\')"><i class="fas fa-pen"></i> Tahrirlash</button>' : '') +
            '<button class="btn btn-primary" onclick="closeModal(\'branchViewModal\')">Yopish</button></div>';
        openModal('branchViewModal');
    },

    openAddModal() {
        if (!requireRole('admin', 'manager')) return;
        this._editingId = null;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        set('br-name', ''); set('br-code', ''); set('br-city', '');
        set('br-phone', ''); set('br-address', ''); set('br-hours', '09:00 — 20:00');
        set('br-status', 'active');
        const colorEl = document.getElementById('br-color');
        if (colorEl) colorEl.value = BRANCH_COLORS[branches.length % BRANCH_COLORS.length];
        const mainEl = document.getElementById('br-main');
        if (mainEl) mainEl.checked = false;
        branchPickIcon = BRANCH_ICONS[0];
        branchPickColor = BRANCH_COLORS[branches.length % BRANCH_COLORS.length];
        const title = document.getElementById('branchModalTitle');
        if (title) title.innerHTML = '<i class="fas fa-map-location-dot" style="color:var(--primary);margin-right:8px"></i>Yangi filial';
        this.renderPickers();
        this.renderMarkerPreview();
        openModal('branchModal');
    },

    edit(id) {
        if (!requireRole('admin', 'manager')) return;
        const b = getBranchById(id);
        if (!b) return;
        this._editingId = String(b.id);
        const set = (id2, v) => { const el = document.getElementById(id2); if (el) el.value = v; };
        set('br-name', b.name); set('br-code', b.code); set('br-city', b.city);
        set('br-phone', b.phone); set('br-address', b.address); set('br-hours', b.hours);
        set('br-status', b.status);
        const colorEl = document.getElementById('br-color');
        if (colorEl) colorEl.value = b.markerColor;
        const mainEl = document.getElementById('br-main');
        if (mainEl) mainEl.checked = Boolean(b.isMain);
        branchPickIcon = b.markerIcon; branchPickColor = b.markerColor;
        const title = document.getElementById('branchModalTitle');
        if (title) title.innerHTML = '<i class="fas fa-pen" style="color:var(--primary);margin-right:8px"></i>Filialni tahrirlash';
        this.renderPickers();
        this.renderMarkerPreview();
        openModal('branchModal');
    },

    /** Lokal tezkor tekshiruv: filialga bog'liq yozuvlar (yakuniy tekshiruv serverda). */
    refCounts(bid) {
        const key = String(bid || '');
        return {
            products: products.filter(p => String(p?.branchId || '') === key).length,
            sales: salesHistory.filter(s => String(s?.branchId || '') === key).length,
            cashFlow: (Array.isArray(cashFlow) ? cashFlow : [])
                .filter(c => String(c?.branchId || '') === key).length,
            staff: (Array.isArray(employees) ? employees : [])
                .filter(u => String(u?.branchId || '') === key).length,
        };
    },

    refText(r) {
        const parts = [];
        if (r.products) parts.push(r.products + ' mahsulot');
        if (r.sales) parts.push(r.sales + ' savdo');
        if (r.cashFlow) parts.push(r.cashFlow + ' kirim/chiqim');
        if (r.staff) parts.push(r.staff + ' xodim');
        return parts.join(', ');
    },

    async toggleStatus(id) {
        const b = getBranchById(id);
        if (!b) return;
        await this.setStatus(id, b.status === 'active' ? 'inactive' : 'active');
    },

    /** Holatni BACKEND orqali saqlash — database'da yangilanadi, reload'da saqlanadi. */
    async setStatus(id, status) {
        if (!requireRole('admin', 'manager')) return false;
        const b = getBranchById(id);
        if (!b) return false;
        const next = status === 'inactive' ? 'inactive' : 'active';
        try {
            const res = await fetchWithTimeout('/api/branches/' + encodeURIComponent(b.id) + '/status', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ status: next })
            }, 8000);
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || data.status !== 'success') {
                playError();
                showNotif('error', 'Saqlanmadi', (data && data.message) || 'Holatni o\'zgartirib bo\'lmadi');
                return false;
            }
            // Lokal nusxa — keyingi sync bilan ham mos qoladi (server allaqachon yangi)
            b.status = next;
            try { localStorage.setItem('tp_branches', JSON.stringify(branches)); } catch (e) { }
            this.render();
            addLog('Filial holati', b.name + ' — ' + (next === 'active' ? 'faol' : 'nofaol'));
            playSuccess();
            showNotif('success', 'Holat yangilandi', '"' + b.name + '" — ' + (next === 'active' ? 'Faol' : 'Nofaol'));
            return true;
        } catch (e) {
            playError();
            showNotif('error', 'Serverga ulanib bo\'lmadi', 'Holat saqlanmadi — o\'zgarish amalga oshmadi');
            return false;
        }
    },

    async remove(id) {
        if (!requireRole('admin', 'manager')) return;
        const b = getBranchById(id);
        if (!b) return;
        // Tekshiruv 1: lokal tezkor hisob — bog'liq ma'lumot bo'lsa o'chirish
        // o'rnina nofaol qilish taklif qilinadi (tarix himoyalanadi).
        const localRefs = this.refCounts(b.id);
        if (Object.values(localRefs).reduce((a, n) => a + n, 0)) {
            if (confirm('"' + b.name + '" filialida bog\'liq ma\'lumotlar bor:\n' +
                this.refText(localRefs) + '.\n\n' +
                'Tarix yo\'qolmasligi uchun o\'chirish o\'rnina filialni NOFAOL qilish tavsiya etiladi.\n' +
                'Filialni nofaol qilasizmi? (OK — ha, Bekor — hech narsa)')) {
                await this.setStatus(id, 'inactive');
            }
            return;
        }
        if (!confirm('"' + b.name + '" filialini bazadan o\'chirmoqchimisiz?')) return;
        try {
            // Tekshiruv 2: serverda yakuniy yaxlitlik tekshiruvi (frontend
            // hisobi yangi bo'lishi mumkin — server qarori yakuniy).
            const res = await fetchWithTimeout('/api/branches/' + encodeURIComponent(b.id), {
                method: 'DELETE',
                headers: authHeaders()
            }, 8000);
            const data = await res.json().catch(() => null);
            if (res.status === 409) {
                playError();
                showNotif('error', 'O\'chirib bo\'lmadi',
                    (data && data.message) || ('Bog\'liq ma\'lumotlar bor: ' + this.refText((data && data.related) || localRefs)));
                return;
            }
            if (!res.ok || !data || data.status !== 'success') {
                playError();
                showNotif('error', 'O\'chirilmadi', (data && data.message) || 'Server xatosi — filial o\'chirilmadi');
                return;
            }
            branches = branches.filter(x => String(x.id) !== String(b.id));
            if (activeBranchId === String(b.id)) {
                activeBranchId = '';
                try { localStorage.removeItem('tp_active_branch'); } catch (e) { }
                try { this.refreshBranchSwitcher(); } catch (e) { }
            }
            delete this._kpi[String(b.id)];
            saveBranches();
            this.render();
            addLog('Filial o\'chirildi', b.name);
            playSuccess();
            showNotif('success', 'O\'chirildi', '"' + b.name + '" filiali bazadan o\'chirildi');
        } catch (e) {
            playError();
            showNotif('error', 'Serverga ulanib bo\'lmadi', 'O\'chirish bajarilmadi — filial saqlanib qoldi');
        }
    },

    save() {
        if (!requireRole('admin', 'manager')) return;
        const get = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
        const raw = {
            id: this._editingId || ('br-' + Date.now()),
            name: get('br-name'), code: get('br-code'), city: get('br-city'),
            address: get('br-address'), phone: get('br-phone'), hours: get('br-hours'),
            status: get('br-status') === 'inactive' ? 'inactive' : 'active',
            isMain: Boolean(document.getElementById('br-main')?.checked),
            markerIcon: branchPickIcon, markerColor: branchPickColor
        };
        if (!cleanText(raw.name, 120)) { playError(); showNotif('error', 'Xato', 'Filial nomini kiriting'); return; }
        if (raw.isMain) branches.forEach(b => { b.isMain = false; });
        const norm = normalizeBranch(raw);
        if (!norm) { playError(); showNotif('error', 'Xato', 'Ma\'lumotlarni tekshirib qayta urinib ko\'ring'); return; }
        if (this._editingId) {
            const idx = branches.findIndex(b => String(b.id) === String(this._editingId));
            if (idx >= 0) branches[idx] = norm;
        } else {
            branches.push(norm);
        }
        saveBranches();
        closeModal('branchModal');
        this.render();
        addLog(this._editingId ? 'Filial tahrirlandi' : 'Filial qo\'shildi', norm.name);
        playSuccess();
        showNotif('success', 'Saqlandi', '"' + norm.name + '" filiali saqlandi');
        this._editingId = null;
        // KPI serverga sync dan keyin yangilansin (yangi filial summary'da paydo bo'ladi)
        setTimeout(() => { this.loadSummary(false); }, 1500);
    },

    /* ── MARKER PICKER (emoji + rang) ────────────────────────── */
    renderPickers() {
        const iconWrap = document.getElementById('branchIconPicker');
        if (iconWrap) {
            iconWrap.innerHTML = BRANCH_ICONS.map(ic =>
                '<button type="button" class="marker-option' + (ic === branchPickIcon ? ' selected' : '') +
                '" onclick="Branches.setPickIcon(\'' + ic + '\')">' + ic + '</button>').join('');
        }
        const swWrap = document.getElementById('branchColorSwatches');
        if (swWrap) {
            swWrap.innerHTML = BRANCH_COLORS.map(c =>
                '<button type="button" class="color-swatch' + (c === branchPickColor ? ' selected' : '') +
                '" style="background:' + c + '" onclick="Branches.setPickColor(\'' + c + '\')"></button>').join('');
        }
        const colorInput = document.getElementById('br-color');
        if (colorInput && !colorInput.dataset.bound) {
            colorInput.dataset.bound = '1';
            colorInput.addEventListener('input', () => {
                branchPickColor = /^#[0-9a-fA-F]{6}$/.test(colorInput.value) ? colorInput.value : branchPickColor;
                this.renderMarkerPreview();
            });
        }
    },

    setPickIcon(icon) { branchPickIcon = icon; this.renderPickers(); this.renderMarkerPreview(); },
    setPickColor(color) {
        branchPickColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : branchPickColor;
        this.renderPickers(); this.renderMarkerPreview();
    },

    renderMarkerPreview() {
        const el = document.getElementById('branchMarkerPreview');
        if (el) el.innerHTML = '<div class="branch-badge" style="background:' + escapeHTML(branchPickColor) + '">' +
            '<span>' + escapeHTML(branchPickIcon) + '</span></div>';
    },

    /* ── CSV EKSPORT (ko'rsatilayotgan FILTRLANGAN ro'yxat + KPI) ── */
    exportCSV() {
        const list = this.filteredBranches();
        if (!list.length) { showNotif('warning', 'Bo\'sh', 'Eksport uchun filial yo\'q'); return; }
        const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const head = ['Nomi', 'Kod', 'Shahar', 'Manzil', 'Telefon', 'Ish vaqti',
            'Holat', 'Mahsulot', 'Zaxira qiymati', 'Savdo (chek)', 'Savdo tushumi',
            'Kirim', 'Chiqim', 'Harajat', 'Sof natija'].join(';');
        const lines = list.map(b => {
            const k = this.kpiFor(b);
            return [
                b.name, b.code, b.city, b.address, b.phone, b.hours,
                b.status === 'active' ? 'Faol' : 'Nofaol',
                k.products, k.stockValue, k.salesCount, k.revenue,
                k.income, k.expense, k.harajat, k.profit
            ].map(esc).join(';');
        });
        const csv = '\ufeff' + head + '\n' + lines.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'filiallar-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        showNotif('success', 'CSV yuklab olindi', list.length + ' ta filial eksport qilindi');
    }
};

// ============================================================
// KIRIM / CHIQIM / HARAJAT MODULI — admin uchun moliyaviy nazorat
// ============================================================
// Admin asosan kirim/chiqim/harajatga qaraydi: har bir filial bo'yicha
// pul harakati kuzatiladi, savdo tushumi esa alohida ko'rsatiladi.
// ============================================================
// KIRIM-CHIQIM MODULI — dizaynga mos qayta ishlangan ko'rinish
// ============================================================
// Mantiq o'zgartirilmadi: yozuvlar `cashFlow` kaliti ostida, POS
// savdosi esa `sales` ro'yxatida alohida saqlanadi (takroriy
// hisob yo'q). Sof pul oqimi = kirim − chiqim − xarajat.
const CF_TYPE_HINTS = {
    kirim: "Kirim: kassaga yoki hisobga pul tushgan holatlar (savdo tushumi, qarz to'lov, bankdan o'tkazma va h.k.).",
    chiqim: "Chiqim: kassadan pul chiqqan holatlar (ta'minotchi to'lovi, maosh, ijara va h.k.).",
    harajat: "Xarajat: do'kon operatsiyasiga tegishli sarflar (kommunal, reklama, ta'mirlash va h.k.).",
};

const CashFlow = {
    _type: 'kirim',
    _page: 1,
    _size: 10,
    _open: false,

    init() {
        this._wireGlobal();
        this.setType('kirim');
        const dateEl = document.getElementById('cf-date');
        if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
        try { this.fillBranchSelects(); } catch (e) { }
        try { this.fillCategorySelects(); } catch (e) { }
        try { this.fillCategoryFilter(); } catch (e) { }
        try { CompanyLive.fill(); } catch (e) { }
        try {
            const f = document.getElementById('cfFrom'), t = document.getElementById('cfTo');
            if (f && t && !f.value && !t.value) { this.setPeriod('month'); return; }
            this.render();
        } catch (e) { }
    },

    onPageOpen() {
        try { this.fillBranchSelects(); } catch (e) { }
        try { this.fillCategorySelects(); } catch (e) { }
        try { this.fillCategoryFilter(); } catch (e) { }
        try { CompanyLive.fill(); } catch (e) { }
        this.render();
    },

    /** Esc = yopish, tashqi bosish = menyu yopish (bir marta ulanadi). */
    _wireGlobal() {
        if (CashFlow._wired) return;
        CashFlow._wired = true;
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && CashFlow._open) CashFlow.closePanel();
        });
        document.addEventListener('click', e => {
            const menu = e.target.closest && e.target.closest('.cf-actions');
            if (!menu) document.querySelectorAll('.cf-actions.open').forEach(m => m.classList.remove('open'));
        });
    },

    /** Yozuv formasi va filtr uchun filial tanlagichlarini to'ldiradi. */
    fillBranchSelects() {
        const activeId = (getActiveBranch() || {}).id || '';
        const options = branches.map(b =>
            '<option value="' + escapeHTML(b.id) + '">' + escapeHTML(b.name) + '</option>').join('');

        const sel = document.getElementById('cf-branch');
        if (sel) {
            const cur = sel.value || activeId;
            sel.innerHTML = '<option value="">Umumiy (filialga bog\'lanmagan)</option>' + options;
            if (cur && branches.some(b => String(b.id) === String(cur))) sel.value = cur;
        }
        const filter = document.getElementById('cfFilterBranch');
        if (filter) {
            const cur = filter.value;
            filter.innerHTML = '<option value="">Barcha filiallar</option>' + options;
            if (cur && branches.some(b => String(b.id) === String(cur))) filter.value = cur;
        }
    },

    /** Formaning kategoriya tanlagichini ro'yxat + real yozuvlardan to'ldiradi. */
    fillCategorySelects() {
        const sel = document.getElementById('cf-category');
        if (!sel) return;
        const cur = sel.value;
        const list = this.categoryList();
        sel.innerHTML = list.map(c => '<option value="' + escapeHTML(c) + '">' + escapeHTML(c) + '</option>').join('');
        if (cur && list.indexOf(cur) !== -1) sel.value = cur;
    },

    /** Filtr uchun kategoriyalar: standart ro'yxat + bazadagi real qiymatlar. */
    fillCategoryFilter() {
        const sel = document.getElementById('cfFilterCat');
        if (!sel) return;
        const cur = sel.value;
        const list = this.categoryList();
        sel.innerHTML = '<option value="">Barcha kategoriyalar</option>' +
            list.map(c => '<option value="' + escapeHTML(c) + '">' + escapeHTML(c) + '</option>').join('');
        if (cur && list.indexOf(cur) !== -1) sel.value = cur;
    },

    categoryList() {
        const seen = new Set(CASHFLOW_CATEGORIES);
        cashFlow.forEach(c => { const v = cleanText(c.category, 60); if (v) seen.add(v); });
        return Array.from(seen);
    },

    /** Panel ichidagi tur tugmasi — faqat turni tanlaydi (panelni ochmaydi). */
    setType(type) {
        this._type = Object.prototype.hasOwnProperty.call(CASHFLOW_TYPES, type) ? type : 'kirim';
        document.querySelectorAll('[data-cf-type]').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-cf-type') === this._type);
        });
        const meta = CASHFLOW_TYPES[this._type];
        const panel = document.getElementById('cfPanel');
        if (panel) panel.setAttribute('data-type', this._type);
        const sub = document.getElementById('cfPanelSub');
        if (sub) sub.textContent = meta.label + " yozuvini qo'shish";
        const hint = document.getElementById('cfHintText');
        if (hint) hint.textContent = CF_TYPE_HINTS[this._type] || '';
        document.querySelectorAll('.cf-op').forEach(card => {
            card.classList.toggle('active', card.getAttribute('data-op') === this._type);
        });
    },

    /** Kartochka bosilganda o'ng panel ochiladi va tur avtomatik tanlanadi. */
    openPanel(type) {
        if (typeof type === 'string') this.setType(type);
        this._open = true;
        const layout = document.getElementById('cfLayout');
        const panel = document.getElementById('cfPanel');
        const scrim = document.getElementById('cfScrim');
        if (layout) layout.classList.add('panel-open');
        if (panel) {
            panel.classList.add('open');
            panel.setAttribute('aria-hidden', 'false');
        }
        if (scrim) scrim.classList.add('show');
        const amount = document.getElementById('cf-amount');
        if (amount) setTimeout(() => { try { amount.focus(); } catch (e) { } }, 60);
    },

    closePanel() {
        this._open = false;
        const layout = document.getElementById('cfLayout');
        const panel = document.getElementById('cfPanel');
        const scrim = document.getElementById('cfScrim');
        if (layout) layout.classList.remove('panel-open');
        if (panel) {
            panel.classList.remove('open');
            panel.setAttribute('aria-hidden', 'true');
        }
        if (scrim) scrim.classList.remove('show');
    },

    onSearch() { this._page = 1; this.render(); },
    onFilter() { this._page = 1; this.render(); },

    /** Sana + filial filtri — ko'rsatkichlar shu bo'yicha hisoblanadi. */
    scoped() {
        const branch = (document.getElementById('cfFilterBranch') || {}).value || '';
        return cashFlow.filter(c =>
            (!branch || String(c.branchId || '') === String(branch)) && this.inRange(c.date));
    },

    /** Filtrlar bo'yicha yozuvlar (eng yangisi birinchi). */
    filtered() {
        const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
        const type = val('cfFilterType');
        const cat = val('cfFilterCat');
        const q = String(val('cfSearch') || '').trim().toLowerCase();
        return this.scoped().filter(c => {
            if (type && c.type !== type) return false;
            if (cat && String(c.category || '') !== cat) return false;
            if (q) {
                const amt = String(c.amount || '') + ' ' + fmt(Number(c.amount) || 0);
                const hay = [c.category, c.note, c.user, amt].join(' ').toLowerCase();
                if (hay.indexOf(q) === -1) return false;
            }
            return true;
        }).sort((a, b) => String(b.date + ' ' + b.createdAt).localeCompare(String(a.date + ' ' + a.createdAt)));
    },

    /** Sana tanlangan oraliqqa (Dan–Gacha) kiradimi. */
    inRange(iso) {
        const from = (document.getElementById('cfFrom') || {}).value || '';
        const to = (document.getElementById('cfTo') || {}).value || '';
        const d = String(iso || '');
        return !(from && d < from) && !(to && d > to);
    },
    saleInRange(s) {
        const from = (document.getElementById('cfFrom') || {}).value || '';
        const to = (document.getElementById('cfTo') || {}).value || '';
        if (!from && !to) return true;
        const iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
        return dateParts(s.date).some(x => this.inRange(iso(x)));
    },
    /** Tez davr tanlash: Bugun / Bu oy / O'tgan oy / Bu yil / Hammasi. */
    setPeriod(p) {
        const now = new Date();
        const iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
        let from = '', to = '';
        if (p === 'today') { from = to = iso(now); }
        else if (p === 'month') { from = iso(new Date(now.getFullYear(), now.getMonth(), 1)); to = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
        else if (p === 'prev') { from = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)); to = iso(new Date(now.getFullYear(), now.getMonth(), 0)); }
        else if (p === 'year') { from = now.getFullYear() + '-01-01'; to = now.getFullYear() + '-12-31'; }
        const f = document.getElementById('cfFrom'), t = document.getElementById('cfTo'), sel = document.getElementById('cfPeriod');
        if (f) f.value = from; if (t) t.value = to; if (sel) sel.value = p;
        this._page = 1;
        this.render();
    },
    /** Filtrga mos to'langan savdolar tushumi (filial nazorati uchun). */
    saleRevenue() {
        const el = document.getElementById('cfFilterBranch');
        const branch = el ? el.value : '';
        return salesHistory
            .filter(s => isPaidSale(s) && (!branch || String(s.branchId || '') === String(branch)) && this.saleInRange(s))
            .reduce((sum, s) => sum + (Number(s.total) || 0), 0);
    },

    render() {
        const tbody = document.getElementById('cashFlowTableBody');
        if (!tbody) return;
        try { this.fillBranchSelects(); } catch (e) { }
        try { this.fillCategoryFilter(); } catch (e) { }

        const list = this.filtered();
        const pages = Math.max(1, Math.ceil(list.length / this._size));
        if (this._page > pages) this._page = pages;
        const start = (this._page - 1) * this._size;

        this.renderMetrics();
        const cnt = document.getElementById('cfRecordCount');
        if (cnt) cnt.textContent = list.length + ' ta yozuv';

        this.renderBranchMonitor();
        this.renderTable(list.slice(start, start + this._size), start);
        this.renderPager(list.length, start, pages);
    },

    /** To'rtta moliyaviy ko'rsatkich: sana va filial filtriga bog'liq. */
    renderMetrics() {
        const totals = cashFlowTotals(this.scoped());
        const counts = { kirim: 0, chiqim: 0, harajat: 0 };
        this.scoped().forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
        const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        setText('cfKirim', fmt(totals.kirim) + " so'm");
        setText('cfChiqim', fmt(totals.chiqim) + " so'm");
        setText('cfHarajat', fmt(totals.harajat) + " so'm");
        setText('cfNet', fmt(totals.net) + " so'm");
        setText('cfKirimCount', counts.kirim + ' ta operatsiya');
        setText('cfChiqimCount', counts.chiqim + ' ta operatsiya');
        setText('cfHarajatCount', counts.harajat + ' ta operatsiya');
        const net = document.getElementById('cfNet');
        if (net) net.classList.toggle('neg', totals.net < 0);
    },

    /** Har bir filial bo'yicha: savdo, kirim, chiqim, xarajat va sof natija. */
    renderBranchMonitor() {
        const tbody = document.getElementById('branchMonitorTable');
        if (!tbody) return;
        const rows = branches.map(b => {
            const bid = String(b.id);
            const revenue = salesHistory
                .filter(s => isPaidSale(s) && String(s.branchId || '') === bid && this.saleInRange(s))
                .reduce((sum, s) => sum + (Number(s.total) || 0), 0);
            const t = cashFlowTotals(cashFlowOfBranch(bid).filter(c => this.inRange(c.date)));
            const net = revenue + t.kirim - t.chiqim - t.harajat;
            return '<tr>' +
                '<td><div class="branch-badge" style="background:' + escapeHTML(b.markerColor) + '">' +
                '<span>' + escapeHTML(b.markerIcon) + '</span></div> ' +
                '<strong>' + escapeHTML(b.name) + '</strong>' +
                (b.isMain ? ' <span class="branch-main-tag"><i class="fas fa-star"></i></span>' : '') + '</td>' +
                '<td style="color:var(--success);font-weight:700">' + fmt(revenue) + '</td>' +
                '<td style="font-weight:700">' + fmt(t.kirim) + '</td>' +
                '<td style="color:var(--danger);font-weight:700">' + fmt(t.chiqim) + '</td>' +
                '<td style="color:var(--warning);font-weight:700">' + fmt(t.harajat) + '</td>' +
                '<td style="font-weight:800;color:' + (net >= 0 ? 'var(--success)' : 'var(--danger)') + '">' +
                fmt(net) + '</td>' +
                '<td><button class="btn btn-outline btn-sm" onclick="CashFlow.focusBranch(' +
                jsStrLiteral(b.id) + ')" title="Shu filial yozuvlarini ko\'rish">' +
                '<i class="fas fa-filter"></i></button></td></tr>';
        });

        // Filialga bog'lanmagan (umumiy) yozuvlar ham ko'rinadi
        const unassigned = cashFlow.filter(c => !String(c.branchId || '') && this.inRange(c.date));
        if (unassigned.length) {
            const t = cashFlowTotals(unassigned);
            rows.push('<tr style="opacity:.85"><td><em>Umumiy (filialsiz)</em></td>' +
                '<td>—</td><td style="font-weight:700">' + fmt(t.kirim) + '</td>' +
                '<td style="color:var(--danger);font-weight:700">' + fmt(t.chiqim) + '</td>' +
                '<td style="color:var(--warning);font-weight:700">' + fmt(t.harajat) + '</td>' +
                '<td style="font-weight:800">' + fmt(t.net) + '</td><td></td></tr>');
        }

        tbody.innerHTML = rows.join('') ||
            '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted)">' +
            'Filial qo\'shilmagan — «Filiallar» bo\'limidan qo\'shing</td></tr>';
    },

    /** Sahifalangan jadval qatorlari. */
    renderTable(list, offset) {
        const tbody = document.getElementById('cashFlowTableBody');
        if (!tbody) return;
        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:34px;color:var(--muted)">' +
                '<i class="fas fa-inbox" style="font-size:26px;display:block;margin-bottom:8px;opacity:.45"></i>' +
                'Yozuv topilmadi — yuqoridagi kartalar orqali kirim/chiqim/xarajat qo\'shing</td></tr>';
            return;
        }
        const canDel = requireRoleSilent('admin', 'manager');
        tbody.innerHTML = list.map((c, i) => {
            const meta = CASHFLOW_TYPES[c.type] || CASHFLOW_TYPES.chiqim;
            const branch = getBranchById(c.branchId);
            const sign = c.type === 'kirim' ? '+' : '\u2212';
            const tone = c.type === 'kirim' ? 'kirim' : (c.type === 'harajat' ? 'harajat' : 'chiqim');
            const createdAt = String(c.createdAt || '');
            const time = createdAt.slice(-8).indexOf(':') > 0 ? createdAt.slice(-8) : '';
            return '<tr>' +
                '<td class="cf-c-num">' + (offset + i + 1) + '</td>' +
                '<td class="cf-c-date"><b>' + escapeHTML(c.date) + '</b>' +
                (time ? '<small>' + escapeHTML(time) + '</small>' : '') + '</td>' +
                '<td><span class="cf-badge cf-badge-' + tone + '">' +
                '<i class="fas ' + meta.icon + '"></i>' + escapeHTML(meta.label) + '</span></td>' +
                '<td>' + escapeHTML(c.category) + '</td>' +
                '<td class="cf-c-note">' + escapeHTML(c.note || '—') + '</td>' +
                '<td>' + (branch ? escapeHTML(branch.name) : '<span style="color:var(--muted)">Umumiy</span>') + '</td>' +
                '<td class="cf-c-amt cf-amt-' + tone + '">' + sign + ' ' + fmt(c.amount) + " so'm</td>" +
                '<td class="cf-c-user">' + escapeHTML(c.user || '—') + '</td>' +
                '<td class="cf-c-act">' + (canDel
                    ? '<div class="cf-actions"><button class="cf-act-btn" title="Amallar" ' +
                    'onclick="CashFlow.toggleActions(event)"><i class="fas fa-ellipsis"></i></button>' +
                    '<div class="cf-actions-menu">' +
                    '<button onclick="CashFlow.remove(' + jsStrLiteral(c.id) + ')">' +
                    '<i class="fas fa-trash"></i> O\'chirish</button></div></div>'
                    : '<span style="color:var(--muted);opacity:.5">—</span>') + '</td></tr>';
        }).join('');
    },

    renderPager(total, start, pages) {
        const box = document.getElementById('cfPager');
        if (!box) return;
        if (!total) { box.innerHTML = ''; box.classList.remove('show'); return; }
        box.classList.add('show');
        const shown = Math.min(this._size, total - start);
        const nums = [];
        const push = p => nums.push('<button type="button" class="cf-pg' + (p === this._page ? ' active' : '') +
            '" onclick="CashFlow.gotoPage(' + p + ')">' + p + '</button>');
        const win = [];
        for (let p = 1; p <= pages; p++) {
            if (p === 1 || p === pages || Math.abs(p - this._page) <= 1) win.push(p);
        }
        win.forEach((p, i) => {
            if (i && p - win[i - 1] > 1) nums.push('<span class="cf-pg-gap">…</span>');
            push(p);
        });
        box.innerHTML =
            '<div class="cf-pg-nums">' +
            '<button type="button" class="cf-pg cf-pg-arrow" ' + (this._page <= 1 ? 'disabled' : '') +
            ' onclick="CashFlow.gotoPage(' + (this._page - 1) + ')"><i class="fas fa-chevron-left"></i></button>' +
            nums.join('') +
            '<button type="button" class="cf-pg cf-pg-arrow" ' + (this._page >= pages ? 'disabled' : '') +
            ' onclick="CashFlow.gotoPage(' + (this._page + 1) + ')"><i class="fas fa-chevron-right"></i></button>' +
            '</div>' +
            '<div class="cf-pg-side">' +
            '<span class="cf-pg-info">' + (start + 1) + '–' + (start + shown) + ' / ' + total + ' ta yozuv</span>' +
            '<select class="form-control cf-pg-size" onchange="CashFlow.setSize(this.value)">' +
            [10, 20, 50].map(n => '<option value="' + n + '"' + (n === this._size ? ' selected' : '') + '>' +
                n + ' ta</option>').join('') + '</select></div>';
    },

    gotoPage(p) {
        const total = this.filtered().length;
        const pages = Math.max(1, Math.ceil(total / this._size));
        this._page = Math.min(Math.max(1, Number(p) || 1), pages);
        this.render();
    },
    setSize(v) {
        this._size = Math.max(10, Math.min(200, Number(v) || 10));
        this._page = 1;
        this.render();
    },

    toggleActions(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const wrap = e && e.currentTarget ? e.currentTarget.closest('.cf-actions') : null;
        if (!wrap) return;
        const was = wrap.classList.contains('open');
        document.querySelectorAll('.cf-actions.open').forEach(m => m.classList.remove('open'));
        if (!was) wrap.classList.add('open');
    },

    save() {
        if (!requireRole('admin', 'manager')) return;
        const amountRaw = String(document.getElementById('cf-amount')?.value || '').replace(/[^\d.]/g, '');
        const amount = Number(amountRaw);
        if (!Number.isFinite(amount) || amount <= 0) {
            playError();
            showNotif('error', 'Xato!', 'Summani kiriting (0 dan katta bo\'lishi kerak)');
            const a = document.getElementById('cf-amount'); if (a) a.focus();
            return; // panel yopilmaydi
        }
        const record = normalizeCashFlow({
            type: this._type,
            amount,
            category: document.getElementById('cf-category')?.value,
            note: document.getElementById('cf-note')?.value,
            branchId: document.getElementById('cf-branch')?.value,
            date: document.getElementById('cf-date')?.value,
            user: currentUser?.name || '—',
        });
        if (!record) {
            playError();
            showNotif('error', 'Xato!', 'Ma\'lumotlar yaroqsiz — qayta tekshiring');
            return; // panel yopilmaydi
        }
        cashFlow.unshift(record);
        saveToStorage();
        const branch = getBranchById(record.branchId);
        addLog('Kassa harakati', CASHFLOW_TYPES[record.type].label + ': ' + fmt(record.amount) +
            " so'm — " + record.category + (branch ? ' (' + branch.name + ')' : ''));

        const amountEl = document.getElementById('cf-amount');
        const noteEl = document.getElementById('cf-note');
        if (amountEl) amountEl.value = '';
        if (noteEl) noteEl.value = '';
        const cnt = document.getElementById('cfNoteCount'); if (cnt) cnt.textContent = '0';
        this.closePanel();
        this.render();
        playSuccess();
        showNotif('success', 'Saqlandi!', CASHFLOW_TYPES[record.type].label + ' — ' +
            fmt(record.amount) + " so'm qo'shildi");
    },

    remove(id) {
        if (!requireRole('admin', 'manager')) return;
        document.querySelectorAll('.cf-actions.open').forEach(m => m.classList.remove('open'));
        const rec = cashFlow.find(c => String(c.id) === String(id));
        if (!rec) return;
        if (!confirm('Bu yozuvni o\'chirasizmi? (' + fmt(rec.amount) + " so'm)")) return;
        cashFlow = cashFlow.filter(c => String(c.id) !== String(id));
        saveToStorage();
        this.render();
        addLog('Kassa harakati', 'Yozuv o\'chirildi — ' + fmt(rec.amount) + " so'm");
        showNotif('info', 'O\'chirildi', 'Yozuv o\'chirildi');
    },

    /** Filial ustunidagi filtr tugmasi: shu filial yozuvlarini ko'rsatadi. */
    focusBranch(branchId) {
        const el = document.getElementById('cfFilterBranch');
        if (el) el.value = branchId;
        this._page = 1;
        this.render();
        const b = getBranchById(branchId);
        showNotif('info', 'Filtr', (b ? b.name : 'Filial') + ' bo\'yicha yozuvlar ko\'rsatilmoqda');
    },

    clearFilters() {
        ['cfFilterBranch', 'cfFilterType', 'cfFilterCat', 'cfFrom', 'cfTo', 'cfSearch'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const sel = document.getElementById('cfPeriod'); if (sel) sel.value = 'all';
        this._page = 1;
        this.render();
    },

    exportCSV() {
        const list = this.filtered();
        if (!list.length) {
            showNotif('warning', 'Bo\'sh', 'Eksport uchun yozuv yo\'q');
            return;
        }
        const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const head = ['Sana', 'Vaqt', 'Turi', 'Kategoriya', 'Filial', 'Summa', 'Izoh', 'Xodim'].join(';');
        const lines = list.map(c => {
            const b = getBranchById(c.branchId);
            return [c.date, String(c.createdAt || '').slice(-8),
            CASHFLOW_TYPES[c.type] ? CASHFLOW_TYPES[c.type].label : c.type,
            c.category, b ? b.name : 'Umumiy', c.amount, c.note, c.user].map(esc).join(';');
        });
        const csv = '\ufeff' + head + '\n' + lines.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'kirim-chiqim-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        showNotif('success', 'CSV yuklab olindi', list.length + ' ta yozuv eksport qilindi');
    }
};





// ============================================================
// KOMPANIYA MA'LUMOTLARI — tahrirlash darhol saqlanadi va hamma joyda o'zgaradi
// ============================================================
const CompanyLive = {
    _t: null,
    map: {
        companyName: ['companyName', 'cf-co-name', 120],
        companyPhone: ['companyPhone', 'cf-co-phone', 40],
        companyAddress: ['companyAddress', 'cf-co-address', 200],
        companyTin: ['companyTin', 'cf-co-tin', 20],
    },
    set(field, raw, srcEl) {
        if (!requireRoleSilent('admin')) return;
        const m = this.map[field]; if (!m) return;
        systemSettings[field] = cleanText(raw, m[2]);
        // Ikkala joydagi (Sozlamalar va Kirim/Chiqim) maydon bir xil bo'lib turadi
        [m[0], m[1]].forEach(id => { const el = document.getElementById(id); if (el && el !== srcEl) el.value = systemSettings[field]; });
        try { localStorage.setItem('tp_settings', JSON.stringify(systemSettings)); } catch (e) {
            try { localStorage.setItem('tp_settings', JSON.stringify({ ...systemSettings, companyLogo: safeImageLink(systemSettings.companyLogo) })); } catch (e2) { }
        }
        try { applyBranding(); } catch (e) { }          // nom: yon panel, login, do'kon — darhol
        const st = document.getElementById('cfCoStatus'); if (st) st.textContent = '✓ Saqlandi';
        clearTimeout(this._t);
        this._t = setTimeout(() => { scheduleSyncWithBackend(300); }, 700);   // serverga sinxron
    },
    fill() {
        const admin = requireRoleSilent('admin');
        Object.entries(this.map).forEach(([field, m]) => {
            const el = document.getElementById(m[1]); if (!el) return;
            el.value = systemSettings[field] || ''; el.disabled = !admin;
        });
    }
};

/* Oddiy tekshiruv: notif chiqarmasdan rol bo'yicha true/false */
function requireRoleSilent(...roles) {
    return Boolean(currentUser && roles.includes(currentUser.role));
}


// Filial ma'lumotlari serverdan (ommaviy endpoint) boshlang'ich yuklash
try { if (typeof Branches !== 'undefined') Branches.loadFromServer(); } catch (e) { }

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

/* ============================================================
   POS / KASSA — REAL-TIME STOCK + CART SYNC
   Professional rebuild:
   - Stock on-cart = product.stock - cart.qty
   - UI inline refresh (butun render emas)
   - Add / ChangeQty / Remove / ClearCart WRAPPER
   - Double-click guard
   - Single card inline stock color badges
   - renderProductGrid OVERRIDE (available stock + fa-plus icon)
   ============================================================ */
(function () {
    'use strict';

    /* ── 1. Source truth funksiyalar (generic, productId asosida) ── */

    /** Savatdagi maxsulot soni (productId bo'yicha). */
    function getCartQty(id) {
        const n = Number(id);
        const it = (typeof cart !== 'undefined' ? cart : window.cart || []).find(function (x) { return Number(x.id) === n; });
        return it ? Math.max(0, Number(it.qty) || 0) : 0;
    }

    /** UI uchun available stock: real stock - savatdagi miqdor (negative bo'lmasligi kerak). */
    function getAvailableStockForUI(id) {
        const n = Number(id);
        const p = (typeof products !== 'undefined' ? products : window.products || []).find(function (x) { return Number(x.id) === n; });
        if (!p) return 0;
        const realStock = Math.max(0, Number(p.stock) || 0);
        const inCart = getCartQty(n);
        return Math.max(0, realStock - inCart);
    }

    /* ── 2. Inline DOM refresh (bitta card / barcha cardlarni) ── */

    function stockClass(avail) {
        if (avail <= 0) return 'stock-zero';
        if (avail <= 5)  return 'stock-low';
        return 'stock-high';
    }

    /** Bitta mahsulot kartasini stock, button, badge, out class bilan yangilaydi. */
    function refreshProductCardUI(id) {
        const n = Number(id);
        const cards = document.querySelectorAll('#productGrid .product-card[data-pid="' + n + '"]');
        if (!cards.length) return;
        const avail = getAvailableStockForUI(n);
        const p = (typeof products !== 'undefined' ? products : window.products || []).find(function (x) { return Number(x.id) === n; });
        const inCartQty = getCartQty(n);
        cards.forEach(function (card) {
            // 1) Stock text yangilashi
            const stockEl = card.querySelector('.product-card-stock');
            if (stockEl) {
                const iconPrefix = avail <= 5 && avail > 0 ? '⚠️ ' : (avail === 0 ? '🚫 ' : '');
                stockEl.classList.remove('stock-high', 'stock-low', 'stock-zero');
                stockEl.classList.add(stockClass(avail));
                const qtyEl = stockEl.querySelector('.stock-qty');
                if (qtyEl) qtyEl.textContent = String(avail);
                else stockEl.innerHTML = iconPrefix + 'Qoldiq: <span class="stock-qty">' + avail + '</span>';
            }
            // 2) Qo'shish tugmasi — disabled + ikon
            const btn = card.querySelector('.product-add-btn');
            if (btn) {
                if (avail <= 0) {
                    btn.setAttribute('disabled', 'disabled');
                    btn.setAttribute('aria-disabled', 'true');
                    btn.title = 'Qoldiq tugagan';
                } else {
                    btn.removeAttribute('disabled');
                    btn.removeAttribute('aria-disabled');
                    btn.title = 'Savatga qo\'shish';
                }
                if (!btn.querySelector('i')) {
                    // Agar hozircha "+" text bo'lsa — FontAwesome ga almashtirish
                    btn.innerHTML = '<i class="fas fa-plus"></i>';
                }
            }
            // 3) Out class + label
            card.classList.toggle('out', avail <= 0);
            if (avail <= 0) {
                card.classList.remove('in');
            } else if (inCartQty > 0) card.classList.add('in');
            // 4) Savat badge (posAfterCartUpdate bilan sinxron)
            const badge = card.querySelector('.in-cart-badge');
            if (badge) {
                badge.textContent = inCartQty ? '×' + inCartQty : '';
            }
        });
    }

    /** Barcha mahsulot kartalarining stock textini yangilaydi. */
    function refreshAllProductCardsInGrid() {
        const ids = new Set();
        document.querySelectorAll('#productGrid .product-card[data-pid]').forEach(function (c) {
            ids.add(c.getAttribute('data-pid'));
        });
        ids.forEach(function (id) { refreshProductCardUI(id); });
    }

    // Global export qilib qo'shish uchun public
    window.__getAvailableStock = getAvailableStockForUI;
    window.__refreshProductCard = refreshProductCardUI;
    window.__refreshAllStockCards = refreshAllProductCardsInGrid;

    /* ── 3. Double-click / Concurrent guard ── */
    const __posGuard = { locked: Object.create(null) };
    function isLocked(id) { return !!__posGuard.locked[id]; }
    function lockBriefly(id, ms) {
        __posGuard.locked[id] = true;
        setTimeout(function () { __posGuard.locked[id] = false; }, ms || 150);
    }

    /* ── 4. WRAPPER: addToCart ── */
    const _origAddToCart = window.addToCart;
    window.addToCart = function (id, isScan) {
        const n = Number(id);
        if (isNaN(n)) return;
        if (isLocked(n)) return;
        const avail = getAvailableStockForUI(n);
        if (avail <= 0) {
            (typeof playError === 'function') && playError();
            (typeof showNotif === 'function') && showNotif('error', 'Xato!', 'Mahsulot qolmadi');
            return;
        }
        lockBriefly(n, 160);
        _origAddToCart.call(this, n, !!isScan);
        // UI feedback
        const card = document.querySelector('#productGrid .product-card[data-pid="' + n + '"] .product-add-btn');
        if (card) card.classList.add('anim-press');
        setTimeout(function () { card && card.classList.remove('anim-press'); }, 260);
        refreshProductCardUI(n);
        if (typeof refreshAllProductCardsInGrid === 'function') refreshAllProductCardsInGrid();
    };

    /* ── 5. WRAPPER: changeQty ── */
    let _origChangeQty = window.changeQty;
    window.changeQty = function (id, delta) {
        const n = Number(id);
        if (isNaN(n)) return;
        const d = Number(delta) || 0;
        if (d > 0) {
            const a = getAvailableStockForUI(n);
            if (a <= 0) {
                (typeof playError === 'function') && playError();
                (typeof showNotif === 'function') && showNotif('error', 'Yetarli emas!', 'Qoldiq tugadi');
                return;
            }
            if (isLocked(n)) return;
            lockBriefly(n, 140);
        }
        _origChangeQty.call(this, n, d);
        refreshProductCardUI(n);
        if (typeof refreshAllProductCardsInGrid === 'function') refreshAllProductCardsInGrid();
    };

    /* ── 6. WRAPPER: removeFromCart ── */
    let _origRemoveFromCart = window.removeFromCart;
    window.removeFromCart = function (id) {
        const n = Number(id);
        if (isNaN(n)) return;
        _origRemoveFromCart.call(this, n);
        if (!isNaN(n)) refreshProductCardUI(n);
        if (typeof refreshAllProductCardsInGrid === 'function') refreshAllProductCardsInGrid();
    };

    /* ── 7. WRAPPER: clearCart ── */
    let _origClearCart = window.clearCart;
    window.clearCart = function () {
        const cartArr = (typeof cart !== 'undefined') ? cart : (window.cart || []);
        const before = (cartArr || []).slice();
        _origClearCart.call(this);
        before.forEach(function (it) { refreshProductCardUI(it.id); });
        if (typeof refreshAllProductCardsInGrid === 'function') refreshAllProductCardsInGrid();
    };

    /* ── 8. WRAPPER: posAfterCartUpdate (badge + yangi stock inline) ── */
    const orig = window.posAfterCartUpdate;
    if (orig) {
        window.posAfterCartUpdate = function () {
            orig.call(this);
            try { refreshAllProductCardsInGrid(); } catch (_) { /* ignore */ }
        };
    }

    /* ── 9. WRAPPER: renderProductGrid (available stock + fa-plus + disabled) ── */
    const __origRender = window.renderProductGrid;
    if (__origRender) {
        window.renderProductGrid = function () {
            // Avval asl render'ni bajaradi
            __origRender.call(this);
            // Keyin:
            // a) har bir product-card da stock-class qo'shiladi (available-stock)
            // b) + btn content'i "<i class=fa-plus>" almashtirish
            // c) disabled state
            // d) stock text'ni QOLDAN AVAILABLE qilib o'zgartirish
            const cards = document.querySelectorAll('#productGrid .product-card[data-pid]');
            if (!cards.length) return;
            cards.forEach(function (card) {
                const id = card.getAttribute('data-pid');
                if (!id) return;
                const avail = getAvailableStockForUI(id);
                const inCartQty = getCartQty(id);
                const stockEl = card.querySelector('.product-card-stock');
                if (stockEl) {
                    // eski stock HTML ni to'liq available bilan almashtiramiz
                    const prefix = avail <= 5 && avail > 0 ? '⚠️ ' : (avail === 0 ? '🚫 ' : '');
                    stockEl.classList.remove('stock-high', 'stock-low', 'stock-zero');
                    stockEl.classList.add(stockClass(avail));
                    const strongExists = !!stockEl.querySelector('strong');
                    if (strongExists) {
                        stockEl.innerHTML = prefix + 'Qoldiq: <span class="stock-qty">' + avail + '</span>';
                    } else {
                        stockEl.innerHTML = prefix + 'Qoldiq: <span class="stock-qty">' + avail + '</span>';
                    }
                    stockEl.style.color = ''; // eski inline color ni o'chirib, CSS class dan foydalanamiz
                }
                const btn = card.querySelector('.product-add-btn');
                if (btn) {
                    // String "+" → FontAwesome ➕ almashtirish
                    if (!btn.querySelector('i')) {
                        btn.innerHTML = '<i class="fas fa-plus"></i>';
                    }
                    if (avail <= 0) {
                        btn.setAttribute('disabled', 'disabled');
                        btn.setAttribute('aria-disabled', 'true');
                        btn.title = 'Qoldiq tugagan';
                    } else {
                        btn.removeAttribute('disabled');
                        btn.removeAttribute('aria-disabled');
                        btn.title = 'Savatga qo\'shish';
                    }
                }
                card.classList.toggle('out', avail <= 0);
                if (avail > 0 && inCartQty > 0) card.classList.add('in');
                const badge = card.querySelector('.in-cart-badge');
                if (badge) badge.textContent = inCartQty ? '×' + inCartQty : '';
            });
        };
    }

    /* ── 10. POS checkout / sale → savatdagi mahsulot sotilganda → yangi renderProductGrid trigger bo'ladi (asl flow) ── */
    // Qo'shimcha: Checkout tugmasi bosilgandan so'ng to'liq grid'ni qayta render qilish
    const origPosCheckout = window.posCheckout || window.makeSale || null;
    if (origPosCheckout) {
        const targetKey = typeof window.posCheckout === 'function' ? 'posCheckout' : (typeof window.makeSale === 'function' ? 'makeSale' : null);
        if (targetKey) {
            window[targetKey] = function () {
                const cartArr = (typeof cart !== 'undefined') ? cart : (window.cart || []);
                const before = (cartArr || []).slice();
                const r = origPosCheckout.apply(this, arguments);
                setTimeout(function () {
                    before.forEach(function (it) { try { refreshProductCardUI(it.id); } catch (_) {} });
                    try { if (typeof renderProductGrid === 'function') renderProductGrid(); } catch (_) {}
                }, 120);
                return r;
            };
        }
    }

    /* ── 11. Boot — birinchi navbatda render bo'lgandan keyin ham refresh ── */
    const boot = function () {
        try {
            refreshAllProductCardsInGrid();
        } catch (_) { /* ignore */ }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        setTimeout(boot, 250);
    }
    window.addEventListener('load', function () { setTimeout(boot, 150); });

    // Har bir goTo page-pos ochilganda grid'ni yangilash
    let _origGoToPos = window.goTo;
    if (_origGoToPos) {
        window.goTo = function (pageId, el) {
            const r = _origGoToPos.call(this, pageId, el);
            if (pageId === 'page-pos') setTimeout(function () {
                try { if (typeof renderCatTabs === 'function') renderCatTabs(); } catch (_) {}
                try { if (typeof renderProductGrid === 'function') renderProductGrid(); } catch (_) {}
                try { if (typeof refreshAllProductCardsInGrid === 'function') refreshAllProductCardsInGrid(); } catch (_) {}
            }, 120);
            return r;
        };
    }

    // saveProduct → render → product yangilansa ham grid render bo'ladi (aslida renderProductGrid) — va stock inline refresh
    const __origSave = window.saveProduct;
    if (__origSave) {
        window.saveProduct = function () {
            const r = __origSave.apply(this, arguments);
            setTimeout(function () { try { refreshAllProductCardsInGrid(); } catch (_) {} }, 320);
            return r;
        };
    }
    const __origDel = window.deleteProduct;
    if (__origDel) {
        window.deleteProduct = function (id) {
            const r = __origDel.call(this, id);
            setTimeout(function () { try { refreshAllProductCardsInGrid(); } catch (_) {} }, 220);
            return r;
        };
    }

})();