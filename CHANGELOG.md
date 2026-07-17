# Changelog

本项目的所有重要变更都会记录在此文件中。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，正式发布前请把 `Unreleased` 中的内容移入对应版本。

## [Unreleased]

### 修复

- 自动更新清单改用公开的 GitHub Release 下载直链，避免匿名 GitHub API 限流导致 Windows 更新下载返回 403。

## [0.1.1] - 2026-07-17

### 修复

- Windows 正式安装版改为图形界面子系统启动，不再同时打开 Windows Terminal 控制台窗口。

### 变更

- ASR 任务状态和日志根据实际服务商显示阿里云百炼、Google Chirp、火山引擎豆包或本地 Whisper，不再固定显示百炼。
- 默认开启目标语言字幕，使新任务导出时默认包含翻译字幕。
- 将本地 TTS 缓存预设版本升级到 5，使旧规则生成的缓存重新合成。

## [0.1.0] - 2026-07-17

### 新增

- 提供本地与网络视频播放、播放历史和 HLS 转码播放能力。
- 提供网页视频、媒体直链及字幕下载，并通过内置 yt-dlp 增强动态视频网站解析。
- 提供从音轨提取、ASR、翻译、TTS、配音混合到视频导出的完整处理流程。
- 支持阿里云百炼、火山引擎、Google Chirp 和本地 Whisper 等语音识别方案，以及电子音和声音复刻配置。
- 支持字幕生成、硬字幕烧录、原声与配音音量调节和任务进度管理。
- 增加 GitHub Actions 自动构建：推送 `main` 生成 Windows x64 与 macOS Apple Silicon 安装程序，推送 `v*` 标签同时创建 GitHub Release。
- 增加应用内自动检查更新、手动检查、版本跳过、更新说明、下载进度和安装重启，并在媒体任务运行或排队时阻止安装更新。
