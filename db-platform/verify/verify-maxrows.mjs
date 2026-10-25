// 设置 maxRows 生效验证：设置 5 后查询 orders（12 行）只返回 5 行并提示截断
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEBUG_PORT = Number(process.argv[2] || 9300);
const APP_PORT = process.argv[3] || '18091';
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
await evaluate(`document.getElementById('settingsBtn').click()`);
await sleep(300);
await evaluate(`document.getElementById('settingsMaxRows').value = '5'`);
await evaluate(`[...document.querySelectorAll('#settingsModal button')].find((b) => b.textContent.trim() === '保存设置').click()`);
await sleep(300);
await evaluate(`document.getElementById('settingsModalClose').click()`);
await evaluate(`document.getElementById('newQueryBtn').click()`);
await waitFor(`!!document.querySelector('.console-editor')`, 5000, 'SQL 控制台');
await evaluate(`document.querySelector('.console-editor').value = 'SELECT * FROM orders'`);
await evaluate(`document.querySelector('.console-toolbar button').click()`);
await waitFor(`!!document.querySelector('.grid-table tbody tr')`, 20000, '查询结果');
await sleep(400);
const report = {
  rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`),
  meta: await evaluate(`document.querySelector('.console-meta').textContent`),
  truncated: await evaluate(`document.querySelector('.console-meta').textContent.includes('截断')`),
  consoleErrors,
  pageExceptions: exceptions,
};
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + 'final-31-maxrows.png', Buffer.from(shot.data, 'base64'));
fs.writeFileSync(OUT + 'final-maxrows-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
