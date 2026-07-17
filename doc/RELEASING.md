# Intervox 发布说明

## 自动构建

`.github/workflows/release.yml` 会在以下场景运行：

- 推送到 `main`：构建 macOS Apple Silicon 的 DMG 和 Windows x64 的 NSIS 安装程序，并保存到该次 GitHub Actions 运行的 `Artifacts` 中。
- 推送 `v*` 标签：构建相同安装程序及签名更新包、创建对应 GitHub Release、生成 `latest.json`，将其中的 GitHub API 资产地址转换为公开下载直链，并把 `CHANGELOG.md` 中当前版本的内容作为 Release 和应用内更新说明。
- 在 GitHub Actions 页面手动运行且不填写修复标签：构建两个平台的安装程序并保存为工作流产物。

Windows 构建会下载 `src-tauri/third-party/yt-dlp/version.json` 指定版本的官方 `yt-dlp.exe`，并使用仓库保存的官方 SHA-256 清单校验后再打包。

## 首次配置更新签名密钥

Tauri 自动更新必须使用项目独立私钥签名。Intervox 的密钥已生成在本机 `.signing/` 目录中；整个目录已被 `.gitignore` 忽略，其中的 `intervox.key` 不得提交、发送到聊天或公开保存。

在第一次推送本工作流之前，需要把私钥写入 GitHub Actions Secret：

```bash
gh secret set INTERVOX_PRIVATE_KEY --repo mayuanfei/intervox < .signing/intervox.key
```

本密钥没有密码，因此工作流中的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 保持为空。请将 `.signing/intervox.key` 另行备份到受保护的离线存储；如果私钥丢失，已安装的客户端将无法验证后续更新。不要重新生成密钥来覆盖现有公钥。

## 发布新版本

1. 同步修改以下文件中的版本号：
   - `package.json`
   - `package-lock.json`（根节点的两个版本字段）
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock`（通常由 Cargo 自动更新）
2. 把 `CHANGELOG.md` 的 `Unreleased` 内容移到新版本标题下，例如 `## [0.2.0] - 2026-08-01`。
3. 本地执行：

   ```bash
   npm ci
   npm run release:verify
   npm run build
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

   在 macOS 上验证签名安装包和 updater 产物：

   ```bash
   TAURI_SIGNING_PRIVATE_KEY="$(<.signing/intervox.key)" \
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
   npm run tauri build -- --target aarch64-apple-darwin --bundles app,dmg
   ```

4. 提交并推送代码后创建与应用版本一致的标签：

   ```bash
   git tag v0.2.0
   git push github main
   git push github v0.2.0
   ```

标签必须严格为 `v` 加应用版本号；不一致时工作流会直接失败，避免错误版本进入 Release。

## 修复已发布的更新清单

如果历史 Release 的 `latest.json` 使用了 `api.github.com/repos/.../releases/assets/...` 地址，匿名 GitHub API 限流可能导致应用下载更新时返回 403。可以在 GitHub Actions 页面手动运行 `Build desktop installers`，并在 `repair_release_tag` 中填写需要修复的标签，例如 `v0.1.1`。

填写该参数后，工作流不会重新构建安装程序，只会读取该 Release 的资产元数据，把 `latest.json` 中的 API 地址替换为公开的 `github.com/.../releases/download/...` 直链并覆盖原清单。签名字段和安装程序本身不会改变。

## 签名说明

当前流水线已经配置 Tauri Updater 签名，用于让已安装的 Intervox 验证更新包来源；这与操作系统代码签名是两套机制。

安装程序目前仍未使用 Apple/Windows 开发者证书签名或公证。它们可以用于内部测试，但在公开分发时 macOS Gatekeeper 和 Windows SmartScreen 可能显示安全提醒。正式对外发布前，建议再配置 Apple Developer ID、公证凭据和 Windows 代码签名证书。

## 应用内更新行为

- 默认在已安装的生产版本启动时后台检查更新；设置页可以关闭自动检查或随时手动检查。
- 发现新版本后显示 `CHANGELOG.md` 对应内容，用户可以下载、安装或跳过当前版本。
- 下载和安装不会静默开始，始终需要用户确认。
- 存在排队中或运行中的媒体任务时禁止安装，必须先完成或取消任务，避免更新退出打断 ASR、TTS 或视频导出。
- macOS 安装完成后提示重启；Windows 安装器执行更新时可能自动退出应用。
