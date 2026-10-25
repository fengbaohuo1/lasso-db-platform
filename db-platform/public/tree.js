'use strict';

/**
 * 对象树：连接 → 数据库/schema → 表/视图 → 列/键/索引；搜索过滤、右键菜单、旧后端降级。
 */

const TREE_KEY = {
  conn: (connectionId) => 'c:' + connectionId,
  ns: (connectionId, schema) => 'n:' + connectionId + ':' + schema,
  table: (connectionId, schema, table) => 't:' + connectionId + ':' + (schema || '') + ':' + table,
  folder: (connectionId, schema, table, folder) => 'f:' + connectionId + ':' + (schema || '') + ':' + table + ':' + folder,
};

function connectionTreeState(connectionId) {
  if (!state.tree.cache.has(connectionId)) {
    state.tree.cache.set(connectionId, {
      connectionId,
      namespacesLoaded: false,
      namespaces: [],
      fallback: false,
      tables: new Map(),
      details: new Map(),
      loading: new Set(),
      error: '',
      errorHint: '',
    });
  }
  return state.tree.cache.get(connectionId);
}

function normalizeNamespaces(data) {
  const list = (data && (data.items || data.namespaces || data.databases || data.schemas)) || [];
  const defaultName = (data && (data.default || data.current || data.currentSchema)) || '';
  return list.map((item) => {
    if (typeof item === 'string') {
      return { name: item, type: 'database', isSystem: false, current: item === defaultName };
    }
    const name = item.name || item.schema || item.database || '';
    return {
      name,
      type: item.type || 'database',
      isSystem: Boolean(item.isSystem),
      current: Boolean(item.current) || (Boolean(defaultName) && name === defaultName),
    };
  }).filter((item) => item.name);
}

function normalizeTables(data) {
  const list = (data && (data.tables || data.items)) || [];
  return list.map((item) => {
    if (typeof item === 'string') return { name: item, type: 'TABLE', rows: null };
    const type = String(item.type || 'TABLE').toUpperCase();
    return {
      name: item.name || item.table || item.TABLE_NAME || '',
      type: type.includes('VIEW') ? 'VIEW' : 'TABLE',
      rows: item.rows !== undefined ? item.rows : (item.rowCount !== undefined ? item.rowCount : null),
    };
  }).filter((item) => item.name);
}

function treeExpanded(key) {
  return state.tree.expanded.has(key);
}

function toggleTreeExpanded(key) {
  if (state.tree.expanded.has(key)) state.tree.expanded.delete(key);
  else state.tree.expanded.add(key);
}

function treeTableKey(cs, schema, table) {
  return (schema || '') + '|' + table;
}

/* ------------------------------ 加载 ------------------------------ */

async function refreshTree(options = {}) {
  try {
    await loadConnections();
  } catch (error) {
    const host = $('tree');
    clear(host);
    host.appendChild(el('div', 'tree-error', '加载数据源失败：' + error.message));
    return;
  }
  if (options.force) state.tree.cache.clear();
  renderTree();
  if (!state.tree.filter) {
    const conn = activeConnection() || state.connections[0];
    if (conn) await expandConnection(conn.id);
  }
  if (!activeTab()) renderStatusForTab(null);
}

async function expandConnection(connectionId) {
  const cs = connectionTreeState(connectionId);
  state.tree.expanded.add(TREE_KEY.conn(connectionId));
  renderTree();
  if (cs.namespacesLoaded) {
    if (cs.fallback && !cs.tables.has('')) await loadTables(cs, '');
    return;
  }
  cs.loading.add('namespaces');
  renderTree();
  try {
    const data = await pluginGetOptional('namespaces', { connectionId }, 'namespaces');
    if (data) {
      cs.namespaces = normalizeNamespaces(data);
      cs.fallback = cs.namespaces.length === 0;
    } else {
      cs.namespaces = [];
      cs.fallback = true;
    }
    cs.namespacesLoaded = true;
    cs.error = '';
    cs.errorHint = '';
    if (cs.fallback) {
      await loadTables(cs, '');
    } else {
      const target = cs.namespaces.find((item) => item.current) || cs.namespaces.find((item) => !item.isSystem);
      if (target) await expandNamespace(cs, target.name, { silent: true });
    }
  } catch (error) {
    cs.error = '加载数据库失败：' + error.message;
    cs.errorHint = passwordAuthGuidance(error);
    cs.namespacesLoaded = true;
  } finally {
    cs.loading.delete('namespaces');
    renderTree();
  }
}

