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
