import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function normalizeUpdaterManifest(manifest, release) {
  if (!manifest?.platforms || typeof manifest.platforms !== "object") {
    throw new Error("latest.json is missing the platforms object");
  }
  if (!Array.isArray(release?.assets) || !release.tag_name) {
    throw new Error("GitHub release metadata is incomplete");
  }

  const expectedVersion = String(release.tag_name).replace(/^v/, "");
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Updater version ${manifest.version} does not match release ${release.tag_name}`,
    );
  }

  const assetsById = new Map(
    release.assets.map((asset) => [String(asset.id), asset.browser_download_url]),
  );
  const browserDownloadUrls = new Set(assetsById.values());
  let rewritten = 0;

  for (const [platform, update] of Object.entries(manifest.platforms)) {
    if (!update?.url) {
      throw new Error(`Updater platform ${platform} is missing its download URL`);
    }
    if (browserDownloadUrls.has(update.url)) {
      continue;
    }

    const assetId = update.url.match(/\/releases\/assets\/(\d+)(?:\?.*)?$/)?.[1];
    if (!assetId) {
      throw new Error(`Updater platform ${platform} has an unsupported URL: ${update.url}`);
    }

    const browserDownloadUrl = assetsById.get(assetId);
    if (!browserDownloadUrl) {
      throw new Error(`Release asset ${assetId} for platform ${platform} was not found`);
    }

    update.url = browserDownloadUrl;
    rewritten += 1;
  }

  return { manifest, rewritten };
}

function main() {
  const [manifestPath, releasePath] = process.argv.slice(2);
  if (!manifestPath || !releasePath) {
    throw new Error(
      "Usage: node normalize-updater-json.mjs <latest.json> <release.json>",
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  const result = normalizeUpdaterManifest(manifest, release);
  writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  console.log(`Normalized ${result.rewritten} updater download URL(s).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
