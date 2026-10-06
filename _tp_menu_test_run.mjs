// _tp_menu_test_run.mjs — VAQTINCHALIK menu/sidebar funktsional test runner.
// Hozirgi index.html dan harness qurib, haqiqiy ☰ tugmani bosib holatlarni o'lchaydi.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.TP_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const HARNESS = '_tp_menu_test.html';
const TAG = '<script src="_tp_menu_test_inject.js"></script>';
const VPS = (process.env.TP_VP || '1920x1080,1366x768,1440x900,1600x900,390x844,360x800,480x900,768x800')
  .split(',').map(s => s.split('x').map(Number));

const fileUrl = 'file:///' + join(ROOT, HARNESS).replace(/\\/g, '/').replace(/ /g, '%20');

function runChrome(w, h) {
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--virtual-time-budget=15000',
    `--window-size=${w},${h}`, '--dump-dom', fileUrl];
  const r = spawnSync(CHROME, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128, timeout: 120000 });
  if (r.error) throw r.error;
  return r.stdout || '';
}

function extract(dump) {
  const m = dump.match(/<pre id="tp-out"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

async function main() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const outHtml = html.includes('</body>')
    ? html.replace('</body>', TAG + '\n</body>')
    : html + TAG;
  await writeFile(join(ROOT, HARNESS), outHtml, 'utf8');
  console.log('harness yozildi: ' + HARNESS);

  for (const [w, h] of VPS) {
    try {
      const dump = runChrome(w, h);
      const txt = extract(dump);
      if (!txt) {
        writeFileSync(join(ROOT, '_tp_menu_dump_' + w + 'x' + h + '.html'), dump, 'utf8');
        console.log('\n===== ' + w + 'x' + h + ' — NATIJA TOPILMADI (dump saqlandi, so%nggi 500 belgi) =====');
        console.log(dump.slice(-500));
        continue;
      }
      console.log('\n===== ' + w + 'x' + h + ' =====');
      console.log(txt);
    } catch (e) {
      console.log('\n===== ' + w + 'x' + h + ' — XATO: ' + ((e && e.message) || e) + ' =====');
    }
  }
}

main().catch(e => { console.error('XATO: ' + ((e && e.message) || e)); process.exit(1); });