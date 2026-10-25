// 封板验收：db-platform Web 全链路（真实 db-service 18090 + BFF 18091）
// 覆盖：初始加载 / H2+MySQL 注册 / 密码保存与清除 / 树/搜索 / 数据/DDL/查询/解释 /
//       写模式 / 行编辑 / 增量 / 标签管理 / 三栏拖拽 / 设置 / 错误态 / 删除数据源
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEBUG_PORT = Number(process.argv[2] || 9297);
const APP_PORT = process.argv[3] || '18091';
const APP = 'http://127.0.0.1:' + APP_PORT;
const OUT = fileURLToPath(new URL('../verify-ui/', import.meta.url));
const PASSWORD = process.env.DBM_TEST_PASSWORD || '';
const MYSQL = { host: '106.54.3.66', port: '13306', database: 'ai_ssh', user: 'root' };
const H2_URL = 'jdbc:h2:mem:finalqa_' + Date.now() + ';DB_CLOSE_DELAY=-1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { steps: [], consoleErrors: [], pageExceptions: [], dialogs: [], unhandled: [] };

async function api(path, options) {
  const response = await fetch(APP + path, options);
  return response.json();
}


async function listDatasources() {
  for (let i = 0; i < 10; i++) {
    try {
      const result = await api('/api/datasources');
      if (result.data && Array.isArray(result.data.datasources)) return result.data.datasources;
    } catch { /* 重试 */ }
    await sleep(400);
  }
  return [];
}

async function cleanupFinalqa() {
  const list = await api('/api/datasources');
  const items = (list.data && list.data.datasources) || [];
  for (const item of items) {
    if (!/^finalqa-/.test(item.id) && !/^finalqa-/.test(item.name)) continue;
    await api('/api/datasources/' + encodeURIComponent(item.id), { method: 'DELETE' });
    report.steps.push({ step: 'pre-cleanup', deleted: item.id });
  }
}

async function findTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:' + APP_PORT));
      if (page) return page;
    } catch { /* Edge 未就绪 */ }
    await sleep(300);
  }
  throw new Error('找不到 Edge 页面 target');
}

await cleanupFinalqa();
const target = await findTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
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
    if (!text.includes('chrome-extension://') && !text.includes('Untrusted event')) report.consoleErrors.push(text);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params.exceptionDetails;
    const text = detail.text + ' ' + (detail.exception?.description || '');
    const url = detail.url || detail.stackTrace?.callFrames?.[0]?.url || '';
    if (!text.includes('chrome-extension://') && !url.includes('chrome-extension://')) {
      report.pageExceptions.push({ text, url });
    }
  }
  if (message.method === 'Page.javascriptDialogOpening') {
    report.dialogs.push({ type: message.params.type, message: message.params.message.slice(0, 300) });
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  }
};
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error('eval 失败：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  }
  return result.result?.value;
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + name, Buffer.from(result.data, 'base64'));
}

async function waitFor(expression, timeoutMs = 20000, label = expression) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await evaluate(expression)) return true; } catch { /* 页面刷新/导航 */ }
    await sleep(200);
  }
  throw new Error('等待超时：' + label + ' :: ' + expression.slice(0, 160));
}

async function rect(expression) {
  return evaluate(`(() => { const node = ${expression}; if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 140), y: r.top + r.height / 2 }; })()`);
}

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
}

async function clickRect(point) {
  if (!point) throw new Error('元素不可见');
  await mouse('mousePressed', point.x, point.y);
  await mouse('mouseReleased', point.x, point.y);
}

async function dblclickRect(point) {
  await mouse('mousePressed', point.x, point.y, { clickCount: 1 });
  await mouse('mouseReleased', point.x, point.y, { clickCount: 1 });
  await mouse('mousePressed', point.x, point.y, { clickCount: 2 });
  await mouse('mouseReleased', point.x, point.y, { clickCount: 2 });
}

