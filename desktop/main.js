// Open Research Agent as a desktop app: the local build (backend/local) runs in
// the background and its pages show in this window. The interface is the same
// one the browser and the hosted site show; only the frame is the app's.
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  ipcMain,
  dialog,
  shell,
  net,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const netSocket = require("node:net");

const REPO = "Jialei-03/open-research-agent";
const PREFERRED_PORT = 8765;
const STOP_SECONDS = 8;

// From the source tree (`make desktop-dev`): the checkout's .venv and runtime.
// Packaged: the Python and the runtime inside the app's Resources.
const root = path.resolve(__dirname, "..");
const resources = app.isPackaged ? process.resourcesPath : null;
const python = resources
  ? path.join(resources, "python", "bin", "python3")
  : path.join(root, ".venv", "bin", "python");
const runtime = resources
  ? path.join(resources, "agent-runtime")
  : path.join(root, "agent-runtime");

const dataDir = process.env.OPR_HOME
  ? path.resolve(process.env.OPR_HOME.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), ".open-paper-reader");
const logFile = path.join(dataDir, "desktop.log");

let backend = null;
let url = null;
// Another instance (`ora` in a terminal) serves the data folder: ours left.
let shared = false;
let window = null;
let quitting = false;
let update = null;

const reminded = new Map();
ipcMain.on("team-reminder", (event, value) => {
  if (
    event.sender !== window?.webContents ||
    !ours(event.senderFrame?.url || "") ||
    !Notification.isSupported()
  )
    return;
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.hash !== "string" ||
    !/^team\/[\w-]+\/mentions$/.test(value.hash) ||
    reminded.has(value.id)
  )
    return;
  const notification = new Notification({
    title: value.title,
    body: value.body,
  });
  reminded.set(value.id, notification);
  notification.on("click", () => {
    show();
    if (url) window?.loadURL(`${url.split("#")[0]}#${value.hash}`);
  });
  notification.on("failed", () => reminded.delete(value.id));
  notification.on("close", () => reminded.set(value.id, null));
  notification.show();
});

function log(text) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(logFile, text.endsWith("\n") ? text : text + "\n");
}

// One app at a time: a second launch brings the first window forward.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => show());

function freePort(preferred) {
  return new Promise((resolve) => {
    const server = netSocket.createServer();
    server.once("error", () => {
      const any = netSocket.createServer();
      any.listen(0, "127.0.0.1", () => {
        const { port } = any.address();
        any.close(() => resolve(port));
      });
    });
    server.listen(preferred, "127.0.0.1", () =>
      server.close(() => resolve(preferred)),
    );
  });
}

// A GUI app starts with a bare PATH: the tools research uses (uv, git, ssh,
// docker, a system Python) are where a terminal would find them.
function toolPath() {
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
  ];
  return [...extra, process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"].join(
    ":",
  );
}

