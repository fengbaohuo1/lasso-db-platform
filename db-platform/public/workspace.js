'use strict';

/**
 * 工作区三栏宽度：左树 | 中间编辑区 | 右 AI 面板。
 * 拖拽分隔条调整宽度，双击恢复默认，localStorage 记忆；AI 收起时中间自适应。
 */

const PANE_LAYOUT = {
  tree: { min: 220, max: 520, storage: 'dbm.ui.treeWidth' },
  ai: { min: 300, max: 620, storage: 'dbm.ui.aiWidth' },
};

function layoutPanel(kind) {
  return kind === 'ai' ? $('aiPanel') : document.querySelector('.tree-pane');
}

function readSavedWidth(kind) {
  const config = PANE_LAYOUT[kind];
  try {
    const raw = Number(localStorage.getItem(config.storage));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

function persistWidth(kind, width) {
  const config = PANE_LAYOUT[kind];
  try {
    localStorage.setItem(config.storage, String(Math.round(width)));
  } catch {
    // 隐私模式下不持久化
  }
}

function clampPaneWidth(kind, width) {
  const config = PANE_LAYOUT[kind];
  const viewportMax = Math.max(config.min, window.innerWidth - 560);
  return Math.round(Math.min(Math.max(width, config.min), Math.min(config.max, viewportMax)));
}

function setPaneWidth(kind, width) {
  const panel = layoutPanel(kind);
  if (!panel) return 0;
  const next = clampPaneWidth(kind, width);
  panel.style.flex = '0 0 ' + next + 'px';
  panel.style.width = next + 'px';
  panel.dataset.resized = '1';
  return next;
}

function resetPaneWidth(kind) {
  const panel = layoutPanel(kind);
  const config = PANE_LAYOUT[kind];
  if (!panel) return;
  panel.style.removeProperty('width');
  panel.style.removeProperty('flex');
  delete panel.dataset.resized;
  try {
    localStorage.removeItem(config.storage);
  } catch {
    // 忽略
  }
}

function syncAiResizer() {
  const handle = document.querySelector('[data-resizer="ai"]');
  if (!handle) return;
  handle.classList.toggle('hidden', !$('aiPanel').classList.contains('open'));
}

function bindPaneResize(kind) {
  const handle = document.querySelector('[data-resizer="' + kind + '"]');
  if (!handle) return;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const panel = layoutPanel(kind);
    if (!panel || (kind === 'ai' && !$('aiPanel').classList.contains('open'))) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const move = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      setPaneWidth(kind, kind === 'tree' ? startWidth + delta : startWidth - delta);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      const width = panel.getBoundingClientRect().width;
      if (width > 0) persistWidth(kind, width);
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => resetPaneWidth(kind));
}

function applySavedPaneWidths() {
  for (const kind of ['tree', 'ai']) {
    const saved = readSavedWidth(kind);
    if (saved) setPaneWidth(kind, saved);
  }
  syncAiResizer();
}

function bindLayout() {
  applySavedPaneWidths();
  bindPaneResize('tree');
  bindPaneResize('ai');
  window.addEventListener('resize', () => {
    for (const kind of ['tree', 'ai']) {
      const panel = layoutPanel(kind);
      if (!panel || !panel.dataset.resized) continue;
      setPaneWidth(kind, panel.getBoundingClientRect().width);
    }
  });
}

