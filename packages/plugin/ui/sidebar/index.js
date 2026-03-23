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
  var invite = inviteInput.value.trim().toUpperCase();
  if (!invite) return;
  inviteInput.value = invite;
  iina.postMessage("join-room", { invite: invite });
});

inviteInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    var invite = inviteInput.value.trim().toUpperCase();
    if (!invite) return;
    inviteInput.value = invite;
    iina.postMessage("join-room", { invite: invite });
  }
});

// Filter out non-alphanumeric characters from room code input
inviteInput.addEventListener("input", function () {
  var pos = inviteInput.selectionStart;
  var before = inviteInput.value;
  var filtered = before.replace(/[^A-Za-z0-9]/g, "");
  if (filtered !== before) {
    inviteInput.value = filtered;
    inviteInput.selectionStart = inviteInput.selectionEnd = pos - (before.length - filtered.length);
  }
});

document.getElementById("btn-cancel").addEventListener("click", function () {
  iina.postMessage("leave-room", {});
});

document.getElementById("btn-copy-invite").addEventListener("click", function () {
  iina.postMessage("copy-invite", {});
});

document.getElementById("btn-leave").addEventListener("click", function () {
  // Pre-fill the room code input so the user can quickly rejoin
  var code = roomCode.textContent;
  if (code) inviteInput.value = code;
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
  if (data.text.indexOf("<") !== -1) {
    warningText.innerHTML = data.text;
  } else {
    warningText.textContent = data.text;
  }
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

iina.onMessage("sb-copy-text", function (data) {
  if (data && data.text && navigator.clipboard) {
    navigator.clipboard.writeText(data.text).catch(function () {});
  }
});

// ── WebSocket transport bridge ───────────────────────────────────────
// Originally in the overlay webview, but IINA's overlay does not reliably
// execute JS or relay postMessage back to the plugin main entry.
// The sidebar webview is the only webview with a working bidirectional
// message channel, so the transport bridge lives here.

/** @type {WebSocket | null} */
var socket = null;
/** @type {string | null} */
var wsConnectUrl = null;
/** @type {string[] | null} */
var wsConnectProtocols = null;
var wsIntentionalClose = false;
var wsReconnectAttempt = 0;
var wsReconnectTimer = null;
var WS_MAX_RECONNECT_DELAY = 30000;
var WS_BASE_DELAY = 1000;
var WS_MAX_ATTEMPTS = 10;

function wsReconnectDelay(attempt) {
  var exp = Math.min(WS_BASE_DELAY * Math.pow(2, attempt), WS_MAX_RECONNECT_DELAY);
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

function wsDestroySocket() {
  if (wsReconnectTimer !== null) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (socket) {
    socket.onopen = null; socket.onmessage = null;
    socket.onerror = null; socket.onclose = null;
    try { socket.close(); } catch (_) {}
    socket = null;
  }
}

function wsOpenSocket(url, protocols) {
  wsDestroySocket();
  wsIntentionalClose = false;
  wsConnectUrl = url;
  wsConnectProtocols = protocols || null;
  socket = (protocols && protocols.length > 0) ? new WebSocket(url, protocols) : new WebSocket(url);
  socket.onopen = function () {
    wsReconnectAttempt = 0;
    iina.postMessage("ws-open", {});
  };
  socket.onmessage = function (event) {
    iina.postMessage("ws-message", { data: event.data });
  };
  socket.onerror = function () {
    iina.postMessage("ws-error", {});
  };
  socket.onclose = function (event) {
    socket = null;
    iina.postMessage("ws-closed", { code: event.code, reason: event.reason });
    if (!wsIntentionalClose && wsConnectUrl) { wsScheduleReconnect(); }
  };
}

function wsScheduleReconnect() {
  if (wsReconnectAttempt >= WS_MAX_ATTEMPTS) {
    iina.postMessage("ws-reconnect-failed", { attempts: wsReconnectAttempt });
    wsConnectUrl = null; wsConnectProtocols = null; wsReconnectAttempt = 0;
    return;
  }
  var delay = wsReconnectDelay(wsReconnectAttempt);
  wsReconnectAttempt++;
  iina.postMessage("ws-reconnecting", { attempt: wsReconnectAttempt, delayMs: delay });
  wsReconnectTimer = setTimeout(function () {
    wsReconnectTimer = null;
    if (wsConnectUrl) { wsOpenSocket(wsConnectUrl, wsConnectProtocols || undefined); }
  }, delay);
}

iina.onMessage("ws-connect", function (data) {
  if (!data || !data.url) { iina.postMessage("ws-error", { message: "ws-connect requires a url" }); return; }
  wsOpenSocket(data.url, data.protocols);
});

iina.onMessage("ws-disconnect", function () {
  wsIntentionalClose = true;
  wsConnectUrl = null; wsConnectProtocols = null; wsReconnectAttempt = 0;
  wsDestroySocket();
});

iina.onMessage("ws-send", function (data) {
  if (socket && socket.readyState === WebSocket.OPEN) { socket.send(data.data); }
});

// ── HTTP fetch bridge ────────────────────────────────────────────────
// The sidebar webview has browser fetch(); the plugin main entry does not.

iina.onMessage("sb-fetch", function (data) {
  if (!data || !data.url) {
    iina.postMessage("sb-fetch-response", { ok: false, error: "sb-fetch requires a url" });
    return;
  }
  var opts = { method: data.method || "GET" };
  if (data.headers) opts.headers = data.headers;
  if (data.body) opts.body = typeof data.body === "string" ? data.body : JSON.stringify(data.body);

  fetch(data.url, opts)
    .then(function (res) {
      return res.json().then(function (body) {
        iina.postMessage("sb-fetch-response", { ok: res.ok, status: res.status, body: body });
      });
    })
    .catch(function (err) {
      iina.postMessage("sb-fetch-response", { ok: false, error: err.message || "Network error" });
    });
});
