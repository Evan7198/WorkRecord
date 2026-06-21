import { invoke } from "@tauri-apps/api/core";

export type ReminderConfig = {
  id: string;
  title: string;
  kind: string;
  enabled: boolean;
  time_of_day: string;
  interval_minutes: number;
  work_minutes: number;
  snooze_minutes: number;
  max_completions: number;
  important: boolean;
  escalate_enabled: boolean;
  escalate_repeat_minutes: number;
};

export type AppSettings = {
  settings_version: number;
  camera_index: number;
  detection_enabled: boolean;
  preview_enabled: boolean;
  preview_debug_overlay: boolean;
  presence_confirm_seconds: number;
  uncertain_grace_seconds: number;
  session_gap_hours: number;
  force_cut_enabled: boolean;
  force_cut_time: string;
  manual_end_requires_absence: boolean;
  yolo_confidence_threshold: number;
  yolo_min_box_area_ratio: number;
  yolo_inference_interval_ms: number;
  yolo_dark_mean_threshold: number;
  yolo_dark_stddev_threshold: number;
  yolo_low_signal_mean_threshold: number;
  yolo_low_signal_stddev_threshold: number;
  yolo_preset_name: string;
  yolo_model_path: string;
  yolo_device: string;
  roi_enabled: boolean;
  roi_x_percent: number;
  roi_y_percent: number;
  roi_w_percent: number;
  roi_h_percent: number;
  activity_assist_enabled: boolean;
  activity_idle_seconds: number;
  daily_target_minutes: number;
  weekly_target_minutes: number;
  monthly_target_minutes: number;
  theme_mode: string;
  language: string;
  start_minimized: boolean;
  autostart: boolean;
  sound_enabled: boolean;
  sound_name: string;
  custom_sound_path: string;
  feishu_enabled: boolean;
  feishu_webhook: string;
  feishu_secret: string;
  dnd_enabled: boolean;
  dnd_start: string;
  dnd_end: string;
  dnd_snooze_minutes: number;
  reminder_style: string;
  reminder_soft_notice_minutes: number;
  reminder_focus_grace_minutes: number;
  reminder_auto_snooze_when_present: boolean;
  show_hotkey: string;
  hide_hotkey: string;
  reminders: ReminderConfig[];
};

export type WorkSession = {
  id: number;
  started_at: string;
  ended_at?: string | null;
  last_seen_at?: string | null;
  total_seconds: number;
  note: string;
  updated_at: string;
};

export type Dashboard = {
  total_seconds: number;
  started_at?: string | null;
  status: string;
  detector_source: string;
  confidence: number;
  interruptions_last_hour: number;
  sessions: WorkSession[];
};

export type DetectionStatus = {
  backend: string;
  status: string;
  model: string;
  device: string;
  confidence_threshold: number;
  source: string;
  present: boolean;
  confidence: number;
  last_update_at?: string | null;
  last_seen_at?: string | null;
  note: string;
};

export const api = {
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  loadJsonState: <T>(name: string) => invoke<T | null>("load_json_state", { name }),
  saveJsonState: (name: string, value: unknown) => invoke<void>("save_json_state", { name, value }),
  getDashboard: () => invoke<Dashboard>("get_dashboard"),
  listSessions: () => invoke<WorkSession[]>("list_sessions"),
  startWorkday: () => invoke<number>("start_workday"),
  endWorkday: () => invoke<void>("end_workday"),
  deleteSession: (id: number) => invoke<void>("delete_session", { id }),
  updateSession: (session: WorkSession) => invoke<void>("update_session", { session }),
  createManualSession: (startedAt: string, totalSeconds: number, note: string) =>
    invoke<number>("create_manual_session", { startedAt, totalSeconds, note }),
  getDetectionStatus: () => invoke<DetectionStatus>("get_detection_status"),
  checkFeishuConfig: (webhook: string, secret: string) =>
    invoke<string>("check_feishu_config", { webhook, secret }),
  sendFeishuMessage: (title: string, text: string) =>
    invoke<void>("send_feishu_message", { title, text }),
  getDebugLogs: () => invoke<string>("get_debug_logs"),
  getDebugLoggingEnabled: () => invoke<boolean>("get_debug_logging_enabled"),
  setDebugLoggingEnabled: (enabled: boolean) => invoke<void>("set_debug_logging_enabled", { enabled }),
  exportDebugLogs: () => invoke<string>("export_debug_logs"),
  updatePresence: (present: boolean, confidence: number, source: string) =>
    invoke<DetectionStatus>("update_presence", { present, confidence, source })
};

export function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")}`;
}
