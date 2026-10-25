# AGENT_API · 数据源服务 Agent 接口

服务地址：`http://127.0.0.1:18090`（默认；`scripts\start.ps1` 启动）
所有响应统一为：

```json
{"code":"00000","info":"success","data":{...}}
```

- `code=00000` 成功；其它为错误码（HTTP 仍为 200）：`40000` 参数/业务错误，`40100` 鉴权失败，`50000` 服务内部错误。
- 若服务端设置了环境变量 `DB_SERVICE_API_KEY`，所有 `/api/**`（`/api/health` 除外）请求需带 `X-API-Key` 头。
- Agent 接口的“行数据”用**数组**返回（配合 `columns` 依次对应），以节省上下文。

## 1. 注册数据源

`POST /api/agent/datasources`

```bash
# MySQL
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources \
  -H 'Content-Type: application/json' \
  -d '{"type":"mysql","name":"业务库","host":"127.0.0.1","port":3306,"database":"app","user":"readonly","password":"***","savePassword":false}'

# 自定义 JDBC（H2/PG 等；驱动需在 classpath，当前内置 H2 + MySQL）
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources \
  -H 'Content-Type: application/json' \
  -d '{"type":"custom","name":"本地H2","jdbcUrl":"jdbc:h2:mem:demo;DB_CLOSE_DELAY=-1","user":"sa"}'

# 内置演示库（无需注册，直接拿到 id=demo）
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources \
  -H 'Content-Type: application/json' -d '{"type":"h2-demo","name":"demo"}'
```

响应：

```json
{"code":"00000","info":"success","data":{"id":"业务库","name":"业务库","type":"mysql","kind":"stored"}}
```

> 注册时会做一次连接测试，失败返回 `40000`；密码仅当 `savePassword=true` 时落盘。

## 2. 数据源清单

`GET /api/agent/datasources`

```bash
curl -s http://127.0.0.1:18090/api/agent/datasources
# {"data":{"datasources":[{"id":"demo","name":"内置演示库（H2）","type":"h2-demo"}],"total":1}}
```

## 3. schema 摘要（表 + 列）

`GET /api/agent/datasources/{id}/schema`

```bash
curl -s http://127.0.0.1:18090/api/agent/datasources/demo/schema
```

返回（节选）：`{datasourceId, dialect, namespaces, tableCount, tables:[{name,type,rowCount,comment,columns:[{name,type,nullable,primaryKey,autoIncrement,comment?}]}]}`，最多返回 200 张表。

## 4. 只读查询

`POST /api/agent/datasources/{id}/query`，body `{sql, maxRows?}`（maxRows 1-500，默认 200）。

```bash
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/demo/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT id, order_no, status FROM orders ORDER BY id","maxRows":3}'
```

```json
{"code":"00000","info":"success","data":{
  "datasourceId":"demo",
  "sql":"SELECT id, order_no, status FROM orders ORDER BY id",
  "columns":["id","order_no","status"],
  "rows":[[1,"SO20261001001","DONE"],[2,"SO20261003002","DONE"],[3,"SO20261005003","SHIPPED"]],
  "rowCount":3,"truncated":true,"elapsedMs":2}}
```

仅允许只读 SQL（SELECT/WITH/EXPLAIN/VALUES/SHOW/DESCRIBE）。

## 5. 增量：注册与读取

### 5.1 注册增量表

`POST /api/agent/datasources/{id}/incremental/register`

```bash
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/demo/incremental/register \
  -H 'Content-Type: application/json' \
  -d '{"table":"orders","watermarkColumn":"id","primaryKey":"id"}'
```

- `watermarkColumn`：单调递增/递增时间列（数字、TIMESTAMP/DATE/TIME 均可）；
- `primaryKey`：行主键列（用于配合行 CRUD 定位行）；
- 表/列必须是真实元数据（防注入），配置写入 `data/incremental.json`。

### 5.2 读取（游标翻页）

`GET /api/agent/datasources/{id}/incremental/read?table=orders&since=&limit=200`

