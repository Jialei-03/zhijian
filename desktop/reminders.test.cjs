// Execute only IPC registration, with all desktop effects stubbed out.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("reminder IPC checks sender, deduplicates, retries failure and opens activity", () => {
  const handlers = new Map();
  const notifications = [];
  const loads = [];
  class Notification {
    static isSupported() {
      return true;
    }
    constructor(value) {
      this.value = value;
      this.events = new Map();
      notifications.push(this);
    }
    on(name, handler) {
      this.events.set(name, handler);
    }
    show() {}
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      on() {},
      whenReady: () => ({ then() {} }),
    },
    Notification,
    ipcMain: { on: (name, handler) => handlers.set(name, handler) },
  };
  const context = vm.createContext({
    __dirname,
    process: { env: {}, on() {} },
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "node:path") return path;
      if (name === "node:os")
        return { homedir: () => "/tmp/ora-notification-test" };
      return {};
    },
    testWindow: {
      webContents: { id: 1 },
      isMinimized: () => false,
      focus() {},
      loadURL: (value) => loads.push(value),
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "main.js"), "utf8"),
    context,
  );
  vm.runInContext(
    'window = testWindow; url = "http://127.0.0.1:8765/";',
    context,
  );
  const notify = handlers.get("team-reminder");
  const event = {
    sender: context.testWindow.webContents,
    senderFrame: { url: "http://127.0.0.1:8765/" },
  };
  const reminder = {
    id: "reminder",
    title: "提醒我",
    body: "Original excerpt",
    hash: "team/workspace/mentions",
  };
  notify({ ...event, sender: {} }, reminder);
  notify(
    { ...event, senderFrame: { url: "https://example.invalid/" } },
    reminder,
  );
  notify(event, { ...reminder, hash: "https://example.invalid" });
  assert.equal(notifications.length, 0);
  notify(event, reminder);
  notify(event, reminder);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].value.title, reminder.title);
  assert.equal(notifications[0].value.body, reminder.body);
  notifications[0].events.get("close")();
  notify(event, reminder);
  assert.equal(notifications.length, 1);
  notifications[0].events.get("click")();
  assert.deepEqual(loads, ["http://127.0.0.1:8765/#team/workspace/mentions"]);
  notifications[0].events.get("failed")();
  notify(event, reminder);
  assert.equal(notifications.length, 2);
});
