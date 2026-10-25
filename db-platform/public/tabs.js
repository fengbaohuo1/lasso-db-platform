'use strict';

/**
 * 标签页管理：对象标签（数据/DDL/列/索引）+ 多 SQL 控制台。控制台渲染委托给 console.js。
 */

const TAB_KIND_LABEL = {
  data: '数据',
  ddl: 'DDL',
  columns: '列',
  indexes: '索引',
  query: 'SQL',
  incremental: '增量',
};

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function findTab(tabId) {
  return state.tabs.find((tab) => tab.id === tabId) || null;
}

function qualifiedName(schema, table) {
  return schema ? schema + '.' + table : table;
}

function tabDisplayTitle(tab) {
  if (tab.kind === 'query') return tab.title;
  return qualifiedName(tab.schema, tab.table);
}

/* ------------------------------ 打开 / 激活 / 关闭 ------------------------------ */

function openObjectTab(kind, context) {
  const connectionId = context.connectionId || state.activeConnectionId;
  if (!connectionId) {
    toast('请先选择一个数据源', 'error');
    return;
  }
  const schema = context.schema || '';
  const table = context.table;
  if (!table) return;
  const tabId = kind + ':' + connectionId + ':' + schema + ':' + table;
  let tab = findTab(tabId);
  if (!tab) {
    tab = {
      id: tabId,
      kind,
      title: kind === 'data' ? '数据' : TAB_KIND_LABEL[kind],
      connectionId,
      schema,
      table,
      state: kind === 'data'
        ? { limit: 100, offset: 0, orderBy: null, desc: false, result: null, entry: null, selectedRowIndex: null, error: '', errorHint: '', loading: false }
        : { loading: false, error: '', errorHint: '', note: '', entry: null, ddl: '', originalDdl: '', executing: false, execInfo: '' },
    };
    state.tabs.push(tab);
  }
  state.activeConnectionId = connectionId;
  activateTab(tab.id);
}

function openQueryTab(options = {}) {
  const connectionId = options.connectionId || state.activeConnectionId;
  const seq = ++state.querySeq;
  const tab = {
    id: 'query:' + seq,
    kind: 'query',
    title: '查询 ' + seq,
    connectionId: connectionId || null,
    schema: options.schema || '',
    table: null,
    state: { sql: options.sql || '', result: null, error: '', errorHint: '', executing: false, lastSql: '' },
  };
  state.tabs.push(tab);
  if (connectionId) state.activeConnectionId = connectionId;
  activateTab(tab.id);
  return tab;
}

function openIncrementalTab(options = {}) {
  const connectionId = options.connectionId || state.activeConnectionId;
  if (!connectionId) {
    toast('请先选择一个数据源', 'error');
    return null;
  }
  const schema = options.schema || '';
  const table = options.table || '';
  const tabId = 'incremental:' + connectionId + ':' + schema + ':' + table;
  let tab = findTab(tabId);
  if (!tab) {
    tab = {
      id: tabId,
      kind: 'incremental',
      title: table || '增量读取',
      connectionId,
      schema,
      table,
      state: {
        table,
        schema,
        watermarkColumn: '',
        primaryKey: '',
        since: '',
        limit: state.settings.incrementalLimit || 100,
        result: null,
        nextCursor: null,
        hasMore: false,
        error: '',
        loading: false,
        readAt: '',
      },
    };
    state.tabs.push(tab);
  }
  state.activeConnectionId = connectionId;
  activateTab(tab.id);
  return tab;
}

function activateTab(tabId) {
  const tab = findTab(tabId);
  if (!tab) return;
  state.activeTabId = tabId;
  if (tab.connectionId) state.activeConnectionId = tab.connectionId;
  renderTabBar();
  renderActiveTab();
  renderTree();
}

function closeTab(tabId) {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  const wasActive = state.activeTabId === tabId;
  state.tabs.splice(index, 1);
  if (wasActive) {
    const next = state.tabs[index] || state.tabs[index - 1] || null;
    state.activeTabId = next ? next.id : null;
    if (next && next.connectionId) state.activeConnectionId = next.connectionId;
  }
  renderTabBar();
  renderActiveTab();
  renderTree();
}

