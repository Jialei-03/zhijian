import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { createPaperWithPdf, openReader, signIn } from "./fixtures";

// The interface follows the browser's language; these specs read it in Chinese.
test.use({ locale: "zh-CN" });

const WORDS = "Evidence stays connected across pages";

const scroller = (page: Page) =>
  page.getByRole("region", { name: "论文页面", exact: true });
const pdfPage = (page: Page, number: number) =>
  page.locator(`[data-page="${number}"]`);
const line = (page: Page, number: number, text: string) =>
  pdfPage(page, number).locator(".textLayer span", { hasText: text });
const regionMenu = (page: Page) =>
  page.getByRole("menu", { name: "框选的区域", exact: true });
const textMenu = (page: Page) =>
  page.getByRole("menu", { name: "划选的文字", exact: true });
const result = (page: Page) =>
  page.getByRole("dialog", { name: "区域解释", exact: true });
const tool = (page: Page) =>
  page.getByRole("button", { name: /框选图表或公式/ });
const box = (page: Page) => page.locator("[data-region]");

const fixtureModels = (vision: boolean) => ({
  models: [
    {
      id: "fixture-model",
      name: "Fixture model",
      model: "fixture-text",
      vision,
      thinking_mode: "disabled",
      reasoning_effort: "default",
      controls: { thinking_modes: ["disabled"], effort_levels: ["default"] },
    },
  ],
  active_id: "fixture-model",
});

// A 1x1 PNG, in place of the server's picture of the box.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function openPaper(page: Page, vision = true) {
  await signIn(page);
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: fixtureModels(vision) }),
  );
  await page.route("**/api/v1/agent/files/*/image*", (route) =>
    route.fulfill({ body: PNG, contentType: "image/png" }),
  );
  const paper = await createPaperWithPdf(page, {
    pages: 3,
    words: { 1: WORDS },
  });
  await openReader(page, { paperId: paper.paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  return paper;
}

/** Drag a box on page 1, from and to a place given as fractions of the page. */
async function drawBox(
  page: Page,
  from: [number, number],
  to: [number, number],
) {
  const sheet = (await pdfPage(page, 1).boundingBox())!;
  const at = ([x, y]: [number, number]) => ({
    x: Math.round(sheet.x + sheet.width * x),
    y: Math.round(sheet.y + sheet.height * y),
  });
  await page.mouse.move(at(from).x, at(from).y);
  await page.mouse.down();
  await page.mouse.move(at(to).x, at(to).y, { steps: 10 });
  await page.mouse.up();
}

const selected = (page: Page) =>
  page.evaluate(() => window.getSelection()?.toString() ?? "");

/** Run answers, as the service gives them: POSTs are recorded, the list answers `response`. */
async function runs(
  page: Page,
  response: () => string,
  working: () => boolean = () => false,
) {
  const created: Record<string, any>[] = [];
  await page.route("**/api/v1/agent/sessions/*/runs", (route: Route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          id: `run-${created.length}`,
          status: "queued",
          response: "",
          error: "",
        },
      });
    }
    return route.fulfill({
      json: [
        {
          id: `run-${created.length}`,
          status: working() ? "running" : "completed",
          response: response(),
          error: "",
        },
      ],
    });
  });
  return created;
}

async function noteBody(page: Page, paperId: string) {
  const notes = await (
    await page.request.get(`/api/v1/items?kind=note&paper_id=${paperId}`)
  ).json();
  return (notes[0]?.body as string | undefined) ?? "";
}

