// _tp_layout_summary.mjs — hisobotni tahlil qilish (vaqtinchalik).
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync('_tp_shots/layout-report.json', 'utf8'));
const only = process.argv[2] || '';
const stateFilter = process.argv[3] || '';
const vpFilter = process.argv[4] || '';

const sel = rows.filter(r => r.main && (!only || r.page === only) && (!stateFilter || r.state === stateFilter) && (!vpFilter || r.vpRequested === vpFilter));

// 1) Sahifa bo'yicha "o'lik bo'shliq" (pageRightGap = .page o'ng chekkasidan .main o'ng chekkasigacha)
const byPage = new Map();
for (const r of sel) {
  if (r.theme !== 'light') continue;
  const k = r.page;
  if (!byPage.has(k)) byPage.set(k, []);
  byPage.get(k).push(r);
}
console.log('=== SAHIFA / viewport bo\'yicha o\'lik bo\'shliq (light) ===');
console.log(['page', 'vp', 'state', 'mainW', 'pageW', 'pageGapR', 'contentGapR', 'ovf', 'widest', 'lastRight'].join('\t'));
for (const [page, list] of byPage) {
  for (const r of list) {
    if (r.pageRightGap !== undefined && r.pageRightGap < 2) continue; // faqat muammoli qatorlar
    console.log([page.replace('page-', ''), r.vpRequested, r.state, r.main.w, r.pageRect && r.pageRect.w, r.pageRightGap, r.contentRightGap, r.overflowX, r.widest && r.widest.s, r.lastRightWho].join('\t'));
  }
}

// 2) Umumiy xulosa: har viewport uchun pageRightGap taqsimoti
console.log('\n=== VIEWPORT bo\'yicha pageRightGap (light, open) ===');
const byVp = new Map();
for (const r of sel) {
  if (r.theme !== 'light' || r.state === 'collapsed') continue;
  const k = r.vpRequested + '/' + r.state;
  if (!byVp.has(k)) byVp.set(k, []);
  byVp.get(k).push(r);
}
for (const [k, list] of byVp) {
  const gaps = list.map(r => r.pageRightGap).filter(v => typeof v === 'number');
  console.log(k.padEnd(24), 'main=' + list[0].main.w, ' pageGapR min/max=' + Math.min(...gaps) + '/' + Math.max(...gaps),
    ' contGapR max=' + Math.max(...list.map(r => r.contentRightGap || 0)));
}

// 3) Overflow / hotkey to'qnashuvi / kontent .main chekkasidan chiqishi
console.log('\n=== MUAMMOLAR ===');
const probs = sel.filter(r => r.overflowX > 1 || (r.overflowers && r.overflowers.length) || (r.hotkeyHits && r.hotkeyHits.length));
for (const r of probs.slice(0, 60)) {
  console.log([r.page.replace('page-', ''), r.vpRequested, r.state, 'ovf=' + r.overflowX,
    'overflowers=' + JSON.stringify(r.overflowers), 'hotkey=' + JSON.stringify(r.hotkeyHits)].join(' '));
}
console.log('muammoli qatorlar:', probs.length, '/', sel.length);