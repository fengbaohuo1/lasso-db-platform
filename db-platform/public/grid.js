'use strict';

/**
 * 结果网格与只读视图：粘性表头、行号、排序、单元格/整行复制、CSV 导出；
 * DDL / 列 / 索引视图；后端新端点缺失时的归一化与降级合成。
 */

/* ------------------------------ 数据归一化 ------------------------------ */

function normalizeColumns(rawColumns) {
  return (rawColumns || []).map((item) => {
    if (typeof item === 'string') return { name: item, type: '' };
    const name = item.name || item.column || item.columnName || '';
    return {
      ...item,
      name,
      type: item.type || item.dataType || item.typeName || '',
      length: item.length !== undefined ? item.length : (item.columnSize !== undefined ? item.columnSize : null),
      decimals: item.decimals !== undefined ? item.decimals : (item.decimalDigits !== undefined ? item.decimalDigits : null),
      nullable: item.nullable !== undefined ? item.nullable : (item.isNullable !== undefined ? item.isNullable : null),
      defaultValue: item.defaultValue !== undefined
        ? item.defaultValue
        : (item.columnDefault !== undefined ? item.columnDefault : null),
      primaryKey: Boolean(item.primaryKey !== undefined ? item.primaryKey : item.pk),
      autoIncrement: Boolean(item.autoIncrement !== undefined ? item.autoIncrement : item.isAutoIncrement),
      comment: item.comment || item.remarks || '',
      ordinal: item.ordinal !== undefined ? item.ordinal : (item.position !== undefined ? item.position : null),
    };
  }).filter((item) => item.name);
}

function normalizeResult(data) {
  const source = data || {};
  const columns = normalizeColumns(source.columns);
  const rows = source.rows || [];
  return {
    columns,
    rows,
    rowCount: source.rowCount !== undefined ? source.rowCount : rows.length,
    total: source.total !== undefined ? source.total : null,
    elapsedMs: source.elapsedMs !== undefined ? source.elapsedMs : null,
    truncated: Boolean(source.truncated),
    orderBy: source.orderBy || null,
    desc: Boolean(source.desc),
    table: source.table || null,
    sql: source.sql || null,
  };
}

function normalizeTableDetail(data, fallback) {
  const source = data || {};
  const base = fallback || {};
  const columns = normalizeColumns(source.columns).map((column, index) => {
    const rawType = column.type || '';
    const hasSize = !/\(/.test(rawType) && Number(column.length || 0) > 0;
    const displayType = hasSize
      ? rawType + '(' + column.length + (Number(column.decimals || 0) > 0 ? ',' + column.decimals : '') + ')'
      : rawType;
    return {
      ...column,
      type: displayType,
      nullable: column.nullable !== undefined ? column.nullable : null,
      defaultValue: column.defaultValue !== undefined ? column.defaultValue : null,
      primaryKey: Boolean(column.primaryKey),
      autoIncrement: Boolean(column.autoIncrement),
      comment: column.comment || '',
      ordinal: column.ordinal !== undefined ? column.ordinal : (column.position !== undefined ? column.position : index + 1),
    };
  });
  const primaryKey = Array.isArray(source.primaryKey) ? source.primaryKey
    : (Array.isArray(source.primaryKeys) ? source.primaryKeys
      : columns.filter((column) => column.primaryKey).map((column) => column.name));
  const indexes = (source.indexes || []).map((index) => ({
    name: index.name || index.indexName || '',
    unique: Boolean(index.unique),
    columns: index.columns || (index.column ? [index.column] : []),
  }));
  const foreignKeys = (source.foreignKeys || []).map((fk) => ({
    name: fk.name || fk.fkName || '',
    columns: fk.columns || (fk.column ? [fk.column] : []),
    refSchema: fk.refSchema || '',
    refTable: fk.refTable || fk.referencedTable || '',
    refColumns: fk.refColumns || (fk.refColumn ? [fk.refColumn] : []),
  }));
  return {
    schema: source.schema || base.schema || '',
    table: source.table || base.table || '',
    kind: source.kind || base.kind || 'TABLE',
    rowCount: source.rowCount !== undefined ? source.rowCount : (base.rowCount ?? null),
    comment: source.comment || '',
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    ddl: source.ddl || '',
  };
}

function extractDdl(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  const keys = ['ddl', 'sql', 'text', 'content', 'definition'];
  for (const key of keys) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key];
  }
  return '';
}

function quoteIdent(connection, name) {
  const ident = String(name || '');
  if (connection && connection.type === 'mysql') {
    return '`' + ident.replaceAll('`', '``') + '`';
  }
  return '"' + ident.replaceAll('"', '""') + '"';
}

