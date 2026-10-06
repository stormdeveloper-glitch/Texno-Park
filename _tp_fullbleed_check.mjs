// _tp_fullbleed_check.mjs — VAQTINCHALIK tekshiruv skripti (login full-bleed)
// Chrome DevTools Protocol orqali turli viewport'larda login sahifasi
// geometriyasini o'lchaydi va skrinshot oladi. Ilovaga aloqasi yo'q.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.TP_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const APP = 'http://127.0.0.1:8899/index.html';
const OUT = join(process.cwd(), '_tp_shots');
const VIEWPORTS = process.env.TP_VP
  ? process.env.TP_VP.split(',').map(s => s.split('x').map(Number))
  : [[1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1024, 768], [901, 700],
  [430, 932], [414, 896], [390, 844], [375, 667], [360, 640]];

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws ulanish xatosi')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? p.rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method && c.handlers.has(m.method)) {
        c.handlers.get(m.method).forEach(fn => fn(m.params));
      }
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout: ' + method)); } }, 30000);
    });
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
}

const MEASURE = `(() => {
  const MODE = '__TP_MODE__'; // 'login' (default) | 'app' (boshqa sahifa regressiya tekshiruvi)
  const lp = document.getElementById('loginPage');
  const app = document.getElementById('app');
  if (MODE === 'login') {
    if (app) app.style.display = 'none';
    if (lp) { lp.classList.add('active'); lp.style.display = 'grid'; }
  }
  const doc = document.documentElement;
  const box = (el, sel) => {
    if (!el) return null;
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { sel, l: +b.left.toFixed(2), t: +b.top.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2),
      r: +b.right.toFixed(2), b: +b.bottom.toFixed(2),
      width: cs.width, maxWidth: cs.maxWidth,
      margin: cs.marginTop + ' ' + cs.marginRight + ' ' + cs.marginBottom + ' ' + cs.marginLeft,
      padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
      minHeight: cs.minHeight, display: cs.display, overflowX: cs.overflowX,
      bgImage: (cs.backgroundImage || '').slice(0, 48), bgSize: cs.backgroundSize,
      bgPos: cs.backgroundPosition, bgRepeat: cs.backgroundRepeat };
  };
  const who = (x, y) => { const el = document.elementFromPoint(x, y); return el ? (el.id ? '#' + el.id : el.tagName + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '')) : 'null'; };
  const inLp = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && lp && lp.contains(el)); };
  const pts = [[1, 1], [doc.clientWidth - 2, 1], [1, Math.round(doc.clientHeight / 2)], [doc.clientWidth - 2, Math.round(doc.clientHeight / 2)], [1, doc.clientHeight - 2], [doc.clientWidth - 2, doc.clientHeight - 2]];
  const lpR = lp.getBoundingClientRect(), lbR = document.querySelector('.login-box').getBoundingClientRect();
  const animated = ['#loginPage .login-box', '#loginPage .btn-login', '#loginPage .quick-section', '#loginPage .logo-icon'];
  return {
    vp: [innerWidth, innerHeight], clientW: doc.clientWidth,
    scrollbarW: innerWidth - doc.clientWidth, hOverflow: doc.scrollWidth - doc.clientWidth,
    bodyW: +document.body.getBoundingClientRect().width.toFixed(2),
    leftGap: +lpR.left.toFixed(2), rightGapIn: +(innerWidth - lpR.right).toFixed(2),
    rightGapClient: +(doc.clientWidth - lpR.right).toFixed(2),
    panelRightGap: +(innerWidth - lbR.right).toFixed(2), panelLeftGap: +lbR.left.toFixed(2),
    lpOverflow: { x: lp.scrollWidth - lp.clientWidth, y: lp.scrollHeight - lp.clientHeight },
    loginPage: box(lp, '#loginPage'), showcase: box(document.querySelector('.login-showcase'), '.login-showcase'),
    loginBox: box(document.querySelector('.login-box'), '.login-box'), body: box(document.body, 'body'),
    cornersInLp: pts.map(p => inLp(p[0], p[1])), cornersWho: pts.map(p => who(p[0], p[1])),
    diag: (() => {
      const o = [];
      document.querySelectorAll(MODE === 'login' ? '#loginPage *' : '#app *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > Math.max(200, doc.clientWidth - 60)) {
          o.push({ s: el.id ? '#' + el.id : el.tagName + '.' + String(el.className).split(' ')[0], w: +r.width.toFixed(1), sw: el.scrollWidth, cw: el.clientWidth });
        }
      });
      return o.slice(0, 12);
    })(),
    transforms: animated.map(s => { const el = document.querySelector(s); return el ? getComputedStyle(el).transform : 'MISSING'; }),
    animations: animated.map(s => { const el = document.querySelector(s); return el ? getComputedStyle(el).animationName : 'MISSING'; })
  };
})()`;

