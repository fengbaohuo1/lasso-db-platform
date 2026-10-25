'use strict';

/**
 * 设置：通用（查询上限 / 写闸门 / Agent 地址）+ 增量读取默认值。
 * 不再有模型渠道；AI 助手仅在配置 Agent 地址后可用（直连 harness）。
 */

const SETTINGS_STORAGE_KEY = 'dbp.settings.v1';
let settingsTab = 'general';

function loadLocalSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    state.settings.maxRows = clampNumber(raw.maxRows, 1, 500, 200);
    state.settings.incrementalLimit = clampNumber(raw.incrementalLimit, 1, 1000, 100);
    state.settings.agentBase = String(raw.agentBase || '');
  } catch {
    state.settings = { maxRows: 200, incrementalLimit: 100, agentBase: '' };
  }
  state.agentBase = state.settings.agentBase;
}

function saveLocalSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    // 隐私模式不持久化
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function bindSettingsEvents() {
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsModalClose').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (event) => {
    if (event.target === $('settingsModal')) closeSettings();
  });
  for (const button of document.querySelectorAll('.settings-tab')) {
    button.addEventListener('click', () => {
      settingsTab = button.dataset.settingsTab || 'general';
      for (const tab of document.querySelectorAll('.settings-tab')) {
        tab.classList.toggle('active', tab === button);
      }
      renderSettingsBody();
    });
  }
}

function openSettings() {
  $('settingsModal').classList.remove('hidden');
  renderSettingsBody();
}

function closeSettings() {
  $('settingsModal').classList.add('hidden');
}

function renderSettingsBody() {
  const host = $('settingsBody');
  clear(host);
  if (settingsTab === 'incremental') renderIncrementalSettings(host);
  else renderGeneralSettings(host);
}

function renderGeneralSettings(host) {
  const querySection = el('section', 'settings-section');
  querySection.appendChild(el('h4', null, '查询'));
  querySection.appendChild(el('p', 'hint', '查询返回行数上限（db-service 最大 500；超过会截断）。'));
  const maxRows = document.createElement('input');
  maxRows.type = 'number';
  maxRows.id = 'settingsMaxRows';
  maxRows.min = '1';
  maxRows.max = '500';
  maxRows.value = String(state.settings.maxRows || 200);
  querySection.appendChild(maxRows);
  host.appendChild(querySection);

  const writeSection = el('section', 'settings-section');
  writeSection.appendChild(el('h4', null, '写操作'));
  writeSection.appendChild(el('p', 'hint',
    '真正闸门在 db-service：启动时需 --db-service.allow-write=true。'
    + '顶部「写模式」开关会先读取 /api/health，服务端未开启时前端拒绝开启。'));
  const healthLine = el('p', 'hint', '服务状态：未检查');
  const check = el('button', 'btn small', '检查服务状态');
  check.addEventListener('click', async () => {
    healthLine.textContent = '服务状态：检查中…';
    try {
      const health = await requestJson(API_ROOT + '/health');
      healthLine.textContent = '服务状态：' + (health.ok ? '正常' : '异常')
        + ' · allowWrite=' + (health.allowWrite ? 'true（可写）' : 'false（只读）')
        + ' · dataDir=' + (health.dataDir || '-');
    } catch (error) {
      healthLine.textContent = '服务状态：读取失败（' + error.message + '）';
    }
  });
  writeSection.append(check, healthLine);
  host.appendChild(writeSection);

  const aiSection = el('section', 'settings-section');
  aiSection.appendChild(el('h4', null, 'AI 助手（可选）'));
  aiSection.appendChild(el('p', 'hint',
    '默认隐藏 AI 面板。填入 harness 地址后显示；AI 直连 harness /api/agent/stream，需 harness 允许 CORS。'));
  const agentInput = document.createElement('input');
  agentInput.type = 'text';
  agentInput.id = 'settingsAgentBase';
  agentInput.placeholder = '例如 http://127.0.0.1:18100（留空隐藏 AI）';
  agentInput.value = state.settings.agentBase || '';
  aiSection.appendChild(agentInput);
  const agentHint = el('p', 'hint', '当前：' + (state.agentBase || '未配置（AI 面板隐藏）'));
  aiSection.append(agentHint);
  host.appendChild(aiSection);

  const actions = el('div', 'settings-actions');
  const save = el('button', 'btn primary small', '保存设置');
  save.addEventListener('click', () => {
    state.settings.maxRows = clampNumber(maxRows.value, 1, 500, 200);
    const base = agentInput.value.trim().replace(/\/+$/, '');
    state.settings.agentBase = base;
    saveLocalSettings();
    setAgentBase(base);
    agentHint.textContent = '当前：' + (base || '未配置（AI 面板隐藏）');
    toast('设置已保存', 'success');
  });
  actions.appendChild(save);
  host.appendChild(actions);

  host.appendChild(el('p', 'hint',
    '数据源密码未勾选保存时只保留在 db-service 进程内存；服务重启后需重新输入。'));
}

function renderIncrementalSettings(host) {
  const section = el('section', 'settings-section');
  section.appendChild(el('h4', null, '增量读取默认值'));
  section.appendChild(el('p', 'hint',
    '“增量”页签先调用 /api/agent/datasources/{id}/incremental/register 注册表/水位列/主键，'
    + '再按 since 游标读取下一页；nextCursor 可直接作为下一次 since。'));
  const limitField = el('label', 'field');
  limitField.appendChild(el('span', null, '默认每页行数（1–1000）'));
  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.id = 'settingsIncrementalLimit';
  limitInput.min = '1';
  limitInput.max = '1000';
  limitInput.value = String(state.settings.incrementalLimit || 100);
  limitField.appendChild(limitInput);
  section.appendChild(limitField);
  const actions = el('div', 'settings-actions');
  const save = el('button', 'btn primary small', '保存默认值');
  save.addEventListener('click', () => {
    state.settings.incrementalLimit = clampNumber(limitInput.value, 1, 1000, 100);
    saveLocalSettings();
    toast('增量默认值已保存', 'success');
  });
  actions.appendChild(save);
  section.appendChild(actions);
  host.appendChild(section);
}
