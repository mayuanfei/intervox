import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(
  `^## \\[${escapedVersion}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\s*$`,
  "m",
);
const match = heading.exec(changelog);

if (!match) {
  throw new Error(`CHANGELOG.md is missing a ## [${version}] entry`);
}

const contentStart = match.index + match[0].length;
const remaining = changelog.slice(contentStart);
const nextHeading = remaining.search(/^## \[/m);
const notes = (nextHeading === -1 ? remaining : remaining.slice(0, nextHeading)).trim();

if (!notes) {
  throw new Error(`CHANGELOG.md entry ${version} has no release notes`);
}

console.log(notes);