test("a drag still selects text; in region mode or with Alt it draws a box", async ({
  page,
}) => {
  await openPaper(page);
  const words = line(page, 1, WORDS);
  const from = (await words.boundingBox())!;

  // Without the mode, a drag across text selects it, and no box comes.
  await page.mouse.move(
    Math.round(from.x + 2),
    Math.round(from.y + from.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.round(from.x + from.width - 2),
    Math.round(from.y + from.height / 2),
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(textMenu(page)).toBeVisible();
  expect((await selected(page)).trim()).toBe(WORDS);
  await expect(box(page)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Region mode: the same drag boxes instead of selecting.
  await tool(page).click();
  await expect(tool(page)).toHaveAttribute("aria-pressed", "true");
  await drawBox(page, [0.1, 0.05], [0.7, 0.3]);
  await expect(regionMenu(page)).toBeVisible();
  await expect(box(page)).toHaveCount(1);
  expect(await selected(page)).toBe("");
  await expect(regionMenu(page).getByRole("menuitem")).toHaveText([
    "解释这张图/表",
    "解释这个公式",
    "转成 LaTeX",
    "问助手",
    "记到笔记",
    "截图复制",
  ]);
  // Escape puts the box away; a second one leaves region mode.
  await page.keyboard.press("Escape");
  await expect(regionMenu(page)).toBeHidden();
  await expect(box(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(tool(page)).toHaveAttribute("aria-pressed", "false");

  // A box too small to mean anything (a click that wobbled) is not one.
  await tool(page).click();
  await drawBox(page, [0.3, 0.5], [0.302, 0.502]);
  await expect(regionMenu(page)).toBeHidden();
  await tool(page).click();

  // With Alt held, outside region mode.
  await page.keyboard.down("Alt");
  await drawBox(page, [0.2, 0.4], [0.8, 0.6]);
  await page.keyboard.up("Alt");
  await expect(regionMenu(page)).toBeVisible();
  await expect(box(page)).toHaveCount(1);
  // The box goes with its page when it scrolls out of view.
  await scroller(page).evaluate((element) => (element.scrollTop += 3000));
  await expect(regionMenu(page)).toBeHidden();
  await expect(box(page)).toHaveCount(0);
});

test("a figure is explained beside its box and kept in the note with its picture", async ({
  page,
}) => {
  const paper = await openPaper(page, false);
  let finished = false;
  const created = await runs(
    page,
    () => (finished ? "图 1 比较了两种方法，右侧更好。" : "图 1 比较了"),
    () => !finished,
  );
  await tool(page).click();
  await drawBox(page, [0.1, 0.4], [0.7, 0.7]);
  await regionMenu(page)
    .getByRole("menuitem", { name: "解释这张图/表" })
    .click();
  await expect(regionMenu(page)).toBeHidden();
  await expect(result(page)).toContainText("图 1 比较了");
  // A model that cannot read images says so.
  await expect(result(page)).toContainText("当前模型看不到图片");
  finished = true;
  await expect(result(page)).toContainText("右侧更好");
  expect(created).toHaveLength(1);
  const context = created[0].reader_context;
  expect(context).toMatchObject({
    paper_id: paper.paperId,
    file_id: paper.fileId,
    page: 1,
    source: "region",
    action: "explain",
  });
  expect(context.rect).toHaveLength(4);
  expect(created[0]).toMatchObject({
    model_config_id: "fixture-model",
    writable: false,
  });
  expect(created[0].prompt).toContain("图");

  // Beside the box, below it.
  const [popover, region] = await Promise.all([
    result(page).boundingBox(),
    box(page).boundingBox(),
  ]);
  expect(popover!.y).toBeGreaterThanOrEqual(region!.y + region!.height - 1);

  await result(page).getByRole("button", { name: "记到笔记" }).click();
  await expect(result(page)).toBeHidden();
  await expect
    .poll(() => noteBody(page, paper.paperId))
    .toMatch(
      new RegExp(
        `!\\[[^\\]]*\\]\\(/api/v1/agent/files/${paper.fileId}/image\\?page=1&rect=[\\d.,]+\\)\\n\\n图 1 比较了两种方法，右侧更好。\\n\\n\\[原文 · 第 1 页\\]\\(#read/${paper.paperId}`,
      ),
    );
});

test("a formula is written as LaTeX that can be copied and kept", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const paper = await openPaper(page);
  const created = await runs(page, () => "```latex\nE = m c^{2}\n```");
  await tool(page).click();
  await drawBox(page, [0.2, 0.3], [0.6, 0.45]);
  await regionMenu(page).getByRole("menuitem", { name: "转成 LaTeX" }).click();
  await expect(result(page).getByLabel("LaTeX")).toHaveText("E = m c^{2}");
  // A model that can see is not told otherwise; the formula is drawn as well as written.
  await expect(result(page)).not.toContainText("当前模型看不到图片");
  await expect(result(page).locator(".katex")).toBeVisible();
  expect(created[0].reader_context).toMatchObject({
    source: "region",
    action: "latex",
  });

  await result(page).getByRole("button", { name: "复制 LaTeX" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "E = m c^{2}",
  );
  await result(page).getByRole("button", { name: "记到笔记" }).click();
  await expect
    .poll(() => noteBody(page, paper.paperId))
    .toContain("$$\nE = m c^{2}\n$$");
});

test("a failed run says why and can be tried again; asking carries the box to the assistant", async ({
  page,
}) => {
  await openPaper(page);
  let fail = true;
  const created: Record<string, any>[] = [];
  await page.route("**/api/v1/agent/sessions/*/runs", (route: Route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postDataJSON());
      if (fail) {
        fail = false;
        return route.fulfill({
          status: 503,
          json: { detail: "模型服务暂时不可用" },
        });
      }
      return route.fulfill({
        json: { id: "run-ok", status: "queued", response: "", error: "" },
      });
    }
    return route.fulfill({
      json: [
        {
          id: "run-ok",
          status: "completed",
          response: "是一个公式。",
          error: "",
        },
      ],
    });
  });
  await tool(page).click();
  await drawBox(page, [0.1, 0.1], [0.5, 0.2]);
  await regionMenu(page)
    .getByRole("menuitem", { name: "解释这个公式" })
    .click();
  await expect(result(page).getByRole("alert")).toHaveText(
    "模型服务暂时不可用",
  );
  await result(page).getByRole("button", { name: "重试" }).click();
  await expect(result(page)).toContainText("是一个公式。");
  expect(created).toHaveLength(2);
  expect(created[1].reader_context.action).toBe("formula");

  await result(page).getByRole("button", { name: "问助手" }).click();
  await expect(result(page)).toBeHidden();
  // The question box holds the box as its picture, to be asked about.
  const composer = page.locator('[class*="composer"]').filter({
    has: page.getByRole("textbox", { name: "向助手提问", exact: true }),
  });
  await expect(
    composer.getByRole("img", { name: "第 1 页的框选区域", exact: true }),
  ).toBeVisible();
});

test("copying the box as an image gives the picture or saves it as a file", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPaper(page);
  await tool(page).click();
  await drawBox(page, [0.1, 0.1], [0.5, 0.3]);
  await regionMenu(page).getByRole("menuitem", { name: "截图复制" }).click();
  await expect(
    page
      .getByRole("region", { name: "通知" })
      .getByRole("status")
      .filter({ hasText: /已复制区域图片|已把图片保存为文件/ }),
  ).toBeVisible();
  await expect(regionMenu(page)).toBeHidden();
});

test("the box looks right in the light and the dark theme", async ({
  page,
}) => {
  await openPaper(page);
  await tool(page).click();
  await drawBox(page, [0.1, 0.05], [0.7, 0.3]);
  await expect(regionMenu(page)).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: `../test-results/regions-${scheme}.png`,
    });
  }
  const outline: Locator = box(page);
  await expect(outline).toBeVisible();
});
