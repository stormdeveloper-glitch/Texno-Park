// _tp_layout_probe.mjs — VAQTINCHALIK o'lchov runner (harness + --dump-dom).
// Chrome CDP siyosat bilan bloklangani uchun harness sahifa ishlatiladi.
// Ilova kodiga ta'sir qilmaydi.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.TP_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const OUT = join(ROOT, '_tp_shots');
const HARNESS = '_tp_layout_probe.html';
const PAGES = process.env.TP_PAGES || 'page-dashboard,page-pos,page-products,page-customers,page-employees,page-contracts,page-branches,page-cashflow,page-reports,page-sms,page-logs,page-categories,page-warehouse,page-discounts,page-assistant,page-settings';
const THEMES = process.env.TP_THEMES || 'light';
const VPS = (process.env.TP_VP || '1920x1080,1600x900,1440x900,1366x768,1024x768,900x700,768x1024,480x800,430x932,414x896,390x844,375x667,360x640')
  .split(',').map(s => s.split('x').map(Number));

const fileUrl = (name, query) => 'file:///' + join(ROOT, name).replace(/\\/g, '/').replace(/ /g, '%20') + (query ? '?' + query : '');
const FRAME_WINDOW = process.env.TP_FRAME_WINDOW || '2100x1300';

async function buildHarness() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const tag = '<script src="_tp_layout_probe_inject.js"></script>';
  const out = html.includes('</body>') ? html.replace('</body>', tag + '\n</body>') : html + tag;
  await writeFile(join(ROOT, HARNESS), out, 'utf8');
}

function extractPre(dump, id) {
  const m = dump.match(new RegExp('<pre id="' + id + '"[^>]*>([\\s\\S]*?)<\\/pre>'));
  if (!m) return null;
  const txt = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return JSON.parse(txt);
}

// Har bir viewport uchun: ota-oyna (frame) ichida aniq W x H iframe.
function measureViewport(w, h, query) {
  const q = `w=${w}&h=${h}&q=${encodeURIComponent(query)}`;
  const url = fileUrl('_tp_layout_frame.html', q);
  const [fw, fh] = FRAME_WINDOW.split('x').map(Number);
  return extractPre(runChrome(url, fw, fh), 'tp-out');
}

function runChrome(url, w, h) {
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--virtual-time-budget=6000',
    `--window-size=${w},${h}`, '--dump-dom', url];
  const r = spawnSync(CHROME, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256, timeout: 180000 });
  if (r.error) throw r.error;
  return r.stdout || '';
}

async function shoot(name, url, w, h) {
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--virtual-time-budget=2500',
    `--window-size=${w},${h}`, `--screenshot=${join(OUT, name)}`, url], { encoding: 'utf8', timeout: 120000 });
  return !!r.status;
}

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await buildHarness();
  const query = `pages=${PAGES}&themes=${THEMES}&mode=admin`;
  if (process.env.TP_MODE === 'calib') {
    for (const [w, h] of [[1920, 1080], [1440, 900], [1024, 768], [480, 800], [360, 640]]) {
      const d = measureViewport(w, h, 'pages=page-dashboard&themes=light');
      console.log('so\'rov=' + w + 'x' + h + ' -> viewport=' + JSON.stringify(d && d[0] && d[0].vp) +
        ' docClientW=' + (d && d[0] && d[0].docClientW));
    }
    return;
  }
  const rows = [];
  for (const [w, h] of VPS) {
    const data = measureViewport(w, h, query);
    if (!data) { rows.push({ vp: `${w}x${h}`, error: 'o\'lchov topilmadi' }); console.log('FAIL ' + w + 'x' + h); continue; }
    for (const r of data) rows.push({ vpRequested: `${w}x${h}`, ...r });
    console.log('OK ' + w + 'x' + h + ' | recs=' + data.length + ' | ichki vp=' + JSON.stringify(data[0] && data[0].vp) +
      ' | main=' + (data[0] && data[0].main && data[0].main.w) + ' | sidebarW=' + (data[0] && data[0].sidebarW));
  }
  await writeFile(join(OUT, 'layout-report.json'), JSON.stringify(rows, null, 1));
  console.log('jami:', rows.length, '-> _tp_shots/layout-report.json');
};

main().catch(e => { console.error('XATO: ' + ((e && e.message) || e)); process.exit(1); });
