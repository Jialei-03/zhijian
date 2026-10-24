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

const main = (page: Page) => page.getByRole("main");
const scroller = (page: Page) =>
  page.getByRole("region", { name: "论文页面", exact: true });
const pdfPage = (page: Page, number: number) =>
  page.locator(`[data-page="${number}"]`);
const menu = (page: Page) =>
  page.getByRole("menu", { name: "划选的文字", exact: true });
const popover = (page: Page) =>
  page.getByRole("dialog", { name: "译文", exact: true });
const pageInput = (page: Page) =>
  main(page).getByRole("textbox", { name: "页码", exact: true });

/** The text selected on the page. */
const selected = (page: Page) =>
  page.evaluate(() => window.getSelection()?.toString() ?? "");

/**
 * Drag across a line of a page's text, from just inside its start to just
 * inside its end, in whole pixels (Chromium starts no selection from a press at
 * a fraction of a pixel that is then dragged).
 */
async function selectLine(page: Page, line: Locator, to?: Locator) {
  // A press inside a selection would drag it away instead: let go of it first, on blank paper.
  if (await selected(page)) {
    const sheet = (await pdfPage(page, 1).boundingBox())!;
    await page.mouse.click(
      Math.round(sheet.x + sheet.width * 0.8),
      Math.round(sheet.y + sheet.height * 0.6),
    );
  }
  const from = (await line.boundingBox())!;
  const end = to ? (await to.boundingBox())! : from;
  await page.mouse.move(
    Math.round(from.x + 2),
    Math.round(from.y + from.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.round(end.x + end.width - 2),
    Math.round(end.y + end.height / 2),
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(menu(page)).toBeVisible();
  return { from, end };
}

const line = (page: Page, number: number, text: string) =>
  pdfPage(page, number).locator(".textLayer span", { hasText: text });

/** The paper's note on the service, as Markdown ("" while it has none). */
async function noteBody(page: Page, paperId: string) {
  const notes = await (
    await page.request.get(`/api/v1/items?kind=note&paper_id=${paperId}`)
  ).json();
  return (notes[0]?.body as string | undefined) ?? "";
}

/** The toast that says the selection was kept in the note. */
const keptToast = (page: Page) =>
  page
    .getByRole("region", { name: "通知" })
    .getByRole("status")
    .filter({ hasText: "已保存" });

async function openPaper(
  page: Page,
  options: Parameters<typeof createPaperWithPdf>[1] = {},
) {
  await signIn(page);
  const paper = await createPaperWithPdf(page, {
    pages: 3,
    words: { 1: WORDS },
    ...options,
  });
  await openReader(page, { paperId: paper.paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  return paper;
}

const fixtureModels = {
  models: [
    {
      id: "fixture-model",
      name: "Fixture model",
      model: "fixture-text",
      thinking_mode: "disabled",
      reasoning_effort: "default",
      controls: { thinking_modes: ["disabled"], effort_levels: ["default"] },
    },
  ],
  active_id: "fixture-model",
};

test("selecting text shows the actions beside it and keeps the selection", async ({
  page,
}) => {
  await openPaper(page);
  const words = line(page, 1, WORDS);
  const { end } = await selectLine(page, words);

  await expect(menu(page)).toBeVisible();
  const items = menu(page).getByRole("menuitem");
  await expect(items).toHaveText([
    "解释E",
    "翻译T",
    "高亮H",
    "批注C",
    "记到笔记N",
    "问助手↵",
  ]);
  for (const [name, keys] of [
    ["解释", "e"],
    ["翻译", "t"],
    ["高亮", "h"],
    ["批注", "c"],
    ["记到笔记", "n"],
    ["问助手", "Enter"],
  ])
    await expect(
      menu(page).getByRole("menuitem", { name, exact: true }),
    ).toHaveAttribute("aria-keyshortcuts", keys);

  // Just under the selected line, over its middle.
  const box = (await menu(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(end.y + end.height - 1);
  expect(box.y).toBeLessThan(end.y + end.height + 24);
  expect(box.x).toBeLessThan(end.x + end.width);
  expect(box.x + box.width).toBeGreaterThan(end.x);

  // The menu took neither the selection nor the keyboard.
  expect((await selected(page)).trim()).toBe(WORDS);
  await expect(scroller(page)).toBeFocused();
  // Nor does resting the pointer on it, or pressing on it without letting go.
  await menu(page).getByRole("menuitem", { name: "翻译", exact: true }).hover();
  expect((await selected(page)).trim()).toBe(WORDS);
  const item = (await menu(page)
    .getByRole("menuitem", { name: "高亮", exact: true })
    .boundingBox())!;
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
  await page.mouse.down();
  expect((await selected(page)).trim()).toBe(WORDS);
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await expect(menu(page)).toBeVisible();

  // It follows the line when the paper scrolls.
  await scroller(page).evaluate((element) => (element.scrollTop += 60));
  await expect
    .poll(async () => (await menu(page).boundingBox())!.y)
    .toBeLessThan(box.y - 50);
  const moved = (await words.boundingBox())!;
  expect((await menu(page).boundingBox())!.y).toBeGreaterThanOrEqual(
    moved.y + moved.height - 1,
  );

  // A right click on the selection shows the menu at the pointer instead of the browser's.
  const point = {
    x: Math.round(moved.x + moved.width / 3),
    y: Math.round(moved.y + moved.height / 2),
  };
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(menu(page)).toBeVisible();
  await expect
    .poll(async () => {
      const at = (await menu(page).boundingBox())!;
      return Math.abs(at.y - point.y) < 12 && at.x <= point.x;
    })
    .toBe(true);
  expect((await selected(page)).trim()).toBe(WORDS);
});

test("E explains, ↵ asks and N keeps the selection; Esc closes the menu", async ({
  page,
}) => {
  const paper = await openPaper(page);
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: fixtureModels }),
  );
  const created: Record<string, any>[] = [];
  await page.route("**/api/v1/agent/sessions/*/runs", (route: Route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: [] });
    created.push(route.request().postDataJSON());
    return route.fulfill({
      json: { id: `run-${created.length}`, status: "queued", response: "" },
    });
  });
  await page.reload();
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  const words = line(page, 1, WORDS);

  await selectLine(page, words);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("e");
  await expect(menu(page)).toBeHidden();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0].reader_context).toMatchObject({
    paper_id: paper.paperId,
    file_id: paper.fileId,
    page: 1,
    source: "selection",
    action: "explain",
    quote: WORDS,
  });
  expect(created[0].reader_context.rects.length).toBe(1);

  await selectLine(page, words);
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeHidden();
  await expect(
    page.getByRole("complementary").getByText(/^选中的一句：“Evidence/),
  ).toBeVisible();
  expect(created).toHaveLength(1);

  await selectLine(page, words);
  await menu(page).getByRole("menuitem", { name: "记到笔记" }).click();
  await expect(menu(page)).toBeHidden();
  await expect(keptToast(page)).toBeVisible();
  expect(await noteBody(page, paper.paperId)).toContain(`> ${WORDS}`);

  // Escape closes it and nothing else: the selection stays, the keys are the page's again.
  await selectLine(page, words);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  expect((await selected(page)).trim()).toBe(WORDS);
  await page.keyboard.press("e");
  await page.waitForTimeout(200);
  expect(created).toHaveLength(1);
  await page.keyboard.press("]");
  await expect(pageInput(page)).toHaveValue("2");

  // A selection scrolled out of view takes its menu with it; one cleared does too.
  await pageInput(page).fill("1");
  await pageInput(page).press("Enter");
  await expect(pageInput(page)).toHaveValue("1");
  await selectLine(page, words);
  await expect(menu(page)).toBeVisible();
  await scroller(page).evaluate((element) => (element.scrollTop += 2000));
  await expect(menu(page)).toBeHidden();
  await scroller(page).evaluate((element) => (element.scrollTop = 0));
  await selectLine(page, words);
  await expect(menu(page)).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(menu(page)).toBeHidden();
});

