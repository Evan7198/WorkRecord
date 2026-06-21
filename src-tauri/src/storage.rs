use crate::models::{now_string, AppSettings, ReminderConfig, WorkSession};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Storage {
    pub root: PathBuf,
    pub db_path: PathBuf,
    pub settings_path: PathBuf,
}

impl Storage {
    pub fn new() -> Result<Self> {
        let root = PathBuf::from("C:/workrecord");
        let data_dir = root.join("data");
        fs::create_dir_all(&data_dir)?;
        let storage = Self {
            settings_path: root.join("settings.json"),
            db_path: data_dir.join("workrecord.sqlite3"),
            root,
        };
        storage.init_db()?;
        Ok(storage)
    }

    fn conn(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    pub fn init_db(&self) -> Result<()> {
        let conn = self.conn()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS work_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                last_seen_at TEXT,
                total_seconds INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_time TEXT NOT NULL,
                event_type TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT ''
            );
            "#,
        )?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<AppSettings> {
        if !self.settings_path.exists() {
            let settings = AppSettings::default();
            self.save_settings(&settings)?;
            return Ok(settings);
        }
        let text = fs::read_to_string(&self.settings_path)?;
        let mut settings: AppSettings = serde_json::from_str(&text).unwrap_or_default();
        settings.settings_version = 1;
        normalize_reminders(&mut settings);
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        let mut normalized = settings.clone();
        normalize_reminders(&mut normalized);
        let payload = serde_json::to_string_pretty(&normalized)?;
        fs::write(&self.settings_path, payload)?;
        Ok(())
    }

    pub fn load_json_state(&self, name: &str) -> Result<Option<Value>> {
        let path = self.json_state_path(name)?;
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(path)?;
        Ok(Some(serde_json::from_str(&text)?))
    }

    pub fn save_json_state(&self, name: &str, value: &Value) -> Result<()> {
        let path = self.json_state_path(name)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(value)?)?;
        Ok(())
    }

    fn json_state_path(&self, name: &str) -> Result<PathBuf> {
        let safe = name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
        if !safe || name.is_empty() {
            anyhow::bail!("invalid json state name");
        }
        Ok(self.root.join("data").join(format!("{name}.json")))
    }

    pub fn list_sessions(&self, limit: Option<i64>) -> Result<Vec<WorkSession>> {
        let conn = self.conn()?;
        let sql = if limit.is_some() {
            "SELECT id, started_at, ended_at, last_seen_at, total_seconds, note, updated_at FROM work_sessions ORDER BY started_at DESC, id DESC LIMIT ?"
        } else {
            "SELECT id, started_at, ended_at, last_seen_at, total_seconds, note, updated_at FROM work_sessions ORDER BY started_at DESC, id DESC"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = if let Some(limit) = limit {
            stmt.query_map(params![limit], row_to_session)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map([], row_to_session)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows)
    }

    pub fn latest_open_session(&self) -> Result<Option<WorkSession>> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT id, started_at, ended_at, last_seen_at, total_seconds, note, updated_at
             FROM work_sessions WHERE ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1",
            [],
            row_to_session,
        )
        .optional()
        .context("query latest open session failed")
    }

    pub fn create_session(
        &self,
        started_at: String,
        total_seconds: i64,
        note: String,
    ) -> Result<i64> {
        let conn = self.conn()?;
        let now = now_string();
        conn.execute(
            "INSERT INTO work_sessions(started_at, last_seen_at, total_seconds, note, updated_at)
             VALUES (?, ?, ?, ?, ?)",
            params![started_at, now, total_seconds.max(0), note, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_session(&self, session: &WorkSession) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE work_sessions SET started_at=?, ended_at=?, last_seen_at=?, total_seconds=?, note=?, updated_at=? WHERE id=?",
            params![
                session.started_at,
                session.ended_at,
                session.last_seen_at,
                session.total_seconds.max(0),
                session.note,
                now_string(),
                session.id
            ],
        )?;
        Ok(())
    }

    pub fn close_session(&self, id: i64, ended_at: String) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE work_sessions SET ended_at=?, last_seen_at=?, updated_at=? WHERE id=? AND ended_at IS NULL",
            params![ended_at, ended_at, now_string(), id],
        )?;
        Ok(())
    }

    pub fn update_session_timing(
        &self,
        id: i64,
        total_seconds: i64,
        last_seen_at: String,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE work_sessions SET total_seconds=?, last_seen_at=?, updated_at=? WHERE id=? AND ended_at IS NULL",
            params![total_seconds.max(0), last_seen_at, now_string(), id],
        )?;
        Ok(())
    }

    pub fn delete_session(&self, id: i64) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM work_sessions WHERE id=?", params![id])?;
        Ok(())
    }

    pub fn log_event(&self, event_type: &str, detail: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO app_events(event_time, event_type, detail) VALUES (?, ?, ?)",
            params![now_string(), event_type, detail],
        )?;
        Ok(())
    }
}