async function expandNamespace(cs, schema, options = {}) {
  state.tree.expanded.add(TREE_KEY.ns(cs.connectionId, schema));
  if (!options.silent) renderTree();
  if (!cs.tables.has(schema || '')) await loadTables(cs, schema);
}

async function loadTables(cs, schema, options = {}) {
  const key = schema || '';
  if (cs.tables.has(key) && !options.force) return;
  cs.loading.add('tables:' + key);
  renderTree();
  try {
    const data = await pluginGet('tables', { connectionId: cs.connectionId, schema });
    cs.tables.set(key, normalizeTables(data).map((table) => ({ ...table, schema: key })));
    cs.error = '';
    cs.errorHint = '';
  } catch (error) {
    cs.tables.set(key, []);
    cs.error = '加载表失败：' + error.message;
    cs.errorHint = passwordAuthGuidance(error);
  } finally {
    cs.loading.delete('tables:' + key);
    renderTree();
  }
}

async function loadTableDetail(cs, schema, table, tableMeta) {
  const key = treeTableKey(cs, schema, table);
  if (cs.details.has(key)) return cs.details.get(key);
  cs.loading.add('detail:' + key);
  renderTree();
  let entry;
  try {
    const data = await pluginGetOptional('table-detail', { connectionId: cs.connectionId, schema, table }, 'table-detail');
    if (data) {
      entry = { detail: normalizeTableDetail(data, { schema, table, kind: tableMeta.type }), degraded: false, error: '', errorHint: '' };
    } else {
      const columnsData = await pluginGet('columns', { connectionId: cs.connectionId, schema, table });
      entry = {
        detail: normalizeTableDetail(columnsData, { schema, table, kind: tableMeta.type }),
        degraded: true,
        error: '',
        errorHint: '',
      };
    }
  } catch (error) {
    entry = {
      detail: normalizeTableDetail({}, { schema, table, kind: tableMeta.type }),
      degraded: true,
      error: error.message,
      errorHint: passwordAuthGuidance(error),
    };
  }
  cs.details.set(key, entry);
  cs.loading.delete('detail:' + key);
  renderTree();
  return entry;
}

async function expandTable(cs, schema, tableMeta) {
  const key = TREE_KEY.table(cs.connectionId, schema, tableMeta.name);
  if (!treeExpanded(key)) {
    state.tree.expanded.add(key);
    renderTree();
    await loadTableDetail(cs, schema, tableMeta.name, tableMeta);
    return;
  }
  state.tree.expanded.delete(key);
  renderTree();
}

/* ------------------------------ 渲染 ------------------------------ */