function closeActiveTab() {
  if (!state.activeTabId) return;
  closeTab(state.activeTabId);
}

/* ------------------------------ 标签栏 ------------------------------ */

function renderTabBar() {
  const bar = $('tabBar');
  clear(bar);
  const menuButton = $('tabMenuBtn');
  if (menuButton) menuButton.disabled = !state.tabs.length;
  if (!state.tabs.length) {
    bar.appendChild(el('div', 'tab-empty', '未打开标签'));
    return;
  }
  for (const tab of state.tabs) {
    const button = el('button', 'ide-tab' + (tab.id === state.activeTabId ? ' active' : ''));
    button.type = 'button';
    button.title = tabDisplayTitle(tab);
    button.appendChild(el('span', 'ide-tab-title', tabDisplayTitle(tab)));
    button.appendChild(el('span', 'ide-tab-kind', TAB_KIND_LABEL[tab.kind] || tab.kind));
    const close = el('span', 'ide-tab-close', '×');
    close.title = '关闭标签';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });
    button.appendChild(close);
    button.addEventListener('click', () => activateTab(tab.id));
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(tab.id);
      }
    });
    bar.appendChild(button);
  }
  const activeButton = bar.querySelector('.ide-tab.active');
  if (activeButton) {
    const buttonRect = activeButton.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    if (buttonRect.left < barRect.left || buttonRect.right > barRect.right) {
      bar.scrollLeft += buttonRect.left - barRect.left - 8;
    }
  }
}

/* ------------------------------ 标签统一管理 ------------------------------ */

function closeAllTabs() {
  for (const tab of [...state.tabs]) closeTab(tab.id);
}

function closeOtherTabs() {
  const activeId = state.activeTabId;
  for (const tab of [...state.tabs]) {
    if (tab.id !== activeId) closeTab(tab.id);
  }
}

function closeTabsToRight() {
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (activeIndex < 0) return;
  for (const tab of state.tabs.slice(activeIndex + 1).reverse()) closeTab(tab.id);
}

function openTabMenu() {
  const button = $('tabMenuBtn');
  if (!button || !state.tabs.length) return;
  const rect = button.getBoundingClientRect();
  const items = [
    { label: '关闭全部标签', action: closeAllTabs },
    { label: '关闭其他标签', action: closeOtherTabs },
    { label: '关闭右侧标签', action: closeTabsToRight },
    { sep: true },
  ];
  state.tabs.forEach((tab, index) => {
    const current = tab.id === state.activeTabId;
    items.push({
      label: (current ? '● ' : '') + tabDisplayTitle(tab),
      hint: (TAB_KIND_LABEL[tab.kind] || tab.kind) + ' · ' + (index + 1),
      action: () => activateTab(tab.id),
    });
  });
  const fakeEvent = {
    clientX: rect.left,
    clientY: rect.bottom + 4,
    preventDefault() {},
    stopPropagation() {},
  };
  openContextMenu(fakeEvent, items);
}

function bindTabMenu() {
  const button = $('tabMenuBtn');
  if (!button) return;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.tabs.length) openTabMenu();
  });
}

/* ------------------------------ 内容区 ------------------------------ */

function welcomeNode() {
  const node = document.createElement('div');
  node.className = 'welcome';
  node.innerHTML = '<h2>数据库工作台</h2>'
    + '<p>从左侧展开数据源，双击表打开数据；也可以新建 SQL 控制台。</p>'
    + '<table class="shortcuts"><tbody>'
    + '<tr><td>Ctrl+T</td><td>新建查询</td></tr>'
    + '<tr><td>Ctrl+Enter</td><td>执行当前 SQL（有选区时只执行选区）</td></tr>'
    + '<tr><td>Ctrl+W</td><td>关闭当前标签</td></tr>'
    + '<tr><td>双击单元格</td><td>复制单元格内容</td></tr>'
    + '</tbody></table>';
  return node;
}

