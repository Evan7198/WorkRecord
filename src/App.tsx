import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { motion } from "framer-motion";
import { emit, listen } from "@tauri-apps/api/event";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  Activity,
  Bell,
  Camera,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  Droplets,
  Dumbbell,
  Edit3,
  Gauge,
  History,
  Monitor,
  Moon,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Save,
  Send,
  Settings,
  Sparkles,
  Sun,
  Target
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { api, AppSettings, Dashboard, DetectionStatus, formatDuration, ReminderConfig, WorkSession } from "./api";
import { detectPersonFromVideo, getYoloRuntime, YoloBox } from "./yolo";

type Page = "dashboard" | "history" | "detection" | "settings" | "debug";
type ThemeMode = "system" | "light" | "dark";
type YoloPresetName = "sensitive" | "balanced" | "strict" | "custom";
type ReminderState = {
  completed: number;
  snoozedUntil: number;
  lastMilestone: number;
  fixedDate: string;
};
type ReminderActionPayload = {
  action: "complete" | "snooze" | "ignore" | "dismiss";
  id: string;
};

const YOLO_TUNING_KEYS = [
  "yolo_confidence_threshold",
  "yolo_min_box_area_ratio",
  "yolo_dark_mean_threshold",
  "yolo_dark_stddev_threshold",
  "yolo_low_signal_mean_threshold",
  "yolo_low_signal_stddev_threshold",
  "yolo_inference_interval_ms",
  "presence_confirm_seconds",
  "uncertain_grace_seconds"
] as const;

type YoloTuningKey = (typeof YOLO_TUNING_KEYS)[number];
type YoloTuningPatch = Pick<AppSettings, YoloTuningKey>;

const YOLO_PRESETS: Record<Exclude<YoloPresetName, "custom">, { label: string; desc: string; values: YoloTuningPatch }> = {
  sensitive: {
    label: "昏暗/灵敏",
    desc: "更容易识别侧身、背面、耳机遮挡，但误检风险略高。",
    values: {
      yolo_confidence_threshold: 0.25,
      yolo_min_box_area_ratio: 0.006,
      yolo_dark_mean_threshold: 22,
      yolo_dark_stddev_threshold: 14,
      yolo_low_signal_mean_threshold: 28,
      yolo_low_signal_stddev_threshold: 6,
      yolo_inference_interval_ms: 800,
      presence_confirm_seconds: 2,
      uncertain_grace_seconds: 12
    }
  },
  balanced: {
    label: "平衡",
    desc: "默认推荐，兼顾暗光、侧身和误检控制。",
    values: {
      yolo_confidence_threshold: 0.35,
      yolo_min_box_area_ratio: 0.012,
      yolo_dark_mean_threshold: 28,
      yolo_dark_stddev_threshold: 18,
      yolo_low_signal_mean_threshold: 35,
      yolo_low_signal_stddev_threshold: 10,
      yolo_inference_interval_ms: 1000,
      presence_confirm_seconds: 3,
      uncertain_grace_seconds: 8
    }
  },
  strict: {
    label: "强防误检",
    desc: "摄像头对着黑屏、墙面、弱纹理区域时更保守。",
    values: {
      yolo_confidence_threshold: 0.5,
      yolo_min_box_area_ratio: 0.02,
      yolo_dark_mean_threshold: 35,
      yolo_dark_stddev_threshold: 22,
      yolo_low_signal_mean_threshold: 45,
      yolo_low_signal_stddev_threshold: 15,
      yolo_inference_interval_ms: 1200,
      presence_confirm_seconds: 5,
      uncertain_grace_seconds: 5
    }
  }
};

const CUSTOM_PRESET_STATE = "custom_yolo_preset";
const APP_LOGO_URL = "/workrecord_logo_128.png";

function Card(props: { title?: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <motion.section
      className={`card ${props.className ?? ""}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
    >
      {props.title && (
        <div className="card-title">
          {props.icon}
          <span>{props.title}</span>
        </div>
      )}
      {props.children}
    </motion.section>
  );
}

function CollapsibleCard(props: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(Boolean(props.defaultCollapsed));

  return (
    <motion.section
      className={`card collapsible-card ${collapsed ? "is-collapsed" : ""} ${props.className ?? ""}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
    >
      <button
        type="button"
        className="card-title card-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span className="card-title-main">
          {props.icon}
          <span>{props.title}</span>
        </span>
        <span className="collapse-label">
          {collapsed ? "展开" : "收起"}
          <ChevronDown size={16} />
        </span>
      </button>
      <div
        className="card-body-clip"
        aria-hidden={collapsed}
      >
        <div className="card-body">
          {props.children}
        </div>
      </div>
    </motion.section>
  );
}

function Metric(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.hint && <small>{props.hint}</small>}
    </div>
  );
}

function NavItem(props: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`nav-item ${props.active ? "active" : ""}`} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function HelpLabel(props: { children: React.ReactNode; help: string }) {
  return (
    <label className="field-label">
      <span>{props.children}</span>
      <span className="help-dot" tabIndex={0}>?</span>
      <span className="help-tooltip">{props.help}</span>
    </label>
  );
}

function SwitchControl(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`switch-control ${props.checked ? "on" : ""} ${props.compact ? "compact" : ""}`}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {(props.label || props.description) && (
        <span className="switch-copy">
          {props.label && <strong>{props.label}</strong>}
          {props.description && <small>{props.description}</small>}
        </span>
      )}
    </button>
  );
}