/** 后端 ddl 端点缺失时：按字段元数据合成近似 DDL（明确标注）。 */
function synthesizeDdl(detail, connection, tableName, kind) {
  const table = detail.table || tableName;
  const lines = ['-- 后端未提供 ddl 端点：以下为前端根据字段元数据生成的近似 DDL，仅供参考'];
  if (kind === 'VIEW' || detail.kind === 'VIEW') {
    lines.push('-- 视图 ' + table + ' 的定义需要后端 DDL 支持（SHOW CREATE VIEW / 系统表查询）');
    return lines.join('\n');
  }
  const qualified = detail.schema
    ? quoteIdent(connection, detail.schema) + '.' + quoteIdent(connection, table)
    : quoteIdent(connection, table);
  lines.push('CREATE TABLE ' + qualified + ' (');
  const parts = [];
  for (const column of detail.columns) {
    const pk = detail.primaryKey.includes(column.name);
    let part = '  ' + quoteIdent(connection, column.name) + ' ' + (column.type || 'VARCHAR(255)');
    if (column.autoIncrement) part += ' AUTO_INCREMENT';
    if (column.nullable === false) part += ' NOT NULL';
    if (column.defaultValue !== null && column.defaultValue !== undefined && !column.autoIncrement) {
      part += ' DEFAULT ' + (/^-?\d+(\.\d+)?$/.test(String(column.defaultValue))
        ? column.defaultValue : "'" + String(column.defaultValue).replaceAll("'", "''") + "'");
    }
    if (pk && detail.primaryKey.length === 1) part += ' PRIMARY KEY';
    parts.push(part);
  }
  if (detail.primaryKey.length > 1) {
    parts.push('  PRIMARY KEY (' + detail.primaryKey.map((name) => quoteIdent(connection, name)).join(', ') + ')');
  }
  lines.push(parts.join(',\n'));
  lines.push(');');
  return lines.join('\n');
}

/* ------------------------------ 网格渲染 ------------------------------ */

let gridState = null;

