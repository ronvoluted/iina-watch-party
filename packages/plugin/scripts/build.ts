/**
 * Plugin build pipeline.
 *
 * 1. Clean and create the build directory structure.
 * 2. Bundle src/main.ts → build/src/main.js (ESM, shared inlined).
 * 3. Bundle each webview JS entry → build/ui/<name>/index.js.
 * 4. Copy static assets (HTML files, Info.json, prefs/).
 * 5. Validate that every file referenced by Info.json exists in build/.
 */

import { mkdirSync, rmSync, cpSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const buildDir = join(pkgRoot, "build");

// ── helpers ────────────────────────────────────────────────────────────

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

/** Throw with a descriptive message when a build step fails. */
function fatal(msg: string): never {
  throw new Error(`[build] ${msg}`);
}

// ── 1. Clean & create dirs ─────────────────────────────────────────────

export function clean(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

const BUILD_DIRS = ["src", "ui/overlay", "ui/sidebar", "prefs"] as const;

export function createDirs(root: string): void {
  for (const dir of BUILD_DIRS) {
    mkdirSync(join(root, dir), { recursive: true });
  }
}

// ── 2. Bundle entry points ─────────────────────────────────────────────

export interface BundleResult {
  entrypoint: string;
  outfile: string;
  size: number;
}

export async function bundleEntry(
  entrypoint: string,
  outdir: string,
  format: "esm" | "iife" = "esm",
): Promise<BundleResult> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    format,
    target: "browser",
    minify: false,
  });

  if (!result.success) {
    const errors = result.logs.map((l) => l.message).join("\n");
    fatal(`Bundle failed for ${entrypoint}:\n${errors}`);
  }

  const output = result.outputs[0];
  return {
    entrypoint,
    outfile: output.path,
    size: output.size ?? 0,
  };
}

// ── 3. Copy static assets ──────────────────────────────────────────────

interface CopySpec {
  src: string;
  dest: string;
  recursive?: boolean;
}

function copyAssets(root: string, dest: string): CopySpec[] {
  const specs: CopySpec[] = [
    { src: join(root, "Info.json"), dest: join(dest, "Info.json") },
    { src: join(root, "ui/overlay/index.html"), dest: join(dest, "ui/overlay/index.html") },
    { src: join(root, "ui/sidebar/index.html"), dest: join(dest, "ui/sidebar/index.html") },
    { src: join(root, "prefs"), dest: join(dest, "prefs"), recursive: true },
  ];

  for (const spec of specs) {
    if (!existsSync(spec.src)) {
      fatal(`Missing source asset: ${spec.src}`);
    }
    cpSync(spec.src, spec.dest, { recursive: spec.recursive ?? false });
  }

  return specs;
}

// ── 4. Validate build output ───────────────────────────────────────────

export interface ManifestValidation {
  valid: boolean;
  missing: string[];
}

export function validateBuild(root: string): ManifestValidation {
  const manifestPath = join(root, "Info.json");
  if (!existsSync(manifestPath)) {
    return { valid: false, missing: ["Info.json"] };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const missing: string[] = [];

  // Check entry file
  if (manifest.entry && !existsSync(join(root, manifest.entry))) {
    missing.push(manifest.entry);
  }

  // Check preferences page
  if (manifest.preferencesPage && !existsSync(join(root, manifest.preferencesPage))) {
    missing.push(manifest.preferencesPage);
  }

  // Check webview HTML files
  for (const htmlFile of ["ui/overlay/index.html", "ui/sidebar/index.html"]) {
    if (!existsSync(join(root, htmlFile))) {
      missing.push(htmlFile);
    }
  }

  // Check webview JS files (referenced by HTML)
  for (const jsFile of ["ui/overlay/index.js", "ui/sidebar/index.js"]) {
    if (!existsSync(join(root, jsFile))) {
      missing.push(jsFile);
    }
  }

  return { valid: missing.length === 0, missing };
}

// ── 5. Orchestrate ─────────────────────────────────────────────────────

export interface BuildReport {
  bundles: BundleResult[];
  assetsCopied: number;
  validation: ManifestValidation;
  durationMs: number;
}

export async function build(
  root: string = pkgRoot,
  outDir: string = buildDir,
): Promise<BuildReport> {
  const t0 = performance.now();

  // Step 1: clean & create
  clean(outDir);
  createDirs(outDir);

  // Step 2: bundle main entry
  const mainBundle = await bundleEntry(
    join(root, "src/main.ts"),
    join(outDir, "src"),
    "esm",
  );

  // Step 3: bundle webview JS
  const overlayBundle = await bundleEntry(
    join(root, "ui/overlay/index.js"),
    join(outDir, "ui/overlay"),
    "iife",
  );

  const sidebarBundle = await bundleEntry(
    join(root, "ui/sidebar/index.js"),
    join(outDir, "ui/sidebar"),
    "iife",
  );

  const bundles = [mainBundle, overlayBundle, sidebarBundle];

  // Step 4: copy static assets
  const copied = copyAssets(root, outDir);

  // Step 5: validate
  const validation = validateBuild(outDir);
  if (!validation.valid) {
    fatal(`Build validation failed. Missing files: ${validation.missing.join(", ")}`);
  }

  const report: BuildReport = {
    bundles,
    assetsCopied: copied.length,
    validation,
    durationMs: Math.round(performance.now() - t0),
  };

  return report;
}

// ── CLI entry ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const t0 = performance.now();
  const outDirOverride = process.env.BUILD_OUT_DIR;
  console.log("[build] Starting plugin build…");

  const report = await build(pkgRoot, outDirOverride ?? buildDir);

  for (const b of report.bundles) {
    const name = b.entrypoint.replace(pkgRoot + "/", "");
    console.log(`  ✓ ${name} → ${b.size} bytes`);
  }
  console.log(`  ✓ ${report.assetsCopied} static assets copied`);
  console.log(`[build] Done in ${elapsed(t0)}`);
}
