/* _tp_boss_probe_inject.js — BOSHLIQ sahifalari uchun VAQTINCHALIK o'lchov skripti.
   Ilova kodiga ta'sir qilmaydi: faqat test holatini o'rnatadi va o'lchaydi.

   Muhim: `/api/boss/*` so'rovlari HAQIQIY serverga yuboriladi (fetch o'chirilmaydi),
   shuning uchun ko'rsatkichlar bazadagi haqiqiy ma'lumotdan kelib chiqadi. */
(function () {
  'use strict';
  var P = new URLSearchParams(location.search);
  var PAGES = (P.get('pages') || 'page-boss').split(',');
  var THEMES = (P.get('themes') || 'light').split(',');
  var SIDEBAR = P.get('sidebar') || 'collapsed';

  function killMotion() {
    if (document.getElementById('tp-noanim')) return;
    var s = document.createElement('style');
    s.id = 'tp-noanim';
    s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    (document.head || document.documentElement).appendChild(s);
  }

  function setState(pageId, theme) {
    killMotion();
    document.documentElement.setAttribute('data-theme', theme);
    var app = document.getElementById('app');
    if (app) { app.style.display = 'block'; app.classList.remove('market-mode'); }
    var lp = document.getElementById('loginPage');
    if (lp) { lp.style.display = 'none'; lp.classList.remove('active'); }
    document.body.classList.remove('modal-open');
    var sb = document.getElementById('sidebar');
    if (sb) {
      sb.classList.remove('collapsed', 'open');
      if (SIDEBAR === 'open') sb.classList.add('open');
      else sb.classList.add('collapsed');
    }
    var all = document.querySelectorAll('#app .page');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
    var page = document.getElementById(pageId);
    if (page) page.classList.add('active');
    return page;
  }

  function R(el) {
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return { l: +b.left.toFixed(1), t: +b.top.toFixed(1), w: +b.width.toFixed(1),
             h: +b.height.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1) };
  }

  /** GORIZONTAL SILJITISH tekshiruvi — talabga muvofiq bo'lishi shart. */
  function overflowCheck(pageId, theme) {
    var page = setState(pageId, theme);
    var doc = document.documentElement;
    var issues = [];
    var pageW = page ? page.getBoundingClientRect().width : 0;
    // 1) Sahiha o'zidan kengroq bo'lmasin
    if (page && page.scrollWidth > page.clientWidth + 2) {
      issues.push({ type: 'page-overflow', detail: 'page scrollW=' + page.scrollWidth + ' clientW=' + page.clientWidth });
    }
    // 2) Ichki elementlardan hech biri ko'rinmaydigan oynadan chiqmasin
    var sel = '.boss-kpi, .boss-panel, .boss-card, .boss-receipt, .boss-sales-kpis > div, '
            + '.boss-toolbar, .boss-table, .boss-audit-row, .boss-chip, .boss-rank-row';
    var nodes = page ? page.querySelectorAll(sel) : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = R(el);
      if (!r || r.w === 0) continue;
      if (r.l < -2 || r.r > pageW + 2) {
        issues.push({
          type: 'element-overflow',
          el: (el.id ? '#' + el.id : el.className.toString().split(' ')[0]),
          l: r.l, r: +r.r.toFixed(1), pageW: +pageW.toFixed(1)
        });
      }
    }
    // 3) Kesilgan matn (kartalar ichida) — scrollWidth > clientWidth bo'lsa
    var cards = page ? page.querySelectorAll('.boss-kpi, .boss-card') : [];
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      if (c.scrollWidth > c.clientWidth + 2) {
        issues.push({ type: 'clipped-card', el: c.className.toString().slice(0, 40) });
      }
    }
    return {
      page: pageId, theme: theme, docClientW: doc.clientWidth,
      pageW: +pageW.toFixed(1),
      nodes: nodes.length,
      issues: issues
    };
  }

  // ── HAQIQIY AUTENTIFIKATSIYA ──────────────────────────────────
  // Probe Boshliq sifatida kiradi va haqiqiy token oladi — shunda
  // `/api/boss/*` so'rovlari serverga boradi va ko'rsatkichlar bazadagi
  // haqiqiy ma'lumotdan kelib chiqadi.
  function login() {
    return fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: P.get('phone') || '+998901234554',
        password: P.get('pw') || ''
      })
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        // scripts.js dagi `let staffToken` global leksik muhitda yashaydi —
        // boshqa skriptdan unga shu yo'l bilan murojaat qilamiz.
        try { staffToken = data.token; } catch (e) { window.staffToken = data.token; }
        try {
          currentUser = { id: 0, login: data.user.login, name: data.user.name,
                          role: data.user.role, color: '#ff6a1f' };
        } catch (e) { /* currentUser topilmasa davom etamiz */ }
        try { serverOnline = true; } catch (e) { }
        return true;
      });
  }

  async function run() {
    var out = [];
    try {
      await login();
    } catch (e) {
      window.__tpErrors.push('login failed: ' + e);
    }
    // Sahifalarni birma-bir ko'rsatib, real ma'lumotni yuklashga vaqt beramiz.
    for (var t = 0; t < THEMES.length; t++) {
      for (var p = 0; p < PAGES.length; p++) {
        setState(PAGES[p], THEMES[t]);
        // Boss moduli sahifani chizishi uchun chaqiramiz
        try {
          if (typeof Boss !== 'undefined') {
            var key = PAGES[p].replace(/^page-/, '');
            await Boss.onPageOpen(key);
          }
        } catch (e) { /* o'lchovga to'sqinlik qilmasin */ }
        // Asinxron so'rovlar tugashini kutamiz
        for (var w = 0; w < 25; w++) {
          await new Promise(function (r) { setTimeout(r, 120); });
          var box = document.querySelector('#' + PAGES[p] + ' .boss-loading');
          if (!box) break;
        }
        await new Promise(function (r) { setTimeout(r, 250); });
        out.push(overflowCheck(PAGES[p], THEMES[t]));
      }
    }
    // Konsol xatolarini ham yig'amiz
    var pre = document.createElement('pre');
    pre.id = 'tp-out';
    pre.textContent = JSON.stringify({ results: out, errors: window.__tpErrors || [] });
    document.body.appendChild(pre);
    document.title = 'TP-DONE';
  }

  window.__tpErrors = [];
  window.addEventListener('error', function (e) {
    window.__tpErrors.push(String(e.message || e));
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__tpErrors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason));
  });

  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();