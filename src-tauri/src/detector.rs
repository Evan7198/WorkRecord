use crate::models::{AppSettings, DetectionStatus};
use chrono::{DateTime, Local};

#[derive(Debug)]
pub struct DetectorState {
    pub running: bool,
    pub source: String,
    pub confidence: f64,
    pub present: bool,
    pub last_update_at: Option<DateTime<Local>>,
    pub last_present_at: Option<DateTime<Local>>,
    pub last_accounted_at: Option<DateTime<Local>>,
    pub absent_since: Option<DateTime<Local>>,
    pub remainder_ms: i64,
    pub note: String,
}

impl Default for DetectorState {
    fn default() -> Self {
        Self {
            running: false,
            source: "YOLO".to_string(),
            confidence: 0.0,
            present: false,
            last_update_at: None,
            last_present_at: None,
            last_accounted_at: None,
            absent_since: None,
            remainder_ms: 0,
            note: "等待前端摄像头启动 YOLO ONNX 推理。".to_string(),
        }
    }
}

impl DetectorState {
    pub fn status(&self, settings: &AppSettings) -> DetectionStatus {
        DetectionStatus {
            backend: "YOLO ONNX Runtime Web".to_string(),
            status: if !settings.detection_enabled {
                "已关闭".into()
            } else if self.running {
                "运行中".into()
            } else {
                "未启动".into()
            },
            model: "内置 yolov8n.onnx".into(),
            device: "WebAssembly / CPU".to_string(),
            confidence_threshold: settings.yolo_confidence_threshold,
            source: self.source.clone(),
            present: self.present,
            confidence: self.confidence,
            last_update_at: self.last_update_at.map(|value| format_time(&value)),
            last_seen_at: self.last_present_at.map(|value| format_time(&value)),
            note: self.note.clone(),
        }
    }

    pub fn apply_detection(
        &mut self,
        present: bool,
        confidence: f64,
        source: String,
        now: DateTime<Local>,
    ) {
        self.running = true;
        self.source = if source.trim().is_empty() {
            "YOLO".to_string()
        } else {
            source
        };
        self.confidence = confidence.clamp(0.0, 1.0);
        self.last_update_at = Some(now);
        self.present = present;
        if present {
            self.last_present_at = Some(now);
            self.absent_since = None;
            self.note = "YOLO 已检测到人，正在驱动自动计时。".to_string();
        } else {
            if self.absent_since.is_none() {
                self.absent_since = Some(now);
            }
            self.last_accounted_at = None;
            self.remainder_ms = 0;
            self.note = "YOLO 当前未检测到人，计时暂停。".to_string();
        }
    }
}

fn format_time(value: &DateTime<Local>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S").to_string()
}
