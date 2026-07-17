import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUpdaterManifest } from "./normalize-updater-json.mjs";

const release = {
  tag_name: "v0.1.1",
  assets: [
    {
      id: 101,
      browser_download_url:
        "https://github.com/mayuanfei/intervox/releases/download/v0.1.1/intervox_windows.exe",
    },
    {
      id: 102,
      browser_download_url:
        "https://github.com/mayuanfei/intervox/releases/download/v0.1.1/intervox_macos.tar.gz",
    },
  ],
};

test("rewrites GitHub API release asset URLs", () => {
  const input = {
    version: "0.1.1",
    platforms: {
      "windows-x86_64": {
        signature: "windows-signature",
        url: "https://api.github.com/repos/mayuanfei/intervox/releases/assets/101",
      },
      "darwin-aarch64": {
        signature: "macos-signature",
        url: "https://api.github.com/repos/mayuanfei/intervox/releases/assets/102",
      },
    },
  };

  const result = normalizeUpdaterManifest(input, release);

  assert.equal(result.rewritten, 2);
  assert.equal(
    result.manifest.platforms["windows-x86_64"].url,
    release.assets[0].browser_download_url,
  );
  assert.equal(
    result.manifest.platforms["darwin-aarch64"].url,
    release.assets[1].browser_download_url,
  );
  assert.equal(
    result.manifest.platforms["windows-x86_64"].signature,
    "windows-signature",
  );
});

test("keeps an already normalized manifest unchanged", () => {
  const input = {
    version: "0.1.1",
    platforms: {
      "windows-x86_64": {
        signature: "windows-signature",
        url: release.assets[0].browser_download_url,
      },
    },
  };

  const result = normalizeUpdaterManifest(input, release);

  assert.equal(result.rewritten, 0);
  assert.equal(
    result.manifest.platforms["windows-x86_64"].url,
    release.assets[0].browser_download_url,
  );
});

test("rejects an API asset that is absent from the release", () => {
  const input = {
    version: "0.1.1",
    platforms: {
      "windows-x86_64": {
        signature: "windows-signature",
        url: "https://api.github.com/repos/mayuanfei/intervox/releases/assets/999",
      },
    },
  };

  assert.throws(
    () => normalizeUpdaterManifest(input, release),
    /Release asset 999.*was not found/,
  );
});
