"use strict";

function displayForWindow(screen, window) {
  if (window && !window.isDestroyed()) {
    return screen.getDisplayMatching(window.getBounds());
  }
  return screen.getPrimaryDisplay();
}

function sourceForDisplay(sources, display) {
  return sources.find(source => source.display_id === String(display.id)) || null;
}

module.exports = { displayForWindow, sourceForDisplay };
