/* _tp_layout_probe_inject.js — VAQTINCHALIK o'lchov skripti (harness sahifasiga qo'shiladi).
   Ilova kodiga ta'sir qilmaydi: faqat o'qish/o'lchash + holat almashtirish. */
(function () {
  'use strict';
  var P = new URLSearchParams(location.search);
  var PAGES = (P.get('pages') || 'page-dashboard').split(',');
  var THEMES = (P.get('themes') || 'light').split(',');
  var MODE = P.get('mode') || 'admin';

  function killMotion() {
    if (document.getElementById('tp-noanim')) return;
    var s = document.createElement('style');
    s.id = 'tp-noanim';
    s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    (document.head || document.documentElement).appendChild(s);
  }

  function setState(pageId, sidebarState, theme) {
    killMotion();
    document.documentElement.setAttribute('data-theme', theme);
    var app = document.getElementById('app');
    if (app) {
      app.style.display = 'block';
      if (MODE === 'market') app.classList.add('market-mode');
      else app.classList.remove('market-mode');
    }
    var lp = document.getElementById('loginPage');
    if (lp) { lp.style.display = 'none'; lp.classList.remove('active'); }
    document.body.classList.remove('modal-open');
    var sb = document.getElementById('sidebar');
    if (sb) {
      sb.classList.remove('collapsed', 'open');
      if (sidebarState === 'open') sb.classList.add('open');
      else if (sidebarState === 'collapsed') sb.classList.add('collapsed');
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
    return { l: +b.left.toFixed(1), t: +b.top.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1) };
  }
  function short(el) {
    if (!el) return '?';
    var cls = (typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    return (el.id ? '#' + el.id : el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
  }
  function visible(el) {
    var c = getComputedStyle(el);
    return c.display !== 'none' && c.visibility !== 'hidden' && c.opacity !== '0';
  }
  function intersect(a, b) {
    return !!(a && b) && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  }

  function measure(pageId, sidebarState, theme) {
    var page = setState(pageId, sidebarState, theme);
    var doc = document.documentElement;
    var main = document.querySelector('#app .main');
    var sb = document.getElementById('sidebar');
    var topbar = document.querySelector('#app .topbar');
    var hk = document.querySelector('#app .hotkeys-bar');
    var mr = R(main), pr = R(page), hr = R(hk);
    var mCS = main ? getComputedStyle(main) : null;
    var pCS = page ? getComputedStyle(page) : null;
    var rec = {
      vp: [innerWidth, innerHeight], theme: theme, mode: MODE, page: pageId, state: sidebarState,
      docClientW: doc.clientWidth, overflowX: doc.scrollWidth - doc.clientWidth,
      main: mr, pageRect: pr, sidebar: R(sb), topbar: R(topbar), hotkeys: hr,
      sidebarW: sb ? +sb.getBoundingClientRect().width.toFixed(1) : null,
      mainStyles: mCS ? { marginLeft: mCS.marginLeft, width: mCS.width, padding: mCS.padding, maxWidth: mCS.maxWidth, boxSizing: mCS.boxSizing } : null,
      pageStyles: pCS ? { margin: pCS.margin, padding: pCS.padding, maxWidth: pCS.maxWidth, width: pCS.width, boxSizing: pCS.boxSizing } : null
    };
    if (!page || !mr) { rec.error = 'main/page topilmadi'; return rec; }

    var minL = Infinity, maxR = -Infinity, lastRight = null, widest = null;
    var overflowers = [], hotkeyHits = [], els = page.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!visible(el)) continue;
      var c = getComputedStyle(el);
      if (c.position === 'fixed') continue;
      var b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (b.left < minL) minL = b.left;
      if (b.right > maxR) { maxR = b.right; lastRight = el; }
      if (!widest || b.width > widest.w) widest = { s: short(el), w: +b.width.toFixed(1) };
      if (b.right > mr.r + 1.5 && overflowers.length < 6) overflowers.push({ s: short(el), r: +b.right.toFixed(1) });
      if (hr && intersect({ l: b.left, t: b.top, r: b.right, b: b.bottom }, hr) && hotkeyHits.length < 6) hotkeyHits.push(short(el));
    }
    rec.pageLeftGap = +(pr.l - mr.l).toFixed(1);
    rec.pageRightGap = +(mr.r - pr.r).toFixed(1);
    rec.contentLeftGap = +(minL - mr.l).toFixed(1);
    rec.contentRightGap = +(mr.r - maxR).toFixed(1);
    rec.contentW = +(maxR - minL).toFixed(1);
    rec.lastRightWho = short(lastRight);
    rec.widest = widest;
    rec.overflowers = overflowers;
    rec.hotkeyHits = hotkeyHits;

    rec.children = [];
    for (var k = 0; k < page.children.length && k < 10; k++) {
      var ch = page.children[k];
      if (!visible(ch)) continue;
      var cr = R(ch);
      rec.children.push({ s: short(ch), l: cr.l, w: cr.w, r: cr.r });
    }

    rec.grids = [];
    var gs = page.querySelectorAll('.stat-grid,.stats-grid,.grid-2,.grid-3,.product-grid,.pos-layout,.table-wrap');
    for (var g = 0; g < gs.length && g < 12; g++) {
      var gr = gs[g], grr = R(gr), gc = getComputedStyle(gr);
      var kidsR = [], cols = 0, kids = gr.children;
      for (var q = 0; q < kids.length; q++) {
        var kr = R(kids[q]);
        if (kr && kr.w > 0) kidsR.push(kr);
      }
      if (gc.display === 'grid' && gc.gridTemplateColumns) cols = gc.gridTemplateColumns.split(' ').length;
      var maxKidR = kidsR.length ? Math.max.apply(null, kidsR.map(function (x) { return x.r; })) : null;
      rec.grids.push({
        sel: short(gr), l: grr.l, w: grr.w, r: grr.r, display: gc.display, cols: cols,
        kids: kidsR.length, kidW: kidsR.length ? +kidsR[0].w.toFixed(1) : 0,
        tailGap: maxKidR === null ? null : +(grr.r - maxKidR).toFixed(1),
        headGap: kidsR.length ? +(kidsR[0].l - grr.l).toFixed(1) : null
      });
    }
    return rec;
  }

  function run() {
    var out = [];
    for (var t = 0; t < THEMES.length; t++) {
      var theme = THEMES[t];
      var isMobile = window.matchMedia('(max-width: 768px)').matches;
      var states = isMobile ? ['mobile-closed'] : ['open', 'collapsed'];
      for (var s = 0; s < states.length; s++) {
        for (var p = 0; p < PAGES.length; p++) {
          try { out.push(measure(PAGES[p], states[s], theme)); }
          catch (e) { out.push({ page: PAGES[p], state: states[s], theme: theme, error: String((e && e.message) || e) }); }
        }
      }
    }
    var pre = document.getElementById('tp-layout');
    if (!pre) {
      pre = document.createElement('pre'); pre.id = 'tp-layout'; pre.style.display = 'none';
      (document.body || document.documentElement).appendChild(pre);
    }
    pre.textContent = JSON.stringify(out);
  }

  killMotion();
  run();
  window.addEventListener('load', function () { run(); setTimeout(run, 80); });
})();
