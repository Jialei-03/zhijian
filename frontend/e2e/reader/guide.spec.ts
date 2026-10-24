import { expect, test, type Page } from "@playwright/test";
import { createPaperWithPdf, openReader, signIn } from "./fixtures";

// The interface follows the browser's language; these specs read it in Chinese.
test.use({ locale: "zh-CN" });

const MODEL = { id: "fixture-model", name: "Fixture model", model: "fixture" };
const TITLES = ["研究问题", "方法", "主要结果", "适用边界"];
const SUMMARY = ["摘要第一句。", "摘要第二句。", "摘要第三句。"];
/** Pages of their own for each section (the second rests on two), so that a chip says which section it is in. */
const PAGES = [[1], [2, 3], [4], [5]];
const SECTIONS = TITLES.map((title, index) => ({
  title,
  body: `${title}的内容，**加粗**一处。`,
  pages: PAGES[index],
}));
const GUIDE = {
  keywords: ["注意力", "Transformer"],
  summary: SUMMARY,
  sections: SECTIONS,
};

type Row = Record<string, unknown>;

/** Everything the mocked service holds about the guide; a test changes it while the page runs. */
type Service = {
  models: unknown[];
  preparation: Row;
  row: Row | null;
  /** What starting a guide answers with. */
  reply: Row | null;
  /** The bodies of the requests that started a guide, and of those that ensured the preparation. */
  started: Row[];
  ensured: unknown[];
  /** How many times the running guide was read by its address. */
  polled: number;
};

const running = (fileId: string, fields: Row = {}): Row => ({
  id: "guide-1",
  file_id: fileId,
  kind: "guide",
  status: "running",
  run_id: "run-1",
  session_id: "session-1",
  model_config_id: MODEL.id,
  error: "",
  result: null,
  parameters: {},
  ...fields,
});

/** The service's answers about the guide, in place of the model: set before the reader is opened. */
async function serve(
  page: Page,
  paperId: string,
  start: Partial<Service> = {},
): Promise<Service> {
  const service: Service = {
    models: [MODEL],
    preparation: {
      enabled: true,
      status: "completed",
      stage: "",
      error: "",
      completed: 0,
      total: 0,
      guide_status: "completed",
      translation_status: "waiting",
      layout_status: "waiting",
    },
    row: null,
    reply: null,
    started: [],
    ensured: [],
    polled: 0,
    ...start,
  };
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        models: service.models,
        active_id: (service.models[0] as { id?: string } | undefined)?.id ?? "",
      },
    }),
  );
  await page.route(`**/api/v1/papers/${paperId}/preparation`, (route) => {
    if (route.request().method() === "POST")
      service.ensured.push(route.request().postDataJSON());
    return route.fulfill({ json: service.preparation });
  });
  await page.route(`**/api/v1/papers/${paperId}/reading-artifacts`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: service.row ? [service.row] : [] });
    service.started.push(route.request().postDataJSON());
    if (service.reply) service.row = service.reply;
    return route.fulfill({ json: service.row });
  });
  await page.route("**/api/v1/reading-artifacts/guide-1", (route) => {
    service.polled += 1;
    return route.fulfill({ json: service.row });
  });
  return service;
}

const panel = (page: Page) => page.getByRole("tabpanel");
const progress = (page: Page) =>
  panel(page).getByRole("status").filter({ hasText: "正在生成导读" });
const heading = (page: Page, name: string) =>
  panel(page).getByRole("heading", { name, exact: true });
const main = (page: Page) => page.getByRole("main");
const pageInput = (page: Page) =>
  main(page).getByRole("textbox", { name: "页码", exact: true });

