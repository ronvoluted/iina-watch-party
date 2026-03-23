/**
 * Sidebar webview — room management UI.
 * Communicates with the plugin main entry via postMessage/onMessage.
 */

document.getElementById("btn-create").addEventListener("click", () => {
  iina.postMessage("create-room", {});
});

document.getElementById("btn-join").addEventListener("click", () => {
  iina.postMessage("join-room", {});
});
