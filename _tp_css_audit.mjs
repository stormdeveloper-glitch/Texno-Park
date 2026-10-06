// _tp_css_audit.mjs — VAQTINCHALIK audit skripti.
// style.css dagi layout bilan bog'liq qoidalarni kaskad tartibida chiqaradi.
// Ilovaga ta'siri yo'q (import qilinmaydi, faqat tahlil uchun).
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'style.css';
const raw = readFileSync(FILE, 'utf8');

// Kommentlarni bo'sh joy bilan almashtiramiz (satr raqamlari saqlanadi)
const css = raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

const rules = [];
function parse(text, start, end, media) {
  let i = start;
  while (i < end) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const selector = text.slice(i, open).replace(/\s+/g, ' ').trim();
    let depth = 1, j = open + 1;
    while (j < end && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const line = text.slice(0, open).split('\n').length;
    if (/^@(media|supports|layer|container)/.test(selector)) {
      parse(text, open + 1, j - 1, selector);
    } else if (selector && !selector.startsWith('@')) {
      rules.push({ sel: selector, body: text.slice(open + 1, j - 1), line, media });
    }
    i = j;
  }
}
parse(css, 0, css.length, '');

const KEYS = process.argv[2]
  ? process.argv[2].split(',')
  : ['.main', '.page', '.topbar', '.sidebar', '.content', '.container', '.stat-grid', '.card', '.panel', '.hotkeys'];

const PROPS = /(^|;)\s*(width|min-width|max-width|margin|margin-left|margin-right|margin-inline|padding|padding-left|padding-right|display|grid-template-columns|grid-auto-flow|gap|grid-gap|position|left|right|top|bottom|transform|translate|flex|flex-basis|flex-shrink|min-height|box-sizing|justify-content|align-items|overflow|overflow-x|float|inset|zoom)\s*:/;

const out = [];
for (const r of rules) {
  const s = r.sel;
  const matches = KEYS.some(k => s.includes(k));
  if (!matches) continue;
  const decls = r.body.split(';').map(d => d.trim()).filter(d => d && PROPS.test(';' + d));
  if (!decls.length) continue;
  out.push(`/* line ${r.line} */${r.media ? '\n  @' + r.media.replace(/^@/, '') : ''}\n${s} {\n    ${decls.join(';\n    ')};\n}`);
}
writeFileSync('_tp_css_audit.txt', out.join('\n\n'), 'utf8');
console.log('rules:', rules.length, '| matched:', out.length, '| -> _tp_css_audit.txt');
