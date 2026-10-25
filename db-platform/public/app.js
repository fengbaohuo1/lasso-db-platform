'use strict';

/**
 * 应用装配：工具栏、写模式、AI 面板事件、快捷键、搜索、初始化。
 */

/* ------------------------------ 主题 ------------------------------ */

const THEME_STORAGE_KEY = 'dbp-theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function syncThemeControl(theme) {
  const button = $('themeToggle');
  if (!button) return;
  const next = theme === 'dark' ? '浅色' : '深色';
  button.title = '切换到' + next + '主题';
  button.dataset.theme = theme;
}

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = normalized;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // 隐私模式下不持久化，仅本次生效
  }
  syncThemeControl(normalized);
}

function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

function bindTheme() {
  syncThemeControl(currentTheme());
  $('themeToggle').addEventListener('click', toggleTheme);
}

/* ------------------------------ 写模式 ------------------------------ */

function syncWriteToggle(on) {
  $('writeToggle').checked = on;
  document.body.classList.toggle('write-mode', on);
  renderStatusBar();
}

/** 写模式必须先确认 db-service 已以 allowWrite=true 启动；服务端没有运行期开关。 */
async function backendWriteAvailable() {
  try {
    const health = await requestJson(API_ROOT + '/health');
    return { available: Boolean(health && health.allowWrite), health };
  } catch (error) {
    toast('无法读取 db-service 健康状态：' + error.message, 'error');
    return { available: false, health: null };
  }
}

async function setWriteMode(on) {
  if (on && !state.writeMode) {
    const confirmed = window.confirm('开启写模式？\n\n'
      + '写模式只做前端二次确认；真正闸门是 db-service 的 allowWrite（启动参数 --db-service.allow-write=true）。\n'
      + '如果服务端未开启，前端会保持关闭。');
    if (!confirmed) {
      syncWriteToggle(false);
      return;
    }
    const check = await backendWriteAvailable();
    if (!check.available) {
      syncWriteToggle(false);
      state.writeMode = false;
      renderStatusBar();
      toast('db-service 未开启写操作：请以 --db-service.allow-write=true 重新启动服务', 'error');
      return;
    }
  }
  state.writeMode = on;
  syncWriteToggle(on);
  if (on) toast('写模式已开启：已确认 db-service allowWrite=true', 'info');
  else toast('写模式已关闭（后端 allowWrite 仍由服务启动参数控制）', 'info');
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindToolbar() {
  $('newQueryBtn').addEventListener('click', () => openQueryTab());
  $('runBtn').addEventListener('click', () => runActiveConsole());
  $('explainBtn').addEventListener('click', () => explainActiveConsole());
  $('exportBtn').addEventListener('click', () => exportActiveGridCsv());
  $('refreshBtn').addEventListener('click', () => refreshActiveView());
  $('refreshTreeBtn').addEventListener('click', () => refreshTree({ force: true }));
  $('writeToggle').addEventListener('change', (event) => setWriteMode(event.target.checked));

  const onSearch = debounce(async () => {
    state.tree.filter = $('treeSearch').value || '';
    renderTree();
    if (state.tree.filter.trim()) await ensureSearchCatalog();
  }, 250);
  $('treeSearch').addEventListener('input', onSearch);
  $('treeSearch').addEventListener('search', () => {
    state.tree.filter = $('treeSearch').value || '';
    renderTree();
  });
}

function bindAiEvents() {
  $('aiToggle').addEventListener('click', toggleAiPanel);
  $('aiClose').addEventListener('click', closeAiPanel);
  $('aiSend').addEventListener('click', sendAssistant);
  $('aiStop').addEventListener('click', () => state.ai.controller?.abort());
  $('aiInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendAssistant();
    }
  });
  $('aiMessages').addEventListener('click', (event) => {
    const button = event.target.closest('.ai-suggestion');
    if (!button) return;
    $('aiInput').value = button.dataset.question || button.textContent;
    sendAssistant();
  });
}

function isTextInput(element) {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === 'Enter') {
      if (activeTab() && activeTab().kind === 'query') {
        event.preventDefault();
        runActiveConsole();
      }
      return;
    }
    if (mod && (event.key === 't' || event.key === 'T')) {
      event.preventDefault();
      openQueryTab();
      return;
    }
    if (mod && (event.key === 'w' || event.key === 'W')) {
      event.preventDefault();
      closeActiveTab();
      return;
    }
    if (mod && (event.key === 'c' || event.key === 'C')) {
      if (!isTextInput(document.activeElement) && !window.getSelection().toString()) {
        if (copySelectedCell()) event.preventDefault();
      }
      return;
    }
    if (event.key === 'Escape') {
      closeContextMenu();
      if (!$('connectionModal').classList.contains('hidden')) closeConnectionModal();
      if (!$('settingsModal').classList.contains('hidden')) closeSettings();
    }
  });
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  loadLocalSettings();
  bindConnectionEvents();
  bindSettingsEvents();
  bindToolbar();
  bindTheme();
  bindAiEvents();
  bindKeyboard();
  bindLayout();
  bindTabMenu();
  syncAiAvailability();
  initAiSessions();
  syncWriteToggle(false);
  renderStatusBar();
  renderTabBar();

  try {
    await refreshTree();
  } catch (error) {
    toast('初始化对象树失败：' + error.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);