const MODE = process.env.TP_APP ? 'app' : 'login';
const MEASURE_EXPR = MEASURE.replace('__TP_MODE__', MODE);

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const profile = join(process.env.TEMP || '.', 'tp-chrome-profile-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--no-sandbox', 'about:blank'], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch (e) { await sleep(300); }
  }
  if (!version) throw new Error('Chrome CDP ulanmadi');
  const c = await CDP.connect(version.webSocketDebuggerUrl);
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  let loaded = false;
  c.on('Page.loadEventFired', () => { loaded = true; });

  const results = [];
  for (const [w, h] of VIEWPORTS) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
    loaded = false;
    await c.send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 30 && !loaded; i++) await sleep(300);
    await sleep(900); // bootstrap + fade-in
    const measure = async () => (await c.send('Runtime.evaluate', { expression: MEASURE_EXPR, returnByValue: true }, sessionId)).result.value;
    const a = await measure();
    for (const [x, y] of [[Math.round(w * 0.75), Math.round(h * 0.5)], [Math.round(w * 0.5), Math.round(h * 0.5)], [10, 10], [w - 12, h - 12]]) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sessionId);
    }
    await sleep(350);
    const b = await measure(); // hover / mouse harakati (talab #16)
    const stable = b.loginBox.l === a.loginBox.l && b.loginBox.t === a.loginBox.t && b.loginBox.w === a.loginBox.w &&
      b.leftGap === a.leftGap && b.rightGapClient === a.rightGapClient;
    const shot = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(OUT, `${w}x${h}${MODE === 'app' ? '-app' : ''}.png`), Buffer.from(shot.data, 'base64'));
    const appRegression = { appHOverflow: a.hOverflow, bodyW: a.bodyW, clientW: a.clientW, appDiag: a.diag };
    results.push({ vp: `${w}x${h}`, a, stable, appRegression,
      transformsAllNone: a.transforms.every(t => t === 'none') && b.transforms.every(t => t === 'none'),
      cornersCovered: a.cornersInLp.every(Boolean) });
  }

  // Resize (reload'siz) tekshiruvi — talab #17.7
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(350);
  const r1 = (await c.send('Runtime.evaluate', { expression: MEASURE_EXPR, returnByValue: true }, sessionId)).result.value;
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(450);
  const r2 = (await c.send('Runtime.evaluate', { expression: MEASURE_EXPR, returnByValue: true }, sessionId)).result.value;
  const resized = { at1920: [r1.leftGap, r1.rightGapClient, r1.panelRightGap], at1366: [r2.leftGap, r2.rightGapClient, r2.panelRightGap],
    ok: Math.abs(r1.leftGap) < 1 && Math.abs(r1.rightGapClient) < 1 && Math.abs(r2.leftGap) < 1 && Math.abs(r2.rightGapClient) < 1 };

  const summary = results.map(r => {
    const fails = [];
    if (MODE === 'app') {
      // Login sahifasidan tashqari sahifalar regressiyasi (talab: "boshqa sahifalarga tegmaslik")
      if (r.appRegression.appHOverflow > 0) fails.push('app gorizontal overflow ' + r.appRegression.appHOverflow);
      if (Math.abs(r.appRegression.bodyW - r.appRegression.clientW) > 1) fails.push('body kengligi mos emas ' + r.appRegression.bodyW + ' / ' + r.appRegression.clientW);
      return { vp: r.vp, status: fails.length ? 'FAIL' : 'PASS', fails, ...r.appRegression, appW: r.a.diag.length };
    }
    if (Math.abs(r.a.leftGap) > 1) fails.push("CHAP boshliq " + r.a.leftGap);
    if (Math.abs(r.a.rightGapClient) > 1) fails.push("ONG boshliq " + r.a.rightGapClient);
    if (r.a.hOverflow > 0) fails.push('gorizontal overflow ' + r.a.hOverflow);
    if (!r.cornersCovered) fails.push('burchaklar qoplanmagan: ' + JSON.stringify(r.a.cornersWho));
    if (!r.transformsAllNone) fails.push('transform bor: ' + JSON.stringify(r.a.transforms));
    if (!r.stable) fails.push("hover'da panel siljidi");
    if (r.a.lpOverflow.x > 0) fails.push('loginPage ichki gorizontal overflow ' + r.a.lpOverflow.x);
    if (r.a.panelRightGap < 4 || r.a.panelRightGap > 90) fails.push("panel-ong chekka masofasi " + r.a.panelRightGap);
    return { vp: r.vp, status: fails.length ? 'FAIL' : 'PASS', fails, leftGap: r.a.leftGap, rightGap: r.a.rightGapClient,
      hOverflow: r.a.hOverflow, lpOverflow: r.a.lpOverflow.x, lpW: r.a.loginPage.w, boxW: r.a.loginBox.w,
      boxLeft: r.a.loginBox.l, boxRight: r.a.loginBox.r,
      panelRightGap: r.a.panelRightGap, cornersCovered: r.cornersCovered, minHeight: r.a.loginPage.minHeight,
      animations: r.a.animations, diag: r.a.diag };
  });
  const out = { summary, resized, full: results };
  console.log(JSON.stringify({ summary, resized }, null, 1));
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(out, null, 1));
  c.ws.close();
  chrome.kill();
};

main().catch(e => { console.error('XATO: ' + (e && e.message)); process.exit(1); });
