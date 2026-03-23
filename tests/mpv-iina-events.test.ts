/**
 * Phase 0: Verify exact mpv and IINA events for pause, seek, buffering,
 * and file-load handling
 *
 * This test documents and validates the event names, mpv property observers,
 * and IINA APIs needed for the watch-party sync engine. Sources of truth:
 *
 * - IINA plugin type definitions (iina-plugin-definition/iina/index.d.ts)
 * - mpv manual (mpv-player/mpv/DOCS/man/input.rst) — "List of events" and
 *   "Properties" sections
 * - PRD §9.11 (FR-6): Do not use mpv.time-pos.changed as a seek detector
 *
 * Exit criteria: event and permission decisions written down (PRD §16, Phase 0).
 */
import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Source data: fetched from iina-plugin-definition master and mpv docs
// ---------------------------------------------------------------------------

/**
 * All typed IINA event names from iina-plugin-definition/iina/index.d.ts.
 * These use the `iina.` prefix and are the only IINA-specific events with
 * typed overloads in the plugin API.
 */
const IINA_TYPED_EVENTS: string[] = [
  "iina.window-loaded",
  "iina.window-size-adjusted",
  "iina.window-screen.changed",
  "iina.window-miniaturized",
  "iina.window-deminiaturized",
  "iina.window-main.changed",
  "iina.window-will-close",
  "iina.window-did-close",
  "iina.music-mode.changed",
  "iina.file-loaded",
  "iina.file-started",
  "iina.mpv-inititalized", // note: typo is in the official API
  "iina.thumbnails-ready",
  "iina.plugin-overlay-loaded",
] as const;

/**
 * mpv events from mpv manual "List of events" section. These are fired via
 * the mpv event system and listened to with `event.on("mpv.EVENT_NAME", cb)`.
 */
const MPV_EVENTS: string[] = [
  "start-file",
  "end-file",
  "file-loaded",
  "seek",
  "playback-restart",
  "shutdown",
  "log-message",
] as const;

/**
 * mpv properties that can be observed via `event.on("mpv.PROP.changed", cb)`.
 * Values are read with `mpv.getFlag()`, `mpv.getNumber()`, or `mpv.getString()`.
 */
const MPV_OBSERVABLE_PROPERTIES = {
  pause: { type: "flag", rw: true, description: "Whether playback is paused" },
  seeking: {
    type: "flag",
    rw: false,
    description:
      "Whether the player is currently seeking or resyncing playback",
  },
  "paused-for-cache": {
    type: "flag",
    rw: false,
    description: "Whether playback is paused because of waiting for the cache",
  },
  "cache-buffering-state": {
    type: "number",
    rw: false,
    description:
      "Cache fill percentage (0-100) until the player will unpause",
  },
  "core-idle": {
    type: "flag",
    rw: false,
    description:
      "Whether the playback core is paused; differs from pause during buffering",
  },
  "idle-active": {
    type: "flag",
    rw: false,
    description: "Whether no file is loaded (idle state)",
  },
  "time-pos": {
    type: "number",
    rw: true,
    description: "Position in current file in seconds",
  },
  duration: {
    type: "number",
    rw: false,
    description: "Duration of the current file in seconds",
  },
  speed: {
    type: "number",
    rw: true,
    description: "Current playback speed",
  },
  filename: {
    type: "string",
    rw: false,
    description: "Currently playing filename (without path)",
  },
  path: {
    type: "string",
    rw: false,
    description: "Full path of the currently playing file",
  },
} as const;

// ---------------------------------------------------------------------------
// IINA APIs for applying remote commands locally
// ---------------------------------------------------------------------------

/**
 * IINA Core API methods for playback control. These are used to apply remote
 * sync commands locally.
 */
const IINA_CORE_METHODS = {
  pause: { signature: "core.pause(): void", description: "Pause playback" },
  resume: { signature: "core.resume(): void", description: "Resume playback" },
  seek: {
    signature: "core.seek(seconds: number, exact: boolean): void",
    description: "Relative seek",
  },
  seekTo: {
    signature: "core.seekTo(seconds: number): void",
    description:
      "Absolute seek (no exact flag — always exact per IINA docs)",
  },
  setSpeed: {
    signature: "core.setSpeed(speed: number): void",
    description: "Set playback speed",
  },
  stop: {
    signature: "core.stop(): void",
    description: "Stop playback and close the file",
  },
} as const;

