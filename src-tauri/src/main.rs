#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod detector;
mod models;
mod storage;

use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use detector::DetectorState;
use hmac::{Hmac, Mac};
use models::{now_string, AppSettings, Dashboard, DetectionStatus, WorkSession};
use serde_json::json;
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use storage::Storage;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

type HmacSha256 = Hmac<Sha256>;

struct AppState {
    storage: Mutex<Storage>,
    detector: Mutex<DetectorState>,
    timing_log: Mutex<TimingLogBuffer>,
    debug_logging_enabled: Mutex<bool>,
}

struct TimingLogBuffer {
    rows: Vec<String>,
}

impl Default for TimingLogBuffer {
    fn default() -> Self {
        Self { rows: Vec::new() }
    }
}

const TIMING_LOG_HEADER: &str = "system_time,session_id,present,confidence,source,wall_elapsed_seconds,work_total_before,work_total_after,add_seconds,delta_ms,remainder_ms,diff_wall_minus_work,note";
const MAX_DEBUG_LOG_ROWS: usize = 20_000;

fn workrecord_window_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/workrecord_logo_256.png"))
}

fn workrecord_tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/workrecord_logo_32.png"))
}

fn setup_window_icon(app: &tauri::App) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(workrecord_window_icon()?)?;
    }
    Ok(())
}

fn map_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn format_local(value: &DateTime<Local>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn parse_local(value: &str) -> Option<DateTime<Local>> {
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").ok()?;
    Local.from_local_datetime(&naive).single()
}

fn csv_cell(value: impl ToString) -> String {
    let value = value.to_string();
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

fn buffer_timing_log(buffer: &Mutex<TimingLogBuffer>, row: String) {
    if let Ok(mut buffer) = buffer.lock() {
        buffer.rows.push(row);
        if buffer.rows.len() > MAX_DEBUG_LOG_ROWS {
            let overflow = buffer.rows.len() - MAX_DEBUG_LOG_ROWS;
            buffer.rows.drain(0..overflow);
        }
    }
}

fn debug_logging_enabled(state: &State<'_, AppState>) -> bool {
    state
        .debug_logging_enabled
        .lock()
        .map(|enabled| *enabled)
        .unwrap_or(false)
}

fn timing_log_text(rows: &[String]) -> String {
    if rows.is_empty() {
        format!("{TIMING_LOG_HEADER}\n")
    } else {
        format!("{TIMING_LOG_HEADER}\n{}\n", rows.join("\n"))
    }
}

fn runtime_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法获取当前程序路径：{error}"))?;
    if let Some(parent) = exe.parent() {
        return Ok(parent.to_path_buf());
    }
    std::env::current_dir().map_err(|error| format!("无法获取运行目录：{error}"))
}

fn validate_feishu_webhook(webhook: &str) -> Result<String, String> {
    let webhook = webhook.trim();
    if webhook.is_empty() {
        return Err("请先填写飞书机器人 Webhook。".to_string());
    }
    if !(webhook.starts_with("https://") || webhook.starts_with("http://")) {
        return Err("飞书 Webhook 必须是 http 或 https 地址。".to_string());
    }
    if !webhook.contains("/open-apis/bot/") {
        return Err(
            "Webhook 看起来不像飞书自定义机器人地址，请检查是否包含 /open-apis/bot/。".to_string(),
        );
    }
    Ok(webhook.to_string())
}

fn feishu_signature(secret: &str, timestamp: i64) -> Result<String, String> {
    let key = format!("{timestamp}\n{secret}");
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).map_err(map_err)?;
    mac.update(b"");
    Ok(general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

async fn post_feishu_text(
    webhook: &str,
    secret: &str,
    title: &str,
    text: &str,
) -> Result<(), String> {
    let webhook = validate_feishu_webhook(webhook)?;
    let mut body = json!({
        "msg_type": "text",
        "content": {
            "text": format!("{title}\n{text}")
        }
    });
    if !secret.trim().is_empty() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(map_err)?
            .as_secs() as i64;
        body["timestamp"] = json!(timestamp.to_string());
        body["sign"] = json!(feishu_signature(secret.trim(), timestamp)?);
    }

    let body_text = serde_json::to_string(&body).map_err(map_err)?;
    let response_text = tauri::async_runtime::spawn_blocking(move || {
        post_json_with_powershell(&webhook, &body_text)
    })
    .await
    .map_err(map_err)??;

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&response_text) {
        let code = value
            .get("code")
            .and_then(|code| code.as_i64())
            .unwrap_or(0);
        if code != 0 {
            let message = value
                .get("msg")
                .and_then(|message| message.as_str())
                .unwrap_or("未知错误");
            return Err(format!("飞书机器人返回错误 code={code}：{message}"));
        }
    }
    Ok(())
}