test("H highlights the selection, and the highlight is saved", async ({
  page,
}) => {
  const paper = await openPaper(page);
  const words = line(page, 1, WORDS);
  await selectLine(page, words);
  await expect(menu(page)).toBeVisible();

  const saved = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().includes(`/api/v1/files/${paper.fileId}/annotations/`),
  );
  await page.keyboard.press("h");
  const request = await saved;
  expect(request.postDataJSON()).toMatchObject({
    page: 1,
    quote: WORDS,
    color: "#FACC15",
    comment: "",
  });
  await expect(menu(page)).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "已高亮" }),
  ).toBeVisible();
  expect(await selected(page)).toBe("");
  const block = pdfPage(page, 1).locator("[data-annotation-id]");
  await expect(block).toHaveCount(1);
  // Over the words it was made from.
  const [mark, text] = await Promise.all([
    block.locator("[data-annotation-rect]").first().boundingBox(),
    words.boundingBox(),
  ]);
  expect(Math.abs(mark!.y - text!.y)).toBeLessThan(6);

  await page.reload();
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  await expect(pdfPage(page, 1).locator("[data-annotation-id]")).toHaveCount(1);
});

test("H pressed again while a highlight is still being saved waits its turn", async ({
  page,
}) => {
  const paper = await openPaper(page, {
    pages: 2,
    words: { 1: WORDS, 2: "A second line to highlight" },
  });
  // The first save is held until the second highlight has been asked for.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let puts = 0;
  await page.route(
    `**/api/v1/files/${paper.fileId}/annotations/*`,
    async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      if (++puts === 1) await held;
      return route.fallback();
    },
  );
  await selectLine(page, line(page, 1, WORDS));
  await page.keyboard.press("h");
  await expect.poll(() => puts).toBe(1);
  await pdfPage(page, 2).scrollIntoViewIfNeeded();
  await expect(pdfPage(page, 2)).toHaveAttribute("data-rendered", "true");
  const second = line(page, 2, "A second line to highlight");
  await second.scrollIntoViewIfNeeded();
  await selectLine(page, second);
  await page.keyboard.press("h");
  await page.waitForTimeout(300);
  // Not refused for being second: it has not even been sent yet.
  expect(puts).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  release();
  await expect.poll(() => puts).toBe(2);
  await expect(pdfPage(page, 1).locator("[data-annotation-id]")).toHaveCount(1);
  await expect(pdfPage(page, 2).locator("[data-annotation-id]")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the keys of the menu are the paper's: a button elsewhere keeps its own", async ({
  page,
}) => {
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: fixtureModels }),
  );
  const created: unknown[] = [];
  await page.route("**/api/v1/agent/sessions/*/runs", (route: Route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: [] });
    created.push(route.request().postDataJSON());
    return route.fulfill({
      json: { id: `run-${created.length}`, status: "queued", response: "" },
    });
  });
  await openPaper(page);
  await selectLine(page, line(page, 1, WORDS));
  // The keyboard on a button of the header, the selection still there: Enter presses the button.
  const next = main(page).getByRole("button", { name: "下一页", exact: true });
  await next.focus();
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(pageInput(page)).toHaveValue("2");
  await expect(main(page).getByText(/^选中的一句：/)).toHaveCount(0);
  await page.keyboard.press("e");
  await page.waitForTimeout(200);
  expect(created).toEqual([]);
});

