/**
 * Watch Party — IINA plugin main entry point.
 *
 * Manages room state, sync logic, and communication with the overlay
 * (transport bridge) and sidebar (UI) webviews.
 */

const { overlay, sidebar, console: log } = iina;

log.log("Watch Party plugin loaded");

overlay.loadFile("ui/overlay/index.html");
sidebar.loadFile("ui/sidebar/index.html");

// ── Sidebar message handlers ────────────────────────────────────────

/**
 * Helper to transition the sidebar to a named view.
 */
function setSidebarView(view: "idle" | "connecting" | "connected" | "error") {
  sidebar.postMessage("sb-state", { view });
}

sidebar.onMessage("create-room", (_data: unknown) => {
  log.log("Sidebar: create-room requested");
  setSidebarView("connecting");
  sidebar.postMessage("sb-connecting-text", { text: "Creating room\u2026" });
});

sidebar.onMessage("join-room", (data: unknown) => {
  const d = data as { invite?: string } | null;
  const invite = d?.invite?.trim();
  if (!invite) {
    log.log("Sidebar: join-room missing invite");
    sidebar.postMessage("sb-error", { text: "Please enter an invite code." });
    return;
  }
  log.log(`Sidebar: join-room with invite length=${invite.length}`);
  setSidebarView("connecting");
  sidebar.postMessage("sb-connecting-text", { text: "Joining room\u2026" });
});

sidebar.onMessage("leave-room", (_data: unknown) => {
  log.log("Sidebar: leave-room requested");
  setSidebarView("idle");
  sidebar.postMessage("sb-status", { text: "Not connected" });
});

sidebar.onMessage("copy-invite", (_data: unknown) => {
  log.log("Sidebar: copy-invite requested");
});
