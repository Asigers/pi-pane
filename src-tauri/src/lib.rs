use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, atomic::{AtomicBool, Ordering}},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::timeout,
};
use uuid::Uuid;

const MAX_FRAME: usize = 8 * 1024 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static WINDOW_CLOSING: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct AppState {
    active: Mutex<Option<Arc<PiProcess>>>,
}
struct PiProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    pid: u32,
    diagnostics: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    path: String,
    name: String,
    modified_ms: u64,
}

// npm's Windows .cmd shim needs cmd.exe. Arguments MUST be in one /C
// command string; do not append --continue as another cmd.exe argument.
fn pi_command(executable: &str, resume_last: bool) -> Result<Command, String> {
    let executable = if executable.trim().is_empty() { "pi" } else { executable.trim() };
    #[cfg(windows)]
    {
        if executable.chars().any(|c| "\"&|<>^%!\r\n".contains(c)) {
            return Err("Pi 路径包含不安全的 Windows cmd 字符".into());
        }
        if executable.eq_ignore_ascii_case("pi")
            || executable.to_ascii_lowercase().ends_with(".cmd")
            || executable.to_ascii_lowercase().ends_with(".bat")
        {
            let shim = if executable.eq_ignore_ascii_case("pi") { "pi.cmd" } else { executable };
            let mut cmd = Command::new("cmd.exe");
            let mode = if resume_last { "--mode rpc --continue" } else { "--mode rpc" };
            // /S strips the outer pair of double quotes.
            let script = format!("\"\"{}\" {}\"", shim, mode);
            // cmd.exe does not use CommandLineToArgvW quoting. Use raw_arg to
            // preserve the paired quotes for paths containing spaces.
            cmd.args(["/D", "/S", "/C"]);
            cmd.raw_arg(script);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return Ok(cmd);
        }
    }
    let mut cmd = Command::new(executable);
    cmd.args(["--mode", "rpc"]);
    if resume_last { cmd.arg("--continue"); }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

fn ensure_directory(dir: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(dir).map_err(|e| format!("目录不存在: {e}"))?;
    if !path.is_dir() { return Err("工作目录不是文件夹".into()); }
    Ok(path)
}

#[tauri::command]
async fn start_pi(
    app: AppHandle, state: State<'_, AppState>, cwd: String, executable: String,
    resume_last: bool,
) -> Result<(), String> {
    let directory = ensure_directory(&cwd)?;
    let mut guard = state.active.lock().await;
    if let Some(process) = guard.take() { stop_process(&process).await; }
    let mut cmd = pi_command(&executable, resume_last)?;
    cmd.current_dir(directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("无法启动本地 Pi: {e}"))?;
    let pid = child.id().unwrap_or_default();
    let stdin = child.stdin.take().ok_or("Pi stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("Pi stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("Pi stderr 不可用")?;
    let process = Arc::new(PiProcess {
        child: Mutex::new(child), stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()), pid,
        diagnostics: Arc::new(Mutex::new(VecDeque::with_capacity(8))),
    });
    *guard = Some(process.clone());
    drop(guard);

    let reader = process.clone();
    let app_reader = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut input = BufReader::new(stdout);
        let mut frame = Vec::with_capacity(4096);
        loop {
            frame.clear();
            // read_until splits exclusively at LF; U+2028/2029 remain part of JSON.
            match input.read_until(b'\n', &mut frame).await {
                Ok(0) => break,
                Err(e) => {
                    let _ = app_reader.emit("pi-error", format!("Pi RPC read: {e}"));
                    break;
                }
                Ok(_) => {}
            }
            if frame.len() > MAX_FRAME {
                let _ = app_reader.emit("pi-error", "RPC 消息超过 8 MiB 上限");
                break;
            }
            if frame.last() == Some(&b'\n') { frame.pop(); }
            if frame.last() == Some(&b'\r') { frame.pop(); }
            let Ok(record) = serde_json::from_slice::<Value>(&frame) else {
                let _ = app_reader.emit("pi-error", "Pi 返回无效 JSONL 消息");
                continue;
            };
            if record["type"] == "response" {
                if let Some(id) = record["id"].as_str() {
                    if let Some(tx) = reader.pending.lock().await.remove(id) {
                        let _ = tx.send(record);
                        continue;
                    }
                }
            }
            let _ = app_reader.emit("pi-event", record);
        }
        reader.pending.lock().await.clear(); // Dropping senders wakes pending RPC calls.
        let app_state = app_reader.state::<AppState>();
        let active = app_state.active.lock().await;
        if active.as_ref().map(|x| Arc::ptr_eq(x, &reader)).unwrap_or(false) {
            let _ = app_reader.emit("pi-exit", "Pi RPC 已退出");
        }
    });

    let app_err = app;
    let diagnostic_process = process.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut remaining = 50usize;
        while remaining > 0 {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    remaining -= 1;
                    // In-memory ring only; no diagnostics are persisted.
                    let short: String = line.chars().take(350).collect();
                    let mut recent = diagnostic_process.diagnostics.lock().await;
                    if recent.len() == 8 { recent.pop_front(); }
                    recent.push_back(short.clone());
                    drop(recent);
                    let _ = app_err.emit("pi-diagnostic", short);
                }
                _ => break,
            }
        }
        // Drain stderr even after reaching display cap so child never blocks.
        while let Ok(Some(_)) = lines.next_line().await {}
    });
    // Spawn alone is not proof that Pi RPC is alive.
    match rpc_on_process(&process, json!({"type":"get_state"}), Duration::from_secs(20)).await {
        Ok(state_value) if state_value.is_object() => Ok(()),
        Ok(_) => {
            if app_state_is_active(&state, &process).await { state.active.lock().await.take(); }
            stop_process(&process).await;
            Err("Pi RPC 返回无效 get_state 响应".into())
        },
        Err(error) => {
            let diagnostics = process.diagnostics.lock().await.iter()
                .filter(|line| !line.trim().is_empty())
                .cloned().collect::<Vec<_>>().join("\n");
            if app_state_is_active(&state, &process).await { state.active.lock().await.take(); }
            stop_process(&process).await;
            if diagnostics.is_empty() {
                Err(format!("Pi RPC 启动失败：{error}。请确认在终端中 pi --mode rpc 可以运行"))
            } else {
                Err(format!("Pi RPC 启动失败：{error}\nPi 输出：\n{diagnostics}"))
            }
        }
    }
}