/** A paper of five pages, opened in the reader once the first page is drawn. */
async function open(page: Page, start: (fileId: string) => Partial<Service>) {
  await signIn(page);
  const { paperId, fileId } = await createPaperWithPdf(page, { pages: 5 });
  const service = await serve(page, paperId, start(fileId));
  await openReader(page, { paperId });
  await expect(page.locator('[data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
  );
  return { service, paperId, fileId };
}

test("without a model the guide says to add one in settings", async ({
  page,
}) => {
  await open(page, () => ({ models: [] }));

  await expect(panel(page).getByText("未配置模型")).toBeVisible();
  const link = panel(page).getByRole("link", { name: "添加模型" });
  await expect(link).toHaveAttribute("href", "#customize/models");
  await expect(panel(page).getByRole("button")).toHaveCount(0);

  await link.click();
  await expect(page).toHaveURL(/#customize\/models$/);
});

test("a guide being written shows what has arrived, and follows it", async ({
  page,
}) => {
  const { service, fileId } = await open(page, (fileId) => ({
    preparation: {
      enabled: true,
      status: "running",
      stage: "",
      error: "",
      completed: 0,
      total: 0,
      guide_status: "running",
      translation_status: "queued",
      layout_status: "queued",
    },
    row: running(fileId, {
      preview: {
        keywords: GUIDE.keywords,
        summary: SUMMARY,
        sections: SECTIONS.slice(0, 1),
      },
    }),
  }));

  // The preparation was asked to take care of the paper, by an empty `ensure`.
  expect(service.ensured).toEqual([{}]);

  await expect(progress(page)).toBeVisible();
  const keywords = panel(page).getByRole("list", { name: "关键词" });
  await expect(keywords.getByRole("listitem")).toHaveText([
    "注意力",
    "Transformer",
  ]);
  for (const line of SUMMARY)
    await expect(panel(page).getByText(line)).toBeVisible();
  await expect(heading(page, "研究问题")).toBeVisible();
  await expect(heading(page, "方法")).toHaveCount(0);
  // The text is the model's; **bold** is read, and the asterisks are not shown.
  await expect(panel(page).locator("strong")).toHaveText("加粗");
  await expect(panel(page)).not.toContainText("**");

  // The next section is written: it comes in, and the line of progress stays.
  service.row = running(fileId, {
    preview: {
      keywords: GUIDE.keywords,
      summary: SUMMARY,
      sections: SECTIONS.slice(0, 2),
    },
  });
  await expect(heading(page, "方法")).toBeVisible();
  await expect(progress(page)).toBeVisible();
  await expect(heading(page, "主要结果")).toHaveCount(0);

  // It is done: the progress line goes, and all four sections are there.
  service.row = running(fileId, {
    status: "completed",
    result: GUIDE,
    preview: undefined,
  });
  for (const title of TITLES) await expect(heading(page, title)).toBeVisible();
  await expect(progress(page)).toHaveCount(0);
});

test("the guide of a preparation that has not made it yet is waited for", async ({
  page,
}) => {
  const { service, fileId } = await open(page, () => ({
    preparation: {
      enabled: true,
      status: "queued",
      stage: "",
      error: "",
      completed: 0,
      total: 0,
      guide_status: "queued",
      translation_status: "queued",
      layout_status: "queued",
    },
  }));

  // Nothing to show but that it is on the way.
  await expect(progress(page)).toBeVisible();
  await expect(panel(page).getByRole("button")).toHaveCount(0);

  // The preparation finishes the guide in the background: it appears by itself.
  service.preparation = { ...service.preparation, status: "completed" };
  service.row = running(fileId, {
    status: "completed",
    result: GUIDE,
    parameters: { preparation_id: "preparation-1" },
  });
  for (const title of TITLES)
    await expect(heading(page, title)).toBeVisible({ timeout: 10000 });
  await expect(progress(page)).toHaveCount(0);
});

test("a finished guide has its four sections, and the page chips go to the page", async ({
  page,
}) => {
  await open(page, (fileId) => ({
    row: running(fileId, { status: "completed", result: GUIDE }),
  }));

  for (const title of TITLES) await expect(heading(page, title)).toBeVisible();
  await expect(
    panel(page).getByRole("listitem").filter({ hasText: "摘要第" }),
  ).toHaveCount(3);
  await expect(progress(page)).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", { name: /^第 \d+ 页$/ }),
  ).toHaveText(["第 1 页", "第 2 页", "第 3 页", "第 4 页", "第 5 页"]);

  // The pill is the accent's text on the accent's soft ground, and round.
  const chip = panel(page).getByRole("button", { name: "第 4 页" });
  const style = await chip.evaluate((element) => {
    const css = getComputedStyle(element);
    const probe = document.createElement("span");
    probe.style.color = "var(--ui-accent-text)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { color: css.color, accent, radius: css.borderTopLeftRadius };
  });
  expect(style.color).toBe(style.accent);
  expect(Number.parseFloat(style.radius)).toBeGreaterThan(10);

  await chip.click();
  await expect(pageInput(page)).toHaveValue("4");
  await expect
    .poll(async () => {
      const [sheet, desk] = await Promise.all([
        page.locator('[data-page="4"]').boundingBox(),
        page
          .getByRole("region", { name: "论文页面", exact: true })
          .boundingBox(),
      ]);
      return Math.abs(sheet!.y - desk!.y - 20);
    })
    .toBeLessThan(6);

  await panel(page).getByRole("button", { name: "第 2 页" }).click();
  await expect(pageInput(page)).toHaveValue("2");
});

test("a failed guide says why, and 重试 asks for it to be made again", async ({
  page,
}) => {
  const reason = "模型返回的阅读结果格式不完整，请重试";
  const { service, fileId } = await open(page, (fileId) => ({
    row: running(fileId, { status: "failed", error: reason }),
    preparation: {
      enabled: true,
      status: "failed",
      guide_status: "failed",
      error: `${reason}；第 2 页翻译失败`,
      layout_status: "unavailable",
    },
  }));
  service.reply = running(fileId, {
    preview: { keywords: GUIDE.keywords },
  });

  await expect(panel(page).getByRole("alert")).toHaveText(reason);
  await expect(panel(page)).not.toContainText("第 2 页翻译失败");
  expect(service.started).toEqual([]);

  await panel(page).getByRole("button", { name: "重试", exact: true }).click();

  await expect
    .poll(() => service.started)
    .toEqual([
      {
        file_id: fileId,
        model_config_id: MODEL.id,
        kind: "guide",
        regenerate: true,
      },
    ]);
  // And it is being made: the error is gone and the progress is shown.
  await expect(progress(page)).toBeVisible();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect(panel(page).getByText("注意力")).toBeVisible();
});

test("unrelated preparation failures do not appear above the assistant", async ({
  page,
}) => {
  const aggregate = "第 2 页翻译失败；布局引擎未配置，对照翻译和导读已单独保存";
  await open(page, () => ({
    row: null,
    preparation: {
      enabled: true,
      status: "failed",
      guide_status: "waiting",
      translation_status: "failed",
      layout_status: "unavailable",
      error: aggregate,
    },
  }));
  await expect(
    panel(page).getByRole("button", { name: "生成导读" }),
  ).toBeVisible();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect(panel(page)).not.toContainText(aggregate);
});

test("with the preparation off the guide is made by a button, once", async ({
  page,
}) => {
  const { service, fileId } = await open(page, () => ({
    preparation: {
      enabled: false,
      status: "paused",
      stage: "已暂停自动准备",
      error: "",
      completed: 0,
      total: 0,
      guide_status: "queued",
      translation_status: "queued",
      layout_status: "queued",
    },
  }));
  service.reply = running(fileId);

  const generate = panel(page).getByRole("button", { name: "生成导读" });
  await expect(generate).toBeVisible();
  await generate.click();

  await expect
    .poll(() => service.started)
    .toEqual([{ file_id: fileId, model_config_id: MODEL.id, kind: "guide" }]);
  await expect(progress(page)).toBeVisible();
  await expect(generate).toHaveCount(0);
});

test("a guide that is refused shows the service's reason", async ({ page }) => {
  const { paperId } = await open(page, () => ({
    preparation: {
      enabled: false,
      status: "paused",
      stage: "",
      error: "",
      completed: 0,
      total: 0,
      guide_status: "queued",
      translation_status: "queued",
      layout_status: "queued",
    },
  }));
  await page.route(`**/api/v1/papers/${paperId}/reading-artifacts`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: [] })
      : route.fulfill({
          status: 409,
          json: { detail: "请先选择可用模型" },
        }),
  );

  await panel(page).getByRole("button", { name: "生成导读" }).click();
  await expect(panel(page).getByRole("alert")).toHaveText("请先选择可用模型");
  // The button is there to try again.
  await expect(
    panel(page).getByRole("button", { name: "生成导读" }),
  ).toBeEnabled();
});