- `since` 省略/为空：从最早记录开始；
- `nextCursor`：响应给下一页的 `since`（**字符串原样回传即可**，数字/时间格式由服务端处理）；
- `hasMore=true` 表示还有下一页；
- SQL 固定为 `SELECT * FROM <table> WHERE <watermark> > ? ORDER BY <watermark> ASC LIMIT ?`（值参数绑定）。

```bash
# 第一页
curl -s 'http://127.0.0.1:18090/api/agent/datasources/demo/incremental/read?table=orders&limit=3'
```

```json
{"code":"00000","info":"success","data":{
  "datasourceId":"demo","table":"orders","watermarkColumn":"id","primaryKey":"id",
  "since":null,"limit":3,"rowCount":3,"hasMore":true,"nextCursor":3,
  "rows":[{"id":1,"order_no":"SO20261001001","status":"DONE", "...":"..."}, ...]}}
```

```bash
# 下一页（用上一页的 nextCursor 作为 since）
curl -s 'http://127.0.0.1:18090/api/agent/datasources/demo/incremental/read?table=orders&since=3&limit=20'
```

翻页循环（伪代码）：

```text
cursor = ""
do {
  resp = GET .../incremental/read?table=T&since=<urlencode(cursor)>&limit=500
  process(resp.rows)
  cursor = resp.nextCursor
} while (resp.hasMore)
```

增量只读；如需 Agent 改数据，用下面的行 CRUD（同样受写闸门约束）。

## 6. Agent 行 CRUD（需服务端开启 permit：`db-service.allow-write=true`）

`POST /api/agent/datasources/{id}/rows/insert|update|delete`，请求体均需 `"confirmed":true`。

```bash
# insert → {affectedRows, generatedKeys}
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/demo/rows/insert \
  -H 'Content-Type: application/json' \
  -d '{"table":"customers","values":{"id":99,"name":"测试"},"confirmed":true}'

# update（pk 必须包含全部主键列；changes 不允许改主键）
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/demo/rows/update \
  -H 'Content-Type: application/json' \
  -d '{"table":"customers","pk":{"id":99},"changes":{"name":"测试2"},"confirmed":true}'

# delete
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/demo/rows/delete \
  -H 'Content-Type: application/json' \
  -d '{"table":"customers","pk":{"id":99},"confirmed":true}'
```

安全规则：参数化 SQL、列白名单来自元数据、无主键表拒绝 update/delete、列不存在/重复列/非主键 pk 均返回可读 `40000`。

## 7. 断开（清理内存密码）

`POST /api/agent/datasources/{id}/disconnect`

```bash
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/业务库/disconnect
# {"code":"00000","data":{"id":"业务库","disconnected":true}}
```

只清理该数据源的进程内密码缓存，不删除注册配置。

## 8. 其他（平台侧，Agent 也可用）

- `GET /api/datasources` / `POST /api/datasources` / `GET|PUT|DELETE /api/datasources/{id}` / `POST /{id}/test`
- `GET /{id}/namespaces`、`/tables?schema=`、`/table-detail?schema=&table=`、`/ddl?schema=&table=`
- `GET /{id}/data?table=&limit=&offset=&orderBy=&desc=&filter=`（`limit=0` 不分页，安全上限 50000）
- `POST /{id}/query`、`/execute`、`/explain`
- `POST /{id}/rows/insert|update|delete`
- `GET /api/health`（无需鉴权）

## 9. 限制与注意

- 查询默认上限 200 行（Agent query 可传 maxRows≤500）；`limit=0` 的全量读取仅用于数据浏览，最多 50000 行。
- 单页增量上限默认 1000（`db-service.incremental-max-limit`）。
- 仅内置 H2 与 MySQL 驱动；其它数据库需在 `pom.xml` 增加驱动依赖。
- 时间类型的水位/游标以服务端返回的字符串原样回传即可（服务端会按列类型转换）。
- 未设置 `DB_SERVICE_API_KEY` 时请仅监听本机回环地址，避免裸奔。
