'use strict';

/**
 * SQL 控制台标签：多标签、历史（localStorage 最近 20 条）、Ctrl+Enter/选区执行、Explain。
 */

const HISTORY_LIMIT = 20;

/* ------------------------------ 历史 ------------------------------ */

function readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
  } catch {
    // localStorage 不可用（隐私模式）时忽略
  }
}

function pushHistory(entry) {
  const items = readHistory().filter((item) => item.sql !== entry.sql || item.connectionId !== entry.connectionId);
  items.unshift(entry);
  writeHistory(items);
}

/* ------------------------------ 控制台渲染 ------------------------------ */

function consoleConnection(tab) {
  return tab.connectionId || state.activeConnectionId;
}

function renderConsoleTab(tab, host) {
  const panel = el('div', 'console-panel');
  const connection = connectionById(consoleConnection(tab));

  const toolbar = el('div', 'console-toolbar');
  const runButton = el('button', 'btn small primary', '执行');
  runButton.title = 'Ctrl+Enter（有选区时只执行选区）';
  runButton.addEventListener('click', () => runConsole(tab));
  const explainButton = el('button', 'btn small', '解释');
  explainButton.title = '查看执行计划';
  explainButton.addEventListener('click', () => runConsole(tab, { explain: true }));
  const historyButton = el('button', 'btn small', '历史');
  historyButton.title = '最近 20 条执行记录';
  historyButton.addEventListener('click', () => {
    tab.state.historyOpen = !tab.state.historyOpen;
    renderActiveTab();
  });
  toolbar.append(runButton, explainButton, historyButton);

  const connSelect = document.createElement('select');
  connSelect.className = 'console-connection';
  connSelect.title = '执行目标数据源';
  for (const item of state.connections) {
    const option = el('option', null, item.name);
    option.value = item.id;
    if (item.id === consoleConnection(tab)) option.selected = true;
    connSelect.appendChild(option);
  }
  connSelect.addEventListener('change', () => {
    tab.connectionId = connSelect.value;
    tab.schema = '';
    state.activeConnectionId = tab.connectionId;
    renderActiveTab();
    renderTree();
  });
  toolbar.appendChild(connSelect);

  if (tab.schema) {
    const target = el('span', 'console-target', 'schema: ' + tab.schema);
    toolbar.appendChild(target);
  }
  toolbar.appendChild(el('span', 'hint', 'Ctrl+Enter 执行；选中片段只执行选区'));
  panel.appendChild(toolbar);

  const editorWrap = el('div', 'console-editor-wrap');
  const editor = document.createElement('textarea');
  editor.className = 'console-editor';
  editor.spellcheck = false;
  editor.placeholder = '输入单条 SQL，例如：SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status ORDER BY cnt DESC';
  editor.value = tab.state.sql || '';
  editor.addEventListener('input', () => {
    tab.state.sql = editor.value;
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      runConsole(tab);
    }
  });
  editorWrap.appendChild(editor);
  if (tab.state.historyOpen) editorWrap.appendChild(renderHistoryMenu(tab, editor));
  panel.appendChild(editorWrap);

  const meta = el('div', 'console-meta');
  meta.textContent = consoleMetaText(tab);
  panel.appendChild(meta);

  const resultHost = el('div', 'console-result');
  renderConsoleResult(tab, resultHost);
  panel.appendChild(resultHost);

  host.appendChild(panel);
  editor.focus();
}

function consoleMetaText(tab) {
  const result = tab.state.result;
  if (tab.state.error) return '执行失败';
  if (tab.state.execInfo) return tab.state.execInfo;
  if (tab.state.planText) return '执行计划 · ' + (tab.state.planElapsed ? fmtMs(tab.state.planElapsed) : '');
  if (!result) return '未执行';
  return '行数 ' + result.rowCount + ' · 耗时 ' + fmtMs(result.elapsedMs)
    + (result.truncated ? ' · 结果已按 maxRows 截断' : '');
}

function renderHistoryMenu(tab, editor) {
  const menu = el('div', 'history-menu');
  const items = readHistory();
  menu.appendChild(el('div', 'history-title', '最近执行（' + items.length + '/' + HISTORY_LIMIT + '）'));
  if (!items.length) menu.appendChild(el('div', 'detail-empty', '还没有执行记录'));
  for (const item of items) {
    const button = el('button', 'history-item');
    button.type = 'button';
    button.title = item.sql;
    button.appendChild(el('span', 'history-sql', item.sql.replace(/\s+/g, ' ')));
    const meta = [item.ok ? '成功' : '失败', fmtMs(item.elapsedMs)];
    button.appendChild(el('span', 'history-meta', meta.join(' · ')));
    button.addEventListener('click', () => {
      tab.state.sql = item.sql;
      tab.state.historyOpen = false;
      if (item.connectionId && connectionById(item.connectionId)) {
        tab.connectionId = item.connectionId;
      }
      renderActiveTab();
      const nextEditor = document.querySelector('.console-editor');
      if (nextEditor) nextEditor.focus();
    });
    menu.appendChild(button);
  }
  return menu;
}

function renderConsoleResult(tab, host) {
  clear(host);
  if (tab.state.executing) {
    host.appendChild(el('div', 'grid-loading', tab.state.planText ? '获取执行计划…' : '执行中…'));
    return;
  }
  if (tab.state.error) {
    host.appendChild(errorPanelNode(tab.state.error, tab.state.errorHint));
    return;
  }
  if (tab.state.planText) {
    const wrap = el('div', 'grid-wrap');
    const pre = document.createElement('pre');
    pre.className = 'ddl-code';
    pre.textContent = tab.state.planText;
    wrap.appendChild(pre);
    host.appendChild(wrap);
    return;
  }
  if (tab.state.execInfo) {
    host.appendChild(el('div', 'grid-loading', tab.state.execInfo));
    return;
  }
  if (tab.state.result) {
    const wrap = el('div', 'grid-wrap');
    renderResultGrid(wrap, tab.state.result, {
      sortable: false,
      fileName: 'query-result',
      emptyText: '执行成功，但没有数据行',
    });
    host.appendChild(wrap);
    return;
  }
  host.appendChild(el('div', 'empty', 'Ctrl+Enter 执行 SQL'));
}