/* 图标：内联 SVG（填充风），颜色由 CSS token 按类型控制。 */
const TREE_ICON_PATHS = {
  conn: '<rect x="2" y="2.4" width="12" height="5.1" rx="1.9" fill="currentColor"/>'
    + '<rect x="2" y="8.5" width="12" height="5.1" rx="1.9" fill="currentColor" opacity=".5"/>'
    + '<circle cx="4.7" cy="4.95" r=".85" fill="currentColor" opacity=".35"/>'
    + '<circle cx="4.7" cy="11.05" r=".85" fill="currentColor" opacity=".35"/>',
  db: '<ellipse cx="8" cy="3.9" rx="5.3" ry="2.2" fill="currentColor"/>'
    + '<path d="M2.7 3.9v6.5c0 1.24 2.37 2.25 5.3 2.25s5.3-1.01 5.3-2.25V3.9c0 1.24-2.37 2.25-5.3 2.25S2.7 5.14 2.7 3.9z" fill="currentColor" opacity=".48"/>'
    + '<path d="M2.9 7.3c.5 1.1 2.55 1.9 5.1 1.9s4.6-.8 5.1-1.9" fill="none" stroke="currentColor" stroke-width="1" opacity=".55"/>',
  table: '<rect x="2" y="2.5" width="12" height="11" rx="2.2" fill="currentColor" opacity=".26"/>'
    + '<rect x="2" y="2.5" width="12" height="3.5" rx="2" fill="currentColor"/>'
    + '<rect x="3.7" y="7.9" width="3.3" height="2.5" rx=".75" fill="currentColor" opacity=".85"/>'
    + '<rect x="8.9" y="7.9" width="3.4" height="2.5" rx=".75" fill="currentColor" opacity=".85"/>'
    + '<rect x="3.7" y="11.3" width="3.3" height="1.4" rx=".6" fill="currentColor" opacity=".5"/>'
    + '<rect x="8.9" y="11.3" width="3.4" height="1.4" rx=".6" fill="currentColor" opacity=".5"/>',
  view: '<path d="M8 3c3.5 0 5.9 2.4 6.7 4.3.2.45.2.95 0 1.4C13.9 10.6 11.5 13 8 13S2.1 10.6 1.3 8.7c-.2-.45-.2-.95 0-1.4C2.1 5.4 4.5 3 8 3z" fill="currentColor" opacity=".38"/>'
    + '<circle cx="8" cy="8" r="2.4" fill="currentColor"/>',
  col: '<rect x="2.2" y="2.7" width="11.6" height="10.6" rx="2.2" fill="currentColor" opacity=".28"/>'
    + '<rect x="4" y="5" width="4.2" height="1.7" rx=".85" fill="currentColor"/>'
    + '<rect x="4" y="7.9" width="8" height="1.7" rx=".85" fill="currentColor" opacity=".6"/>'
    + '<rect x="4" y="10.7" width="5.8" height="1.4" rx=".7" fill="currentColor" opacity=".4"/>',
  key: '<circle cx="4.9" cy="8" r="2.7" fill="none" stroke="currentColor" stroke-width="2.1"/>'
    + '<path d="M7.5 8H14v2.1h-1.3V12h-1.9v-1.9h-1V12H8V8z" fill="currentColor"/>',
  pk: '<circle cx="4.7" cy="8" r="2.5" fill="currentColor"/>'
    + '<circle cx="4.7" cy="8" r="1" fill="currentColor" opacity=".3"/>'
    + '<path d="M7.2 8H14v2.1h-1.3V12h-1.9v-1.9h-1V12H7.7V8z" fill="currentColor"/>',
  fk: '<circle cx="4.5" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/>'
    + '<path d="M6.7 8h3.1V6.5h2.2V8H14v2h-2v1.6h-2.2V10H6.7z" fill="currentColor"/>',
  index: '<path d="M9.9 1.5 3.4 9h3.5l-1 5.5L12.9 7H9.2l.7-5.5z" fill="currentColor"/>',
};

function treeIconSvg(kind) {
  const span = el('span', 'tree-icon icon-' + kind);
  span.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + (TREE_ICON_PATHS[kind] || TREE_ICON_PATHS.table) + '</svg>';
  return span;
}