fn post_json_with_powershell(webhook: &str, body: &str) -> Result<String, String> {
    let webhook_b64 = general_purpose::STANDARD.encode(webhook.as_bytes());
    let body_b64 = general_purpose::STANDARD.encode(body.as_bytes());
    let script = format!(
        "$u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{webhook_b64}'));\
         $b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{body_b64}'));\
         try {{\
           $r=Invoke-WebRequest -UseBasicParsing -Uri $u -Method Post -ContentType 'application/json; charset=utf-8' -Body $b;\
           Write-Output $r.Content;\
           exit 0\
         }} catch {{\
           Write-Error $_.Exception.Message;\
           exit 1\
         }}"
    );
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &script,
    ]);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法启动 PowerShell 发送飞书消息：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("飞书请求失败：{detail}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(windows)]
fn run_hidden_command(program: &str, args: &[String]) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .map_err(|error| format!("无法执行 {program}：{error}"))
}

#[cfg(windows)]
fn sync_autostart(enabled: bool) -> Result<(), String> {
    let run_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run".to_string();
    let value_name = "WorkRecord".to_string();
    if enabled {
        let exe =
            std::env::current_exe().map_err(|error| format!("无法获取当前程序路径：{error}"))?;
        let exe_value = format!("\"{}\"", exe.display());
        let args = vec![
            "add".to_string(),
            run_key,
            "/v".to_string(),
            value_name,
            "/t".to_string(),
            "REG_SZ".to_string(),
            "/d".to_string(),
            exe_value,
            "/f".to_string(),
        ];
        let output = run_hidden_command("reg.exe", &args)?;
        if !output.status.success() {
            let detail = command_output_detail(&output);
            return Err(format!("开机启动注册失败：{detail}"));
        }
    } else {
        let args = vec![
            "delete".to_string(),
            run_key,
            "/v".to_string(),
            value_name,
            "/f".to_string(),
        ];
        // 启动项不存在时 reg delete 会返回非 0；关闭开机启动时把“不存在”也视为目标达成。
        let _ = run_hidden_command("reg.exe", &args);
    }
    Ok(())
}

#[cfg(not(windows))]
fn sync_autostart(_enabled: bool) -> Result<(), String> {
    Ok(())
}

fn command_output_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("退出码 {:?}", output.status.code())
    }
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state
        .storage
        .lock()
        .map_err(map_err)?
        .load_settings()
        .map_err(map_err)
}

#[tauri::command]
fn save_settings(settings: AppSettings, state: State<'_, AppState>) -> Result<(), String> {
    let previous_autostart = {
        let storage = state.storage.lock().map_err(map_err)?;
        storage
            .load_settings()
            .map(|value| value.autostart)
            .unwrap_or(false)
    };
    if previous_autostart != settings.autostart {
        sync_autostart(settings.autostart)?;
    }
    state
        .storage
        .lock()
        .map_err(map_err)?
        .save_settings(&settings)
        .map_err(map_err)
}

#[tauri::command]
fn load_json_state(
    name: String,
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    state
        .storage
        .lock()
        .map_err(map_err)?
        .load_json_state(&name)
        .map_err(map_err)
}

#[tauri::command]
fn save_json_state(
    name: String,
    value: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .storage
        .lock()
        .map_err(map_err)?
        .save_json_state(&name, &value)
        .map_err(map_err)
}

#[tauri::command]
async fn check_feishu_config(webhook: String, secret: String) -> Result<String, String> {
    post_feishu_text(
        &webhook,
        &secret,
        "WorkRecord 飞书配置检测",
        "如果你收到这条消息，说明飞书机器人配置可用。",
    )
    .await?;
    Ok("飞书配置检测成功，已发送测试消息。".to_string())
}

