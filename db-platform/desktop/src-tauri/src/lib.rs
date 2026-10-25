//! DB Platform 桌面壳（Tauri 2）：一个窗口 + 一个内嵌 db-service 后端。
//!
//! 启动链路：
//! 1. 用 `app.path().resource_dir()`（打包后）或开发期相对路径找到 `runtime/db-service-0.1.0.jar`；
//! 2. 在 `app_data_dir/data/` 下建立产品数据目录（logs 等），java 子进程 cwd = `app_data_dir`
//!    （也就是 data 的父目录），所有运行数据都落在应用数据目录内；
//! 3. 决定端口：debug 默认 18210、release 默认 18090，`DBP_SERVICE_PORT` 可覆盖；
//!    端口已被占且 `/api/health` 正常则复用，被其他进程占用则退到空闲端口（绝不杀 18090/18091）；
//! 4. spawn `java -jar ... --server.port=<p> --db-service.data-dir=<data>
//!    --db-service.allow-write=true --logging.file.name=<data>/logs/db-service.log`；
//! 5. 后台轮询 `GET /api/health`（code=00000 视为就绪），就绪后创建窗口并加载
//!    `index.html?apiBase=http://127.0.0.1:<p>`；初始化脚本同时注入 `window.__DBM_API_BASE__`；
//! 6. 窗口关闭 / 应用退出时结束 java 子进程；Windows 下用 Job Object 兜底（强杀桌面进程也不残留）。

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// tauri.conf.json 中定义的窗口 label。
const WINDOW_LABEL: &str = "main";
/// 内嵌 db-service 制品名（由 desktop/runtime/ 打包进资源目录）。
const JAR_NAME: &str = "db-service-0.1.0.jar";
/// 健康检查：统一信封，成功 code=00000（data.allowWrite 反映写操作闸门）。
const HEALTH_PATH: &str = "/api/health";
/// debug 默认端口：避开独立产品在跑的 18090/18091。
const DEFAULT_DEBUG_PORT: u16 = 18210;
/// release 默认端口：与 debug 一样固定 18210（与 Web 版 db-service 的 18090 隔离，避免冲突）。
const DEFAULT_RELEASE_PORT: u16 = 18210;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 运行时路径（应用数据目录 + 打包资源目录）。
#[derive(Clone, Debug)]
struct RuntimePaths {
    /// 应用数据根目录（java 子进程 cwd；data 的父目录）。
    app_data_dir: PathBuf,
    /// 产品数据目录 `<app_data>/data`（db-service.data-dir + 日志）。
    data_dir: PathBuf,
    /// 日志目录 `<data>/logs`。
    logs_dir: PathBuf,
    /// 内嵌 db-service jar。
    runtime_jar: PathBuf,
}

/// 托管的 db-service 子进程句柄；Drop 兜底结束。
struct ServiceState {
    child: Arc<Mutex<Option<Child>>>,
}

impl ServiceState {
    fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for ServiceState {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Tauri 应用入口（main.rs 调用）。
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            match start(app.handle()) {
                Ok(state) => {
                    app.manage(state);
                }
                // 启动失败时 start 里已创建窗口并注入错误提示，这里只记录
                Err(error) => eprintln!("[db-platform] 启动失败：{error}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("初始化 Tauri 应用失败")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                if let Some(state) = app_handle.try_state::<ServiceState>() {
                    state.stop();
                }
            }
        });
}

/// 启动：解析路径 → 选端口 → spawn db-service → 后台等健康 → 建窗口。
fn start(app: &AppHandle) -> Result<ServiceState, String> {
    let requested = requested_port();
    let paths = match resolve_paths(app) {
        Ok(paths) => paths,
        Err(error) => {
            let placeholder = format!("http://127.0.0.1:{requested}");
            let _ = create_main_window(app, &placeholder, Some(&error));
            return Err(error);
        }
    };
    log(
        &paths,
        &format!(
            "启动：appData={} dataDir={} jar={}",
            paths.app_data_dir.display(),
            paths.data_dir.display(),
            paths.runtime_jar.display()
        ),
    );

    let (port, reuse_existing) = choose_port(requested, &paths);
    let base_url = format!("http://127.0.0.1:{port}");

    let child = if reuse_existing {
        log(
            &paths,
            &format!("端口 {port} 上已有健康 db-service，复用该实例（退出时不会停止它）"),
        );
        None
    } else {
        match spawn_service(&paths, port) {
            Ok(child) => Some(child),
            Err(error) => {
                let _ = create_main_window(app, &base_url, Some(&error));
                return Err(error);
            }
        }
    };

    let child = Arc::new(Mutex::new(child));
    let monitor_app = app.clone();
    let monitor_child = Arc::clone(&child);
    let monitor_paths = paths.clone();
    let monitor_base = base_url.clone();
    thread::spawn(move || monitor(monitor_app, port, monitor_base, monitor_child, monitor_paths));

    Ok(ServiceState { child })
}