function treeNode(level, options) {
  const node = el('div', 'tree-node' + (options.className ? ' ' + options.className : ''));
  node.style.setProperty('--level', String(level));
  node.dataset.context = options.context || '';
  if (options.title) node.title = options.title;

  const chevron = el('span', 'tree-chevron'
    + (options.expandable ? '' : ' spacer')
    + (options.expandable && options.expanded ? ' expanded' : ''));
  node.appendChild(chevron);

  if (options.dot) {
    const dot = el('span', 'tree-dot ' + options.dot);
    node.appendChild(dot);
  }
  if (options.iconKind) {
    node.appendChild(treeIconSvg(options.iconKind));
  } else if (options.icon) {
    node.appendChild(el('span', 'tree-icon ' + (options.iconClass || ''), options.icon));
  }

  const label = el('span', 'tree-label' + (options.mono ? ' mono' : ''));
  label.appendChild(el('span', null, options.label));
  if (options.sub) label.appendChild(el('span', 'tree-sub', options.sub));
  if (options.note) {
    const note = el('span', 'tree-note', options.note);
    note.title = options.note;
    label.appendChild(note);
  }
  node.appendChild(label);

  if (options.badge !== undefined && options.badge !== null && options.badge !== '') {
    node.appendChild(el('span', 'tree-badge', String(options.badge)));
  }
  if (options.onClick) node.addEventListener('click', (event) => { event.stopPropagation(); options.onClick(event); });
  if (options.onDblClick) node.addEventListener('dblclick', (event) => { event.stopPropagation(); options.onDblClick(event); });
  if (options.onContext) {
    node.addEventListener('contextmenu', (event) => { event.stopPropagation(); options.onContext(event); });
  }
  return node;
}

function activeTableIdentity() {
  const tab = activeTab();
  if (!tab || !tab.table) return null;
  return { connectionId: tab.connectionId, schema: tab.schema || '', table: tab.table };
}

function treeLoadingHint(text) {
  return el('div', 'tree-loading', text);
}

function renderTree() {
  const host = $('tree');
  if (!host) return;
  const scrollTop = host.scrollTop;
  clear(host);
  if (!state.connections.length) {
    host.appendChild(el('div', 'tree-hint', '暂无数据源。点击工具栏「新建数据源」创建。'));
    return;
  }
  const filter = state.tree.filter.trim().toLowerCase();
  if (filter) {
    renderFilteredTree(host, filter);
  } else {
    for (const connection of state.connections) {
      renderConnectionTree(host, connection);
    }
  }
  host.scrollTop = scrollTop;
}

function renderConnectionTree(host, connection) {
  const cs = connectionTreeState(connection.id);
  const expanded = treeExpanded(TREE_KEY.conn(connection.id));
  const active = activeTableIdentity();
  const isActive = active && active.connectionId === connection.id;
  const passwordNote = connectionPasswordMemoryOnly(connection) ? PASSWORD_MEMORY_NOTE : '';
  host.appendChild(treeNode(0, {
    context: 'connection',
    expandable: true,
    expanded,
    dot: connection.status === 'ok' ? 'ok' : 'error',
    iconKind: 'conn',
    label: connection.name,
    sub: connectionEndpoint(connection),
    note: passwordNote,
    mono: true,
    className: 'conn-row' + (isActive ? ' active' : '') + (passwordNote ? ' has-note' : ''),
    title: (connection.jdbcUrl || connection.name)
      + (passwordNote ? '\n' + passwordNote : ''),
    onClick: () => {
      state.activeConnectionId = connection.id;
      toggleTreeExpanded(TREE_KEY.conn(connection.id));
      if (!expanded) {
        expandConnection(connection.id).then(() => { if (!activeTab()) renderStatusForTab(null); });
      } else {
        renderTree();
        if (!activeTab()) renderStatusForTab(null);
      }
    },
    onContext: (event) => openConnectionMenu(event, connection),
  }));
  if (!expanded) return;

  if (cs.error) {
    host.appendChild(el('div', 'tree-error', cs.error));
    if (cs.errorHint) host.appendChild(el('div', 'tree-error-hint', cs.errorHint));
  }
  if (cs.loading.has('namespaces')) {
    host.appendChild(treeLoadingHint('加载数据库…'));
    return;
  }
  if (cs.fallback) {
    renderSchemaSection(host, cs, '', connection);
    return;
  }
  const normal = cs.namespaces.filter((item) => !item.isSystem);
  const systems = cs.namespaces.filter((item) => item.isSystem);
  host.appendChild(el('div', 'tree-group-title', '库 · ' + normal.length));
  for (const namespace of normal) renderNamespaceNode(host, cs, namespace, connection);
  if (systems.length) {
    host.appendChild(el('div', 'tree-group-title', '系统对象'));
    for (const namespace of systems) renderNamespaceNode(host, cs, namespace, connection);
  }
}