async fn app_state_is_active(state: &State<'_, AppState>, process: &Arc<PiProcess>) -> bool {
    state.active.lock().await.as_ref()
        .map(|running| Arc::ptr_eq(running, process)).unwrap_or(false)
}

async fn stop_process(process: &Arc<PiProcess>) {
    process.pending.lock().await.clear();
    // Close stdin first, giving Pi an opportunity to flush its session.
    let _ = process.stdin.lock().await.shutdown().await;
    let stopped = {
        let mut child = process.child.lock().await;
        match timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(_)) => true,
            _ => false,
        }
    };
    if !stopped {
        #[cfg(windows)]
        {
            // Windows npm .cmd launches a Node descendant; kill the process tree.
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &process.pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null()).stderr(Stdio::null()).status().await;
        }
        let mut child = process.child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

#[tauri::command]
async fn stop_pi(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(process) = state.active.lock().await.take() {
        stop_process(&process).await;
    }
    Ok(())
}

#[tauri::command]
async fn rpc_command(state: State<'_, AppState>, payload: Value) -> Result<Value, String> {
    const COMMANDS: &[&str] = &[
        "prompt", "steer", "follow_up", "abort", "clear_queue", "new_session",
        "get_state", "get_messages", "set_model", "cycle_model",
        "get_available_models", "set_thinking_level", "cycle_thinking_level",
        "get_available_thinking_levels", "get_session_stats", "compact",
        "switch_session", "get_commands", "get_tree", "get_entries",
        "get_fork_messages", "fork", "clone", "export_html", "set_session_name",
        "set_steering_mode", "set_follow_up_mode", "set_auto_retry",
        "set_auto_compaction", "abort_retry",
    ];
    let command = payload["type"].as_str().ok_or("RPC 缺少 type")?;
    if !COMMANDS.contains(&command) { return Err(format!("不允许调用 RPC 命令: {command}")); }
    let process = state.active.lock().await.as_ref().cloned().ok_or("Pi 尚未连接")?;
    rpc_on_process(&process, payload, Duration::from_secs(90)).await
}

async fn rpc_on_process(process: &Arc<PiProcess>, payload: Value, deadline: Duration) -> Result<Value, String> {
    let id = Uuid::new_v4().to_string();
    let mut data = payload.as_object().cloned().ok_or("RPC 必须是 JSON 对象")?;
    data.insert("id".into(), json!(id));
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 { return Err("命令超出 2 MiB 上限".into()); }
    let (tx, rx) = oneshot::channel();
    process.pending.lock().await.insert(id.clone(), tx);
    let sent = async {
        let mut stdin = process.stdin.lock().await;
        stdin.write_all(&bytes).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await
    }.await;
    if let Err(e) = sent {
        process.pending.lock().await.remove(&id);
        return Err(format!("RPC 发送失败: {e}"));
    }
    match timeout(deadline, rx).await {
        Ok(Ok(response)) if response["success"] == true => Ok(response["data"].clone()),
        Ok(Ok(response)) => Err(response["error"].as_str().unwrap_or("RPC 请求失败").into()),
        Ok(Err(_)) => Err("Pi 已退出，RPC 请求中断".into()),
        Err(_) => {
            process.pending.lock().await.remove(&id);
            Err("RPC 响应超时（Pi 可能仍在执行）".into())
        }
    }
}