/// 后台等健康；就绪后（在主线程）创建窗口并加载前端。
fn monitor(
    app: AppHandle,
    port: u16,
    base_url: String,
    child: Arc<Mutex<Option<Child>>>,
    paths: RuntimePaths,
) {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        if let Some(status) = child_exit_status(&child) {
            let message = format!(
                "内嵌 db-service 进程提前退出（{status}）。日志：{}",
                paths.logs_dir.join("db-service.log").display()
            );
            log(&paths, &message);
            open_window_async(&app, &base_url, Some(message));
            return;
        }
        if probe_health(port) {
            break;
        }
        if Instant::now() >= deadline {
            let message = format!(
                "等待内嵌 db-service 就绪超时（{}s）。日志：{}",
                HEALTH_TIMEOUT.as_secs(),
                paths.logs_dir.join("db-service.log").display()
            );
            log(&paths, &message);
            open_window_async(&app, &base_url, Some(message));
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }

    log(&paths, &format!("db-service 已就绪：{base_url}"));
    open_window_async(&app, &base_url, None);
}

/// 在 Tauri 主线程创建窗口（窗口必须在主线程建）。
fn open_window_async(app: &AppHandle, base_url: &str, fatal: Option<String>) {
    let app_handle = app.clone();
    let url = base_url.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = create_main_window(&app_handle, &url, fatal.as_deref()) {
            eprintln!("[db-platform] 创建主窗口失败：{error}");
        }
    });
}

/* ------------------------------ 窗口与注入脚本 ------------------------------ */

/// 从 tauri.conf.json 的 main 窗口配置创建窗口，并动态补上 `?apiBase=` 与注入脚本。
fn create_main_window(app: &AppHandle, base_url: &str, fatal: Option<&str>) -> tauri::Result<()> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == WINDOW_LABEL)
        .cloned()
        .expect("tauri.conf.json 缺少 label=main 的窗口配置");
    config.url = WebviewUrl::App(format!("index.html?apiBase={base_url}").into());
    config.visible = true;

    WebviewWindowBuilder::from_config(app, &config)?
        .initialization_script(init_script(base_url, fatal))
        .build()?;
    Ok(())
}

/// 每次页面加载前注入：API base 全局量 + `?apiBase=` 兜底（前端 core.js 的解析约定）。
fn init_script(base_url: &str, fatal: Option<&str>) -> String {
    let mut script = format!(
        r#"(function () {{
  var base = {base};
  window.__DBM_API_BASE__ = base;
  window.__DBP_API_BASE__ = base;
  window.__DBP_DESKTOP__ = true;
  try {{
    var current = new URL(window.location.href);
    if (current.searchParams.get('apiBase') !== base) {{
      current.searchParams.set('apiBase', base);
      window.history.replaceState(null, '', current.pathname + current.search + current.hash);
    }}
  }} catch (error) {{ /* tauri 协议下 replaceState 可能受限，忽略 */ }}
}})();"#,
        base = json_str(base_url)
    );
    if let Some(message) = fatal {
        script.push_str(&error_overlay_script(message));
    }
    script
}

/// 全屏错误蒙层（启动失败 / 服务提前退出时注入，不修改前端源码）。
fn error_overlay_script(message: &str) -> String {
    format!(
        r#"(function () {{
  var message = {message};
  function show() {{
    if (document.querySelector('[data-dbp-error]')) return;
    var overlay = document.createElement('div');
    overlay.setAttribute('data-dbp-error', '1');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#14161a;color:#e6e8eb;padding:40px;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif;';
    var card = document.createElement('div');
    card.style.cssText = 'max-width:780px;border:1px solid #3a3f47;border-radius:12px;padding:24px 28px;background:#1b1e24;';
    var title = document.createElement('h1');
    title.textContent = 'DB Platform 启动失败';
    title.style.cssText = 'margin:0 0 12px;font-size:20px;color:#ff7875;';
    var body = document.createElement('pre');
    body.textContent = message;
    body.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:#c9d1d9;font:12.5px/1.7 Consolas,monospace;';
    card.appendChild(title);
    card.appendChild(body);
    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);
  }}
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', show);
  }} else {{
    show();
  }}
}})();"#,
        message = json_str(message)
    )
}

/* ------------------------------ 资源 / 端口 / 进程 ------------------------------ */

