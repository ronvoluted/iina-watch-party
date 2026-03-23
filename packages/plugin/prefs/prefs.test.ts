import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Preferences page tests.
 *
 * Since the preferences page runs in IINA's webview with its own DOM,
 * we test the HTML structure and inline script logic statically.
 */

describe("preferences page", () => {
  let html: string;

  beforeEach(() => {
    html = readFileSync(join(__dirname, "index.html"), "utf-8");
  });

  describe("structure", () => {
    test("contains backendUrl input", () => {
      expect(html).toContain('id="backendUrl"');
      expect(html).toContain('type="url"');
    });

    test("contains displayName input", () => {
      expect(html).toContain('id="displayName"');
      expect(html).toContain('type="text"');
    });

    test("contains driftThresholdMs input", () => {
      expect(html).toContain('id="driftThresholdMs"');
      expect(html).toContain('type="number"');
    });

    test("sets drift threshold constraints", () => {
      expect(html).toContain('min="500"');
      expect(html).toContain('max="10000"');
      expect(html).toContain('step="100"');
    });

    test("has displayName maxlength", () => {
      expect(html).toContain('maxlength="32"');
    });

    test("uses data-pref-key for IINA auto-wiring", () => {
      expect(html).toContain('data-pref-key="backendUrl"');
      expect(html).toContain('data-pref-key="displayName"');
      expect(html).toContain('data-pref-key="driftThresholdMs"');
    });

    test("uses data-type=int for numeric preference", () => {
      expect(html).toContain('data-type="int"');
    });
  });

  describe("validation logic", () => {
    test("includes URL protocol validation", () => {
      expect(html).toContain("https:");
      expect(html).toContain("http:");
      expect(html).toContain("new URL");
    });

    test("includes drift threshold range validation", () => {
      expect(html).toContain("< 500");
      expect(html).toContain("> 10000");
    });

    test("has error styling class", () => {
      expect(html).toContain(".hint.error");
      expect(html).toContain("invalid");
    });

    test("validates on input events", () => {
      expect(html).toContain('"input"');
    });
  });

  describe("field hints", () => {
    test("has hint for each field", () => {
      expect(html).toContain('id="backendUrl-hint"');
      expect(html).toContain('id="displayName-hint"');
      expect(html).toContain('id="driftThresholdMs-hint"');
    });
  });

  describe("alignment with Info.json", () => {
    let manifest: Record<string, unknown>;

    beforeEach(() => {
      const manifestPath = join(__dirname, "..", "Info.json");
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    });

    test("preferences page matches manifest preferencesPage", () => {
      expect(manifest.preferencesPage).toBe("prefs/index.html");
    });

    test("all preferenceDefaults have corresponding inputs", () => {
      const defaults = manifest.preferenceDefaults as Record<string, unknown>;
      for (const key of Object.keys(defaults)) {
        expect(html).toContain(`id="${key}"`);
      }
    });

    test("drift threshold default matches manifest", () => {
      const defaults = manifest.preferenceDefaults as Record<string, unknown>;
      expect(defaults.driftThresholdMs).toBe(2000);
      expect(html).toContain('value="2000"');
    });
  });
});
