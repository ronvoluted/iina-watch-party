/**
 * Phase 0: IINA Scaffold Verification Tests
 *
 * Verifies that the current `iina-plugin new` scaffold output matches
 * the assumptions in the PRD. Run against a freshly generated scaffold
 * to catch any drift between docs and reality.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { $ } from "bun";

const SCAFFOLD_DIR = join(import.meta.dir, "..", ".scaffold-verify");
const PLUGIN_DIR = join(SCAFFOLD_DIR, "verify-plugin");

beforeAll(async () => {
  // Clean and regenerate scaffold with all features enabled
  await $`rm -rf ${SCAFFOLD_DIR}`.quiet();
  await $`mkdir -p ${SCAFFOLD_DIR}`.quiet();
  // Use expect(1) to drive the interactive CLI prompts
  await $`cd ${SCAFFOLD_DIR} && expect -c '
spawn iina-plugin new verify-plugin
expect "global entry"
send "y\r"
expect "video overlay"
send "y\r"
expect "side bar"
send "y\r"
expect "standalone window"
send "y\r"
expect "frontend framework"
send "1\r"
expect "bundler"
send "n\r"
expect eof
'`.quiet().nothrow();
});

async function readScaffoldJsonAsync(relativePath: string): Promise<unknown> {
  const fullPath = join(PLUGIN_DIR, relativePath);
  const text = await Bun.file(fullPath).text();
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// 1. File structure
// ---------------------------------------------------------------------------
describe("scaffold file structure", () => {
  const expectedFiles = [
    "Info.json",
    "jsconfig.json",
    "src/index.js",
    "src/global.js",
    "ui/overlay/index.html",
    "ui/overlay/index.js",
    "ui/sidebar/index.html",
    "ui/sidebar/index.js",
    "ui/window/index.html",
    "ui/window/index.js",
    ".gitignore",
  ];

  for (const file of expectedFiles) {
    test(`contains ${file}`, () => {
      expect(existsSync(join(PLUGIN_DIR, file))).toBe(true);
    });
  }

  test("does not contain unexpected src files", () => {
    const srcFiles = new Bun.Glob("src/**/*").scanSync(PLUGIN_DIR);
    const names = Array.from(srcFiles).sort();
    expect(names).toEqual(["src/global.js", "src/index.js"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Info.json manifest keys
// ---------------------------------------------------------------------------
describe("Info.json manifest", () => {
  let manifest: Record<string, unknown>;

  beforeAll(async () => {
    manifest = (await readScaffoldJsonAsync("Info.json")) as Record<
      string,
      unknown
    >;
  });

  test("uses 'entry' key (not 'main' or 'mainEntry')", () => {
    expect(manifest).toHaveProperty("entry");
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("mainEntry");
    expect(manifest.entry).toBe("src/index.js");
  });

  test("uses 'globalEntry' key (not 'global')", () => {
    expect(manifest).toHaveProperty("globalEntry");
    expect(manifest).not.toHaveProperty("global");
    expect(manifest.globalEntry).toBe("src/global.js");
  });

  test("has sidebarTab object with name", () => {
    expect(manifest).toHaveProperty("sidebarTab");
    const tab = manifest.sidebarTab as Record<string, unknown>;
    expect(tab).toHaveProperty("name");
    expect(typeof tab.name).toBe("string");
  });

  test("has preferencesPage key", () => {
    expect(manifest).toHaveProperty("preferencesPage");
    expect(typeof manifest.preferencesPage).toBe("string");
  });

  test("has preferenceDefaults key", () => {
    expect(manifest).toHaveProperty("preferenceDefaults");
    expect(typeof manifest.preferenceDefaults).toBe("object");
  });

  test("has allowedDomains array", () => {
    expect(manifest).toHaveProperty("allowedDomains");
    expect(Array.isArray(manifest.allowedDomains)).toBe(true);
  });

  test("has permissions array", () => {
    expect(manifest).toHaveProperty("permissions");
    expect(Array.isArray(manifest.permissions)).toBe(true);
  });

  test("has identifier string", () => {
    expect(manifest).toHaveProperty("identifier");
    expect(typeof manifest.identifier).toBe("string");
  });

  test("has version string", () => {
    expect(manifest).toHaveProperty("version");
    expect(typeof manifest.version).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 3. Permissions verification (PRD §9.3)
// ---------------------------------------------------------------------------
describe("scaffold permissions", () => {
  let permissions: string[];

  beforeAll(async () => {
    const manifest = (await readScaffoldJsonAsync("Info.json")) as Record<
      string,
      unknown
    >;
    permissions = manifest.permissions as string[];
  });

  // PRD baseline permissions - must exist in scaffold
  test("includes 'show-osd'", () => {
    expect(permissions).toContain("show-osd");
  });

  test("includes 'network-request'", () => {
    expect(permissions).toContain("network-request");
  });

  test("includes 'video-overlay'", () => {
    expect(permissions).toContain("video-overlay");
  });

  // Additional permissions the scaffold includes (valid but not all needed for MVP)
  test("includes 'show-alert' (valid scaffold permission)", () => {
    expect(permissions).toContain("show-alert");
  });

  test("includes 'file-system' (valid scaffold permission, optional for MVP)", () => {
    expect(permissions).toContain("file-system");
  });

  // PRD §9.3 warns these are stale/undocumented - scaffold must NOT include them
  const stalePermissions = [
    "control-player",
    "observe-events",
    "show-sidebar",
    "add-menu-item",
  ];

  for (const perm of stalePermissions) {
    test(`does NOT include stale permission '${perm}'`, () => {
      expect(permissions).not.toContain(perm);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Main entry (src/index.js) API surface
// ---------------------------------------------------------------------------
describe("main entry API surface", () => {
  let source: string;

  beforeAll(async () => {
    source = await Bun.file(join(PLUGIN_DIR, "src/index.js")).text();
  });

  test("destructures from global iina object", () => {
    expect(source).toContain("} = iina");
  });

  test("uses iina.overlay API", () => {
    expect(source).toContain("overlay");
    expect(source).toContain("overlay.loadFile");
    expect(source).toContain("overlay.show()");
    expect(source).toContain("overlay.hide()");
  });

  test("uses iina.sidebar API", () => {
    expect(source).toContain("sidebar");
    expect(source).toContain("sidebar.loadFile");
  });

  test("uses iina.event API with 'iina.window-loaded' event", () => {
    expect(source).toContain("event.on");
    expect(source).toContain("iina.window-loaded");
  });

  test("uses iina.menu API", () => {
    expect(source).toContain("menu.addItem");
    expect(source).toContain("menu.item");
  });

  test("uses iina.console API", () => {
    expect(source).toContain("console.log");
  });

  test("uses iina.standaloneWindow API", () => {
    expect(source).toContain("standaloneWindow");
  });
});

// ---------------------------------------------------------------------------
// 5. Global entry (src/global.js)
// ---------------------------------------------------------------------------
describe("global entry", () => {
  let source: string;

  beforeAll(async () => {
    source = await Bun.file(join(PLUGIN_DIR, "src/global.js")).text();
  });

  test("destructures from global iina object", () => {
    expect(source).toContain("iina");
  });

  test("is minimal (just console.log)", () => {
    expect(source).toContain("console.log");
    // Global entry is a simple stub in the scaffold
    expect(
      source.split("\n").filter((l) => l.trim()).length
    ).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 6. Webview HTML structure
// ---------------------------------------------------------------------------
describe("webview HTML templates", () => {
  const webviews = [
    "ui/overlay/index.html",
    "ui/sidebar/index.html",
    "ui/window/index.html",
  ];

  for (const view of webviews) {
    describe(view, () => {
      let html: string;

      beforeAll(async () => {
        html = await Bun.file(join(PLUGIN_DIR, view)).text();
      });

      test("is valid HTML with doctype", () => {
        expect(html).toContain("<!DOCTYPE html>");
      });

      test("includes module script tag", () => {
        expect(html).toContain('<script type="module"');
      });

      test("has a root div", () => {
        expect(html).toContain('id="root"');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 7. PRD cross-reference: document verified findings
// ---------------------------------------------------------------------------
describe("PRD cross-reference", () => {
  let manifest: Record<string, unknown>;

  beforeAll(async () => {
    manifest = (await readScaffoldJsonAsync("Info.json")) as Record<
      string,
      unknown
    >;
  });

  test("PRD §8.1: globalEntry is the correct manifest key (not 'global')", () => {
    expect(manifest).toHaveProperty("globalEntry");
    expect(manifest).not.toHaveProperty("global");
  });

  test("PRD §8.2: overlay webview exists and is loadable from main entry", async () => {
    const source = await Bun.file(join(PLUGIN_DIR, "src/index.js")).text();
    expect(existsSync(join(PLUGIN_DIR, "ui/overlay/index.html"))).toBe(true);
    expect(source).toContain('overlay.loadFile("ui/overlay/index.html")');
  });

  test("PRD §9.3: all three baseline permissions exist in scaffold", () => {
    const perms = manifest.permissions as string[];
    expect(perms).toContain("show-osd");
    expect(perms).toContain("network-request");
    expect(perms).toContain("video-overlay");
  });

  test("PRD §9.3: no stale permission names in scaffold", () => {
    const perms = manifest.permissions as string[];
    const stale = [
      "control-player",
      "observe-events",
      "show-sidebar",
      "add-menu-item",
    ];
    for (const s of stale) {
      expect(perms).not.toContain(s);
    }
  });

  test("PRD §9.2: scaffold supports overlay, sidebar, and standalone window webviews", () => {
    expect(existsSync(join(PLUGIN_DIR, "ui/overlay/index.html"))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, "ui/sidebar/index.html"))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, "ui/window/index.html"))).toBe(true);
  });
});
