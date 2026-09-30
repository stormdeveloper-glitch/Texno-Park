/* Texno Park №1 — POS PLUS v2
   • Kunlik savdo va Oylik savdo  -> "Shartnomalar" bo'limi ICHIDA (alohida tablar)
   • Xodimlar KPI                 -> "Xodimlar" bo'limi ICHIDA
   • Yangi menyu bandi / yangi sahifa QO'SHILMAYDI, alohida shartnoma tizimi YO'Q
   Ulash: index.html da scripts.js dan KEYIN (bir marta):  <script src="pos-plus.js"></script> */
(function () {
  'use strict';
  if (window.__ppLoaded) return;          // ikki marta ulansa ham bir marta ishlaydi
  window.__ppLoaded = true;

  /* ================= YORDAMCHILAR ================= */
  const $ = (s, r) => (r || document).querySelector(s);
  const p2 = n => String(n).padStart(2, '0');
  const money = n => Math.round(+n || 0).toLocaleString('ru-RU') + " so'm";
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dkey = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const mkey = d => d.getFullYear() + '-' + p2(d.getMonth() + 1);
  const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
  const sum = (a, f) => a.reduce((t, x) => t + (+f(x) || 0), 0);
  const group = (a, f) => { const m = {}; a.forEach(x => { const k = f(x); (m[k] = m[k] || []).push(x); }); return m; };
  const OR = '#ff6b35';
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };
  const charts = {};
  function chart(id, cfg) {
    const c = document.getElementById(id);
    if (!c || !window.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(c, cfg);
  }

  /* ================= MA'LUMOT MANBALARI (scripts.js dagi haqiqiy massivlar) ================= */
  const G = {
    sales() { try { return Array.isArray(salesHistory) ? salesHistory : []; } catch (e) { return []; } },
    emps() { try { return Array.isArray(employees) ? employees : []; } catch (e) { return []; } },
    cts() { try { return Array.isArray(contracts) ? contracts : []; } catch (e) { return []; } }
  };
  const BAD_STATUS = ['pending', 'cancelled', 'canceled', 'failed', 'refunded', 'rejected'];

  /** Sana turli formatda bo'lishi mumkin: 30.09.2026 / 30/09/2026 / 2026-09-30 */
  function parseSaleDate(s) {
    const raw = s.date || s.createdAt || s.created_at || s.timestamp || '';
    if (typeof raw === 'number') { const t = new Date(raw); return isNaN(t) ? null : t; }
    const str = String(raw).trim();
    let y, m, d, mm;
    if ((mm = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
    else if ((mm = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; }
    else { const t = new Date(str); return isNaN(t) ? null : t; }
    const tm = String(s.time || '').match(/(\d{1,2}):(\d{2})/) || str.match(/[T ](\d{1,2}):(\d{2})/);
    return new Date(y, m - 1, d, tm ? +tm[1] : 0, tm ? +tm[2] : 0);
  }
  function sales() {
    return G.sales()
      .filter(s => s && !BAD_STATUS.includes(String(s.status || '').toLowerCase()))
      .map(s => {
        const d = parseSaleDate(s);
        if (!d) return null;
        return {
          d, total: +s.total || 0, emp: s.cashier || '—', pay: String(s.pay || s.provider || '—'),
          profit: profitOf(s), cust: s.customer || '—', online: /online/i.test(String(s.cashier || '')), id: s.id
        };
      }).filter(Boolean);
  }
  /** Sotuv foydasi = jami − olingan narx. Olingan narx noma'lum (eski mahsulot) bo'lsa 20% marja olinadi. */
  function profitOf(s) {
    let cost = 0;
    (s.items || []).forEach(it => {
      let c = it.cost;
      if (c == null) { let pr; try { pr = products.find(x => x.id === it.id); } catch (e) { } c = pr && pr.cost != null ? pr.cost : it.price * 0.8; }
      cost += (+c || 0) * (+it.qty || 0);
    });
    return (+s.total || 0) - cost;
  }
  /** Xodimlar oyligi (Maosh bo'limidagi yozuvlardan) */
  const salaries = () => store.get('tp_salary_records', []).filter(r => r && +r.salary);
  const salaryOf = n => sum(salaries().filter(r => String(r.name || '').trim().toLowerCase() === String(n).trim().toLowerCase()), r => r.salary);
  const liveContracts = () => G.cts().filter(c => c && c.status !== 'cancelled');

  /* ================= CSS ================= */
  const st = document.createElement('style');
  st.textContent = `
  .pp-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin:0 0 16px}
  .pp-head h3{font-size:17px;font-weight:800}.pp-head p{color:var(--muted,#888);font-size:13px;margin-top:3px}
  .pp-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .pp-tools .form-control{height:40px;width:auto}
  .pp-seg{display:inline-flex;flex-wrap:wrap;background:var(--bg,#f3f4f6);border-radius:12px;padding:4px;gap:4px;margin-bottom:18px}
  .pp-seg button{border:0;background:transparent;padding:9px 18px;border-radius:9px;cursor:pointer;color:var(--muted,#888);font:inherit;font-weight:700}
  .pp-seg button.on{background:${OR};color:#fff}
  .pp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
  .pp-card{background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:16px;padding:16px 18px}
  .pp-card small{display:block;color:var(--muted,#888);font-size:12px;margin-bottom:6px}
  .pp-card b{font-size:21px;font-weight:800;display:block;line-height:1.2}
  .pp-card i.d{font-style:normal;font-size:12px;font-weight:700;margin-top:6px;display:inline-block;color:var(--muted,#888)}
  .pp-up{color:#10b981!important}.pp-down{color:#ef4444!important}
  .pp-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  @media(max-width:900px){.pp-grid{grid-template-columns:1fr}}
  .pp-box{background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:16px;overflow:hidden;margin-bottom:18px}
  .pp-box h4{font-size:15px;font-weight:700;padding:14px 18px;border-bottom:1px solid var(--border,#e5e7eb)}
  .pp-box .in{padding:16px 18px}.pp-box canvas{max-height:260px}
  .pp-box table{width:100%;border-collapse:collapse}
  .pp-box th,.pp-box td{padding:11px 16px;text-align:left;font-size:13px;border-bottom:1px solid var(--border,#e5e7eb)}
  .pp-box th{color:var(--muted,#888);font-weight:600;font-size:12px}
  .pp-scroll{overflow-x:auto}
  .pp-bar{height:8px;background:var(--border,#e5e7eb);border-radius:99px;overflow:hidden;min-width:90px}
  .pp-bar i{display:block;height:100%;border-radius:99px;background:${OR}}.pp-bar i.ok{background:#10b981}
  .pp-pill{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700}
  .pp-on{background:rgba(59,130,246,.15);color:#3b82f6}.pp-off{background:rgba(255,107,53,.15);color:${OR}}
  .pp-ok{background:rgba(16,185,129,.15);color:#10b981}.pp-warn{background:rgba(245,158,11,.18);color:#d97706}.pp-bad{background:rgba(239,68,68,.15);color:#ef4444}
  .pp-empty{padding:28px;text-align:center;color:var(--muted,#888);font-size:13px}
  .pp-note{font-size:12px;color:var(--muted,#888);margin-top:8px;padding:0 4px}
  .pp-rank{width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;background:var(--bg,#f3f4f6)}
  .pp-rank.r1{background:#fbbf24;color:#fff}.pp-rank.r2{background:#9ca3af;color:#fff}.pp-rank.r3{background:#d97706;color:#fff}`;
  document.head.appendChild(st);

  const PP = window.PP = { tab: 'list' };

  /* ================= "SHARTNOMALAR" BO'LIMI ICHIGA TABLAR ================= */
  function initContractsTabs() {
    const page = $('#page-contracts');
    if (!page || $('#ppTabs')) return;
    // mavjud shartnomalar kontentini bitta o'ramga solamiz (o'zgarishsiz qoladi)
    const listWrap = document.createElement('div');
    listWrap.id = 'ct-tab-list';
    while (page.firstChild) listWrap.appendChild(page.firstChild);

    const tabs = document.createElement('div');
    tabs.id = 'ppTabs'; tabs.className = 'pp-seg';
    tabs.innerHTML = `<button type="button" data-t="list" class="on">📄 Shartnomalar</button>
      <button type="button" data-t="daily">📅 Kunlik savdo</button>
      <button type="button" data-t="monthly">🗓 Oylik savdo</button>`;

    const daily = document.createElement('div');
    daily.id = 'ct-tab-daily'; daily.style.display = 'none';
    daily.innerHTML = `<div class="pp-head"><div><h3>📅 Kunlik savdo</h3><p>Tanlangan kun bo'yicha savdo, to'lov turlari, xodimlar va shartnomalar</p></div>
      <div class="pp-tools"><button type="button" class="btn btn-outline btn-sm" id="pp-d-prev">‹</button>
      <input type="date" class="form-control" id="pp-d-date"><button type="button" class="btn btn-outline btn-sm" id="pp-d-next">›</button>
      <button type="button" class="btn btn-outline btn-sm" id="pp-d-today">Bugun</button></div></div><div id="pp-daily-body"></div>`;

    const monthly = document.createElement('div');
    monthly.id = 'ct-tab-monthly'; monthly.style.display = 'none';
    monthly.innerHTML = `<div class="pp-head"><div><h3>🗓 Oylik savdo</h3><p>Yil bo'yicha oylar taqqoslanadi (savdo va shartnomalar)</p></div>
      <div class="pp-tools"><select class="form-control" id="pp-m-year"></select>
      <button type="button" class="btn btn-outline btn-sm" id="pp-m-csv">CSV</button></div></div><div id="pp-monthly-body"></div>`;

    page.append(tabs, listWrap, daily, monthly);

    tabs.addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) showTab(b.dataset.t); });
    $('#pp-d-date').onchange = () => PP.daily();
    $('#pp-d-today').onclick = () => { $('#pp-d-date').value = dkey(new Date()); PP.daily(); };
    const shift = n => { const d = new Date($('#pp-d-date').value + 'T00:00:00'); d.setDate(d.getDate() + n); $('#pp-d-date').value = dkey(d); PP.daily(); };
    $('#pp-d-prev').onclick = () => shift(-1);
    $('#pp-d-next').onclick = () => shift(1);
    $('#pp-m-csv').onclick = () => csv('oylik-savdo.csv', [['Oy', 'Cheklar', 'Savdo', 'Foyda', "O'rtacha chek", 'Shartnomalar', 'Shartnoma summasi']]
      .concat(monthRows.map(r => [r.n, r.cnt, Math.round(r.rev), Math.round(r.pr), Math.round(r.avg), r.cc, Math.round(r.cs)])));
  }
  function showTab(name) {
    PP.tab = name;
    ['list', 'daily', 'monthly'].forEach(k => { const el = $('#ct-tab-' + k); if (el) el.style.display = k === name ? '' : 'none'; });
    document.querySelectorAll('#ppTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === name));
    if (name === 'daily') PP.daily();
    if (name === 'monthly') PP.monthly();
  }

  /* ================= KUNLIK SAVDO ================= */
  PP.daily = function () {
    const inp = $('#pp-d-date'); if (!inp) return;
    if (!inp.value) inp.value = dkey(new Date());
    const all = sales(), day = new Date(inp.value + 'T00:00:00');
    const yd = new Date(day); yd.setDate(yd.getDate() - 1);
    const cur = all.filter(s => dkey(s.d) === inp.value), prev = all.filter(s => dkey(s.d) === dkey(yd));
    const rev = sum(cur, s => s.total), prevRev = sum(prev, s => s.total);
    const diff = prevRev ? Math.round((rev - prevRev) / prevRev * 100) : null;
    const online = cur.filter(s => s.online), off = cur.filter(s => !s.online);
    const cts = liveContracts().filter(c => c.startDate === inp.value);
    const rows = o => Object.entries(o).map(([k, v]) => [k, v.length, sum(v, s => s.total)]).sort((a, b) => b[2] - a[2]);
    const tbl = (o, lab) => { const r = rows(o); return r.length ? `<div class="pp-scroll"><table><thead><tr><th>${lab}</th><th>Cheklar</th><th>Summa</th></tr></thead><tbody>${r.map(x => `<tr><td>${esc(x[0])}</td><td>${x[1]}</td><td><b>${money(x[2])}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="pp-empty">Ma\'lumot yo\'q</div>'; };
    $('#pp-daily-body').innerHTML = `
      <div class="pp-cards">
        <div class="pp-card"><small>Kunlik savdo</small><b>${money(rev)}</b>${diff === null ? '' : `<i class="d ${diff >= 0 ? 'pp-up' : 'pp-down'}">${diff >= 0 ? '▲' : '▼'} ${Math.abs(diff)}% kechagiga nisbatan</i>`}</div>
        <div class="pp-card"><small>Cheklar soni</small><b>${cur.length}</b></div>
        <div class="pp-card"><small>O'rtacha chek</small><b>${money(cur.length ? rev / cur.length : 0)}</b></div>
        <div class="pp-card"><small>🏬 Offline</small><b>${money(sum(off, s => s.total))}</b><i class="d">${off.length} ta chek</i></div>
        <div class="pp-card"><small>🛒 Online</small><b>${money(sum(online, s => s.total))}</b><i class="d">${online.length} ta chek</i></div>
        <div class="pp-card"><small>📄 Shu kuni tuzilgan shartnomalar</small><b>${cts.length} ta</b><i class="d">${money(sum(cts, c => c.amount))}</i></div>
      </div>
      <div class="pp-box"><h4>Soatlar bo'yicha savdo</h4><div class="in"><canvas id="pp-hour"></canvas></div></div>
      <div class="pp-grid">
        <div class="pp-box"><h4>To'lov turlari</h4>${tbl(group(cur, s => s.pay), "To'lov turi")}</div>
        <div class="pp-box"><h4>Xodimlar</h4>${tbl(group(cur, s => s.emp), 'Xodim')}</div>
      </div>
      <div class="pp-box"><h4>Kunlik cheklar</h4>${cur.length ? `<div class="pp-scroll"><table><thead><tr><th>Vaqt</th><th>Chek</th><th>Mijoz</th><th>Xodim</th><th>Kanal</th><th>To'lov</th><th>Summa</th></tr></thead><tbody>${cur.slice().sort((a, b) => b.d - a.d).slice(0, 100).map(s => `<tr><td>${p2(s.d.getHours())}:${p2(s.d.getMinutes())}</td><td>#${esc(s.id)}</td><td>${esc(s.cust)}</td><td>${esc(s.emp)}</td><td><span class="pp-pill ${s.online ? 'pp-on' : 'pp-off'}">${s.online ? 'Online' : 'Offline'}</span></td><td>${esc(s.pay)}</td><td><b>${money(s.total)}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="pp-empty">Bu kunda savdo bo\'lmagan</div>'}</div>`;
    const h = Array(24).fill(0); cur.forEach(s => h[s.d.getHours()] += s.total);
    chart('pp-hour', { type: 'bar', data: { labels: h.map((_, i) => p2(i) + ':00'), datasets: [{ data: h, backgroundColor: OR, borderRadius: 6 }] }, options: { plugins: { legend: { display: false } }, maintainAspectRatio: false } });
  };

  /* ================= OYLIK SAVDO ================= */
  let monthRows = [];
  PP.monthly = function () {
    const sel = $('#pp-m-year'); if (!sel) return;
    const all = sales(), cAll = liveContracts();
    const years = [...new Set(all.map(s => s.d.getFullYear()).concat(new Date().getFullYear()))].sort((a, b) => b - a);
    if (!sel.options.length) { sel.innerHTML = years.map(y => `<option>${y}</option>`).join(''); sel.onchange = PP.monthly; }
    const y = +sel.value, data = all.filter(s => s.d.getFullYear() === y);
    monthRows = MONTHS.map((n, i) => {
      const m = data.filter(s => s.d.getMonth() === i), rev = sum(m, s => s.total);
      const cs = cAll.filter(c => String(c.startDate).slice(0, 7) === y + '-' + p2(i + 1));
      const days = group(m, s => dkey(s.d)); let best = ['—', 0];
      Object.entries(days).forEach(([k, v]) => { const t = sum(v, s => s.total); if (t > best[1]) best = [k, t]; });
      return { n, pr: sum(m, s => s.profit), cnt: m.length, rev, avg: m.length ? rev / m.length : 0, best, cc: cs.length, cs: sum(cs, c => c.amount) };
    });
    const total = sum(monthRows, r => r.rev), top = monthRows.reduce((a, b) => b.rev > a.rev ? b : a, monthRows[0]);
    const nowKey = mkey(new Date()), thisM = monthRows[+nowKey.slice(5) - 1];
    $('#pp-monthly-body').innerHTML = `
      <div class="pp-cards">
        <div class="pp-card"><small>${y}-yil jami savdo</small><b>${money(total)}</b></div>
        <div class="pp-card"><small>Cheklar soni</small><b>${sum(monthRows, r => r.cnt)}</b></div>
        <div class="pp-card"><small>Eng yaxshi oy</small><b>${top.rev ? top.n : '—'}</b><i class="d">${money(top.rev)}</i></div>
        <div class="pp-card"><small>💰 ${y}-yil foyda</small><b class="pp-up">${money(sum(monthRows, r => r.pr))}</b><i class="d">Marja: ${total ? Math.round(sum(monthRows, r => r.pr) / total * 100) : 0}%</i></div>
        <div class="pp-card"><small>👥 Xodimlar oyligi (oyiga)</small><b>${money(sum(salaries(), r => r.salary))}</b><i class="d">${salaries().length} ta xodim</i></div>
        <div class="pp-card"><small>O'rtacha oylik</small><b>${money(total / 12)}</b></div>
        <div class="pp-card"><small>📄 ${y}-yil shartnomalari</small><b>${sum(monthRows, r => r.cc)} ta</b><i class="d">${money(sum(monthRows, r => r.cs))}</i></div>
        ${y === new Date().getFullYear() ? `<div class="pp-card"><small>Shu oy (${thisM.n})</small><b>${money(thisM.rev)}</b><i class="d">${thisM.cnt} ta chek · ${thisM.cc} ta shartnoma</i></div>` : ''}
      </div>
      <div class="pp-box"><h4>Oylar bo'yicha savdo</h4><div class="in"><canvas id="pp-mchart"></canvas></div></div>
      <div class="pp-box"><h4>Oylik hisobot</h4><div class="pp-scroll"><table><thead><tr><th>Oy</th><th>Cheklar</th><th>Savdo</th><th>Foyda</th><th>Sof foyda (maoshsiz)</th><th>O'rtacha chek</th><th>Shartnomalar</th><th>O'sish</th><th>Eng yaxshi kun</th></tr></thead><tbody>
      ${monthRows.map((r, i) => { const pv = i ? monthRows[i - 1].rev : 0; const g = pv ? Math.round((r.rev - pv) / pv * 100) : null; return `<tr><td><b>${r.n}</b></td><td>${r.cnt}</td><td><b>${money(r.rev)}</b></td><td class="pp-up"><b>${money(r.pr)}</b></td><td class="${r.pr - sum(salaries(), x => x.salary) >= 0 ? 'pp-up' : 'pp-down'}">${r.cnt ? money(r.pr - sum(salaries(), x => x.salary)) : '—'}</td><td>${money(r.avg)}</td><td>${r.cc} ta · ${money(r.cs)}</td><td>${g === null ? '—' : `<span class="${g >= 0 ? 'pp-up' : 'pp-down'}">${g >= 0 ? '▲' : '▼'} ${Math.abs(g)}%</span>`}</td><td>${r.best[1] ? r.best[0] + ' · ' + money(r.best[1]) : '—'}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
    chart('pp-mchart', { type: 'bar', data: { labels: MONTHS, datasets: [{ data: monthRows.map(r => r.rev), backgroundColor: OR, borderRadius: 6 }] }, options: { plugins: { legend: { display: false } }, maintainAspectRatio: false } });
  };

  /* ================= "XODIMLAR" BO'LIMI ICHIDA KPI ================= */
  function initKPI() {
    const page = $('#page-employees');
    if (!page || $('#ppKpiBox')) return;
    const box = document.createElement('div');
    box.id = 'ppKpiBox'; box.className = 'panel'; box.style.marginTop = '18px';
    box.innerHTML = `<div class="panel-header" style="flex-wrap:wrap;gap:10px">
        <h3><i class="fas fa-bullseye" style="color:var(--primary)"></i> Xodimlar KPI</h3>
        <div class="pp-tools"><input type="month" class="form-control" id="pp-k-month"><button type="button" class="btn btn-outline btn-sm" id="pp-k-csv">CSV</button></div>
      </div><div class="panel-body" id="pp-kpi-body"></div>`;
    const first = page.querySelector('.panel');
    if (first) first.after(box); else page.appendChild(box);
    $('#pp-k-month').value = mkey(new Date());
    $('#pp-k-month').onchange = () => PP.kpi();
    $('#pp-k-csv').onclick = () => csv('xodim-kpi.csv', [['Xodim', 'Cheklar', 'Savdo', "O'rtacha chek", 'Shartnomalar', 'Reja', 'Bajarilish %', 'KPI', 'Bonus']]
      .concat(kpiRows.map(r => [r.name, r.cnt, Math.round(r.rev), Math.round(r.avg), r.cc, r.plan, Math.round(r.pc), r.score, Math.round(r.bonus)])));
  }
  const DEFAULT_PLAN = 50000000;
  let kpiRows = [];
  PP.kpi = function () {
    const mi = $('#pp-k-month'); if (!mi) return;
    if (!mi.value) mi.value = mkey(new Date());
    const data = sales().filter(s => mkey(s.d) === mi.value && !s.online);
    const plans = store.get('pp_plans', {});
    const by = group(data, s => s.emp);
    G.emps().forEach(e => { if (e && e.name && !by[e.name]) by[e.name] = []; });
    const ctBy = group(liveContracts().filter(c => String(c.startDate).slice(0, 7) === mi.value), c => c.createdBy || '—');
    const teamAvg = data.length ? sum(data, s => s.total) / data.length : 0;
    kpiRows = Object.entries(by).map(([name, v]) => {
      const rev = sum(v, s => s.total), plan = +plans[name] || DEFAULT_PLAN, avg = v.length ? rev / v.length : 0;
      const pc = plan ? rev / plan * 100 : 0;
      const score = Math.round(Math.min(100, pc) * 0.7 + Math.min(100, teamAvg ? avg / teamAvg * 100 : 0) * 0.3);
      return { name, cnt: v.length, rev, avg, plan, pc, score, cc: (ctBy[name] || []).length, bonus: pc >= 100 ? rev * 0.01 : 0 };
    }).filter(r => r.name !== '—').sort((a, b) => b.score - a.score || b.rev - a.rev);
    $('#pp-kpi-body').innerHTML = `
      <div class="pp-cards">
        <div class="pp-card"><small>Jami savdo (kassa)</small><b>${money(sum(kpiRows, r => r.rev))}</b></div>
        <div class="pp-card"><small>Xodimlar</small><b>${kpiRows.length}</b></div>
        <div class="pp-card"><small>Rejani bajarganlar</small><b>${kpiRows.filter(r => r.pc >= 100).length}</b></div>
        <div class="pp-card"><small>Eng yaxshi xodim</small><b style="font-size:18px">${kpiRows[0] && kpiRows[0].rev ? esc(kpiRows[0].name) : '—'}</b></div>
      </div>
      ${kpiRows.length ? `<div class="pp-scroll"><table class="pp-kpi-table" style="width:100%"><thead><tr><th>#</th><th>Xodim</th><th>Oylik maosh</th><th>Cheklar</th><th>Savdo</th><th>O'rtacha chek</th><th>Shartnomalar</th><th>Oylik reja</th><th>Bajarilishi</th><th>KPI ball</th><th>Bonus (1%)</th></tr></thead><tbody>
      ${kpiRows.map((r, i) => `<tr><td><span class="pp-rank ${i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td><td><b>${esc(r.name)}</b></td><td>${salaryOf(r.name) ? money(salaryOf(r.name)) : '—'}</td><td>${r.cnt}</td><td>${money(r.rev)}</td><td>${money(r.avg)}</td><td>${r.cc}</td>
      <td><input type="number" class="form-control pp-plan" data-n="${esc(r.name)}" value="${r.plan}" style="height:34px;width:130px"></td>
      <td><div class="pp-bar"><i class="${r.pc >= 100 ? 'ok' : ''}" style="width:${Math.min(100, r.pc)}%"></i></div><small>${Math.round(r.pc)}%</small></td>
      <td><span class="pp-pill ${r.score >= 80 ? 'pp-ok' : r.score >= 50 ? 'pp-warn' : 'pp-bad'}">${r.score}</span></td><td>${r.bonus ? money(r.bonus) : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="pp-empty">Bu oyda ma\'lumot yo\'q</div>'}
      <div class="pp-note">KPI ball = reja bajarilishi (70%) + o'rtacha chekning jamoa o'rtachasiga nisbati (30%). Online do'kon buyurtmalari xodim KPI'siga kirmaydi. Bonus — reja 100% bajarilsa savdoning 1%. Rejani jadvalda o'zgartiring — avtomatik saqlanadi.</div>`;
    document.querySelectorAll('.pp-plan').forEach(i => i.onchange = () => {
      const p = store.get('pp_plans', {}); p[i.dataset.n] = +i.value || 0; store.set('pp_plans', p); PP.kpi();
    });
  };

  /* ================= ESKI "Shartnoma (yangi)" DAN BITTA TIZIMGA KO'CHIRISH ================= */
  const OLD_TYPE = {
    installment: "Muddatli to'lov shartnomasi", warranty: 'Kafolat shartnomasi', remote: 'Online buyurtma shartnomasi',
    delivery: 'Yetkazib berish shartnomasi', retail: 'Savdo shartnomasi', preorder: 'Savdo shartnomasi'
  };
  function migrateOldContracts() {
    try {
      if (typeof currentUser === 'undefined' || currentUser?.role !== 'admin') return;
      if (typeof normalizeContract !== 'function' || typeof saveContracts !== 'function') return;
      const old = store.get('pp_contracts', []);
      if (!Array.isArray(old) || !old.length) return;
      const have = new Set(G.cts().map(c => c.number));
      let n = 0;
      old.forEach(o => {
        const no = o.no || ('SH-' + String(o.id));
        if (have.has(no)) return;
        const start = /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : dkey(new Date());
        const months = o.type === 'installment' ? (+o.months || 0) : 0;
        const c = normalizeContract({
          id: +o.id || Date.now() + n, number: no, type: OLD_TYPE[o.type] || 'Savdo shartnomasi',
          customer: o.name, phone: o.phone, subject: o.item, amount: o.amount, baseAmount: o.amount,
          prepay: +o.prepay || 0, months, warrantyMonths: +o.warranty || 12, startDate: start,
          createdBy: (typeof currentUser !== 'undefined' && currentUser?.name) || 'Admin',
          note: [o.note, 'Eski bo\'limdan ko\'chirildi'].filter(Boolean).join(' | ')
        });
        if (c && c.customer) { c.status = contractStatusFor(c.endDate); contracts.push(c); have.add(no); n++; }
      });
      if (n) saveContracts();
      localStorage.setItem('pp_contracts_migrated', JSON.stringify(old));
      localStorage.removeItem('pp_contracts');
      if (n && typeof showNotif === 'function') showNotif('info', "Shartnomalar birlashtirildi", `${n} ta eski shartnoma asosiy ro'yxatga ko'chirildi`);
    } catch (e) { console.warn('pp migrate:', e); }
  }

  /* ================= ULASH: goTo va Contracts.render ================= */
  function refresh() {
    const cp = $('#page-contracts'), ep = $('#page-employees');
    if (cp && cp.classList.contains('active')) { if (PP.tab === 'daily') PP.daily(); else if (PP.tab === 'monthly') PP.monthly(); }
    if (ep && ep.classList.contains('active')) PP.kpi();
  }
  PP.refresh = refresh;

  if (typeof window.goTo === 'function') {
    const _goTo = window.goTo;
    window.goTo = function (pageId) {
      const r = _goTo.apply(this, arguments);
      if (pageId === 'page-contracts') { migrateOldContracts(); if (typeof Contracts !== 'undefined') Contracts.render(); refresh(); }
      if (pageId === 'page-employees') PP.kpi();
      return r;
    };
  }
  try {
    if (typeof Contracts !== 'undefined' && Contracts.render && !Contracts.__pp) {
      const _render = Contracts.render;
      Contracts.render = function () { const r = _render.apply(this, arguments); refresh(); return r; };
      Contracts.__pp = true;
    }
  } catch (e) { }

  /* ================= CSV ================= */
  function csv(name, rows) {
    const t = '\ufeff' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = name; a.click();
  }

  /* ================= DASHBOARD: HAQIQIY FOYDA ================= */
  function dashProfit() {
    const all = sales(), nk = mkey(new Date());
    const tp = sum(all, s => s.profit), tr = sum(all, s => s.total);
    const mo = all.filter(s => mkey(s.d) === nk), mp = sum(mo, s => s.profit), mr = sum(mo, s => s.total);
    const el = document.getElementById('d-profit'); if (!el) return;
    el.textContent = money(tp);
    const ch = document.getElementById('d-profit-change');
    if (ch) ch.innerHTML = `<i class="fas fa-calendar"></i> Bu oy: ${money(mp)}` + (mr ? ` · marja ${Math.round(mp / mr * 100)}%` : '');
  }
  try {
    if (typeof window.loadAdminDashboard === 'function') {
      const _lad = window.loadAdminDashboard;
      window.loadAdminDashboard = function () { const r = _lad.apply(this, arguments); dashProfit(); return r; };
    }
    if (typeof window.saveToStorage === 'function') {   // sotuv bo'lishi bilan dashboard darhol yangilansin
      const _sts = window.saveToStorage;
      window.saveToStorage = function () {
        const r = _sts.apply(this, arguments);
        const dp = $('#page-dashboard');
        if (dp && dp.classList.contains('active') && $('#admin-dashboard') && $('#admin-dashboard').style.display !== 'none') window.loadAdminDashboard();
        return r;
      };
    }
  } catch (e) { }

  initContractsTabs();
  initKPI();
})();