async function startBackend() {
  const port = await freePort(PREFERRED_PORT);
  log(`--- ${new Date().toISOString()} starting on port ${port}`);
  backend = spawn(
    python,
    ["-m", "backend.local", "--desktop", "--port", String(port)],
    {
      cwd: resources ? os.homedir() : root,
      env: {
        ...process.env,
        PATH: toolPath(),
        PYTHONUNBUFFERED: "1",
        // The app's own Electron runs the assistant runtime as Node.
        AGENT_NODE: process.execPath,
        ELECTRON_RUN_AS_NODE: "1",
        AGENT_RUNTIME_DIR: runtime,
        // The git the app carries, for the projects' repositories.
        ...(resources ? { ORA_GIT_DIR: path.join(resources, "git") } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const child = backend;
  return new Promise((resolve, reject) => {
    let said = "";
    const read = (chunk) => {
      const text = chunk.toString();
      log(text);
      said = (said + text).slice(-4000);
      const ready = text.match(/^ORA_(READY|SHARED) (\S+)/m);
      if (ready) {
        shared = ready[1] === "SHARED";
        resolve(ready[2]);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      log(`backend exited with ${code}`);
      if (backend === child) backend = null;
      if (shared) return;
      if (!url) reject(new Error(said.trim().split("\n").slice(-6).join("\n")));
      else if (!quitting) stopped();
    });
  });
}

function stopBackend() {
  const child = backend;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), STOP_SECONDS * 1000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function page(title, body) {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font:15px -apple-system,system-ui,sans-serif;color:#1c1917;background:#f7f6f2;-webkit-app-region:drag}
a{-webkit-app-region:no-drag}
@media (prefers-color-scheme:dark){body{color:#e7e5e4;background:#1c1b1a}}
main{max-width:520px;padding:32px;text-align:center}pre{text-align:left;white-space:pre-wrap;font-size:12px;opacity:.75}
a{color:inherit}</style><main>${body}</main>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function createWindow() {
  const saved = readState();
  window = new BrowserWindow({
    width: saved.width || 1440,
    height: saved.height || 920,
    x: saved.x,
    y: saved.y,
    minWidth: 900,
    minHeight: 600,
    title: "Open Research Agent",
    backgroundColor: "#f7f6f2",
    show: false,
    // No title bar: the page reaches the top and the window buttons sit in
    // its top strip (frontend/src/desktop.css keeps 32px for them).
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 10 },
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  if (saved.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());
  window.on("close", () => writeState(window));
  window.on("closed", () => {
    window = null;
  });
  guard(window.webContents);
  window.loadURL(
    url || page("Open Research Agent", "<p>正在启动 Open Research Agent…</p>"),
  );
}

function show() {
  if (!window) createWindow();
  else {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
}

// Pages of the app stay in the app; anything else opens in the browser.
function ours(target) {
  return url && target.startsWith(url);
}

function guard(contents) {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (ours(target)) return { action: "allow" };
    if (/^https?:|^mailto:/.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, target) => {
    if (target === "ora:restart") {
      event.preventDefault();
      restart();
    } else if (target === "ora:log") {
      event.preventDefault();
      shell.showItemInFolder(logFile);
    } else if (target === "ora:logs") {
      event.preventDefault();
      const logs = path.join(dataDir, "logs");
      fs.mkdirSync(logs, { recursive: true });
      shell.openPath(logs);
    } else if (!ours(target) && !target.startsWith("data:")) {
      event.preventDefault();
      if (/^https?:|^mailto:/.test(target)) shell.openExternal(target);
    }
  });
  contents.on("did-create-window", (child) => guard(child.webContents));
}

function failed(error) {
  const reason = String(error && error.message ? error.message : error);
  log(`failed: ${reason}`);
  if (!window) createWindow();
  window.loadURL(
    page(
      "没有启动",
      `<h2>Open Research Agent 没能启动</h2><pre>${reason.replace(/</g, "&lt;")}</pre>
<p><a href="ora:restart">再试一次</a> · <a href="ora:log">打开日志</a></p>`,
    ),
  );
}

function stopped() {
  url = null;
  if (!window) return;
  window.loadURL(
    page(
      "已停止",
      `<h2>后台服务停止了</h2><p>正在进行的研究会在重新启动后继续。</p>
<p><a href="ora:restart">重新启动</a> · <a href="ora:log">打开日志</a></p>`,
    ),
  );
}

async function restart() {
  await stopBackend();
  url = null;
  window?.loadURL(page("Open Research Agent", "<p>正在启动…</p>"));
  try {
    url = await startBackend();
    window?.loadURL(url);
  } catch (error) {
    failed(error);
  }
}

// Window size and place, kept between launches.
function stateFile() {
  return path.join(app.getPath("userData"), "window.json");
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeState(win) {
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
    );
  } catch {
    // Not kept: the next launch uses the default size.
  }
}

// Downloads ask where to save, like a browser would.
function downloads(session) {
  session.on("will-download", (_event, item, contents) => {
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
    // A window opened only to fetch a file has nothing else to show.
    const opener = BrowserWindow.fromWebContents(contents);
    if (opener && opener !== window && contents.getURL() === item.getURL())
      item.once("done", () => opener.close());
  });
}

// A newer release on GitHub: offered in the menu (an unsigned app on macOS
// cannot replace itself, so the download page opens).
async function checkForUpdate() {
  if (!app.isPackaged) return;
  try {
    const response = await net.fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
    );
    if (!response.ok) return;
    const release = await response.json();
    const latest = String(release.tag_name || "").replace(/^v/, "");
    if (latest && newer(latest, app.getVersion())) {
      update = { version: latest, page: release.html_url };
      buildMenu();
    }
  } catch {
    // Offline or rate-limited: asked again at the next launch.
  }
}
function newer(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

function buildMenu() {
  const help = [
    ...(update
      ? [
          {
            label: `下载新版本 ${update.version}`,
            click: () => shell.openExternal(update.page),
          },
          { type: "separator" },
        ]
      : []),
    {
      label: "打开数据文件夹",
      click: () => shell.openPath(dataDir),
    },
    { label: "打开日志", click: () => shell.showItemInFolder(logFile) },
    {
      label: "在浏览器中打开",
      enabled: !!url,
      click: () => url && shell.openExternal(url),
    },
    { type: "separator" },
    {
      label: "GitHub 项目主页",
      click: () => shell.openExternal(`https://github.com/${REPO}`),
    },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "重新载入" },
          { type: "separator" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
          ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
        ],
      },
      { role: "windowMenu" },
      { label: "帮助", role: "help", submenu: help },
    ]),
  );
}

app.whenReady().then(async () => {
  app.setAboutPanelOptions({
    applicationName: "Open Research Agent",
    applicationVersion: app.getVersion(),
    website: `https://github.com/${REPO}`,
  });
  buildMenu();
  downloads(require("electron").session.defaultSession);
  createWindow();
  try {
    url = await startBackend();
    buildMenu();
    window?.loadURL(url);
  } catch (error) {
    failed(error);
  }
  checkForUpdate();
});

// Closing the window keeps the research going; the Dock icon brings it back.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => show());

// Quitting stops the backend and its workers first.
app.on("before-quit", (event) => {
  if (quitting || !backend) return;
  event.preventDefault();
  quitting = true;
  stopBackend().then(() => app.quit());
});

process.on("uncaughtException", (error) => {
  log(`uncaught: ${error.stack || error}`);
  dialog.showErrorBox("Open Research Agent", String(error.message || error));
});
