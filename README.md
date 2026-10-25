# lasso-db-platform

数据库管理平台：**数据源服务（db-service）+ 管理平台（db-platform）+ Tauri 桌面端**。

- `db-service`：独立 Spring Boot 数据源服务，管理数据源、元数据、查询/DDL、行级编辑、增量读取，并向 Agent 暴露 `/api/agent/*` 接口。
- `db-platform`：纯管理平台（Node BFF + 原生前端），深色无框工作台：数据源注册、库表树、数据/DDL/查询/解释、单元格编辑、标签管理、三栏拖拽、增量页签。
- `db-platform/desktop`：Tauri 2 桌面壳，内嵌 db-service（固定端口 18210），不需要 Node/harness。

## 快速开始

### 桌面端（Windows）

从 Releases 下载 `DB-Platform-Setup.exe`，安装后启动「DB Platform」。
数据与日志在 `%APPDATA%\com.jnf.dbplatform.desktop\data`。

### Web 版

从 Releases 下载 `DB-Platform-Web.zip`，解压后：

```powershell
powershell -ExecutionPolicy Bypass -File start-all.ps1
```

- 管理平台：http://127.0.0.1:18091
- 数据源服务：http://127.0.0.1:18090
- 停止：`stop-all.ps1`

前置：JDK 17+、Node 18+。

### Agent 接数据源

单独启动 `db-service.jar`（或使用 Web 版内自带的服务），按 [`db-service/AGENT_API.md`](db-service/AGENT_API.md) 调用：

```bash
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources \
  -H 'Content-Type: application/json' \
  -d '{"type":"h2-demo"}'

curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/demo/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status","maxRows":10}'

# 增量（水位列游标）
curl -s -X POST http://127.0.0.1:18090/api/agent/datasources/demo/incremental/register \
  -H 'Content-Type: application/json' -d '{"table":"orders","watermarkColumn":"id","primaryKey":"id"}'
curl -s 'http://127.0.0.1:18090/api/agent/datasources/demo/incremental/read?table=orders&since=0&limit=100'
```

## 仓库结构

```
db-service/            # 数据源服务后端（Spring Boot 3.3.5 / Java 17）
db-platform/           # 管理平台（BFF + public 前端）
db-platform/desktop/   # Tauri 2 桌面壳（内嵌 db-service）
RELEASE-NOTES-1.0.0.md # 封板发布说明与已知限制
```

## 构建

```powershell
# 数据源服务
cd db-service; mvn -o -B test; mvn -o -B package   # target/db-service.jar

# Web 平台（需先启动 db-service）
cd db-platform; powershell -ExecutionPolicy Bypass -File start.ps1

# 桌面端
cd db-platform/desktop
# 先把 db-service/target/db-service.jar 复制为 runtime/db-service-0.1.0.jar
cd src-tauri; cargo build
# 安装包：tauri build（NSIS）
```

## 相关仓库

- [lasso-harness](https://github.com/fengbaohuo1/lasso-harness)：Agent Harness 底座
- [lasso-harness-desktop](https://github.com/fengbaohuo1/lasso-harness-desktop)：Harness 桌面壳

## 已知限制

见 [RELEASE-NOTES-1.0.0.md](RELEASE-NOTES-1.0.0.md)（未签名、无连接池/限流/审计、增量仅单列水位等）。