function ThemeDock({
  settings,
  saveSettings
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
  resolvedTheme: Exclude<ThemeMode, "system">;
}) {
  const mode = normalizeThemeMode(settings.theme_mode);
  const items: Array<{ mode: ThemeMode; label: string; icon: React.ReactNode }> = [
    { mode: "system", label: "随系统", icon: <Monitor size={17} /> },
    { mode: "light", label: "白日", icon: <Sun size={17} /> },
    { mode: "dark", label: "暗夜", icon: <Moon size={17} /> }
  ];
  return (
    <div className="theme-dock icon-only" aria-label="主题切换">
      <div className="theme-segment">
        {items.map((item) => (
          <button
            key={item.mode}
            className={mode === item.mode ? "active" : ""}
            onClick={() => saveSettings({ ...settings, theme_mode: item.mode })}
            title={item.label}
          >
            {item.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReminderWindow() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const id = params.get("id") ?? "";
  const title = params.get("title") ?? "WorkRecord 提醒";
  const kind = params.get("kind") ?? "自定义提醒";
  const completed = params.get("completed") ?? "0";
  const snooze = params.get("snooze") ?? "10";
  const present = params.get("present") === "1";
  const workState = params.get("workState") ?? (present ? "正在计时" : "当前未确认在位");
  const important = params.get("important") === "1";
  const language = normalizeLanguage(params.get("language") ?? undefined);
  const actedRef = useRef(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => normalizeThemeMode(params.get("theme") ?? undefined));
  const [systemTheme, setSystemTheme] = useState<Exclude<ThemeMode, "system">>(() => getSystemTheme());
  const resolvedTheme = themeMode === "system" ? systemTheme : themeMode;
  useRuntimeTranslation(language);

  useEffect(() => {
    document.documentElement.classList.add("reminder-html");
    document.documentElement.lang = language;
    document.body.classList.add("reminder-body");
    return () => {
      document.body.classList.remove("reminder-body");
      document.documentElement.classList.remove("reminder-html");
      delete document.documentElement.dataset.theme;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api.getSettings()
      .then((settings) => {
        if (!alive) return;
        setThemeMode(normalizeThemeMode(settings.theme_mode));
        document.documentElement.lang = normalizeLanguage(settings.language);
      })
      .catch(() => {
        if (alive) setThemeMode("dark");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media) return;
    const onChange = () => setSystemTheme(getSystemTheme());
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  async function sendAction(action: ReminderActionPayload["action"]) {
    actedRef.current = true;
    await emit("reminder-action", { action, id } satisfies ReminderActionPayload);
    await getCurrentWindow().close();
  }

  function startWindowDrag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [data-no-drag]")) return;
    event.preventDefault();
    void getCurrentWindow().startDragging().catch(() => {});
  }

  useEffect(() => {
    return () => {
      if (!actedRef.current && id) {
        void emit("reminder-action", { action: "dismiss", id } satisfies ReminderActionPayload);
      }
    };
  }, [id]);

  return (
    <main className={`reminder-window ${important ? "important" : ""}`} onMouseDown={startWindowDrag}>
      <button className="reminder-window-close" onClick={() => sendAction("ignore")} aria-label="忽略本次">
        ×
      </button>
      <div className="reminder-window-glow" />
      <div className="reminder-window-head" data-tauri-drag-region>
        <div className="reminder-window-icon">
          <Bell size={24} />
        </div>
        <div>
          <span className="reminder-window-kind">{kind}</span>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="reminder-window-meta">
        <span>今日已完成 <strong>{completed}</strong> 次</span>
        {present ? <span className="present-dot">{workState}</span> : <span>{workState}</span>}
      </div>
      <div className="reminder-window-actions">
        <button className="button" onClick={() => sendAction("complete")}>
          <CheckCircle2 size={16} />完成
        </button>
        <button className="button secondary" onClick={() => sendAction("snooze")}>
          稍后 {snooze} 分钟
        </button>
        <button className="button ghost" onClick={() => sendAction("ignore")}>
          忽略本次
        </button>
      </div>
    </main>
  );
}

function SoftReminderWindow() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const id = params.get("id") ?? "";
  const title = params.get("title") ?? "WorkRecord 提醒";
  const kind = params.get("kind") ?? "自定义提醒";
  const completed = params.get("completed") ?? "0";
  const language = normalizeLanguage(params.get("language") ?? undefined);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => normalizeThemeMode(params.get("theme") ?? undefined));
  const [systemTheme, setSystemTheme] = useState<Exclude<ThemeMode, "system">>(() => getSystemTheme());
  const resolvedTheme = themeMode === "system" ? systemTheme : themeMode;
  useRuntimeTranslation(language);

  useEffect(() => {
    document.documentElement.classList.add("reminder-html");
    document.documentElement.lang = language;
    document.body.classList.add("reminder-body");
    return () => {
      document.body.classList.remove("reminder-body");
      document.documentElement.classList.remove("reminder-html");
      delete document.documentElement.dataset.theme;
    };
  }, [language]);

  useEffect(() => {
    let alive = true;
    api.getSettings()
      .then((settings) => {
        if (!alive) return;
        setThemeMode(normalizeThemeMode(settings.theme_mode));
        document.documentElement.lang = normalizeLanguage(settings.language);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media) return;
    const onChange = () => setSystemTheme(getSystemTheme());
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  async function closeBubble() {
    if (id) {
      await emit("reminder-action", { action: "ignore", id } satisfies ReminderActionPayload);
    }
    await getCurrentWindow().close();
  }

  function startWindowDrag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [data-no-drag]")) return;
    event.preventDefault();
    void getCurrentWindow().startDragging().catch(() => {});
  }

  return (
    <main className="soft-reminder-window" onMouseDown={startWindowDrag} onClick={() => closeBubble().catch(() => {})} title="点击关闭">
      <div className="soft-reminder-icon">
        <Bell size={18} />
      </div>
      <div className="soft-reminder-copy">
        <span>{kind}</span>
        <strong>{title}</strong>
        <small>今日已完成 {completed} 次</small>
      </div>
      <button
        className="soft-reminder-close"
        onClick={(event) => {
          event.stopPropagation();
          closeBubble().catch(() => {});
        }}
        aria-label="忽略本次"
        title="忽略本次"
      >
        ×
      </button>
    </main>
  );
}

function pickYoloTuning(settings: AppSettings): YoloTuningPatch {
  const picked = {} as YoloTuningPatch;
  for (const key of YOLO_TUNING_KEYS) {
    picked[key] = settings[key] as never;
  }
  return picked;
}

function patchMatches(settings: AppSettings, patch: YoloTuningPatch) {
  return YOLO_TUNING_KEYS.every((key) => Math.abs(Number(settings[key]) - Number(patch[key])) < 0.0001);
}

function detectYoloPreset(settings: AppSettings): YoloPresetName {
  for (const [name, preset] of Object.entries(YOLO_PRESETS) as Array<[Exclude<YoloPresetName, "custom">, typeof YOLO_PRESETS.balanced]>) {
    if (patchMatches(settings, preset.values)) {
      return name;
    }
  }
  return "custom";
}

function normalizeYoloPresetName(value?: string): YoloPresetName | null {
  return value === "sensitive" || value === "balanced" || value === "strict" || value === "custom" ? value : null;
}

function preferredYoloPreset(settings: AppSettings): YoloPresetName {
  return normalizeYoloPresetName(settings.yolo_preset_name) ?? detectYoloPreset(settings);
}

function yoloPresetLabel(preset: YoloPresetName) {
  return preset === "custom" ? "自定义" : YOLO_PRESETS[preset].label;
}

function loadCustomPreset() {
  return api.loadJsonState<YoloTuningPatch>(CUSTOM_PRESET_STATE);
}

function saveCustomPreset(values: YoloTuningPatch) {
  return api.saveJsonState(CUSTOM_PRESET_STATE, values);
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeThemeMode(value?: string): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function normalizeLanguage(value?: string) {
  return value === "en-US" ? "en-US" : "zh-CN";
}

const EN_TEXT: Record<string, string> = {
  "随系统": "System",
  "白日": "Light",
  "暗夜": "Dark",
  "主题切换": "Theme switcher",
  "主面板": "Dashboard",
  "历史统计": "History",
  "检测": "Detection",
  "检测与模型": "Detection & Model",
  "设置": "Settings",
  "刷新": "Refresh",
  "开始": "Start",
  "结束": "End",
  "收起": "Collapse",
  "展开": "Expand",
  "设置已保存": "Settings saved",
  "DEBUG 菜单已显示": "DEBUG menu is now visible",
  "已开始工作日": "Workday started",
  "已结束当前工作日": "Current workday ended",
  "当前工作日累计": "Current workday total",
  "加载中": "Loading",
  "累计中": "Counting",
  "状态": "Status",
  "开始时间": "Start time",
  "检测来源": "Detection source",
  "置信度": "Confidence",
  "近 1 小时中断": "Interruptions in last hour",
  "工作趋势": "Work trend",
  "历史记录": "History records",
  "结束/最近": "End / Latest",
  "累计": "Total",
  "备注": "Note",
  "删除": "Delete",
  "YOLO ONNX 检测模块": "YOLO ONNX detection module",
  "后端": "Backend",
  "运行中": "Running",
  "未启动": "Not started",
  "设备": "Device",
  "是否有人": "Presence",
  "有人": "Present",
  "无人": "Absent",
  "来源": "Source",
  "生效阈值": "Active threshold",
  "模型微调": "Model tuning",
  "环境预设": "Environment preset",
  "昏暗/灵敏": "Dim / Sensitive",
  "平衡": "Balanced",
  "强防误检": "Strict anti-false-positive",
  "自定义": "Custom",
  "自定义参数": "Custom parameters",
  "已微调": "Tuned",
  "待应用": "Pending apply",
  "已生效": "Active",
  "YOLO 置信度阈值": "YOLO confidence threshold",
  "应用": "Apply",
  "保存自定义": "Save custom",
  "重置当前预设": "Reset current preset",
  "摄像头调试": "Camera debug",
  "摄像头设备": "Camera device",
  "停止预览": "Stop preview",
  "开始预览": "Start preview",
  "显示 YOLO 方框": "Show YOLO boxes",
  "ROI 区域": "ROI area",
  "预览状态": "Preview status",
  "已停止": "Stopped",
  "分辨率": "Resolution",
  "未检测到人": "No person detected",
  "YOLO 叠框未开启": "YOLO overlay is off",
  "应用设置": "App settings",
  "启动后最小化到托盘": "Start minimized to tray",
  "关闭后，启动时直接显示主窗口。": "When off, show the main window on startup.",
  "关闭窗口时最小化到托盘": "Minimize to tray when closing",
  "关闭后，点击窗口关闭按钮会直接退出程序。": "When off, clicking the window close button exits the app.",
  "开机启动": "Start on boot",
  "跟随 Windows 登录自动启动。": "Start automatically after Windows login.",
  "主题": "Theme",
  "语言": "Language",
  "中文": "Chinese",
  "计时规则": "Timing rules",
  "每日目标": "Daily target",
  "提醒通道": "Reminder channels",
  "本机声音": "Local sound",
  "声音提示": "Sound alert",
  "内置：清脆提示": "Built-in: crisp alert",
  "内置：柔和铃声": "Built-in: soft bell",
  "试听": "Preview",
  "免打扰": "Do not disturb",
  "到": "to",
  "飞书机器人 Webhook": "Feishu bot webhook",
  "飞书签名 Secret": "Feishu signing secret",
  "可留空": "Optional",
  "检测配置": "Test config",
  "飞书提醒": "Feishu reminder",
  "低打扰策略": "Low-interruption strategy",
  "提醒策略": "Reminder strategy",
  "轻提示：不打断心流（推荐）": "Gentle: do not interrupt flow (recommended)",
  "普通：弹窗 + 轻声": "Normal: popup + soft sound",
  "严格：必须确认": "Strict: confirmation required",
  "人在专注时自动低打扰": "Use low-interruption mode when present",
  "关闭后，到点会立即提醒。": "When off, reminders appear immediately.",
  "预设提醒": "Preset reminders",
  "内置 3 个常用提醒": "Three built-in common reminders",
  "休息一下": "Take a break",
  "喝水提醒": "Drink water reminder",
  "动一动提醒": "Move around reminder",
  "预设提醒 · 今日完成": "Preset reminder · Completed today",
  "自定义提醒事项": "Custom reminders",
  "自定义提醒": "Custom reminder",
  "喝药、固定事项、循环间隔事项都在这里管理。": "Manage medicine, fixed-time tasks, and repeating interval tasks here.",
  "新增自定义": "Add custom",
  "暂无自定义提醒。": "No custom reminders.",
  "启用": "Enable",
  "提醒名称": "Reminder name",
  "提醒方式": "Reminder mode",
  "固定时间": "Fixed time",
  "循环间隔": "Recurring interval",
  "循环间隔（分钟）": "Recurring interval (min)",
  "累计工作间隔": "Work interval",
  "提醒间隔": "Reminder interval",
  "稍后分钟": "Snooze minutes",
  "完成多少次后停止": "Stop after completions",
  "重要提醒": "Important reminder",
  "更醒目的提醒窗口样式": "More prominent reminder window style",
  "未处理重复": "Repeat if unhandled",
  "未确认时按间隔再次提醒": "Remind again after interval if not confirmed",
  "重复间隔": "Repeat interval",
  "分钟": "min",
  "独立提醒窗未创建成功，已回落到主窗口内提醒。": "The separate reminder window failed; using in-window fallback.",
  "知道了": "Got it",
  "完成": "Done",
  "忽略本次": "Skip this time",
  "点击关闭": "Click to close",
  "今日已完成": "Completed today",
  "今日完成": "Completed today",
  "次": "times",
  "稍后": "Snooze",
  "秒": "s",
  "小时": "h",
  "每日目标：": "Daily target:",
  "柔性提示等待：": "Soft notice wait:",
  "专注宽限：": "Focus grace:",
  "当前草稿：": "Draft:",
  "最小人体框面积：": "Minimum person box area:",
  "检测周期：": "Detection interval:",
  "确认有人：": "Presence confirmation:",
  "离开宽限：": "Absence grace:",
  "黑屏亮度阈值：": "Black-screen brightness threshold:",
  "低信号纹理阈值：": "Low-signal texture threshold:",
  "连续未检测到人超过": "After no person is detected for over",
  "小时后，下次检测到人自动开启新工作日": "hours, the next detection starts a new workday",
  "· 已微调": "· Tuned",
  "· 待应用": "· Pending apply",
  "· 已生效": "· Active",
  "· 今日完成": "· Completed today",
  "当前未确认在位": "Presence not confirmed",
  "正在计时": "Counting",
  "WorkRecord 提醒": "WorkRecord reminder",
  "普通提醒体验": "Normal reminder test",
  "严格提醒体验": "Strict reminder test",
  "DEBUG 操作": "DEBUG actions",
  "记录计时 DEBUG 日志": "Record timing DEBUG logs",
  "默认关闭，开启后只写入内存日志。": "Off by default; when enabled, logs are written only to memory.",
  "轻提示：先弱提示再弹窗": "Gentle: weak notice then popup",
  "普通：直接弹窗 + 声音": "Normal: popup + sound",
  "严格：重要样式 + 未处理重复": "Strict: important style + repeat if unhandled",
  "在位状态": "Presence state",
  "重要样式": "Important style",
  "播放声音": "Play sound",
  "体验提醒策略": "Test reminder strategy",
  "触发测试弹窗": "Trigger test popup",
  "刷新日志": "Refresh logs",
  "导出日志": "Export logs",
  "日志窗口": "Log window",
  "暂无 DEBUG 日志。检测运行后会出现计时日志。": "No DEBUG logs yet. Timing logs appear after detection runs.",
  "默认不记录高频计时日志；只有勾选上方开关后才写入内存日志。需要时点击“导出日志”保存到运行目录。": "High-frequency timing logs are not recorded by default. Enable the switch above to keep them in memory, then click \"Export logs\" when needed.",
  "最近导出": "Last export",
  "最近导出：": "Last export:",
  "更容易识别侧身、背面、耳机遮挡，但误检风险略高。": "Easier to detect side view, back view, and headphones, with a slightly higher false-positive risk.",
  "默认推荐，兼顾暗光、侧身和误检控制。": "Recommended default. Balances low light, side view, and false-positive control.",
  "摄像头对着黑屏、墙面、弱纹理区域时更保守。": "More conservative for black screens, walls, and low-texture scenes.",
  "载入自定义预设": "Load custom preset",
  "先微调参数后点击“保存自定义”": "Tune parameters first, then click \"Save custom\"",
  "自定义参数已修改": "Custom parameters changed",
  "已切换预设": "Preset changed",
  "已切换预设，点击“应用”后才会生效。": "Preset changed. Click \"Apply\" to take effect.",
  "自定义参数已修改，点击“应用”后生效。": "Custom parameters changed. Click \"Apply\" to take effect.",
  "已应用到当前 YOLO 检测。": "Applied to current YOLO detection.",
  "已保存为自定义预设；点击“应用”后会用于检测。": "Saved as custom preset. Click \"Apply\" to use it for detection.",
  "还没有保存过自定义预设，无法恢复自定义默认值。": "No custom preset has been saved yet, so it cannot be restored.",
  "已恢复自定义预设的保存值，点击“应用”后生效。": "Restored the saved custom preset. Click \"Apply\" to take effect.",
  "还没有保存过自定义预设；可先微调参数后点击“保存自定义”。": "No custom preset has been saved yet. Tune parameters first, then click \"Save custom\".",
  "已载入自定义预设，点击“应用”后生效。": "Loaded the custom preset. Click \"Apply\" to take effect.",
  "YOLO 输出为空或格式不支持。": "YOLO output is empty or unsupported.",
  "摄像头尚未输出有效画面。": "The camera has not produced a valid frame yet.",
  "无法创建画面缓冲区。": "Failed to create the frame buffer.",
  "画面过暗或近似黑屏，跳过 YOLO 计时。": "The image is too dark or nearly black; skipping YOLO timing.",
  "画面信号不足，跳过 YOLO 计时。": "The image signal is too weak; skipping YOLO timing.",
  "检测已在设置中关闭；不会自动计时。": "Detection is disabled in settings; automatic timing is off.",
  "等待前端摄像头启动 YOLO ONNX 推理。": "Waiting for the frontend camera to start YOLO ONNX inference.",
  "YOLO 已检测到人，正在驱动自动计时。": "YOLO detected a person and is driving automatic timing.",
  "YOLO 当前未检测到人，计时暂停。": "YOLO does not currently detect a person; timing is paused.",
  "已关闭": "Off",
  "已开启": "On",
  "YOLO 已关闭": "YOLO disabled",
  "YOLO 启动中": "Starting YOLO",
  "YOLO 启动失败": "YOLO startup failed",
  "YOLO 错误": "YOLO error",
  "YOLO 自动计时未启动": "YOLO auto timing did not start",
  "YOLO 检测异常": "YOLO detection error",
  "YOLO 识别框": "YOLO boxes",
  "当前索引": "Current index",
  "叠框状态": "Overlay status",
  "ROI 检测区域": "ROI detection area",
  "只在指定画面区域内检测人体。开启后蓝色虚线区域会叠加显示在预览上。": "Detect people only inside the specified area. When enabled, a blue dashed area is shown on the preview.",
  "左": "Left",
  "上": "Top",
  "宽": "Width",
  "高": "Height",
  "点击“开始预览”调试摄像头": "Click \"Start preview\" to debug the camera",
  "未枚举到摄像头": "No camera enumerated",
  "摄像头": "Camera",
  "检测到人": "Person detected",
  "当前 WebView 不支持 getUserMedia。": "The current WebView does not support getUserMedia.",
  "这里用于调试摄像头画面、权限、ROI 区域和 YOLO 识别框；不影响后台自动计时逻辑。": "Use this page to debug the camera image, permissions, ROI area, and YOLO boxes. It does not affect background automatic timing.",
  "当前 WebView 不支持摄像头枚举。": "The current WebView does not support camera enumeration.",
  "当前 WebView 不支持 getUserMedia，无法打开摄像头预览。": "The current WebView does not support getUserMedia, so camera preview cannot be opened.",
  "摄像头打开失败": "Failed to open camera",
  "飞书配置已保存。": "Feishu configuration saved.",
  "未填写 Webhook，飞书提醒保持关闭。": "Webhook is empty; Feishu reminders remain disabled.",
  "正在检测飞书配置……": "Testing Feishu configuration...",
  "请先填写飞书机器人 Webhook。": "Please enter the Feishu bot webhook first.",
  "飞书 Webhook 必须是 http 或 https 地址。": "The Feishu webhook must be an http or https URL.",
  "Webhook 看起来不像飞书自定义机器人地址，请检查是否包含 /open-apis/bot/。": "The webhook does not look like a Feishu custom bot URL. Check that it contains /open-apis/bot/.",
  "飞书配置检测成功，已发送测试消息。": "Feishu configuration test succeeded; a test message was sent.",
  "自动保存失败": "Auto-save failed",
  "飞书开关失败": "Failed to toggle Feishu",
  "检测失败，飞书提醒已关闭": "Test failed; Feishu reminders disabled",
  "保存分钟": "Save minutes",
  "直接输入分钟": "Enter minutes directly",
  "确定删除这个自定义提醒吗？": "Delete this custom reminder?",
  "喝药": "Medicine",
  "优先右下角轻量提醒，不抢焦点。": "Prefer a lightweight bottom-right reminder without stealing focus.",
  "可按专注宽限延后，不强制中断。": "Can delay by the focus grace period without forcing an interruption.",
  "弹窗提供“完成”和“稍后”。": "The popup offers \"Done\" and \"Snooze\".",
  "可选择固定时间或循环间隔。": "Choose either a fixed time or a recurring interval.",
  "设置尚未加载，暂时无法触发弹窗": "Settings are not loaded yet; the popup cannot be triggered.",
  "DEBUG 提醒策略测试": "DEBUG reminder strategy test",
  "轻提示体验": "Gentle reminder test",
  "模拟正在计时": "Simulate counting",
  "读取 DEBUG 日志失败": "Failed to read DEBUG logs",
  "读取 DEBUG 日志开关失败": "Failed to read DEBUG log switch",
  "DEBUG 计时日志已开启": "DEBUG timing logs enabled",
  "DEBUG 计时日志已关闭": "DEBUG timing logs disabled",
  "已触发轻提示体验，约 1 秒后弹出提醒窗": "Gentle reminder test triggered. A popup will appear in about 1 second.",
  "已按所选策略触发提醒体验": "Reminder strategy test triggered.",
  "已触发 DEBUG 测试弹窗": "DEBUG test popup triggered.",
  "DEBUG 日志已导出到运行目录": "DEBUG logs exported to the runtime directory.",
  "提醒窗口创建超时，已切换到主窗口内提醒": "Reminder window creation timed out; switched to in-window reminder.",
  "提醒窗口打开失败": "Failed to open reminder window",
  "提醒窗口打开异常": "Reminder window exception",
  "提醒状态保存失败": "Failed to save reminder state",
  "提醒窗口监听失败": "Failed to listen for reminder window actions",
  "轻提示气泡创建超时，已切换到主窗口内提醒": "Soft reminder bubble timed out; switched to in-window reminder.",
  "轻提示气泡创建超时，已切换到提醒弹窗": "Soft reminder bubble timed out; switched to reminder popup.",
  "轻提示气泡打开失败": "Failed to open soft reminder bubble",
  "轻提示气泡打开异常": "Soft reminder bubble exception",
  "已触发轻提示气泡，约 1 秒后弹出提醒窗": "Soft reminder bubble triggered. A popup will appear in about 1 second.",
  "当前累计": "Current total",
  "手动开始": "Manual start",
  "托盘开始": "Tray start",
  "YOLO 自动开始": "YOLO auto start",
  "未知错误": "Unknown error",
  "值越高越不容易误判；值越低越容易识别侧脸、背面、耳机遮挡。": "Higher values reduce false positives; lower values make side faces, backs, and headphones easier to detect.",
  "过滤很小的人体框，减少黑屏、椅背、杂物造成的误检；太高会漏掉远距离人体。": "Filter very small person boxes to reduce false positives from black screens, chair backs, or clutter. Too high may miss distant people.",
  "两次 YOLO 推理之间的间隔。越短越灵敏但 CPU 更高；越长更省电。": "Interval between YOLO inferences. Shorter is more responsive but uses more CPU; longer saves power.",
  "连续检测到有人达到该时间后，才开始或恢复计时，用于减少瞬间误检。": "Start or resume timing only after a person has been detected continuously for this duration, reducing instant false positives.",
  "人体短暂消失时继续认为人在，适合低头吃饭、侧身、摄像头偶发漏检。": "Continue treating you as present during brief detection losses, useful for eating, turning sideways, or occasional camera misses.",
  "画面整体亮度低于该值且纹理也很低时，直接视为不可用黑屏，不交给 YOLO 误判。": "If overall brightness and texture are both below this value, treat the frame as unusable black screen and skip YOLO.",
  "画面纹理/对比度低于该值时，会被判定为低信号画面；提高可减少纯黑/纯色误检。": "Frames below this texture/contrast value are considered low-signal. Raising it reduces black/solid-color false positives.",
  "用于跨凌晨工作场景：离开时间超过阈值后，再次检测到人时会自动开启新的工作日。": "For work sessions across midnight: after absence exceeds the threshold, the next person detection starts a new workday.",
  "控制提醒弹出强度。轻提示不会抢焦点，适合避免打断心流。": "Controls reminder intensity. Gentle reminders do not steal focus and help avoid interrupting flow.",
  "先以桌面右下角轻提示气泡，等待这个时间后再升级为弹窗。": "First show a gentle desktop bubble in the bottom-right corner, then upgrade to a popup after this wait.",
  "如果检测到人仍在座位上，休息提醒可先延后这个时间，避免马上打断。": "If you are still detected at the desk, break reminders can be delayed by this duration to avoid immediate interruption.",
  "未开始": "Not started"
};

const EN_RULES: Array<[RegExp, (...args: string[]) => string]> = [
  [/^(.+) · 今日完成 (\d+) 次$/, (_all, a, b) => `${translateCoreText(a)} · Completed today ${b} times`],
  [/^今日已完成 (\d+) 次$/, (_all, a) => `Completed today ${a} times`],
  [/^今日完成 (\d+) 次$/, (_all, a) => `Completed today ${a} times`],
  [/^稍后 (\d+) 分钟$/, (_all, a) => `Snooze ${a} min`],
  [/^(\d+) 次$/, (_all, a) => `${a} times`],
  [/^(\d+)% \/ ([\d.]+) 小时$/, (_all, a, b) => `${a}% / ${b} h`],
  [/^当前草稿：(\d+)%。$/, (_all, a) => `Draft: ${a}%.`],
  [/^最小人体框面积：(.+)%$/, (_all, a) => `Minimum person box area: ${a}%`],
  [/^检测周期：(.+) ms$/, (_all, a) => `Detection interval: ${a} ms`],
  [/^确认有人：(\d+) 秒$/, (_all, a) => `Presence confirmation: ${a} s`],
  [/^离开宽限：(\d+) 秒$/, (_all, a) => `Absence grace: ${a} s`],
  [/^黑屏亮度阈值：(.+)$/, (_all, a) => `Black-screen brightness threshold: ${a}`],
  [/^低信号纹理阈值：(.+)$/, (_all, a) => `Low-signal texture threshold: ${a}`],
  [/^柔性提示等待：(\d+) 分钟$/, (_all, a) => `Soft notice wait: ${a} min`],
  [/^专注宽限：(\d+) 分钟$/, (_all, a) => `Focus grace: ${a} min`],
  [/^连续未检测到人超过 (\d+) 小时后，下次检测到人自动开启新工作日$/, (_all, a) => `After no person is detected for over ${a} hours, the next detection starts a new workday`],
  [/^每日目标：\s*(\d+) 分钟$/, (_all, a) => `Daily target: ${a} min`],
  [/^#1 休息一下 · #2 喝水提醒 · #3 动一动提醒$/, () => "#1 Take a break · #2 Drink water · #3 Move around"],
  [/^到达休息时间：(.+)$/, (_all, a) => `When break time arrives: ${translateCoreText(a)}`],
  [/^用户仍在镜头前：(.+)$/, (_all, a) => `If you are still in frame: ${translateCoreText(a)}`],
  [/^宽限后仍未休息：(.+)$/, (_all, a) => `After grace period: ${translateCoreText(a)}`],
  [/^喝药等事项归入自定义提醒，(.+)$/, (_all, a) => `Medicine and similar tasks are custom reminders; ${translateCoreText(a)}`],
  [/^(.+)，点击“应用”后生效。$/, (_all, a) => `${translateCoreText(a)}. Click "Apply" to take effect.`],
  [/^已恢复(.+)预设默认值，点击“应用”后生效。$/, (_all, a) => `Restored ${translateCoreText(a)} preset defaults. Click "Apply" to take effect.`],
  [/^(.+)预设已微调，点击“应用”后生效。$/, (_all, a) => `${translateCoreText(a)} preset has been tuned. Click "Apply" to take effect.`],
  [/^飞书提醒发送失败：(.+)$/, (_all, a) => `Failed to send Feishu reminder: ${a}`],
  [/^提醒窗口打开异常：(.+)$/, (_all, a) => `Failed to open reminder window: ${a}`],
  [/^提醒窗口打开失败：(.+)$/, (_all, a) => `Failed to open reminder window: ${a}`],
  [/^提醒窗口监听失败：(.+)$/, (_all, a) => `Failed to listen for reminder window actions: ${a}`],
  [/^轻提示气泡打开失败：(.+)$/, (_all, a) => `Failed to open soft reminder bubble: ${a}`],
  [/^轻提示气泡打开异常：(.+)$/, (_all, a) => `Soft reminder bubble exception: ${a}`],
  [/^提醒状态保存失败：(.+)$/, (_all, a) => `Failed to save reminder state: ${a}`],
  [/^读取 DEBUG 日志失败：(.+)$/, (_all, a) => `Failed to read DEBUG logs: ${a}`],
  [/^读取 DEBUG 日志开关失败：(.+)$/, (_all, a) => `Failed to read DEBUG log switch: ${a}`],
  [/^YOLO 检测异常：(.+)$/, (_all, a) => `YOLO detection error: ${a}`],
  [/^YOLO 自动计时未启动：(.+)$/, (_all, a) => `YOLO auto timing did not start: ${a}`],
  [/^YOLO 叠框失败：(.+)$/, (_all, a) => `YOLO overlay failed: ${a}`],
  [/^摄像头打开失败：(.+)$/, (_all, a) => `Failed to open camera: ${a}`],
  [/^摄像头 (\d+)$/, (_all, a) => `Camera ${a}`],
  [/^YOLO：(.+) · (\d+)%$/, (_all, a, b) => `YOLO: ${translateCoreText(a)} · ${b}%`],
  [/^自动保存失败：(.+)$/, (_all, a) => `Auto-save failed: ${a}`],
  [/^飞书开关失败：(.+)$/, (_all, a) => `Failed to toggle Feishu: ${a}`],
  [/^检测失败，飞书提醒已关闭：(.+)$/, (_all, a) => `Test failed; Feishu reminders disabled: ${a}`],
  [/^飞书机器人返回错误 code=(.+)：(.+)$/, (_all, a, b) => `Feishu bot returned error code=${a}: ${b}`],
  [/^无法获取当前程序路径：(.+)$/, (_all, a) => `Failed to get current executable path: ${a}`],
  [/^无法获取运行目录：(.+)$/, (_all, a) => `Failed to get runtime directory: ${a}`],
  [/^无法启动 PowerShell 发送飞书消息：(.+)$/, (_all, a) => `Failed to start PowerShell for Feishu message: ${a}`],
  [/^飞书请求失败：(.+)$/, (_all, a) => `Feishu request failed: ${a}`],
  [/^无法执行 (.+)：(.+)$/, (_all, a, b) => `Failed to execute ${a}: ${b}`],
  [/^开机启动注册失败：(.+)$/, (_all, a) => `Failed to register startup entry: ${a}`],
  [/^日志导出失败：(.+)$/, (_all, a) => `Failed to export logs: ${a}`],
  [/^最近导出：(.+)$/, (_all, a) => `Last export: ${a}`]
];

function translateCoreText(text: string): string {
  const direct = EN_TEXT[text];
  if (direct) return direct;
  for (const [pattern, replacer] of EN_RULES) {
    const match = text.match(pattern);
    if (match) return replacer(...match);
  }
  return text;
}

function translateText(text: string): string {
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  const core = text.trim();
  if (!core) return text;
  const translated = translateCoreText(core);
  return translated === core ? text : `${leading}${translated}${trailing}`;
}

function translateForLanguage(language: ReturnType<typeof normalizeLanguage>, text: string) {
  return language === "en-US" ? translateCoreText(text) : text;
}

function shouldSkipTranslation(node: Node) {
  const parent = node.parentElement;
  return Boolean(parent?.closest("script, style, textarea, code, pre, .debug-log-window"));
}

function translateAttributes(element: Element) {
  for (const attr of ["placeholder", "title", "aria-label"]) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const next = translateText(value);
    if (next !== value) element.setAttribute(attr, next);
  }
}

function translateNodeTree(node: Node) {
  if (shouldSkipTranslation(node)) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const next = translateText(node.textContent ?? "");
    if (next !== node.textContent) node.textContent = next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  if (element.closest("script, style, textarea, code, pre, .debug-log-window")) return;
  translateAttributes(element);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      if (!shouldSkipTranslation(current)) {
        const next = translateText(current.textContent ?? "");
        if (next !== current.textContent) current.textContent = next;
      }
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      translateAttributes(current as Element);
    }
    current = walker.nextNode();
  }
}

function useRuntimeTranslation(language: ReturnType<typeof normalizeLanguage>) {
  useLayoutEffect(() => {
    if (language !== "en-US") return;
    translateNodeTree(document.body);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          translateNodeTree(mutation.target);
        } else if (mutation.type === "childList") {
          mutation.addedNodes.forEach(translateNodeTree);
        } else if (mutation.type === "attributes") {
          translateNodeTree(mutation.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["placeholder", "title", "aria-label"]
    });
    return () => observer.disconnect();
  }, [language]);
}

function getSystemTheme(): Exclude<ThemeMode, "system"> {
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function themeModeLabel(mode: ThemeMode) {
  if (mode === "system") return "随系统";
  if (mode === "light") return "白日";
  return "暗夜";
}

export default function App() {
  if (window.location.hash.startsWith("#/reminder")) {
    return <ReminderWindow />;
  }
  if (window.location.hash.startsWith("#/soft-reminder")) {
    return <SoftReminderWindow />;
  }

  const [page, setPage] = useState<Page>("dashboard");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [detector, setDetector] = useState<DetectionStatus | null>(null);
  const [message, setMessage] = useState("");
  const [debugUnlocked, setDebugUnlocked] = useState(false);
  const [logoClicks, setLogoClicks] = useState(0);
  const [systemTheme, setSystemTheme] = useState<Exclude<ThemeMode, "system">>(() => getSystemTheme());

  async function refresh() {
    const [d, s, h, det] = await Promise.all([
      api.getDashboard(),
      api.getSettings(),
      api.listSessions(),
      api.getDetectionStatus()
    ]);
    setDashboard(d);
    setSettings(s);
    setSessions(h);
    setDetector(det);
  }

  useEffect(() => {
    refresh().catch((e) => setMessage(String(e)));
    const id = window.setInterval(() => refresh().catch(() => {}), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(""), 2600);
    return () => window.clearTimeout(id);
  }, [message]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media) return;
    const onChange = () => setSystemTheme(getSystemTheme());
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  async function start() {
    await api.startWorkday();
    setMessage("已开始工作日");
    await refresh();
  }

  async function end() {
    await api.endWorkday();
    setMessage("已结束当前工作日");
    await refresh();
  }

  async function saveSettings(next: AppSettings) {
    await api.saveSettings(next);
    setSettings(next);
    setMessage("设置已保存");
    await refresh();
  }

  function handleLogoClick() {
    if (debugUnlocked) return;
    setLogoClicks((count) => {
      const next = count + 1;
      if (next >= 20) {
        setDebugUnlocked(true);
        setMessage("DEBUG 菜单已显示");
      }
      return next;
    });
  }

  const chartData = useMemo(
    () =>
      [...sessions]
        .reverse()
        .slice(-14)
        .map((s) => ({
          date: s.started_at.slice(5, 10),
          hours: Number((s.total_seconds / 3600).toFixed(2))
        })),
    [sessions]
  );
  const themeMode = normalizeThemeMode(settings?.theme_mode);
  const resolvedTheme = themeMode === "system" ? systemTheme : themeMode;
  const language = normalizeLanguage(settings?.language);
  useRuntimeTranslation(language);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <main className="shell" key={language}>
      <aside className="sidebar">
        <div className="brand">
          <div
            className="brand-mark"
            onClick={handleLogoClick}
          >
            <img src={APP_LOGO_URL} alt="WorkRecord" draggable={false} />
          </div>
          <div>
            <strong>WorkRecord</strong>
          </div>
        </div>
        <nav>
          <NavItem active={page === "dashboard"} icon={<Gauge />} label="主面板" onClick={() => setPage("dashboard")} />
          <NavItem active={page === "history"} icon={<History />} label="历史统计" onClick={() => setPage("history")} />
          <NavItem active={page === "detection"} icon={<Camera />} label="检测" onClick={() => setPage("detection")} />
          <NavItem active={page === "settings"} icon={<Settings />} label="设置" onClick={() => setPage("settings")} />
          {debugUnlocked && (
            <NavItem active={page === "debug"} icon={<Sparkles />} label="DEBUG" onClick={() => setPage("debug")} />
          )}
        </nav>
        <div className="sidebar-footer">
          {settings && <ThemeDock settings={settings} saveSettings={saveSettings} resolvedTheme={resolvedTheme} />}
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h1>{pageTitle(page)}</h1>
          </div>
          <div className="actions">
            <button className="button secondary refresh-button" onClick={refresh}><RotateCcw size={16} />刷新</button>
            {page !== "dashboard" && (
              <>
                <button className="button work-start" onClick={start}><PlayCircle size={16} />开始</button>
                <button className="button work-end" onClick={end}><PauseCircle size={16} />结束</button>
              </>
            )}
          </div>
        </header>

        {message && (
          <motion.div
            className="toast floating-toast"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.18 }}
          >
            {message}
          </motion.div>
        )}
        {settings && <YoloAutoTimer settings={settings} onStatus={setDetector} onMessage={setMessage} onTick={refresh} />}
        {settings && dashboard && <ReminderRuntime settings={settings} dashboard={dashboard} detector={detector} onMessage={setMessage} />}

        {page === "dashboard" && <DashboardPage dashboard={dashboard} detector={detector} settings={settings} chartData={chartData} />}
        {page === "history" && <HistoryPage sessions={sessions} refresh={refresh} />}
        {page === "detection" && <DetectionPage detector={detector} settings={settings} saveSettings={saveSettings} />}
        {page === "settings" && settings && <SettingsPage settings={settings} saveSettings={saveSettings} />}
        {page === "debug" && debugUnlocked && (
          <DebugPage settings={settings} dashboard={dashboard} detector={detector} onMessage={setMessage} />
        )}
      </section>
    </main>
  );
}

function pageTitle(page: Page) {
  return {
    dashboard: "主面板",
    history: "历史统计",
    detection: "检测与模型",
    settings: "设置",
    debug: "DEBUG"
  }[page];
}

function YoloAutoTimer({
  settings,
  onStatus,
  onMessage,
  onTick
}: {
  settings: AppSettings;
  onStatus: (status: DetectionStatus) => void;
  onMessage: (message: string) => void;
  onTick: () => Promise<void>;
}) {
  const stateRef = useRef({
    confirmed: false,
    candidate: null as boolean | null,
    candidateSince: 0
  });

  const configKey = [
    settings.detection_enabled,
    settings.camera_index,
    settings.presence_confirm_seconds,
    settings.uncertain_grace_seconds,
    settings.yolo_inference_interval_ms,
    settings.yolo_confidence_threshold,
    settings.yolo_min_box_area_ratio,
    settings.yolo_dark_mean_threshold,
    settings.yolo_dark_stddev_threshold,
    settings.yolo_low_signal_mean_threshold,
    settings.yolo_low_signal_stddev_threshold,
    settings.roi_enabled,
    settings.roi_x_percent,
    settings.roi_y_percent,
    settings.roi_w_percent,
    settings.roi_h_percent
  ].join("|");

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    const canvas = document.createElement("canvas");

    async function stopCamera() {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      video = null;
    }

    async function openCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前 WebView 不支持 getUserMedia。");
      }

      let selectedDevice: MediaDeviceInfo | undefined;
      if (navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((device) => device.kind === "videoinput");
        selectedDevice = cameras[settings.camera_index];
      }

      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 5, max: 10 }
      };
      if (selectedDevice?.deviceId) {
        videoConstraints.deviceId = { exact: selectedDevice.deviceId };
      }

      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      return video;
    }

    async function loop() {
      if (!settings.detection_enabled) {
        const status = await api.updatePresence(false, 0, "YOLO 已关闭");
        if (!cancelled) onStatus(status);
        return;
      }

      const runtime = await getYoloRuntime();
      const videoElement = await openCamera();
      if (!cancelled) {
        const status = await api.updatePresence(false, 0, "YOLO 启动中");
        onStatus(status);
      }

      while (!cancelled) {
        const loopStarted = performance.now();
        try {
          const result = await detectPersonFromVideo(runtime, videoElement, canvas, settings);
          const confirmed = settlePresence(result.present, performance.now(), settings, stateRef.current);
          const source = confirmed && !result.present ? "YOLO grace" : result.source;
          const status = await api.updatePresence(confirmed, confirmed ? result.confidence : 0, source);
          if (!cancelled) {
            onStatus(status);
            void onTick();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = await api.updatePresence(false, 0, `YOLO 错误`);
          if (!cancelled) {
            onStatus(status);
            onMessage(`YOLO 检测异常：${message}`);
          }
          await sleep(2500);
        }
        const elapsed = performance.now() - loopStarted;
        await sleep(Math.max(150, settings.yolo_inference_interval_ms - elapsed));
      }
    }

    loop().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const status = await api.updatePresence(false, 0, "YOLO 启动失败");
        if (!cancelled) onStatus(status);
      } catch {
        // ignore status update failure
      }
      if (!cancelled) {
        onMessage(`YOLO 自动计时未启动：${message}`);
      }
    });

    return () => {
      cancelled = true;
      stopCamera();
    };
    // configKey 覆盖了会影响检测的设置；避免每次刷新 settings 对象都重启摄像头。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  return null;
}