function renderActiveTab() {
  const host = $('tabContent');
  clear(host);
  const tab = activeTab();
  if (!tab) {
    state.selection = null;
    host.appendChild(welcomeNode());
    renderStatusForTab(null);
    return;
  }
  switch (tab.kind) {
    case 'data':
      renderDataTab(tab);
      break;
    case 'ddl':
      renderDdlTab(tab);
      break;
    case 'columns':
    case 'indexes':
      renderDetailTab(tab);
      break;
    case 'query':
      renderConsoleTab(tab, host);
      break;
    case 'incremental':
      renderIncrementalTab(tab);
      break;
    default:
      host.appendChild(welcomeNode());
  }
  renderStatusForTab(tab);
}

function renderStatusForTab(tab) {
  const connectionId = (tab && tab.connectionId) || state.activeConnectionId;
  const connection = connectionId ? connectionById(connectionId) : null;
  const status = {
    connection: connection ? connection.name : '未选择数据源',
    schema: tab ? tab.schema || '' : '',
    rows: null,
    elapsedMs: null,
    truncated: false,
  };
  if (tab && (tab.kind === 'data' || tab.kind === 'query') && tab.state.result) {
    status.rows = tab.state.result.rowCount;
    status.elapsedMs = tab.state.result.elapsedMs;
    status.truncated = tab.state.result.truncated;
  }
  updateStatusBar(status);
}

/* ------------------------------ 数据标签 ------------------------------ */

