'use strict';

/**
 * AI 助手模块（可选）：SSE 流式对话（meta/chunk/thinking/step_break/tool_result/usage/done/error）。
 * 时间线严格按事件顺序渲染：文本块与工具卡交替追加；工具卡默认折叠，结果更新同一 callId。
 * 直连 harness：设置里的 Agent 地址 + /api/agent/stream，默认隐藏面板。
 */

function aiStreamDescription() {
  const base = readAgentBase();
  return base ? '直连 harness：' + base + '/api/agent/stream' : '未配置 Agent 地址';
}

function openAiPanel() {
  if (!readAgentBase()) {
    toast('请先在设置中填写 Agent 地址（如 http://127.0.0.1:18100）', 'info');
    return;
  }
  $('aiPanel').classList.add('open');
  $('aiToggle').classList.add('active');
  $('aiToggle').setAttribute('aria-expanded', 'true');
  if (typeof syncAiResizer === 'function') syncAiResizer();
  scrollAi();
  $('aiInput').focus();
}

function closeAiPanel() {
  $('aiPanel').classList.remove('open');
  $('aiToggle').classList.remove('active');
  $('aiToggle').setAttribute('aria-expanded', 'false');
  if (typeof syncAiResizer === 'function') syncAiResizer();
}

function toggleAiPanel() {
  if ($('aiPanel').classList.contains('open')) closeAiPanel();
  else openAiPanel();
}

function updateAiStatus(text) {
  const node = $('aiStatus');
  if (node) node.textContent = text || '';
}

function scrollAi() {
  const box = $('aiMessages');
  if (box) box.scrollTop = box.scrollHeight;
}

function appendUserMessage(text) {
  const empty = $('aiMessages').querySelector('.ai-empty');
  if (empty) empty.remove();
  const message = el('article', 'ai-msg ai-user');
  message.appendChild(el('div', 'ai-msg-meta', '我'));
  const content = el('div', 'ai-content markdown');
  content.innerHTML = renderMarkdown(text);
  message.appendChild(content);
  $('aiMessages').appendChild(message);
  scrollAi();
}

/* ------------------------------ 工具卡 ------------------------------ */

const TOOL_STATUS_LABEL = { begin: '调用中', running: '调用中', start: '调用中', ok: '完成', success: '完成', done: '完成', error: '失败', fail: '失败', failed: '失败' };

function toolStatusLabel(payload) {
  const status = String((payload && payload.status) || '').toLowerCase();
  return TOOL_STATUS_LABEL[status] || '调用中';
}

function parseToolArgs(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try {
    return JSON.parse(args);
  } catch {
    return { raw: String(args) };
  }
}

function summarizeToolCall(toolName, args) {
  const parsed = parseToolArgs(args);
  if (parsed.sql) return String(parsed.sql).replace(/\s+/g, ' ').trim();
  if (parsed.table) return parsed.table;
  if (parsed.connectionId) return parsed.connectionId;
  const text = JSON.stringify(parsed);
  return text === '{}' ? '' : clip(text, 90);
}