#[tauri::command]
async fn send_feishu_message(
    title: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let settings = state
        .storage
        .lock()
        .map_err(map_err)?
        .load_settings()
        .map_err(map_err)?;
    if !settings.feishu_enabled {
        return Ok(());
    }
    post_feishu_text(
        &settings.feishu_webhook,
        &settings.feishu_secret,
        title.trim(),
        text.trim(),
    )
    .await
}

#[tauri::command]
fn get_dashboard(state: State<'_, AppState>) -> Result<Dashboard, String> {
    let storage = state.storage.lock().map_err(map_err)?;
    let sessions = storage.list_sessions(Some(12)).map_err(map_err)?;
    let open = storage.latest_open_session().map_err(map_err)?;
    let detector = state.detector.lock().map_err(map_err)?;
    Ok(Dashboard {
        total_seconds: open.as_ref().map(|s| s.total_seconds).unwrap_or(0),
        started_at: open.as_ref().map(|s| s.started_at.clone()),
        status: if open.is_some() {
            "累计中".into()
        } else {
            "未开始".into()
        },
        detector_source: detector.source.clone(),
        confidence: detector.confidence,
        interruptions_last_hour: 0,
        sessions,
    })
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<WorkSession>, String> {
    state
        .storage
        .lock()
        .map_err(map_err)?
        .list_sessions(None)
        .map_err(map_err)
}

#[tauri::command]
fn create_manual_session(
    started_at: String,
    total_seconds: i64,
    note: String,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    state
        .storage
        .lock()
        .map_err(map_err)?
        .create_session(started_at, total_seconds, note)
        .map_err(map_err)
}

#[tauri::command]
fn update_session(session: WorkSession, state: State<'_, AppState>) -> Result<(), String> {
    state
        .storage
        .lock()
        .map_err(map_err)?
        .update_session(&session)
        .map_err(map_err)
}

#[tauri::command]
fn delete_session(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    state
        .storage
        .lock()
        .map_err(map_err)?
        .delete_session(id)
        .map_err(map_err)
}

#[tauri::command]
fn start_workday(state: State<'_, AppState>) -> Result<i64, String> {
    let storage = state.storage.lock().map_err(map_err)?;
    if let Some(open) = storage.latest_open_session().map_err(map_err)? {
        return Ok(open.id);
    }
    let id = storage
        .create_session(now_string(), 0, "手动开始".into())
        .map_err(map_err)?;
    storage
        .log_event("manual_start", &format!("session={id}"))
        .ok();
    Ok(id)
}

#[tauri::command]
fn end_workday(state: State<'_, AppState>) -> Result<(), String> {
    let storage = state.storage.lock().map_err(map_err)?;
    if let Some(open) = storage.latest_open_session().map_err(map_err)? {
        let ended_at = now_string();
        storage
            .close_session(open.id, ended_at.clone())
            .map_err(map_err)?;
        storage
            .log_event(
                "manual_end",
                &format!("session={} ended_at={ended_at}", open.id),
            )
            .ok();
    }
    Ok(())
}

#[tauri::command]
fn get_detection_status(state: State<'_, AppState>) -> Result<DetectionStatus, String> {
    let settings = state
        .storage
        .lock()
        .map_err(map_err)?
        .load_settings()
        .map_err(map_err)?;
    let detector = state.detector.lock().map_err(map_err)?;
    Ok(detector.status(&settings))
}

#[tauri::command]
fn get_debug_logs(state: State<'_, AppState>) -> Result<String, String> {
    let buffer = state.timing_log.lock().map_err(map_err)?;
    Ok(timing_log_text(&buffer.rows))
}

#[tauri::command]
fn get_debug_logging_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .debug_logging_enabled
        .lock()
        .map(|enabled| *enabled)
        .map_err(map_err)
}

#[tauri::command]
fn set_debug_logging_enabled(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut current = state.debug_logging_enabled.lock().map_err(map_err)?;
    *current = enabled;
    Ok(())
}

