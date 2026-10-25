'use strict';

/**
 * 核心模块：API base 解析、请求封装、全局状态、通用工具、状态栏、上下文菜单、剪贴板、CSV。
 * 所有模块共享本文件里的全局常量/函数（经典脚本，defer 顺序加载）。
 */

/* ------------------------------ API base ------------------------------ */

function trimBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * API base 解析优先级：
 * 1. window.__DBM_API_BASE__（桌面端注入）
 * 2. ?apiBase= 查询参数
 * 3. tauri 协议/宿主 → http://127.0.0.1:18100（桌面内置 harness）
 * 4. 空串（同源，经 platform/server.mjs 的 BFF 反代）
 */
function resolveApiBase() {
  if (typeof window.__DBM_API_BASE__ === 'string') {
    return trimBase(window.__DBM_API_BASE__);
  }
  const params = new URLSearchParams(window.location.search);
  if (params.has('apiBase')) {
    return trimBase(params.get('apiBase'));
  }
  return '';
}

const API_BASE = resolveApiBase();
const API_ROOT = API_BASE + '/api';
const AGENT_BASE_KEY = 'dbp.agentBase.v1';
const AI_AGENT_ID = 'db-platform-assistant';
const HISTORY_KEY = 'dbp.queryHistory.v1';
const READ_ONLY_KEYWORDS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'SHOW', 'DESCRIBE', 'TABLE']);

/* ------------------------------ 全局状态 ------------------------------ */

const state = {
  connections: [],
  activeConnectionId: null,
  tree: {
    filter: '',
    searching: false,
    expanded: new Set(),
    cache: new Map(),
  },
  tabs: [],
  activeTabId: null,
  querySeq: 0,
  writeMode: false,
  writeModeSynced: false,
  modalConnectionId: null,
  settings: { maxRows: 200, incrementalLimit: 100, agentBase: '' },
  agentBase: '',
  caps: {},
  status: {
    connection: '未选择数据源',
    schema: '',
    rows: 0,
    elapsedMs: 0,
    truncated: false,
    kind: '',
  },
  selection: null,
  ai: { streaming: false, controller: null },
  /** 本次运行内“密码只在后端内存、未落盘”的连接（前端本地标记，刷新页面后由后端字段兜底）。 */
  passwordOnlyMemory: new Set(),
};

/* ------------------------------ DOM 工具 ------------------------------ */

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function debounce(fn, wait = 180) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ------------------------------ 文本工具 ------------------------------ */

function clip(text, max = 160) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function firstKeyword(sql) {
  let text = String(sql || '').replace(/^\s+/, '');
  const comment = /^(--[^\n]*\n|\/\*[\s\S]*?\*\/)/;
  while (comment.test(text)) {
    text = text.replace(comment, '').replace(/^\s+/, '');
  }
  const match = text.match(/^[A-Za-z]+/);
  return match ? match[0].toUpperCase() : '';
}

function isReadOnlySql(sql) {
  return READ_ONLY_KEYWORDS.has(firstKeyword(sql));
}

function fmtRows(n) {
  return n === null || n === undefined ? '-' : String(n);
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '-';
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
}

function sanitizeFileName(name) {
  return String(name || 'result').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
}

/* ------------------------------ 提示 / 剪贴板 / 下载 ------------------------------ */

let toastTimer = null;

function toast(message, type = 'info') {
  const box = $('toast');
  if (!box) return;
  box.textContent = message;
  box.className = 'toast ' + type;
  box.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), type === 'error' ? 6000 : 3000);
}

async function copyText(text, successMessage = '已复制') {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage, 'success');
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    toast(ok ? successMessage : '复制失败（浏览器不支持剪贴板）', ok ? 'success' : 'error');
    return ok;
  }
}

function downloadText(fileName, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------ CSV ------------------------------ */

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows || []) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return '\ufeff' + lines.join('\r\n');
}

function exportCsv(columns, rows, fileName) {
  if (!columns || !columns.length) {
    toast('当前没有可导出的结果', 'error');
    return;
  }
  downloadText(sanitizeFileName(fileName || 'result') + '.csv', toCsv(columns, rows), 'text/csv;charset=utf-8');
  toast('已导出 ' + (rows ? rows.length : 0) + ' 行 CSV', 'success');
}