function parseToolResult(payload) {
  const raw = payload ? payload.result : null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function toolResultError(payload, data) {
  if (payload && payload.error) {
    return typeof payload.error === 'string' ? payload.error : (data && (data.error || data.message)) || String(payload.result || '工具执行失败');
  }
  if (data && (data.ok === false || data.error)) return String(data.error || data.message || '工具执行失败');
  return '';
}

function buildToolCard(payload) {
  const card = document.createElement('details');
  card.className = 'tool-card';
  card.dataset.callId = payload.callId || '';
  const head = document.createElement('summary');
  head.className = 'tool-card-head';
  const name = el('span', 'tool-name', payload.toolName || '工具');
  const brief = el('span', 'tool-brief', summarizeToolCall(payload.toolName, payload.args));
  const status = el('span', 'tool-status running', toolStatusLabel(payload));
  head.append(name, brief, status, el('span', 'tool-chevron'));
  const body = el('div', 'tool-card-body');
  card.append(head, body);
  scrollAi();
  return { node: card, brief, status, body, args: payload.args };
}

function setToolStatus(entry, payload, failed) {
  entry.status.className = 'tool-status ' + (failed ? 'fail' : 'ok');
  entry.status.textContent = failed ? '失败' : '完成';
  entry.node.classList.toggle('tool-error', Boolean(failed));
}

function toolMetric(label, value) {
  const item = el('span', 'tool-metric');
  item.appendChild(el('span', null, label + ' '));
  item.appendChild(el('b', null, String(value)));
  return item;
}

function toolMetrics(parts) {
  const box = el('div', 'tool-metrics');
  for (const part of parts) {
    if (part[1] === undefined || part[1] === null || part[1] === '') continue;
    box.appendChild(toolMetric(part[0], part[1]));
  }
  return box;
}

function toolCodeBlock(text) {
  const pre = el('pre', 'tool-code');
  const code = document.createElement('code');
  code.textContent = String(text);
  pre.appendChild(code);
  return pre;
}

function cellText(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderToolTable(columns, rows, maxRows = 20) {
  const names = (columns || []).map((column) => (typeof column === 'string' ? column : column.name)).filter(Boolean);
  const list = Array.isArray(rows) ? rows : [];
  if (!names.length) names.push(...inferRowColumns(list));
  if (!names.length) return el('div', 'tool-note', '（无数据行）');
  const wrap = el('div', 'tool-grid-wrap');
  const table = el('table', 'tool-grid');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of names) headRow.appendChild(el('th', null, name));
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  for (const row of list.slice(0, maxRows)) {
    const tr = document.createElement('tr');
    for (const name of names) {
      const value = Array.isArray(row) ? row[names.indexOf(name)] : row[name];
      const td = el('td', null, cellText(value));
      if (value === null || value === undefined) td.classList.add('cell-null');
      else if (typeof value === 'number') td.classList.add('cell-number');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  if (list.length > maxRows) {
    wrap.appendChild(el('div', 'tool-note', '仅预览前 ' + maxRows + ' 行，共 ' + list.length + ' 行'));
  }
  return wrap;
}

function inferRowColumns(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const first = rows[0];
  return first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : [];
}

function toolList(rows, maxItems = 30) {
  const list = el('div', 'tool-list');
  for (const row of rows.slice(0, maxItems)) {
    const item = el('div', 'tool-list-row');
    item.appendChild(el('span', 'tool-list-main', row[0]));
    if (row[1]) item.appendChild(el('span', 'tool-list-meta', row[1]));
    list.appendChild(item);
  }
  if (rows.length > maxItems) list.appendChild(el('div', 'tool-note', '仅显示前 ' + maxItems + ' 项，共 ' + rows.length + ' 项'));
  return list;
}

function renderQueryToolBody(body, data, entry) {
  const sql = data.sql || parseToolArgs(entry.args).sql || '';
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const rowCount = data.rowCount !== undefined ? data.rowCount : rows.length;
  body.appendChild(toolMetrics([
    ['行数', rowCount],
    ['耗时', data.elapsedMs !== undefined ? fmtMs(data.elapsedMs) : ''],
    ['连接', data.connectionName || data.connectionId || ''],
  ]));
  if (sql) body.appendChild(toolCodeBlock(sql));
  body.appendChild(renderToolTable(data.columns, rows));
  if (data.truncated) body.appendChild(el('div', 'tool-note', '结果已截断'));
}

function renderExecuteToolBody(body, data, entry) {
  const sql = data.sql || parseToolArgs(entry.args).sql || '';
  body.appendChild(toolMetrics([
    ['影响行数', data.affectedRows !== undefined ? data.affectedRows : ''],
    ['耗时', data.elapsedMs !== undefined ? fmtMs(data.elapsedMs) : ''],
  ]));
  if (sql) body.appendChild(toolCodeBlock(sql));
}

function renderTablesToolBody(body, data) {
  const tables = Array.isArray(data.tables) ? data.tables : [];
  body.appendChild(toolMetrics([['表/视图', data.total !== undefined ? data.total : tables.length]]));
  body.appendChild(toolList(tables.map((table) => {
    const meta = [];
    if (table.type) meta.push(table.type);
    if (table.rows !== undefined && table.rows !== null) meta.push(table.rows + ' 行');
    if (table.schema) meta.push(table.schema);
    return [table.name || table.table || '', meta.join(' · ')];
  })));
}

function renderDescribeToolBody(body, data) {
  const columns = Array.isArray(data.columns) ? data.columns : [];
  body.appendChild(toolMetrics([
    ['列', columns.length],
    ['行数', data.rowCount !== undefined ? data.rowCount : ''],
    ['类型', data.kind || ''],
  ]));
  body.appendChild(toolList(columns.map((column) => {
    const meta = [column.type || ''];
    if (column.primaryKey) meta.push('PK');
    if (column.nullable === false) meta.push('NOT NULL');
    return [column.name || '', meta.join(' · ')];
  }), 50));
}

function renderConnectionsToolBody(body, data) {
  const connections = Array.isArray(data.connections) ? data.connections : [];
  body.appendChild(toolMetrics([['连接', data.total !== undefined ? data.total : connections.length]]));
  body.appendChild(toolList(connections.map((connection) => {
    const meta = [];
    if (connection.kind) meta.push(connection.kind);
    if (connection.status) meta.push(connection.status);
    if (connection.tables !== undefined) meta.push(connection.tables + ' 表');
    return [connection.name || connection.id || '', meta.join(' · ')];
  })));
}

function renderJsonToolBody(body, data) {
  body.appendChild(toolCodeBlock(JSON.stringify(data, null, 2)));
}

function renderToolBody(entry, payload) {
  const data = parseToolResult(payload);
  const failed = toolResultError(payload, data);
  entry.body.replaceChildren();
  if (failed) {
    entry.body.appendChild(el('div', 'tool-card-error', failed));
    setToolStatus(entry, payload, true);
    return;
  }
  setToolStatus(entry, payload, false);
  if (!data) {
    entry.body.appendChild(el('div', 'tool-note', '工具未返回内容'));
    return;
  }
  switch (payload.toolName) {
    case 'db_query':
    case 'db_table_sample':
      renderQueryToolBody(entry.body, data, entry);
      break;
    case 'db_execute':
      renderExecuteToolBody(entry.body, data, entry);
      break;
    case 'db_list_tables':
      renderTablesToolBody(entry.body, data);
      break;
    case 'db_describe_table':
      renderDescribeToolBody(entry.body, data);
      break;
    case 'db_list_connections':
      renderConnectionsToolBody(entry.body, data);
      break;
    default:
      renderJsonToolBody(entry.body, data);
      break;
  }
}

/* ------------------------------ 助手气泡 ------------------------------ */

function createAssistantBubble() {
  const root = el('article', 'ai-msg ai-assistant');
  const meta = el('div', 'ai-msg-meta', 'AI 助手');
  const thinking = document.createElement('details');
  thinking.className = 'ai-thinking hidden';
  const thinkingPre = document.createElement('pre');
  thinking.append(el('summary', null, '思考过程'), thinkingPre);
  const timeline = el('div', 'ai-timeline');
  const status = el('div', 'ai-msg-status hidden');
  root.append(meta, thinking, timeline, status);
  $('aiMessages').appendChild(root);
  scrollAi();

  const toolMap = new Map();
  let thinkingText = '';
  let stepCount = 0;
  let activeText = null;
  let textBlocks = 0;
  let finalText = '';

  function ensureTextBlock() {
    if (activeText) return activeText;
    const node = el('div', 'ai-content markdown');
    timeline.appendChild(node);
    activeText = { node, buffer: '' };
    textBlocks += 1;
    return activeText;
  }

  const api = {
    root,
    thinking(delta) {
      thinking.classList.remove('hidden');
      thinkingText += delta;
      thinkingPre.textContent = thinkingText;
      scrollAi();
    },
    chunk(delta, fullText) {
      if (fullText) finalText = fullText;
      if (!delta) return;
      const block = ensureTextBlock();
      block.buffer += delta;
      block.node.innerHTML = renderMarkdown(block.buffer);
      scrollAi();
    },
    setStatus(text) {
      status.classList.toggle('hidden', !text);
      status.textContent = text || '';
    },
    stepBreak(payload) {
      const key = payload.callId || 'step-' + (++stepCount);
      if (toolMap.has(key)) {
        const entry = toolMap.get(key);
        if (!entry.result && payload.status) {
          entry.status.textContent = toolStatusLabel(payload);
          entry.status.className = 'tool-status running';
        }
        return;
      }
      // 时间线：工具卡之后出现的文本必须另起一段，排在工具卡下方。
      activeText = null;
      const entry = buildToolCard(payload);
      entry.callId = key;
      timeline.appendChild(entry.node);
      toolMap.set(key, entry);
    },
    toolResult(payload) {
      activeText = null;
      let entry = payload.callId ? toolMap.get(payload.callId) : null;
      if (!entry) {
        for (const value of [...toolMap.values()].reverse()) {
          if (!value.result) {
            entry = value;
            break;
          }
        }
      }
      if (!entry) {
        entry = buildToolCard(payload);
        entry.callId = payload.callId || '';
        timeline.appendChild(entry.node);
        if (entry.callId) toolMap.set(entry.callId, entry);
      }
      entry.result = payload.result;
      renderToolBody(entry, payload);
      scrollAi();
    },
    usage(payload) {
      if (payload && payload.totalTokens !== undefined) {
        api.setStatus('tokens ' + payload.totalTokens
          + (payload.tokensPerSecond ? ' · ' + payload.tokensPerSecond + ' tok/s' : ''));
      }
    },
    done(data) {
      root.classList.add('done');
      if (!textBlocks && data && data.text) {
        const node = el('div', 'ai-content markdown');
        node.innerHTML = renderMarkdown(data.text);
        timeline.appendChild(node);
        textBlocks += 1;
      }
      api.setStatus('完成' + (data && data.toolCalls ? ' · ' + data.toolCalls + ' 次工具调用' : ''));
      scrollAi();
    },
    error(message) {
      root.classList.add('error');
      timeline.appendChild(el('div', 'ai-error', message));
      scrollAi();
    },
  };
  return api;
}

async function sendAssistant() {
  const input = $('aiInput');
  const message = input.value.trim();
  if (!message) return;
  if (state.ai.streaming) {
    toast('上一条回答还在生成中，可先点「停止」', 'info');
    return;
  }
  input.value = '';
  appendUserMessage(message);
  if (typeof noteAiUserMessage === 'function') noteAiUserMessage(message);
  const bubble = createAssistantBubble();
  state.ai.streaming = true;
  state.ai.controller = new AbortController();
  $('aiSend').disabled = true;
  $('aiStop').classList.remove('hidden');
  updateAiStatus('生成中…');
  bubble.setStatus('连接 ' + aiStreamDescription());

  try {
    const response = await fetch(aiStreamUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: typeof currentAiAgentId === 'function' ? currentAiAgentId() : AI_AGENT_ID,
        message,
      }),
      signal: state.ai.controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('text/event-stream')) {
      const detail = await response.text().catch(() => '');
      throw new Error('AI 流返回异常（HTTP ' + response.status + '）：' + clip(detail, 300));
    }
    await consumeSse(response.body, bubble);
  } catch (error) {
    if (error.name === 'AbortError') {
      bubble.setStatus('已停止');
    } else {
      bubble.error(error.message + '（请确认 Agent 地址可访问且 harness CORS 允许本页来源）');
      updateAiStatus('出错');
    }
  } finally {
    state.ai.streaming = false;
    state.ai.controller = null;
    $('aiSend').disabled = false;
    $('aiStop').classList.add('hidden');
    updateAiStatus('');
  }
}

async function consumeSse(stream, bubble) {
  if (!stream) throw new Error('浏览器不支持流式响应（response.body 为空）');
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const ctx = { text: '' };
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frame;
    while ((frame = nextSseFrame(buffer))) {
      buffer = buffer.slice(frame.end);
      if (frame.frame.trim()) handleSseFrame(frame.frame, bubble, ctx);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleSseFrame(buffer, bubble, ctx);
}

function nextSseFrame(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { frame: buffer.slice(0, crlf), end: crlf + 4 };
  return { frame: buffer.slice(0, lf), end: lf + 2 };
}

function handleSseFrame(frame, bubble, ctx) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return;
  const raw = dataLines.join('\n');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { content: raw };
  }
  switch (event) {
    case 'meta':
      bubble.setStatus('Agent 会话：' + (data.agentId || ''));
      break;
    case 'chunk':
      ctx.text += data.content || '';
      bubble.chunk(data.content || '', ctx.text);
      break;
    case 'thinking':
      bubble.thinking(data.content || '');
      break;
    case 'step_break':
      bubble.stepBreak(data);
      bubble.setStatus('调用工具：' + (data.toolName || ''));
      break;
    case 'tool_result':
      bubble.toolResult(data);
      break;
    case 'usage':
      bubble.usage(data);
      break;
    case 'finish':
      break;
    case 'done':
      bubble.done(data);
      break;
    case 'error':
      bubble.error((data.code ? data.code + '：' : '') + (data.message || '未知错误'));
      break;
    default:
      break;
  }
}

