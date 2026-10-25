# DB Platform 封板发布说明（1.0.0，2026-10-25）

## 交付物（D:\study\产品）
| 文件 | 用途 |
| --- | --- |
| DB-Platform-Setup.exe | Windows 桌面安装包（NSIS，含内嵌 db-service 1.0.0 + 最新前端） |
| DB-Platform-Web.zip | Web 版整套（db-service.jar + db-platform BFF/前端 + start-all.ps1/stop-all.ps1） |
| db-service.jar | 仅数据源服务（可被 Agent/其它系统独立调用，接口见 AGENT_API.md） |
| AGENT_API.md | Agent 接口文档（注册/查询/schema/增量/行 CRUD） |
| SHA256SUMS-DB-Platform.txt | 上述文件校验和 |

## 架构
- **db-service**：独立 Spring Boot 数据源服务（默认 18090），管理数据源、元数据、查询/DDL、行 CRUD、增量读取，向 Agent 暴露 /api/agent/*。
- **db-platform**：纯管理平台（默认 18091，Node BFF 反代 db-service），深色无框 UI、三栏、标签、内联编辑、增量页签。
- **桌面端**：Tauri2 壳内嵌 db-service（固定端口 18210，独立 %APPDATA% 数据），无需 Node/harness。

## 快速开始
- 桌面：双击安装包 → 安装 → 启动“DB Platform”；数据/日志在 %APPDATA%\com.jnf.dbplatform.desktop\data。
- Web：解压 DB-Platform-Web.zip → powershell -ExecutionPolicy Bypass -File start-all.ps1 → http://127.0.0.1:18091（停止 stop-all.ps1）。
- Agent：启动 db-service.jar 后按 AGENT_API.md 调用 /api/agent/datasources/...。

## 封板前修复（严重）
- db-service：编辑数据源不再误清已保存密码；API Key 模式 CORS 预检放行；dataDir 含空格/PS5.1 中文脚本/端口冲突/重复实例等运维问题；产物固定 db-service.jar。
- db-platform：删除数据源后残留标签（点击会请求已删 id）已修；设置 maxRows 未生效已修；密码提示语义与后端一致（留空=保留已存密码，显式新密码且不勾选=清除旧密码）。
- 桌面端：release 端口固定 18210（避免与 Web 服务 18090 冲突）；安装包含最新 db-service 与前端；卸载清理快捷方式/注册表。

## 验证（封板轮）
- db-service：mvn test 16/16；最终 jar 错误路径/行 CRUD/增量/真实 MySQL 均通过。
- db-platform Web：18090/18091 真环境 30 步全链路，0 console error / 0 exception（final-01..31 截图）。
- 桌面安装包：静默安装 → 启动（18210）→ 树/数据/写模式 → 错误 SQL 40000 约 0.3s → 退出收尸 → 静默卸载干净；安装包内嵌 jar hash 与最终服务 jar 一致。
- Web zip：解压用 start-all.ps1 在 18290/18291 冒烟通过。

## 已知限制（小问题）
- 未签名：SmartScreen 可能提示未知发布者；应用数据目录不随卸载删除。
- 无连接池/请求限流/审计；驱动仅 H2 + MySQL；增量仅单列水位、只读。
- 行编辑/插入/删除后左侧表行数 badge 不自动刷新（刷新树恢复）。
- MySQL 部分历史注释在源库本身乱码（显示层能解码的已解码）。
- BFF /healthz 不探测 db-service（前端实际用 /api/health）；保存后树短暂显示“加载数据库…”。
- 桌面端 AI 面板默认隐藏，需在设置中填写 Agent 地址。