test("a selection across two pages is highlighted on both", async ({
  page,
}) => {
  // Short pages, so that the end of the first and the start of the second are in view together.
  const paper = await openPaper(page, {
    pages: 2,
    size: [612, 240],
    words: {},
  });
  await expect(pdfPage(page, 2)).toHaveAttribute("data-rendered", "true");
  await selectLine(page, line(page, 1, "Page 1 of 2"), line(page, 2, "Page 2"));
  await expect(menu(page)).toBeVisible();
  const text = await selected(page);
  expect(text).toContain("Page 1 of 2");
  expect(text).toContain("Page 2");

  await menu(page).getByRole("menuitem", { name: "高亮", exact: true }).click();
  await expect(pdfPage(page, 1).locator("[data-annotation-id]")).toHaveCount(1);
  await expect(pdfPage(page, 2).locator("[data-annotation-id]")).toHaveCount(1);
  const rows = await (
    await page.request.get(`/api/v1/files/${paper.fileId}/annotations`)
  ).json();
  expect(rows.map((row: { page: number }) => row.page)).toEqual([1, 2]);
  expect(rows[0].quote).toContain("Page 1 of 2");
  expect(rows[1].quote).toContain("Page 2");
});

test("T translates beside the selection as the translation is written", async ({
  page,
}) => {
  // The reader reads the settings once, as it opens.
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: fixtureModels }),
  );
  const paper = await openPaper(page);
  const created: Record<string, any>[] = [];
  const cancelled: string[] = [];
  let failNext = true;
  let finished = false;
  const run = () => {
    const id = `translate-run-${created.length}`;
    return finished
      ? {
          id,
          status: "completed",
          response: "证据在页面之间保持相连。",
          error: "",
        }
      : { id, status: "running", response: "证据在页面之间", error: "" };
  };
  await page.route("**/api/v1/agent/sessions/*/runs", (route: Route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postDataJSON());
      if (failNext) {
        failNext = false;
        return route.fulfill({
          status: 503,
          json: { detail: "模型服务暂时不可用" },
        });
      }
      return route.fulfill({
        json: {
          id: `translate-run-${created.length}`,
          status: "queued",
          response: "",
          error: "",
        },
      });
    }
    return route.fulfill({ json: [run()] });
  });
  await page.route("**/api/v1/agent/runs/*/cancel", (route) => {
    cancelled.push(route.request().url());
    return route.fulfill({ json: {} });
  });

  const words = line(page, 1, WORDS);
  await selectLine(page, words);
  await page.keyboard.press("t");
  await expect(menu(page)).toBeHidden();
  // The server's reason, and a way to try again.
  await expect(popover(page).getByRole("alert")).toHaveText(
    "模型服务暂时不可用",
  );
  await popover(page).getByRole("button", { name: "重试" }).click();

  // What is written so far shows as it comes, and the rest once it is there.
  await expect(popover(page)).toContainText("证据在页面之间");
  await expect(popover(page).getByRole("status")).toBeVisible();
  await expect(popover(page).getByRole("button", { name: "复制" })).toHaveCount(
    0,
  );
  finished = true;
  await expect(popover(page)).toContainText("证据在页面之间保持相连。");
  await expect(popover(page).getByRole("status")).toHaveCount(0);
  expect(created).toHaveLength(2);
  expect(created[1]).toMatchObject({
    model_config_id: "fixture-model",
    writable: false,
    context: `paper/${paper.paperId}`,
    reader_context: {
      paper_id: paper.paperId,
      file_id: paper.fileId,
      page: 1,
      source: "selection",
      action: "translate",
      quote: WORDS,
    },
  });
  expect(created[1].prompt).toContain("翻译");

  // Beside the selection, under its line.
  const [box, text] = await Promise.all([
    popover(page).boundingBox(),
    words.boundingBox(),
  ]);
  expect(box!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
  expect(box!.y).toBeLessThan(text!.y + text!.height + 24);

  await popover(page).getByRole("button", { name: "记到笔记" }).click();
  await expect(popover(page)).toBeHidden();
  // The words and their translation, one after the other.
  await expect(keptToast(page)).toBeVisible();
  expect(await noteBody(page, paper.paperId)).toMatch(
    new RegExp(
      `> ${WORDS}\\n\\n证据在页面之间保持相连。\\n\\n\\[原文 · 第 1 页\\]`,
    ),
  );
  expect(cancelled).toEqual([]);

  // A translation closed before it is done is stopped.
  finished = false;
  await selectLine(page, words);
  await page.keyboard.press("t");
  await expect(popover(page)).toContainText("证据在页面之间");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect.poll(() => cancelled.length).toBe(1);
  expect(cancelled[0]).toContain(`/agent/runs/translate-run-3/cancel`);
});

