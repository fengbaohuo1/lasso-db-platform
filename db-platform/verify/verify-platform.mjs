// db-platform 验证：数据源注册/E2E 树/数据/DDL/行编辑/增量页签/设置
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEBUG_PORT = Number(process.argv[2] || 9291);
const APP_PORT = process.argv[3] || '18091';
const OUT_DIR = fileURLToPath(new URL('../verify-ui/', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && target.url.includes('127.0.0.1:' + APP_PORT));
      if (page) return page;
    } catch {
      // Edge 未就绪
    }
    await sleep(300);
  }
  throw new Error('找不到 Edge 页面 target');
}

const page = await findTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const consoleErrors = [];
const pageExceptions = [];
const dialogs = [];
let nextId = 0;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    const text = message.params.args.map((arg) => arg.value || arg.description || '').join(' ');
    if (!text.includes('chrome-extension://') && !text.includes('Untrusted event')) consoleErrors.push(text);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params.exceptionDetails;
    const text = detail.text + ' ' + (detail.exception?.description || '');
    const url = detail.url || detail.stackTrace?.callFrames?.[0]?.url || '';
    if (!text.includes('chrome-extension://') && !text.includes('Untrusted event') && !url.includes('chrome-extension://')) {
      pageExceptions.push({ text, url, stack: (detail.stackTrace?.callFrames || []).slice(0, 4).map((frame) => frame.url + ':' + frame.lineNumber) });
    }
  }
  if (message.method === 'Page.javascriptDialogOpening') {
    dialogs.push({ type: message.params.type, message: message.params.message.slice(0, 200) });
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  }
};
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('eval 失败：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  return result.result?.value;
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT_DIR + name, Buffer.from(result.data, 'base64'));
}

async function waitFor(expression, timeoutMs = 15000, label = expression) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      // 页面导航中
    }
    await sleep(200);
  }
  throw new Error('等待超时：' + label);
}

