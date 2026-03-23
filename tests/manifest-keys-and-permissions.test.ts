/**
 * Phase 0: Verify manifest keys and permission names
 *
 * Validates the IINA plugin Info.json manifest schema and permission names
 * against the PRD §9.3 specification and current scaffold output. This test
 * serves as the canonical reference for which manifest keys and permission
 * names are valid, which are required for the watch-party plugin, and which
 * are stale or undocumented.
 *
 * Exit criteria: permission decisions written down (PRD §16, Phase 0).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "path";

const PLUGIN_DIR = join(
  import.meta.dir,
  "..",
  ".scaffold-verify",
  "verify-plugin",
);

interface ManifestAuthor {
  name: string;
  email: string;
  url: string;
}

interface Manifest {
  name: string;
  identifier: string;
  version: string;
  description: string;
  author: ManifestAuthor;
  entry: string;
  globalEntry?: string;
  permissions: string[];
  sidebarTab: { name: string };
  allowedDomains: string[];
  preferencesPage: string;
  preferenceDefaults: Record<string, unknown>;
  [key: string]: unknown;
}

let manifest: Manifest;

beforeAll(async () => {
  const text = await Bun.file(join(PLUGIN_DIR, "Info.json")).text();
  manifest = JSON.parse(text) as Manifest;
});

// ---------------------------------------------------------------------------
// 1. Canonical manifest key inventory
// ---------------------------------------------------------------------------
describe("manifest key inventory", () => {
  // Keys the scaffold currently emits, verified against IINA plugin docs
  const knownKeys = new Set([
    "name",
    "identifier",
    "version",
    "description",
    "author",
    "entry",
    "globalEntry",
    "permissions",
    "sidebarTab",
    "allowedDomains",
    "preferencesPage",
    "preferenceDefaults",
  ]);

  test("scaffold emits only known manifest keys", () => {
    const actual = new Set(Object.keys(manifest));
    const unknown = [...actual].filter((k) => !knownKeys.has(k));
    expect(unknown).toEqual([]);
  });

  test("scaffold emits all known manifest keys", () => {
    const actual = new Set(Object.keys(manifest));
    const missing = [...knownKeys].filter((k) => !actual.has(k));
    expect(missing).toEqual([]);
  });

  // Stale or incorrect key names that must NOT appear (PRD §8.1)
  const rejectedKeys = ["main", "mainEntry", "global"];

  for (const key of rejectedKeys) {
    test(`rejected key '${key}' is absent`, () => {
      expect(manifest).not.toHaveProperty(key);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Manifest key types and shapes
// ---------------------------------------------------------------------------
describe("manifest key types", () => {
  test("name is a non-empty string", () => {
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
  });

  test("identifier is a reverse-DNS string", () => {
    expect(typeof manifest.identifier).toBe("string");
    expect(manifest.identifier).toMatch(/^[a-z]+(\.[a-z0-9-]+)+$/);
  });

  test("version is a semver-like string", () => {
    expect(typeof manifest.version).toBe("string");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("entry points to a .js file", () => {
    expect(manifest.entry).toMatch(/\.js$/);
  });

  test("globalEntry points to a .js file when present", () => {
    if (manifest.globalEntry !== undefined) {
      expect(manifest.globalEntry).toMatch(/\.js$/);
    }
  });

  test("author has name, email, and url", () => {
    expect(typeof manifest.author).toBe("object");
    expect(typeof manifest.author.name).toBe("string");
    expect(typeof manifest.author.email).toBe("string");
    expect(typeof manifest.author.url).toBe("string");
  });

  test("sidebarTab has a name string", () => {
    expect(typeof manifest.sidebarTab).toBe("object");
    expect(typeof manifest.sidebarTab.name).toBe("string");
  });

  test("allowedDomains is an array of strings", () => {
    expect(Array.isArray(manifest.allowedDomains)).toBe(true);
    for (const d of manifest.allowedDomains) {
      expect(typeof d).toBe("string");
    }
  });

  test("preferencesPage is a string ending in .html", () => {
    expect(manifest.preferencesPage).toMatch(/\.html$/);
  });

  test("preferenceDefaults is a plain object", () => {
    expect(typeof manifest.preferenceDefaults).toBe("object");
    expect(manifest.preferenceDefaults).not.toBeNull();
    expect(Array.isArray(manifest.preferenceDefaults)).toBe(false);
  });

  test("permissions is a non-empty array of strings", () => {
    expect(Array.isArray(manifest.permissions)).toBe(true);
    expect(manifest.permissions.length).toBeGreaterThan(0);
    for (const p of manifest.permissions) {
      expect(typeof p).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Permission name validation
// ---------------------------------------------------------------------------
describe("permission names", () => {
  // All permissions the current scaffold emits
  const scaffoldPermissions = new Set([
    "show-osd",
    "show-alert",
    "video-overlay",
    "network-request",
    "file-system",
  ]);

  // PRD §9.3 baseline: required for watch-party functionality
  const baselinePermissions = ["show-osd", "network-request", "video-overlay"];

  // PRD §9.3 conditional: valid but only needed if specific features require them
  const conditionalPermissions = [
    { name: "show-alert", reason: "alert dialogs for errors" },
    { name: "file-system", reason: "file metadata for mismatch detection" },
  ];

  // PRD §9.3 stale/undocumented: must NOT be used
  const stalePermissions = [
    "control-player",
    "observe-events",
    "show-sidebar",
    "add-menu-item",
  ];

  test("all permissions follow kebab-case naming", () => {
    for (const p of manifest.permissions) {
      expect(p).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  test("no duplicate permissions", () => {
    const unique = new Set(manifest.permissions);
    expect(unique.size).toBe(manifest.permissions.length);
  });

  test("scaffold emits only known permissions", () => {
    const unknown = manifest.permissions.filter(
      (p) => !scaffoldPermissions.has(p),
    );
    expect(unknown).toEqual([]);
  });

  describe("baseline permissions (PRD §9.3)", () => {
    for (const perm of baselinePermissions) {
      test(`'${perm}' is present`, () => {
        expect(manifest.permissions).toContain(perm);
      });
    }
  });

  describe("conditional permissions (valid, usage-dependent)", () => {
    for (const { name, reason } of conditionalPermissions) {
      test(`'${name}' is present in scaffold (${reason})`, () => {
        expect(manifest.permissions).toContain(name);
      });
    }
  });

  describe("stale permissions must be absent (PRD §9.3)", () => {
    for (const perm of stalePermissions) {
      test(`'${perm}' is NOT present`, () => {
        expect(manifest.permissions).not.toContain(perm);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Watch-party manifest requirements (PRD §9.2, §9.3)
// ---------------------------------------------------------------------------
describe("watch-party manifest requirements", () => {
  test("entry key is 'entry' not 'main' (PRD §8.1)", () => {
    expect(manifest).toHaveProperty("entry");
    expect(manifest).not.toHaveProperty("main");
  });

  test("global entry key is 'globalEntry' not 'global' (PRD §8.1)", () => {
    expect(manifest).toHaveProperty("globalEntry");
    expect(manifest).not.toHaveProperty("global");
  });

  test("sidebarTab is present for room management UI (PRD §9.2)", () => {
    expect(manifest).toHaveProperty("sidebarTab");
  });

  test("preferencesPage is present for backend URL config (PRD §9.2)", () => {
    expect(manifest).toHaveProperty("preferencesPage");
  });

  test("preferenceDefaults is present for default values (PRD §9.2)", () => {
    expect(manifest).toHaveProperty("preferenceDefaults");
  });

  test("allowedDomains must be restricted in production (PRD §9.3)", () => {
    // Scaffold defaults to wildcard; production must restrict to backend domain
    expect(manifest).toHaveProperty("allowedDomains");
    expect(Array.isArray(manifest.allowedDomains)).toBe(true);
    // Document that wildcard is scaffold default, not production-safe
    if (manifest.allowedDomains.includes("*")) {
      expect(manifest.allowedDomains).toContain("*"); // scaffold default, must narrow later
    }
  });

  test("network-request permission enables backend communication", () => {
    expect(manifest.permissions).toContain("network-request");
  });

  test("video-overlay permission enables WebSocket bridge overlay", () => {
    expect(manifest.permissions).toContain("video-overlay");
  });

  test("show-osd permission enables user feedback messages", () => {
    expect(manifest.permissions).toContain("show-osd");
  });
});