/* ------------------------------ API 请求 ------------------------------ */

class ApiError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = info.code || '';
    this.status = info.status || 0;
    this.url = info.url || '';
  }
}

function buildUrl(base, path, query) {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return base + path + (suffix ? (path.includes('?') ? '&' : '?') + suffix : '');
}

async function requestJson(url, options = {}) {
  const method = options.method || 'GET';
  const init = { method, headers: {} };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new ApiError('无法连接服务：' + error.message + '（' + url + '）', { url });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`接口返回非 JSON（HTTP ${response.status}）：${url}`, { status: response.status, url });
  }
  if (!payload || payload.code !== '00000') {
    throw new ApiError((payload && payload.info) || `请求失败（HTTP ${response.status}）`, {
      code: payload && payload.code,
      status: response.status,
      url,
    });
  }
  return payload.data;
}

function isMissingEndpoint(error) {
  return error instanceof ApiError && /插件端点不存在|方法不允许|Not Found/i.test(error.message);
}

/* ------------------------------ 密码状态与错误引导 ------------------------------ */

const PASSWORD_MEMORY_NOTE = '密码未保存（本次运行有效）';
const PASSWORD_AUTH_GUIDANCE = '该连接需要密码，请编辑数据源重新输入，或勾选保存密码后重试';

/** 密码纠错文字由后端提供时按关键词兜底识别（旧后端无结构化 code 也可提示）。 */
const PASSWORD_ERROR_PATTERN = /Access denied|using password:\s*NO|需要密码|密码未(提供|保存|设置)|密码为空|password.*(required|missing)|authentication failed|login failed|鉴权失败|认证失败/i;

function isPasswordAuthError(error) {
  const message = String((error && error.message) || error || '');
  return PASSWORD_ERROR_PATTERN.test(message);
}

function passwordAuthGuidance(error) {
  return isPasswordAuthError(error) ? PASSWORD_AUTH_GUIDANCE : '';
}

function markPasswordOnlyInMemory(connectionId, onlyInMemory) {
  if (!connectionId) return;
  if (onlyInMemory) state.passwordOnlyMemory.add(connectionId);
  else state.passwordOnlyMemory.delete(connectionId);
}

/**
 * 判断连接卡片是否应提示“密码未保存（本次运行有效）”。
 * 优先读后端 list-connections 新增字段（passwordSaved/passwordInMemory 等），
 * 旧后端没有这些字段时使用保存连接时的前端本地标记。
 */
function connectionPasswordMemoryOnly(connection) {
  if (!connection || !connection.id) return false;
  if (state.passwordOnlyMemory.has(connection.id)) return true;
  const saved = connection.passwordSaved !== undefined ? connection.passwordSaved
    : (connection.passwordStored !== undefined ? connection.passwordStored : connection.savedPassword);
  const inMemory = connection.passwordInMemory === true
    || connection.passwordCached === true
    || connection.passwordOnlyInMemory === true;
  const hasPassword = connection.hasPassword === true || connection.passwordSet === true;
  if (inMemory) return true;
  return saved === false && hasPassword;
}

/** 错误区统一渲染：主错误 + 可选的密码缺失引导。 */
function errorPanelNode(message, guidance) {
  const panel = el('div', 'error-panel');
  panel.appendChild(el('div', 'error-text', String(message || '')));
  if (guidance) panel.appendChild(el('div', 'error-guidance', guidance));
  return panel;
}

/* db-service 端点适配：把旧 db-manager 插件端点名映射到 db-service REST 路径。 */

