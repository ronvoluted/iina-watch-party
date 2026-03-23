/**
 * Pre-build script: creates the build directory structure and copies
 * static assets (Info.json, HTML, webview JS) into the build output.
 */

import { mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const buildDir = join(pkgRoot, "build");

const dirs = [
  "src",
  "ui/overlay",
  "ui/sidebar",
  "prefs",
];

for (const dir of dirs) {
  mkdirSync(join(buildDir, dir), { recursive: true });
}

cpSync(join(pkgRoot, "Info.json"), join(buildDir, "Info.json"));
cpSync(join(pkgRoot, "ui/overlay"), join(buildDir, "ui/overlay"), { recursive: true });
cpSync(join(pkgRoot, "ui/sidebar"), join(buildDir, "ui/sidebar"), { recursive: true });
cpSync(join(pkgRoot, "prefs"), join(buildDir, "prefs"), { recursive: true });

console.log("Build directory prepared at", buildDir);