#[tauri::command]
fn export_debug_logs(state: State<'_, AppState>) -> Result<String, String> {
    let text = {
        let buffer = state.timing_log.lock().map_err(map_err)?;
        timing_log_text(&buffer.rows)
    };
    let filename = format!(
        "workrecord-debug-{}.csv",
        Local::now().format("%Y%m%d-%H%M%S")
    );
    let path = runtime_dir()?.join(filename);
    fs::write(&path, text).map_err(|error| format!("日志导出失败：{error}"))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn update_presence(
    present: bool,
    confidence: f64,
    source: String,
    state: State<'_, AppState>,
) -> Result<DetectionStatus, String> {
    let now = Local::now();
    let now_text = format_local(&now);
    let should_debug_log = debug_logging_enabled(&state);
    let storage = state.storage.lock().map_err(map_err)?;
    let settings = storage.load_settings().map_err(map_err)?;
    let mut detector = state.detector.lock().map_err(map_err)?;

    detector.apply_detection(present, confidence, source, now);

    if !settings.detection_enabled {
        detector.note = "检测已在设置中关闭；不会自动计时。".to_string();
        if should_debug_log {
            buffer_timing_log(
                &state.timing_log,
                format!(
                    "{},{},{},{:.3},{},{},{},{},{},{},{},{},{}",
                    csv_cell(&now_text),
                    "",
                    present,
                    detector.confidence,
                    csv_cell(&detector.source),
                    "",
                    0,
                    0,
                    0,
                    0,
                    detector.remainder_ms,
                    "",
                    csv_cell("detection_disabled")
                ),
            );
        }
        return Ok(detector.status(&settings));
    }

    let gap_seconds = settings.session_gap_hours.max(1) * 3600;
    let max_tick_ms = (settings.uncertain_grace_seconds.max(3) + 5) * 1000;
    let open = storage.latest_open_session().map_err(map_err)?;
    let mut log_session_id: Option<i64> = None;
    let mut wall_elapsed_seconds: Option<i64> = None;
    let mut work_total_before = 0_i64;
    let mut work_total_after = 0_i64;
    let mut add_seconds = 0_i64;
    let mut delta_ms = 0_i64;
    let mut log_note: String;

    if present {
        if let Some(open) = open {
            log_session_id = Some(open.id);
            work_total_before = open.total_seconds.max(0);
            work_total_after = work_total_before;
            if let Some(started_at) = parse_local(&open.started_at) {
                wall_elapsed_seconds =
                    Some(now.signed_duration_since(started_at).num_seconds().max(0));
            }
            if let Some(last_seen) = open.last_seen_at.as_deref().and_then(parse_local) {
                if now.signed_duration_since(last_seen).num_seconds() > gap_seconds {
                    storage
                        .close_session(open.id, format_local(&last_seen))
                        .map_err(map_err)?;
                    let id = storage
                        .create_session(now_text.clone(), 0, "YOLO 自动开始".into())
                        .map_err(map_err)?;
                    storage
                        .log_event("auto_start_after_gap", &format!("session={id}"))
                        .ok();
                    log_session_id = Some(id);
                    wall_elapsed_seconds = Some(0);
                    work_total_before = 0;
                    work_total_after = 0;
                    add_seconds = 0;
                    delta_ms = 0;
                    log_note = format!("auto_start_after_gap old_session={}", open.id);
                    detector.last_accounted_at = Some(now);
                    detector.remainder_ms = 0;
                } else {
                    log_note = "present_update".to_string();
                }
            } else {
                log_note = "present_update_no_last_seen".to_string();
            }

            if !log_note.starts_with("auto_start_after_gap") {
                let mut total_seconds = open.total_seconds.max(0);
                if let Some(last_accounted_at) = detector.last_accounted_at {
                    delta_ms = now
                        .signed_duration_since(last_accounted_at)
                        .num_milliseconds();
                    if delta_ms > 0 && delta_ms <= max_tick_ms {
                        let accounted_ms = detector.remainder_ms + delta_ms;
                        add_seconds = accounted_ms / 1000;
                        detector.remainder_ms = accounted_ms % 1000;
                        total_seconds += add_seconds;
                    } else {
                        detector.remainder_ms = 0;
                        log_note = format!("present_update_reset_delta delta_ms={delta_ms}");
                    }
                } else {
                    detector.remainder_ms = 0;
                }

                storage
                    .update_session_timing(open.id, total_seconds, now_text.clone())
                    .map_err(map_err)?;
                work_total_after = total_seconds;
                detector.last_accounted_at = Some(now);
            }
        } else {
            let id = storage
                .create_session(now_text.clone(), 0, "YOLO 自动开始".into())
                .map_err(map_err)?;
            storage
                .log_event("auto_start", &format!("session={id}"))
                .ok();
            log_session_id = Some(id);
            wall_elapsed_seconds = Some(0);
            log_note = "auto_start".to_string();
            detector.last_accounted_at = Some(now);
            detector.remainder_ms = 0;
        }
    } else if let Some(open) = open {
        log_session_id = Some(open.id);
        work_total_before = open.total_seconds.max(0);
        work_total_after = work_total_before;
        if let Some(started_at) = parse_local(&open.started_at) {
            wall_elapsed_seconds = Some(now.signed_duration_since(started_at).num_seconds().max(0));
        }
        log_note = "absent_pause".to_string();
        if let Some(last_seen) = open.last_seen_at.as_deref().and_then(parse_local) {
            if now.signed_duration_since(last_seen).num_seconds() > gap_seconds {
                storage
                    .close_session(open.id, format_local(&last_seen))
                    .map_err(map_err)?;
                storage
                    .log_event("auto_close_after_absence", &format!("session={}", open.id))
                    .ok();
                log_note = "auto_close_after_absence".to_string();
            }
        }
    } else {
        log_note = "absent_no_open_session".to_string();
    }

    let diff_wall_minus_work = wall_elapsed_seconds.map(|wall| wall - work_total_after);
    if should_debug_log {
        buffer_timing_log(
            &state.timing_log,
            format!(
                "{},{},{},{:.3},{},{},{},{},{},{},{},{},{}",
                csv_cell(&now_text),
                log_session_id.map(|id| id.to_string()).unwrap_or_default(),
                present,
                detector.confidence,
                csv_cell(&detector.source),
                wall_elapsed_seconds
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                work_total_before,
                work_total_after,
                add_seconds,
                delta_ms,
                detector.remainder_ms,
                diff_wall_minus_work
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                csv_cell(log_note)
            ),
        );
    }

    Ok(detector.status(&settings))
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "开始工作日", true, None::<&str>)?;
    let end = MenuItem::with_id(app, "end", "结束工作日", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &end, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("WorkRecord")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "start" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let storage = state.storage.lock();
                    if let Ok(storage) = storage {
                        if storage.latest_open_session().ok().flatten().is_none() {
                            let _ = storage.create_session(now_string(), 0, "托盘开始".into());
                        }
                    }
                }
            }
            "end" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let storage = state.storage.lock();
                    if let Ok(storage) = storage {
                        if let Ok(Some(open)) = storage.latest_open_session() {
                            let _ = storage.close_session(open.id, now_string());
                        }
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Ok(icon) = workrecord_tray_icon() {
        builder = builder.icon(icon);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn close_to_tray_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<AppState>()
        .and_then(|state| {
            state
                .storage
                .lock()
                .ok()
                .and_then(|storage| storage.load_settings().ok())
        })
        .map(|settings| settings.close_to_tray)
        .unwrap_or(true)
}

fn setup_close_to_tray(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let app_handle = app.handle().clone();
    let window_to_hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if close_to_tray_enabled(&app_handle) {
                api.prevent_close();
                let _ = window_to_hide.hide();
            }
        }
    });

    Ok(())
}

