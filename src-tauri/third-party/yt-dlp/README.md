# yt-dlp sidecar

Intervox bundles official yt-dlp executables from:

https://github.com/yt-dlp/yt-dlp/releases/tag/2026.03.17

The macOS Universal executable is committed to the repository and renamed to
the Tauri sidecar filename:

`src-tauri/binaries/yt-dlp-aarch64-apple-darwin`

The GitHub Actions release workflow downloads `yt-dlp.exe` from the same pinned
release and renames it to:

`src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe`

Both assets are verified against the official `SHA2-256SUMS` file. See
`version.json` for the pinned version and macOS checksum.

The standalone executable contains third-party components with their own
licenses. The upstream `LICENSE` and `THIRD_PARTY_LICENSES.txt` files are
included in this directory and packaged with the application.
