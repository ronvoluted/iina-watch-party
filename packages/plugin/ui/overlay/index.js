/**
 * Overlay webview — WebSocket transport bridge.
 * Owns the outbound browser WebSocket connection to the backend.
 * Communicates with the plugin main entry via postMessage/onMessage.
 *
 * This bridge is intentionally "dumb" — it knows nothing about the
 * protocol, room state, or playback logic. It only manages the
 * WebSocket lifecycle and ferries messages.
 *
 * Bridge messages (overlay ↔ main):
 *   Inbound  (main → overlay): ws-connect, ws-disconnect, ws-send
 *   Outbound (overlay → main): ws-open, ws-message, ws-closed, ws-error, ws-reconnecting
 */

/** @type {WebSocket | null} */
let socket = null;

/** @type {string | null} URL for reconnection */
let connectUrl = null;

/** @type {string[] | null} Protocols for reconnection */
let connectProtocols = null;

/** Whether the current disconnect was intentional (vs unexpected). */
let intentionalClose = false;

/** Current reconnect attempt count (reset on successful open). */
let reconnectAttempt = 0;

/** Handle for the pending reconnect timer. */
let reconnectTimer = null;

/** Maximum reconnect delay in ms. */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Base delay for exponential backoff in ms. */
const BASE_DELAY_MS = 1000;

/** Maximum number of reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Compute delay with exponential backoff and jitter.
 * @param {number} attempt
 * @returns {number}
 */
function reconnectDelay(attempt) {
  const exponential = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
  // Add ±25% jitter to avoid thundering herd
  const jitter = exponential * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/** Tear down the current socket without triggering reconnection. */
function destroySocket() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    // Remove listeners before closing to prevent onclose from triggering reconnect
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch (_) {
      // Ignore errors on already-closed sockets
    }
    socket = null;
  }
}

/**
 * Open a new WebSocket connection.
 * @param {string} url
 * @param {string[]} [protocols]
 */
function openSocket(url, protocols) {
  destroySocket();
  intentionalClose = false;
  connectUrl = url;
  connectProtocols = protocols || null;

  socket = protocols && protocols.length > 0
    ? new WebSocket(url, protocols)
    : new WebSocket(url);

  socket.onopen = function () {
    reconnectAttempt = 0;
    iina.postMessage("ws-open", {});
  };

  socket.onmessage = function (event) {
    iina.postMessage("ws-message", { data: event.data });
  };

  socket.onerror = function () {
    iina.postMessage("ws-error", {});
  };

  socket.onclose = function (event) {
    var code = event.code;
    var reason = event.reason;
    socket = null;
    iina.postMessage("ws-closed", { code: code, reason: reason });

    // Don't reconnect on server-rejected codes (auth/room errors).
    var serverRejected = code >= 4001 && code <= 4005;
    if (!intentionalClose && !serverRejected && connectUrl) {
      scheduleReconnect();
    }
  };
}

/** Schedule a reconnection attempt with exponential backoff. */
function scheduleReconnect() {
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    iina.postMessage("ws-reconnect-failed", { attempts: reconnectAttempt });
    connectUrl = null;
    connectProtocols = null;
    reconnectAttempt = 0;
    return;
  }
  var delay = reconnectDelay(reconnectAttempt);
  reconnectAttempt++;
  iina.postMessage("ws-reconnecting", { attempt: reconnectAttempt, delayMs: delay });
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (connectUrl) {
      openSocket(connectUrl, connectProtocols || undefined);
    }
  }, delay);
}

// --- Bridge message handlers ---

/**
 * ws-connect: Open a WebSocket connection.
 * Payload: { url: string, protocols?: string[] }
 */
iina.onMessage("ws-connect", function (data) {
  if (!data || !data.url) {
    iina.postMessage("ws-error", { message: "ws-connect requires a url" });
    return;
  }
  openSocket(data.url, data.protocols);
});

/**
 * ws-disconnect: Intentionally close the current connection.
 * No reconnection will be attempted.
 */
iina.onMessage("ws-disconnect", function () {
  intentionalClose = true;
  connectUrl = null;
  connectProtocols = null;
  reconnectAttempt = 0;
  destroySocket();
});

/**
 * ws-send: Send a message through the open WebSocket.
 * Payload: { data: string }
 */
iina.onMessage("ws-send", function (data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(data.data);
  }
});

// --- HTTP fetch bridge ---

/**
 * http-fetch: Make an HTTP request and return the result.
 * Payload: { url: string, method?: string, headers?: object, body?: string }
 * Response posted as http-response: { ok: boolean, status: number, body: unknown, error?: string }
 */
iina.onMessage("http-fetch", function (data) {
  if (!data || !data.url) {
    iina.postMessage("http-response", { ok: false, error: "http-fetch requires a url" });
    return;
  }

  var opts = { method: data.method || "GET" };
  if (data.headers) opts.headers = data.headers;
  if (data.body) opts.body = typeof data.body === "string" ? data.body : JSON.stringify(data.body);

  fetch(data.url, opts)
    .then(function (res) {
      return res.json().then(function (body) {
        iina.postMessage("http-response", { ok: res.ok, status: res.status, body: body });
      });
    })
    .catch(function (err) {
      iina.postMessage("http-response", { ok: false, error: err.message || "Network error" });
    });
});
