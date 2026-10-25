'use strict';

/**
 * AI 会话管理：独立 agentId、本地会话列表、历史回放、删除。
 * 会话列表存 localStorage；切换会话时清空面板，再从 harness 控制台端点回放 user/assistant 文本。
 */

const AI_SESSIONS_KEY = 'dbm.ai.sessions.v1';
const AI_CURRENT_SESSION_KEY = 'dbm.ai.currentSession.v1';

const aiSessionState = {
  sessions: [],
  currentId: '',
  emptyHtml: '',
  replayToken: '',
};

function aiSessionNewId() {
  return 'db-ai-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function aiSessionList() {
  return aiSessionState.sessions;
}

function aiSessionCurrent() {
  return aiSessionList().find((session) => session.id === aiSessionState.currentId) || null;
}

function currentAiAgentId() {
  return aiSessionState.currentId || AI_AGENT_ID;
}

function loadAiSessionStore() {
  let sessions = [];
  try {
    const raw = JSON.parse(localStorage.getItem(AI_SESSIONS_KEY) || '[]');
    if (Array.isArray(raw)) {
      sessions = raw
        .filter((item) => item && typeof item.id === 'string' && item.id)
        .map((item) => ({
          id: item.id,
          title: String(item.title || '新对话'),
          createdAt: Number(item.createdAt) || Date.now(),
          titled: Boolean(item.titled),
        }));
    }
  } catch {
    sessions = [];
  }
  let currentId = '';
  try {
    currentId = String(localStorage.getItem(AI_CURRENT_SESSION_KEY) || '');
  } catch {
    currentId = '';
  }
  let fresh = false;
  if (!sessions.length) {
    const session = createAiSession();
    sessions = [session];
    currentId = session.id;
    fresh = true;
  } else if (!sessions.some((session) => session.id === currentId)) {
    currentId = sessions[0].id;
  }
  aiSessionState.sessions = sessions;
  aiSessionState.currentId = currentId;
  persistAiSessions();
  return fresh;
}

function persistAiSessions() {
  try {
    localStorage.setItem(AI_SESSIONS_KEY, JSON.stringify(aiSessionList()));
    localStorage.setItem(AI_CURRENT_SESSION_KEY, aiSessionState.currentId || '');
  } catch {
    // 隐私模式下不持久化
  }
}

function createAiSession() {
  return { id: aiSessionNewId(), title: '新对话', createdAt: Date.now(), titled: false };
}

function renderAiSessionHeader() {
  const session = aiSessionCurrent();
  const title = session ? (session.title || '新对话') : '新对话';
  $('aiSessionTitle').textContent = title;
  $('aiSessionBtn').title = title + ' · 切换会话（' + aiSessionList().length + ' 个）';
  $('aiDeleteSession').disabled = !session;
}

function resetAiMessages() {
  const box = $('aiMessages');
  if (!box) return;
  box.innerHTML = aiSessionState.emptyHtml;
}

function appendReplayAssistant(text) {
  const empty = $('aiMessages').querySelector('.ai-empty');
  if (empty) empty.remove();
  const article = el('article', 'ai-msg ai-assistant');
  article.appendChild(el('div', 'ai-msg-meta', 'AI 助手'));
  const content = el('div', 'ai-content markdown');
  content.innerHTML = renderMarkdown(text);
  article.appendChild(content);
  $('aiMessages').appendChild(article);
}

