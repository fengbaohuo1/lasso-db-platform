'use strict';

/**
 * 增量读取页签：表/水位列/since/limit → rows + nextCursor。
 * 先注册（table/watermarkColumn/primaryKey），再读取 /api/agent/datasources/{id}/incremental/read。
 */

/* ------------------------------ 增量读取页签 ------------------------------ */

function incrementalTableList(tab) {
  const cs = connectionTreeState(tab.connectionId);
  const tables = cs ? cs.tables.get(tab.schema || '') : null;
  return (tables || []).filter((item) => item.type !== 'VIEW');
}

function preferredWatermark(columns) {
  const score = (column) => {
    const type = String(column.type || '').toUpperCase();
    const name = String(column.name || '').toLowerCase();
    if (type.includes('TIMESTAMP') || type.includes('DATETIME')) return 100;
    if (type.includes('DATE')) return 90;
    if (type.includes('INT')) return 50;
    if (name.includes('time') || name.includes('_at') || name.includes('date')) return 40;
    return 0;
  };
  return [...columns].sort((a, b) => score(b) - score(a))[0];
}

function incrementalColumns(tab) {
  const source = tab.state.result;
  const rows = Array.isArray(source) ? source : ((source && source.rows) || []);
  const names = [];
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (!names.includes(key)) names.push(key);
    }
  }
  return names.map((name) => ({ name, type: '' }));
}

function renderIncrementalResult(tab, host) {
  clear(host);
  if (tab.state.error) {
    host.appendChild(errorPanelNode(tab.state.error));
    return;
  }
  if (tab.state.loading) {
    host.appendChild(el('div', 'grid-loading', '读取增量…'));
    return;
  }
  if (!tab.state.result) {
    host.appendChild(el('div', 'grid-loading', '选择表/水位列后点击「读取」；增量读取只返回水位大于 since 的行。'));
    return;
  }
  const result = {
    columns: incrementalColumns(tab),
    rows: tab.state.result,
    rowCount: tab.state.result.length,
    total: tab.state.result.length,
    truncated: tab.state.hasMore,
  };
  if (!result.rows.length) {
    host.appendChild(el('div', 'grid-loading', '没有新的增量行'));
    return;
  }
  renderResultGrid(host, result, { sortable: false, fileName: tab.table + '-incremental', editable: false, primaryKey: [] });
}

async function doIncrementalRead(tab) {
  const table = tab.state.table;
  const watermark = tab.state.watermarkColumn;
  const primaryKey = tab.state.primaryKey;
  if (!table) {
    tab.state.error = '请选择表';
    renderActiveTab();
    return;
  }
  if (!watermark) {
    tab.state.error = '请选择水位列（watermarkColumn）';
    renderActiveTab();
    return;
  }
  if (!primaryKey) {
    tab.state.error = '该表没有主键，无法注册增量读取';
    renderActiveTab();
    return;
  }
  tab.state.loading = true;
  tab.state.error = '';
  renderActiveTab();
  try {
    await incrementalRegister(tab.connectionId, { table, watermarkColumn: watermark, primaryKey });
    const limit = Math.max(1, Math.min(1000, Number(tab.state.limit) || 100));
    const data = await incrementalRead(tab.connectionId, table, tab.state.since, limit);
    tab.state.result = data.rows || [];
    tab.state.nextCursor = data.nextCursor;
    tab.state.hasMore = Boolean(data.hasMore);
    tab.state.readAt = new Date().toLocaleTimeString();
    tab.state.limit = limit;
  } catch (error) {
    tab.state.result = null;
    tab.state.error = '增量读取失败：' + error.message;
  } finally {
    tab.state.loading = false;
    if (state.activeTabId === tab.id) renderActiveTab();
  }
}