fn resolve_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let raw_app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?;
    // tauri 的 resource_dir / app_data_dir 在 Windows 上可能是 verbatim 形式（\\?\D:\...），
    // java -jar 与日志参数都不认这个前缀，统一剥掉。
    let app_data_dir = strip_verbatim(&raw_app_data_dir);
    let data_dir = app_data_dir.join("data");
    let logs_dir = data_dir.join("logs");
    for dir in [&app_data_dir, &data_dir, &logs_dir] {
        fs::create_dir_all(dir)
            .map_err(|error| format!("创建目录失败 {}：{error}", dir.display()))?;
    }

    let runtime_dir = strip_verbatim(&resolve_runtime_dir(app)?);
    let runtime_jar = runtime_dir.join(JAR_NAME);
    if !runtime_jar.is_file() {
        return Err(format!(
            "缺少内嵌 db-service 后端：{}\n请把 db-service-0.1.0.jar 放到 runtime/ 目录后再启动。",
            runtime_jar.display()
        ));
    }

    Ok(RuntimePaths {
        app_data_dir,
        data_dir,
        logs_dir,
        runtime_jar,
    })
}

/// 依次尝试：DBP_RUNTIME_DIR → 打包资源 resource_dir/runtime → 可执行文件祖先目录/runtime → 源码树。
fn resolve_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = env::var("DBP_RUNTIME_DIR") {
        if !dir.trim().is_empty() {
            candidates.push(PathBuf::from(dir));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("runtime"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            // target/debug/db-platform-desktop.exe → 向上找 <desktop>/runtime
            for ancestor in dir.ancestors().take(8) {
                candidates.push(ancestor.join("runtime"));
            }
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime"));

    let mut tried = Vec::new();
    for candidate in candidates {
        if candidate.join(JAR_NAME).is_file() {
            return Ok(candidate);
        }
        tried.push(candidate.display().to_string());
    }
    Err(format!(
        "未找到内嵌 db-service 运行时目录（runtime/{JAR_NAME}）。已尝试：\n{}",
        tried.join("\n")
    ))
}

/// 去掉 Windows verbatim 前缀（`\\?\D:\...` → `D:\...`，`\\?\UNC\srv\share` → `\\srv\share`）。
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn requested_port() -> u16 {
    if let Some(port) = env::var("DBP_SERVICE_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
    {
        return port;
    }
    if cfg!(debug_assertions) {
        DEFAULT_DEBUG_PORT
    } else {
        DEFAULT_RELEASE_PORT
    }
}

/// 返回（端口，是否复用已有实例）。
fn choose_port(requested: u16, paths: &RuntimePaths) -> (u16, bool) {
    if !port_in_use(requested) {
        return (requested, false);
    }
    if probe_health(requested) {
        return (requested, true);
    }
    if let Some(free) = find_free_port() {
        log(
            paths,
            &format!("端口 {requested} 被其他进程占用且不是 db-service，改用空闲端口 {free}"),
        );
        return (free, false);
    }
    log(
        paths,
        &format!("端口 {requested} 被占用且未找到空闲端口，仍尝试使用 {requested}"),
    );
    (requested, false)
}

fn port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn find_free_port() -> Option<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.local_addr().ok().map(|addr| addr.port())
}

fn java_executable() -> PathBuf {
    if let Ok(value) = env::var("DBP_JAVA") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    if let Ok(home) = env::var("JAVA_HOME") {
        let candidate = PathBuf::from(home)
            .join("bin")
            .join(if cfg!(windows) { "java.exe" } else { "java" });
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("java")
}

fn spawn_service(paths: &RuntimePaths, port: u16) -> Result<Child, String> {
    let java = java_executable();
    let stdout = File::create(paths.logs_dir.join("db-service.stdout.log"))
        .map_err(|error| format!("创建 db-service.stdout.log 失败：{error}"))?;
    let stderr = File::create(paths.logs_dir.join("db-service.stderr.log"))
        .map_err(|error| format!("创建 db-service.stderr.log 失败：{error}"))?;
    let logging_file = paths.logs_dir.join("db-service.log");

    let mut command = Command::new(&java);
    command
        .arg("-jar")
        .arg(&paths.runtime_jar)
        .arg(format!("--server.port={port}"))
        .arg(format!(
            "--db-service.data-dir={}",
            paths.data_dir.display()
        ))
        .arg("--db-service.allow-write=true")
        .arg(format!("--logging.file.name={}", logging_file.display()))
        .current_dir(&paths.app_data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：debug 构建启动 java 时不额外弹控制台窗口
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command.spawn().map_err(|error| {
        format!(
            "启动内嵌 db-service 失败（java={}，jar={}）：{error}",
            java.display(),
            paths.runtime_jar.display()
        )
    })?;
    // Windows：把子进程放进 Job Object，桌面进程崩溃/被强杀时也不会留下孤儿 java
    #[cfg(windows)]
    if let Err(error) = attach_job_object(&child) {
        log(
            paths,
            &format!("警告：java 子进程未加入 Job 对象（异常退出可能残留进程）：{error}"),
        );
    }
    log(
        paths,
        &format!(
            "已启动内嵌 db-service：pid={} port={port} jar={}",
            child.id(),
            paths.runtime_jar.display()
        ),
    );
    Ok(child)
}

/// 把子进程加入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object。
///
/// 句柄故意不关闭：桌面进程以任何方式结束时，系统都会关闭该句柄并连带结束 java，
/// 避免崩溃/被强杀后残留进程占用端口与 H2 文件锁。
#[cfg(windows)]
fn attach_job_object(child: &Child) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("CreateJobObjectW 失败".to_string());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            CloseHandle(job);
            return Err("SetInformationJobObject 失败".to_string());
        }
        let process = child.as_raw_handle() as HANDLE;
        if AssignProcessToJobObject(job, process) == 0 {
            CloseHandle(job);
            return Err("AssignProcessToJobObject 失败".to_string());
        }
        Ok(())
    }
}

fn child_exit_status(child: &Arc<Mutex<Option<Child>>>) -> Option<String> {
    let mut guard = child.lock().ok()?;
    let process = guard.as_mut()?;
    match process.try_wait() {
        Ok(Some(status)) => {
            let text = status.to_string();
            *guard = None;
            Some(text)
        }
        _ => None,
    }
}

/* ------------------------------ 健康检查与 HTTP ------------------------------ */

fn probe_health(port: u16) -> bool {
    match http_request(port, "GET", HEALTH_PATH, None, Duration::from_secs(3)) {
        Ok((status, body)) => status == 200 && body.contains("\"code\":\"00000\""),
        Err(_) => false,
    }
}

/* ------------------------------ 极简 HTTP 客户端 ------------------------------ */

fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|error| format!("连接 127.0.0.1:{port} 失败：{error}"))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let payload = body.unwrap_or("");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n"
    );
    if body.is_some() {
        request.push_str("Content-Type: application/json; charset=utf-8\r\n");
    }
    request.push_str(&format!("Content-Length: {}\r\n\r\n", payload.len()));

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("写入请求失败：{error}"))?;
    if !payload.is_empty() {
        stream
            .write_all(payload.as_bytes())
            .map_err(|error| format!("写入请求体失败：{error}"))?;
    }

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| format!("读取响应失败：{error}"))?;
    Ok(parse_http_response(&raw))
}