async function replayAiSession() {
  const box = $('aiMessages');
  if (!box) return;
  resetAiMessages();
  const sessionId = aiSessionState.currentId;
  const token = String(Date.now()) + Math.random();
  aiSessionState.replayToken = token;
  if (!sessionId || !readAgentBase()) return;
  try {
    const data = await requestJson(
      agentConsoleUrl('/sessions/' + encodeURIComponent(sessionId) + '/messages'),
    );
    if (aiSessionState.replayToken !== token || aiSessionState.currentId !== sessionId) return;
    const messages = Array.isArray(data) ? data : (data && Array.isArray(data.messages) ? data.messages : []);
    for (const item of messages) {
      if (!item) continue;
      const role = String(item.role || '').toUpperCase();
      const text = String(item.text || '').trim();
      if (!text) continue;
      if (role === 'USER') appendUserMessage(text);
      else if (role === 'ASSISTANT') appendReplayAssistant(text);
    }
    scrollAi();
  } catch (error) {
    if (aiSessionState.replayToken === token) {
      toast('回放会话失败：' + error.message, 'error');
    }
  }
}

function setCurrentAiSession(session) {
  aiSessionState.currentId = session.id;
  persistAiSessions();
  renderAiSessionHeader();
}

function newAiSession() {
  if (state.ai.streaming) {
    toast('回答还在生成中，请先停止再新建对话', 'info');
    return;
  }
  const session = createAiSession();
  aiSessionList().unshift(session);
  setCurrentAiSession(session);
  resetAiMessages();
  closeContextMenu();
  $('aiInput').focus();
}

async function switchAiSession(sessionId) {
  if (!sessionId || sessionId === aiSessionState.currentId) return;
  if (state.ai.streaming) {
    toast('回答还在生成中，请先停止再切换对话', 'info');
    return;
  }
  const session = aiSessionList().find((item) => item.id === sessionId);
  if (!session) return;
  setCurrentAiSession(session);
  await replayAiSession();
  $('aiInput').focus();
}

async function deleteAiSession() {
  const session = aiSessionCurrent();
  if (!session) return;
  if (state.ai.streaming) {
    toast('回答还在生成中，请先停止再删除对话', 'info');
    return;
  }
  try {
    await requestJson(agentConsoleUrl('/sessions/' + encodeURIComponent(session.id)), { method: 'DELETE' });
  } catch (error) {
    toast('删除对话失败：' + error.message, 'error');
    return;
  }
  aiSessionState.sessions = aiSessionList().filter((item) => item.id !== session.id);
  const next = createAiSession();
  aiSessionState.sessions.unshift(next);
  setCurrentAiSession(next);
  resetAiMessages();
  closeContextMenu();
  toast('已删除对话：' + clip(session.title || '新对话', 20), 'success');
}

function openAiSessionMenu() {
  const button = $('aiSessionBtn');
  const rect = button.getBoundingClientRect();
  const items = aiSessionList().map((session) => ({
    label: clip(session.title || '新对话', 24),
    hint: session.id === aiSessionState.currentId ? '当前' : formatAiSessionTime(session.createdAt),
    action: () => { switchAiSession(session.id); },
  }));
  items.push({ sep: true });
  items.push({
    label: '新建对话',
    hint: '清空面板',
    action: () => newAiSession(),
  });
  openContextMenu({
    preventDefault() {},
    stopPropagation() {},
    clientX: rect.left,
    clientY: rect.bottom + 2,
  }, items);
}

function formatAiSessionTime(value) {
  const date = new Date(Number(value) || Date.now());
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return hh + ':' + mm;
  return (date.getMonth() + 1) + '/' + date.getDate();
}

function noteAiUserMessage(text) {
  const session = aiSessionCurrent();
  if (!session) return;
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return;
  if (!session.titled) {
    session.title = clip(value, 20);
    session.titled = true;
    persistAiSessions();
    renderAiSessionHeader();
  }
}

function bindAiSessionEvents() {
  $('aiSessionBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    openAiSessionMenu();
  });
  $('aiNewSession').addEventListener('click', newAiSession);
  $('aiDeleteSession').addEventListener('click', deleteAiSession);
}

function initAiSessions() {
  aiSessionState.emptyHtml = $('aiMessages').innerHTML;
  const fresh = loadAiSessionStore();
  renderAiSessionHeader();
  bindAiSessionEvents();
  if (!fresh) replayAiSession();
}