function renderIncrementalTab(tab) {
  const host = $('tabContent');
  const panel = el('div', 'object-panel');
  const toolbar = el('div', 'object-toolbar');
  toolbar.appendChild(el('span', 'object-title', qualifiedName(tab.schema, tab.table) || '增量读取'));
  toolbar.appendChild(el('span', 'object-sub', '增量'));
  toolbar.appendChild(el('span', 'spacer'));
  const refresh = el('button', 'btn small', '刷新');
  refresh.addEventListener('click', () => {
    tab.state.result = null;
    tab.state.error = '';
    tab.state.nextCursor = null;
    renderActiveTab();
  });
  toolbar.appendChild(refresh);
  panel.appendChild(toolbar);

  const controls = el('div', 'incremental-controls');
  const tableField = el('label', 'field');
  tableField.appendChild(el('span', null, '表'));
  const tableSelect = document.createElement('select');
  const tables = incrementalTableList(tab);
  for (const table of tables) {
    const option = el('option', null, table.name);
    option.value = table.name;
    if (table.name === tab.state.table) option.selected = true;
    tableSelect.appendChild(option);
  }
  if (!tables.length) {
    const option = el('option', null, tab.state.table || '（无表）');
    option.value = tab.state.table || '';
    tableSelect.appendChild(option);
  }
  if (!tab.state.table) tab.state.table = tableSelect.value;
  tableField.appendChild(tableSelect);
  controls.appendChild(tableField);

  const watermarkField = el('label', 'field');
  watermarkField.appendChild(el('span', null, '水位列'));
  const watermarkSelect = document.createElement('select');
  watermarkField.appendChild(watermarkSelect);
  controls.appendChild(watermarkField);

  const sinceField = el('label', 'field');
  sinceField.appendChild(el('span', null, 'since（可选）'));
  const sinceInput = document.createElement('input');
  sinceInput.type = 'text';
  sinceInput.placeholder = '留空从最早开始 / 填 nextCursor';
  sinceInput.value = tab.state.since || '';
  sinceField.appendChild(sinceInput);
  controls.appendChild(sinceField);

  const limitField = el('label', 'field narrow');
  limitField.appendChild(el('span', null, 'limit'));
  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.min = '1';
  limitInput.max = '1000';
  limitInput.value = String(tab.state.limit || 100);
  limitField.appendChild(limitInput);
  controls.appendChild(limitField);

  const readButton = el('button', 'btn primary small', '读取');
  readButton.disabled = true;
  readButton.title = '等待字段加载后再读取';
  readButton.addEventListener('click', () => {
    tab.state.table = tableSelect.value;
    tab.state.watermarkColumn = watermarkSelect.value;
    tab.state.since = sinceInput.value.trim();
    tab.state.limit = Math.max(1, Math.min(1000, Number(limitInput.value) || 100));
    doIncrementalRead(tab);
  });
  controls.appendChild(readButton);
  panel.appendChild(controls);

  const meta = el('div', 'object-toolbar incremental-meta');
  if (tab.state.result) {
    meta.appendChild(el('span', 'hint',
      '行数 ' + tab.state.result.length
      + ' · nextCursor ' + (tab.state.nextCursor === null || tab.state.nextCursor === undefined ? '-' : String(tab.state.nextCursor))
      + (tab.state.hasMore ? ' · 还有更多' : ' · 已到末尾')
      + (tab.state.readAt ? ' · ' + tab.state.readAt : '')));
    if (tab.state.nextCursor !== null && tab.state.nextCursor !== undefined) {
      const next = el('button', 'btn small', '用 nextCursor 继续');
      next.addEventListener('click', () => {
        sinceInput.value = String(tab.state.nextCursor);
        tab.state.since = String(tab.state.nextCursor);
        readButton.click();
      });
      meta.appendChild(next);
    }
  } else {
    meta.appendChild(el('span', 'hint', '注册 + 读取分别调用 /api/agent/datasources/{id}/incremental/{register,read}'));
  }
  panel.appendChild(meta);

  const gridWrap = el('div', 'grid-wrap');
  panel.appendChild(gridWrap);
  host.appendChild(panel);
  renderIncrementalResult(tab, gridWrap);

  // 水位列与主键来自 table-detail；表变化时重新加载。
  const applyDetail = (detail) => {
    const columns = (detail && detail.columns) || [];
    watermarkSelect.textContent = '';
    const preferred = preferredWatermark(columns);
    for (const column of columns) {
      const option = el('option', null, column.name + '  ' + (column.type || ''));
      option.value = column.name;
      if (column.name === tab.state.watermarkColumn || (!tab.state.watermarkColumn && preferred && column.name === preferred.name)) {
        option.selected = true;
        tab.state.watermarkColumn = column.name;
      }
      watermarkSelect.appendChild(option);
    }
    if (!tab.state.watermarkColumn) tab.state.watermarkColumn = watermarkSelect.value;
    tab.state.primaryKey = detail && detail.primaryKey && detail.primaryKey.length ? detail.primaryKey[0] : '';
    readButton.disabled = false;
    readButton.title = tab.state.primaryKey ? '注册并读取增量' : '该表没有主键，无法注册增量';
    if (!tab.state.primaryKey) readButton.disabled = true;
  };

  const loadDetail = async () => {
    try {
      const data = await pluginGet('table-detail', {
        connectionId: tab.connectionId,
        schema: tab.schema || '',
        table: tab.state.table,
      });
      applyDetail(normalizeTableDetail(data, { schema: tab.schema, table: tab.state.table }));
    } catch (error) {
      watermarkSelect.textContent = '';
      watermarkSelect.appendChild(el('option', null, '（字段加载失败）'));
      tab.state.error = '加载表结构失败：' + error.message;
      renderIncrementalResult(tab, gridWrap);
    }
  };

  tableSelect.addEventListener('change', () => {
    tab.state.table = tableSelect.value;
    tab.state.watermarkColumn = '';
    tab.state.primaryKey = '';
    tab.state.result = null;
    tab.state.nextCursor = null;
    tab.state.error = '';
    readButton.disabled = true;
    loadDetail();
  });
  watermarkSelect.addEventListener('change', () => { tab.state.watermarkColumn = watermarkSelect.value; });
  sinceInput.addEventListener('input', () => { tab.state.since = sinceInput.value; });
  limitInput.addEventListener('input', () => { tab.state.limit = Number(limitInput.value) || 100; });

  if (!tables.length) {
    pluginGet('tables', { connectionId: tab.connectionId, schema: tab.schema || '' })
      .then((data) => {
        const cs = connectionTreeState(tab.connectionId);
        cs.tables.set(tab.schema || '', data.tables || []);
        renderActiveTab();
      })
      .catch(() => {});
  }
  loadDetail();
}

