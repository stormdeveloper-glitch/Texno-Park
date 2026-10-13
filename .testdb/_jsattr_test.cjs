// jsStrAttr() ni haqiqiy scripts.js dan olib, in'ektsiya holatlarini sinaymiz.
const fs = require('fs');
const src = fs.readFileSync('scripts.js', 'utf8').split(/\r?\n/);
// escapeHTML + jsStrAttr ta'riflari (qatorlar 73..100 atrofida)
const start = src.findIndex(l => l.startsWith('function escapeHTML'));
const end = src.findIndex((l, i) => i > start && l.startsWith('function safeJsonParse'));
const helpers = src.slice(start, end).join('\n');
eval(helpers);

const BS = String.fromCharCode(92);
const cases = [
    "X');window.__XSS=1;//",
    "a" + BS + "');alert(1)//",
    'Kir yuvish mashinasi (7 kg)',
    'Samsung 55" TV',
    '<img src=x onerror=alert(1)>',
    'a\nb',
    "O'Brien & Sons",
    null,
    undefined,
    42,
];

let bad = 0;
for (const c of cases) {
    const enc = jsStrAttr(c);
    // Brauzer HTML atributini AVVAL dekodlaydi, keyin JS bajaradi
    const decoded = enc.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    let out = null, err = null;
    try { out = eval("(function(){ return '" + decoded + "'; })()"); } catch (e) { err = e.name; }
    // Kutilgan natija: null/undefined → '' ; yangi qator → bo'shliq (ataylab);
    // qolgan barcha belgilar AYNAN saqlanadi (matn o'zgarmaydi).
    const expected = c === null || c === undefined ? '' : String(c).replace(/[\r\n]/g, ' ');
    const ok = err === null && out === expected;
    if (!ok) bad++;
    console.log((ok ? 'OK  ' : 'XATO') + '  kirish=' + JSON.stringify(c) +
        '\n      enc=' + JSON.stringify(enc) + '\n      JS satr=' + JSON.stringify(out) + ' err=' + err);
}
console.log('\nXulosa: ' + (cases.length - bad) + '/' + cases.length + ' holat xavfsiz va qiymat saqlangan');
if (bad) process.exitCode = 1;
