// 写模式与 allowWrite=false 同步验证：浏览器应拒绝开启并提示。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEBUG_PORT = Number(process.argv[2] || 9299);
const APP_PORT = process.argv[3] || '18099';
const OUT = fileURLToPath(new URL('../verify-ui/', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:' + APP_PORT));
      if (page) return page;
    } catch { /* wait */ }
    await sleep(300);
  }
  throw new Error('找不到 Edge 页面');
}
const page = await findTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const consoleErrors = [];
const exceptions = [];
let id = 0;
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = m.params.args.map((a) => a.value || a.description || '').join(' ');
    if (!text.includes('chrome-extension://')) consoleErrors.push(text);
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
  if (m.method === 'Page.javascriptDialogOpening') {
    const reqId = ++id;
    ws.send(JSON.stringify({ id: reqId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}
async function waitFor(expression, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expression)) return true; } catch { /* nav */ }
    await sleep(200);
  }
  throw new Error('等待超时：' + label);
}
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(`(localStorage.clear(), location.reload(), true)`);
await sleep(1800);
await waitFor(`!!document.querySelector('.conn-row')`, 15000, '数据源树');
await evaluate(`document.getElementById('writeToggle').click()`);
await waitFor(`document.getElementById('toast').textContent.includes('未开启写操作')`, 15000, '写模式拒绝提示');
const report = {
  writeStatus: await evaluate(`document.getElementById('statusWrite').textContent`),
  toggleChecked: await evaluate(`document.getElementById('writeToggle').checked`),
  toast: await evaluate(`document.getElementById('toast').textContent`),
  consoleErrors,
  pageExceptions: exceptions,
};
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + 'final-30-write-disabled.png', Buffer.from(shot.data, 'base64'));
fs.writeFileSync(OUT + 'final-writemode-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
