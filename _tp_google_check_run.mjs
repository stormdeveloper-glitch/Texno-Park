// _tp_google_check_run.mjs — VAQTINCHALIK tekshiruv runner (Google login olib tashlanganini
// brauzerda tasdiqlash + login oqimi va panel o'lchamlarini o'lchash).
// Ilova kodiga ta'sir qilmaydi.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CHROME = process.env.TP_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();

const fileUrl = (name, hash) =>
  'file:///' + join(ROOT, name).replace(/\\/g, '/').replace(/ /g, '%20') + (hash ? '#' + hash : '');

function extractPre(dump) {
  const m = dump.match(/<pre id="tp-gcheck"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  const txt = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return JSON.parse(txt);
}

function runChrome(url, w, h) {
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--virtual-time-budget=9000',
    `--window-size=${w},${h}`, '--dump-dom', url];
  const r = spawnSync(CHROME, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128, timeout: 120000 });
  if (r.error) throw r.error;
  return r.stdout || '';
}

const VPS = (process.env.TP_VPS || '1366x900,1366x768,1366x680,1920x1080,360x640,375x667,390x844,393x852,414x896,430x932,480x800')
  .split(',').map(s => s.split('x').map(Number));

const all = [];
for (const [w, h] of VPS) {
  const winW = Math.max(w + 40, 480);
  const winH = Math.max(h + 60, 720);
  const dump = runChrome(fileUrl('_tp_google_check.html', `vp=${w}x${h}`), winW, winH);
  const data = extractPre(dump);
  if (!data || data.fatal) {
    console.log(`VP ${w}x${h} | XATO: ${data ? data.fatal : 'natija topilmadi'}`);
    all.push({ vp: `${w}x${h}`, error: true, fatal: data && data.fatal });
    continue;
  }
  const fails = (data.checks || []).filter(c => c.startsWith('FAIL'));
  const i = data.info || {};
  console.log(`VP ${w}x${h} | inner=${JSON.stringify(i.vp)} | boxH=${i.boxH} | top=${i.boxTop} | bottomGap=${i.bottomGap} | hOv=${i.hOverflow} | checks=${(data.checks || []).length} fails=${fails.length}`);
  fails.forEach(f => console.log('   >> ' + f));
  all.push(data);
}
console.log('\nJAMI: ' + all.length + ' viewport tekshirildi');
