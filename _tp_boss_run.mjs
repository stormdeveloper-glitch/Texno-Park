// _tp_boss_run.mjs — BOSHLIQ sahifalari uchun VAQTINCHALIK o'lchov runner.
// Loyihaning mavjud CDP infratuzilmasiga (_tp_layout_run.mjs) asoslanadi.
// Ilova kodiga ta'sir qilmaydi.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CHROME = process.env.TP_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const BASE = process.env.TP_BASE || 'http://127.0.0.1:5099';
const PAGES = process.env.TP_PAGES || 'page-boss,page-bossStaff,page-bossProducts,page-bossBranches,page-bossFinance,page-bossReports,page-bossAudit';
const THEMES = process.env.TP_THEMES || 'light';
const SIDEBAR = process.env.TP_SIDEBAR || 'collapsed';
// Talabda ko'rsatilgan barcha ekran o'lchamlari
const VPS = (process.env.TP_VP || '1920x1080,1600x900,1440x900,1366x768,480x900,430x932,414x896,393x852,390x844,375x667,360x640')
  .split(',').map(s => s.split('x').map(Number));

async function buildHarness() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const tag = '<script src="_tp_boss_probe_inject.js"></script>';
  const out = html.includes('</body>') ? html.replace('</body>', tag + '\n</body>') : html + tag;
  await writeFile(join(ROOT, '_tp_boss_probe.html'), out, 'utf8');
}

function extractPre(dump, id) {
  const m = dump.match(new RegExp('<pre id="' + id + '"[^>]*>([\\s\\S]*?)<\\/pre>'));
  if (!m) return null;
  const txt = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  try { return JSON.parse(txt); } catch (e) { return null; }
}

function runChrome(url, w, h) {
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--virtual-time-budget=25000', `--window-size=${w},${h}`, '--dump-dom', url];
  const r = spawnSync(CHROME, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256, timeout: 240000 });
  if (r.error) throw r.error;
  return r.stdout || '';
}

const main = async () => {
  await mkdir(join(ROOT, '_tp_shots'), { recursive: true });
  await buildHarness();

  const results = [];
  let totalIssues = 0;

  for (const [w, h] of VPS) {
    // Iframe orqali aniq viewport o'lchamini olamiz
    const q = `w=${w}&h=${h}&pages=${encodeURIComponent(PAGES)}&themes=${THEMES}&sidebar=${SIDEBAR}`;
    const frameUrl = `${BASE}/_tp_boss_probe_frame.html?${q}`;
    let dump = '';
    try {
      dump = runChrome(frameUrl, 2200, 1400);
    } catch (e) {
      console.log(`[SKIP] ${w}x${h} — Chrome ishga tushmadi`);
      continue;
    }
    const data = extractPre(dump, 'tp-out');
    if (!data) {
      console.log(`[FAIL] ${w}x${h} — o'lchov natijasi topilmadi`);
      results.push({ vp: `${w}x${h}`, error: 'natija topilmadi' });
      totalIssues++;
      continue;
    }
    for (const r of data.results) {
      const bad = r.issues || [];
      totalIssues += bad.length;
      const errs = (data.errors || []).filter(e => e);
      console.log(`${bad.length === 0 && errs.length === 0 ? 'OK   ' : 'MUAMMO'} ${w}x${h} ${r.theme} ${r.page}` +
        ` (w=${r.docClientW}, el=${r.nodes}, muammo=${bad.length})` +
        (bad.length ? '\n        ' + JSON.stringify(bad.slice(0, 4)) : '') +
        (errs.length ? '\n        JS xato: ' + JSON.stringify(errs.slice(0, 3)) : ''));
    }
    if ((data.errors || []).length) totalIssues += data.errors.length;
    results.push({ vp: `${w}x${h}`, rows: data.results });
  }

  await writeFile(join(ROOT, '_tp_shots', 'boss-layout-report.json'),
    JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n=== JAMI MUAMMO: ${totalIssues} ===`);
};

main().catch(e => { console.error(e); process.exit(1); });