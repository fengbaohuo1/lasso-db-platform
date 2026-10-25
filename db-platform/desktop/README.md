# DB Platform 桌面端（Tauri 2 独立桌面应用）

把 db-platform（数据源工作台前端）+ 内嵌 **db-service** 后端装进一个原生窗口：启动即用，
不依赖 Node BFF、不需要手动执行 `start.ps1`。

```
<desktop>/
├─ README.md                 # 本文件
├─ .gitignore                # 排除 target/runtime jar/验证产物
├─ runtime/
│  └─ db-service-0.1.0.jar   # 内嵌后端（从 ../../db-service/target 复制，发布时随安装包进资源目录）
├─ scripts/
│  ├─ cdp-check.mjs          # CDP 断言：对象树 / 12 行数据 / 写模式 / 控制台错误
│  └─ verify-window.ps1      # 一键验证：窗口 / 端口 / 数据目录 / 退出收尸 + PrintWindow 截图
└─ src-tauri/
   ├─ Cargo.toml             # 版本线与 jnf-desktop 对齐（复用 cargo 缓存）
   ├─ tauri.conf.json        # 窗口 1440×900、productName/identifier、打包 ../runtime、frontendDist=../../public
   ├─ capabilities/          # 最小权限面（页面只做 fetch，无 IPC）
   ├─ icons/                 # 复用 jnf-desktop 图标
   └─ src/lib.rs             # 启动内嵌 db-service / 健康等待 / 创建窗口 / 退出收尸
```

## 1. 前置条件

| 用途 | 要求 |
| --- | --- |
| 运行 | JDK 17+（`java` 在 PATH，或设置 `JAVA_HOME` / `DBP_JAVA`）、WebView2（Windows 10/11 自带） |
| 构建 | Rust stable（`cargo`）、Windows MSVC 工具链 |
| 内嵌 jar | `runtime/db-service-0.1.0.jar`（由 `../../db-service` 构建后复制） |

## 2. 构建与运行

```powershell
# 准备内嵌后端（从 db-service 构建产物复制；已复制过可跳过）
copy ..\..\db-service\target\db-service-0.1.0.jar runtime\

cd src-tauri
cargo build                 # 或 cargo build --release
```

产物：`desktop\src-tauri\target\debug\db-platform-desktop.exe`（release 为 `target\release\`）。

```powershell
# 直接启动（debug 默认端口 18210，避开 Web 版占用的 18090/18091）
.\desktop\src-tauri\target\debug\db-platform-desktop.exe
```

端口规则：

| 场景 | 默认端口 | 说明 |
| --- | --- | --- |
| debug 构建 | `18210` | 避免与运行中的 Web 版 db-service（18090）/BFF（18091）冲突 |
| release 构建 | `18210` | 封板约定：与 debug 一致，固定不随构建配置变化 |
| 环境变量 `DBP_SERVICE_PORT` | 覆盖上两项 | 例如 `$env:DBP_SERVICE_PORT=18250` |

若目标端口上已有**健康**的 db-service，桌面端复用它（退出时不会停止它）；被其他进程占用则自动退到空闲端口。

## 3. 启动链路（`src-tauri/src/lib.rs`）

1. 定位内嵌 jar：`DBP_RUNTIME_DIR` → 打包资源 `resource_dir()/runtime` → 可执行文件祖先目录的 `runtime/`
   → 源码树 `../../runtime`（开发期 `cargo build` 直接可跑）。
2. 建数据目录：`app_data_dir()/data/logs`；**java 子进程 cwd = app_data_dir（data 的父目录）**。
3. spawn：

   ```text
   java -jar <runtime>/db-service-0.1.0.jar
        --server.port=<port>
        --db-service.data-dir=<app_data>/data
        --db-service.allow-write=true
        --logging.file.name=<app_data>/data/logs/db-service.log
   ```

   stdout/stderr 落到 `data/logs/db-service.stdout.log`、`db-service.stderr.log`。
4. 后台轮询 `GET /api/health`（信封 `code=00000` 视为就绪，最长 120s；java 提前退出直接报错）；
   **就绪后**（在 Tauri 主线程）创建窗口并加载 `index.html?apiBase=http://127.0.0.1:<port>`，
   同时初始化脚本注入 `window.__DBM_API_BASE__`（`public/core.js` 的解析约定）。
5. 窗口关闭 / 应用退出：结束 java 子进程（`RunEvent::Exit` + `Drop` 双保险）；
   Windows 下额外用 Job Object（`KILL_ON_JOB_CLOSE`）兜底，强杀桌面进程也不会残留 java。

## 4. 数据与端口隔离

