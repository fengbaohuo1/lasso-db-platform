'use strict';

/**
 * 新建/编辑数据源弹窗：MySQL 字段拼 JDBC URL、H2 演示库只读、自定义 JDBC；
 * 测试/保存/删除走 db-service，保存后刷新对象树。密码未勾选保存时只保留在后端进程内存。
 */

function mysqlUrlFor(host, port, database) {
  return 'jdbc:mysql://' + host + ':' + port + '/' + database
    + '?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai'
    + '&characterEncoding=UTF-8&connectTimeout=5000';
}

function currentConnType() {
  return $('connType').value;
}

function syncConnectionFields() {
  const type = currentConnType();
  const isDemo = type === 'h2-demo';
  const isMysql = type === 'mysql';
  $('demoNotice').classList.toggle('hidden', !isDemo);
  $('mysqlFields').classList.toggle('hidden', !isMysql);
  $('credentialFields').classList.toggle('hidden', isDemo);
  $('advancedFields').classList.toggle('hidden', isDemo);
  if (isMysql) {
    if (!$('connPort').value) $('connPort').value = '3306';
    $('connUrl').placeholder = '留空则按主机/端口/数据库自动拼接';
    $('connTypeHint').textContent =
      'MySQL：填主机/端口/数据库/用户名后按字段拼接 JDBC URL（默认 3306；useSSL=false、connectTimeout=5000）。';
  } else if (type === 'custom') {
    $('connUrl').placeholder = 'jdbc:h2:mem:apptest;DB_CLOSE_DELAY=-1';
    $('connTypeHint').textContent =
      '自定义 JDBC：必须填写下方「高级：JDBC URL 覆盖」；db-service 内置 H2 与 MySQL 驱动。';
    $('advancedFields').open = true;
  } else {
    $('connTypeHint').textContent = '内置演示库用于体验，只读：不可修改或删除。';
  }
  for (const id of ['connType', 'connName', 'connHost', 'connPort', 'connDatabase',
    'connUser', 'connPassword', 'connSavePassword', 'connUrl']) {
    $(id).disabled = isDemo;
  }
  $('connectionSaveBtn').disabled = isDemo;
}

function buildConnectionBody() {
  const type = currentConnType();
  const body = {
    type,
    name: $('connName').value.trim(),
    user: $('connUser').value.trim(),
    password: $('connPassword').value,
    savePassword: $('connSavePassword').checked,
  };
  if (type === 'mysql') {
    body.host = $('connHost').value.trim();
    body.port = $('connPort').value.trim();
    body.database = $('connDatabase').value.trim();
  }
  const override = $('connUrl').value.trim();
  if (override) body.jdbcUrl = override;
  if (type === 'custom' && !override) {
    throw new Error('自定义类型需要填写 JDBC URL（展开「高级：JDBC URL 覆盖」）');
  }
  if (state.modalConnectionId) body.id = state.modalConnectionId;
  return body;
}

function connectionUnchanged(connection, body) {
  if (!connection || body.password) return false;
  if (body.type === 'h2-demo') return true;
  if (body.type === 'mysql') {
    return !body.jdbcUrl
      && body.host === (connection.host || '')
      && String(body.port || 3306) === String(connection.port || 3306)
      && body.database === (connection.database || '')
      && body.user === (connection.user || '');
  }
  return body.jdbcUrl === (connection.jdbcUrl || '');
}

