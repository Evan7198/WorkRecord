use chrono::Local;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ReminderConfig {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub enabled: bool,
    pub time_of_day: String,
    pub interval_minutes: i64,
    pub work_minutes: i64,
    pub snooze_minutes: i64,
    pub max_completions: i64,
    pub important: bool,
    pub escalate_enabled: bool,
    pub escalate_repeat_minutes: i64,
}

impl Default for ReminderConfig {
    fn default() -> Self {
        Self {
            id: "drink-water".to_string(),
            title: "喝水提醒".to_string(),
            kind: "drink".to_string(),
            enabled: true,
            time_of_day: "09:00".to_string(),
            interval_minutes: 45,
            work_minutes: 50,
            snooze_minutes: 10,
            max_completions: 0,
            important: false,
            escalate_enabled: false,
            escalate_repeat_minutes: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub settings_version: i64,
    pub camera_index: i64,
    pub detection_enabled: bool,
    pub preview_enabled: bool,
    pub preview_debug_overlay: bool,
    pub presence_confirm_seconds: i64,
    pub uncertain_grace_seconds: i64,
    pub session_gap_hours: i64,
    pub force_cut_enabled: bool,
    pub force_cut_time: String,
    pub manual_end_requires_absence: bool,
    pub yolo_confidence_threshold: f64,
    pub yolo_min_box_area_ratio: f64,
    pub yolo_inference_interval_ms: i64,
    pub yolo_dark_mean_threshold: f64,
    pub yolo_dark_stddev_threshold: f64,
    pub yolo_low_signal_mean_threshold: f64,
    pub yolo_low_signal_stddev_threshold: f64,
    pub yolo_preset_name: String,
    pub yolo_model_path: String,
    pub yolo_device: String,
    pub roi_enabled: bool,
    pub roi_x_percent: i64,
    pub roi_y_percent: i64,
    pub roi_w_percent: i64,
    pub roi_h_percent: i64,
    pub activity_assist_enabled: bool,
    pub activity_idle_seconds: i64,
    pub daily_target_minutes: i64,
    pub weekly_target_minutes: i64,
    pub monthly_target_minutes: i64,
    pub theme_mode: String,
    pub language: String,
    pub start_minimized: bool,
    pub close_to_tray: bool,
    pub autostart: bool,
    pub sound_enabled: bool,
    pub sound_name: String,
    pub custom_sound_path: String,
    pub feishu_enabled: bool,
    pub feishu_webhook: String,
    pub feishu_secret: String,
    pub dnd_enabled: bool,
    pub dnd_start: String,
    pub dnd_end: String,
    pub dnd_snooze_minutes: i64,
    pub reminder_style: String,
    pub reminder_soft_notice_minutes: i64,
    pub reminder_focus_grace_minutes: i64,
    pub reminder_auto_snooze_when_present: bool,
    pub show_hotkey: String,
    pub hide_hotkey: String,
    pub reminders: Vec<ReminderConfig>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            settings_version: 1,
            camera_index: 0,
            detection_enabled: true,
            preview_enabled: false,
            preview_debug_overlay: true,
            presence_confirm_seconds: 3,
            uncertain_grace_seconds: 8,
            session_gap_hours: 6,
            force_cut_enabled: false,
            force_cut_time: "05:00".to_string(),
            manual_end_requires_absence: true,
            yolo_confidence_threshold: 0.35,
            yolo_min_box_area_ratio: 0.012,
            yolo_inference_interval_ms: 1000,
            yolo_dark_mean_threshold: 28.0,
            yolo_dark_stddev_threshold: 18.0,
            yolo_low_signal_mean_threshold: 35.0,
            yolo_low_signal_stddev_threshold: 10.0,
            yolo_preset_name: "balanced".to_string(),
            yolo_model_path: String::new(),
            yolo_device: "CPU".to_string(),
            roi_enabled: false,
            roi_x_percent: 0,
            roi_y_percent: 0,
            roi_w_percent: 100,
            roi_h_percent: 100,
            activity_assist_enabled: false,
            activity_idle_seconds: 60,
            daily_target_minutes: 480,
            weekly_target_minutes: 2400,
            monthly_target_minutes: 10560,
            theme_mode: "system".to_string(),
            language: "zh-CN".to_string(),
            start_minimized: false,
            close_to_tray: true,
            autostart: false,
            sound_enabled: true,
            sound_name: "SystemNotification".to_string(),
            custom_sound_path: String::new(),
            feishu_enabled: false,
            feishu_webhook: String::new(),
            feishu_secret: String::new(),
            dnd_enabled: false,
            dnd_start: "22:00".to_string(),
            dnd_end: "08:00".to_string(),
            dnd_snooze_minutes: 10,
            reminder_style: "gentle".to_string(),
            reminder_soft_notice_minutes: 3,
            reminder_focus_grace_minutes: 10,
            reminder_auto_snooze_when_present: true,
            show_hotkey: "Ctrl+Alt+W".to_string(),
            hide_hotkey: "Ctrl+Alt+H".to_string(),
            reminders: vec![
                ReminderConfig {
                    id: "break".to_string(),
                    title: "休息一下".to_string(),
                    kind: "break".to_string(),
                    work_minutes: 50,
                    interval_minutes: 50,
                    ..ReminderConfig::default()
                },
                ReminderConfig {
                    id: "drink-water".to_string(),
                    title: "喝水提醒".to_string(),
                    kind: "drink".to_string(),
                    interval_minutes: 45,
                    work_minutes: 45,
                    ..ReminderConfig::default()
                },
                ReminderConfig {
                    id: "move".to_string(),
                    title: "动一动提醒".to_string(),
                    kind: "move".to_string(),
                    interval_minutes: 60,
                    work_minutes: 60,
                    ..ReminderConfig::default()
                },
                ReminderConfig {
                    id: "custom-medicine".to_string(),
                    title: "喝药".to_string(),
                    kind: "custom".to_string(),
                    enabled: false,
                    important: true,
                    escalate_enabled: true,
                    ..ReminderConfig::default()
                },
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkSession {
    pub id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub total_seconds: i64,
    pub note: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dashboard {
    pub total_seconds: i64,
    pub started_at: Option<String>,
    pub status: String,
    pub detector_source: String,
    pub confidence: f64,
    pub interruptions_last_hour: i64,
    pub sessions: Vec<WorkSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionStatus {
    pub backend: String,
    pub status: String,
    pub model: String,
    pub device: String,
    pub confidence_threshold: f64,
    pub source: String,
    pub present: bool,
    pub confidence: f64,
    pub last_update_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub note: String,
}

pub fn now_string() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}