async function rectOf(expression) {
  return evaluate(`(() => {
    const node = ${expression};
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
}

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
}

async function clickAt(point) {
  await mouse('mousePressed', point.x, point.y);
  await mouse('mouseReleased', point.x, point.y);
}

async function dblclick(point) {
  await mouse('mousePressed', point.x, point.y, { clickCount: 1 });
  await mouse('mouseReleased', point.x, point.y, { clickCount: 1 });
  await mouse('mousePressed', point.x, point.y, { clickCount: 2 });
  await mouse('mouseReleased', point.x, point.y, { clickCount: 2 });
}

async function clickButton(scope, text) {
  const ok = await evaluate(`(() => {
    const root = (${scope}) || document;
    const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === ${JSON.stringify(text)} && !node.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!ok) throw new Error('找不到按钮：' + text);
}

async function clickMenu(text) {
  const ok = await evaluate(`(() => {
    const button = [...document.querySelectorAll('#contextMenu .menu-item')].find((node) => node.textContent.includes(${JSON.stringify(text)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!ok) throw new Error('找不到菜单项：' + text);
}

const report = { steps: [] };
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(`(localStorage.clear(), location.reload(), true)`);
await sleep(1800);
await waitFor(`document.querySelectorAll('.tree-node').length > 2`, 20000, '数据源树');
await waitFor(`!!document.querySelector('.conn-row')`, 15000, '数据源行');
await evaluate(`(() => {
  window.__unhandled = [];
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.__unhandled.push({
      reason: String(reason && (reason.message || reason)),
      stack: String(reason && reason.stack || ''),
    });
  });
  return true;
})()`);

report.steps.push({
  step: 'initial',
  datasources: await evaluate(`[...document.querySelectorAll('.conn-row .tree-label')].map((node) => node.textContent.trim())`),
  aiHidden: await evaluate(`document.getElementById('aiToggle').classList.contains('hidden')`),
  title: await evaluate(`document.title`),
});
await screenshot('01-tree.png');

// 注册自定义 H2 数据源
await evaluate(`document.getElementById('newConnectionBtn').click()`);
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, '数据源弹窗');
await evaluate(`(() => {
  const type = document.getElementById('connType');
  type.value = 'custom';
  type.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('connName').value = 'H2 平台测试';
  document.getElementById('connUrl').value = 'jdbc:h2:mem:platformtest;DB_CLOSE_DELAY=-1';
  document.getElementById('connUser').value = 'sa';
  document.getElementById('connPassword').value = '';
  document.getElementById('connSavePassword').checked = false;
  return true;
})()`);
await sleep(300);
await screenshot('02-register-datasource.png');
await clickButton(`document`, '保存');
await waitFor(`document.getElementById('toast').textContent.includes('数据源已保存')`, 20000, '数据源保存 toast');
await sleep(1200);
report.steps.push({
  step: 'register-h2',
  toast: await evaluate(`document.getElementById('toast').textContent`),
  treeNames: await evaluate(`[...document.querySelectorAll('.conn-row .tree-label')].map((node) => node.textContent.trim())`),
});
await screenshot('03-registered-tree.png');

// 选内置 demo，确保 orders 表节点可见（注册 H2 后 demo 可能仍展开/也可能被切走）
let ordersNode = await rectOf(`[...document.querySelectorAll('.tree-node[data-context="table"]')].find((node) => node.textContent.includes('orders'))`);
if (!ordersNode) {
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.conn-row')];
    const demo = rows.find((node) => node.textContent.includes('内置演示库'));
    if (!demo) return false;
    demo.querySelector('.tree-label').click();
    return true;
  })()`);
  await sleep(1200);
  ordersNode = await rectOf(`[...document.querySelectorAll('.tree-node[data-context="table"]')].find((node) => node.textContent.includes('orders'))`);
}
if (!ordersNode) throw new Error('找不到 orders 表节点');
await dblclick(ordersNode);
await waitFor(`document.querySelector('.grid-table tbody tr')`, 20000, '数据网格');
await sleep(500);
report.steps.push({
  step: 'data',
  rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`),
  meta: await evaluate(`document.querySelector('.object-title')?.textContent || ''`),
});
await screenshot('04-data.png');

// 开启写模式（会检查 /api/health allowWrite）
await evaluate(`document.getElementById('writeToggle').click()`);
await waitFor(`document.getElementById('statusWrite').textContent.includes('开')`, 15000, '写模式开启');
report.steps.push({
  step: 'write-mode',
  status: await evaluate(`document.getElementById('statusWrite').textContent`),
  healthChecked: await evaluate(`document.getElementById('toast').textContent`),
});

// DDL 编辑并执行
const ordersForDdl = await rectOf(`[...document.querySelectorAll('.tree-node[data-context="table"]')].find((node) => node.textContent.includes('orders'))`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ordersForDdl.x, y: ordersForDdl.y, button: 'right', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ordersForDdl.x, y: ordersForDdl.y, button: 'right', clickCount: 1 });
await waitFor(`!document.getElementById('contextMenu').classList.contains('hidden')`, 5000, '表右键菜单');
await clickMenu('打开 DDL');
await waitFor(`!!document.querySelector('.ddl-editor')`, 15000, 'DDL 编辑器');
await evaluate(`(() => {
  const editor = document.querySelector('.ddl-editor');
  editor.value = 'ALTER TABLE "public"."orders" ADD COLUMN platform_note VARCHAR(20)';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await clickButton(`document`, '执行修改');
await waitFor(`document.getElementById('toast').textContent.includes('DDL 执行成功')`, 25000, 'DDL 成功 toast');
await waitFor(`document.querySelector('.ddl-editor')?.value.includes('platform_note')`, 25000, 'DDL 刷新');
report.steps.push({
  step: 'ddl',
  toast: await evaluate(`document.getElementById('toast').textContent`),
  hasColumn: await evaluate(`document.querySelector('.ddl-editor').value.includes('platform_note')`),
});
await screenshot('05-ddl.png');

// 回到数据标签，行内编辑 status
await evaluate(`document.querySelectorAll('.ide-tab')[0].click()`);
await waitFor(`document.querySelector('.grid-table tbody tr')`, 15000, '数据网格2');
await sleep(500);
const cellPoint = await evaluate(`(() => {
  const headers = [...document.querySelectorAll('.grid-table thead th')].map((th) => th.textContent.trim());
  const column = headers.findIndex((text) => text.startsWith('status'));
  const row = document.querySelector('.grid-table tbody tr');
  const rect = row.children[column].getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`);
await dblclick(cellPoint);
await waitFor(`!!document.querySelector('.cell-editor')`, 5000, '单元格编辑器');
await evaluate(`(() => {
  const input = document.querySelector('.cell-editor');
  input.value = 'PAID';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
await waitFor(`document.getElementById('toast').textContent.includes('已更新 1 行')`, 20000, '行更新 toast');
await sleep(1000);
report.steps.push({
  step: 'row-edit',
  toast: await evaluate(`document.getElementById('toast').textContent`),
  statuses: await evaluate(`[...document.querySelectorAll('.grid-table tbody tr')].slice(0, 3).map((tr) => tr.textContent.slice(0, 80))`),
});
await screenshot('06-cell-edit.png');

// 增量页签
const ordersForInc = await rectOf(`[...document.querySelectorAll('.tree-node[data-context="table"]')].find((node) => node.textContent.includes('orders'))`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ordersForInc.x, y: ordersForInc.y, button: 'right', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ordersForInc.x, y: ordersForInc.y, button: 'right', clickCount: 1 });
await waitFor(`!document.getElementById('contextMenu').classList.contains('hidden')`, 5000, '表右键菜单2');
await clickMenu('增量读取');
await waitFor(`!!document.querySelector('.incremental-controls')`, 15000, '增量页签');
await waitFor(`(() => {
  const selects = document.querySelectorAll('.incremental-controls select');
  const read = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '读取');
  return selects.length > 1 && selects[1].options.length > 1 && read && !read.disabled;
})()`, 20000, '增量字段加载');
await evaluate(`(() => {
  const limit = document.querySelector('.incremental-controls input[type="number"]');
  limit.value = '2';
  limit.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await clickButton(`document`, '读取');
await waitFor(`(() => {
  const meta = document.querySelector('.incremental-meta');
  return meta && (meta.textContent.includes('nextCursor') || !!document.querySelector('.error-panel'));
})()`, 25000, '增量结果');
await sleep(600);
report.steps.push({
  step: 'incremental',
  meta: await evaluate(`document.querySelector('.incremental-meta')?.textContent || ''`),
  rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`),
  watermarkOptions: await evaluate(`[...document.querySelectorAll('.incremental-controls select')[1].options].map((option) => option.value)`),
});
await screenshot('07-incremental.png');

// 设置页：通用 / 增量
await evaluate(`document.getElementById('settingsBtn').click()`);
await waitFor(`!document.getElementById('settingsModal').classList.contains('hidden')`, 5000, '设置弹窗');
await sleep(300);
report.steps.push({
  step: 'settings-general',
  tabs: await evaluate(`[...document.querySelectorAll('.settings-tab')].map((node) => node.textContent.trim())`),
  hasAgent: await evaluate(`!!document.getElementById('settingsAgentBase')`),
});
await screenshot('08-settings-general.png');
await evaluate(`[...document.querySelectorAll('.settings-tab')].find((node) => node.textContent.includes('增量')).click()`);
await sleep(300);
await screenshot('09-settings-incremental.png');
report.steps.push({ step: 'settings-incremental', hasLimit: await evaluate(`!!document.getElementById('settingsIncrementalLimit')`) });

// 配置 Agent 地址后 AI 入口显示
await evaluate(`[...document.querySelectorAll('.settings-tab')].find((node) => node.textContent.includes('通用')).click()`);
await sleep(200);
await evaluate(`(() => {
  const input = document.getElementById('settingsAgentBase');
  input.value = 'http://127.0.0.1:18100';
  return true;
})()`);
await clickButton(`document.getElementById('settingsModal')`, '保存设置');
await sleep(400);
await screenshot('10-ai-enabled.png');
report.steps.push({
  step: 'agent-address',
  aiVisible: await evaluate(`!document.getElementById('aiToggle').classList.contains('hidden')`),
  toast: await evaluate(`document.getElementById('toast').textContent`),
});
await evaluate(`document.getElementById('settingsModalClose').click()`);
await sleep(300);

// 删除 H2 测试数据源（详情弹窗 + 删除）
await evaluate(`(() => {
  const row = [...document.querySelectorAll('.conn-row')].find((node) => node.textContent.includes('H2 平台测试'));
  row?.scrollIntoView({ block: 'center' });
  return true;
})()`);
const h2Row = await rectOf(`(() => {
  const row = [...document.querySelectorAll('.conn-row')].find((node) => node.textContent.includes('H2 平台测试'));
  return row;
})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h2Row.x, y: h2Row.y, button: 'right', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h2Row.x, y: h2Row.y, button: 'right', clickCount: 1 });
await waitFor(`!document.getElementById('contextMenu').classList.contains('hidden')`, 5000, '数据源右键菜单');
await clickMenu('编辑数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, '数据源编辑弹窗');
await clickButton(`document.getElementById('connectionModal')`, '测试连接');
await waitFor(`document.getElementById('connTestResult').textContent.includes('连接成功')`, 15000, '数据源测试连接');
report.steps.push({ step: 'datasource-test', result: await evaluate(`document.getElementById('connTestResult').textContent`) });
await screenshot('11-datasource-edit.png');
await clickButton(`document.getElementById('connectionModal')`, '删除数据源');
await waitFor(`document.getElementById('toast').textContent.includes('数据源已删除')`, 15000, '删除数据源 toast');
await sleep(600);
report.steps.push({
  step: 'datasource-delete',
  toast: await evaluate(`document.getElementById('toast').textContent`),
  treeNames: await evaluate(`[...document.querySelectorAll('.conn-row .tree-label')].map((node) => node.textContent.trim())`),
});
await screenshot('12-datasource-delete.png');

report.consoleErrors = consoleErrors;
report.pageExceptions = pageExceptions;
report.unhandled = await evaluate(`window.__unhandled || []`);
report.dialogs = dialogs;
fs.writeFileSync(OUT_DIR + 'report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
socket.close();