function renderDataTab(tab) {
  const host = $('tabContent');
  const panel = el('div', 'object-panel');
  const toolbar = el('div', 'object-toolbar');

  const title = el('span', 'object-title', qualifiedName(tab.schema, tab.table));
  if (tab.schema) title.appendChild(el('span', 'object-sub', '数据'));
  toolbar.appendChild(title);

  const meta = el('span', 'object-meta');
  toolbar.appendChild(meta);
  toolbar.appendChild(el('span', 'spacer'));

  const detail = tab.state.entry ? tab.state.entry.detail : null;
  const primaryKey = detail ? detail.primaryKey : [];
  const editable = primaryKey.length > 0;

  const insertButton = el('button', 'btn small', '新增行');
  insertButton.disabled = !editable;
  insertButton.title = editable ? '插入一行（需要写模式）' : '该表没有主键，禁用行编辑';
  insertButton.addEventListener('click', () => openInsertRowModal(tab));
  const deleteButton = el('button', 'btn small', '删除行');
  deleteButton.disabled = !editable;
  deleteButton.title = editable ? '删除选中的行（先点击行号选中）' : '该表没有主键，禁用行编辑';
  deleteButton.addEventListener('click', () => deleteSelectedRow(tab));
  toolbar.append(insertButton, deleteButton);

  const pager = el('div', 'pager');
  pager.appendChild(el('span', 'hint', '每页'));
  const limitSelect = document.createElement('select');
  for (const value of [50, 100, 200, 500, 0]) {
    const option = el('option', null, value === 0 ? '无限制' : String(value));
    option.value = String(value);
    if (value === tab.state.limit) option.selected = true;
    limitSelect.appendChild(option);
  }
  limitSelect.addEventListener('change', () => {
    tab.state.limit = Number(limitSelect.value) || 0;
    tab.state.offset = 0;
    loadDataTab(tab);
  });
  pager.appendChild(limitSelect);

  const result = tab.state.result;
  const total = result ? (result.total ?? result.rowCount) : 0;
  const returned = result ? result.rowCount : 0;
  const unlimited = tab.state.limit === 0;
  const pageCount = unlimited ? 1 : Math.max(1, Math.ceil(total / Math.max(1, tab.state.limit)));
  const currentPage = unlimited ? 1 : Math.min(pageCount, Math.floor(tab.state.offset / Math.max(1, tab.state.limit)) + 1);

  const prev = el('button', 'btn small', '上一页');
  prev.disabled = !result || unlimited || tab.state.offset <= 0;
  prev.addEventListener('click', () => {
    tab.state.offset = Math.max(0, tab.state.offset - Math.max(1, tab.state.limit));
    loadDataTab(tab);
  });
  const next = el('button', 'btn small', '下一页');
  next.disabled = !result || unlimited || total <= 0 || tab.state.offset + returned >= total;
  next.addEventListener('click', () => {
    tab.state.offset += Math.max(1, tab.state.limit);
    loadDataTab(tab);
  });

  const pageInput = document.createElement('input');
  pageInput.className = 'page-input';
  pageInput.type = 'number';
  pageInput.min = '1';
  pageInput.max = String(pageCount);
  pageInput.value = String(currentPage);
  pageInput.disabled = !result || unlimited;
  pageInput.title = '输入页码后回车跳转';
  pageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || unlimited) return;
    const page = Math.min(pageCount, Math.max(1, Number(pageInput.value) || 1));
    tab.state.offset = (page - 1) * tab.state.limit;
    loadDataTab(tab);
  });

  const pageInfo = el('span', 'page-info', result
    ? (unlimited
      ? '全部 · 共 ' + total + ' 行' + (result.truncated ? '（已截断）' : '')
      : '第 ' + currentPage + ' / ' + pageCount + ' 页 · 共 ' + total + ' 行' + (result.truncated ? '（已截断）' : ''))
    : '-');
  pager.append(prev, pageInput, next, pageInfo);
  toolbar.appendChild(pager);

  const refresh = el('button', 'btn small', '刷新');
  refresh.addEventListener('click', () => loadDataTab(tab));
  const exportButton = el('button', 'btn small', '导出 CSV');
  exportButton.addEventListener('click', () => exportActiveGridCsv());
  toolbar.append(refresh, exportButton);
  panel.appendChild(toolbar);

  const gridWrap = el('div', 'grid-wrap');
  panel.appendChild(gridWrap);
  host.appendChild(panel);

  if (tab.state.result) {
    meta.innerHTML = '行数 <b>' + result.rowCount + '</b> · 耗时 <b>' + fmtMs(result.elapsedMs) + '</b>'
      + (result.truncated ? ' · <span class="warn">已截断</span>' : '')
      + (detail && !editable ? ' · <span class="warn">无主键，只读</span>' : '');
    renderResultGrid(gridWrap, result, {
      sortable: true,
      orderBy: tab.state.orderBy,
      desc: tab.state.desc,
      onSort: (columnName) => {
        if (tab.state.orderBy === columnName) tab.state.desc = !tab.state.desc;
        else {
          tab.state.orderBy = columnName;
          tab.state.desc = false;
        }
        loadDataTab(tab);
      },
      fileName: tab.table,
      editable,
      primaryKey,
      canEdit: () => dataCanEdit(tab),
      onUpdateCell: (row, columnName, value) => updateDataCell(tab, row, columnName, value),
      onSelectRow: (rowIndex) => { tab.state.selectedRowIndex = rowIndex; },
    });
  } else if (tab.state.error) {
    gridWrap.appendChild(errorPanelNode(tab.state.error, tab.state.errorHint));
    meta.textContent = '加载失败';
  } else if (tab.state.loading) {
    gridWrap.appendChild(el('div', 'grid-loading', '加载数据…'));
    meta.textContent = '加载中…';
  } else {
    meta.textContent = '';
    loadDataTab(tab);
  }
}

async function loadDataTab(tab) {
  tab.state.loading = true;
  tab.state.error = '';
  if (state.activeTabId === tab.id) renderActiveTab();
  const query = {
    connectionId: tab.connectionId,
    schema: tab.schema || '',
    table: tab.table,
    limit: tab.state.limit,
    offset: tab.state.limit === 0 ? 0 : tab.state.offset,
  };
  if (tab.state.orderBy) {
    query.orderBy = tab.state.orderBy;
    query.desc = tab.state.desc ? 'true' : 'false';
  }
  try {
    const [data, entry] = await Promise.all([
      pluginGet('table-data', query),
      getTableDetail(tab).catch(() => null),
    ]);
    tab.state.result = normalizeResult(data);
    tab.state.entry = entry;
    tab.state.selectedRowIndex = null;
    tab.state.error = '';
  } catch (error) {
    tab.state.result = null;
    tab.state.entry = null;
    tab.state.error = '加载数据失败：' + error.message;
    tab.state.errorHint = passwordAuthGuidance(error);
  } finally {
    tab.state.loading = false;
    if (state.activeTabId === tab.id) renderActiveTab();
  }
}