#[tauri::command]
async fn extension_response(state: State<'_, AppState>, payload: Value) -> Result<(), String> {
    if payload["type"] != "extension_ui_response"
        || payload["id"].as_str().is_none()
        || !payload.is_object() {
        return Err("无效 Extension UI 响应".into());
    }
    let process = state.active.lock().await.as_ref().cloned().ok_or("Pi 尚未连接")?;
    let data = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    if data.len() > 1024 * 1024 { return Err("UI 响应超出限制".into()); }
    let mut stdin = process.stdin.lock().await;
    stdin.write_all(&data).await.map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions(cwd: String) -> Result<Vec<SessionInfo>, String> {
    let cwd = ensure_directory(&cwd)?;
    let override_dir = std::env::var("PI_CODING_AGENT_SESSION_DIR").ok();
    let root = if let Some(dir) = override_dir {
        PathBuf::from(dir)
    } else {
        let agent_root = std::env::var("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME")).unwrap_or_default())
                    .join(".pi").join("agent")
            });
        let normalized: String = cwd.to_string_lossy().trim_start_matches(['/', '\\'])
            .chars().map(|c| if matches!(c, '/' | '\\' | ':') {'-'} else {c}).collect();
        agent_root.join("sessions").join(format!("--{normalized}--"))
    };
    let mut sessions = Vec::new();
    let Ok(iter) = std::fs::read_dir(root) else { return Ok(sessions); };
    // Never traverse unrelated directories.
    for item in iter.flatten().take(5000) {
        let path = item.path();
        if path.extension().and_then(|x| x.to_str()) != Some("jsonl") { continue; }
        if !path.is_file() { continue; }
        let meta = match item.metadata() { Ok(m) => m, Err(_) => continue };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let title = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        sessions.push(SessionInfo {
            path: path.to_string_lossy().to_string(), name: title,
            modified_ms: modified,
        });
    }
    sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    sessions.truncate(150);
    Ok(sessions)
}

#[tauri::command]
async fn detect_pi() -> Result<String, String> {
    // Probe without opening a shell to execute arbitrary user-provided code.
    // The RPC mode is not suitable for version detection.
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/D", "/C", "pi", "--version"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = Command::new("pi");
        cmd.arg("--version");
        cmd
    };
    let result = timeout(Duration::from_secs(6), cmd.output()).await
        .map_err(|_| "Pi 版本检测超时".to_string())?
        .map_err(|e| format!("未找到 Pi: {e}"))?;
    if !result.status.success() { return Err("找不到 pi，请先安装并配置 PATH".into()); }
    Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !WINDOW_CLOSING.swap(true, Ordering::SeqCst) {
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    let label = window.label().to_string();
                    tauri::async_runtime::spawn(async move {
                        let app_state = app.state::<AppState>();
                        let process = app_state.active.lock().await.take();
                        if let Some(process) = process { stop_process(&process).await; }
                        if let Some(window) = app.get_webview_window(&label) {
                            let _ = window.close();
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_pi, stop_pi, rpc_command, extension_response, list_sessions, detect_pi,
        ])
        .run(tauri::generate_context!())
        .expect("error while starting Pi Pane");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_workdir_rejected() {
        assert!(ensure_directory("/this_path_should_not_exist_9284721").is_err());
    }
    #[test]
    fn command_builds() {
        assert!(pi_command("pi", true).is_ok());
        assert!(pi_command("pi", false).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn dangerous_cmd_path_rejected() {
        assert!(pi_command(r"C:\test&bad\pi.cmd", false).is_err());
    }
    // Regression: the packaged application uses the same launcher as this
    // test, rather than a separate node.js smoke program with different
    // cmd quoting. CI installs the same Pi CLI before running Rust tests.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_real_pi_cmd_rpc_continue() {
        if std::env::var("PI_PANE_SMOKE_RPC").ok().as_deref() != Some("1") {
            return;
        }
        let home = std::env::temp_dir().join(format!("pi-pane-rpc-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let mut cmd = pi_command("pi", true).unwrap();
        cmd.current_dir(&home)
            .env("PI_CODING_AGENT_DIR", home.join("agent"))
            .env("PI_OFFLINE", "1")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("Windows .cmd shim launch failed");
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        stdin.write_all(b"{\"type\":\"get_state\",\"id\":\"windows-smoke\"}\n").await.unwrap();
        stdin.flush().await.unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let response = timeout(Duration::from_secs(45), async {
            while let Some(line) = lines.next_line().await.expect("RPC read error") {
                let value: Value = serde_json::from_str(&line).expect("non-JSON stdout");
                if value["type"] == "response" && value["id"] == "windows-smoke" {
                    return value;
                }
            }
            panic!("RPC process closed stdout before handshake");
        }).await.expect("RPC startup timed out");
        assert_eq!(response["success"], true, "RPC response: {response}");
        let _ = stdin.shutdown().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
        let _ = std::fs::remove_dir_all(home);
    }

}
