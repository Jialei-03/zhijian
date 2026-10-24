// Marks the page as shown by the desktop app (frontend/src/desktop.css): the
// window has no title bar, so the page keeps a strip for the window buttons.
// The preload may run before the document has its root, so it marks it as
// soon as there is one.
const mark = () => {
  const root = document.documentElement;
  if (root) root.dataset.desktop = process.platform || "desktop";
  return !!root;
};
if (!mark())
  document.addEventListener("readystatechange", mark, { once: true });
window.addEventListener("DOMContentLoaded", mark);

const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("oraDesktop", {
  notifyReminder: (value) => ipcRenderer.send("team-reminder", value),
});
