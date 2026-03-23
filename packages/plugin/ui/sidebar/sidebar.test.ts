import { describe, test, expect, beforeEach, jest } from "bun:test";

// ── Mock infrastructure ──────────────────────────────────────────────

type MessageHandler = (data: unknown) => void;

/** Captured iina.onMessage handlers keyed by message name. */
let handlers: Record<string, MessageHandler>;

/** Messages posted via iina.postMessage. */
let posted: Array<{ name: string; data: unknown }>;

/** Minimal mock DOM for sidebar elements. */
interface MockElement {
  id: string;
  textContent: string;
  value: string;
  classList: {
    _classes: Set<string>;
    add(cls: string): void;
    remove(cls: string): void;
    toggle(cls: string, force?: boolean): void;
    contains(cls: string): boolean;
  };
  _listeners: Record<string, Array<(ev: unknown) => void>>;
  addEventListener(event: string, fn: (ev: unknown) => void): void;
}

function makeMockElement(id: string, initialClasses: string[] = []): MockElement {
  const classes = new Set<string>(initialClasses);
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  return {
    id,
    textContent: "",
    value: "",
    classList: {
      _classes: classes,
      add(cls: string) { classes.add(cls); },
      remove(cls: string) { classes.delete(cls); },
      toggle(cls: string, force?: boolean) {
        if (force === undefined) {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
        } else if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
      },
      contains(cls: string) { return classes.has(cls); },
    },
    _listeners: listeners,
    addEventListener(event: string, fn: (ev: unknown) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
  };
}

/** All mock elements keyed by id. */
let elements: Record<string, MockElement>;

function setupGlobals() {
  handlers = {};
  posted = [];

  // Create mock DOM elements for all sidebar IDs
  const elementIds = [
    "view-idle", "view-connecting", "view-connected", "view-error",
    "idle-status", "invite-input", "connecting-text",
    "connected-status", "room-code", "invite-display", "invite-section",
    "peer-dot", "peer-name", "warning-section", "warning-text",
    "error-text",
    "btn-create", "btn-join", "btn-copy-invite", "btn-leave", "btn-back",
  ];

  elements = {};
  for (const id of elementIds) {
    const initialClasses = id.startsWith("view-") && id !== "view-idle" ? ["hidden"] : [];
    elements[id] = makeMockElement(id, initialClasses);
  }

  (globalThis as any).document = {
    getElementById(id: string) {
      return elements[id] || makeMockElement(id);
    },
  };

  (globalThis as any).iina = {
    onMessage(name: string, cb: MessageHandler) {
      handlers[name] = cb;
    },
    postMessage(name: string, data: unknown) {
      posted.push({ name, data });
    },
  };
}

function loadSidebar() {
  const path = require.resolve("./index.js");
  delete require.cache[path];
  require(path);
  posted = []; // Clear load-time messages
}

function send(name: string, data?: unknown) {
  handlers[name]?.(data);
}

function findPosted(name: string) {
  return posted.filter((m) => m.name === name);
}

function lastPosted(name: string) {
  const msgs = findPosted(name);
  return msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
}

function clickButton(id: string) {
  const el = elements[id];
  if (el && el._listeners["click"]) {
    for (const fn of el._listeners["click"]) fn({});
  }
}

function isViewVisible(viewId: string): boolean {
  return !elements[viewId].classList.contains("hidden");
}

// ── Tests ────────────────────────────────────────────────────────────

describe("sidebar shell", () => {
  beforeEach(() => {
    setupGlobals();
    loadSidebar();
  });

  describe("initialization", () => {
    test("registers all expected message handlers", () => {
      expect(handlers["sb-state"]).toBeDefined();
      expect(handlers["sb-room"]).toBeDefined();
      expect(handlers["sb-peer"]).toBeDefined();
      expect(handlers["sb-warning"]).toBeDefined();
      expect(handlers["sb-error"]).toBeDefined();
      expect(handlers["sb-status"]).toBeDefined();
      expect(handlers["sb-connecting-text"]).toBeDefined();
    });

    test("idle view is visible by default", () => {
      expect(isViewVisible("view-idle")).toBe(true);
      expect(isViewVisible("view-connecting")).toBe(false);
      expect(isViewVisible("view-connected")).toBe(false);
      expect(isViewVisible("view-error")).toBe(false);
    });
  });

  describe("view switching via sb-state", () => {
    test("switches to connecting view", () => {
      send("sb-state", { view: "connecting" });
      expect(isViewVisible("view-connecting")).toBe(true);
      expect(isViewVisible("view-idle")).toBe(false);
    });

    test("switches to connected view", () => {
      send("sb-state", { view: "connected" });
      expect(isViewVisible("view-connected")).toBe(true);
      expect(isViewVisible("view-idle")).toBe(false);
    });

    test("switches to error view", () => {
      send("sb-state", { view: "error" });
      expect(isViewVisible("view-error")).toBe(true);
      expect(isViewVisible("view-idle")).toBe(false);
    });

    test("switches back to idle view", () => {
      send("sb-state", { view: "connected" });
      send("sb-state", { view: "idle" });
      expect(isViewVisible("view-idle")).toBe(true);
      expect(isViewVisible("view-connected")).toBe(false);
    });

    test("ignores invalid view name", () => {
      send("sb-state", { view: "nonexistent" });
      // Should remain on idle (no crash)
      expect(isViewVisible("view-idle")).toBe(true);
    });

    test("ignores null data", () => {
      send("sb-state", null);
      expect(isViewVisible("view-idle")).toBe(true);
    });
  });

  describe("button actions", () => {
    test("Create Room posts create-room message", () => {
      clickButton("btn-create");
      const msg = lastPosted("create-room");
      expect(msg).toBeDefined();
    });

    test("Join Room posts join-room with invite string", () => {
      elements["invite-input"].value = "ABC123:secretdata";
      clickButton("btn-join");
      const msg = lastPosted("join-room");
      expect(msg).toBeDefined();
      expect((msg!.data as any).invite).toBe("ABC123:secretdata");
    });

    test("Join Room does not post when invite is empty", () => {
      elements["invite-input"].value = "";
      clickButton("btn-join");
      expect(findPosted("join-room")).toEqual([]);
    });

    test("Join Room trims whitespace from invite", () => {
      elements["invite-input"].value = "  ABC123:secret  ";
      clickButton("btn-join");
      const msg = lastPosted("join-room");
      expect((msg!.data as any).invite).toBe("ABC123:secret");
    });

    test("Enter key in invite input triggers join", () => {
      elements["invite-input"].value = "XYZ789:token";
      const keydownListeners = elements["invite-input"]._listeners["keydown"] || [];
      for (const fn of keydownListeners) {
        fn({ key: "Enter" });
      }
      const msg = lastPosted("join-room");
      expect(msg).toBeDefined();
      expect((msg!.data as any).invite).toBe("XYZ789:token");
    });

    test("Copy Invite posts copy-invite message", () => {
      clickButton("btn-copy-invite");
      const msg = lastPosted("copy-invite");
      expect(msg).toBeDefined();
    });

    test("Leave posts leave-room message", () => {
      clickButton("btn-leave");
      const msg = lastPosted("leave-room");
      expect(msg).toBeDefined();
    });

    test("Back button returns to idle view", () => {
      send("sb-state", { view: "error" });
      expect(isViewVisible("view-error")).toBe(true);
      clickButton("btn-back");
      expect(isViewVisible("view-idle")).toBe(true);
    });
  });

  describe("sb-room updates", () => {
    test("sets room code text", () => {
      send("sb-room", { code: "ABC123", invite: "ABC123:secret" });
      expect(elements["room-code"].textContent).toBe("ABC123");
    });

    test("sets invite display text", () => {
      send("sb-room", { code: "ABC123", invite: "ABC123:secret" });
      expect(elements["invite-display"].textContent).toBe("ABC123:secret");
    });

    test("shows invite section when invite present", () => {
      elements["invite-section"].classList.add("hidden");
      send("sb-room", { code: "ABC123", invite: "ABC123:secret" });
      expect(elements["invite-section"].classList.contains("hidden")).toBe(false);
    });

    test("hides invite section when no invite", () => {
      send("sb-room", { code: "ABC123", invite: "" });
      expect(elements["invite-section"].classList.contains("hidden")).toBe(true);
    });

    test("ignores null data", () => {
      send("sb-room", null);
      // No crash
    });
  });

  describe("sb-peer updates", () => {
    test("shows peer as connected", () => {
      send("sb-peer", { present: true, name: "Alice" });
      expect(elements["peer-name"].textContent).toBe("Alice");
      expect(elements["peer-dot"].classList.contains("offline")).toBe(false);
    });

    test("shows peer as disconnected", () => {
      send("sb-peer", { present: false });
      expect(elements["peer-name"].textContent).toContain("Waiting");
      expect(elements["peer-dot"].classList.contains("offline")).toBe(true);
    });

    test("uses default name when peer present without name", () => {
      send("sb-peer", { present: true });
      expect(elements["peer-name"].textContent).toBe("Peer connected");
    });
  });

  describe("sb-warning updates", () => {
    test("shows warning text", () => {
      send("sb-warning", { text: "File mismatch detected" });
      expect(elements["warning-text"].textContent).toBe("File mismatch detected");
      expect(elements["warning-section"].classList.contains("hidden")).toBe(false);
    });

    test("clears warning on null", () => {
      send("sb-warning", { text: "Some warning" });
      send("sb-warning", null);
      expect(elements["warning-section"].classList.contains("hidden")).toBe(true);
    });

    test("clears warning on empty text", () => {
      send("sb-warning", { text: "Some warning" });
      send("sb-warning", {});
      expect(elements["warning-section"].classList.contains("hidden")).toBe(true);
    });
  });

  describe("sb-error", () => {
    test("switches to error view with message", () => {
      send("sb-error", { text: "Connection failed" });
      expect(isViewVisible("view-error")).toBe(true);
      expect(elements["error-text"].textContent).toBe("Connection failed");
    });

    test("ignores missing text", () => {
      send("sb-error", {});
      // Should remain on current view
      expect(isViewVisible("view-idle")).toBe(true);
    });
  });

  describe("sb-status updates", () => {
    test("updates idle status text when in idle view", () => {
      send("sb-status", { text: "Reconnecting…" });
      expect(elements["idle-status"].textContent).toBe("Reconnecting…");
    });

    test("updates connected status text when in connected view", () => {
      send("sb-state", { view: "connected" });
      send("sb-status", { text: "Synced" });
      expect(elements["connected-status"].textContent).toBe("Synced");
    });
  });

  describe("sb-connecting-text", () => {
    test("updates connecting text", () => {
      send("sb-connecting-text", { text: "Joining room…" });
      expect(elements["connecting-text"].textContent).toBe("Joining room…");
    });
  });
});