/* ------------------------------ 执行 ------------------------------ */

function selectedConsoleSql() {
  const editor = document.querySelector('.console-editor');
  if (!editor) return '';
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  if (start !== end) {
    const selected = editor.value.slice(start, end).trim();
    if (selected) return selected;
  }
  return editor.value.trim();
}

function runActiveConsole(options = {}) {
  const tab = activeTab();
  if (!tab) {
    toast('请先新建查询（Ctrl+T）', 'info');
    return;
  }
  if (tab.kind !== 'query') {
    toast('当前标签不是 SQL 控制台，按 Ctrl+T 新建查询', 'info');
    return;
  }
  runConsole(tab, options);
}

async function runConsole(tab, options = {}) {
  if (tab.state.executing) return;
  const connectionId = consoleConnection(tab);
  if (!connectionId) {
    toast('请先选择数据源', 'error');
    return;
  }
  const sql = selectedConsoleSql() || (tab.state.sql || '').trim();
  if (!sql) {
    tab.state.error = '请输入 SQL 语句';
    renderActiveTab();
    return;
  }
  tab.state.sql = sql;
  tab.state.error = '';
  tab.state.errorHint = '';
  tab.state.result = null;
  tab.state.execInfo = '';
  tab.state.planText = '';
  tab.state.executing = true;
  renderActiveTab();

  const started = Date.now();
  try {
    if (options.explain) {
      await executeExplain(tab, sql, connectionId);
      pushHistory({ sql, connectionId, ok: true, elapsedMs: Date.now() - started, at: Date.now() });
    } else if (isReadOnlySql(sql)) {
      const data = await pluginPost('query', {
        connectionId,
        schema: tab.schema || '',
        sql,
        maxRows: state.settings.maxRows || 500,
      });
      tab.state.result = normalizeResult(data);
      tab.state.execInfo = '';
      pushHistory({ sql, connectionId, ok: true, elapsedMs: tab.state.result.elapsedMs || (Date.now() - started), at: Date.now() });
    } else {
      await executeWrite(tab, sql, connectionId);
      pushHistory({ sql, connectionId, ok: true, elapsedMs: Date.now() - started, at: Date.now() });
    }
  } catch (error) {
    tab.state.error = error.message;
    tab.state.errorHint = passwordAuthGuidance(error);
    pushHistory({ sql, connectionId, ok: false, elapsedMs: Date.now() - started, at: Date.now() });
  } finally {
    tab.state.executing = false;
    if (state.activeTabId === tab.id) renderActiveTab();
    if (state.activeTabId === tab.id) renderStatusForTab(tab);
  }
}

async function executeWrite(tab, sql, connectionId) {
  if (!state.writeMode) {
    throw new Error('检测到写/DDL 语句（首关键字 ' + (firstKeyword(sql) || '?') + '）：请先开启顶部「写模式」。'
      + '即使开启，后端仍要求插件配置 allowWrite=true 且请求带 confirmed=true。');
  }
  const confirmed = window.confirm('即将执行写操作（' + firstKeyword(sql) + '）：\n\n'
    + clip(sql, 800) + '\n\n确认执行？');
  if (!confirmed) {
    throw new Error('已取消执行');
  }
  const data = await pluginPost('execute', {
    connectionId,
    schema: tab.schema || '',
    sql,
    confirmed: true,
  });
  tab.state.execInfo = '执行成功：影响 ' + data.affectedRows + ' 行（' + fmtMs(data.elapsedMs) + '）';
}

function normalizeExplain(data) {
  if (!data) return { text: '' };
  // 契约：H2 用 text 文本渲染；MySQL 用 plan 表格（列表）。text 优先，避免表格吞掉可读计划。
  if (typeof data.text === 'string' && data.text.trim()) return { text: data.text };
  if (data.columns && data.rows) return { result: normalizeResult(data) };
  if (Array.isArray(data.plan)) {
    return { text: data.plan.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n') };
  }
  if (typeof data.plan === 'string') return { text: data.plan };
  return { text: JSON.stringify(data, null, 2) };
}

async function executeExplain(tab, sql, connectionId) {
  const started = Date.now();
  const data = await pluginPostOptional('explain', {
    connectionId,
    schema: tab.schema || '',
    sql,
  }, 'explain');
  if (data) {
    const normalized = normalizeExplain(data);
    if (normalized.result) {
      tab.state.planText = '';
      tab.state.result = normalized.result;
    } else {
      tab.state.planText = normalized.text || '（后端未返回执行计划文本）';
    }
    tab.state.planElapsed = Date.now() - started;
    return;
  }
  // 旧后端降级：EXPLAIN <sql> 走只读 query
  const planSql = firstKeyword(sql) === 'EXPLAIN' ? sql : 'EXPLAIN ' + sql;
  const result = await pluginPost('query', {
    connectionId,
    schema: tab.schema || '',
    sql: planSql,
    maxRows: 200,
  });
  tab.state.result = normalizeResult(result);
  tab.state.planText = '';
}

/* ------------------------------ 工具栏入口 ------------------------------ */

function explainActiveConsole() {
  runActiveConsole({ explain: true });
}