fn setup_initial_window_visibility(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let start_minimized = app
        .try_state::<AppState>()
        .and_then(|state| {
            state
                .storage
                .lock()
                .ok()
                .and_then(|storage| storage.load_settings().ok())
        })
        .map(|settings| settings.start_minimized)
        .unwrap_or(false);

    if start_minimized {
        let _ = window.hide();
    } else {
        window.show()?;
        let _ = window.set_focus();
    }
    Ok(())
}

fn main() {
    let storage = Storage::new().expect("init storage");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState {
            storage: Mutex::new(storage),
            detector: Mutex::new(DetectorState::default()),
            timing_log: Mutex::new(TimingLogBuffer::default()),
            debug_logging_enabled: Mutex::new(false),
        })
        .setup(|app| {
            setup_window_icon(app)?;
            setup_tray(app)?;
            setup_close_to_tray(app)?;
            setup_initial_window_visibility(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            load_json_state,
            save_json_state,
            check_feishu_config,
            send_feishu_message,
            get_dashboard,
            list_sessions,
            create_manual_session,
            update_session,
            delete_session,
            start_workday,
            end_workday,
            get_detection_status,
            get_debug_logs,
            get_debug_logging_enabled,
            set_debug_logging_enabled,
            export_debug_logs,
            update_presence
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