fn preset_reminder_defaults(kind: &str) -> Option<(&'static str, &'static str, i64)> {
    match kind {
        "break" => Some(("break", "休息一下", 50)),
        "drink" => Some(("drink-water", "喝水提醒", 45)),
        "move" => Some(("move", "动一动提醒", 60)),
        _ => None,
    }
}

fn merge_preset_reminder(
    target: &mut Option<ReminderConfig>,
    mut reminder: ReminderConfig,
    id: &str,
    title: &str,
    default_interval: i64,
) {
    reminder.id = id.to_string();
    reminder.title = title.to_string();
    if reminder.interval_minutes <= 0 {
        reminder.interval_minutes = default_interval;
    }
    if reminder.work_minutes <= 0 {
        reminder.work_minutes = reminder.interval_minutes;
    }
    if let Some(existing) = target {
        existing.enabled = existing.enabled || reminder.enabled;
        if existing.interval_minutes <= 0 {
            existing.interval_minutes = reminder.interval_minutes;
        }
        if existing.work_minutes <= 0 {
            existing.work_minutes = reminder.work_minutes;
        }
        if existing.snooze_minutes <= 0 {
            existing.snooze_minutes = reminder.snooze_minutes;
        }
        if existing.max_completions <= 0 && reminder.max_completions > 0 {
            existing.max_completions = reminder.max_completions;
        }
        existing.important = existing.important || reminder.important;
        existing.escalate_enabled = existing.escalate_enabled || reminder.escalate_enabled;
        if existing.escalate_repeat_minutes <= 0 {
            existing.escalate_repeat_minutes = reminder.escalate_repeat_minutes;
        }
    } else {
        *target = Some(reminder);
    }
}

fn normalize_reminders(settings: &mut AppSettings) {
    let defaults = AppSettings::default().reminders;
    for reminder in &mut settings.reminders {
        if reminder.id == "rest" {
            reminder.kind = "break".to_string();
        }
        if reminder.id == "medicine" {
            reminder.kind = "custom".to_string();
            if reminder.title.trim().is_empty() {
                reminder.title = "喝药".to_string();
            }
        }
        if reminder.kind == "interval" {
            reminder.kind = "drink".to_string();
        }
        if reminder.kind == "work_duration" {
            reminder.kind = "break".to_string();
        }
        if reminder.kind == "fixed_time" {
            reminder.kind = "custom".to_string();
        }
        if let Some((id, title, default_interval)) = preset_reminder_defaults(&reminder.kind) {
            reminder.id = id.to_string();
            reminder.title = title.to_string();
            if reminder.interval_minutes <= 0 {
                reminder.interval_minutes = default_interval;
            }
            if reminder.work_minutes <= 0 {
                reminder.work_minutes = reminder.interval_minutes;
            }
        }
    }

    let mut break_reminder: Option<ReminderConfig> = None;
    let mut drink_reminder: Option<ReminderConfig> = None;
    let mut move_reminder: Option<ReminderConfig> = None;
    let mut custom_reminders = Vec::new();

    for reminder in settings.reminders.drain(..) {
        if let Some((id, title, interval)) = preset_reminder_defaults(&reminder.kind) {
            match reminder.kind.as_str() {
                "break" => {
                    merge_preset_reminder(&mut break_reminder, reminder, id, title, interval)
                }
                "drink" => {
                    merge_preset_reminder(&mut drink_reminder, reminder, id, title, interval)
                }
                "move" => merge_preset_reminder(&mut move_reminder, reminder, id, title, interval),
                _ => {}
            }
        } else {
            custom_reminders.push(reminder);
        }
    }

    for mut default in defaults {
        if let Some((id, title, default_interval)) = preset_reminder_defaults(&default.kind) {
            default.id = id.to_string();
            default.title = title.to_string();
            default.interval_minutes = default_interval;
            default.work_minutes = default_interval;
            match default.kind.as_str() {
                "break" if break_reminder.is_none() => break_reminder = Some(default),
                "drink" if drink_reminder.is_none() => drink_reminder = Some(default),
                "move" if move_reminder.is_none() => move_reminder = Some(default),
                _ => {}
            }
        }
    }

    settings.reminders = Vec::new();
    if let Some(reminder) = break_reminder {
        settings.reminders.push(reminder);
    }
    if let Some(reminder) = drink_reminder {
        settings.reminders.push(reminder);
    }
    if let Some(reminder) = move_reminder {
        settings.reminders.push(reminder);
    }
    settings.reminders.extend(custom_reminders);
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkSession> {
    Ok(WorkSession {
        id: row.get(0)?,
        started_at: row.get(1)?,
        ended_at: row.get(2)?,
        last_seen_at: row.get(3)?,
        total_seconds: row.get(4)?,
        note: row.get(5)?,
        updated_at: row.get(6)?,
    })
}
