/* _tp_boss_nav_inject.js — BOSHLIQ menyu har bir elementi click'langanda
   to'g'ri sahifa + header title + active ni tekshiradi (VAQTINCHALIK probe). */
(function () {
  'use strict';
  var HASH = new URLSearchParams(location.hash.replace(/^#/, ''));
  var PW = HASH.get('pw') || '';
  var DIGITS = HASH.get('digits') || '901234554';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var EXPECTED = [
    { id: 'nav-settings',      page: 'page-settings',      title: 'Sozlamalar',        label: 'Sozlamalar' },
    { id: 'nav-boss',          page: 'page-boss',          title: 'Boshliq Dashboard',  label: 'Boshliq Dashboard' },
    { id: 'nav-bossStaff',     page: 'page-bossStaff',     title: 'Xodimlar',           label: 'Xodimlar' },
    { id: 'nav-bossStaffSales', page: 'page-bossStaffSales', title: 'Xodim savdosi',    label: 'Xodim savdosi' },
    { id: 'nav-bossProducts',  page: 'page-bossProducts',  title: 'Mahsulotlar',        label: 'Mahsulotlar' },
    { id: 'nav-bossBranches',  page: 'page-bossBranches',  title: 'Filiallar',          label: 'Filiallar' },
    { id: 'nav-bossFinance',   page: 'page-bossFinance',   title: 'Moliya',             label: 'Moliya' },
    { id: 'nav-bossReports',   page: 'page-bossReports',   title: 'Hisobotlar',         label: 'Hisobotlar' },
    { id: 'nav-bossAudit',     page: 'page-bossAudit',     title: 'Amallar jurnali',    label: 'Amallar jurnali' }
  ];

  async function run() {
    var out = { checks: [], results: [] };
    for (var i = 0; i < 120 && !(window.doLogin && document.getElementById('loginPhone')); i++) await sleep(100);
    await sleep(1200);
    var phone = document.getElementById('loginPhone');
    var pass = document.getElementById('loginPass');
    if (!phone || !pass) throw new Error('login elementlari topilmadi');
    phone.value = ''; pass.value = '';
    for (var c = 0; c < DIGITS.length; c++) { phone.value += DIGITS[c]; phone.dispatchEvent(new Event('input', { bubbles: true })); }
    pass.value = PW;
    try { await window.doLogin(); } catch (e) { out.error = String((e && e.message) || e); }
    var app = document.getElementById('app');
    for (var w = 0; w < 100 && app.style.display !== 'block'; w++) await sleep(200);
    await sleep(1500);

    // Har bir bo'limni bosamiz va natijani yozamiz
    for (var k = 0; k < EXPECTED.length; k++) {
      var spec = EXPECTED[k];
      var navEl = document.getElementById(spec.id);
      if (!navEl) { out.results.push({ id: spec.id, error: 'topilmadi' }); continue; }
      navEl.click();
      await sleep(550);
      var activePages = Array.prototype.map.call(document.querySelectorAll('.page.active'), function (p) { return p.id || ''; });
      var activeNav = document.querySelector('#sidebar .nav-item.active');
      var title = (document.getElementById('pageTitle') || {}).textContent || '';
      var row = {
        clicked: spec.label,
        navId: spec.id,
        page: activePages.join(','),
        expectedPage: spec.page,
        title: title,
        expectedTitle: spec.title,
        activeNav: activeNav ? activeNav.id : null
      };
      out.results.push(row);
      var okPage = row.page.indexOf(spec.page) >= 0 && row.page.split(',').length === 1;
      var okTitle = title === spec.title;
      var okActive = row.activeNav === spec.id;
      out.checks.push(((okPage && okTitle && okActive) ? 'PASS ' : 'FAIL ') +
        spec.label + ' → page=' + row.page + ' title="' + title + '" active=' + row.activeNav);
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
  if (document.readyState === 'complete') run().catch(fail);
  else window.addEventListener('load', function () { run().catch(fail); });
})();