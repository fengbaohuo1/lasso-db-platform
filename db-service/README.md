# db-service · 数据源服务（独立后端）

把 `db-manager` 里“连数据库、看元数据、查数据、改数据”的后端能力抽成**独立数据源服务**，
与数据库管理平台前端（`db-manager/platform`）解耦。服务只提供 HTTP API，不承载插件宿主，
也不依赖 jnf-harness。

- 技术栈：Spring Boot 3.3.5 / Java 17 / Maven
- 默认端口：**18090**
- 数据目录：`./data`（connections.json、demo.mv.db、incremental.json、logs）
- 统一响应：`{"code":"00000","info":"success","data":{...}}`，HTTP 恒为 200（业务码看 code）
- 面向 Agent 的紧凑接口：注册、schema、查询、**增量读取（watermark 游标翻页）**、行 CRUD
  —— 详见 [AGENT_API.md](AGENT_API.md)

> 当前是“能力拆分第一版（糙版）”：够用、可跑、可被 Agent/前端接入；后续再补鉴权、连接池、可观测性等。

## 快速开始

前置：JDK 17+、Maven 3.9+（离线构建需要本地仓库已有 Spring Boot 3.3.5 依赖，仓库已缓存）。

```powershell
# 1) 构建（含单测；也可 -DskipTests）
mvn -o -B package

# 2) 一键启动（默认 18090，写操作默认关闭；需要行编辑/execute 时加 -AllowWrite）
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -AllowWrite

# 3) 健康检查
curl http://127.0.0.1:18090/api/health

# 4) 一键停止（只停本脚本启动的进程）
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```

启动脚本支持：`-Port 18090`、`-DataDir <目录>`、`-AllowWrite`、`-ApiKey "密钥"`（进程环境变量 `DB_SERVICE_API_KEY`）、`-Build`（先离线打包）。
日志：`data/logs/db-service.log`（应用日志）、`db-service.out.log` / `db-service.err.log`（标准输出/错误）。

## 目录结构

