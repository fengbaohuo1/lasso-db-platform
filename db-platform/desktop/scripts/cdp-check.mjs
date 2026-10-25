/**
 * DB Platform 桌面壳验证：CDP 断言页面标题 / 数据源树 / 数据行 / 写模式，并记录控制台错误。
 *
 * 前置：桌面壳以 WebView2 CDP 端口启动（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>）。
 * 用法：node cdp-check.mjs <cdpPort>
 * 输出：一行 JSON（同时由 verify-window.ps1 落盘为 verify-cdp.json）。
 */

const port = Number(process.argv[2] || 9345);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const consoleErrors = [];
let recording = false;

async function fetchJson(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return response.json();
}

async function waitPageTarget() {
  const deadline = Date.now() + 30000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson('/json');
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          target.webSocketDebuggerUrl &&
          (target.url.includes('index.html') || target.url.startsWith('http://tauri.localhost')),
      );
      if (page) return page;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(500);
  }
  throw new Error(`未找到桌面页面目标：${lastError}`);
}

const target = await waitPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
});

let seq = 0;
function send(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), timeout);
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result && result.exceptionDetails) {
    throw new Error(`页面求值异常：${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
  }
  return result && result.result ? result.result.value : undefined;
}

ws.addEventListener('message', (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!recording) return;
  if (message.method === 'Log.entryAdded') {
    const entry = message.params && message.params.entry;
    if (entry && entry.level === 'error') {
      consoleErrors.push({ source: entry.source, text: entry.text, url: entry.url || '' });
    }
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params && message.params.exceptionDetails;
    consoleErrors.push({
      source: 'exception',
      text: (detail && detail.exception && detail.exception.description) || JSON.stringify(detail).slice(0, 400),
      url: (detail && detail.url) || '',
    });
  }
});

await send('Log.enable');
await send('Runtime.enable');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  if (!passed) throw new Error(`断言失败：${name} ${detail}`);
}

/** 等对象树首次加载完成（不再显示“正在加载”）。 */
const readyDeadline = Date.now() + 150000;
let treeText = '';
let ready = false;
while (Date.now() < readyDeadline) {
  treeText = (await evaluate("(document.getElementById('tree') || {}).innerText || ''")) || '';
  if (treeText.length > 0 && !treeText.includes('正在加载')) {
    ready = true;
    break;
  }
  await sleep(800);
}
if (!ready) throw new Error(`对象树未加载完成：${treeText.slice(0, 300)}`);
await sleep(1200);
recording = true;

// 1) 页面标题 / API base / 数据源树
const page = await evaluate(`JSON.stringify({
  title: document.title,
  href: window.location.href,
  apiBase: typeof window.__DBM_API_BASE__ === 'string' ? window.__DBM_API_BASE__ : null,
  tree: (document.getElementById('tree') || {}).innerText || '',
  statusApi: (document.getElementById('statusApi') || {}).textContent || ''
})`);
const pageInfo = JSON.parse(page);
check('页面标题含 DB Platform', /DB Platform/.test(pageInfo.title), pageInfo.title);
check('apiBase 已注入', typeof pageInfo.apiBase === 'string' && pageInfo.apiBase.startsWith('http://127.0.0.1:'), String(pageInfo.apiBase));
check('对象树含内置演示库', /演示库|demo/i.test(pageInfo.tree), pageInfo.tree.slice(0, 200));
check('对象树含 public', /public/i.test(pageInfo.tree), pageInfo.tree.slice(0, 200));

// 2) 展开 public → orders（页面启动时会异步 expandConnection，可能重渲染树；
//    这里在等待循环里按当前 DOM 状态补点，避免「点早了」被后续 renderTree 覆盖）
const treeDeadline = Date.now() + 30000;
let treeAfter = pageInfo.tree;
while (Date.now() < treeDeadline) {
  treeAfter = (await evaluate("(document.getElementById('tree') || {}).innerText || ''")) || '';
  if (/\borders\b/.test(treeAfter)) break;
  const clicked = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('#tree .tree-node'));
    const node = nodes.find((item) => (item.innerText || '').split('\\n')[0].trim() === 'public');
    if (!node) return 'no-node';
    const chevron = node.querySelector('.tree-chevron');
    if (chevron && chevron.classList.contains('expanded')) return 'already-expanded';
    node.click();
    return 'clicked';
  })()`);
  if (clicked === 'no-node') {
    // 连接行还没展开时先展开连接
    await evaluate(`(() => {
      const row = document.querySelector('#tree .tree-node[data-context="connection"]');
      if (row) row.click();
      return true;
    })()`);
  }
  await sleep(700);
}
check('对象树出现 orders 表', /\borders\b/.test(treeAfter), treeAfter.slice(0, 400));

// 3) 双击 orders 打开数据页签，断言 12 行（带重试：页面树可能异步重渲染）
const rowDeadline = Date.now() + 30000;
let rowCount = 0;
let opened = false;
while (Date.now() < rowDeadline) {
  rowCount = await evaluate(
    "document.querySelectorAll('#tabContent tbody tr[data-row-index]').length",
  );
  if (rowCount >= 12) break;
  opened = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('#tree .tree-node'));
    const node = nodes.find((item) => (item.innerText || '').split('\\n')[0].trim() === 'orders');
    if (!node) return false;
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(700);
}
check('双击 orders 打开数据页签', opened === true || rowCount >= 12, `rows=${rowCount}`);
check('orders 数据 12 行', rowCount === 12, `rows=${rowCount}`);

// 4) 写模式可开启（health allowWrite=true；window.confirm 用脚本放行）
const writeResult = await evaluate(`(async () => {
  try { window.confirm = () => true; } catch (error) { /* 忽略 */ }
  const toggle = document.getElementById('writeToggle');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const status = (document.getElementById('statusWrite') || {}).textContent || '';
  let allowWrite = null;
  try {
    const response = await fetch(window.__DBM_API_BASE__ + '/api/health');
    const payload = await response.json();
    allowWrite = payload && payload.data ? payload.data.allowWrite : null;
  } catch (error) {
    allowWrite = 'fetch-error:' + error.message;
  }
  return JSON.stringify({ status, allowWrite, checked: toggle.checked });
})()`);
const writeInfo = JSON.parse(writeResult);
check('写模式开关已打开', writeInfo.checked === true, JSON.stringify(writeInfo));
check('状态栏显示写模式：开', /写模式：开/.test(writeInfo.status), writeInfo.status);
check('health allowWrite=true', writeInfo.allowWrite === true, String(writeInfo.allowWrite));

const bodyText = await evaluate("(document.body ? document.body.innerText : '').slice(0, 2000)");
console.log(
  JSON.stringify(
    {
      ok: checks.every((item) => item.passed) && consoleErrors.length === 0,
      target: target.url,
      page: {
        title: pageInfo.title,
        href: pageInfo.href,
        apiBase: pageInfo.apiBase,
        tree: pageInfo.tree,
        bodyText,
      },
      checks,
      consoleErrors,
    },
    null,
    2,
  ),
);
ws.close();