function settlePresence(
  detected: boolean,
  nowMs: number,
  settings: AppSettings,
  state: { confirmed: boolean; candidate: boolean | null; candidateSince: number }
) {
  if (detected === state.confirmed) {
    state.candidate = null;
    state.candidateSince = 0;
    return state.confirmed;
  }

  if (state.candidate !== detected) {
    state.candidate = detected;
    state.candidateSince = nowMs;
    return state.confirmed;
  }

  const waitMs = Math.max(0, detected ? settings.presence_confirm_seconds : settings.uncertain_grace_seconds) * 1000;
  if (nowMs - state.candidateSince >= waitMs) {
    state.confirmed = detected;
    state.candidate = null;
    state.candidateSince = 0;
  }

  return state.confirmed;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function reminderStateStorageName() {
  return `reminder_state_${todayKey()}`;
}

async function loadReminderStates(): Promise<Record<string, ReminderState>> {
  return (await api.loadJsonState<Record<string, ReminderState>>(reminderStateStorageName())) ?? {};
}

function saveReminderStates(states: Record<string, ReminderState>) {
  return api.saveJsonState(reminderStateStorageName(), states);
}

function getReminderState(states: Record<string, ReminderState>, id: string): ReminderState {
  return states[id] ?? { completed: 0, snoozedUntil: 0, lastMilestone: 0, fixedDate: "" };
}

function reminderIntervalMinutes(reminder: ReminderConfig) {
  if (reminder.kind === "break") return Math.max(1, reminder.work_minutes || reminder.interval_minutes || 50);
  if (reminder.kind === "custom" && reminder.interval_minutes <= 0) return 0;
  return Math.max(1, reminder.interval_minutes || reminder.work_minutes || 45);
}

function isPresetReminder(reminder: ReminderConfig) {
  return reminder.kind === "break" || reminder.kind === "drink" || reminder.kind === "move";
}

function reminderKindText(kind: string) {
  if (kind === "break" || kind === "drink" || kind === "move") return "预设提醒";
  return "自定义提醒";
}

function reminderTitleText(reminder: ReminderConfig) {
  if (reminder.kind === "break") return "休息一下";
  if (reminder.kind === "drink") return "喝水提醒";
  if (reminder.kind === "move") return "动一动提醒";
  return reminder.title;
}

function reminderKindOrder(kind: string) {
  if (kind === "break") return 1;
  if (kind === "drink") return 2;
  if (kind === "move") return 3;
  return 99;
}

function customReminderMode(reminder: ReminderConfig): "fixed" | "interval" {
  return reminder.time_of_day?.trim() ? "fixed" : "interval";
}

function reminderIcon(kind: string) {
  if (kind === "drink") return <Droplets size={16} />;
  if (kind === "move") return <Dumbbell size={16} />;
  if (kind === "break") return <Clock3 size={16} />;
  return <Bell size={16} />;
}

function isDndNow(settings: AppSettings) {
  if (!settings.dnd_enabled) return false;
  const now = new Date();
  const value = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = settings.dnd_start.split(":").map(Number);
  const [endH, endM] = settings.dnd_end.split(":").map(Number);
  const start = (startH || 0) * 60 + (startM || 0);
  const end = (endH || 0) * 60 + (endM || 0);
  if (start === end) return false;
  return start < end ? value >= start && value < end : value >= start || value < end;
}

function playReminderSound(settings: AppSettings, force = false) {
  if (!force && (!settings.sound_enabled || isDndNow(settings))) return;
  try {
    if (settings.custom_sound_path.trim()) {
      const audio = new Audio(settings.custom_sound_path.trim());
      audio.volume = 0.45;
      void audio.play();
      return;
    }
    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.value = settings.sound_name === "SoftBell" ? 660 : 880;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + 0.18);
  } catch {
    // 声音失败不影响提醒本身。
  }
}