function renderNamespaceNode(host, cs, namespace, connection) {
  const key = TREE_KEY.ns(cs.connectionId, namespace.name);
  const expanded = treeExpanded(key);
  host.appendChild(treeNode(1, {
    context: 'namespace',
    expandable: true,
    expanded,
    iconKind: 'db',
    label: namespace.name,
    badge: namespace.current ? '当前' : '',
    className: namespace.isSystem ? 'muted' : '',
    title: namespace.name,
    onClick: () => {
      if (expanded) {
        state.tree.expanded.delete(key);
        renderTree();
      } else {
        expandNamespace(cs, namespace.name);
      }
    },
    onContext: (event) => openNamespaceMenu(event, cs, namespace),
  }));
  if (expanded) renderSchemaSection(host, cs, namespace.name, connection);
}

function renderSchemaSection(host, cs, schema, connection) {
  const tableKey = schema || '';
  if (cs.loading.has('tables:' + tableKey)) {
    host.appendChild(treeLoadingHint('加载表…'));
    return;
  }
  const tables = cs.tables.get(tableKey);
  if (!tables) return;
  const active = activeTableIdentity();
  const groups = [
    { label: '表', items: tables.filter((item) => item.type !== 'VIEW') },
    { label: '视图', items: tables.filter((item) => item.type === 'VIEW') },
  ];
  let rendered = false;
  for (const group of groups) {
    if (!group.items.length) continue;
    rendered = true;
    host.appendChild(el('div', 'tree-group-title', group.label + ' · ' + group.items.length));
    for (const table of group.items) {
      renderTableNode(host, cs, schema, table, active);
    }
  }
  if (!rendered) host.appendChild(el('div', 'tree-loading', '（没有表/视图）'));
}

function renderTableNode(host, cs, schema, table, active) {
  const key = TREE_KEY.table(cs.connectionId, schema, table.name);
  const expanded = treeExpanded(key);
  const isActive = active && active.connectionId === cs.connectionId
    && active.schema === (schema || '') && active.table === table.name;
  host.appendChild(treeNode(schema ? 2 : 1, {
    context: 'table',
    expandable: true,
    expanded,
    iconKind: table.type === 'VIEW' ? 'view' : 'table',
    label: table.name,
    mono: true,
    badge: table.rows !== null && table.rows !== undefined && table.rows >= 0 ? String(table.rows) : '',
    className: isActive ? 'active' : '',
    title: table.name + (table.type === 'VIEW' ? '（视图）' : ''),
    onClick: () => expandTable(cs, schema, table),
    onDblClick: () => openObjectTab('data', { connectionId: cs.connectionId, schema, table: table.name }),
    onContext: (event) => openTableMenu(event, cs, schema, table),
  }));
  if (!expanded) return;
  const detailKey = treeTableKey(cs, schema, table.name);
  if (cs.loading.has('detail:' + detailKey)) {
    host.appendChild(treeLoadingHint('加载表结构…'));
    return;
  }
  const entry = cs.details.get(detailKey);
  if (!entry) return;
  if (entry.error) {
    host.appendChild(el('div', 'tree-error', entry.error));
    if (entry.errorHint) host.appendChild(el('div', 'tree-error-hint', entry.errorHint));
  }
  const level = schema ? 3 : 2;
  renderTableFolders(host, cs, schema, table, entry, level);
}

