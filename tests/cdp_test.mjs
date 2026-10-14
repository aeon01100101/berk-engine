// Real-browser play test: drives Berk Engine in headless Chromium (SwiftShader
// WebGL) over CDP. Loads the page, clicks Play, waits for world gen, pumps
// real frames, pokes keys, and screenshots. Any uncaught page exception or
// console error fails the run.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Chrome 152 blocks even CDP navigations to loopback (Local Network Access
// checks), so the page is served from a fake public origin whose requests
// are intercepted and fulfilled from disk — no packet ever leaves the browser.
const PORT = 9333, PAGE_URL = 'http://berk.test/';
const WEBROOT = new URL('../web/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/opt/meta-chromium/chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights',
  '--remote-debugging-port=' + PORT, '--window-size=1100,700',
  '--user-data-dir=/tmp/berk-cdp-profile', 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const problems = [];
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function waitFor(expr, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJs(expr).catch(() => false)) return true;
    await sleep(400);
  }
  throw new Error('timeout waiting: ' + label);
}
async function shot(path) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  console.log('screenshot:', path, fs.statSync(path).size, 'bytes');
}

try {
  // wait for devtools endpoint
  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); targets = await r.json(); } catch { await sleep(500); }
  }
  const page = targets.find((t) => t.type === 'page' && (t.url === 'about:blank' || t.url.startsWith('http')));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') problems.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('CONSOLE ERROR: ' + JSON.stringify(m.params.args).slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push('LOG ERROR: ' + m.params.entry.text);
    if (m.method === 'Fetch.requestPaused') {
      const u = new URL(m.params.request.url);
      let rel = decodeURIComponent(u.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(WEBROOT, rel);
      const rid = m.params.requestId;
      if (u.pathname === '/favicon.ico') {
        ws.send(JSON.stringify({ id: ++msgId, method: 'Fetch.fulfillRequest', params: { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: '' } }));
        return;
      }
      if (!file.startsWith(WEBROOT) || !fs.existsSync(file)) {
        ws.send(JSON.stringify({ id: ++msgId, method: 'Fetch.fulfillRequest', params: { requestId: rid, responseCode: 404, body: '' } }));
      } else {
        const body = fs.readFileSync(file).toString('base64');
        const type = MIME[path.extname(file)] || 'application/octet-stream';
        ws.send(JSON.stringify({ id: ++msgId, method: 'Fetch.fulfillRequest', params: { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body } }));
      }
    }
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http://berk.test/*', requestStage: 'Request' }] });
  await send('Page.navigate', { url: PAGE_URL });
  await waitFor(`!!document.querySelector('#btn-play')`, 15000, 'title screen');
  await waitFor(`typeof THREE !== 'undefined'`, 15000, 'three.js loaded');
  await sleep(1500); // engine.js binds its listeners at the end of the file
  console.log('title screen up');
  await evalJs(`document.querySelector('#world-name').value='CDPTest'; document.querySelector('#world-seed').value='42'; document.querySelector('#btn-play').click(); 'clicked'`);
  await waitFor(`document.querySelector('#pack-stats').textContent.includes('dragon species')`, 30000, 'pack + entities loaded');
  console.log('pack stats:', await evalJs(`document.querySelector('#pack-stats').textContent`));
  await waitFor(`!document.querySelector('#hud').classList.contains('hidden')`, 30000, 'HUD visible (world started)');
  await sleep(6000); // let chunks mesh + frames run
  const hotbar = await evalJs(`document.querySelectorAll('#hotbar .slot').length`);
  const selName = await evalJs(`document.querySelector('#selname').textContent`);
  console.log('hotbar slots:', hotbar, '| selected:', selName);
  // frame counter: prove the render loop is actually running
  const frames = await evalJs(`new Promise((res) => { let n = 0; const f = () => { n++; if (n < 90) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); })`);
  console.log('rAF frames pumped:', frames);
  await shot('/tmp/berk-ingame.png');
  // open the block picker with B and screenshot it
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'b'})); 'ok'`);
  await sleep(1200);
  const pickerCount = await evalJs(`document.querySelector('#picker-count').textContent`);
  console.log('picker:', pickerCount);
  await shot('/tmp/berk-picker.png');
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'b'})); 'ok'`);
  // walk forward for 2 seconds of real frames (game loop reads key state)
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'w'})); 'ok'`);
  await sleep(2000);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keyup', {key:'w'})); 'ok'`);
  await shot('/tmp/berk-walked.png');
  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'NO PAGE ERRORS');
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  console.log('TEST FAILED:', e.message);
  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : '(no page errors captured)');
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  chrome.kill('SIGKILL');
}
