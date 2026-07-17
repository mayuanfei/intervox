import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const cargoManifest = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");

const packageSection = cargoManifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
const cargoVersion = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json packages root", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoVersion],
]);

const expectedVersion = packageJson.version;
const mismatches = [...versions].filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  const details = mismatches
    .map(([file, version]) => `  - ${file}: ${version ?? "missing"}`)
    .join("\n");
  throw new Error(`Release versions must all be ${expectedVersion}:\n${details}`);
}

const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const changelogHeading = new RegExp(
  `^## \\[${escapedVersion}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\s*$`,
  "m",
);
if (!changelogHeading.test(changelog)) {
  throw new Error(`CHANGELOG.md is missing a ## [${expectedVersion}] entry`);
}

if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
  throw new Error("src-tauri/tauri.conf.json must enable bundle.createUpdaterArtifacts");
}

for (const target of ["app", "dmg", "nsis"]) {
  if (!tauriConfig.bundle?.targets?.includes(target)) {
    throw new Error(`src-tauri/tauri.conf.json must include the ${target} bundle target`);
  }
}

const updater = tauriConfig.plugins?.updater;
if (!updater?.pubkey || !updater.endpoints?.includes(
  "https://github.com/mayuanfei/intervox/releases/latest/download/latest.json",
)) {
  throw new Error("src-tauri/tauri.conf.json has incomplete GitHub updater configuration");
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  const expectedTag = `v${expectedVersion}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(
      `Release tag ${process.env.GITHUB_REF_NAME} does not match application version ${expectedVersion}; expected ${expectedTag}`,
    );
  }
}

console.log(`Release metadata is consistent at version ${expectedVersion}.`);