function renderTableFolders(host, cs, schema, table, entry, level) {
  const detail = entry.detail;
  const folders = [
    {
      id: 'columns', label: '列', iconKind: 'col',
      items: detail.columns.map((column) => ({
        label: column.name,
        sub: column.type || '',
        iconKind: column.primaryKey ? 'pk' : 'col',
        onContext: (event) => openContextMenu(event, [
          { label: '复制列名', action: () => copyText(column.name, '已复制列名') },
          { label: '复制类型', action: () => copyText(column.type || '', '已复制类型') },
        ]),
      })),
    },
    {
      id: 'keys', label: '键', iconKind: 'key',
      items: [
        ...detail.primaryKey.map((name) => ({ label: name, sub: 'PRIMARY KEY', iconKind: 'pk' })),
        ...detail.foreignKeys.map((fk) => ({
          label: fk.name || fk.columns.join(','),
          sub: fk.columns.join(',') + ' → ' + [fk.refSchema, fk.refTable].filter(Boolean).join('.'),
          iconKind: 'fk',
          onContext: (event) => openContextMenu(event, [
            { label: '复制外键名', action: () => copyText(fk.name || '', '已复制') },
          ]),
        })),
      ],
    },
    {
      id: 'indexes', label: '索引', iconKind: 'index',
      items: detail.indexes.map((index) => ({
        label: index.name,
        sub: (index.unique ? 'UNIQUE ' : '') + index.columns.join(','),
        iconKind: 'index',
        onContext: (event) => openContextMenu(event, [
          { label: '复制索引名', action: () => copyText(index.name, '已复制索引名') },
        ]),
      })),
    },
  ];
  for (const folder of folders) {
    const folderKey = TREE_KEY.folder(cs.connectionId, schema, table.name, folder.id);
    const expanded = treeExpanded(folderKey);
    host.appendChild(treeNode(level, {
      context: 'folder',
      expandable: true,
      expanded,
      iconKind: folder.iconKind,
      label: folder.label,
      badge: folder.items.length,
      sub: folder.id === 'keys' && folder.items.length === 0 ? '' : '',
      onClick: () => { toggleTreeExpanded(folderKey); renderTree(); },
      onContext: (event) => openContextMenu(event, [
        { label: '展开/收起', action: () => { toggleTreeExpanded(folderKey); renderTree(); } },
        ...(entry.degraded ? [{ label: '后端未升级（表结构来自旧端点）', action: () => toast('升级插件后可用 table-detail 获取完整注释/自增/外键', 'info') }] : []),
      ]),
    }));
    if (!expanded) continue;
    for (const item of folder.items) {
      host.appendChild(treeNode(level + 1, {
        context: 'item',
        iconKind: item.iconKind,
        label: item.label,
        sub: item.sub,
        mono: true,
        onContext: item.onContext,
      }));
    }
  }
}

function renderFilteredTree(host, filter) {
  let matches = 0;
  for (const connection of state.connections) {
    const cs = connectionTreeState(connection.id);
    const entries = [];
    for (const [schema, tables] of cs.tables.entries()) {
      for (const table of tables) {
        const haystack = (connection.name + ' ' + connection.id + ' ' + schema + ' ' + table.name).toLowerCase();
        if (haystack.includes(filter)) entries.push({ schema, table });
      }
    }
    if (!entries.length) continue;
    matches += entries.length;
    host.appendChild(el('div', 'tree-group-title', connection.name));
    const firstNs = cs.namespaces.filter((item) => !item.isSystem)[0];
    const defaultSchema = firstNs ? firstNs.name : '';
    for (const entry of entries.slice(0, 200)) {
      host.appendChild(treeNode(1, {
        context: 'table',
        iconKind: entry.table.type === 'VIEW' ? 'view' : 'table',
        label: entry.table.name,
        sub: entry.schema && entry.schema !== defaultSchema ? entry.schema : '',
        mono: true,
        badge: entry.table.rows !== null && entry.table.rows >= 0 ? String(entry.table.rows) : '',
        onClick: () => openObjectTab('data', { connectionId: connection.id, schema: entry.schema, table: entry.table.name }),
        onContext: (event) => openTableMenu(event, cs, entry.schema, entry.table),
      }));
    }
  }
  if (!matches) host.appendChild(el('div', 'tree-hint', state.tree.searching
    ? '正在加载各数据源的表清单…' : '没有匹配的对象'));
}