/**
 * IINA StatusAPI properties (core.status.*) for reading current state.
 * All are readonly.
 */
const IINA_STATUS_PROPERTIES = {
  paused: { type: "boolean", description: "Whether the player is paused" },
  idle: { type: "boolean", description: "Whether the player is idle" },
  position: { type: "number", description: "Current playback position (s)" },
  duration: { type: "number", description: "Duration of the current file (s)" },
  speed: { type: "number", description: "Current playback speed" },
  url: { type: "string", description: "URL of the current file" },
  title: { type: "string", description: "Title of the current file" },
  isNetworkResource: {
    type: "boolean",
    description: "Whether the current file is a network resource",
  },
} as const;

// ---------------------------------------------------------------------------
// Watch-party event mapping: which events/properties handle each sync concern
// ---------------------------------------------------------------------------

interface EventMapping {
  description: string;
  iinaEvents: string[];
  mpvEvents: string[];
  mpvProperties: string[];
  coreAPIs: string[];
  statusAPIs: string[];
  notes: string[];
}

const WATCH_PARTY_EVENT_MAP: Record<string, EventMapping> = {
  pause: {
    description: "Detect and apply play/pause state changes",
    iinaEvents: [],
    mpvEvents: [],
    mpvProperties: ["pause"],
    coreAPIs: ["pause", "resume"],
    statusAPIs: ["paused"],
    notes: [
      "Use mpv.pause.changed to detect user-initiated pause/resume.",
      "Use core.pause() and core.resume() to apply remote commands.",
      "Read core.status.paused for current state in heartbeats.",
      "Do not confuse with core-idle which also triggers during buffering.",
    ],
  },

  seek: {
    description: "Detect and apply seek operations",
    iinaEvents: [],
    mpvEvents: ["seek", "playback-restart"],
    mpvProperties: ["seeking"],
    coreAPIs: ["seek", "seekTo"],
    statusAPIs: ["position"],
    notes: [
      "Use mpv.seek event to detect that a seek was initiated.",
      "Use mpv.playback-restart to know when seek completed and playback resumed.",
      "Use mpv.seeking.changed to track seeking state for suppression guards.",
      "Do NOT use mpv.time-pos.changed as a seek detector (PRD FR-6).",
      "Use core.seekTo(seconds) for absolute positioning (drift correction).",
      "Use core.seek(seconds, true) for relative adjustments if needed.",
      "Read core.status.position for current position in heartbeats.",
    ],
  },

  buffering: {
    description: "Detect buffering state for sync suppression and warnings",
    iinaEvents: [],
    mpvEvents: [],
    mpvProperties: ["paused-for-cache", "cache-buffering-state", "core-idle"],
    coreAPIs: [],
    statusAPIs: [],
    notes: [
      "Use mpv.paused-for-cache.changed to detect when buffering starts/stops.",
      "Use mpv.cache-buffering-state.changed to track cache fill percentage (0-100).",
      "core-idle differs from pause: it also triggers when paused due to cache.",
      "Do not treat buffering as a user pause (PRD FR-11).",
      "Suppress non-user sync actions while buffering (PRD FR-11).",
      "Do not correct drift while buffering (PRD FR-8).",
      "Show peer-buffering warning if one peer buffers and the other does not.",
    ],
  },

  fileLoad: {
    description: "Detect file load/change for room lifecycle management",
    iinaEvents: ["iina.file-loaded", "iina.file-started"],
    mpvEvents: ["start-file", "file-loaded", "end-file"],
    mpvProperties: ["idle-active"],
    coreAPIs: [],
    statusAPIs: ["url", "title", "duration", "idle"],
    notes: [
      "iina.file-loaded fires when a new file is loaded; callback receives the URL.",
      "iina.file-started fires when a new file has started playing (no data).",
      "mpv.start-file fires right before a new file loads.",
      "mpv.file-loaded fires after a file was loaded and playback begins.",
      "mpv.end-file fires after a file was unloaded (has reason field).",
      "If a new file loads mid-session, auto-leave the room (PRD FR-11).",
      "Use iina.file-loaded for detecting mid-session file changes.",
      "Read core.status.url, title, duration for file metadata exchange.",
    ],
  },

  lifecycle: {
    description: "Window and plugin lifecycle events for setup and cleanup",
    iinaEvents: [
      "iina.window-loaded",
      "iina.window-will-close",
      "iina.window-did-close",
      "iina.plugin-overlay-loaded",
      "iina.mpv-inititalized",
    ],
    mpvEvents: ["shutdown"],
    mpvProperties: [],
    coreAPIs: [],
    statusAPIs: [],
    notes: [
      "iina.window-loaded: required before displaying OSDs and overlays.",
      "iina.plugin-overlay-loaded: required before overlay postMessage works.",
      "iina.window-will-close: trigger graceful disconnect and cleanup.",
      "iina.mpv-inititalized: note the typo is in the official API.",
      "mpv.shutdown: player quitting, ensure final cleanup.",
    ],
  },

  speed: {
    description: "Detect and apply playback speed changes",
    iinaEvents: [],
    mpvEvents: [],
    mpvProperties: ["speed"],
    coreAPIs: ["setSpeed"],
    statusAPIs: ["speed"],
    notes: [
      "Use mpv.speed.changed to detect user-initiated speed changes.",
      "Use core.setSpeed(speed) to apply remote speed commands.",
      "Include speed in heartbeats so drift logic can reason correctly (PRD FR-9).",
      "Apply speed sync before drift correction seeks when mismatch exists.",
    ],
  },
};