/* ------------------------------ Markdown 渲染 ------------------------------ */

function renderMarkdown(text) {
  const source = escapeHtml(text);
  const blocks = [];
  let output = source.replace(/```([\w-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    blocks.push('<pre class="md-code"><code>' + code.replace(/\n$/, '') + '</code></pre>');
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });
  output = extractMarkdownTables(output, blocks);
  output = output.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/^#{1,4}\s+(.+)$/gm, '<h4>$1</h4>');
  output = output.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  output = output.replace(/(<li>.*<\/li>\n?)+/g, (match) => '<ul>' + match + '</ul>');
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const paragraphs = output.split(/\n{2,}/).map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    if (/^<(h4|ul|pre|li|div|table)/.test(trimmed) || /^[\u0000\u0001]\d+[\u0000\u0001]$/.test(trimmed)) return trimmed;
    return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
  });
  output = paragraphs.join('');
  output = output.replace(/[\u0000\u0001](\d+)[\u0000\u0001]/g, (match, index) => blocks[Number(index)] || '');
  return output || '<p></p>';
}

function markdownInline(text) {
  return text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const text = line.trim();
  if (!text.includes('-')) return false;
  return /^\|?[\s:|-]+\|?$/.test(text) && /-{2,}/.test(text);
}

function extractMarkdownTables(output, blocks) {
  const lines = output.split('\n');
  const result = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line.startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitTableRow(lines[index]);
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[cursor]));
        cursor += 1;
      }
      blocks.push(renderMarkdownTable(header, rows));
      result.push('\u0001' + (blocks.length - 1) + '\u0001');
      index = cursor;
    } else {
      result.push(lines[index]);
      index += 1;
    }
  }
  return result.join('\n');
}

function renderMarkdownTable(header, rows) {
  const head = '<tr>' + header.map((cell) => '<th>' + markdownInline(cell) + '</th>').join('') + '</tr>';
  const body = rows.map((row) => '<tr>' + header.map((cell, cellIndex) => {
    const value = row[cellIndex] === undefined ? '' : row[cellIndex];
    return '<td>' + markdownInline(value) + '</td>';
  }).join('') + '</tr>').join('');
  return '<div class="md-table-wrap"><table class="md-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