/* ------------------------------ 搜索 ------------------------------ */

let searchToken = 0;

async function ensureSearchCatalog() {
  const token = ++searchToken;
  state.tree.searching = true;
  renderTree();
  for (const connection of state.connections) {
    const cs = connectionTreeState(connection.id);
    if (!cs.namespacesLoaded) {
      try {
        const data = await pluginGetOptional('namespaces', { connectionId: connection.id }, 'namespaces');
        cs.namespaces = data ? normalizeNamespaces(data) : [];
        cs.fallback = !data || cs.namespaces.length === 0;
      } catch {
        cs.fallback = true;
        cs.namespaces = [];
      }
      cs.namespacesLoaded = true;
    }
    const schemas = cs.fallback ? [''] : cs.namespaces.filter((item) => !item.isSystem).map((item) => item.name);
    for (const schema of schemas) {
      if (token !== searchToken) return;
      if (!cs.tables.has(schema || '')) {
        try {
          await loadTables(cs, schema);
        } catch {
          // 单个连接失败不影响其它连接搜索
        }
      }
    }
  }
  state.tree.searching = false;
  if (token === searchToken) renderTree();
}

/* ------------------------------ 右键菜单 ------------------------------ */

function openConnectionMenu(event, connection) {
  openContextMenu(event, [
    { label: '刷新数据源', action: () => { const cs = connectionTreeState(connection.id); cs.namespacesLoaded = false; cs.tables.clear(); cs.details.clear(); state.tree.expanded.add(TREE_KEY.conn(connection.id)); expandConnection(connection.id); } },
    { label: '新建查询', action: () => openQueryTab({ connectionId: connection.id }) },
    { label: '编辑数据源', action: () => openConnectionModal(connection.id) },
    { sep: true },
    { label: '断开数据源', action: () => disconnectConnection(connection) },
    { label: '复制数据源名', action: () => copyText(connection.name, '已复制数据源名') },
    { label: '复制 JDBC URL', action: () => copyText(connection.jdbcUrl || '', '已复制 JDBC URL') },
  ]);
}

function openNamespaceMenu(event, cs, namespace) {
  openContextMenu(event, [
    { label: '刷新表清单', action: () => loadTables(cs, namespace.name, { force: true }) },
    { label: '新建查询（默认库）', action: () => openQueryTab({ connectionId: cs.connectionId, schema: namespace.name }) },
    { sep: true },
    { label: '复制名称', action: () => copyText(namespace.name, '已复制') },
  ]);
}

function openTableMenu(event, cs, schema, table) {
  const qualified = (schema ? schema + '.' : '') + table.name;
  openContextMenu(event, [
    { label: '打开数据', action: () => openObjectTab('data', { connectionId: cs.connectionId, schema, table: table.name }) },
    { label: '打开 DDL', action: () => openObjectTab('ddl', { connectionId: cs.connectionId, schema, table: table.name }) },
    { label: '查看列', action: () => openObjectTab('columns', { connectionId: cs.connectionId, schema, table: table.name }) },
    { label: '查看索引', action: () => openObjectTab('indexes', { connectionId: cs.connectionId, schema, table: table.name }) },
    { label: '增量读取', action: () => openIncrementalTab({ connectionId: cs.connectionId, schema, table: table.name }) },
    { sep: true },
    { label: '在查询中打开', action: () => openQueryTab({ connectionId: cs.connectionId, schema, sql: 'SELECT * FROM ' + qualified + ' LIMIT 100' }) },
    { label: '刷新表结构', action: () => { const detailKey = treeTableKey(cs, schema, table.name); cs.details.delete(detailKey); loadTableDetail(cs, schema, table.name, table); } },
    { sep: true },
    { label: '复制名称', action: () => copyText(table.name, '已复制表名') },
    { label: '复制限定名', action: () => copyText(qualified, '已复制限定名') },
  ]);
}