test("a translation made before is shown at once, and can be made again", async ({
  page,
}) => {
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: fixtureModels }),
  );
  const paper = await openPaper(page);
  const asked: Record<string, any>[] = [];
  const created: Record<string, any>[] = [];
  let kept = "已保存的译文。";
  await page.route("**/api/v1/files/*/saved-translation", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: { translation: kept } });
  });
  await page.route("**/api/v1/agent/sessions/*/runs", (route: Route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          id: "again-run",
          status: "completed",
          response: "新的译文。",
          error: "",
        },
      });
    }
    return route.fulfill({ json: [] });
  });

  const words = line(page, 1, WORDS);
  await selectLine(page, words);
  await page.keyboard.press("t");
  // Shown from what was kept: the model is not asked.
  await expect(popover(page)).toContainText("已保存的译文。");
  await expect(popover(page).getByRole("status")).toHaveCount(0);
  expect(asked).toEqual([{ quote: WORDS }]);
  expect(created).toHaveLength(0);

  // Notes work from it as from a new one.
  await popover(page).getByRole("button", { name: "记到笔记" }).click();
  await expect(keptToast(page)).toBeVisible();
  expect(await noteBody(page, paper.paperId)).toContain("已保存的译文。");

  // Asked again, it replaces what was kept.
  await selectLine(page, words);
  await page.keyboard.press("t");
  await expect(popover(page)).toContainText("已保存的译文。");
  kept = "新的译文。";
  await popover(page).getByRole("button", { name: "重新翻译" }).click();
  await expect(popover(page)).toContainText("新的译文。");
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    reader_context: { action: "translate", quote: WORDS },
  });
  // Selecting it later shows the new one, again without the model.
  await page.keyboard.press("Escape");
  await selectLine(page, words);
  await page.keyboard.press("t");
  await expect(popover(page)).toContainText("新的译文。");
  expect(created).toHaveLength(1);
});

