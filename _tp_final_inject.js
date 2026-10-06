// TEXNO PARK N1 — REAL BROWSER AUTH CHECK (injected probe)
// index.html nusxasi ichiga yuklanadi (iframesiz, to'g'ridan-to'g'ri).
(function () {
  'use strict';
  var results = [];
  var debug = [];
  var started = false;
  function startOnce() {
    if (started) return;
    started = true;
    setTimeout(run, 1200);
  }
  function add(ok, msg) { results.push((ok ? 'PASS' : 'FAIL') + '  ' + msg); }
  // Fetch kuzatuvi (konsolga parol/secret chiqarilmaydi — faqat URL+status)
  try {
    var _origFetch = window.fetch;
    window.fetch = function () {
      var args = Array.prototype.slice.call(arguments);
      var u = String(args[0] || '');
      debug.push('fetch-> ' + u.slice(0, 90));
      return _origFetch.apply(this, args).then(function (res) {
        debug.push('fetch=' + res.status + ' ' + u.slice(0, 90));
        return res;
      }, function (e) {
        debug.push('fetchX ' + u.slice(0, 90) + ' ' + ((e && e.message) || e));
        throw e;
      });
    };
  } catch (e) { debug.push('fetch-wrap-error'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function q(s) { return document.querySelector(s); }

  function reset() {
    try { doLogout(true); } catch (e) { /* */ }
    return sleep(400).then(function () {
      try { localStorage.removeItem('tp_login_guard'); } catch (e) { /* */ }
      try { showLoginScreen(); } catch (e) { /* */ }
      return sleep(400);
    });
  }

  function seedStaleLock(digits) {
    var key = '+998' + String(digits).replace(/\D/g, '');
    var store = {};
    store[key] = { attempts: 0, lockUntil: Date.now() + 10 * 60000, firstTry: Date.now() - 1000 };
    try { localStorage.setItem('tp_login_guard', JSON.stringify(store)); } catch (e) { /* */ }
    return (localStorage.getItem('tp_login_guard') || '').indexOf(key) !== -1;
  }

  function fill(digits, pw) {
    var phone = q('#loginPhone'), pass = q('#loginPass');
    if (!phone || !pass) { add(false, 'login maydonlari topilmadi'); return false; }
    phone.value = '';
    for (var i = 0; i < String(digits).length; i++) {
      phone.value += String(digits)[i];
      phone.dispatchEvent(new Event('input', { bubbles: true }));
    }
    pass.value = pw;
    return true;
  }

  function appVisible() {
    var appEl = q('#app');
    return !!appEl && appEl.style.display === 'block';
  }

  function loginVisible() {
    var lp = q('#loginPage');
    return !!lp && lp.style.display !== 'none' && !appVisible();
  }

  function roleText() { return (q('#sideRole') || {}).textContent || ''; }
  function toasts() {
    return Array.prototype.slice.call(document.querySelectorAll('.notif')).map(function (el) { return el.textContent || ''; });
  }

  function waitApp(ms) {
    ms = ms || 8000;
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function loop() {
        if (appVisible()) return resolve(true);
        if (Date.now() - t0 >= ms) return resolve(false);
        setTimeout(loop, 150);
      })();
    });
  }

  function loginRaw(digits, pw) {
    var err = null;
    fill(digits, pw);
    return Promise.resolve()
      .then(function () {
        try { return doLogin(); } catch (e) { err = ((e && e.message) || String(e)); return null; }
      })
      .then(function () { return waitApp(8000); })
      .then(function (ok) { return { ok: ok, err: err, role: ok ? roleText() : '', toasts: toasts() }; });
  }
  function main() {
    return reset()
      .then(function () {
        // === 1) Enter tugmada -> POS/barkod toast YO'Q ===
        var btn = q('#loginPage .btn-login');
        if (btn) btn.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true, cancelable: true }));
        return sleep(900);
      })
      .then(function () {
        var bad = toasts().filter(function (t) {
          return t.indexOf('Topilmadi') !== -1 || t.indexOf('Barkod') !== -1 ||
            t.indexOf('mahsulot yo') !== -1 || t.indexOf('savat') !== -1;
        });
        add(!bad.length, location.protocol + ' [1] Enter(tugma): POS/barkod toast YO\'Q' + (bad.length ? ' => ' + bad[0] : ''));
        add(loginVisible(), location.protocol + ' [1b] Enter(bo\'sh forma) login qilmadi (login kontekst xatosi)');
        return sleep(300);
      })
      .then(function () {
        // === 2) Phone INPUT ichida Enter -> barkod toast YO'Q ===
        var phone = q('#loginPhone');
        if (phone) phone.focus();
        document.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true, cancelable: true }));
        return sleep(700);
      })
      .then(function () {
        var bad = toasts().filter(function (t) {
          return t.indexOf('Topilmadi') !== -1 || t.indexOf('Barkod') !== -1;
        });
        add(!bad.length, location.protocol + ' [2] Enter(telefon maydoni): POS/barkod toast YO\'Q' + (bad.length ? ' => ' + bad[0] : ''));
        return sleep(200);
      });
  }

  function scenario3() {
    return reset()
      .then(function () {
        add(seedStaleLock('901234554'), location.protocol + ' [3] stale lock localStorage ga yozildi (lockUntil +10 daq)');
        return loginRaw('901234554', 'diyorbek6272');
      })
      .then(function (r) {
        add(r.ok, location.protocol + ' [3b] stale lock GA QARAMASDAN to\'g\'ri parol -> kirish OK' +
          (r.err ? ' (err=' + r.err + ')' : '') + (r.toasts && r.toasts.length ? ' | toasts: ' + r.toasts.join(' ; ').slice(0, 160) : ''));
        add(r.role === 'Boshliq', location.protocol + ' [3c] BOSHLIQ roli: "' + r.role + '"');
        var guard = '?';
        try { guard = JSON.stringify(JSON.parse(localStorage.getItem('tp_login_guard') || '{}')); } catch (e) { guard = '?'; }
        add(guard === '{}', location.protocol + ' [3d] muvaffaqiyatdan so\'ng tp_login_guard tozalandi: ' + guard);
        return sleep(200);
      });
  }

  function scenario4() {
    var variants = ['+998901234554', '+998 90 123 45 54', '998901234554', '901234554'];
    var chain = Promise.resolve().then(reset);
    variants.forEach(function (v) {
      chain = chain.then(reset).then(function () {
        return loginRaw(v.replace(/\D/g, ''), 'diyorbek6272');
      }).then(function (r) {
        add(r.ok && r.role === 'Boshliq', location.protocol + ' [4] "' + v + '" -> BOSHLIQ, ok=' + r.ok + ', role=' + r.role +
          (r.err ? ' err=' + r.err : '') + (r.toasts && r.toasts.length ? ' | toasts=' + r.toasts.join(' ; ').slice(0, 160) : ''));
      });
    });
    return chain;
  }
  function scenario5() {
    var last;
    var chain = Promise.resolve().then(reset);
    for (var i = 0; i < 5; i++) {
      chain = chain.then(function () {
        return loginRaw('901234554', 'diyorbek0000');
      }).then(function (r) { last = r; });
    }
    return chain.then(function () {
      var t = toasts().join(' | ');
      var guarded = (localStorage.getItem('tp_login_guard') || '').length > 0;
      add(!last.ok && (/bloklandi|ko`p noto|bloklangan|urini|Xavfsizlik/gi.test(t) || guarded),
        location.protocol + ' [5] 5x xato parol -> lockout xabari (last.ok=' + (last ? last.ok : '?') + '): ' + t.slice(0, 220));
      return reset();
    }).then(function () {
      return loginRaw('901234554', 'diyorbek6272');
    }).then(function (r) {
      add(r.ok && r.role === 'Boshliq', location.protocol + ' [5b] lockoutdan keyin to\'g\'ri parol -> BOSHLIQ (ok=' + r.ok + ', role=' + r.role + ')');
    });
  }

  function scenario6() {
    var roles = [
      ['908480921', 'Administrator'],
      ['902750921', 'Menejer'],
      ['905450921', 'Kassa Xodimi']
    ];
    var chain = Promise.resolve();
    roles.forEach(function (pair) {
      chain = chain.then(reset).then(function () {
        return loginRaw(pair[0], 'diyorbek6272');
      }).then(function (r) {
        add(r.ok && r.role === pair[1], location.protocol + ' [6] ' + pair[0] + ' -> "' + r.role + '" (kutilgan: ' + pair[1] + ')');
      });
    });
    return chain;
  }

  function run() {
    main()
      .then(scenario3)
      .then(scenario4)
      .then(scenario5)
      .then(scenario6)
      .then(function () {
        var pre = document.createElement('pre');
        pre.id = 'out';
        pre.style.cssText = 'position:fixed;left:0;bottom:0;right:0;max-height:40vh;overflow:auto;background:#111;color:#0f0;padding:10px;z-index:99999;margin:0';
        pre.textContent = 'MODE=' + location.protocol + '\n' + results.join('\n') +
          '\n\nJami: ' + results.length + ', ' +
          results.filter(function (r) { return r.indexOf('PASS') === 0; }).length + ' PASS, ' +
          results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length + ' FAIL' +
          '\n\n--- DEBUG (fetch) ---\n' + debug.slice(-40).join('\n');
        (document.body || document.documentElement).appendChild(pre);
        document.title = 'TP_FINAL_DONE';
      })
      .catch(function (e) {
        var pre = document.createElement('pre');
        pre.id = 'out';
        pre.textContent = 'FATAL: ' + ((e && e.stack) || String(e));
        (document.body || document.documentElement).appendChild(pre);
        document.title = 'TP_FINAL_ERROR';
      });
  }

  var ready = function () {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      startOnce();
    } else {
      document.addEventListener('DOMContentLoaded', startOnce);
      window.addEventListener('load', startOnce);
    }
  };
  ready();
})();