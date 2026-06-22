# WorkRecord

<p align="center">
  <strong>中文</strong> | <a href="#english">English</a>
</p>

<a id="中文"></a>

WorkRecord 是一个 Windows 桌面端工作时长记录工具。它通过摄像头和 YOLO 人体检测判断用户是否在位，自动累计当前工作日的工作时长，并用低打扰方式提醒休息、喝水、动一动或处理自定义事项。

> License: GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).

## 功能特性

- 自动累计当前工作日工作时长
- YOLO ONNX 人体检测，仅判断是否有人在位，不上传视频
- 跨凌晨工作日规则：长时间未检测到人后，下次在位自动开启新工作日
- 手动开始 / 结束工作日
- 历史记录、备注编辑和趋势图
- 预设提醒：休息一下、喝水提醒、动一动提醒
- 自定义提醒：固定时间或循环间隔
- 本机声音、自定义声音、飞书机器人提醒
- 低打扰轻提示气泡与独立提醒窗
- 摄像头调试预览、YOLO 方框、ROI 检测区域
- 白日 / 暗夜 / 跟随系统主题
- 中文 / English 界面切换
- 托盘、开机启动、启动后最小化到托盘、关闭窗口时最小化到托盘

## 技术栈

- Tauri 2
- Rust
- React + TypeScript
- SQLite
- ONNX Runtime Web + YOLO
- Recharts / Framer Motion / Lucide React

## 开发环境

需要安装：

- Node.js
- Rust
- Tauri 2 依赖环境

安装依赖：

```powershell
npm install
```

开发运行：

```powershell
npm run dev
```

构建 EXE / 安装包：

```powershell
Remove-Item Env:CC -ErrorAction SilentlyContinue
npm run build
```

构建产物：

```text
src-tauri\target\release\workrecord.exe
src-tauri\target\release\bundle\
```

## 本地数据目录

运行时数据默认写入：

```text
C:\workrecord
```

主要文件：

- `C:\workrecord\settings.json`
- `C:\workrecord\data\workrecord.sqlite3`
- `C:\workrecord\data\*.json`
- `C:\workrecord\logs\`

这些运行时数据不会提交到 Git。

## 模型文件与许可证

默认 YOLO 模型位于：

```text
public\models\yolov8n.onnx
```

本项目按 AGPL-3.0-only 发布。若你替换、训练或分发其他模型，请自行确认对应模型和训练框架的许可证要求。当前默认 YOLO 模型如来自 Ultralytics YOLO，其官方默认许可证为 AGPL-3.0。

## 开源许可证

本项目使用 **GNU Affero General Public License v3.0 only**。

这意味着你可以使用、复制、修改和分发本项目，但需要遵守 AGPL-3.0 的要求，包括但不限于：

- 保留版权和许可证声明；
- 分发修改版时提供对应源代码；
- 如果你修改后通过网络提供服务，也需要向网络用户提供对应源代码；
- 不提供任何担保。

完整许可证见：[`LICENSE`](LICENSE)。

## 项目状态

当前项目只保留 Tauri / Rust / React 重构版代码，旧 Python / PySide 版本已移除。

---

<p align="center">
  <a href="#中文">中文</a> | <strong>English</strong>
</p>

<a id="english"></a>

# WorkRecord

WorkRecord is a Windows desktop app for tracking work time. It uses camera-based YOLO person detection to infer whether the user is present, automatically accumulates the current workday duration, and provides low-interruption reminders for breaks, drinking water, moving around, and custom tasks.

> License: GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).

## Features

- Automatically tracks the current workday duration
- YOLO ONNX person detection for presence only; video is not uploaded
- Cross-midnight workday rule: after a long absence, the next presence detection starts a new workday
- Manual start / end workday controls
- History records, editable notes, and trend charts
- Preset reminders: take a break, drink water, move around
- Custom reminders: fixed-time or recurring interval
- Local sound, custom sound, and Feishu bot reminders
- Gentle desktop bubble reminders and independent reminder windows
- Camera debug preview, YOLO boxes, and ROI detection area
- Light / dark / system theme modes
- Chinese / English UI switching
- Tray support, startup on boot, and start minimized to tray

## Tech Stack

- Tauri 2
- Rust
- React + TypeScript
- SQLite
- ONNX Runtime Web + YOLO
- Recharts / Framer Motion / Lucide React

## Development

Requirements:

- Node.js
- Rust
- Tauri 2 prerequisites

Install dependencies:

```powershell
npm install
```

Run in development mode:

```powershell
npm run dev
```

Build the EXE / installers:

```powershell
Remove-Item Env:CC -ErrorAction SilentlyContinue
npm run build
```

Build outputs:

```text
src-tauri\target\release\workrecord.exe
src-tauri\target\release\bundle\
```

## Local Data Directory

Runtime data is written to:

```text
C:\workrecord
```

Main files:

- `C:\workrecord\settings.json`
- `C:\workrecord\data\workrecord.sqlite3`
- `C:\workrecord\data\*.json`
- `C:\workrecord\logs\`

These runtime files are not committed to Git.

## Model File and License

The default YOLO model is located at:

```text
public\models\yolov8n.onnx
```

This project is released under AGPL-3.0-only. If you replace, train, or redistribute other models, verify the license requirements of the corresponding model and training framework yourself. If the default YOLO model comes from Ultralytics YOLO, its default official license is AGPL-3.0.

## Open Source License

This project is licensed under the **GNU Affero General Public License v3.0 only**.

In short, you may use, copy, modify, and distribute this project, but you must comply with AGPL-3.0 requirements, including but not limited to:

- Keep copyright and license notices;
- Provide corresponding source code when distributing modified versions;
- If you modify the software and provide it as a network service, provide corresponding source code to network users;
- The software is provided without warranty.

See the full license in [`LICENSE`](LICENSE).

## Project Status

Only the Tauri / Rust / React rewrite is kept in this repository. The old Python / PySide version has been removed.
