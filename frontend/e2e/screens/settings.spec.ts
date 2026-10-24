import { expect, test, type Page } from "@playwright/test";
import { createPaperWithPdf, signIn } from "../reader/fixtures";

// The settings are a window over the page, one kind of settings at a time.
const SETTINGS = (category: string) => `/#settings/${category}`;

// Not a real key: the service is never reached, its answers are mocked.
const FAKE_KEY = "sk-test-not-a-real-key";

async function headers(page: Page) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "paper_csrf",
  )!.value;
  return { "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() };
}

async function settings(page: Page) {
  const response = await page.request.get("/api/v1/translation-settings");
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function removeModels(page: Page) {
  for (const row of (await settings(page)).models)
    await page.request.delete(
      `/api/v1/translation-settings/configs/${row.id}`,
      { headers: await headers(page) },
    );
}

/** Adds a model through the dialog, its connection test answered from here. */
async function addModel(page: Page, model: string) {
  await page.getByRole("button", { name: "添加模型" }).click();
  const dialog = page.getByRole("dialog", { name: "添加模型" });
  await dialog
    .getByLabel("服务地址", { exact: true })
    .fill("https://api.openai.com/v1");
  await dialog.getByLabel("API 密钥", { exact: true }).fill(FAKE_KEY);
  await dialog.getByLabel("模型", { exact: true }).fill(model);
  await dialog.getByRole("button", { name: "测试连接" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`已添加 ${model}。`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // The Chinese interface, unless a test (or the page) has chosen otherwise.
  await page.addInitScript(() => {
    if (!localStorage.getItem("paper-locale"))
      localStorage.setItem("paper-locale", "zh");
  });
  await signIn(page);
  await removeModels(page);
  await page.route("**/api/v1/translation-settings/configs/*/test", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
});

test.afterEach(async ({ page }) => {
  await removeModels(page);
});

test("models are added, chosen, tested and removed", async ({ page }) => {
  await page.goto(SETTINGS("models"));
  await expect(page).toHaveURL(/#customize\/models$/);
  const section = page.getByRole("region", { name: "模型" });
  await expect(section.getByText("暂无条目")).toBeVisible();

  await addModel(page, "gpt-test-first");
  const list = section.getByRole("list", { name: "模型" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem").first()).toContainText("当前");

  // The newest model becomes the current one.
  await addModel(page, "gpt-test-second");
  const first = list
    .getByRole("listitem")
    .filter({ hasText: "gpt-test-first" });
  const second = list
    .getByRole("listitem")
    .filter({ hasText: "gpt-test-second" });
  await expect(second).toContainText("当前");
  await expect(first).not.toContainText("当前");

  await first
    .getByRole("button", { name: "gpt-test-first 的更多操作" })
    .click();
  await page.getByRole("menuitem", { name: "使用", exact: true }).click();
  await expect(first).toContainText("当前");
  await expect(second).not.toContainText("当前");
  const ids = (await settings(page)).models.map(
    (row: { id: string; model: string }) => row,
  );
  expect((await settings(page)).active_id).toBe(
    ids.find((row: { model: string }) => row.model === "gpt-test-first").id,
  );

  await second
    .getByRole("button", { name: "gpt-test-second 的更多操作" })
    .click();
  await page.getByRole("menuitem", { name: "测试", exact: true }).click();
  await expect(page.getByText("gpt-test-second 连接正常。")).toBeVisible();

  await second
    .getByRole("button", { name: "gpt-test-second 的更多操作" })
    .click();
  await page.getByRole("menuitem", { name: "移除", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "移除这个模型？" });
  await expect(confirm).not.toHaveAttribute("aria-describedby");
  await confirm.getByRole("button", { name: "移除" }).click();
  await expect(confirm).toBeHidden();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  expect(
    (await settings(page)).models.map((row: { model: string }) => row.model),
  ).toEqual(["gpt-test-first"]);
});

test("the theme and the language change at once", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(SETTINGS("general"));
  await page.getByRole("radio", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("radio", { name: "跟随系统" }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("paper-appearance")),
  ).toBe("system");

  await page.getByRole("radio", { name: "English" }).click();
  const window = page.getByRole("dialog", { name: "Settings" });
  await expect(window).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // Only the name of the other language is in Chinese.
  const text = await window.innerText();
  expect(text.replace("中文", "")).not.toMatch(/[一-鿿]/);
  expect(
    await window
      .getByRole("main")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page.goto(SETTINGS("usage"));
  await expect(page.getByRole("region", { name: "Usage" })).toBeVisible();
  await page.goto(SETTINGS("general"));
  await page.reload();
  await expect(window).toBeVisible();
  await page.getByRole("radio", { name: "中文" }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
});

test("full-window settings keep the desktop inset, search and native dialog controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/#new");
  await page.evaluate(() => {
    document.documentElement.dataset.desktop = "darwin";
  });
  const open = page
    .getByRole("navigation", { name: "侧栏", exact: true })
    .getByRole("link", { name: "设置", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("top", "32px");
  await expect(dialog).toHaveCSS("height", "868px");
  await expect(dialog).toHaveCSS("width", "720px");
  const search = dialog.getByRole("searchbox");
  await expect(search).toBeFocused();
  await expect(search.locator("..")).toHaveCSS("box-shadow", /1\.5px/);
  await search.fill("用量");
  await expect(dialog.getByRole("navigation").getByRole("button")).toHaveCount(
    1,
  );
  await search.press("Enter");
  await expect(dialog.getByRole("heading", { level: 1 })).toHaveText("用量");
  await search.fill("");
  const close = dialog.getByRole("button", { name: "关闭", exact: true });
  await close.focus();
  await expect(close).toBeFocused();
  await search.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#new$/);
  await open.click();
  await close.click();
  await expect(dialog).toBeHidden();
});

test("the data, its use and the export are shown", async ({ page }) => {
  await createPaperWithPdf(page);
  await page.goto(SETTINGS("data"));
  const data = page.getByRole("region", { name: "数据" });
  await expect(data.getByText(/^已用 .+ \/ .+$/)).toBeVisible();
  await expect(data.getByRole("meter", { name: "存储用量" })).toBeVisible();
  await expect(data.getByText("论文", { exact: true })).toBeVisible();
  await expect(data.getByRole("button", { name: "下载 ZIP" })).toBeVisible();
  await page.goto(SETTINGS("usage"));
  const usage = page.getByRole("region", { name: "用量" });
  await expect(usage.getByText("请求", { exact: true })).toBeVisible();
  await expect(usage.getByText("Tokens", { exact: true })).toBeVisible();
});

test("local browser data settings show a copyable log folder", async ({
  page,
}) => {
  await page.route("**/api/v1/storage-usage", (route) =>
    route.fulfill({
      json: {
        used_bytes: 0,
        limit_bytes: 1024,
        categories: {},
        logs_path: "/tmp/ora data/logs",
      },
    }),
  );
  await page.goto(SETTINGS("data"));
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          document.documentElement.dataset.copiedLogPath = value;
          return Promise.resolve();
        },
      },
    });
  });
  const data = page.getByRole("region", { name: "数据" });
  await expect(
    data.getByText("/tmp/ora data/logs", { exact: true }),
  ).toBeVisible();
  const exportRow = data
    .getByRole("button", { name: "下载 ZIP" })
    .locator("..");
  await expect(exportRow).toHaveCSS("min-height", "56px");
  await expect(exportRow).toHaveCSS("padding", "12px 16px");
  await expect(exportRow.locator("..")).toHaveCSS("border-radius", "16px");
  expect(
    await exportRow.evaluate((row) => {
      const divider = getComputedStyle(row, "::before");
      return [divider.height, divider.left, divider.right];
    }),
  ).toEqual(["1px", "16px", "16px"]);
  await data.getByRole("button", { name: "复制路径" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-log-path",
    "/tmp/ora data/logs",
  );
  await page.setViewportSize({ width: 720, height: 420 });
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("main").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeInViewport();
});

test("desktop data settings use the log folder action", async ({ page }) => {
  await page.route("**/api/v1/storage-usage", (route) =>
    route.fulfill({
      json: {
        used_bytes: 0,
        limit_bytes: 1024,
        categories: {},
        logs_path: "/tmp/ora/logs",
      },
    }),
  );
  await page.goto(SETTINGS("data"));
  // As the desktop preload does; the section reads it when it renders.
  await page.evaluate(() => {
    document.documentElement.dataset.desktop = "darwin";
  });
  await page.getByRole("button", { name: "常规" }).click();
  await page.getByRole("button", { name: "数据" }).click();
  const data = page.getByRole("region", { name: "数据" });
  await expect(
    data.getByRole("button", { name: "打开日志文件夹" }),
  ).toBeVisible();
  await expect(data.getByRole("button", { name: "复制路径" })).toHaveCount(0);
});

test("share links and credentials can only be revoked", async ({ page }) => {
  const paper = await createPaperWithPdf(page);
  const share = await page.request.post(
    `/api/v1/papers/${paper.paperId}/shares`,
    {
      headers: await headers(page),
      data: { file_id: paper.fileId, expires_days: 7 },
    },
  );
  expect(share.ok()).toBeTruthy();
  const tokenName = `Test agent ${Date.now().toString(36)}`;
  const token = await page.request.post("/api/v1/tokens", {
    headers: await headers(page),
    data: { name: tokenName, scopes: ["read"], days: 30 },
  });
  expect(token.ok()).toBeTruthy();

  await page.goto(SETTINGS("access"));
  const access = page.getByRole("region", { name: "分享链接和凭据" });
  const shares = access.getByRole("list", { name: "分享链接" });
  await expect(shares).toHaveCSS("padding", "4px");
  await expect(shares).toHaveCSS("border-radius", "16px");
  await expect(shares).not.toHaveCSS("box-shadow", "none");
  const shareRow = shares
    .getByRole("listitem")
    .filter({ hasText: paper.title });
  await expect(shareRow).toContainText("paper.pdf");
  await expect(shareRow).toHaveCSS("padding", "7px 9px");
  await expect(shareRow).toHaveCSS("gap", "9px");
  await expect(shareRow).toHaveCSS("border-radius", "12px");
  // There is nothing to make here: only revoking.
  await expect(access.getByRole("button", { name: /创建|新建/ })).toHaveCount(
    0,
  );

  await shareRow
    .getByRole("button", { name: `${paper.title} 的更多操作` })
    .click();
  await page.getByRole("menuitem", { name: "撤销", exact: true }).click();
  const confirmShare = page.getByRole("dialog", { name: "撤销这个链接？" });
  await confirmShare.getByRole("button", { name: "撤销" }).click();
  await expect(confirmShare).toBeHidden();
  await expect(shareRow).toHaveCount(0);
  const left = await (
    await page.request.get(`/api/v1/papers/${paper.paperId}/shares`)
  ).json();
  expect(left[0].revoked_at).toBeTruthy();

  const tokens = access.getByRole("list", { name: "Agent 凭据" });
  const tokenRow = tokens.getByRole("listitem").filter({ hasText: tokenName });
  await expect(tokenRow).toContainText("只读");
  await tokenRow
    .getByRole("button", { name: `${tokenName} 的更多操作` })
    .click();
  await page.getByRole("menuitem", { name: "撤销", exact: true }).click();
  const confirmToken = page.getByRole("dialog", { name: "撤销这个凭据？" });
  await confirmToken.getByRole("button", { name: "撤销" }).click();
  await expect(tokenRow).toHaveCount(0);
  const rows = await (await page.request.get("/api/v1/tokens")).json();
  expect(
    rows.find((row: { name: string }) => row.name === tokenName).revoked,
  ).toBe(true);

  await page.reload();
  await expect(access.getByText("暂无分享链接")).toBeVisible();
});