function findDueReminder(settings: AppSettings, dashboard: Dashboard, states: Record<string, ReminderState>) {
  if (isDndNow(settings)) return null;
  const totalMinutes = Math.floor((dashboard.total_seconds ?? 0) / 60);
  const now = Date.now();
  const today = todayKey();
  const timeNow = new Date().toTimeString().slice(0, 5);

  for (const reminder of settings.reminders) {
    if (!reminder.enabled) continue;
    const state = getReminderState(states, reminder.id);
    if (reminder.max_completions > 0 && state.completed >= reminder.max_completions) continue;
    if (state.snoozedUntil > now) continue;

    if (reminder.kind === "custom" && reminder.time_of_day?.trim()) {
      if (timeNow >= reminder.time_of_day && state.fixedDate !== today) {
        return reminder;
      }
      continue;
    }

    const interval = reminderIntervalMinutes(reminder);
    if (interval <= 0) continue;
    const milestone = Math.floor(totalMinutes / interval);
    if (milestone > 0 && milestone > state.lastMilestone) {
      return reminder;
    }
  }
  return null;
}

function isActivelyCounting(dashboard: Dashboard | null, detector: DetectionStatus | null) {
  if (detector?.present) return true;
  if (!dashboard || dashboard.status !== "累计中") return false;
  return (dashboard.confidence ?? 0) > 0;
}

const SOFT_REMINDER_WIDTH = 360;
const SOFT_REMINDER_HEIGHT = 118;

async function placeWindowBottomRight(windowRef: WebviewWindow, width: number, height: number) {
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  if (!monitor) return;
  const scale = monitor.scaleFactor || 1;
  const margin = Math.round(22 * scale);
  const x = monitor.workArea.position.x + monitor.workArea.size.width - Math.round(width * scale) - margin;
  const y = monitor.workArea.position.y + monitor.workArea.size.height - Math.round(height * scale) - margin;
  await windowRef.setPosition(new PhysicalPosition(Math.max(monitor.workArea.position.x, x), Math.max(monitor.workArea.position.y, y)));
}

function openSoftReminderWindow(
  reminder: ReminderConfig,
  state: ReminderState,
  settings: AppSettings,
  onMessage: (message: string) => void,
  onWindowError: () => void
): WebviewWindow | null {
  const params = new URLSearchParams({
    id: reminder.id,
    title: reminderTitleText(reminder),
    kind: reminderKindText(reminder.kind),
    completed: String(state.completed),
    theme: normalizeThemeMode(settings.theme_mode),
    language: normalizeLanguage(settings.language)
  });
  try {
    const label = `soft-reminder-${reminder.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now()}`;
    const windowRef = new WebviewWindow(label, {
      url: `index.html#/soft-reminder?${params.toString()}`,
      title: `WorkRecord - ${reminder.title}`,
      width: SOFT_REMINDER_WIDTH,
      height: SOFT_REMINDER_HEIGHT,
      decorations: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      alwaysOnTop: true,
      focus: false,
      focusable: true,
      skipTaskbar: true,
      shadow: false,
      transparent: true,
      visible: false
    });
    let settled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      onMessage("轻提示气泡创建超时，已切换到提醒弹窗");
      onWindowError();
    }, 1800);
    windowRef
      .once("tauri://created", async () => {
        if (settled) {
          windowRef.close().catch(() => {});
          return;
        }
        settled = true;
        window.clearTimeout(fallbackTimer);
        await placeWindowBottomRight(windowRef, SOFT_REMINDER_WIDTH, SOFT_REMINDER_HEIGHT).catch(() => {});
        await windowRef.show().catch((error) => {
          onMessage(`轻提示气泡打开异常：${String(error)}`);
          windowRef.close().catch(() => {});
          onWindowError();
        });
      })
      .catch(() => {});
    windowRef
      .once("tauri://error", (event) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallbackTimer);
        onMessage(`轻提示气泡打开失败：${String(event.payload)}`);
        onWindowError();
      })
      .catch(() => {});
    return windowRef;
  } catch (error) {
    onMessage(`轻提示气泡打开异常：${String(error)}`);
    onWindowError();
    return null;
  }
}

function openReminderWindow(
  reminder: ReminderConfig,
  state: ReminderState,
  settings: AppSettings,
  dashboard: Dashboard,
  detector: DetectionStatus | null,
  onMessage: (message: string) => void,
  onWindowError: () => void
) {
  const activelyCounting = isActivelyCounting(dashboard, detector);
  const params = new URLSearchParams({
    id: reminder.id,
    title: reminderTitleText(reminder),
    kind: reminderKindText(reminder.kind),
    completed: String(state.completed),
    snooze: String(reminder.snooze_minutes || settings.dnd_snooze_minutes || 10),
    important: reminder.important ? "1" : "0",
    present: activelyCounting ? "1" : "0",
    workState: activelyCounting ? "正在计时" : "当前未确认在位",
    total: formatDuration(dashboard.total_seconds),
    theme: normalizeThemeMode(settings.theme_mode),
    language: normalizeLanguage(settings.language)
  });
  try {
    const label = `reminder-${reminder.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now()}`;
    const windowRef = new WebviewWindow(label, {
      url: `index.html#/reminder?${params.toString()}`,
      title: `WorkRecord - ${reminder.title}`,
      width: 460,
      height: 244,
      decorations: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      alwaysOnTop: true,
      center: true,
      focus: false,
      focusable: false,
      skipTaskbar: true,
      shadow: false,
      transparent: true
    });
    let settled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      onMessage("提醒窗口创建超时，已切换到主窗口内提醒");
      onWindowError();
    }, 1800);
    windowRef
      .once("tauri://created", () => {
        if (settled) {
          windowRef.close().catch(() => {});
          return;
        }
        settled = true;
        window.clearTimeout(fallbackTimer);
      })
      .catch(() => {});
    windowRef
      .once("tauri://error", (event) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallbackTimer);
        onMessage(`提醒窗口打开失败：${String(event.payload)}`);
        onWindowError();
      })
      .catch(() => {});
  } catch (error) {
    onMessage(`提醒窗口打开异常：${String(error)}`);
    onWindowError();
  }

}