async function rightClick(point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', clickCount: 1 });
}

async function clickButton(scope, text) {
  const ok = await evaluate(`(() => {
    const root = (${scope}) || document;
    const node = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled);
    if (!node) return false; node.click(); return true;
  })()`);
  if (!ok) throw new Error('找不到按钮：' + text);
}

async function clickMenu(text) {
  const ok = await evaluate(`(() => {
    const node = [...document.querySelectorAll('#contextMenu .menu-item')].find((b) => b.textContent.includes(${JSON.stringify(text)}));
    if (!node) return false; node.click(); return true;
  })()`);
  if (!ok) throw new Error('找不到菜单项：' + text);
}

async function setValue(selector, value, eventName = 'input') {
  await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
    return true;
  })()`);
}

async function setChecked(selector, checked) {
  const ok = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.checked = ${checked ? 'true' : 'false'};
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error('找不到复选框：' + selector);
}

async function toastContains(text, timeoutMs = 30000) {
  await waitFor(`document.getElementById('toast').textContent.includes(${JSON.stringify(text)})`, timeoutMs, 'toast: ' + text);
  return evaluate(`document.getElementById('toast').textContent`);
}

async function connRow(name) {
  return rect(`[...document.querySelectorAll('.conn-row')].find((n) => n.textContent.includes(${JSON.stringify(name)}))`);
}

async function ensureConnExpanded(name) {
  const expanded = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.conn-row')].find((n) => n.textContent.includes(${JSON.stringify(name)}));
    return Boolean(row && row.querySelector('.tree-chevron.expanded'));
  })()`);
  if (!expanded) {
    await evaluate(`(() => { const row = [...document.querySelectorAll('.conn-row')].find((n) => n.textContent.includes(${JSON.stringify(name)})); row?.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(150);
    const point = await connRow(name);
    if (!point) throw new Error('找不到数据源行：' + name);
    await clickRect(point);
    await sleep(300);
  }
}

async function tableNode(name) {
  return rect(`[...document.querySelectorAll('.tree-node[data-context="table"]')].find((n) => n.textContent.toLowerCase().includes(${JSON.stringify(name.toLowerCase())}))`);
}

async function openConnMenu(name, item) {
  await evaluate(`(() => { const row = [...document.querySelectorAll('.conn-row')].find((n) => n.textContent.includes(${JSON.stringify(name)})); row?.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(150);
  const point = await connRow(name);
  if (!point) throw new Error('找不到数据源行：' + name);
  await rightClick(point);
  await waitFor(`!document.getElementById('contextMenu').classList.contains('hidden')`, 5000, '数据源菜单');
  await clickMenu(item);
}

async function openTableMenu(name, item) {
  await evaluate(`(() => { const node = [...document.querySelectorAll('.tree-node[data-context="table"]')].find((n) => n.textContent.toLowerCase().includes(${JSON.stringify(name.toLowerCase())})); node?.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(150);
  const point = await tableNode(name);
  if (!point) throw new Error('找不到表节点：' + name);
  await rightClick(point);
  await waitFor(`!document.getElementById('contextMenu').classList.contains('hidden')`, 5000, '表菜单');
  await clickMenu(item);
}

async function consoleConnectionTo(name) {
  const ok = await evaluate(`(() => {
    const select = document.querySelector('.console-connection');
    if (!select) return false;
    const option = [...select.options].find((o) => o.textContent.includes(${JSON.stringify(name)}));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error('控制台找不到数据源：' + name);
}

async function runSql(sql, expect = 'success') {
  await setValue('.console-editor', sql);
  await evaluate(`document.querySelector('.console-editor').focus()`);
  const before = await evaluate(`document.querySelector('.console-meta').textContent`);
  await clickButton(`document.querySelector('.console-toolbar')`, '执行');
  await waitFor(`document.querySelector('.console-meta').textContent !== ${JSON.stringify(before)}`, 30000, 'SQL 执行状态变化');
  await waitFor(`(() => {
    const result = document.querySelector('.console-result');
    if (!result) return false;
    const loading = result.querySelector('.grid-loading');
    if (loading) return /执行成功|执行失败|影响/.test(loading.textContent);
    return !!result.querySelector('.grid-table tbody tr, .error-panel, .ddl-code, .empty');
  })()`, 30000, 'SQL 执行完成');
  await sleep(300);
  const state = await evaluate(`(() => {
    const result = document.querySelector('.console-result');
    return {
      meta: document.querySelector('.console-meta').textContent,
      error: result.querySelector('.error-panel')?.textContent || '',
      rows: result.querySelectorAll('.grid-table tbody tr').length,
      plan: !!result.querySelector('.ddl-code'),
    };
  })()`);
  if (expect === 'success' && state.error) throw new Error('SQL 意外失败：' + state.error);
  if (expect === 'error' && !state.error) throw new Error('SQL 预期失败但成功：' + sql);
  return state;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(`(localStorage.clear(), sessionStorage.clear(), location.reload(), true)`);
await sleep(2000);
await waitFor(`!!document.querySelector('.conn-row')`, 20000, '初始数据源树');
await evaluate(`(() => {
  window.__unhandled = [];
  window.addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason && (e.reason.stack || e.reason.message || e.reason))));
  return true;
})()`);
report.steps.push({
  step: 'initial',
  datasources: await evaluate(`[...document.querySelectorAll('.conn-row .tree-label')].map((n) => n.textContent.trim())`),
  treeError: await evaluate(`document.querySelector('#tree .tree-error')?.textContent || ''`),
  writeMode: await evaluate(`document.getElementById('statusWrite').textContent`),
  aiHidden: await evaluate(`document.getElementById('aiToggle').classList.contains('hidden')`),
});
await screenshot('final-01-initial.png');

// 搜索（demo 已展开，不触发 MySQL 全库扫描）
await setValue('#treeSearch', 'orders');
await waitFor(`[...document.querySelectorAll('.tree-node[data-context="table"]')].some((n) => n.textContent.toLowerCase().includes('orders'))`, 10000, '搜索结果');
await screenshot('final-02-search.png');
report.steps.push({ step: 'search', matches: await evaluate(`document.querySelectorAll('.tree-node[data-context="table"]').length`) });
await setValue('#treeSearch', '');
await sleep(500);

// H2 内存数据源
await clickButton('document', '新建数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, '新建弹窗');
await setValue('#connType', 'custom', 'change');
await setValue('#connName', 'finalqa-h2');
await setValue('#connUrl', H2_URL);
await setValue('#connUser', 'sa');
await setChecked('#connSavePassword', false);
await screenshot('final-03-register-h2.png');
await clickButton("document.getElementById('connectionModal')", '保存');
await toastContains('数据源已保存');
await waitFor(`[...document.querySelectorAll('.conn-row')].some((n) => n.textContent.includes('finalqa-h2'))`, 10000, 'H2 树节点');
report.steps.push({ step: 'register-h2', dataSources: await evaluate(`[...document.querySelectorAll('.conn-row .tree-label')].map((n) => n.textContent.trim())`) });

// MySQL 真实数据源
try {
  if (!PASSWORD) throw new Error('未提供 DBM_TEST_PASSWORD，跳过 MySQL 注册');
  await clickButton('document', '新建数据源');
  await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, '新建 MySQL 弹窗');
  await setValue('#connType', 'mysql', 'change');
  await setValue('#connName', 'finalqa-mysql');
  await setValue('#connHost', MYSQL.host);
  await setValue('#connPort', MYSQL.port);
  await setValue('#connDatabase', MYSQL.database);
  await setValue('#connUser', MYSQL.user);
  await setValue('#connPassword', PASSWORD);
  await setChecked('#connSavePassword', true);
  await screenshot('final-04-register-mysql.png');
  await clickButton("document.getElementById('connectionModal')", '保存');
  await toastContains('数据源已保存', 60000);
  await waitFor(`[...document.querySelectorAll('.conn-row')].some((n) => n.textContent.includes('finalqa-mysql'))`, 15000, 'MySQL 树节点');
  report.steps.push({ step: 'register-mysql', dataSources: await evaluate(`[...document.querySelectorAll('.conn-row .tree-label')].map((n) => n.textContent.trim())`) });
} catch (error) {
  report.steps.push({ step: 'register-mysql', error: error.message });
  throw error;
}
await screenshot('final-05-tree-two-sources.png');

// MySQL 编辑：密码留空且保持勾选，不应清空密码
await openConnMenu('finalqa-mysql', '编辑数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, 'MySQL 编辑弹窗');
const editState = await evaluate(`({
  password: document.getElementById('connPassword').value,
  checked: document.getElementById('connSavePassword').checked,
  host: document.getElementById('connHost').value,
})`);
await clickButton("document.getElementById('connectionModal')", '测试连接');
await waitFor(`document.getElementById('connTestResult').textContent.includes('连接成功')`, 30000, 'MySQL 测试连接');
report.steps.push({ step: 'mysql-edit-blank-password', state: editState, test: await evaluate(`document.getElementById('connTestResult').textContent`) });
await screenshot('final-06-mysql-edit.png');
await clickButton("document.getElementById('connectionModal')", '保存');
await toastContains('数据源已保存', 60000);
await sleep(800);
let dataSources = await listDatasources();
const mysqlView = dataSources.find((d) => d.name === 'finalqa-mysql');
report.steps.push({ step: 'mysql-password-preserved', passwordSaved: mysqlView && mysqlView.passwordSaved });

// MySQL 未输入新密码、取消勾选：db-service 会保留已保存密码（不误清），但需给出说明确认
await openConnMenu('finalqa-mysql', '编辑数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, 'MySQL 编辑弹窗2');
await setChecked('#connSavePassword', false);
const dialogBeforeBlank = report.dialogs.length;
await clickButton("document.getElementById('connectionModal')", '保存');
await toastContains('数据源已保存', 60000);
await waitFor(`document.getElementById('connectionModal').classList.contains('hidden')`, 10000, '留空保存后关闭弹窗');
dataSources = await listDatasources();
report.steps.push({
  step: 'mysql-password-blank-unchecked',
  dialogsAdded: report.dialogs.length - dialogBeforeBlank,
  passwordSaved: (dataSources.find((d) => d.name === 'finalqa-mysql') || {}).passwordSaved,
});
await screenshot('final-07-password-kept.png');

// 输入新密码并取消勾选：确认后清除持久化密码，仅保留进程内存
await openConnMenu('finalqa-mysql', '编辑数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, 'MySQL 编辑弹窗3');
await setValue('#connPassword', PASSWORD);
await setChecked('#connSavePassword', false);
const dialogBeforeClear = report.dialogs.length;
await clickButton("document.getElementById('connectionModal')", '保存');
await toastContains('数据源已保存', 60000);
await waitFor(`document.getElementById('connectionModal').classList.contains('hidden')`, 10000, '清除密码保存后关闭弹窗');
dataSources = await listDatasources();
report.steps.push({
  step: 'mysql-password-clear-explicit',
  dialogsAdded: report.dialogs.length - dialogBeforeClear,
  passwordSaved: (dataSources.find((d) => d.name === 'finalqa-mysql') || {}).passwordSaved,
});
await screenshot('final-07b-password-cleared.png');

// 清除持久化后仍可在当前进程测试（内存密码）
await openConnMenu('finalqa-mysql', '编辑数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, 'MySQL 编辑弹窗3');
await clickButton("document.getElementById('connectionModal')", '测试连接');
await waitFor(`document.getElementById('connTestResult').textContent.includes('连接成功')`, 30000, '清除后内存密码测试');
report.steps.push({ step: 'mysql-memory-password', test: await evaluate(`document.getElementById('connTestResult').textContent`) });
await setValue('#connPassword', PASSWORD);
await setChecked('#connSavePassword', true);
await clickButton("document.getElementById('connectionModal')", '保存');
await toastContains('数据源已保存', 60000);
await sleep(800);
dataSources = await listDatasources();
report.steps.push({ step: 'mysql-password-restored', passwordSaved: (dataSources.find((d) => d.name === 'finalqa-mysql') || {}).passwordSaved });

// MySQL 树展开 / 表浏览 / DDL / 查询 / 解释
await ensureConnExpanded('finalqa-mysql');
await waitFor(`[...document.querySelectorAll('.tree-node[data-context="table"]')].some((n) => n.textContent.toLowerCase().includes('chat_message'))`, 60000, 'MySQL chat_message 表');
report.steps.push({ step: 'mysql-tree', tableNodes: await evaluate(`document.querySelectorAll('.tree-node[data-context="table"]').length`) });
const chatPoint = await tableNode('chat_message');
await clickRect(chatPoint);
await sleep(300);
await dblclickRect(chatPoint);
await waitFor(`document.querySelector('.grid-table tbody tr')`, 30000, 'MySQL 数据网格');
await sleep(500);
report.steps.push({
  step: 'mysql-data',
  rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`),
  meta: await evaluate(`document.querySelector('.object-toolbar')?.textContent || ''`),
  error: await evaluate(`document.querySelector('.error-panel')?.textContent || ''`),
});
await screenshot('final-08-mysql-data.png');

await openTableMenu('chat_message', '打开 DDL');
await waitFor(`!!document.querySelector('.ddl-editor, .ddl-code')`, 30000, 'MySQL DDL');
report.steps.push({ step: 'mysql-ddl', ddlLength: await evaluate(`(() => { const editor = document.querySelector('.ddl-editor'); if (editor) return editor.value.length; const code = document.querySelector('.ddl-code'); return code ? code.textContent.length : 0; })()`) });
await screenshot('final-09-mysql-ddl.png');

await clickButton('document', '新建查询');
await consoleConnectionTo('finalqa-mysql');
const queryState = await runSql('SELECT COUNT(*) AS cnt FROM chat_message');
report.steps.push({ step: 'mysql-query', ...queryState });
await screenshot('final-10-query.png');
await clickButton('document', '解释');
await waitFor(`(() => { const r = document.querySelector('.console-result'); return r && (!!r.querySelector('.ddl-code') || !!r.querySelector('.grid-table tbody tr') || !!r.querySelector('.error-panel')); })()`, 30000, 'MySQL EXPLAIN');
await sleep(500);
report.steps.push({
  step: 'mysql-explain',
  meta: await evaluate(`document.querySelector('.console-meta').textContent`),
  error: await evaluate(`document.querySelector('.console-result .error-panel')?.textContent || ''`),
});
await screenshot('final-11-explain.png');

// 设置：服务状态 / 增量；配置 Agent 后 AI 面板可显示
await clickButton('document', '设置');
await waitFor(`!document.getElementById('settingsModal').classList.contains('hidden')`, 5000, '设置弹窗');
await evaluate(`[...document.querySelectorAll('.settings-tab')].find((t) => t.textContent.includes('增量'))?.click()`);
await sleep(300);
await screenshot('final-12-settings.png');
await evaluate(`[...document.querySelectorAll('.settings-tab')].find((t) => t.textContent.includes('通用'))?.click()`);
await sleep(200);
await setValue('#settingsAgentBase', 'http://127.0.0.1:18100');
await clickButton("document.getElementById('settingsModal')", '保存设置');
await sleep(500);
await evaluate(`document.getElementById('settingsModalClose').click()`);
await waitFor(`!document.getElementById('aiToggle').classList.contains('hidden')`, 5000, 'AI 入口显示');
await evaluate(`document.getElementById('aiToggle').click()`);
await waitFor(`document.getElementById('aiPanel').classList.contains('open')`, 5000, 'AI 面板');
await sleep(500);
const aiResizer = await rect(`document.querySelector('[data-resizer="ai"]')`);
await mouse('mousePressed', aiResizer.x, aiResizer.y);
for (let x = aiResizer.x - 90; x <= aiResizer.x - 20; x += 20) {
  await mouse('mouseMoved', x, aiResizer.y);
}
await mouse('mouseReleased', aiResizer.x - 90, aiResizer.y);
await sleep(400);
report.steps.push({
  step: 'three-pane-resize',
  aiWidth: await evaluate(`Math.round(document.getElementById('aiPanel').getBoundingClientRect().width)`),
  stored: await evaluate(`localStorage.getItem('dbm.ui.aiWidth')`),
});
await screenshot('final-13-three-pane.png');

// 开启写模式（health allowWrite=true）
await evaluate(`document.getElementById('writeToggle').click()`);
await waitFor(`document.getElementById('statusWrite').textContent.includes('开')`, 20000, '写模式开启');
report.steps.push({ step: 'write-mode', status: await evaluate(`document.getElementById('statusWrite').textContent`) });

// H2：建表、数据浏览、单元格编辑、新增/删除行
await clickButton('document', '新建查询');
await consoleConnectionTo('finalqa-h2');
await runSql('CREATE TABLE qa_orders (id INT PRIMARY KEY, status VARCHAR(16), amount DECIMAL(10,2))');
await runSql("INSERT INTO qa_orders VALUES (1, 'NEW', 10.50), (2, 'PAID', 20.00), (3, 'NEW', 30.00)");
await runSql('CREATE TABLE qa_nopk (name VARCHAR(16))');
await runSql("INSERT INTO qa_nopk VALUES ('a')");
report.steps.push({ step: 'h2-seed', meta: await evaluate(`document.querySelector('.console-meta').textContent`) });

await openConnMenu('finalqa-h2', '刷新数据源');
await waitFor(`[...document.querySelectorAll('.tree-node[data-context="table"]')].some((n) => n.textContent.toLowerCase().includes('qa_orders'))`, 30000, 'H2 新表');
const qaOrdersPoint = await tableNode('qa_orders');
await clickRect(qaOrdersPoint);
await sleep(300);
await dblclickRect(qaOrdersPoint);
await waitFor(`document.querySelector('.grid-table tbody tr')`, 20000, 'H2 QA_ORDERS 网格');
await sleep(600);
report.steps.push({ step: 'h2-data', rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`) });
await screenshot('final-14-h2-data.png');

const cellPoint = await evaluate(`(() => {
  const headers = [...document.querySelectorAll('.grid-table thead th')].map((th) => th.textContent.trim());
  const column = headers.findIndex((text) => text.toLowerCase().startsWith('status'));
  const row = document.querySelector('.grid-table tbody tr');
  const rect = row.children[column].getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`);
await dblclickRect(cellPoint);
await waitFor(`!!document.querySelector('.cell-editor')`, 5000, '单元格编辑器');
await setValue('.cell-editor', 'PAID');
await evaluate(`(() => { const input = document.querySelector('.cell-editor'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
await toastContains('已更新 1 行', 30000);
report.steps.push({ step: 'h2-cell-edit', toast: await evaluate(`document.getElementById('toast').textContent`) });
await screenshot('final-15-cell-edit.png');

await clickButton("document.querySelector('.object-toolbar')", '新增行');
await waitFor(`!!document.querySelector('.row-form-card')`, 5000, '新增行弹窗');
await evaluate(`(() => {
  const card = document.querySelector('.row-form-card');
  const set = (label, value) => {
    const field = [...card.querySelectorAll('.field')].find((f) => f.textContent.trim().toLowerCase().startsWith(label.toLowerCase()));
    if (!field) return false;
    const input = field.querySelector('input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  set('id', '4'); set('status', 'NEW'); set('amount', '40.00');
  return true;
})()`);
await screenshot('final-16-insert-row.png');
await clickButton("document.querySelector('.row-form-card')", '插入新行');
await toastContains('已插入 1 行', 30000);
await waitFor(`document.querySelectorAll('.grid-table tbody tr').length >= 4`, 15000, '新增后 4 行');
report.steps.push({ step: 'h2-insert', rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`) });
await screenshot('final-17-row-inserted.png');

await evaluate(`document.querySelector('.grid-table tbody tr .rownum').click()`);
await clickButton("document.querySelector('.object-toolbar')", '删除行');
await toastContains('已删除 1 行', 30000);
await waitFor(`document.querySelectorAll('.grid-table tbody tr').length >= 3`, 15000, '删除后 3 行');
report.steps.push({ step: 'h2-delete', rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`) });
await screenshot('final-18-row-deleted.png');

await openConnMenu('finalqa-h2', '刷新数据源');
await waitFor(`[...document.querySelectorAll('.tree-node[data-context="table"]')].some((n) => n.textContent.toLowerCase().includes('qa_nopk'))`, 30000, 'qa_nopk 表');
const nopkPoint = await tableNode('qa_nopk');
await dblclickRect(nopkPoint);
await waitFor(`document.querySelector('.grid-table tbody tr')`, 20000, '无主键表数据');
await sleep(400);
const nopkState = await evaluate(`({
  meta: document.querySelector('.object-toolbar')?.textContent || '',
  error: document.querySelector('.error-panel')?.textContent || '',
  buttonsDisabled: [...document.querySelectorAll('.object-toolbar button')].filter((b) => b.textContent.includes('行')).every((b) => b.disabled),
})`);
report.steps.push({ step: 'h2-no-pk', ...nopkState });
await screenshot('final-19-no-pk.png');

// 增量页签：register + read + nextCursor 翻页
await openTableMenu('qa_orders', '增量读取');
await waitFor(`!!document.querySelector('.incremental-controls')`, 15000, '增量页签');
await waitFor(`(() => {
  const selects = document.querySelectorAll('.incremental-controls select');
  const read = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '读取');
  return selects.length > 1 && selects[1].options.length > 1 && read && !read.disabled;
})()`, 20000, '增量字段加载');
await evaluate(`(() => {
  const limit = document.querySelector('.incremental-controls input[type="number"]');
  limit.value = '2';
  limit.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await clickButton('document', '读取');
await waitFor(`(() => {
  const meta = document.querySelector('.incremental-meta');
  return meta && (meta.textContent.includes('行数') || !!document.querySelector('.error-panel'));
})()`, 30000, '增量结果');
await sleep(400);
report.steps.push({
  step: 'incremental',
  meta: await evaluate(`document.querySelector('.incremental-meta')?.textContent || ''`),
  rows: await evaluate(`document.querySelectorAll('.grid-table tbody tr').length`),
  error: await evaluate(`document.querySelector('.error-panel')?.textContent || ''`),
});
await screenshot('final-25-incremental.png');
const nextCursorButton = await evaluate(`!![...document.querySelectorAll('button')].find((b) => b.textContent.includes('用 nextCursor 继续'))`);
if (nextCursorButton) {
  const beforeMeta = await evaluate(`document.querySelector('.incremental-meta')?.textContent || ''`);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('用 nextCursor 继续')).click()`);
  await waitFor(`(() => {
    const meta = document.querySelector('.incremental-meta');
    return meta && meta.textContent !== ${JSON.stringify(beforeMeta)};
  })()`, 30000, '增量翻页');
  report.steps.push({ step: 'incremental-next', meta: await evaluate(`document.querySelector('.incremental-meta')?.textContent || ''`) });
  await screenshot('final-26-incremental-next.png');
}

// 标签管理菜单
await clickButton('document', '标签管理');
await waitFor(`!document.getElementById('contextMenu').classList.contains('hidden')`, 5000, '标签管理菜单');
await screenshot('final-27-tab-menu.png');
report.steps.push({ step: 'tab-menu', items: await evaluate(`[...document.querySelectorAll('#contextMenu .menu-item')].map((n) => n.textContent.trim())`) });
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(200);

// SQL 错误态
await clickButton('document', '新建查询');
await consoleConnectionTo('finalqa-h2');
const sqlError = await runSql('SELECT * FROM missing_finalqa_table', 'error');
report.steps.push({ step: 'sql-error', ...sqlError });
await screenshot('final-20-sql-error.png');

// 注册不可达 MySQL：应提示保存失败且不产生数据源
await clickButton('document', '新建数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, '不可达弹窗');
await setValue('#connType', 'mysql', 'change');
await setValue('#connName', 'finalqa-bad');
await setValue('#connHost', '127.0.0.1');
await setValue('#connPort', '1');
await setValue('#connDatabase', 'none');
await setValue('#connUser', 'root');
await setValue('#connPassword', 'bad');
await setChecked('#connSavePassword', false);
await clickButton("document.getElementById('connectionModal')", '保存');
await toastContains('保存失败', 30000);
report.steps.push({ step: 'connect-error', toast: await evaluate(`document.getElementById('toast').textContent`) });
await screenshot('final-21-connect-error.png');
await evaluate(`document.getElementById('connectionModal').classList.contains('hidden') || document.getElementById('connectionModalClose').click()`);

// 删除 MySQL 数据源时，已打开的 MySQL 标签应一起关闭
const beforeTabs = await evaluate(`[...document.querySelectorAll('.ide-tab-title')].map((n) => n.textContent.trim())`);
await openConnMenu('finalqa-mysql', '编辑数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, '删除 MySQL 弹窗');
await clickButton("document.getElementById('connectionModal')", '删除数据源');
await toastContains('数据源已删除', 30000);
await waitFor(`![...document.querySelectorAll('.conn-row')].some((n) => n.textContent.includes('finalqa-mysql'))`, 10000, 'MySQL 树节点消失');
const afterTabs = await evaluate(`[...document.querySelectorAll('.ide-tab-title')].map((n) => n.textContent.trim())`);
report.steps.push({ step: 'delete-mysql', beforeTabs, afterTabs, staleMysqlTab: afterTabs.some((t) => t.includes('chat_message')) });
await screenshot('final-22-delete-mysql.png');

// 删除 H2 数据源
await openConnMenu('finalqa-h2', '编辑数据源');
await waitFor(`!document.getElementById('connectionModal').classList.contains('hidden')`, 5000, '删除 H2 弹窗');
await screenshot('final-23-delete-h2.png');
await clickButton("document.getElementById('connectionModal')", '删除数据源');
await toastContains('数据源已删除', 30000);
await waitFor(`[...document.querySelectorAll('.conn-row')].every((n) => n.textContent.includes('内置演示库'))`, 10000, '仅剩 demo');
report.steps.push({ step: 'final-tree', dataSources: await evaluate(`[...document.querySelectorAll('.conn-row .tree-label')].map((n) => n.textContent.trim())`), tabs: await evaluate(`[...document.querySelectorAll('.ide-tab-title')].map((n) => n.textContent.trim())`) });
await screenshot('final-24-final-tree.png');

report.unhandled = await evaluate(`window.__unhandled || []`);
fs.writeFileSync(OUT + 'final-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  steps: report.steps,
  consoleErrors: report.consoleErrors,
  pageExceptions: report.pageExceptions,
  unhandled: report.unhandled,
  dialogs: report.dialogs.map((d) => d.message.slice(0, 80)),
}, null, 2));
socket.close();
await cleanupFinalqa();

