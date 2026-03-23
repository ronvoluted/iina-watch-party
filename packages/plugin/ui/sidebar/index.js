/**
 * Sidebar webview — room management UI.
 *
 * Manages four view states: idle, connecting, connected, error.
 * Communicates with the plugin main entry via postMessage/onMessage.
 *
 * Messages sent (sidebar → main):
 *   create-room        User clicked Create Room
 *   join-room          User submitted invite string  { invite: string }
 *   leave-room         User clicked Leave
 *   copy-invite        User clicked Copy Invite
 *
 * Messages received (main → sidebar):
 *   sb-state           Switch view state  { view: "idle"|"connecting"|"connected"|"error", ... }
 *   sb-room            Room info          { code: string, invite: string }
 *   sb-peer            Peer status        { present: boolean, name?: string }
 *   sb-warning         Warning message    { text: string } | null  (null clears)
 *   sb-error           Error message      { text: string }
 *   sb-status          Status text update { text: string }
 *   sb-connecting-text  Connecting text   { text: string }
 */

// ── DOM references ──────────────────────────────────────────────────

var views = {
  idle: document.getElementById("view-idle"),
  connecting: document.getElementById("view-connecting"),
  connected: document.getElementById("view-connected"),
  error: document.getElementById("view-error"),
};

var idleStatus = document.getElementById("idle-status");
var inviteInput = document.getElementById("invite-input");
var connectingText = document.getElementById("connecting-text");
var connectedStatus = document.getElementById("connected-status");
var roomCode = document.getElementById("room-code");
var inviteDisplay = document.getElementById("invite-display");
var inviteSection = document.getElementById("invite-section");
var peerDot = document.getElementById("peer-dot");
var peerName = document.getElementById("peer-name");
var warningSection = document.getElementById("warning-section");
var warningText = document.getElementById("warning-text");
var errorText = document.getElementById("error-text");

// ── State ───────────────────────────────────────────────────────────

var currentView = "idle";

// ── View switching ──────────────────────────────────────────────────

function showView(name) {
  if (!views[name]) return;
  currentView = name;
  for (var key in views) {
    if (views[key]) {
      views[key].classList.toggle("hidden", key !== name);
    }
  }
}

// ── Button handlers ─────────────────────────────────────────────────

document.getElementById("btn-create").addEventListener("click", function () {
  iina.postMessage("create-room", {});
});

document.getElementById("btn-join").addEventListener("click", function () {
  var invite = inviteInput.value.trim();
  if (!invite) return;
  iina.postMessage("join-room", { invite: invite });
});

inviteInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    var invite = inviteInput.value.trim();
    if (!invite) return;
    iina.postMessage("join-room", { invite: invite });
  }
});

document.getElementById("btn-copy-invite").addEventListener("click", function () {
  iina.postMessage("copy-invite", {});
});

document.getElementById("btn-leave").addEventListener("click", function () {
  iina.postMessage("leave-room", {});
});

document.getElementById("btn-back").addEventListener("click", function () {
  showView("idle");
});

// ── Message handlers (main → sidebar) ───────────────────────────────

iina.onMessage("sb-state", function (data) {
  if (data && data.view) {
    showView(data.view);
  }
});

iina.onMessage("sb-room", function (data) {
  if (!data) return;
  if (data.code) roomCode.textContent = data.code;
  if (data.invite) inviteDisplay.textContent = data.invite;
  if (inviteSection) {
    inviteSection.classList.toggle("hidden", !data.invite);
  }
});

iina.onMessage("sb-peer", function (data) {
  if (!data) return;
  var present = !!data.present;
  peerDot.classList.toggle("offline", !present);
  peerName.textContent = present ? (data.name || "Peer connected") : "Waiting for peer\u2026";
});

iina.onMessage("sb-warning", function (data) {
  if (!data || !data.text) {
    warningSection.classList.add("hidden");
    return;
  }
  warningText.textContent = data.text;
  warningSection.classList.remove("hidden");
});

iina.onMessage("sb-error", function (data) {
  if (data && data.text) {
    errorText.textContent = data.text;
    showView("error");
  }
});

iina.onMessage("sb-status", function (data) {
  if (!data || !data.text) return;
  if (currentView === "idle") {
    idleStatus.textContent = data.text;
  } else if (currentView === "connected") {
    connectedStatus.textContent = data.text;
  }
});

iina.onMessage("sb-connecting-text", function (data) {
  if (data && data.text) {
    connectingText.textContent = data.text;
  }
});