function ReminderRuntime({
  settings,
  dashboard,
  detector,
  onMessage
}: {
  settings: AppSettings;
  dashboard: Dashboard;
  detector: DetectionStatus | null;
  onMessage: (message: string) => void;
}) {
  const [states, setStates] = useState<Record<string, ReminderState>>({});
  const [statesLoaded, setStatesLoaded] = useState(false);
  const [active, setActive] = useState<ReminderConfig | null>(null);
  const [inlineFallback, setInlineFallback] = useState(false);
  const promptedRef = useRef<string>("");
  const escalationTimerRef = useRef<number | null>(null);

  function clearEscalationTimer() {
    if (escalationTimerRef.current !== null) {
      window.clearTimeout(escalationTimerRef.current);
      escalationTimerRef.current = null;
    }
  }

  useEffect(() => {
    loadReminderStates()
      .then((current) => {
        setStates(current);
        setStatesLoaded(true);
      })
      .catch(() => setStatesLoaded(true));
  }, [settings.reminders]);

  useEffect(() => () => clearEscalationTimer(), []);

  useEffect(() => {
    if (!statesLoaded) return;
    if (active) return;
    const due = findDueReminder(settings, dashboard, states);
    if (!due) return;

    const interval = reminderIntervalMinutes(due);
    const milestone = interval > 0 ? Math.floor(Math.floor(dashboard.total_seconds / 60) / interval) : 0;
    const promptKey = `${todayKey()}|${due.id}|${milestone || due.time_of_day}`;
    if (promptedRef.current === promptKey) return;
    promptedRef.current = promptKey;
    setActive(due);
    setInlineFallback(false);
    clearEscalationTimer();

    const reminderState = getReminderState(states, due.id);
    const openFullReminder = () =>
      openReminderWindow(due, reminderState, settings, dashboard, detector, onMessage, () => {
        setInlineFallback(true);
      });

    if (settings.reminder_style === "gentle") {
      let softWindow: WebviewWindow | null = null;
      const handleSoftWindowError = () => {
        clearEscalationTimer();
        softWindow?.close().catch(() => {});
        openFullReminder();
      };
      softWindow = openSoftReminderWindow(due, reminderState, settings, onMessage, handleSoftWindowError);
      if (softWindow) {
        const waitMs = Math.max(0, settings.reminder_soft_notice_minutes || 0) * 60_000;
        escalationTimerRef.current = window.setTimeout(() => {
          escalationTimerRef.current = null;
          softWindow?.close().catch(() => {});
          openFullReminder();
        }, waitMs);
      }
    } else {
      openFullReminder();
    }

    const reminderLanguage = normalizeLanguage(settings.language);
    const reminderKind = translateForLanguage(reminderLanguage, reminderKindText(due.kind));
    const reminderTitle = translateForLanguage(reminderLanguage, reminderTitleText(due));
    const currentTotalLabel = translateForLanguage(reminderLanguage, "当前累计");
    const separator = reminderLanguage === "en-US" ? ": " : "：";
    const body = `${reminderKind}${separator}${reminderTitle}`;
    playReminderSound(settings);
    if (settings.feishu_enabled && settings.feishu_webhook.trim()) {
      api
        .sendFeishuMessage(translateForLanguage(reminderLanguage, "WorkRecord 提醒"), `${body}\n${currentTotalLabel}${separator}${formatDuration(dashboard.total_seconds)}`)
        .catch((error) => onMessage(`飞书提醒发送失败：${String(error)}`));
    }
  }, [
    active,
    dashboard.status,
    dashboard.total_seconds,
    dashboard.confidence,
    detector?.present,
    settings,
    states,
    statesLoaded,
    onMessage
  ]);

  function complete(reminder: ReminderConfig) {
    clearEscalationTimer();
    const interval = reminderIntervalMinutes(reminder);
    const milestone = interval > 0 ? Math.floor(Math.floor(dashboard.total_seconds / 60) / interval) : 0;
    const next = {
      ...states,
      [reminder.id]: {
        ...getReminderState(states, reminder.id),
        completed: getReminderState(states, reminder.id).completed + 1,
        lastMilestone: Math.max(getReminderState(states, reminder.id).lastMilestone, milestone),
        fixedDate: reminder.kind === "custom" && reminder.time_of_day?.trim() ? todayKey() : getReminderState(states, reminder.id).fixedDate,
        snoozedUntil: 0
      }
    };
    void saveReminderStates(next).catch((error) => onMessage(`提醒状态保存失败：${String(error)}`));
    setStates(next);
    setActive(null);
    setInlineFallback(false);
  }

  function snooze(reminder: ReminderConfig) {
    clearEscalationTimer();
    const next = {
      ...states,
      [reminder.id]: {
        ...getReminderState(states, reminder.id),
        snoozedUntil: Date.now() + Math.max(1, reminder.snooze_minutes || settings.dnd_snooze_minutes || 10) * 60_000
      }
    };
    void saveReminderStates(next).catch((error) => onMessage(`提醒状态保存失败：${String(error)}`));
    setStates(next);
    setActive(null);
    setInlineFallback(false);
  }

  function dismiss(reminder: ReminderConfig) {
    clearEscalationTimer();
    if (!reminder.escalate_enabled) {
      ignoreOnce(reminder);
      return;
    }
    const next = {
      ...states,
      [reminder.id]: {
        ...getReminderState(states, reminder.id),
        snoozedUntil: Date.now() + Math.max(1, reminder.escalate_repeat_minutes || 5) * 60_000
      }
    };
    void saveReminderStates(next).catch((error) => onMessage(`提醒状态保存失败：${String(error)}`));
    setStates(next);
    setActive(null);
    setInlineFallback(false);
  }

  function ignoreOnce(reminder: ReminderConfig) {
    clearEscalationTimer();
    const current = getReminderState(states, reminder.id);
    const interval = reminderIntervalMinutes(reminder);
    const milestone = interval > 0 ? Math.floor(Math.floor(dashboard.total_seconds / 60) / interval) : 0;
    const next = {
      ...states,
      [reminder.id]: {
        ...current,
        lastMilestone: Math.max(current.lastMilestone, milestone),
        fixedDate: reminder.kind === "custom" && reminder.time_of_day?.trim() ? todayKey() : current.fixedDate,
        snoozedUntil: 0
      }
    };
    void saveReminderStates(next).catch((error) => onMessage(`提醒状态保存失败：${String(error)}`));
    setStates(next);
    setActive(null);
    setInlineFallback(false);
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ReminderActionPayload>("reminder-action", (event) => {
      if (!active || event.payload.id !== active.id) return;
      if (event.payload.action === "complete") {
        complete(active);
      } else if (event.payload.action === "snooze") {
        snooze(active);
      } else if (event.payload.action === "ignore") {
        ignoreOnce(active);
      } else {
        dismiss(active);
      }
    })
      .then((handler) => {
        unlisten = handler;
      })
      .catch((error) => onMessage(`提醒窗口监听失败：${String(error)}`));
    return () => {
      unlisten?.();
    };
  }, [active, states, dashboard.total_seconds, settings, onMessage]);

  if (!active || !inlineFallback) return null;

  const state = getReminderState(states, active.id);
  return (
    <div className={`reminder-popup ${active.important ? "important" : ""}`}>
      <div className="reminder-popup-head">
        <span className="reminder-icon">
          <Bell size={16} />
        </span>
        <div>
          <strong>{active.title}</strong>
          <span>{reminderKindText(active.kind)} · 今日完成 {state.completed} 次</span>
        </div>
      </div>
      <div className="actions">
        <button className="button" onClick={() => complete(active)}>
          <CheckCircle2 size={16} />完成
        </button>
        <button className="button secondary" onClick={() => snooze(active)}>
          稍后 {active.snooze_minutes || settings.dnd_snooze_minutes || 10} 分钟
        </button>
        <button className="button ghost" onClick={() => ignoreOnce(active)}>
          忽略本次
        </button>
      </div>
    </div>
  );
}