// ---------------------------------------------------------------------------
// 1. IINA typed event inventory
// ---------------------------------------------------------------------------
describe("IINA typed event inventory", () => {
  test("all expected IINA events are catalogued", () => {
    expect(IINA_TYPED_EVENTS.length).toBe(14);
  });

  test("iina.file-loaded provides url callback for file metadata", () => {
    // iina.file-loaded callback signature: (url: string) => void
    // This is critical for detecting mid-session file changes
    const fileLoadedEvent = IINA_TYPED_EVENTS.find(
      (e) => e === "iina.file-loaded",
    );
    expect(fileLoadedEvent).toBeDefined();
  });

  test("iina.file-started exists as separate event from file-loaded", () => {
    const fileStartedEvent = IINA_TYPED_EVENTS.find(
      (e) => e === "iina.file-started",
    );
    expect(fileStartedEvent).toBeDefined();
    // file-loaded fires when file is loaded (with url), file-started fires
    // when playback actually begins (no data). Both are needed.
  });

  test("iina.mpv-inititalized has the official typo", () => {
    // The typo ("inititalized" not "initialized") is in the official type
    // definitions. Our code must use the typo to match the runtime.
    const mpvInitEvent = IINA_TYPED_EVENTS.find(
      (e) => e === "iina.mpv-inititalized",
    );
    expect(mpvInitEvent).toBeDefined();
    expect(IINA_TYPED_EVENTS).not.toContain("iina.mpv-initialized");
  });

  test("lifecycle events for window setup and teardown exist", () => {
    expect(IINA_TYPED_EVENTS).toContain("iina.window-loaded");
    expect(IINA_TYPED_EVENTS).toContain("iina.window-will-close");
    expect(IINA_TYPED_EVENTS).toContain("iina.window-did-close");
    expect(IINA_TYPED_EVENTS).toContain("iina.plugin-overlay-loaded");
  });
});

// ---------------------------------------------------------------------------
// 2. mpv event inventory
// ---------------------------------------------------------------------------
describe("mpv event inventory", () => {
  test("seek event exists and is distinct from playback-restart", () => {
    expect(MPV_EVENTS).toContain("seek");
    expect(MPV_EVENTS).toContain("playback-restart");
    // seek fires when seeking begins; playback-restart fires when seek
    // completes and playback resumes. Both are needed for echo suppression.
  });

  test("file lifecycle events exist", () => {
    expect(MPV_EVENTS).toContain("start-file");
    expect(MPV_EVENTS).toContain("file-loaded");
    expect(MPV_EVENTS).toContain("end-file");
  });

  test("shutdown event exists for cleanup", () => {
    expect(MPV_EVENTS).toContain("shutdown");
  });
});