test("the guide stops asking once the reader is left", async ({ page }) => {
  const { service } = await open(page, (fileId) => ({
    row: running(fileId, { preview: { keywords: GUIDE.keywords } }),
  }));
  await expect(progress(page)).toBeVisible();
  await expect.poll(() => service.polled).toBeGreaterThan(1);

  await page.evaluate(() => {
    location.hash = "library";
  });
  await expect(page.getByRole("tabpanel")).toHaveCount(0);
  const settled = service.polled;
  await page.waitForTimeout(2000);
  expect(service.polled - settled).toBeLessThanOrEqual(1);
});

test("the guide opens the assistant's tab, the conversation follows it, and the question box is only under that tab", async ({
  page,
}) => {
  const SESSION = "guide-merge-session";
  const runs: Row[] = [];
  await page.route("**/api/v1/papers/*/discussion", (route) =>
    route.fulfill({ json: { id: SESSION, title: "Discussion" } }),
  );
  await page.route(`**/api/v1/agent/sessions/${SESSION}/runs`, (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill({ json: runs });
    const body = route.request().postDataJSON() as Row;
    const run = {
      id: `run-${runs.length + 1}`,
      prompt: String(body.prompt),
      response: "这是回答。",
      status: "completed",
      error: "",
      writable: false,
      steps: [],
      runtime: { phase: "completed", execution_seconds: 1 },
    };
    runs.push(run);
    return route.fulfill({ json: run });
  });
  await open(page, (fileId) => ({
    row: running(fileId, { status: "completed", result: GUIDE }),
  }));

  const tabs = page.getByRole("complementary").getByRole("tab");
  await expect(tabs).toHaveText(["助手", "笔记", "相关"]);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  // The empty view offers nothing to start from: the guide is what is there.
  await expect(heading(page, "研究问题")).toBeVisible();
  await expect(panel(page).getByText("可以从这些问题开始")).toHaveCount(0);
  await expect(panel(page).getByRole("log")).toHaveCount(0);

  const box = page.getByRole("textbox", { name: "向助手提问", exact: true });
  await expect(box).toBeVisible();
  await box.fill("它的局限是什么？");
  await box.press("Enter");
  const log = panel(page).getByRole("log", { name: "与助手的对话" });
  await expect(log).toContainText("这是回答。");
  // The guide stays above the conversation.
  const [guideBox, logBox] = await Promise.all([
    heading(page, "研究问题").boundingBox(),
    log.boundingBox(),
  ]);
  const body = await panel(page).evaluate((el) => ({
    top: el.parentElement!.scrollTop,
  }));
  expect(guideBox!.y).toBeLessThan(logBox!.y + body.top + 1);

  // The other tabs have no question box; the draft waits for the return.
  await box.fill("还没写完");
  for (const name of ["笔记", "相关"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(box).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "助手", exact: true }).click();
  await expect(box).toHaveValue("还没写完");

  // Put away, the panel has no question box either.
  await page.getByRole("button", { name: "收起右侧面板" }).click();
  await expect(box).toHaveCount(0);
  await page.getByRole("button", { name: "展开右侧面板" }).click();
  await expect(box).toHaveValue("还没写完");
});