function DebugPage({
  settings,
  dashboard,
  detector,
  onMessage
}: {
  settings: AppSettings | null;
  dashboard: Dashboard | null;
  detector: DetectionStatus | null;
  onMessage: (message: string) => void;
}) {
  const [logs, setLogs] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [fallbackReminder, setFallbackReminder] = useState<ReminderConfig | null>(null);
  const [debugLoggingEnabled, setDebugLoggingEnabled] = useState(false);
  const [debugStrategy, setDebugStrategy] = useState(settings?.reminder_style ?? "gentle");
  const [debugImportant, setDebugImportant] = useState(false);
  const [debugPresent, setDebugPresent] = useState(true);
  const [debugSound, setDebugSound] = useState(true);

  async function refreshLogs() {
    const text = await api.getDebugLogs();
    setLogs(text);
  }

  useEffect(() => {
    refreshLogs().catch((error) => onMessage(`读取 DEBUG 日志失败：${String(error)}`));
    const id = window.setInterval(() => refreshLogs().catch(() => {}), 2000);
    return () => window.clearInterval(id);
  }, [onMessage]);

  useEffect(() => {
    api
      .getDebugLoggingEnabled()
      .then(setDebugLoggingEnabled)
      .catch((error) => onMessage(`读取 DEBUG 日志开关失败：${String(error)}`));
  }, [onMessage]);

  async function toggleDebugLogging(enabled: boolean) {
    await api.setDebugLoggingEnabled(enabled);
    setDebugLoggingEnabled(enabled);
    onMessage(enabled ? "DEBUG 计时日志已开启" : "DEBUG 计时日志已关闭");
  }

  function dashboardSnapshot(): Dashboard {
    return (
      dashboard ?? {
        total_seconds: 0,
        started_at: null,
        status: "未开始",
        detector_source: detector?.source || "YOLO",
        confidence: detector?.confidence ?? 0,
        interruptions_last_hour: 0,
        sessions: []
      }
    );
  }

  useEffect(() => {
    if (settings?.reminder_style) setDebugStrategy(settings.reminder_style);
  }, [settings?.reminder_style]);

  function debugReminder(): ReminderConfig {
    return {
      id: `debug-popup-${Date.now()}`,
      title: debugStrategy === "gentle" ? "轻提示体验" : debugStrategy === "strict" ? "严格提醒体验" : "普通提醒体验",
      kind: "custom",
      enabled: true,
      time_of_day: "",
      interval_minutes: 0,
      work_minutes: 0,
      snooze_minutes: 10,
      max_completions: 0,
      important: debugImportant || debugStrategy === "strict",
      escalate_enabled: debugStrategy === "strict",
      escalate_repeat_minutes: 1
    };
  }

  function triggerReminderWindow(fullExperience = false) {
    if (!settings) {
      onMessage("设置尚未加载，暂时无法触发弹窗");
      return;
    }
    const reminder = debugReminder();
    const testSettings = {
      ...settings,
      reminder_style: debugStrategy,
      sound_enabled: debugSound ? true : settings.sound_enabled
    };
    const testDetector = {
      ...(detector ?? {
        backend: "DEBUG",
        status: "DEBUG",
        model: "debug",
        device: "debug",
        confidence_threshold: 0,
        source: "DEBUG",
        last_update_at: null,
        last_seen_at: null,
        note: "DEBUG 提醒策略测试"
      }),
      present: debugPresent,
      confidence: debugPresent ? 0.9 : 0
    };
    const open = () =>
      openReminderWindow(
        reminder,
        { completed: 0, snoozedUntil: 0, lastMilestone: 0, fixedDate: todayKey() },
        testSettings,
        dashboardSnapshot(),
        testDetector,
        onMessage,
        () => setFallbackReminder(reminder)
      );
    setFallbackReminder(null);
    if (fullExperience && debugStrategy === "gentle") {
      let softWindow: WebviewWindow | null = null;
      softWindow = openSoftReminderWindow(
        reminder,
        { completed: 0, snoozedUntil: 0, lastMilestone: 0, fixedDate: todayKey() },
        testSettings,
        onMessage,
        () => {
          softWindow?.close().catch(() => {});
          open();
        }
      );
      if (debugSound) playReminderSound(testSettings, true);
      if (!softWindow) return;
      onMessage("已触发轻提示气泡，约 1 秒后弹出提醒窗");
      window.setTimeout(() => {
        softWindow?.close().catch(() => {});
        open();
      }, 1000);
      return;
    }
    if (debugSound) playReminderSound(testSettings, true);
    open();
    onMessage(fullExperience ? "已按所选策略触发提醒体验" : "已触发 DEBUG 测试弹窗");
  }

  async function exportLogs() {
    const path = await api.exportDebugLogs();
    setExportPath(path);
    onMessage("DEBUG 日志已导出到运行目录");
  }

  return (
    <div className="grid">
      <Card title="DEBUG 操作" icon={<Sparkles />}>
        <SwitchControl
          checked={debugLoggingEnabled}
          label="记录计时 DEBUG 日志"
          description="默认关闭，开启后只写入内存日志。"
          onChange={(checked) => toggleDebugLogging(checked).catch((error) => onMessage(String(error)))}
        />
        <div className="debug-test-panel">
          <div>
            <label>提醒策略</label>
            <select value={debugStrategy} onChange={(event) => setDebugStrategy(event.target.value)}>
              <option value="gentle">轻提示：先弱提示再弹窗</option>
              <option value="normal">普通：直接弹窗 + 声音</option>
              <option value="strict">严格：重要样式 + 未处理重复</option>
            </select>
          </div>
          <SwitchControl compact checked={debugPresent} label="模拟正在计时" onChange={setDebugPresent} />
          <SwitchControl compact checked={debugImportant} label="重要样式" onChange={setDebugImportant} />
          <SwitchControl compact checked={debugSound} label="播放声音" onChange={setDebugSound} />
        </div>
        <div className="debug-actions">
          <button className="button" onClick={() => triggerReminderWindow(true)}>
            <Bell size={16} />体验提醒策略
          </button>
          <button className="button secondary" onClick={() => triggerReminderWindow(false)}>
            <Bell size={16} />触发测试弹窗
          </button>
          <button className="button secondary" onClick={() => refreshLogs().catch((error) => onMessage(String(error)))}>
            刷新日志
          </button>
          <button className="button secondary" onClick={() => exportLogs().catch((error) => onMessage(String(error)))}>
            <Save size={16} />导出日志
          </button>
        </div>
        <p className="muted">
          默认不记录高频计时日志；只有勾选上方开关后才写入内存日志。需要时点击“导出日志”保存到运行目录。
        </p>
        {exportPath && <p className="muted">最近导出：{exportPath}</p>}
      </Card>

      <Card title="日志窗口" icon={<Database />}>
        <pre className="debug-log-window">{logs.trim() || "暂无 DEBUG 日志。检测运行后会出现计时日志。"}</pre>
      </Card>

      {fallbackReminder && (
        <div className="reminder-popup">
          <div className="reminder-popup-head">
            <span className="reminder-icon">
              <Bell size={16} />
            </span>
            <div>
              <strong>{fallbackReminder.title}</strong>
              <span>独立提醒窗未创建成功，已回落到主窗口内提醒。</span>
            </div>
          </div>
          <div className="actions">
            <button className="button" onClick={() => setFallbackReminder(null)}>
              <CheckCircle2 size={16} />知道了
            </button>
            <button className="button ghost" onClick={() => setFallbackReminder(null)}>
              忽略本次
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardPage({
  dashboard,
  detector,
  settings,
  chartData
}: {
  dashboard: Dashboard | null;
  detector: DetectionStatus | null;
  settings: AppSettings | null;
  chartData: { date: string; hours: number }[];
}) {
  const total = dashboard?.total_seconds ?? 0;
  const [liveTotal, setLiveTotal] = useState(total);
  const isCounting = isActivelyCounting(dashboard, detector);
  const timerAnchor = useRef({
    total,
    perfMs: performance.now(),
    counting: false
  });

  useEffect(() => {
    const now = performance.now();
    const anchor = timerAnchor.current;
    const predicted = anchor.counting ? anchor.total + Math.floor((now - anchor.perfMs) / 1000) : anchor.total;

    if (!isCounting) {
      timerAnchor.current = { total, perfMs: now, counting: false };
      setLiveTotal(total);
      return;
    }

    if (!anchor.counting || total > predicted || Math.abs(total - predicted) >= 2) {
      timerAnchor.current = { total, perfMs: now, counting: true };
      setLiveTotal(total);
    }
  }, [total, isCounting]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = performance.now();
      const anchor = timerAnchor.current;
      const next = anchor.counting ? anchor.total + Math.floor((now - anchor.perfMs) / 1000) : anchor.total;
      setLiveTotal((prev) => (prev === next ? prev : next));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const target = Math.max(1, (settings?.daily_target_minutes ?? 480) * 60);
  const percent = Math.min(100, Math.round((liveTotal / target) * 100));
  return (
    <div className="grid dashboard-grid">
      <Card className="hero">
        <div className="hero-label">当前工作日累计</div>
        <div className="hero-time">{formatDuration(liveTotal)}</div>
        <div className="progress">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="hero-sub">
          <span>{dashboard?.status ?? "加载中"}</span>
          <span>{percent}% / {(settings?.daily_target_minutes ?? 480) / 60} 小时</span>
        </div>
      </Card>
      <Card title="状态" icon={<Activity />}>
        <div className="metrics">
          <Metric label="开始时间" value={dashboard?.started_at?.replace("T", " ") ?? "-"} />
          <Metric label="检测来源" value={dashboard?.detector_source || "YOLO"} />
          <Metric label="置信度" value={`${Math.round((dashboard?.confidence ?? 0) * 100)}%`} />
          <Metric label="近 1 小时中断" value={`${dashboard?.interruptions_last_hour ?? 0} 次`} />
        </div>
      </Card>
      <Card title="工作趋势" icon={<Target />} className="wide">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis dataKey="date" stroke="var(--chart-axis)" />
            <YAxis stroke="var(--chart-axis)" />
            <Tooltip
              contentStyle={{
                background: "var(--chart-tooltip-bg)",
                border: "1px solid var(--chart-tooltip-border)",
                color: "var(--chart-tooltip-text)"
              }}
            />
            <Bar dataKey="hours" fill="var(--chart-bar)" opacity={0.72} radius={[8, 8, 2, 2]} />
            <Line type="monotone" dataKey="hours" stroke="var(--chart-line)" strokeWidth={3} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

function HistoryPage({ sessions, refresh }: { sessions: WorkSession[]; refresh: () => Promise<void> }) {
  async function remove(id: number) {
    await api.deleteSession(id);
    await refresh();
  }

  return (
    <Card title="历史记录" icon={<Database />}>
      <div className="table">
        <div className="table-head">
          <span>开始</span><span>结束/最近</span><span>累计</span><span>备注</span><span />
        </div>
        {sessions.map((s) => (
          <div className="table-row" key={s.id}>
            <span>{s.started_at.replace("T", " ")}</span>
            <span>{(s.ended_at || s.last_seen_at || "-").replace("T", " ")}</span>
            <span>{formatDuration(s.total_seconds)}</span>
            <EditableNote session={s} refresh={refresh} />
            <button className="link" onClick={() => remove(s.id)}>删除</button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function EditableNote({ session, refresh }: { session: WorkSession; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(session.note || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(session.note || "");
  }, [session.note]);

  async function save() {
    const note = draft.trim();
    if (note === (session.note || "")) return;
    setSaving(true);
    try {
      await api.updateSession({ ...session, note });
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      className="note-input"
      value={draft}
      placeholder="备注"
      disabled={saving}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => save().catch(() => {})}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function DetectionPage({
  detector,
  settings,
  saveSettings
}: {
  detector: DetectionStatus | null;
  settings: AppSettings | null;
  saveSettings: (settings: AppSettings) => Promise<void>;
}) {
  if (!settings) return null;
  const currentSettings = settings;
  const [draft, setDraft] = useState<AppSettings>(currentSettings);
  const [activePreset, setActivePreset] = useState<YoloPresetName>(preferredYoloPreset(currentSettings));
  const [dirty, setDirty] = useState(false);
  const [presetNotice, setPresetNotice] = useState("");
  const [savedCustom, setSavedCustom] = useState<YoloTuningPatch | null>(null);
  const [lastCustomDraft, setLastCustomDraft] = useState<YoloTuningPatch | null>(null);
  const presetModified =
    activePreset !== "custom" && !patchMatches(draft, YOLO_PRESETS[activePreset].values);

  useEffect(() => {
    loadCustomPreset()
      .then((preset) => setSavedCustom(preset))
      .catch(() => setSavedCustom(null));
  }, []);

  useEffect(() => {
    if (!dirty) {
      setDraft(currentSettings);
      setActivePreset(preferredYoloPreset(currentSettings));
    }
  }, [currentSettings, dirty]);

  function selectPreset(preset: Exclude<YoloPresetName, "custom">) {
    setDraft((prev) => ({ ...prev, ...YOLO_PRESETS[preset].values, yolo_preset_name: preset }));
    setActivePreset(preset);
    setDirty(true);
    setPresetNotice("已切换预设，点击“应用”后才会生效。");
  }

  function updateDraft(key: YoloTuningKey, value: number) {
    setDraft((prev) => {
      const next = { ...prev, [key]: value, yolo_preset_name: activePreset };
      if (activePreset === "custom") {
        setLastCustomDraft(pickYoloTuning(next));
      }
      return next;
    });
    setDirty(true);
    setPresetNotice(
      activePreset === "custom"
        ? "自定义参数已修改，点击“应用”后生效。"
        : `${yoloPresetLabel(activePreset)}预设已微调，点击“应用”后生效。`
    );
  }

  async function applyDraft() {
    const next = { ...currentSettings, ...pickYoloTuning(draft), yolo_preset_name: activePreset };
    await saveSettings(next);
    setDraft(next);
    setDirty(false);
    setActivePreset(activePreset);
    setPresetNotice("已应用到当前 YOLO 检测。");
  }

  async function saveCustom() {
    const custom = pickYoloTuning(draft);
    await saveCustomPreset(custom);
    setSavedCustom(custom);
    setLastCustomDraft(custom);
    setDraft((prev) => ({ ...prev, yolo_preset_name: "custom" }));
    setActivePreset("custom");
    setPresetNotice("已保存为自定义预设；点击“应用”后会用于检测。");
  }

  function restoreDefault() {
    if (activePreset === "custom") {
      if (!savedCustom) {
        setPresetNotice("还没有保存过自定义预设，无法恢复自定义默认值。");
        return;
      }
      setDraft((prev) => ({ ...prev, ...savedCustom, yolo_preset_name: "custom" }));
      setLastCustomDraft(savedCustom);
      setDirty(true);
      setPresetNotice("已恢复自定义预设的保存值，点击“应用”后生效。");
      return;
    }

    setDraft((prev) => ({ ...prev, ...YOLO_PRESETS[activePreset].values, yolo_preset_name: activePreset }));
    setDirty(true);
    setPresetNotice(`已恢复${YOLO_PRESETS[activePreset].label}预设默认值，点击“应用”后生效。`);
  }

  function loadSavedCustom() {
    const custom = savedCustom;
    if (!custom) {
      setActivePreset("custom");
      setPresetNotice("还没有保存过自定义预设；可先微调参数后点击“保存自定义”。");
      return;
    }
    setDraft((prev) => ({ ...prev, ...custom, yolo_preset_name: "custom" }));
    setLastCustomDraft(custom);
    setActivePreset("custom");
    setDirty(true);
    setPresetNotice("已载入自定义预设，点击“应用”后生效。");
  }

  return (
    <div className="grid two">
      <Card title="YOLO ONNX 检测模块" icon={<Camera />}>
        <div className="metrics">
          <Metric label="后端" value={detector?.backend ?? "YOLO ONNX Runtime Web"} />
          <Metric label="状态" value={detector?.status ?? "未启动"} />
          <Metric label="设备" value={detector?.device ?? settings.yolo_device} />
          <Metric label="是否有人" value={detector?.present ? "有人" : "无人"} />
          <Metric label="来源" value={detector?.source || "YOLO"} />
          <Metric label="置信度" value={`${Math.round((detector?.confidence ?? 0) * 100)}%`} />
          <Metric label="生效阈值" value={`${Math.round(settings.yolo_confidence_threshold * 100)}%`} />
        </div>
        <p className="muted">{detector?.note}</p>
      </Card>
      <Card title="模型微调" icon={<Settings />} className="tuning-card">
        <label>环境预设</label>
        <div className="inline preset-row">
          {(Object.keys(YOLO_PRESETS) as Array<Exclude<YoloPresetName, "custom">>).map((name) => (
            <motion.button
              layout
              whileTap={{ scale: 0.96 }}
              className={`chip preset-chip ${activePreset === name ? "on" : ""}`}
              key={name}
              onClick={() => selectPreset(name)}
            >
              {YOLO_PRESETS[name].label}
            </motion.button>
          ))}
          <motion.button
            layout
            whileTap={{ scale: 0.96 }}
            className={`chip preset-chip ${activePreset === "custom" ? "on custom" : ""}`}
            onClick={loadSavedCustom}
            title={savedCustom || lastCustomDraft ? "载入自定义预设" : "先微调参数后点击“保存自定义”"}
          >
            自定义
          </motion.button>
        </div>

        <motion.div
          key={`${activePreset}-${dirty ? "dirty" : "clean"}`}
          className={`preset-panel ${dirty ? "dirty" : ""}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
        >
          <Sparkles size={16} />
          <span>
            {activePreset === "custom" ? "自定义参数" : YOLO_PRESETS[activePreset].desc}
            {presetModified ? " · 已微调" : ""}
            {dirty ? " · 待应用" : " · 已生效"}
          </span>
        </motion.div>

        <HelpLabel help="值越高越不容易误判；值越低越容易识别侧脸、背面、耳机遮挡。">YOLO 置信度阈值</HelpLabel>
        <input
          type="range"
          min={10}
          max={95}
          value={Math.round(draft.yolo_confidence_threshold * 100)}
          onChange={(e) => updateDraft("yolo_confidence_threshold", Number(e.target.value) / 100)}
        />
        <p className="range-hint">当前草稿：{Math.round(draft.yolo_confidence_threshold * 100)}%。</p>

        <HelpLabel help="过滤很小的人体框，减少黑屏、椅背、杂物造成的误检；太高会漏掉远距离人体。">
          最小人体框面积：{(draft.yolo_min_box_area_ratio * 100).toFixed(2)}%
        </HelpLabel>
        <input
          type="range"
          min={1}
          max={100}
          value={Math.round(draft.yolo_min_box_area_ratio * 1000)}
          onChange={(e) => updateDraft("yolo_min_box_area_ratio", Number(e.target.value) / 1000)}
        />

        <HelpLabel help="两次 YOLO 推理之间的间隔。越短越灵敏但 CPU 更高；越长更省电。">检测周期：{draft.yolo_inference_interval_ms} ms</HelpLabel>
        <input
          type="range"
          min={300}
          max={3000}
          step={100}
          value={draft.yolo_inference_interval_ms}
          onChange={(e) => updateDraft("yolo_inference_interval_ms", Number(e.target.value))}
        />

        <HelpLabel help="连续检测到有人达到该时间后，才开始或恢复计时，用于减少瞬间误检。">确认有人：{draft.presence_confirm_seconds} 秒</HelpLabel>
        <input
          type="range"
          min={0}
          max={10}
          value={draft.presence_confirm_seconds}
          onChange={(e) => updateDraft("presence_confirm_seconds", Number(e.target.value))}
        />

        <HelpLabel help="人体短暂消失时继续认为人在，适合低头吃饭、侧身、摄像头偶发漏检。">离开宽限：{draft.uncertain_grace_seconds} 秒</HelpLabel>
        <input
          type="range"
          min={1}
          max={60}
          value={draft.uncertain_grace_seconds}
          onChange={(e) => updateDraft("uncertain_grace_seconds", Number(e.target.value))}
        />

        <HelpLabel help="画面整体亮度低于该值且纹理也很低时，直接视为不可用黑屏，不交给 YOLO 误判。">黑屏亮度阈值：{draft.yolo_dark_mean_threshold.toFixed(0)}</HelpLabel>
        <input
          type="range"
          min={5}
          max={80}
          value={draft.yolo_dark_mean_threshold}
          onChange={(e) => updateDraft("yolo_dark_mean_threshold", Number(e.target.value))}
        />

        <HelpLabel help="画面纹理/对比度低于该值时，会被判定为低信号画面；提高可减少纯黑/纯色误检。">低信号纹理阈值：{draft.yolo_low_signal_stddev_threshold.toFixed(0)}</HelpLabel>
        <input
          type="range"
          min={2}
          max={35}
          value={draft.yolo_low_signal_stddev_threshold}
          onChange={(e) => updateDraft("yolo_low_signal_stddev_threshold", Number(e.target.value))}
        />

        <div className="preset-actions">
          <button className="button" onClick={() => applyDraft()} disabled={!dirty}>
            <CheckCircle2 size={16} />应用
          </button>
          <button className="button secondary" onClick={() => saveCustom()}>
            <Save size={16} />保存自定义
          </button>
          <button className="button secondary" onClick={restoreDefault}>
            <RotateCcw size={16} />重置当前预设
          </button>
        </div>
        {presetNotice && <p className="muted preset-notice">{presetNotice}</p>}
      </Card>
    </div>
  );
}

function clearCameraOverlay(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawCameraOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  boxes: YoloBox[],
  settings: AppSettings
) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width <= 0 || height <= 0) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  if (settings.roi_enabled) {
    const x = width * clampNumber(settings.roi_x_percent, 0, 99) / 100;
    const y = height * clampNumber(settings.roi_y_percent, 0, 99) / 100;
    const w = width * clampNumber(settings.roi_w_percent, 1, 100) / 100;
    const h = height * clampNumber(settings.roi_h_percent, 1, 100) / 100;
    ctx.save();
    ctx.setLineDash([9, 7]);
    ctx.strokeStyle = "rgba(56,189,248,.95)";
    ctx.lineWidth = Math.max(2, width / 420);
    ctx.strokeRect(x, y, Math.min(w, width - x), Math.min(h, height - y));
    ctx.fillStyle = "rgba(56,189,248,.16)";
    ctx.fillRect(x, y, Math.min(w, width - x), Math.min(h, height - y));
    ctx.restore();
  }

  for (const box of boxes) {
    ctx.save();
    ctx.strokeStyle = "rgba(34,197,94,.98)";
    ctx.lineWidth = Math.max(3, width / 360);
    ctx.shadowColor = "rgba(34,197,94,.45)";
    ctx.shadowBlur = 10;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    const label = `Person ${Math.round(box.confidence * 100)}%`;
    ctx.font = `${Math.max(14, Math.round(width / 52))}px Segoe UI, sans-serif`;
    const metrics = ctx.measureText(label);
    const labelH = Math.max(22, Math.round(width / 32));
    const labelY = Math.max(0, box.y - labelH);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(22,163,74,.95)";
    ctx.fillRect(box.x, labelY, metrics.width + 14, labelH);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, box.x + 7, labelY + labelH - 7);
    ctx.restore();
  }
}

function CameraDebugCard({
  settings,
  saveSettings
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const yoloCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(settings.camera_index);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState("");
  const [overlayStatus, setOverlayStatus] = useState("YOLO 叠框未开启");

  async function loadDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError("当前 WebView 不支持摄像头枚举。");
      return;
    }
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const cameras = allDevices.filter((device) => device.kind === "videoinput");
    setDevices(cameras);
    if (cameras.length > 0 && selectedIndex >= cameras.length) {
      setSelectedIndex(0);
    }
  }

  function stopPreview() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    clearCameraOverlay(overlayRef.current);
    setPreviewing(false);
    setResolution("");
    setOverlayStatus("YOLO 叠框未开启");
  }

  async function startPreview(index = selectedIndex) {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("当前 WebView 不支持 getUserMedia，无法打开摄像头预览。");
      return;
    }

    stopPreview();
    const selectedDevice = devices[index];
    const video: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };
    if (selectedDevice?.deviceId) {
      video.deviceId = { exact: selectedDevice.deviceId };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const trackSettings = stream.getVideoTracks()[0]?.getSettings();
      if (trackSettings) {
        setResolution(`${trackSettings.width ?? "-"} × ${trackSettings.height ?? "-"}`);
      }
      setPreviewing(true);
      await loadDevices();
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setError(`摄像头打开失败：${reason}`);
    }
  }

  async function selectCamera(nextIndex: number) {
    setSelectedIndex(nextIndex);
    await saveSettings({ ...settings, camera_index: nextIndex });
    if (previewing) {
      await startPreview(nextIndex);
    }
  }

  function updateRoi(patch: Partial<Pick<AppSettings, "roi_enabled" | "roi_x_percent" | "roi_y_percent" | "roi_w_percent" | "roi_h_percent">>) {
    const next = { ...settings, ...patch };
    next.roi_x_percent = clampNumber(next.roi_x_percent, 0, 99);
    next.roi_y_percent = clampNumber(next.roi_y_percent, 0, 99);
    next.roi_w_percent = clampNumber(next.roi_w_percent, 1, 100 - next.roi_x_percent);
    next.roi_h_percent = clampNumber(next.roi_h_percent, 1, 100 - next.roi_y_percent);
    return saveSettings(next);
  }

  async function toggleOverlay(enabled: boolean) {
    await saveSettings({ ...settings, preview_debug_overlay: enabled });
    if (enabled && !previewing) {
      await startPreview();
    }
    if (!enabled) {
      clearCameraOverlay(overlayRef.current);
      setOverlayStatus("YOLO 叠框未开启");
    }
  }

  useEffect(() => {
    loadDevices()
      .catch((e) => setError(String(e)));
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      clearCameraOverlay(overlayRef.current);
    };
    // 这里只在组件挂载时枚举一次，切换设备由 selectCamera 主动处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!previewing || !settings.preview_debug_overlay) {
      clearCameraOverlay(overlayRef.current);
      if (!settings.preview_debug_overlay) setOverlayStatus("YOLO 叠框未开启");
      return;
    }

    let cancelled = false;
    let running = false;
    const interval = Math.max(500, settings.yolo_inference_interval_ms || 1000);
    async function detectAndDraw() {
      if (cancelled || running) return;
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (!video || !overlay || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      running = true;
      try {
        const runtime = await getYoloRuntime();
        const buffer = yoloCanvasRef.current ?? document.createElement("canvas");
        yoloCanvasRef.current = buffer;
        const result = await detectPersonFromVideo(runtime, video, buffer, settings);
        if (cancelled) return;
        drawCameraOverlay(overlay, video, result.boxes ?? [], settings);
        setOverlayStatus(result.note ?? `YOLO：${result.present ? "检测到人" : "未检测到人"} · ${Math.round((result.confidence ?? 0) * 100)}%`);
      } catch (e) {
        if (!cancelled) setOverlayStatus(`YOLO 叠框失败：${String(e)}`);
      } finally {
        running = false;
      }
    }

    void detectAndDraw();
    const id = window.setInterval(() => void detectAndDraw(), interval);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    previewing,
    settings.preview_debug_overlay,
    settings.yolo_inference_interval_ms,
    settings.yolo_confidence_threshold,
    settings.yolo_min_box_area_ratio,
    settings.yolo_dark_mean_threshold,
    settings.yolo_dark_stddev_threshold,
    settings.yolo_low_signal_mean_threshold,
    settings.yolo_low_signal_stddev_threshold,
    settings.roi_enabled,
    settings.roi_x_percent,
    settings.roi_y_percent,
    settings.roi_w_percent,
    settings.roi_h_percent
  ]);

  return (
    <CollapsibleCard title="摄像头调试" icon={<Camera />} className="wide">
      <div className="camera-debug">
        <div className="camera-panel">
          <video ref={videoRef} className="camera-preview" muted playsInline />
          <canvas ref={overlayRef} className="camera-overlay" />
          {!previewing && (
            <div className="camera-placeholder">
              <Camera size={34} />
              <span>点击“开始预览”调试摄像头</span>
            </div>
          )}
        </div>
        <div className="camera-controls">
          <label>摄像头设备</label>
          <select
            value={selectedIndex}
            onChange={(event) => selectCamera(Number(event.target.value)).catch((e) => setError(String(e)))}
          >
            {devices.length === 0 && <option value={settings.camera_index}>未枚举到摄像头</option>}
            {devices.map((device, index) => (
              <option key={device.deviceId || index} value={index}>
                {device.label || `摄像头 ${index}`}
              </option>
            ))}
          </select>

          <div className="inline">
            <button className="button preview-start" onClick={() => startPreview().catch((e) => setError(String(e)))}>
              开始预览
            </button>
            <button className="button secondary" onClick={stopPreview}>
              停止预览
            </button>
            <SwitchControl
              compact
              checked={settings.preview_debug_overlay}
              label="YOLO 识别框"
              onChange={(checked) => toggleOverlay(checked).catch((e) => setError(String(e)))}
            />
          </div>

          <div className="metrics one">
            <Metric label="当前索引" value={`${settings.camera_index}`} />
            <Metric label="预览状态" value={previewing ? "运行中" : "已停止"} hint={resolution || undefined} />
            <Metric label="叠框状态" value={settings.preview_debug_overlay ? "已开启" : "已关闭"} hint={overlayStatus} />
          </div>
          <div className="roi-card">
            <SwitchControl
              checked={settings.roi_enabled}
              label="ROI 检测区域"
              description="只在指定画面区域内检测人体。开启后蓝色虚线区域会叠加显示在预览上。"
              onChange={(checked) => updateRoi({ roi_enabled: checked }).catch((e) => setError(String(e)))}
            />
            <div className="roi-grid">
              {([
                ["X", "roi_x_percent", settings.roi_x_percent],
                ["Y", "roi_y_percent", settings.roi_y_percent],
                ["宽", "roi_w_percent", settings.roi_w_percent],
                ["高", "roi_h_percent", settings.roi_h_percent]
              ] as Array<[string, "roi_x_percent" | "roi_y_percent" | "roi_w_percent" | "roi_h_percent", number]>).map(([label, key, value]) => (
                <div key={String(key)}>
                  <label>{label}：{value}%</label>
                  <input
                    type="range"
                    min={key === "roi_w_percent" || key === "roi_h_percent" ? 1 : 0}
                    max={100}
                    value={Number(value)}
                    disabled={!settings.roi_enabled}
                    onChange={(e) => updateRoi({ [key]: Number(e.target.value) }).catch((err) => setError(String(err)))}
                  />
                </div>
              ))}
            </div>
          </div>
          <p className="muted">这里用于调试摄像头画面、权限、ROI 区域和 YOLO 识别框；不影响后台自动计时逻辑。</p>
          {error && <div className="error-box">{error}</div>}
        </div>
      </div>
    </CollapsibleCard>
  );
}

function NumberTextInput({
  value,
  min = 0,
  max,
  onCommit,
  className = "number-text"
}: {
  value: number;
  min?: number;
  max?: number;
  onCommit: (value: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number(draft || min);
    const clipped = Math.max(min, max === undefined ? parsed : Math.min(max, parsed));
    setDraft(String(clipped));
    onCommit(clipped);
  }

  return (
    <input
      className={className}
      inputMode="numeric"
      pattern="[0-9]*"
      value={draft}
      onChange={(e) => setDraft(digitsOnly(e.target.value))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

function DailyTargetEditor({
  settings,
  saveSettings
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(settings.daily_target_minutes));

  useEffect(() => {
    setDraft(String(settings.daily_target_minutes));
  }, [settings.daily_target_minutes]);

  async function apply() {
    const value = Math.max(1, Number(draft || settings.daily_target_minutes));
    await saveSettings({ ...settings, daily_target_minutes: value });
    setEditing(false);
  }

  return (
    <div className="target-editor">
      <div className="label-row">
        <label>每日目标：{settings.daily_target_minutes} 分钟</label>
        <button className="icon-button" onClick={() => setEditing((value) => !value)} title="直接输入分钟">
          <Edit3 size={14} />
        </button>
      </div>
      {editing && (
        <motion.div className="inline compact-editor" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
          <input
            className="number-text wide-number"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft}
            onChange={(e) => setDraft(digitsOnly(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply();
            }}
          />
          <button className="button secondary" onClick={() => apply()}>
            保存分钟
          </button>
        </motion.div>
      )}
      <input
        type="range"
        min={60}
        max={1440}
        value={settings.daily_target_minutes}
        onChange={(e) => saveSettings({ ...settings, daily_target_minutes: Number(e.target.value) })}
      />
    </div>
  );
}

function FeishuSettings({
  settings,
  saveSettings
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
}) {
  const [webhook, setWebhook] = useState(settings.feishu_webhook);
  const [secret, setSecret] = useState(settings.feishu_secret);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setWebhook(settings.feishu_webhook);
    setSecret(settings.feishu_secret);
  }, [settings.feishu_webhook, settings.feishu_secret]);

  const configured = webhook.trim().length > 0;

  async function saveConfig(enabled = settings.feishu_enabled) {
    if (!configured) {
      await saveSettings({ ...settings, feishu_webhook: "", feishu_secret: secret.trim(), feishu_enabled: false });
      setStatus("未填写 Webhook，飞书提醒保持关闭。");
      return;
    }
    await saveSettings({ ...settings, feishu_webhook: webhook.trim(), feishu_secret: secret.trim(), feishu_enabled: enabled });
    setStatus("飞书配置已保存。");
  }

  async function checkConfig() {
    setStatus("正在检测飞书配置……");
    try {
      const result = await api.checkFeishuConfig(webhook.trim(), secret.trim());
      await saveSettings({ ...settings, feishu_webhook: webhook.trim(), feishu_secret: secret.trim(), feishu_enabled: true });
      setStatus(result);
    } catch (error) {
      await saveSettings({ ...settings, feishu_webhook: webhook.trim(), feishu_secret: secret.trim(), feishu_enabled: false });
      setStatus(`检测失败，飞书提醒已关闭：${String(error)}`);
    }
  }

  return (
    <div className="feishu-box">
      <label>飞书机器人 Webhook</label>
      <input
        className="text-input"
        placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
        value={webhook}
        onChange={(e) => setWebhook(e.target.value)}
        onBlur={() => saveConfig(settings.feishu_enabled).catch((error) => setStatus(`自动保存失败：${String(error)}`))}
      />
      <label>飞书签名 Secret</label>
      <input
        className="text-input"
        placeholder="可留空"
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        onBlur={() => saveConfig(settings.feishu_enabled).catch((error) => setStatus(`自动保存失败：${String(error)}`))}
      />
      <div className="inline">
        <button className="button" onClick={() => checkConfig()} disabled={!configured}>
          <Send size={16} />检测配置
        </button>
        <SwitchControl
          compact
          label="飞书提醒"
          checked={settings.feishu_enabled}
          disabled={!webhook.trim()}
          onChange={(checked) => saveConfig(checked && Boolean(webhook.trim())).catch((error) => setStatus(`飞书开关失败：${String(error)}`))}
        />
      </div>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}

function AppPreferencesCard({
  settings,
  saveSettings
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
}) {
  const themeMode = normalizeThemeMode(settings.theme_mode);
  const language = normalizeLanguage(settings.language);
  return (
    <CollapsibleCard title="应用设置" icon={<Settings />}>
      <div className="preference-strip">
        <SwitchControl
          checked={settings.start_minimized}
          label="启动后最小化到托盘"
          description="关闭后，启动时直接显示主窗口。"
          onChange={(checked) => saveSettings({ ...settings, start_minimized: checked })}
        />
        <SwitchControl
          checked={settings.close_to_tray}
          label="关闭窗口时最小化到托盘"
          description="关闭后，点击窗口关闭按钮会直接退出程序。"
          onChange={(checked) => saveSettings({ ...settings, close_to_tray: checked })}
        />
        <SwitchControl
          checked={settings.autostart}
          label="开机启动"
          description="跟随 Windows 登录自动启动。"
          onChange={(checked) => saveSettings({ ...settings, autostart: checked })}
        />
      </div>

      <div className="settings-field-grid">
        <div>
          <label>主题</label>
          <select
            value={themeMode}
            onChange={(e) => saveSettings({ ...settings, theme_mode: normalizeThemeMode(e.target.value) })}
          >
            <option value="system">随系统</option>
            <option value="light">白日</option>
            <option value="dark">暗夜</option>
          </select>
        </div>
        <div>
          <label>语言</label>
          <select
            value={language}
            onChange={(e) => saveSettings({ ...settings, language: normalizeLanguage(e.target.value) })}
          >
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
      </div>
    </CollapsibleCard>
  );
}

function ReminderSettingsCard({
  settings,
  saveSettings
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
}) {
  const [states, setStates] = useState<Record<string, ReminderState>>({});

  useEffect(() => {
    let cancelled = false;
    async function refreshStates() {
      const current = await loadReminderStates();
      if (!cancelled) setStates(current);
    }
    refreshStates().catch(() => {});
    const id = window.setInterval(() => refreshStates().catch(() => {}), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  function updateReminder(id: string, patch: Partial<ReminderConfig>) {
    const reminders = settings.reminders.map((reminder) => (reminder.id === id ? { ...reminder, ...patch } : reminder));
    return saveSettings({ ...settings, reminders });
  }

  function addCustomReminder() {
    const custom: ReminderConfig = {
      id: `custom-${Date.now()}`,
      title: "自定义提醒",
      kind: "custom",
      enabled: false,
      time_of_day: "09:00",
      interval_minutes: 0,
      work_minutes: 0,
      snooze_minutes: 10,
      max_completions: 1,
      important: false,
      escalate_enabled: false,
      escalate_repeat_minutes: 5
    };
    return saveSettings({ ...settings, reminders: [...settings.reminders, custom] });
  }

  function deleteReminder(id: string) {
    if (!window.confirm(translateForLanguage(normalizeLanguage(settings.language), "确定删除这个自定义提醒吗？"))) return;
    const reminders = settings.reminders.filter((reminder) => reminder.id !== id);
    void saveSettings({ ...settings, reminders });
  }

  function setCustomReminderMode(reminder: ReminderConfig, mode: "fixed" | "interval") {
    if (mode === "fixed") {
      return updateReminder(reminder.id, {
        time_of_day: reminder.time_of_day?.trim() || "09:00",
        interval_minutes: 0,
        work_minutes: 0
      });
    }
    const interval = reminder.interval_minutes > 0 ? reminder.interval_minutes : 60;
    return updateReminder(reminder.id, {
      time_of_day: "",
      interval_minutes: interval,
      work_minutes: interval
    });
  }

  const presetReminders = ["break", "drink", "move"]
    .map((kind) => settings.reminders.find((reminder) => reminder.kind === kind))
    .filter((reminder): reminder is ReminderConfig => Boolean(reminder))
    .sort((a, b) => reminderKindOrder(a.kind) - reminderKindOrder(b.kind));
  const customReminders = settings.reminders.filter((reminder) => !isPresetReminder(reminder));

  function renderReminder(reminder: ReminderConfig) {
    const state = getReminderState(states, reminder.id);
    const isCustom = !isPresetReminder(reminder);
    const customMode = isCustom ? customReminderMode(reminder) : "interval";
    return (
      <motion.div layout className={`reminder-row ${isCustom ? "custom-reminder-row" : "preset-reminder-row"}`} key={reminder.id}>
        <div className="reminder-row-head">
          <div className="reminder-row-title">
            <span className="reminder-icon">{reminderIcon(reminder.kind)}</span>
            <div>
              <strong>{reminderTitleText(reminder)}</strong>
              <span>
                {reminderKindText(reminder.kind)}
                {isPresetReminder(reminder) ? ` #${reminderKindOrder(reminder.kind)}` : ""}
                · 今日完成 {state.completed} 次
              </span>
            </div>
          </div>
          <SwitchControl
            compact
            checked={reminder.enabled}
            label="启用"
            onChange={(checked) => updateReminder(reminder.id, { enabled: checked })}
          />
        </div>

        <div className="reminder-fields">
          {isCustom && (
            <div>
              <label>提醒名称</label>
              <input
                className="text-input"
                defaultValue={reminder.title}
                onBlur={(e) => {
                  const title = e.target.value.trim() || "自定义提醒";
                  if (title !== reminder.title) void updateReminder(reminder.id, { title });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>
          )}
          {isCustom && (
            <div>
              <label>提醒方式</label>
              <div className="inline reminder-mode-row">
                <button className={`chip ${customMode === "fixed" ? "on" : ""}`} onClick={() => setCustomReminderMode(reminder, "fixed")}>
                  固定时间
                </button>
                <button className={`chip ${customMode === "interval" ? "on" : ""}`} onClick={() => setCustomReminderMode(reminder, "interval")}>
                  循环间隔
                </button>
              </div>
            </div>
          )}
          {isCustom ? (
            customMode === "fixed" ? (
              <div>
                <label>固定时间</label>
                <input
                  className="text-input"
                  type="time"
                  value={reminder.time_of_day || "09:00"}
                  onChange={(e) => updateReminder(reminder.id, { time_of_day: e.target.value, interval_minutes: 0, work_minutes: 0 })}
                />
              </div>
            ) : (
              <div>
                <label>循环间隔（分钟）</label>
                <NumberTextInput
                  value={reminder.interval_minutes > 0 ? reminder.interval_minutes : 60}
                  min={1}
                  max={1440}
                  onCommit={(value) => updateReminder(reminder.id, { interval_minutes: value, work_minutes: value, time_of_day: "" })}
                />
              </div>
            )
          ) : (
            <div>
              <label>{reminder.kind === "break" ? "累计工作间隔" : "提醒间隔"}</label>
              <NumberTextInput
                value={reminder.kind === "break" ? reminder.work_minutes : reminder.interval_minutes}
                min={1}
                max={1440}
                onCommit={(value) => updateReminder(reminder.id, { interval_minutes: value, work_minutes: value })}
              />
            </div>
          )}
          <div>
            <label>稍后分钟</label>
            <NumberTextInput value={reminder.snooze_minutes} min={1} max={240} onCommit={(value) => updateReminder(reminder.id, { snooze_minutes: value })} />
          </div>
          <div>
            <label>完成多少次后停止</label>
            <NumberTextInput value={reminder.max_completions} min={0} max={99} onCommit={(value) => updateReminder(reminder.id, { max_completions: value })} />
          </div>
        </div>

        <div className="inline">
          <SwitchControl
            compact
            checked={reminder.important}
            label="重要提醒"
            description="更醒目的提醒窗口样式"
            onChange={(checked) => updateReminder(reminder.id, { important: checked })}
          />
          <SwitchControl
            compact
            checked={reminder.escalate_enabled}
            label="未处理重复"
            description="未确认时按间隔再次提醒"
            onChange={(checked) => updateReminder(reminder.id, { escalate_enabled: checked })}
          />
          {reminder.escalate_enabled && (
            <span className="inline reminder-repeat-field">
              <span className="muted">重复间隔</span>
              <NumberTextInput value={reminder.escalate_repeat_minutes || 5} min={1} max={240} onCommit={(value) => updateReminder(reminder.id, { escalate_repeat_minutes: value })} />
              <span className="muted">分钟</span>
            </span>
          )}
          {isCustom && (
            <button className="chip danger-chip" onClick={() => deleteReminder(reminder.id)}>
              删除
            </button>
          )}
        </div>
      </motion.div>
    );
  }

  return (
    <>
      <CollapsibleCard title="预设提醒" icon={<Bell />} className="wide">
        <div className="reminder-section preset-reminder-section">
          <div className="preset-reminder-note">
            <strong>内置 3 个常用提醒</strong>
            <p className="muted">#1 休息一下 · #2 喝水提醒 · #3 动一动提醒</p>
          </div>
          <div className="reminder-sections">
            {presetReminders.map(renderReminder)}
          </div>
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="自定义提醒事项" icon={<Bell />} className="wide">
        <div className="custom-reminder-head">
          <div>
            <strong>自定义提醒</strong>
            <p className="muted">喝药、固定事项、循环间隔事项都在这里管理。</p>
          </div>
          <button className="button secondary" onClick={() => addCustomReminder()}>新增自定义</button>
        </div>
        <div className="reminder-section custom-reminder-section">
          {customReminders.length > 0 ? customReminders.map(renderReminder) : <div className="reminder-empty">暂无自定义提醒。</div>}
        </div>
      </CollapsibleCard>
    </>
  );
}

function SettingsPage({
  settings,
  saveSettings
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
}) {
  return (
    <div className="settings-stack">
      <AppPreferencesCard settings={settings} saveSettings={saveSettings} />
      <CollapsibleCard title="计时规则" icon={<Clock3 />}>
        <HelpLabel help="用于跨凌晨工作场景：离开时间超过阈值后，再次检测到人时会自动开启新的工作日。">
          连续未检测到人超过 {settings.session_gap_hours} 小时后，下次检测到人自动开启新工作日
        </HelpLabel>
        <input
          type="range"
          min={1}
          max={24}
          value={settings.session_gap_hours}
          onChange={(e) => saveSettings({ ...settings, session_gap_hours: Number(e.target.value) })}
        />
        <DailyTargetEditor settings={settings} saveSettings={saveSettings} />
      </CollapsibleCard>

      <CollapsibleCard title="提醒通道" icon={<Bell />}>
        <label>本机声音</label>
        <div className="inline">
          <SwitchControl compact checked={settings.sound_enabled} label="声音提示" onChange={(checked) => saveSettings({ ...settings, sound_enabled: checked })} />
          <select value={settings.sound_name} onChange={(e) => saveSettings({ ...settings, sound_name: e.target.value })}>
            <option value="SystemNotification">内置：清脆提示</option>
            <option value="SoftBell">内置：柔和铃声</option>
          </select>
          <button className="button secondary" onClick={() => playReminderSound({ ...settings, sound_enabled: true }, true)}>
            试听
          </button>
        </div>

        <label>免打扰</label>
        <div className="inline">
          <SwitchControl compact checked={settings.dnd_enabled} label="免打扰" onChange={(checked) => saveSettings({ ...settings, dnd_enabled: checked })} />
          <input className="time-input" type="time" value={settings.dnd_start} onChange={(e) => saveSettings({ ...settings, dnd_start: e.target.value })} />
          <span className="muted">到</span>
          <input className="time-input" type="time" value={settings.dnd_end} onChange={(e) => saveSettings({ ...settings, dnd_end: e.target.value })} />
        </div>

        <FeishuSettings settings={settings} saveSettings={saveSettings} />
      </CollapsibleCard>

      <CollapsibleCard title="低打扰策略" icon={<Bell />} className="wide">
        <div className="reminder-design">
          <div>
            <HelpLabel help="控制提醒弹出强度。轻提示不会抢焦点，适合避免打断心流。">提醒策略</HelpLabel>
            <select
              value={settings.reminder_style}
              onChange={(e) => saveSettings({ ...settings, reminder_style: e.target.value })}
            >
              <option value="gentle">轻提示：不打断心流（推荐）</option>
              <option value="normal">普通：弹窗 + 轻声</option>
              <option value="strict">严格：必须确认</option>
            </select>

            <HelpLabel help="先以桌面右下角轻提示气泡，等待这个时间后再升级为弹窗。">柔性提示等待：{settings.reminder_soft_notice_minutes} 分钟</HelpLabel>
            <input
              type="range"
              min={0}
              max={15}
              value={settings.reminder_soft_notice_minutes}
              onChange={(e) => saveSettings({ ...settings, reminder_soft_notice_minutes: Number(e.target.value) })}
            />

            <HelpLabel help="如果检测到人仍在座位上，休息提醒可先延后这个时间，避免马上打断。">专注宽限：{settings.reminder_focus_grace_minutes} 分钟</HelpLabel>
            <input
              type="range"
              min={0}
              max={60}
              value={settings.reminder_focus_grace_minutes}
              onChange={(e) => saveSettings({ ...settings, reminder_focus_grace_minutes: Number(e.target.value) })}
            />

            <SwitchControl
              checked={settings.reminder_auto_snooze_when_present}
              label="人在专注时自动低打扰"
              description="关闭后，到点会立即提醒。"
              onChange={(checked) => saveSettings({ ...settings, reminder_auto_snooze_when_present: checked })}
            />
          </div>
          <ol className="design-list">
            <li>到达休息时间：优先右下角轻量提醒，不抢焦点。</li>
            <li>用户仍在镜头前：可按专注宽限延后，不强制中断。</li>
            <li>宽限后仍未休息：弹窗提供“完成”和“稍后”。</li>
            <li>喝药等事项归入自定义提醒，可选择固定时间或循环间隔。</li>
          </ol>
        </div>
      </CollapsibleCard>

      <ReminderSettingsCard settings={settings} saveSettings={saveSettings} />
      <CameraDebugCard settings={settings} saveSettings={saveSettings} />
    </div>
  );
}
