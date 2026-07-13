"use strict";

function presentBarrageWindow(window, bounds) {
  if (!window || window.isDestroyed()) return false;
  if (bounds) window.setBounds(bounds, false);
  window.setAlwaysOnTop(true, "screen-saver", 1);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setIgnoreMouseEvents(true);
  window.showInactive();
  window.moveTop();
  return true;
}

module.exports = { presentBarrageWindow };
