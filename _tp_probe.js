/* Texno Park N1 — login barqarorlik probe (vaqtinchalik, test nusxasi uchun) */
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (document.readyState !== 'complete') {
    await new Promise(res => window.addEventListener('load', res, { once: true }));
  }
  const win = window, doc = document;
  const pre = doc.createElement('pre');
  pre.id = 'tp-results';
  pre.style.display = 'none';
  doc.body.appendChild(pre);

  for (let i = 0; i < 60 && !doc.querySelector('.login-box'); i++) await sleep(100);
  await sleep(1500); // fade-in tugashi + config

  const results = { checks: [], info: {} };
  const add = (ok, msg) => results.checks.push((ok ? 'PASS ' : 'FAIL ') + msg);
  const q = s => doc.querySelector(s);
  const qa = s => [...doc.querySelectorAll(s)];
  const rect = el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 100) / 100); };
  const cs = el => win.getComputedStyle(el);
  const eq = (a, b, tol) => { tol = tol || 0.75; return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol); };

  const lp = q('#loginPage'), lb = q('.login-box'), btn = q('#loginPage .btn-login'), icon = q('.login-logo .logo-icon');
  const cards = qa('#loginPage .quick-section');
  const snapshot = () => ({ st: lp.scrollTop, box: rect(lb), cards: cards.map(rect), btn: rect(btn), icon: rect(icon) });
  const absY = o => ({ box: o.box[1] + o.st, cards: o.cards.map(r => r[1] + o.st), btn: o.btn[1] + o.st, icon: o.icon[1] + o.st });
  const desc = el => { if (!el) return 'null'; const c = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''; return (el.tagName || '?') + (el.id ? '#' + el.id : '') + c; };

  const base = snapshot();
  results.info.vp = [win.innerWidth, win.innerHeight];
  results.info.base = base;

  // A) Fon rasmi
  const bgi = cs(lp).backgroundImage;
  add(/texno-park-n1-exterior\.jpg/.test(bgi), 'bg-image: ' + bgi.slice(0, 70));
  add(cs(lp).backgroundSize === 'cover', 'bg-size: ' + cs(lp).backgroundSize);
  add(cs(lp).backgroundPosition === '50% 50%', 'bg-position: ' + cs(lp).backgroundPosition);
  add(cs(lp).backgroundRepeat === 'no-repeat', 'bg-repeat: ' + cs(lp).backgroundRepeat);
  const imgOk = await new Promise(res => {
    const i = new Image();
    i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight);
    i.onerror = () => res('');
    i.src = 'assets/texno-park-n1-exterior.jpg?p=1';
  });
  add(!!imgOk, 'img yuklandi: ' + imgOk);

  // B) Animatsiya / transform
  add(cs(lb).animationName === 'loginFadeIn', 'box anim: ' + cs(lb).animationName);
  add(cs(icon).animationName === 'none', 'icon anim: ' + cs(icon).animationName);
  add(cards.every(c => cs(c).animationName === 'none'), 'cards anim: ' + cards.map(c => cs(c).animationName).join(','));
  add(cs(btn).animationName === 'none', 'btn anim: ' + cs(btn).animationName);
  add(cs(lb).transform === 'none', 'box transform: ' + cs(lb).transform);
  add(cs(icon).transform === 'none', 'icon transform: ' + cs(icon).transform);
  add(cards.every(c => cs(c).transform === 'none'), 'cards transform: ' + cards.map(c => cs(c).transform).join(','));
  add(cs(btn).transform === 'none', 'btn transform: ' + cs(btn).transform);
  add(cs(lb).willChange === 'auto', 'will-change: ' + cs(lb).willChange);

  // C) Vaqt bo'yicha barqarorlik
  await sleep(900);
  let s = snapshot();
  add(eq(base.box, s.box) && base.cards.every((r, i) => eq(r, s.cards[i])) && eq(base.icon, s.icon), '900ms: pozitsiya bir xil');

  // D) Focus / click / toggle / rol tanlash
  doc.getElementById('loginUser').focus();
  await sleep(150);
  s = snapshot();
  add(eq(base.box, s.box), 'username focus: stable');
  add(doc.activeElement && doc.activeElement.id === 'loginUser', 'username focus: activeElement');
  doc.getElementById('loginPass').focus();
  await sleep(150);
  s = snapshot();
  add(eq(base.box, s.box), 'parol focus: stable (border o`lchami o`zgarmaydi)');
  const pt = q('#loginPage .pass-toggle');
  pt.click();
  await sleep(220);
  add(doc.getElementById('loginPass').type === 'text', 'eye toggle: text');
  s = snapshot();
  add(eq(base.box, s.box), 'eye toggle (text): stable');
  pt.click();
  await sleep(220);
  add(doc.getElementById('loginPass').type === 'password', 'eye toggle: password qaytdi');
  s = snapshot();
  add(eq(base.box, s.box), 'eye toggle (parol): stable');
  for (let i = 0; i < cards.length && i < 3; i++) {
    cards[i].click();
    await sleep(220);
    s = snapshot();
    const selCount = cards.filter(c => c.classList.contains('selected')).length;
    add(eq(base.box, s.box) && base.cards.every((r, j) => eq(r, s.cards[j])) && selCount === 1 && cards[i].classList.contains('selected'),
      'rol ' + i + ' tanlash: selected=1, surilish yo`q (value=' + doc.getElementById('loginUser').value + ')');
  }

  // E) HAQIQIY hover/active simulyatsiyasi: :hover/:active -> .tp-force-* klon
  const hoverCls = 'tp-force-hover', activeCls = 'tp-force-active';
  const cssParts = [];
  for (const sh of doc.styleSheets) {
    try {
      let text = '';
      if (sh.ownerNode && sh.ownerNode.textContent) text = sh.ownerNode.textContent;
      else if (sh.href) {
        const u = new URL(sh.href, win.location.href);
        if (u.origin !== win.location.origin) continue;
        text = await (await fetch(u.href)).text();
      }
      if (text) {
        if (text.indexOf(':hover') !== -1) cssParts.push(text.replace(/:hover/g, '.' + hoverCls));
        if (text.indexOf(':active') !== -1) cssParts.push(text.replace(/:active/g, '.' + activeCls));
      }
    } catch (e) { /* tashqi CDN — o'tkazib yuboriladi */ }
  }
  const st = doc.createElement('style');
  st.textContent = cssParts.join('\n');
  doc.head.appendChild(st);
  results.info.hoverParts = cssParts.length;

  const hoverPath = el => { const list = []; let cur = el; while (cur && cur.nodeType === 1) { list.push(cur); if (cur === lp) break; cur = cur.parentElement; } return list; };
  const clearForced = () => qa('#loginPage, #loginPage *').forEach(el => el.classList.remove(hoverCls, activeCls));
  lp.scrollTop = 0;
  await sleep(200);
  const ref = snapshot();
  const hoverTest = async (label, targets) => {
    lp.scrollTop = ref.st;
    await sleep(120);
    const before = snapshot();
    targets.forEach(el => el.classList.add(hoverCls));
    await sleep(420);
    const after = snapshot();
    const okAbs = Math.abs(absY(before).box - absY(after).box) <= 0.75
      && Math.abs(absY(before).btn - absY(after).btn) <= 0.75
      && before.cards.every((r, i) => Math.abs((r[1] + before.st) - (after.cards[i][1] + after.st)) <= 0.75);
    const okT = cs(btn).transform === 'none' && cs(lb).transform === 'none' && cs(icon).transform === 'none' && cards.every(c => cs(c).transform === 'none');
    const ds = Math.round((after.st - before.st) * 100) / 100;
    add(okAbs && okT && Math.abs(ds) < 0.5,
      label + ' [abs=' + (okAbs ? 'ok' : 'SHIFT') + ' transform=' + (okT ? 'none' : cs(btn).transform + '|' + cs(lb).transform) + ' scrollD=' + ds + ']');
    clearForced();
    await sleep(260);
    lp.scrollTop = ref.st;
    await sleep(140);
  };
  await hoverTest('hover: BARCHA elementlar birga (eng og`ir holat)', qa('#loginPage, #loginPage *'));
  await hoverTest('hover: faqat tugma (.btn-login)', hoverPath(btn));
  await hoverTest('hover: faqat 1-rol kartasi', hoverPath(cards[0]));
  await hoverTest('hover: faqat login-box', [lb]);
  await hoverTest('hover: faqat showroom paneli', hoverPath(q('.login-showcase')));
  await hoverTest('hover: faqat logo icon', hoverPath(icon));
  lp.scrollTop = ref.st;
  await sleep(120);
  const bAct = snapshot();
  hoverPath(btn).forEach(el => el.classList.add(activeCls));
  await sleep(350);
  const aAct = snapshot();
  add(Math.abs(absY(bAct).box - absY(aAct).box) <= 0.75 && cs(btn).transform === 'none',
    'ACTIVE (.btn-login bosilgan holat): joyida, transform=' + cs(btn).transform);
  clearForced();
  await sleep(260);

  // F) Overflow / layout
  add(doc.documentElement.scrollWidth - win.innerWidth <= 0, 'gorizontal overflow (doc): ' + (doc.documentElement.scrollWidth - win.innerWidth));
  add(lp.scrollWidth - lp.clientWidth <= 0, 'gorizontal overflow (loginPage): ' + (lp.scrollWidth - lp.clientWidth));
  const bodyW = Math.round(doc.body.getBoundingClientRect().width * 100) / 100;
  const clientW = doc.documentElement.clientWidth;
  results.info.widths = { bodyW: bodyW, clientW: clientW, innerW: win.innerWidth, docScrollW: doc.documentElement.scrollWidth, innerH: win.innerHeight };
  add(Math.abs(bodyW - clientW) < 1.5 || Math.abs(bodyW - win.innerWidth) < 1.5, 'body kengligi viewportni qoplaydi (body=' + bodyW + ' client=' + clientW + ' inner=' + win.innerWidth + ')');
  add(cs(doc.body).marginTop === '0px' && cs(doc.body).marginLeft === '0px', 'body margin 0');
  const c1 = doc.elementFromPoint(2, 2);
  const c2 = doc.elementFromPoint(win.innerWidth - 3, win.innerHeight - 3);
  results.info.corners = { tl: desc(c1), br: desc(c2), tlIn: !!lp.contains(c1), brIn: !!lp.contains(c2) };
  add(!!lp.contains(c1) && !!lp.contains(c2), 'burchaklar loginPage bilan qoplangan — tl=' + desc(c1) + ' br=' + desc(c2));
  const lpRect = lp.getBoundingClientRect();
  const hOver = qa('#loginPage, #loginPage *').map(el => {
    const r = el.getBoundingClientRect();
    return { el: desc(el), right: Math.round((r.right - lpRect.right) * 100) / 100, left: Math.round((lpRect.left - r.left) * 100) / 100, w: Math.round(r.width * 100) / 100 };
  }).filter(o => o.w > 0 && (o.right > 0.5 || o.left > 0.5));
  results.info.hOver = hOver.slice(0, 15);
  if (lp.scrollWidth - lp.clientWidth > 0) {
    const culprits = [];
    const test = (sel, label) => {
      const s2 = doc.createElement('style');
      s2.textContent = sel + '{display:none !important}';
      doc.head.appendChild(s2);
      const ov = lp.scrollWidth - lp.clientWidth;
      s2.remove();
      if (ov <= 0) culprits.push(label);
    };
    const kids = qa('#loginPage > *, #loginPage .login-box > *, #loginPage .login-showcase > *');
    kids.forEach((el, i) => el.setAttribute('data-tp-i', String(i)));
    kids.forEach((el, i) => test('[data-tp-i="' + i + '"]', desc(el)));
    kids.forEach(el => el.removeAttribute('data-tp-i'));
    const pseudoCulprits = [];
    ['#loginPage::before', '#loginPage::after', '#loginPage .login-box::before', '#loginPage .login-box::after', '#loginPage .login-showcase::before', '#loginPage .login-showcase::after'].forEach(sel => {
      const s2 = doc.createElement('style');
      s2.textContent = sel + '{display:none !important}';
      doc.head.appendChild(s2);
      const ov = lp.scrollWidth - lp.clientWidth;
      s2.remove();
      if (ov <= 0) pseudoCulprits.push(sel);
    });
    results.info.culprit = culprits;
    results.info.culpritPseudo = pseudoCulprits;
  }

  // G) Scroll — transform o'zgarmasligi
  win.scrollTo(0, 250);
  lp.scrollTop = 200;
  await sleep(150);
  add(cs(lb).transform === 'none' && cs(icon).transform === 'none' && cs(btn).transform === 'none', 'scroll: transformlar none');
  win.scrollTo(0, 0);
  lp.scrollTop = 0;
  await sleep(150);

  // H) Mobil vertikal: yuqori qism kesilib qolmasligi
  const showEl = q('.login-showcase');
  const showR = showEl ? showEl.getBoundingClientRect() : null;
  const lpR = lp.getBoundingClientRect();
  results.info.vert = {
    lpScrollH: lp.scrollHeight, lpClientH: lp.clientHeight,
    overflow: lp.scrollHeight - lp.clientHeight,
    showcaseTop: showR ? Math.round(showR.top * 100) / 100 : null,
    lpTop: Math.round(lpR.top * 100) / 100,
    topReachable: showR ? showR.top >= lpR.top - 1.5 : null
  };
  if (showR && lp.scrollHeight > lp.clientHeight) {
    add(showR.top >= lpR.top - 1.5, 'vertikal overflow bor, lekin yuqori qism ochiq (kesilmagan)');
  }

  // I) Tozalash (screenshot uchun toza holat)
  cards.forEach(c => c.classList.remove('selected'));
  if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
  await sleep(150);

  pre.textContent = JSON.stringify(results);
})().catch(e => {
  const p = document.getElementById('tp-results');
  if (p) p.textContent = JSON.stringify({ error: String((e && e.message) || e) });
  else document.title = 'PROBE-ERROR ' + String((e && e.message) || e);
});