function cellText(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * @param {HTMLElement} host
 * @param {object} result normalizeResult 产物
 * @param {{sortable?:boolean,onSort?:Function,emptyText?:string,fileName?:string,rowNumbers?:boolean}} options
 */
function renderResultGrid(host, result, options = {}) {
  clear(host);
  const columns = result.columns || [];
  if (!columns.length) {
    host.appendChild(el('div', 'empty', options.emptyText || '（无结果列）'));
    gridState = null;
    return;
  }
  gridState = {
    columns: columns.map((column) => column.name),
    rows: result.rows || [],
    fileName: options.fileName || 'result',
  };
  const table = el('table', 'grid-table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const rowNumbers = options.rowNumbers !== false;
  if (rowNumbers) {
    const corner = document.createElement('th');
    corner.className = 'rownum';
    corner.textContent = '#';
    headRow.appendChild(corner);
  }
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column.name;
    th.title = column.name + (column.type ? ' · ' + column.type : '');
    if (column.type) {
      const typeNode = el('span', 'col-type', column.type);
      th.appendChild(typeNode);
    }
    if (options.sortable) {
      th.classList.add('sortable');
      if (options.orderBy === column.name) th.classList.add(options.desc ? 'sorted-desc' : 'sorted-asc');
      th.addEventListener('click', () => options.onSort && options.onSort(column.name));
      th.addEventListener('contextmenu', (event) => {
        openContextMenu(event, [
          { label: '按该列排序（升序）', action: () => options.onSort && options.onSort(column.name) },
          { label: '复制列名', action: () => copyText(column.name, '已复制列名') },
        ]);
      });
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const rows = result.rows || [];
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = String(rowIndex);
    if (rowNumbers) {
      const numCell = document.createElement('td');
      numCell.className = 'rownum';
      numCell.textContent = String(rowIndex + 1);
      numCell.title = '右键复制整行';
      numCell.addEventListener('contextmenu', (event) => openRowMenu(event, rowIndex, row));
      numCell.addEventListener('click', () => {
        clearRowSelection(tbody);
        tr.classList.add('row-selected');
        if (options.onSelectRow) options.onSelectRow(rowIndex, row);
      });
      tr.appendChild(numCell);
    }
    columns.forEach((column) => {
      const td = document.createElement('td');
      const value = row ? row[column.name] : undefined;
      td.textContent = cellText(value);
      if (value === null || value === undefined) {
        td.classList.add('cell-null');
      } else if (typeof value === 'number') {
        td.classList.add('cell-number');
      } else if (typeof value === 'boolean') {
        td.classList.add('cell-bool');
      } else {
        td.title = cellText(value);
      }
      td.addEventListener('click', () => selectCell(td, tbody));
      td.addEventListener('dblclick', () => {
        if (options.editable && options.onUpdateCell) {
          if (options.canEdit && !options.canEdit()) return;
          startCellEdit(td, row, column.name, options);
        } else {
          copyText(cellText(value), '已复制单元格');
        }
      });
      td.addEventListener('contextmenu', (event) => openCellMenu(event, rowIndex, column.name, value));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = columns.length + (rowNumbers ? 1 : 0);
    td.textContent = options.emptyText || '执行成功，但没有数据行';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
  host.scrollTop = 0;
}

function startCellEdit(td, row, columnName, options) {
  const originalValue = row ? row[columnName] : undefined;
  const previousText = td.textContent;
  const input = document.createElement('input');
  input.className = 'cell-editor';
  input.type = 'text';
  input.value = originalValue === null || originalValue === undefined ? '' : String(originalValue);
  input.placeholder = originalValue === null || originalValue === undefined ? 'NULL' : '';
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();
  let settled = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    td.textContent = previousText;
  };
  const commit = async () => {
    if (settled) return;
    settled = true;
    td.textContent = '保存中…';
    try {
      await options.onUpdateCell(row, columnName, input.value);
    } catch {
      td.textContent = previousText;
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      restore();
    }
  });
  input.addEventListener('blur', restore);
}

function selectCell(td, tbody) {
  tbody.querySelectorAll('td.cell-selected').forEach((cell) => cell.classList.remove('cell-selected'));
  td.classList.add('cell-selected');
  state.selection = td;
}

function clearRowSelection(tbody) {
  tbody.querySelectorAll('tr.row-selected').forEach((tr) => tr.classList.remove('row-selected'));
}

/* ------------------------------ 网格右键菜单 / 复制 ------------------------------ */

function openCellMenu(event, rowIndex, columnName, value) {
  openContextMenu(event, [
    { label: '复制单元格', hint: '双击', action: () => copyText(cellText(value), '已复制单元格') },
    { label: '复制整行（TSV）', action: () => copyRow(rowIndex) },
    { label: '复制列名', action: () => copyText(columnName, '已复制列名') },
    { sep: true },
    { label: '导出 CSV（当前结果）', action: () => exportCsv(gridState.columns, gridState.rows, gridState.fileName) },
  ]);
}

function openRowMenu(event, rowIndex) {
  openContextMenu(event, [
    { label: '复制整行（TSV）', action: () => copyRow(rowIndex) },
    { label: '复制为 CSV 行', action: () => copyText(toCsvLine(rowIndex), '已复制 CSV 行') },
  ]);
}

function toCsvLine(rowIndex) {
  if (!gridState) return '';
  const row = gridState.rows[rowIndex] || {};
  return gridState.columns.map((column) => csvCell(row[column])).join(',');
}

function copyRow(rowIndex) {
  if (!gridState) return;
  const row = gridState.rows[rowIndex] || {};
  const text = gridState.columns.map((column) => cellText(row[column])).join('\t');
  copyText(text, '已复制整行');
}

function copySelectedCell() {
  const td = document.querySelector('.grid-table td.cell-selected');
  if (!td) return false;
  copyText(td.textContent, '已复制单元格');
  return true;
}

function exportActiveGridCsv() {
  if (!gridState || !gridState.rows) {
    toast('当前没有可导出的结果', 'error');
    return;
  }
  exportCsv(gridState.columns, gridState.rows, gridState.fileName);
}

/* ------------------------------ DDL 视图 ------------------------------ */

function highlightDdl(ddl, connection) {
  const keywords = /\b(CREATE|TABLE|VIEW|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|INDEX|NOT|NULL|DEFAULT|AUTO_INCREMENT|COMMENT|CONSTRAINT|CHARACTER|SET|COLLATE|ENGINE|USING|BTREE)\b/gi;
  const types = /\b(BIGINT|INT|INTEGER|SMALLINT|TINYINT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL|VARCHAR|CHAR|TEXT|LONGTEXT|DATE|DATETIME|TIMESTAMP|TIME|BOOLEAN|BOOL|BLOB|JSON|UUID)\b/gi;
  return String(ddl || '').split(/\n/).map((line) => {
    const escaped = escapeHtml(line);
    if (/^\s*--/.test(line)) return '<span class="comment">' + escaped + '</span>';
    return escaped
      .replace(keywords, (word) => '<span class="kw">' + word + '</span>')
      .replace(types, (word) => '<span class="type">' + word + '</span>');
  }).join('\n');
}

function renderDdlView(host, options) {
  clear(host);
  const panel = el('div', 'ddl-panel');
  if (options.note) {
    const banner = el('div', 'info-banner', options.note);
    panel.appendChild(banner);
  }
  const code = document.createElement('pre');
  code.className = 'ddl-code';
  code.innerHTML = highlightDdl(options.ddl || '', options.connection);
  panel.appendChild(code);
  host.appendChild(panel);
}

/* ------------------------------ 列 / 索引视图 ------------------------------ */

function renderColumnsView(host, detail, options = {}) {
  clear(host);
  const panel = el('div', 'detail-panel');
  if (options.note) panel.appendChild(el('div', 'info-banner', options.note));
  if (detail.comment) {
    const intro = el('div', 'detail-section');
    intro.appendChild(el('div', 'hint', '表注释：' + detail.comment));
    panel.appendChild(intro);
  }
  const section = el('div', 'detail-section');
  section.appendChild(el('div', 'detail-section-title',
    '列（' + detail.columns.length + '）' + (detail.rowCount !== null && detail.rowCount !== undefined ? ' · ' + detail.rowCount + ' 行' : '')));
  const table = el('table', 'detail-table');
  const header = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['#', '字段', '类型', '可空', '默认值', '主键', '自增', '备注']) {
    headRow.appendChild(el('th', null, label));
  }
  header.appendChild(headRow);
  table.appendChild(header);
  const tbody = document.createElement('tbody');
  detail.columns.forEach((column, index) => {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'muted', String(column.ordinal || index + 1)));
    tr.appendChild(el('td', 'mono', column.name));
    tr.appendChild(el('td', 'mono', column.type || ''));
    tr.appendChild(el('td', 'muted', column.nullable === true ? '可空' : (column.nullable === false ? '非空' : '')));
    tr.appendChild(el('td', 'mono muted', column.defaultValue === null || column.defaultValue === undefined ? '' : String(column.defaultValue)));
    tr.appendChild(el('td', null, column.primaryKey ? 'PK' : ''));
    tr.appendChild(el('td', 'muted', column.autoIncrement ? '是' : ''));
    tr.appendChild(el('td', 'muted', column.comment || ''));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);
  panel.appendChild(section);
  host.appendChild(panel);
}

function renderIndexesView(host, detail, options = {}) {
  clear(host);
  const panel = el('div', 'detail-panel');
  if (options.note) panel.appendChild(el('div', 'info-banner', options.note));

  const pkSection = el('div', 'detail-section');
  pkSection.appendChild(el('div', 'detail-section-title', '主键'));
  pkSection.appendChild(detail.primaryKey.length
    ? el('div', 'mono', detail.primaryKey.join(', '))
    : el('div', 'detail-empty', '未发现主键'));
  panel.appendChild(pkSection);

  const indexSection = el('div', 'detail-section');
  indexSection.appendChild(el('div', 'detail-section-title', '索引（' + detail.indexes.length + '）'));
  if (detail.indexes.length) {
    const table = el('table', 'detail-table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['索引名', '唯一', '列']) headRow.appendChild(el('th', null, label));
    head.appendChild(headRow);
    table.appendChild(head);
    const tbody = document.createElement('tbody');
    for (const index of detail.indexes) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', 'mono', index.name));
      tr.appendChild(el('td', 'muted', index.unique ? '唯一' : ''));
      tr.appendChild(el('td', 'mono', index.columns.join(', ')));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    indexSection.appendChild(table);
  } else {
    indexSection.appendChild(el('div', 'detail-empty', '没有索引信息'));
  }
  panel.appendChild(indexSection);

  if (detail.foreignKeys.length || options.showForeignKeys) {
    const fkSection = el('div', 'detail-section');
    fkSection.appendChild(el('div', 'detail-section-title', '外键（' + detail.foreignKeys.length + '）'));
    if (detail.foreignKeys.length) {
      const table = el('table', 'detail-table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['外键名', '列', '引用']) headRow.appendChild(el('th', null, label));
      head.appendChild(headRow);
      table.appendChild(head);
      const tbody = document.createElement('tbody');
      for (const fk of detail.foreignKeys) {
        const tr = document.createElement('tr');
        tr.appendChild(el('td', 'mono', fk.name));
        tr.appendChild(el('td', 'mono', fk.columns.join(', ')));
        const ref = [fk.refSchema, fk.refTable].filter(Boolean).join('.')
          + (fk.refColumns.length ? ' (' + fk.refColumns.join(', ') + ')' : '');
        tr.appendChild(el('td', 'mono', ref));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      fkSection.appendChild(table);
    } else {
      fkSection.appendChild(el('div', 'detail-empty', '没有外键信息'));
    }
    panel.appendChild(fkSection);
  }
  host.appendChild(panel);
}

