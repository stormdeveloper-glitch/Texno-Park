/* _tp_boss_sidebar_inject.js — BOSHLIQ/rollar sidebar tekshiruvi (VAQTINCHALIK probe).
   Ushbu skript index.html ichiga qo'shiladi va REAL doLogin() orqali kiradi:
   telefon+parol → doLogin() → initApp → setupRoleBasedNav → loadDashboard.
   Natija <pre id="tp-out"> ga yoziladi (--dump-dom bilan o'qiladi).
   Loyihaning xizmat kodiga ta'sir qilmaydi. Parol URL hash'da beriladi. */
(function () {
  'use strict';
  var HASH = new URLSearchParams(location.hash.replace(/^#/, ''));
  var PW = HASH.get('pw') || '';
  var DIGITS = HASH.get('digits') || '901234554';
  var ROLE = HASH.get('role') || 'boss';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function run() {
    var out = { role: ROLE, checks: [], sidebar: [], active: {}, header: {}, activePage: [], roleShown: '' };
    function add(ok, msg) { out.checks.push((ok ? 'PASS ' : 'FAIL ') + msg); }

    // Ilova bootstrap tugashini kutamiz
    for (var i = 0; i < 120 && !(window.doLogin && document.getElementById('loginPhone')); i++) await sleep(100);
    await sleep(1200);

    var phone = document.getElementById('loginPhone');
    var pass = document.getElementById('loginPass');
    if (!phone || !pass) throw new Error('login elementlari topilmadi');
    phone.value = ''; pass.value = '';
    for (var c = 0; c < DIGITS.length; c++) {
      phone.value += DIGITS[c];
      phone.dispatchEvent(new Event('input', { bubbles: true }));
    }
    pass.value = PW;

    try { await window.doLogin(); } catch (e) { out.error = String((e && e.message) || e); }

    var app = document.getElementById('app');
    for (var w = 0; w < 100 && app.style.display !== 'block'; w++) await sleep(200);
    await sleep(1800);
    out.appOpen = app.style.display === 'block';
    out.loginError = out.error || null;
    out.diag = {
      innerWidth: window.innerWidth,
      appClass: app.className,
      bodyRole: document.body.getAttribute('data-role'),
      navTotal: document.querySelectorAll('#sidebar .nav-item').length
    };

    var visible = [];
    document.querySelectorAll('#sidebar .nav-item').forEach(function (el) {
      var span = el.querySelector(':scope > span:not(.nav-badge)') || el.querySelector('span');
      var label = (span ? span.textContent : '').trim();
      var disp = el.style.display;
      var cs = window.getComputedStyle(el);
      if (disp !== 'none' && cs.display !== 'none' && cs.visibility !== 'hidden') visible.push(label);
    });
    out.sidebar = visible;

    var activeNav = document.querySelector('#sidebar .nav-item.active');
    out.active = {
      id: activeNav ? activeNav.id : null,
      label: activeNav ? ((activeNav.querySelector('span') || {}).textContent || '').trim() : ''
    };
    out.header = {
      title: (document.getElementById('pageTitle') || {}).textContent || '',
      subtitle: (document.getElementById('pageSubtitle') || {}).textContent || ''
    };
    out.roleShown = (document.getElementById('sideRole') || {}).textContent || '';
    out.activePage = Array.prototype.map.call(document.querySelectorAll('.page.active'), function (p) { return p.id || ''; });

    var BOSS_EXPECTED = ['Sozlamalar', 'Boshliq Dashboard', 'Xodimlar', 'Xodim savdosi', 'Mahsulotlar',
      'Filiallar', 'Moliya', 'Hisobotlar', 'Amallar jurnali'];
    var BOSS_FORBIDDEN = ['Dashboard', 'Kassa (POS)', 'Kategoriyalar', 'Ombor', 'Mijozlar',
      'Kirim / Chiqim', 'Shartnomalar', 'AI Yordamchi', 'Chegirmalar', 'SMS Tizimi', 'Loglar'];

    if (ROLE === 'boss') {
      add(JSON.stringify(visible) === JSON.stringify(BOSS_EXPECTED),
        'sidebar AYNAN talab qilingan 9 bo\'lim: ' + JSON.stringify(visible));
      var forbidden = visible.filter(function (l) { return BOSS_FORBIDDEN.indexOf(l) >= 0; });
      add(forbidden.length === 0, 'ortiqcha bo\'limlar yo\'q (chiqqani: ' + JSON.stringify(forbidden) + ')');
      add(out.active.id === 'nav-boss', 'faol menyu: #' + out.active.id);
      add(out.header.title === 'Boshliq Dashboard', 'header sarlavha: ' + out.header.title);
      add(out.activePage.indexOf('page-boss') >= 0, 'ochiq sahifa: ' + out.activePage.join(','));
    } else {
      var leaked = visible.filter(function (l) {
        return ['Boshliq Dashboard', 'Amallar jurnali', 'Xodim savdosi', 'Boshliq'].indexOf(l) >= 0;
      });
      add(leaked.length === 0, ROLE.toUpperCase() + ': BOSHLIQ bo\'limlari qolib ketmadi (' + JSON.stringify(leaked) + ')');
      add(out.roleShown.length > 0, ROLE.toUpperCase() + ' roli aniqlandi: ' + out.roleShown);
    }

    var pre = document.createElement('pre');
    pre.id = 'tp-out';
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
    document.title = 'TP-DONE';
  }

  function fail(e) {
    var pre = document.createElement('pre');
    pre.id = 'tp-out';
    pre.textContent = JSON.stringify({ error: String((e && e.message) || e) });
    document.body.appendChild(pre);
    document.title = 'TP-DONE';
  }

  window.addEventListener('error', function (e) { /* konsol xatolari — doLogin ichida bo'lsa ham davom */ });
  if (document.readyState === 'complete') run().catch(fail);
  else window.addEventListener('load', function () { run().catch(fail); });
})();