/* ------------------------------ 数据网格编辑 ------------------------------ */

function dataDetail(tab) {
  return tab.state.entry ? tab.state.entry.detail : null;
}

function dataPrimaryKey(tab) {
  const detail = dataDetail(tab);
  return detail ? detail.primaryKey : [];
}

function buildRowPk(tab, row) {
  const pk = {};
  for (const name of dataPrimaryKey(tab)) pk[name] = row ? row[name] : undefined;
  return pk;
}

function dataCanEdit(tab) {
  if (!dataPrimaryKey(tab).length) {
    toast('该表没有主键，禁用网格编辑', 'error');
    return false;
  }
  if (!state.writeMode) {
    toast('请先开启顶部「写模式」再编辑数据', 'error');
    return false;
  }
  return true;
}

function cellInputValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseCellInput(text, original) {
  const raw = String(text);
  if (raw === '') return null;
  if (typeof original === 'number' && Number.isFinite(Number(raw))) return Number(raw);
  if (typeof original === 'boolean') return /^(true|1|是|yes)$/i.test(raw.trim());
  return raw;
}

async function updateDataCell(tab, row, columnName, text) {
  if (!state.writeMode) {
    toast('请先开启顶部「写模式」再编辑数据', 'error');
    throw new Error('未开启写模式');
  }
  const pk = buildRowPk(tab, row);
  if (!Object.keys(pk).length) throw new Error('该表没有主键，无法定位行');
  const nextValue = parseCellInput(text, row[columnName]);
  const confirmed = window.confirm('更新 ' + qualifiedName(tab.schema, tab.table) + '.' + columnName + '：\n\n'
    + cellInputValue(row[columnName]) + '  →  ' + cellInputValue(nextValue)
    + '\n\n主键：' + JSON.stringify(pk) + '\n确认执行？（需要写模式 + db-service allowWrite=true）');
  if (!confirmed) throw new Error('已取消');
  try {
    const data = await pluginPost('row-update', {
      connectionId: tab.connectionId,
      schema: tab.schema || '',
      table: tab.table,
      pk,
      changes: { [columnName]: nextValue },
      confirmed: true,
    });
    toast('已更新 1 行' + (data && data.elapsedMs !== undefined ? '（' + fmtMs(data.elapsedMs) + '）' : ''), 'success');
    await loadDataTab(tab);
  } catch (error) {
    toast('更新失败：' + error.message, 'error');
    throw error;
  }
}