function encPath(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

function apiUrl(path, query) {
  return buildUrl(API_BASE + path, '', query);
}

function datasourceUrl(id, suffix, query) {
  const base = API_ROOT + '/datasources/' + encPath(id) + (suffix ? '/' + suffix : '');
  return buildUrl(base, '', query);
}

function pluginGetUrl(endpoint, query) {
  const params = { ...(query || {}) };
  const id = params.connectionId || params.datasourceId || '';
  delete params.connectionId;
  delete params.datasourceId;
  switch (endpoint) {
    case 'list-connections':
      return buildUrl(API_ROOT + '/datasources', '', params);
    case 'namespaces':
      return datasourceUrl(id, 'namespaces', params);
    case 'tables':
      return datasourceUrl(id, 'tables', params);
    case 'table-detail':
    case 'columns':
      return datasourceUrl(id, 'table-detail', params);
    case 'ddl':
      return datasourceUrl(id, 'ddl', params);
    case 'table-data':
      return datasourceUrl(id, 'data', params);
    default:
      return datasourceUrl(id, endpoint, params);
  }
}

async function pluginGet(endpoint, query) {
  return requestJson(pluginGetUrl(endpoint, query));
}

async function pluginPost(endpoint, body) {
  const payload = { ...(body || {}) };
  const id = payload.connectionId || payload.datasourceId || payload.id || '';
  delete payload.connectionId;
  delete payload.datasourceId;
  switch (endpoint) {
    case 'save-connection': {
      const target = payload.id ? datasourceUrl(payload.id, '') : API_ROOT + '/datasources';
      delete payload.id;
      return requestJson(target, { method: payload.__isUpdate || id ? 'PUT' : 'POST', body: payload });
    }
    case 'test-connection':
      if (!id) throw new Error('请先保存数据源，再测试连接');
      return requestJson(datasourceUrl(id, 'test'), { method: 'POST', body: payload });
    case 'delete-connection':
      return requestJson(datasourceUrl(id, ''), { method: 'DELETE' });
    case 'query':
      return requestJson(datasourceUrl(id, 'query'), { method: 'POST', body: payload });
    case 'execute':
      return requestJson(datasourceUrl(id, 'execute'), { method: 'POST', body: payload });
    case 'explain':
      return requestJson(datasourceUrl(id, 'explain'), { method: 'POST', body: payload });
    case 'row-insert':
      return requestJson(datasourceUrl(id, 'rows/insert'), { method: 'POST', body: payload });
    case 'row-update':
      return requestJson(datasourceUrl(id, 'rows/update'), { method: 'POST', body: payload });
    case 'row-delete':
      return requestJson(datasourceUrl(id, 'rows/delete'), { method: 'POST', body: payload });
    case 'disconnect':
      return requestJson(API_ROOT + '/agent/datasources/' + encPath(id) + '/disconnect', { method: 'POST', body: {} });
    default:
      if (!id) throw new Error('缺少数据源 id');
      return requestJson(datasourceUrl(id, endpoint), { method: 'POST', body: payload });
  }
}

/**
 * 可选端点调用：端点不存在（40000 且提示 Not Found/不存在）时返回 null 并记入能力缓存。
 * @returns {Promise<any|null>}
 */
async function pluginGetOptional(endpoint, query, capability) {
  if (capability && state.caps[capability] === 'missing') return null;
  try {
    const data = await pluginGet(endpoint, query);
    if (capability) state.caps[capability] = 'ok';
    return data;
  } catch (error) {
    if (isMissingEndpoint(error)) {
      if (capability) state.caps[capability] = 'missing';
      return null;
    }
    throw error;
  }
}

async function pluginPostOptional(endpoint, body, capability) {
  if (capability && state.caps[capability] === 'missing') return null;
  try {
    const data = await pluginPost(endpoint, body);
    if (capability) state.caps[capability] = 'ok';
    return data;
  } catch (error) {
    if (isMissingEndpoint(error)) {
      if (capability) state.caps[capability] = 'missing';
      return null;
    }
    throw error;
  }
}

/* Agent / 增量接口（db-service /api/agent/datasources） */

function agentDatasourceUrl(id, suffix, query) {
  const base = API_ROOT + '/agent/datasources/' + encPath(id) + (suffix ? '/' + suffix : '');
  return buildUrl(base, '', query);
}

async function agentGet(id, suffix, query) {
  return requestJson(agentDatasourceUrl(id, suffix, query));
}

async function agentPost(id, suffix, body) {
  return requestJson(agentDatasourceUrl(id, suffix), { method: 'POST', body: body || {} });
}

async function incrementalRegister(id, body) {
  return agentPost(id, 'incremental/register', body);
}

async function incrementalRead(id, table, since, limit) {
  return agentGet(id, 'incremental/read', { table, since: since || '', limit });
}

/* Agent 直连配置（可选；默认隐藏 AI 面板） */

function readAgentBase() {
  const value = String(state.agentBase || '').trim().replace(/\/+$/, '');
  return value;
}

function aiStreamUrl() {
  return readAgentBase() + '/api/agent/stream';
}

function agentConsoleUrl(path) {
  return readAgentBase() + '/api/harness/console' + path;
}

function setAgentBase(value) {
  state.agentBase = String(value || '').trim().replace(/\/+$/, '');
  try {
    if (state.agentBase) localStorage.setItem(AGENT_BASE_KEY, state.agentBase);
    else localStorage.removeItem(AGENT_BASE_KEY);
  } catch {
    // 隐私模式忽略
  }
  syncAiAvailability();
}

function syncAiAvailability() {
  const available = Boolean(readAgentBase());
  const toggle = $('aiToggle');
  if (toggle) toggle.classList.toggle('hidden', !available);
  if (!available) {
    const panel = $('aiPanel');
    if (panel) panel.classList.remove('open');
    const close = $('aiClose');
    if (close) close.classList.remove('hidden');
  }
}

/* 写模式同步：db-service 服务端 allowWrite 开关（端点不存在时降级为前端确认）。 */
async function syncWriteModeToServer(on) {
  try {
    const result = await requestJson(API_ROOT + '/settings/write-mode', {
      method: 'PUT',
      body: { allowWrite: Boolean(on) },
    });
    state.writeModeSynced = true;
    return result;
  } catch (error) {
    if (isMissingEndpoint(error)) {
      state.writeModeSynced = false;
      return null;
    }
    throw error;
  }
}

/* 宿主端点已不再使用（模型渠道在 db-platform 中移除）。 */

/* ------------------------------ 连接信息 ------------------------------ */

function connectionById(connectionId) {
  return state.connections.find((item) => item.id === connectionId) || null;
}

function activeConnection() {
  return connectionById(state.activeConnectionId);
}

function connectionEndpoint(connection) {
  if (!connection) return '';
  if (connection.type === 'mysql' && connection.host) {
    return connection.host + ':' + (connection.port || 3306) + '/' + (connection.database || '');
  }
  if (connection.jdbcUrl && connection.kind !== 'demo') {
    const match = /^jdbc:[^:]+:\/\/([^/:;?]+)(?::(\d+))?\/([^;?]+)/.exec(connection.jdbcUrl);
    if (match) return match[1] + (match[2] ? ':' + match[2] : '') + '/' + match[3];
  }
  return connection.database || '';
}

function connectionTypeLabel(connection) {
  if (!connection) return '';
  if (connection.typeLabel) return connection.typeLabel;
  if (connection.kind === 'demo') return '内置演示库（H2）';
  if (connection.type === 'mysql') return 'MySQL';
  if (connection.type === 'h2-demo') return 'H2 演示库';
  return '自定义 JDBC';
}

function connectionMeta(connection) {
  const parts = [];
  parts.push(connectionTypeLabel(connection));
  const endpoint = connectionEndpoint(connection);
  if (endpoint) parts.push(endpoint);
  if (connection.user) parts.push(connection.user);
  return parts.join(' · ');
}

function normalizeDatasource(raw) {
  const source = raw || {};
  const type = String(source.type || source.kind || 'custom').toLowerCase();
  const normalized = {
    ...source,
    id: String(source.id || source.datasourceId || source.connectionId || ''),
    name: String(source.name || source.displayName || source.datasourceId || source.id || '数据源'),
    type,
    kind: source.kind || (type === 'h2-demo' || type === 'demo' ? 'demo' : 'stored'),
    host: source.host || '',
    port: Number(source.port || 0),
    database: source.database || '',
    user: source.user || '',
    jdbcUrl: source.jdbcUrl || '',
    status: source.status || (source.ok === false ? 'error' : 'ok'),
    tableCount: source.tableCount !== undefined ? source.tableCount
      : (source.tables !== undefined && typeof source.tables === 'number' ? source.tables : null),
  };
  if (normalized.passwordSaved === undefined) {
    normalized.passwordSaved = source.passwordSaved !== undefined ? Boolean(source.passwordSaved)
      : (source.savePassword !== undefined ? Boolean(source.savePassword) : undefined);
  }
  if (normalized.passwordInMemory === undefined && source.passwordInMemory !== undefined) {
    normalized.passwordInMemory = Boolean(source.passwordInMemory);
  }
  return normalized;
}

function normalizeDatasourceList(data) {
  const list = Array.isArray(data) ? data
    : (data && Array.isArray(data.datasources) ? data.datasources
      : (data && Array.isArray(data.connections) ? data.connections
        : (data && Array.isArray(data.items) ? data.items : [])));
  return list.map(normalizeDatasource);
}

async function loadConnections() {
  const data = await pluginGet('list-connections');
  state.connections = normalizeDatasourceList(data);
  const known = new Set(state.connections.map((item) => item.id));
  for (const id of [...state.passwordOnlyMemory]) {
    if (!known.has(id)) state.passwordOnlyMemory.delete(id);
  }
  for (const connection of state.connections) {
    if (connection.passwordSaved === true || connection.passwordStored === true) {
      state.passwordOnlyMemory.delete(connection.id);
    }
  }
  if (!state.connections.some((item) => item.id === state.activeConnectionId)) {
    state.activeConnectionId = state.connections[0] ? state.connections[0].id : null;
  }
  return state.connections;
}

/* ------------------------------ 状态栏 ------------------------------ */

function updateStatusBar(partial) {
  Object.assign(state.status, partial || {});
  renderStatusBar();
}

function renderStatusBar() {
  const status = state.status;
  const conn = status.connection || '未选择数据源';
  $('statusConnection').textContent = conn;
  $('statusSchema').textContent = status.schema ? '· ' + status.schema : '';
  $('statusRows').textContent = '行数 ' + (status.rows === null || status.rows === undefined ? '-' : fmtRows(status.rows));
  $('statusElapsed').textContent = '耗时 ' + fmtMs(status.elapsedMs);
  $('statusTruncated').classList.toggle('hidden', !status.truncated);
  $('statusWrite').textContent = state.writeMode ? '写模式：开' : '写模式：关';
  $('statusWrite').className = 'status-item' + (state.writeMode ? ' warn' : '');
  $('statusApi').textContent = 'db-service: ' + (API_BASE || '同源（BFF）');
  $('statusApi').title = API_BASE || '同源，经 server.mjs 反代到 db-service';
}

/* ------------------------------ 上下文菜单 ------------------------------ */

let contextMenuItems = [];

function closeContextMenu() {
  const menu = $('contextMenu');
  if (!menu) return;
  menu.classList.add('hidden');
  clear(menu);
  contextMenuItems = [];
}

/**
 * @param {MouseEvent} event
 * @param {Array<{label:string, hint?:string, danger?:boolean, action:Function}|{sep:true}>} items
 */
function openContextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  const menu = $('contextMenu');
  clear(menu);
  contextMenuItems = items;
  for (const item of items) {
    if (item.sep) {
      menu.appendChild(el('div', 'menu-sep'));
      continue;
    }
    const button = el('button', 'menu-item' + (item.danger ? ' danger' : ''));
    button.type = 'button';
    button.appendChild(el('span', null, item.label));
    if (item.hint) button.appendChild(el('span', 'menu-hint', item.hint));
    button.addEventListener('click', () => {
      closeContextMenu();
      item.action();
    });
    menu.appendChild(button);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 6);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 6);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
}

/* 点击空白/滚动/ESC 关闭菜单 */
document.addEventListener('click', (event) => {
  const menu = $('contextMenu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(event.target)) closeContextMenu();
});
document.addEventListener('contextmenu', (event) => {
  const menu = $('contextMenu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(event.target)
    && !event.target.closest('[data-context]')) {
    closeContextMenu();
  }
}, true);
window.addEventListener('resize', closeContextMenu);
window.addEventListener('scroll', closeContextMenu, true);


