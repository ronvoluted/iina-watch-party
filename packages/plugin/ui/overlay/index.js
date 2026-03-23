/**
 * Overlay webview — WebSocket transport bridge.
 * Owns the outbound browser WebSocket connection to the backend.
 * Communicates with the plugin main entry via postMessage/onMessage.
 */

iina.onMessage("ws-connect", (data) => {
  iina.postMessage("ws-open", { status: "stub" });
});
