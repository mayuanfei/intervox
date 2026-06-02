# yt-dlp sidecar

Intervox bundles the official macOS Universal `yt-dlp_macos` executable from:

https://github.com/yt-dlp/yt-dlp/releases/tag/2026.03.17

The executable is renamed to the Tauri sidecar filename:

`src-tauri/binaries/yt-dlp-aarch64-apple-darwin`

The downloaded asset was verified against the official `SHA2-256SUMS` file. See
`version.json` for the pinned version and checksum.

The standalone executable contains third-party components with their own
licenses. The upstream `LICENSE` and `THIRD_PARTY_LICENSES.txt` files are
included in this directory and packaged with the application.