function openConnectionModal(connectionId) {
  state.modalConnectionId = connectionId || null;
  const connection = connectionId ? connectionById(connectionId) : null;
  const isDemo = Boolean(connection && connection.kind === 'demo');
  $('connectionModalTitle').textContent = connection ? '编辑数据源 · ' + connection.name : '新建数据源';
  let type = 'mysql';
  if (isDemo) type = 'h2-demo';
  else if (connection && connection.type) type = connection.type === 'mysql' ? 'mysql' : 'custom';
  $('connType').value = type;
  $('connName').value = connection ? connection.name : '';
  $('connHost').value = connection ? (connection.host || '') : '';
  $('connPort').value = connection && connection.port ? String(connection.port) : (type === 'mysql' ? '3306' : '');
  $('connDatabase').value = connection ? (connection.database || '') : '';
  $('connUser').value = connection ? (connection.user || '') : '';
  $('connPassword').value = '';
  // 已保存过密码时默认勾选，避免再次保存时把已存密码静默清掉。
  $('connSavePassword').checked = Boolean(connection && connection.passwordSaved);
  $('connUrl').value = '';
  $('advancedFields').open = false;
  if (connection && type === 'mysql' && connection.jdbcUrl) {
    const generated = mysqlUrlFor(connection.host || '', connection.port || 3306, connection.database || '');
    if (connection.jdbcUrl !== generated) {
      $('connUrl').value = connection.jdbcUrl;
      $('advancedFields').open = true;
    }
  } else if (connection && type === 'custom') {
    $('connUrl').value = connection.jdbcUrl || '';
  }
  $('connTestResult').className = 'test-result hidden';
  $('connTestResult').textContent = '';
  const passwordOnly = connection ? connectionPasswordMemoryOnly(connection) : false;
  $('connPasswordState').classList.toggle('hidden', !passwordOnly);
  $('connPasswordState').textContent = passwordOnly
    ? '当前密码未落盘：仅本次运行有效，重启后请重新输入，或勾选「保存密码」。'
    : '';
  $('deleteConnectionBtn').disabled = !connection || isDemo;
  $('deleteConnectionBtn').classList.toggle('hidden', !connection);
  syncConnectionFields();
  $('connectionModal').classList.remove('hidden');
  if (!connection) $('connName').focus();
}

function closeConnectionModal() {
  $('connectionModal').classList.add('hidden');
  state.modalConnectionId = null;
}

async function testConnection() {
  const button = $('connectionTestBtn');
  const result = $('connTestResult');
  button.disabled = true;
  result.className = 'test-result';
  result.textContent = '测试中…';
  try {
    const connection = state.modalConnectionId ? connectionById(state.modalConnectionId) : null;
    if (!connection) {
      throw new Error('新数据源尚无 id：请先保存（保存时会连接测试），保存后再测试');
    }
    const data = await pluginPost('test-connection', { id: connection.id });
    if (data.ok) {
      result.classList.add('ok');
      result.textContent = '连接成功：' + (data.product || '') + ' ' + (data.version || '')
        + '（' + fmtMs(data.elapsedMs) + '）';
    } else {
      result.classList.add('fail');
      result.textContent = '连接失败：' + (data.error || '未知错误');
    }
  } catch (error) {
    result.classList.add('fail');
    result.textContent = '测试失败：' + error.message;
  } finally {
    button.disabled = false;
  }
}