运行数据全部在 **应用数据目录**（Windows：`%APPDATA%\com.jnf.dbplatform.desktop\data\`）：

| 路径 | 内容 |
| --- | --- |
| `data\db-service.log` | db-service 日志（`--logging.file.name`） |
| `data\logs\db-service.stdout.log` / `.stderr.log` | 子进程 stdout/stderr |
| `data\logs\desktop.log` | 桌面壳启动/收尸日志 |
| `data\*` | db-service 的 `--db-service.data-dir`（数据源清单、H2 演示库、运行期文件，由 db-service 管理） |

与 Web 版（18090 服务 + 18091 BFF）、共享端口 18100/18200 互不影响；桌面端只监听自己的
`127.0.0.1:<port>`。

## 5. 验证

```powershell
# 在 <desktop> 目录；先 cargo build
powershell -ExecutionPolicy Bypass -File scripts\verify-window.ps1
```

验证内容（全部通过才 exit 0）：

- 窗口出现、标题含 `DB Platform`、尺寸 ≥ 1200 宽；
- java 子进程存在，命令行含 `--server.port` / `--db-service.data-dir` / `--db-service.allow-write=true` /
  `--logging.file.name`；
- `GET /api/health` → `00000`、`data.allowWrite=true`；
- CDP 驱动页面：标题/`apiBase`、对象树含「演示库」与 `public`、展开后出现 `orders` 表、
  双击打开后数据 **12 行**、写模式开关可开启且状态栏显示「写模式：开」、交互期 0 控制台错误；
- **Win32 `PrintWindow`（PW_RENDERFULLCONTENT）** 截窗口图 → `desktop/verify-window.png`；
- 端口 ≠ 18090/18091/18100/18200，且这些端口原有监听进程全程未被本应用占用/终止；
- `WM_CLOSE` 关窗后桌面进程与 java 子进程都退出、端口释放。

可选：`-KeepRunning` 保留窗口人工查看；`-Configuration release` 验证 release 构建。

## 6. 与 Web 版的差异

| 项 | Web 版（`public` + `server.mjs`） | 桌面端（本目录） |
| --- | --- | --- |
| 前端/后端连接 | 浏览器 → Node BFF(`18091`) → db-service(`18090`) | WebView 直连内嵌 db-service，无 BFF |
| db-service | 需单独启动，默认 18090 | 随桌面进程启动（debug/release 均 18210） |
| 数据目录 | db-service 默认 `data/`（可用启动参数改） | `%APPDATA%\com.jnf.dbplatform.desktop\data` |
| 写操作 | `--db-service.allow-write=true` 启动参数 | 桌面壳固定传 `--db-service.allow-write=true`，UI 写模式仍二次确认 |
| 端口/进程 | 需自己管理 service/BFF | 端口自动避让、退出自动收尸（Job Object 兜底） |
| AI 助手 | 需在设置里配置 Agent 地址（可选） | 同样可选；桌面端不内嵌 harness，AI 面板默认隐藏 |

## 7. 打包（NSIS 安装包，未签名）

配置已包含 `bundle.resources`（`../runtime → runtime`）、`bundle.targets = ["nsis"]` 与图标，
`src-tauri/installer-hooks.nsh` 在卸载后清理开始菜单/桌面快捷方式。用 jnf-desktop 已安装的
Tauri CLI 打包（免全局安装）：

```powershell
cd desktop\src-tauri
node D:\study\dsh-java\jnf-desktop\node_modules\@tauri-apps\cli\tauri.js build
```

产物：`src-tauri\target\release\bundle\nsis\DB Platform_1.0.0_x64-setup.exe`（约 23.5 MiB，
含 `runtime\db-service-0.1.0.jar`；安装后安装目录内另有 `uninstall.exe`）。
发布副本：`D:\study\产品\DB-Platform-Setup.exe`。

```powershell
# 静默安装到指定目录（NSIS：/D 必须最后且不加引号；路径避免空格/中文）
Start-Process .\DB-Platform-Setup.exe -ArgumentList '/S',"/D=$env:TEMP\DBPlatformInstalled" -Wait
# 静默卸载（卸载程序在安装目录内；快捷方式与注册表项一并清理）
Start-Process "$env:TEMP\DBPlatformInstalled\uninstall.exe" -ArgumentList '/S' -Wait
```

已验证（本机 Win11）：安装后开始菜单快捷方式与注册表 Uninstall 项都存在；安装后的 exe 由
`scripts\verify-window.ps1 -ExePath <安装目录>\db-platform-desktop.exe` 全链路验证通过
（端口 18210、健康 `00000`、CDP 断言全 True、数据 12 行、写模式开、退出收尸）；静默卸载后
安装目录、开始菜单/桌面快捷方式、注册表项均消失。桌面壳与内嵌服务**未做代码签名**，发布说明
中注明「仅供内部测试」。

## 8. 已知限制

- **未签名**：桌面壳与内嵌服务均未做代码签名，安装器为 NSIS（`bundle.targets=["nsis"]`，已实测安装/卸载）；发布正式版前需补签名。
- **内嵌 jar 需手动刷新**：升级 db-service 后重新 `copy` 到 `runtime/` 再 `cargo build`（或在打包前刷新）。
- **AI 助手**：桌面端不内嵌 jnf-harness，AI 面板默认隐藏；需要时在设置里填 Agent 地址（需自行启动 harness）。
- 应用数据目录不随卸载自动删除（如需彻底清理，手动删除 `%APPDATA%\com.jnf.dbplatform.desktop`）。

## 9. 环境变量一览

| 变量 | 作用 |
| --- | --- |
| `DBP_SERVICE_PORT` | 覆盖内嵌 db-service 端口 |
| `DBP_RUNTIME_DIR` | 覆盖运行时目录（含 `db-service-0.1.0.jar`） |
| `DBP_JAVA` | 指定 java 可执行文件 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | 验证用：如 `--remote-debugging-port=9345`（`verify-window.ps1` 会自动设置） |