```
db-service/
├─ pom.xml
├─ src/main/java/com/jnf/dbservice/
│  ├─ DbServiceApplication.java        # Spring Boot 入口
│  ├─ AppProperties.java               # db-service.* 配置
│  ├─ DbSupport.java                   # 元数据/DDL/查询/过滤/行 CRUD（H2+MySQL）
│  ├─ DataSourceRegistry.java          # 数据源注册表 + 连接打开 + 进程内密码缓存
│  ├─ ConnectionSpec.java / ConnectionStore.java
│  ├─ DemoSeeder.java                  # 内置 H2 演示库种子数据
│  ├─ IncrementalConfigStore.java      # data/incremental.json
│  ├─ IncrementalService.java          # 增量注册/读取（watermark 游标）
│  ├─ DataSourceController.java        # /api/datasources 注册 CRUD/test
│  ├─ DataController.java              # /api/datasources/{id}/... 元数据/数据/查询/写入/行编辑
│  ├─ AgentController.java             # /api/agent/datasources/... 紧凑接口
│  ├─ ApiKeyFilter.java / WebConfig.java / ApiErrorHandler.java / ApiResult.java
│  └─ Json.java
├─ src/test/java/com/jnf/dbservice/    # 14 个 H2 单测（含写闸门 / API Key / 增量）
├─ scripts/start.ps1, stop.ps1
├─ AGENT_API.md
└─ data/                               # 运行时生成（不版本化）
```

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `server.port` | 18090 | HTTP 端口 |
| `db-service.data-dir` | `./data` | 连接清单/演示库/增量配置/日志目录 |
| `db-service.allow-write` | `false` | 写操作总开关（execute、rows/*）；请求仍需 `confirmed=true` |
| `db-service.max-rows` | 200 | query/浏览默认行数上限（query 可传 maxRows，1-500） |
| `db-service.incremental-max-limit` | 1000 | 增量读取单页上限 |
| 环境变量 `DB_SERVICE_API_KEY` | 空 | 非空时 `/api/**`（/api/health 除外）必须带 `X-API-Key` |

启动参数示例：`java -jar target/db-service.jar --server.port=18090 --db-service.data-dir=./data --db-service.allow-write=true`

## API 总览

统一前缀 `/api`，完整 curl 与字段见 [AGENT_API.md](AGENT_API.md) 与各 Controller。

**数据源（平台/管理）**
- `GET/POST /api/datasources`，`GET/PUT/DELETE /api/datasources/{id}`，`POST /{id}/test`
- 类型：`mysql`（host/port/database）、`custom`（jdbcUrl）、`h2-demo`（内置演示库，id 恒为 `demo`）

**元数据与数据**
- `GET /{id}/namespaces`、`/tables?schema=`、`/table-detail?schema=&table=`、`/ddl?...`
- `GET /{id}/data?table=&limit=&offset=&orderBy=&desc=&filter=`：`limit=0` 表示不分页（上限 50000，`truncated`/`rowCap` 标记）
- `POST /{id}/query`（只读）、`/execute`（allowWrite+confirmed）、`/explain`
- `POST /{id}/rows/insert|update|delete`：参数化 SQL、按真实列白名单、主键完整校验（无主键拒绝）

**Agent 紧凑接口**：`/api/agent/datasources` 注册/清单、`/{id}/schema`、`/{id}/query`、`/{id}/incremental/register|read`、`/{id}/rows/*`、`/{id}/disconnect`。

## 安全与密码

- 密码仅当 `savePassword=true` 时写入 `data/connections.json`；否则只保留在**进程内存缓存**（注册/更新/测试收到密码即缓存，进程重启失效），列表/详情接口不返回密码。
- 写操作双闸门：`db-service.allow-write=true` **且** 请求体 `confirmed=true`；行编辑只允许修改非主键列、主键必须完整。
- 可选 `X-API-Key` 鉴权（值来自环境变量 `DB_SERVICE_API_KEY`）；未设置时仅适合本地回环。
- SQL 防注入：查询只读白名单（SELECT/WITH/EXPLAIN/VALUES/SHOW/DESCRIBE）；表/列名必须命中真实元数据后加引号；过滤条件禁分号与 SQL 注释；行编辑全部参数绑定。

## 数据与备份

`data/` 全部为运行时数据：`connections.json`（数据源清单，可能含勾选保存的密码 → 注意权限）、
`demo.mv.db`、`incremental.json`、`logs/`、启动时临时 `service.json`。升级前建议停服并备份整个 `data/`。

## 测试与实测记录（2026-10-25）

- `mvn -o -B test` → **16/16 通过**（数据源 CRUD/密码落盘与编辑保留、demo 元数据、limit=0、query/execute、行 CRUD、写闸门、API Key、CORS 预检、Agent 注册/schema/查询/增量/行 CRUD）。
- `mvn -o -B package` → 可执行 jar `target/db-service.jar` ≈ 25 MB（含 H2 + MySQL 驱动）。
- 实跑 18090（`start.ps1 -AllowWrite`）：
  - `/api/health` → `00000 allowWrite=true`；
  - 注册 H2 demo → `id=demo`；tables=5；`table-detail orders` 6 列；`query` 分组统计 4 行；
  - Agent schema 5 表；Agent query 3 行（truncated=true）；
  - 增量 `orders`（watermark=id）：第一页 3 行 `hasMore=true nextCursor=3`，第二页 9 行到 id=12；
  - 自定义 H2 内存源：建表 + 行 insert/update/delete 各 affectedRows=1；`limit=0` 返回 3 行；缺 `confirmed` 返回 `40000`；非主键 pk 返回 `40000`；
  - 真实 MySQL `106.54.3.66:13306/ai_ssh`：注册/测试 ok（`product=MySQL`），Agent query 2 行，增量 `chat_message`（watermark=created_at）第一页 2 行 `hasMore=true`，用返回的 `nextCursor` 继续第二页 3 行；`connections.json` 中无明文密码（未勾选保存）。
- `scripts\stop.ps1` 停止后 18090 释放，`data/` 保留。

## 与 db-manager 的关系

- 本服务是从 `db-manager/plugin` 抽出的**独立后端**，复用 ConnectionSpec/ConnectionStore/DbSupport/Json/DemoSeeder 等逻辑；
- 现有 `db-manager` 未被修改；
- 数据库管理平台前端后续把 API base 指到 `http://127.0.0.1:18090/api` 即可（前端拆分是后续任务）；
- 不依赖 jnf-harness / 插件 reload 机制。

## 封板验收修复（2026-10-25）

严重问题（已修复 + 单测/实跑验证）：
1. **编辑数据源会静默清空已保存密码**（只改名称/端口时后续连不上）：编辑未提供密码时不再改写持久化密码，保留原值；断开内存缓存后仍可用已保存密码连接。
2. **API Key 模式下 CORS 预检 OPTIONS 被 40100 拦截**（浏览器前端不可用）：预检请求放行给 Spring CORS；40100 响应也补上 `Access-Control-Allow-Origin`，前端可读取错误。
3. **Windows 路径含空格时启动失败/数据写错位置**：`start.ps1` 对 jar/dataDir/日志路径逐个加引号，空格路径已实测正常。
4. **Windows PowerShell 5.1 下脚本中文乱码导致解析失败**：`start.ps1`/`stop.ps1` 改为 UTF-8 with BOM，PS 5.1/7 均可执行。
5. **运维可用性**：`-Build` 在实例运行时会因 jar 被锁定失败 → 现提前给出可读提示“先 stop”；同端口数据目录不一致/端口被占/同一 data 目录二次启动均有明确中文错误；`stop.ps1` 可重复执行，且按“项目根目录 + db-service + 端口”校验命令行，能停止旧版 `db-service-0.1.0.jar` 启动的实例。
6. 打包产物固定为 `target/db-service.jar`（避免带版本号 jar 被运行中进程锁定后无法重新打包）。

已知小问题（未修，记录）：
- 同名数据源重复注册会自动加后缀 id（如 `-2`），没有“已存在”提示；
- `start.ps1` 幂等复用时不会校验/更新 API Key 配置（不同 key 需先停止再启动）；
- 无连接池、无请求级限流/审计；驱动仅 H2/MySQL；Agent schema 最多 200 张表；
- 编辑时若显式输入新密码但未勾选“保存密码”，会清掉旧持久化密码并仅存内存（符合“仅勾选才落盘”的语义，但需前端提示）。