// ---------------------------------------------------------------------------
// 3. mpv observable properties for sync concerns
// ---------------------------------------------------------------------------
describe("mpv observable properties", () => {
  test("pause property is read-write flag", () => {
    const prop = MPV_OBSERVABLE_PROPERTIES["pause"];
    expect(prop.type).toBe("flag");
    expect(prop.rw).toBe(true);
  });

  test("seeking property is read-only flag", () => {
    const prop = MPV_OBSERVABLE_PROPERTIES["seeking"];
    expect(prop.type).toBe("flag");
    expect(prop.rw).toBe(false);
  });

  test("paused-for-cache property exists for buffering detection", () => {
    const prop = MPV_OBSERVABLE_PROPERTIES["paused-for-cache"];
    expect(prop.type).toBe("flag");
    expect(prop.rw).toBe(false);
  });

  test("cache-buffering-state property exists for buffering progress", () => {
    const prop = MPV_OBSERVABLE_PROPERTIES["cache-buffering-state"];
    expect(prop.type).toBe("number");
  });

  test("core-idle differs from pause (triggers during buffering)", () => {
    const coreIdle = MPV_OBSERVABLE_PROPERTIES["core-idle"];
    const pause = MPV_OBSERVABLE_PROPERTIES["pause"];
    expect(coreIdle.type).toBe("flag");
    expect(pause.type).toBe("flag");
    // core-idle can be true when pause is false (e.g. during cache wait)
  });

  test("time-pos is available but must not be used as seek detector", () => {
    const prop = MPV_OBSERVABLE_PROPERTIES["time-pos"];
    expect(prop.type).toBe("number");
    expect(prop.rw).toBe(true);
    // PRD FR-6: Do NOT use mpv.time-pos.changed as a seek detector.
    // Use mpv.seek event + mpv.seeking.changed instead.
  });

  test("speed property is read-write for sync", () => {
    const prop = MPV_OBSERVABLE_PROPERTIES["speed"];
    expect(prop.type).toBe("number");
    expect(prop.rw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. IINA Core API methods for applying remote commands
// ---------------------------------------------------------------------------
describe("IINA Core API for remote command application", () => {
  test("pause and resume are separate methods", () => {
    expect(IINA_CORE_METHODS.pause).toBeDefined();
    expect(IINA_CORE_METHODS.resume).toBeDefined();
    // IINA uses pause()/resume() not a toggle — important for deterministic
    // remote command application
  });

  test("seekTo is absolute seek without exact flag", () => {
    expect(IINA_CORE_METHODS.seekTo.signature).toContain("seconds: number");
    expect(IINA_CORE_METHODS.seekTo.signature).not.toContain("exact");
    // seekTo always seeks exactly; core.seek(seconds, exact) is relative
  });

  test("seek is relative seek with exact flag", () => {
    expect(IINA_CORE_METHODS.seek.signature).toContain("exact: boolean");
  });

  test("setSpeed exists for speed sync", () => {
    expect(IINA_CORE_METHODS.setSpeed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. IINA StatusAPI for reading current state
// ---------------------------------------------------------------------------
describe("IINA StatusAPI for state reads", () => {
  test("all needed status properties exist", () => {
    const needed = [
      "paused",
      "idle",
      "position",
      "duration",
      "speed",
      "url",
      "title",
    ];
    for (const key of needed) {
      expect(IINA_STATUS_PROPERTIES).toHaveProperty(key);
    }
  });

  test("isNetworkResource exists for file metadata heuristic", () => {
    expect(IINA_STATUS_PROPERTIES.isNetworkResource).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Watch-party event mapping completeness
// ---------------------------------------------------------------------------
describe("watch-party event mapping", () => {
  const concerns = ["pause", "seek", "buffering", "fileLoad", "lifecycle", "speed"];

  test("all sync concerns are mapped", () => {
    for (const concern of concerns) {
      expect(WATCH_PARTY_EVENT_MAP[concern]).toBeDefined();
    }
  });

  test("every referenced IINA event exists in the typed inventory", () => {
    for (const concern of concerns) {
      const mapping = WATCH_PARTY_EVENT_MAP[concern];
      for (const evt of mapping.iinaEvents) {
        expect(IINA_TYPED_EVENTS).toContain(evt);
      }
    }
  });

  test("every referenced mpv event exists in the event inventory", () => {
    for (const concern of concerns) {
      const mapping = WATCH_PARTY_EVENT_MAP[concern];
      for (const evt of mapping.mpvEvents) {
        expect(MPV_EVENTS).toContain(evt);
      }
    }
  });

  test("every referenced mpv property exists in the property inventory", () => {
    for (const concern of concerns) {
      const mapping = WATCH_PARTY_EVENT_MAP[concern];
      for (const prop of mapping.mpvProperties) {
        expect(MPV_OBSERVABLE_PROPERTIES).toHaveProperty(prop);
      }
    }
  });

  test("every referenced Core API exists in the method inventory", () => {
    for (const concern of concerns) {
      const mapping = WATCH_PARTY_EVENT_MAP[concern];
      for (const api of mapping.coreAPIs) {
        expect(IINA_CORE_METHODS).toHaveProperty(api);
      }
    }
  });

  test("every referenced StatusAPI exists in the status inventory", () => {
    for (const concern of concerns) {
      const mapping = WATCH_PARTY_EVENT_MAP[concern];
      for (const api of mapping.statusAPIs) {
        expect(IINA_STATUS_PROPERTIES).toHaveProperty(api);
      }
    }
  });

  test("mpv.time-pos.changed is NOT used as seek detector", () => {
    const seekMapping = WATCH_PARTY_EVENT_MAP["seek"];
    expect(seekMapping.mpvProperties).not.toContain("time-pos");
    // time-pos is used in heartbeats for drift detection, but
    // NOT as a seek event source (PRD FR-6)
  });

  test("pause mapping does not use core-idle (avoids buffering false positives)", () => {
    const pauseMapping = WATCH_PARTY_EVENT_MAP["pause"];
    expect(pauseMapping.mpvProperties).not.toContain("core-idle");
    // core-idle triggers during buffering which is not a user pause
  });

  test("buffering mapping includes core-idle for distinguishing from pause", () => {
    const bufferingMapping = WATCH_PARTY_EVENT_MAP["buffering"];
    expect(bufferingMapping.mpvProperties).toContain("core-idle");
    expect(bufferingMapping.mpvProperties).toContain("paused-for-cache");
  });
});

// ---------------------------------------------------------------------------
// 7. Event listener patterns (document how events will be registered)
// ---------------------------------------------------------------------------
describe("event listener patterns", () => {
  test("IINA events use event.on('iina.NAME', callback) pattern", () => {
    // All iina events use the `iina.` prefix
    for (const evt of IINA_TYPED_EVENTS) {
      expect(evt.startsWith("iina.")).toBe(true);
    }
  });

  test("mpv events use event.on('mpv.NAME', callback) pattern", () => {
    // mpv events are accessed via the generic `mpv.${string}` overload
    // Example: event.on("mpv.seek", callback)
    for (const evt of MPV_EVENTS) {
      expect(evt).not.toContain("mpv."); // raw event names have no prefix
      // Plugin code prepends "mpv." when registering: event.on(`mpv.${evt}`, cb)
    }
  });

  test("mpv property observers use event.on('mpv.PROP.changed', callback) pattern", () => {
    // Example: event.on("mpv.pause.changed", callback)
    // Then read value with mpv.getFlag("pause") or mpv.getNumber("time-pos")
    for (const prop of Object.keys(MPV_OBSERVABLE_PROPERTIES)) {
      const eventName = `mpv.${prop}.changed`;
      expect(eventName).toMatch(/^mpv\..+\.changed$/);
    }
  });

  test("mpv property reads use typed accessors", () => {
    // mpv.getFlag(name) for boolean properties
    // mpv.getNumber(name) for numeric properties
    // mpv.getString(name) for string properties
    const flagProps = Object.entries(MPV_OBSERVABLE_PROPERTIES)
      .filter(([, v]) => v.type === "flag")
      .map(([k]) => k);
    const numberProps = Object.entries(MPV_OBSERVABLE_PROPERTIES)
      .filter(([, v]) => v.type === "number")
      .map(([k]) => k);
    const stringProps = Object.entries(MPV_OBSERVABLE_PROPERTIES)
      .filter(([, v]) => v.type === "string")
      .map(([k]) => k);

    expect(flagProps).toContain("pause");
    expect(flagProps).toContain("seeking");
    expect(flagProps).toContain("paused-for-cache");
    expect(numberProps).toContain("time-pos");
    expect(numberProps).toContain("speed");
    expect(numberProps).toContain("duration");
    expect(stringProps).toContain("filename");
    expect(stringProps).toContain("path");
  });
});