test("a read of the translation that fails for a moment is tried again", async ({
  page,
}) => {
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: fixtureModels }),
  );
  await openPaper(page);
  // For a second after the translation is asked for, the service cannot be reached.
  let asked = 0;
  let failedReads = 0;
  await page.route("**/api/v1/agent/sessions/*/runs", (route: Route) => {
    if (route.request().method() === "POST") {
      asked = Date.now();
      return route.fulfill({
        json: {
          id: "translate-run",
          status: "queued",
          response: "",
          error: "",
        },
      });
    }
    if (asked && Date.now() - asked < 1000) {
      failedReads += 1;
      return route.fulfill({ status: 502, json: { detail: "网关暂时不可用" } });
    }
    return route.fulfill({
      json: asked
        ? [
            {
              id: "translate-run",
              status: "completed",
              response: "证据在页面之间保持相连。",
              error: "",
            },
          ]
        : [],
    });
  });
  await selectLine(page, line(page, 1, WORDS));
  await page.keyboard.press("t");
  await expect(popover(page)).toContainText("证据在页面之间保持相连。");
  expect(failedReads).toBeGreaterThan(0);
  await expect(popover(page).getByRole("alert")).toHaveCount(0);
  await expect(
    popover(page).getByRole("button", { name: "复制" }),
  ).toBeVisible();
});

test("without a model, the translation says where to add one", async ({
  page,
}) => {
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: { models: [], active_id: "" } }),
  );
  await openPaper(page);
  const created: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/runs"))
      created.push(request.url());
  });
  await selectLine(page, line(page, 1, WORDS));
  await page.keyboard.press("t");
  await expect(popover(page)).toContainText("未配置模型");
  await expect(
    popover(page).getByRole("link", { name: "添加模型" }),
  ).toHaveAttribute("href", "#customize/models");
  await expect(popover(page).getByRole("alert")).toHaveCount(0);
  expect(created).toEqual([]);
});