function openInsertRowModal(tab) {
  const detail = dataDetail(tab);
  if (!detail) {
    toast('表结构尚未加载，请先刷新', 'error');
    return;
  }
  if (!dataPrimaryKey(tab).length) {
    toast('该表没有主键，禁用行编辑', 'error');
    return;
  }
  if (!state.writeMode) {
    toast('请先开启顶部「写模式」再新增行', 'error');
    return;
  }
  const fields = detail.columns.filter((column) => !column.autoIncrement);
  if (!fields.length) {
    toast('该表没有可填写的列', 'error');
    return;
  }
  const overlay = el('div', 'modal');
  const card = el('div', 'modal-card row-form-card');
  const head = el('div', 'modal-head');
  head.appendChild(el('h3', null, '新增行 · ' + qualifiedName(tab.schema, tab.table)));
  const closeButton = el('button', 'icon-btn', '关闭');
  closeButton.type = 'button';
  head.appendChild(closeButton);
  const body = el('div', 'modal-body');
  const inputs = new Map();
  for (const column of fields) {
    const field = el('label', 'field');
    field.appendChild(el('span', null, column.name + '  ' + (column.type || '')
      + (column.nullable === false ? ' · 非空' : '')
      + (column.primaryKey ? ' · PK' : '')));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = column.defaultValue === null || column.defaultValue === undefined ? '' : String(column.defaultValue);
    input.placeholder = column.nullable === false ? '必填' : '可留空（NULL）';
    inputs.set(column.name, input);
    field.appendChild(input);
    body.appendChild(field);
  }
  const message = el('div', 'form-message hidden');
  body.appendChild(message);
  const foot = el('div', 'modal-foot');
  const cancelButton = el('button', 'btn', '取消');
  const insertButton = el('button', 'btn primary', '插入新行');
  foot.append(cancelButton, el('span', 'spacer'), insertButton);
  card.append(head, body, foot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  closeButton.addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  const first = inputs.values().next().value;
  if (first) first.focus();
  insertButton.addEventListener('click', async () => {
    const values = {};
    for (const [name, input] of inputs) {
      if (input.value !== '') values[name] = input.value;
    }
    const confirmed = window.confirm('插入 1 行到 ' + qualifiedName(tab.schema, tab.table) + '：\n\n'
      + JSON.stringify(values, null, 2) + '\n\n确认执行？（需要写模式 + db-service allowWrite=true）');
    if (!confirmed) return;
    insertButton.disabled = true;
    message.className = 'form-message hidden';
    try {
      await pluginPost('row-insert', {
        connectionId: tab.connectionId,
        schema: tab.schema || '',
        table: tab.table,
        values,
        confirmed: true,
      });
      close();
      toast('已插入 1 行', 'success');
      await loadDataTab(tab);
    } catch (error) {
      message.className = 'form-message fail';
      message.textContent = '插入失败：' + error.message;
      insertButton.disabled = false;
    }
  });
}

async function deleteSelectedRow(tab) {
  if (!state.writeMode) {
    toast('请先开启顶部「写模式」再删除行', 'error');
    return;
  }
  const result = tab.state.result;
  const rowIndex = tab.state.selectedRowIndex;
  if (!result || rowIndex === null || rowIndex === undefined || !result.rows[rowIndex]) {
    toast('请先点击左侧行号选中一行', 'info');
    return;
  }
  const pk = buildRowPk(tab, result.rows[rowIndex]);
  if (!Object.keys(pk).length) {
    toast('该表没有主键，无法删除行', 'error');
    return;
  }
  const confirmed = window.confirm('删除 ' + qualifiedName(tab.schema, tab.table) + ' 的 1 行：\n\n主键：'
    + JSON.stringify(pk) + '\n\n确认执行？（需要写模式 + db-service allowWrite=true）');
  if (!confirmed) return;
  try {
    await pluginPost('row-delete', {
      connectionId: tab.connectionId,
      schema: tab.schema || '',
      table: tab.table,
      pk,
      confirmed: true,
    });
    toast('已删除 1 行', 'success');
    await loadDataTab(tab);
  } catch (error) {
    toast('删除失败：' + error.message, 'error');
  }
}

/* ------------------------------ DDL 标签 ------------------------------ */

function renderDdlTab(tab) {
  const host = $('tabContent');
  const panel = el('div', 'object-panel');
  const toolbar = el('div', 'object-toolbar');
  toolbar.appendChild(el('span', 'object-title', qualifiedName(tab.schema, tab.table)));
  toolbar.appendChild(el('span', 'object-sub', 'DDL'));
  toolbar.appendChild(el('span', 'hint', '可直接编辑'));
  toolbar.appendChild(el('span', 'spacer'));

  const executeButton = el('button', 'btn small primary', tab.state.executing ? '执行中…' : '执行修改');
  executeButton.disabled = Boolean(tab.state.executing || tab.state.loading || !tab.state.ddl);
  executeButton.title = '执行当前编辑器里的 DDL；需要开启写模式且 db-service allowWrite=true';
  executeButton.addEventListener('click', () => executeDdlChanges(tab));

  const resetButton = el('button', 'btn small', '重置');
  resetButton.disabled = !tab.state.ddl || tab.state.ddl === tab.state.originalDdl;
  resetButton.title = '恢复到加载时的原始 DDL';
  resetButton.addEventListener('click', () => {
    tab.state.ddl = tab.state.originalDdl || '';
    tab.state.error = '';
    tab.state.errorHint = '';
    renderActiveTab();
    toast('已重置为原始 DDL', 'info');
  });

  const copyButton = el('button', 'btn small', '复制 DDL');
  copyButton.disabled = !tab.state.ddl;
  copyButton.addEventListener('click', () => copyText(tab.state.ddl || '', '已复制 DDL'));

  const refresh = el('button', 'btn small', '刷新');
  refresh.disabled = Boolean(tab.state.executing);
  refresh.addEventListener('click', () => {
    tab.state.ddl = '';
    tab.state.originalDdl = '';
    tab.state.note = '';
    tab.state.error = '';
    tab.state.errorHint = '';
    loadDdlTab(tab);
  });
  toolbar.append(executeButton, resetButton, copyButton, refresh);
  panel.appendChild(toolbar);

  const body = el('div', 'ddl-edit-wrap');
  panel.appendChild(body);
  host.appendChild(panel);

  if (tab.state.loading && !tab.state.ddl) {
    body.appendChild(el('div', 'grid-loading', '加载 DDL…'));
  } else if (tab.state.ddl) {
    if (tab.state.note) body.appendChild(el('div', 'info-banner', tab.state.note));
    const editor = document.createElement('textarea');
    editor.className = 'ddl-editor';
    editor.spellcheck = false;
    editor.title = '直接编辑 DDL，然后点击「执行修改」（需要写模式与 allowWrite）';
    editor.value = tab.state.ddl;
    editor.addEventListener('input', () => {
      tab.state.ddl = editor.value;
    });
    body.appendChild(editor);
    if (tab.state.error) body.appendChild(errorPanelNode(tab.state.error, tab.state.errorHint));
    if (tab.state.execInfo) body.appendChild(el('div', 'form-message ok', tab.state.execInfo));
  } else if (tab.state.error) {
    body.appendChild(errorPanelNode(tab.state.error, tab.state.errorHint));
  } else {
    loadDdlTab(tab);
  }
}

async function executeDdlChanges(tab) {
  if (tab.state.executing) return;
  const sql = String(tab.state.ddl || '').trim();
  if (!sql) {
    toast('DDL 不能为空', 'error');
    return;
  }
  if (!state.writeMode) {
    toast('结构修改需要先开启顶部「写模式」', 'error');
    return;
  }
  const confirmed = window.confirm('即将执行结构修改 DDL：\n\n' + clip(sql, 1500)
    + '\n\n需要顶部「写模式」开启，且 db-service 启动参数 allow-write=true。确认执行？');
  if (!confirmed) return;
  tab.state.executing = true;
  tab.state.error = '';
  tab.state.errorHint = '';
  tab.state.execInfo = '';
  renderActiveTab();
  try {
    const data = await pluginPost('execute', {
      connectionId: tab.connectionId,
      schema: tab.schema || '',
      sql,
      confirmed: true,
    });
    tab.state.execInfo = '执行成功：影响 ' + (data.affectedRows !== undefined ? data.affectedRows : 0) + ' 行（' + fmtMs(data.elapsedMs) + '）';
    toast('DDL 执行成功', 'success');
    const cs = connectionTreeState(tab.connectionId);
    cs.details.delete(treeTableKey(cs, tab.schema, tab.table));
    tab.state.ddl = '';
    tab.state.originalDdl = '';
    tab.state.note = '';
    await loadDdlTab(tab);
  } catch (error) {
    tab.state.error = '执行修改失败：' + error.message;
    tab.state.errorHint = passwordAuthGuidance(error);
    toast('DDL 执行失败', 'error');
  } finally {
    tab.state.executing = false;
    if (state.activeTabId === tab.id) renderActiveTab();
  }
}

async function loadDdlTab(tab) {
  tab.state.loading = true;
  tab.state.error = '';
  if (state.activeTabId === tab.id) renderActiveTab();
  const connection = connectionById(tab.connectionId);
  try {
    const data = await pluginGetOptional('ddl', {
      connectionId: tab.connectionId,
      schema: tab.schema || '',
      table: tab.table,
    }, 'ddl');
    if (data) {
      tab.state.ddl = extractDdl(data) || '-- 后端返回了空 DDL';
      tab.state.note = '';
    } else {
      const entry = await getTableDetail(tab);
      tab.state.ddl = synthesizeDdl(entry.detail, connection, tab.table, entry.detail.kind);
      tab.state.note = '后端未升级：ddl 端点不可用，以下为前端根据字段元数据生成的近似 DDL（注释/自增/外键可能缺失）。';
    }
    tab.state.originalDdl = tab.state.ddl;
  } catch (error) {
    tab.state.ddl = '';
    tab.state.error = '加载 DDL 失败：' + error.message;
    tab.state.errorHint = passwordAuthGuidance(error);
  } finally {
    tab.state.loading = false;
    if (state.activeTabId === tab.id) renderActiveTab();
  }
}

/* ------------------------------ 列 / 索引标签 ------------------------------ */

async function getTableDetail(tab) {
  const cs = connectionTreeState(tab.connectionId);
  const key = treeTableKey(cs, tab.schema, tab.table);
  if (cs.details.has(key)) return cs.details.get(key);
  let tableMeta = { name: tab.table, type: 'TABLE' };
  const schemaKey = tab.schema || '';
  if (cs.tables.has(schemaKey)) {
    const found = cs.tables.get(schemaKey).find((item) => item.name === tab.table);
    if (found) tableMeta = found;
  }
  return loadTableDetail(cs, tab.schema || '', tab.table, tableMeta);
}

function renderDetailTab(tab) {
  const host = $('tabContent');
  const panel = el('div', 'object-panel');
  const toolbar = el('div', 'object-toolbar');
  toolbar.appendChild(el('span', 'object-title', qualifiedName(tab.schema, tab.table)));
  toolbar.appendChild(el('span', 'object-sub', tab.kind === 'columns' ? '列' : '索引'));
  toolbar.appendChild(el('span', 'spacer'));
  const refresh = el('button', 'btn small', '刷新');
  refresh.addEventListener('click', () => {
    const cs = connectionTreeState(tab.connectionId);
    cs.details.delete(treeTableKey(cs, tab.schema, tab.table));
    tab.state.entry = null;
    tab.state.error = '';
    loadDetailTab(tab);
  });
  toolbar.appendChild(refresh);
  panel.appendChild(toolbar);
  const body = el('div', 'grid-wrap');
  panel.appendChild(body);
  host.appendChild(panel);

  if (tab.state.error) {
    body.appendChild(errorPanelNode(tab.state.error, tab.state.errorHint));
  } else if (tab.state.entry) {
    const note = tab.state.entry.degraded
      ? '后端未升级：表结构来自旧 columns 端点，注释/自增/外键信息可能缺失。' : '';
    if (tab.kind === 'columns') renderColumnsView(body, tab.state.entry.detail, { note });
    else renderIndexesView(body, tab.state.entry.detail, { note, showForeignKeys: true });
  } else if (tab.state.loading) {
    body.appendChild(el('div', 'grid-loading', '加载表结构…'));
  } else {
    loadDetailTab(tab);
  }
}

async function loadDetailTab(tab) {
  tab.state.loading = true;
  tab.state.error = '';
  if (state.activeTabId === tab.id) renderActiveTab();
  try {
    tab.state.entry = await getTableDetail(tab);
  } catch (error) {
    tab.state.entry = null;
    tab.state.error = '加载表结构失败：' + error.message;
    tab.state.errorHint = passwordAuthGuidance(error);
  } finally {
    tab.state.loading = false;
    if (state.activeTabId === tab.id) renderActiveTab();
  }
}

/* ------------------------------ 刷新 ------------------------------ */

async function refreshActiveView() {
  const tab = activeTab();
  await refreshTree({ force: false });
  if (!tab) return;
  if (tab.kind === 'data') await loadDataTab(tab);
  else if (tab.kind === 'ddl') {
    tab.state.ddl = '';
    await loadDdlTab(tab);
  } else if (tab.kind === 'columns' || tab.kind === 'indexes') {
    const cs = connectionTreeState(tab.connectionId);
    cs.details.delete(treeTableKey(cs, tab.schema, tab.table));
    tab.state.entry = null;
    await loadDetailTab(tab);
  } else if (tab.kind === 'query') {
    toast('SQL 控制台无需刷新，直接执行即可', 'info');
  }
}







