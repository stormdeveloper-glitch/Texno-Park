/* _tp_menu_test_inject.js — VAQTINCHALIK menu/sidebar funktsional test (harness sahifasiga qo'shiladi).
   Ilova kodiga ta'sir qilmaydi: faqat haqiqiy tugmani bosib holatni o'lchaydi. */
(function () {
  'use strict';

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function state() {
    var sb = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    var btn = document.getElementById('sidebarToggleBtn');
    var main = document.querySelector('#app .main');
    var icon = btn ? btn.querySelector('i') : null;
    return {
      vp: window.innerWidth + 'x' + window.innerHeight,
      mobile: window.innerWidth <= 768,
      sbClass: sb ? sb.classList.toString() : null,
      sbW: sb ? Math.round(sb.getBoundingClientRect().width) : null,
      mainML: main ? Math.round(parseFloat(getComputedStyle(main).marginLeft)) : null,
      icon: icon ? icon.className : null,
      ariaExpanded: btn ? btn.getAttribute('aria-expanded') : null,
      ariaLabel: btn ? btn.getAttribute('aria-label') : null,
      overlayVisible: overlay ? overlay.classList.contains('visible') : false,
      bodyLocked: document.body.classList.contains('sidebar-locked')
    };
  }

  function snap(tag) { var s = state(); s.tag = tag; return s; }

  function setupAdmin() {
    var app = document.getElementById('app');
    var lp = document.getElementById('loginPage');
    if (app) { app.style.display = 'block'; app.classList.remove('market-mode'); }
    if (lp) { lp.classList.remove('active'); lp.style.display = 'none'; }
    if (!document.getElementById('tp-noanim')) {
      var s = document.createElement('style');
      s.id = 'tp-noanim';
      s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  }

  async function run() {
    await delay(400);
    setupAdmin();
    await delay(60);

    var out = [];
    var btn = document.getElementById('sidebarToggleBtn');
    var sb = document.getElementById('sidebar');
    if (!btn || !sb || typeof window.toggleSidebar !== 'function') {
      out.push({ error: 'topilmadi: btn=' + !!btn + ' sb=' + !!sb + ' fn=' + typeof window.toggleSidebar });
    } else {
      var mobile = window.innerWidth <= 768;
      if (mobile) {
        out.push(snap('m0-init'));
        btn.click(); await delay(100);   out.push(snap('m1-click-open'));
        btn.click(); await delay(100);   out.push(snap('m2-click-close'));
        btn.click(); await delay(100);   out.push(snap('m3-open-again'));
        var ov = document.getElementById('sidebarOverlay');
        if (ov) { ov.click(); await delay(100); }
        out.push(snap('m4-overlay-close'));
        btn.click(); await delay(100);
        pressEscape(); await delay(100);
        out.push(snap('m5-esc-close'));
      } else {
        out.push(snap('d0-init'));
        btn.click(); await delay(100);   out.push(snap('d1-click-open'));
        btn.click(); await delay(100);   out.push(snap('d2-click-close'));
        btn.click(); await delay(100);   out.push(snap('d3-open-again'));
        pressEscape(); await delay(100); out.push(snap('d4-esc-close'));
        var emp = document.getElementById('nav-employees');
        if (emp && typeof window.toggleEmployeesDropdown === 'function') {
          window.toggleEmployeesDropdown(emp); await delay(100);
          out.push(snap('d5-employees-opens-sidebar'));
        }
      }
    }

    var pre = document.getElementById('tp-out');
    if (!pre) { pre = document.createElement('pre'); pre.id = 'tp-out'; document.body.appendChild(pre); }
    pre.textContent = JSON.stringify(out, null, 1);
  }

  var boot = function () { setTimeout(run, 0); };
  var started = false;
  var bootOnce = function () { if (started) return; started = true; boot(); };
  if (document.readyState === 'complete' || document.readyState === 'interactive') bootOnce();
  else document.addEventListener('DOMContentLoaded', bootOnce, { once: true });
  window.addEventListener('load', bootOnce, { once: true });
})();