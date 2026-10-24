import { expect, test, type Page } from "@playwright/test";
import { createPaperWithPdf, openReader, signIn } from "./fixtures";

// The local build (open-paper-reader) installs layout translation on demand.
// The install itself is the service's (backend/tests/test_layout_install.py):
// here it is mocked, and the translated view is what is checked.
test.use({ locale: "zh-CN" });

type Install = {
  status: string;
  stage: string;
  progress: number;
  error: string;
  supported: boolean;
  installed: boolean;
  available: boolean;
};

async function serve(page: Page, start: Partial<Install> = {}) {
  const install: Install = {
    status: "idle",
    stage: "",
    progress: 0,
    error: "",
    supported: true,
    installed: false,
    available: false,
    ...start,
  };
  const calls: string[] = [];
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        models: [{ id: "model-1", name: "Fixture model", model: "fixture" }],
        active_id: "model-1",
        configured: true,
        pdf_layout_enabled: install.available,
      },
    }),
  );
  await page.route("**/api/v1/papers/*/translations", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/layout-install**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      calls.push(path);
      if (path.endsWith("/cancel"))
        Object.assign(install, { status: "cancelled", stage: "", progress: 0 });
      else
        Object.assign(install, {
          status: "running",
          stage: "engine",
          progress: 35,
        });
    }
    return route.fulfill({ json: install });
  });
  return { install, calls };
}

const main = (page: Page) => page.getByRole("main");
const panel = (page: Page) =>
  main(page).getByRole("region", { name: "全文翻译", exact: true });

async function openTranslated(page: Page, start: Partial<Install> = {}) {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: 2 });
  const service = await serve(page, start);
  await openReader(page, { paperId: paper.paperId });
  await main(page)
    .getByRole("radiogroup", { name: "阅读方式", exact: true })
    .getByRole("radio", { name: "译文", exact: true })
    .click();
  await expect(
    panel(page).getByText("未配置版面翻译", { exact: true }),
  ).toBeVisible();
  return service;
}

test("the local build installs layout translation from the translated view", async ({
  page,
}) => {
  const { install, calls } = await openTranslated(page);
  await expect(panel(page).getByText("约 1 GB", { exact: true })).toBeVisible();

  await panel(page).getByRole("button", { name: "安装版面翻译" }).click();
  await expect(panel(page).getByText("正在安装 BabelDOC…")).toBeVisible();
  await expect(
    panel(page).getByRole("progressbar", { name: "安装进度" }),
  ).toHaveAttribute("aria-valuenow", "35");
  expect(calls).toEqual(["/api/v1/layout-install"]);

  // Finished: the settings are read again and the translation can start.
  Object.assign(install, {
    status: "completed",
    stage: "",
    progress: 100,
    installed: true,
    available: true,
  });
  await expect(
    panel(page).getByRole("button", { name: "开始版面翻译" }),
  ).toBeVisible();
});

test("an install can be cancelled, and a failed one shows why and retries", async ({
  page,
}) => {
  const { install, calls } = await openTranslated(page, {
    status: "running",
    stage: "assets",
    progress: 80,
  });
  await expect(panel(page).getByText("正在下载版面模型和字体…")).toBeVisible();
  await panel(page).getByRole("button", { name: "取消安装" }).click();
  await expect(
    panel(page).getByText("已取消安装，没有留下任何文件。"),
  ).toBeVisible();
  expect(calls).toEqual(["/api/v1/layout-install/cancel"]);

  Object.assign(install, {
    status: "failed",
    error: "No matching distribution found for BabelDOC==0.6.4",
  });
  await page.reload();
  await main(page)
    .getByRole("radiogroup", { name: "阅读方式", exact: true })
    .getByRole("radio", { name: "译文", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("安装没有完成");
  await expect(
    panel(page).getByText("No matching distribution found"),
  ).toBeVisible();
  await panel(page).getByRole("button", { name: "重试" }).click();
  await expect(panel(page).getByText("正在安装 BabelDOC…")).toBeVisible();
});

test("the hosted site shows no install button", async ({ page }) => {
  await openTranslated(page, { supported: false });
  await expect(panel(page).getByRole("button")).toHaveCount(0);
});