fn parse_http_response(raw: &[u8]) -> (u16, String) {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = match text.find("\r\n\r\n") {
        Some(index) => (&text[..index], &text[index + 4..]),
        None => (text.as_ref(), ""),
    };
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = if chunked {
        dechunk(body)
    } else {
        body.to_string()
    };
    (status, body)
}

/// 解 Transfer-Encoding: chunked 响应体（Spring Boot 默认对 JSON 用分块传输）。
fn dechunk(body: &str) -> String {
    let mut output = String::new();
    let mut rest = body;
    loop {
        let Some(line_end) = rest.find("\r\n") else {
            break;
        };
        let size_text = rest[..line_end].trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            break;
        };
        rest = &rest[line_end + 2..];
        if size == 0 {
            break;
        }
        let take = size.min(rest.len());
        output.push_str(&rest[..take]);
        rest = &rest[take..];
        if let Some(stripped) = rest.strip_prefix("\r\n") {
            rest = stripped;
        }
    }
    output
}

fn json_str(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for ch in value.chars() {
        match ch {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                output.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => output.push(other),
        }
    }
    output.push('"');
    output
}

/* ------------------------------ 日志 ------------------------------ */

fn log(paths: &RuntimePaths, message: &str) {
    eprintln!("[db-platform] {message}");
    let line = format!("[{}] {message}\n", timestamp());
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.logs_dir.join("desktop.log"))
    {
        let _ = file.write_all(line.as_bytes());
    }
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_string_escapes_windows_paths() {
        assert_eq!(json_str(r"C:\data\db"), r#""C:\\data\\db""#);
        assert_eq!(json_str("a\"b\nc"), r#""a\"b\nc""#);
    }

    #[test]
    fn chunked_response_body_is_decoded() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let (status, body) = parse_http_response(raw);
        assert_eq!(status, 200);
        assert_eq!(body, "hello world");
    }

    #[test]
    fn plain_response_body_is_kept() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        let (status, body) = parse_http_response(raw);
        assert_eq!(status, 200);
        assert_eq!(body, "{}");
    }

    #[test]
    fn verbatim_prefix_is_stripped_for_java() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\D:\data\db")),
            PathBuf::from(r"D:\data\db")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\srv\share\x")),
            PathBuf::from(r"\\srv\share\x")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"D:\plain\path")),
            PathBuf::from(r"D:\plain\path")
        );
    }
}
