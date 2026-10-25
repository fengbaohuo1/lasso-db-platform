// 服务不可用（BFF 指向不存在的 db-service）时的前端错误态验证
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEBUG_PORT = Number(process.argv[2] || 9298);
const APP_PORT = process.argv[3] || '18097';
const OUT = fileURLToPath(new URL('../verify-ui/', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:' + APP_PORT));
      if (page) return page;
    } catch { /* wait */ }
    await sleep(300);
  }
  throw new Error('找不到 Edge 页面');
}

const page = await findTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const consoleErrors = [];
const pageExceptions = [];
let nextId = 0;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    const text = message.params.args.map((a) => a.value || a.description || '').join(' ');
    if (!text.includes('chrome-extension://') && !text.includes('Untrusted event')) consoleErrors.push(text);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params.exceptionDetails;
    const text = detail.text + ' ' + (detail.exception?.description || '');
    if (!text.includes('chrome-extension://')) pageExceptions.push(text);
  }
};
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result?.value;
}
async function waitFor(expression, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await evaluate(expression)) return true; } catch { /* navigation */ }
    await sleep(200);
  }
  throw new Error('等待超时：' + label);
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + name, Buffer.from(result.data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(`(localStorage.clear(), location.reload(), true)`);
await sleep(1800);
await waitFor(`!!document.querySelector('#tree .tree-error')`, 20000, '服务不可用错误');
const report = {
  initial: {
    title: await evaluate('document.title'),
    treeError: await evaluate(`document.querySelector('#tree .tree-error')?.textContent || ''`),
    hint: await evaluate(`document.querySelector('#tree .tree-error-hint')?.textContent || ''`),
    hasToolbar: await evaluate(`!!document.getElementById('newConnectionBtn')`),
    bodyTextLength: await evaluate('document.body.innerText.length'),
  },
};
await screenshot('final-28-service-down.png');

// 服务不可用时仍应能打开新建弹窗，保存后给出可读错误
await evaluate(`document.getElementById('newConnectionBtn').click()`);
await sleep(300);
await evaluate(`(() => {
  const type = document.getElementById('connType');
  type.value = 'custom';
  type.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('connName').value = 'offline-test';
  document.getElementById('connUrl').value = 'jdbc:h2:mem:offline;DB_CLOSE_DELAY=-1';
  return true;
})()`);
await evaluate(`[...document.querySelectorAll('#connectionModal button')].find((b) => b.textContent.trim() === '保存').click()`);
await waitFor(`document.getElementById('toast').textContent.includes('保存失败')`, 15000, '离线保存错误');
report.save = {
  toast: await evaluate(`document.getElementById('toast').textContent`),
  modalOpen: await evaluate(`!document.getElementById('connectionModal').classList.contains('hidden')`),
};
await screenshot('final-29-service-down-save.png');
report.consoleErrors = consoleErrors;
report.pageExceptions = pageExceptions;
fs.writeFileSync(OUT + 'final-offline-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
socket.close();