async function saveConnection() {
  if (currentConnType() === 'h2-demo') {
    toast('内置演示库不可保存/覆盖', 'error');
    return;
  }
  const existing = state.modalConnectionId ? connectionById(state.modalConnectionId) : null;
  const passwordValue = $('connPassword').value;
  const savePassword = $('connSavePassword').checked;
  if (existing && existing.passwordSaved === true && !savePassword) {
    // db-service 的当前语义：密码留空时保留已保存密码；只有提供新密码且不保存时才清掉旧密码。
    if (passwordValue) {
      if (!window.confirm('未勾选「保存密码」：新密码只保留在 db-service 进程内存，'
        + '并会清除该数据源已保存的旧密码。\n确认继续？')) {
        $('connSavePassword').checked = true;
        return;
      }
    } else if (!window.confirm('db-service 当前语义：密码留空会保留已保存密码，'
      + '取消勾选「保存密码」不会清除已保存密码。\n如需清除，请重新输入密码且保持不勾选。\n确认继续保存（保留密码）？')) {
      $('connSavePassword').checked = true;
      return;
    }
  }
  let body;
  try {
    body = buildConnectionBody();
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  const button = $('connectionSaveBtn');
  button.disabled = true;
  try {
    const data = await pluginPost('save-connection', body);
    const saved = data && (data.datasource || data.connection) ? (data.datasource || data.connection) : (data || {});
    const targetId = saved.id || state.modalConnectionId;
    toast('数据源已保存：' + (saved.name || targetId), 'success');
    if (!targetId) throw new Error('后端未返回数据源 id');
    if (saved.passwordSaved === true) markPasswordOnlyInMemory(targetId, false);
    else if (passwordValue) markPasswordOnlyInMemory(targetId, true);
    else if (existing && existing.passwordSaved) markPasswordOnlyInMemory(targetId, true);
    else markPasswordOnlyInMemory(targetId, false);
    closeConnectionModal();
    await loadConnections();
    state.activeConnectionId = targetId;
    state.tree.cache.delete(targetId);
    renderTree();
    await expandConnection(targetId);
    renderTree();
  } catch (error) {
    toast('保存失败：' + error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function deleteConnection() {
  const connection = state.modalConnectionId ? connectionById(state.modalConnectionId) : null;
  if (!connection) return;
  if (!window.confirm('确定删除数据源「' + connection.name + '」（' + connection.id + '）？\n'
    + '只删除数据源配置，不影响数据库数据。')) {
    return;
  }
  const button = $('deleteConnectionBtn');
  button.disabled = true;
  try {
    await pluginPost('delete-connection', { id: connection.id });
    markPasswordOnlyInMemory(connection.id, false);
    toast('数据源已删除：' + connection.name, 'success');
    closeConnectionModal();
    // 数据源删除后它下面的标签已不可用：先关闭，避免残留标签继续请求已删除的 id。
    closeTabsForConnection(connection.id);
    state.tree.cache.delete(connection.id);
    state.activeConnectionId = null;
    await loadConnections();
    if (state.connections[0]) {
      state.activeConnectionId = state.connections[0].id;
      await expandConnection(state.activeConnectionId);
    }
    renderTree();
    renderTabBar();
    if (!activeTab()) renderActiveTab();
  } catch (error) {
    toast('删除失败：' + error.message, 'error');
    button.disabled = false;
  }
}

/* ------------------------------ 断开数据源 ------------------------------ */

/** 关闭某个连接下的全部标签（数据/DDL/列/索引/SQL）。 */
function closeTabsForConnection(connectionId) {
  const tabIds = state.tabs.filter((tab) => tab.connectionId === connectionId).map((tab) => tab.id);
  for (const tabId of tabIds) closeTab(tabId);
  return tabIds.length;
}

function applyDisconnected(connectionId) {
  state.tree.expanded.delete(TREE_KEY.conn(connectionId));
  state.tree.cache.delete(connectionId);
  markPasswordOnlyInMemory(connectionId, false);
  const connection = connectionById(connectionId);
  if (connection) {
    connection.passwordInMemory = false;
    connection.passwordCached = false;
    connection.passwordOnlyInMemory = false;
  }
  closeTabsForConnection(connectionId);
  if (state.activeConnectionId === connectionId) {
    const next = state.connections.find((item) => item.id !== connectionId);
    state.activeConnectionId = next ? next.id : null;
  }
  renderTree();
  if (!activeTab()) renderActiveTab();
  else renderStatusForTab(activeTab());
}

/**
 * 断开数据源：调用插件 POST disconnect（清空进程内密码/连接缓存），成功后收起连接树、
 * 关闭该连接的全部标签并清除“密码仅内存”标记；再次点击连接会重新加载对象树。
 */
async function disconnectConnection(connection) {
  if (!connection) return;
  let backendSupported = true;
  try {
    await pluginPost('disconnect', { connectionId: connection.id });
  } catch (error) {
    if (isMissingEndpoint(error)) {
      backendSupported = false;
    } else {
      toast('断开失败：' + error.message, 'error');
      return;
    }
  }
  applyDisconnected(connection.id);
  toast(backendSupported
    ? '已断开数据源：' + connection.name
    : '已断开本地视图：' + connection.name + '（后端未提供 disconnect）',
  backendSupported ? 'success' : 'info');
}

function bindConnectionEvents() {
  $('newConnectionBtn').addEventListener('click', () => openConnectionModal());
  $('connType').addEventListener('change', syncConnectionFields);
  $('connectionModalClose').addEventListener('click', closeConnectionModal);
  $('connectionTestBtn').addEventListener('click', testConnection);
  $('connectionSaveBtn').addEventListener('click', saveConnection);
  $('deleteConnectionBtn').addEventListener('click', deleteConnection);
  $('connectionModal').addEventListener('click', (event) => {
    if (event.target === $('connectionModal')) closeConnectionModal();
  });
}


