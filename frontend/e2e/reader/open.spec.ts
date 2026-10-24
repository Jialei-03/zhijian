import { expect, test, type Page } from "@playwright/test";
import { createPaperWithPdf, openReader, signIn } from "./fixtures";

// The interface follows the browser's language; these specs read it in Chinese.
test.use({ locale: "zh-CN" });

/** Whatever the page logs as an error or throws, from here on. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Wait for every running transition, so that rectangles are the settled ones. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );

const sidebar = (page: Page) => page.getByRole("navigation");
const panelTabs = (page: Page) => page.getByRole("tablist");

test("opens a paper in the new reader", async ({ page }) => {
  await signIn(page);
  const { paperId, title } = await createPaperWithPdf(page);
  const errors = watchErrors(page);

  await openReader(page, { paperId });

  const paper = page.getByRole("main");
  await expect(
    paper.getByRole("heading", { level: 1, name: title, exact: true }),
  ).toBeVisible();
  await expect(
    sidebar(page).getByRole("link", { name: "全部", exact: true }),
  ).toBeVisible();
  // The paper being read is in the list of what is being read, and marked.
  await expect(
    sidebar(page).getByRole("link", { name: title, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  for (const name of ["助手", "笔记", "相关"])
    await expect(panelTabs(page).getByRole("tab", { name })).toBeVisible();
  await expect(
    panelTabs(page).getByRole("tab", { name: "助手" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(panelTabs(page).getByRole("tab", { name: "导读" })).toHaveCount(
    0,
  );

  // None of the old interface is around it, and the wide window needs no toggle.
  await expect(page.locator("#main-content")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开研究助手" })).toHaveCount(
    0,
  );
  // Wide, the panel is docked and can be put away from the header.
  await expect(page.getByRole("button", { name: /右侧面板/ })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "收起右侧面板" }),
  ).toBeVisible();
  // The window is the shell's: it is the cards that scroll, never the page.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("the tabs of the side panel switch its text", async ({ page }) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: { models: [], active_id: "", configured: false } }),
  );
  await openReader(page, { paperId });

  await panelTabs(page).getByRole("tab", { name: "笔记" }).click();
  await expect(
    panelTabs(page).getByRole("tab", { name: "笔记" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("高亮与批注");
  await panelTabs(page).getByRole("tab", { name: "笔记" }).press("ArrowLeft");
  await expect(
    panelTabs(page).getByRole("tab", { name: "助手" }),
  ).toBeFocused();
  await expect(
    panelTabs(page).getByRole("tab", { name: "助手" }),
  ).toHaveAttribute("aria-selected", "true");
  const assistant = page.getByRole("tabpanel", { name: "助手", exact: true });
  await expect(assistant).toContainText("未配置模型");
  const addModel = assistant.getByRole("link", {
    name: "添加模型",
    exact: true,
  });
  await expect(addModel).toHaveAttribute("href", "#customize/models");
  await addModel.click();
  await expect(page).toHaveURL(/#customize\/models$/);
  await expect(
    page.getByRole("heading", { name: "模型", exact: true }),
  ).toBeVisible();
});

test("an unknown paper explains and links back", async ({ page }) => {
  await signIn(page);
  await openReader(page, { paperId: "does-not-exist" });

  const paper = page.getByRole("main");
  await expect(paper).toContainText("找不到这篇论文");
  const back = paper.getByRole("link", { name: "回到文库" });
  await expect(back).toBeVisible();
  // The rest of the screen is there: this is a paper that is missing, not a screen that broke.
  await expect(
    sidebar(page).getByRole("link", { name: "全部", exact: true }),
  ).toBeVisible();
  await expect(panelTabs(page)).toBeVisible();

  await back.click();
  await expect(page).toHaveURL(/#library/);
});

test("a failing region shows a retry instead of a blank screen", async ({
  page,
}) => {
  await signIn(page);
  const { paperId, title } = await createPaperWithPdf(page);
  // An answer that cannot be read: the card throws rather than explains.
  await page.route(`**/api/v1/papers/${paperId}/files`, (route) =>
    route.fulfill({ status: 200, body: "not json" }),
  );
  await openReader(page, { paperId });

  const paper = page.getByRole("main");
  const alert = paper.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("论文出了问题");
  await expect(alert.getByRole("button", { name: "重试" })).toBeVisible();
  // The other regions carry on.
  await expect(
    sidebar(page).getByRole("link", { name: "全部", exact: true }),
  ).toBeVisible();
  await expect(
    panelTabs(page).getByRole("tab", { name: "助手" }),
  ).toBeVisible();
  // Only the paper's body broke: its header stays, so on a narrow window the
  // side panel can still be opened.
  await page.setViewportSize({ width: 1000, height: 800 });
  const show = page.getByRole("button", { name: "展开右侧面板" });
  await expect(show).toBeVisible();
  await show.click();
  await expect(panelTabs(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panelTabs(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.unroute(`**/api/v1/papers/${paperId}/files`);
  await alert.getByRole("button", { name: "重试" }).click();
  await expect(
    paper.getByRole("heading", { level: 1, name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a paper that broke does not keep the next one from opening", async ({
  page,
}) => {
  await signIn(page);
  const good = await createPaperWithPdf(page);
  const broken = await createPaperWithPdf(page);
  await openReader(page, { paperId: good.paperId });
  const paper = page.getByRole("main");
  await expect(
    paper.getByRole("heading", { level: 1, name: good.title, exact: true }),
  ).toBeVisible();

  await page.route(`**/api/v1/papers/${broken.paperId}/files`, (route) =>
    route.fulfill({ status: 200, body: "not json" }),
  );
  await openReader(page, { paperId: broken.paperId });
  await expect(paper.getByRole("alert")).toContainText("论文出了问题");

  // Another paper, from the sidebar: it opens, without the old failure in the way.
  await sidebar(page).getByRole("link", { name: good.title }).click();
  await expect(page).toHaveURL(new RegExp(`#read/${good.paperId}$`));
  await expect(
    paper.getByRole("heading", { level: 1, name: good.title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a paper the service refuses is explained, with a retry", async ({
  page,
}) => {
  await signIn(page);
  const { paperId, title } = await createPaperWithPdf(page);
  let refuse = true;
  await page.route(`**/api/v1/papers/${paperId}`, (route) =>
    refuse
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "服务暂时不可用" }),
        })
      : route.continue(),
  );
  await openReader(page, { paperId });

  const paper = page.getByRole("main");
  await expect(paper.getByRole("alert")).toContainText("服务暂时不可用");
  refuse = false;
  await paper.getByRole("button", { name: "重试" }).click();
  await expect(
    paper.getByRole("heading", { level: 1, name: title, exact: true }),
  ).toBeVisible();
});

test("the sidebar lists what was read last and goes there", async ({
  page,
}) => {
  await signIn(page);
  const first = await createPaperWithPdf(page);
  const second = await createPaperWithPdf(page);

  await openReader(page, { paperId: first.paperId });
  await expect(page.getByRole("main")).toContainText(first.title);
  await openReader(page, { paperId: second.paperId });
  await expect(page.getByRole("main")).toContainText(second.title);

  const reading = sidebar(page).getByRole("group", { name: "最近阅读" });
  await expect(
    reading.getByRole("link", { name: second.title }),
  ).toHaveAttribute("aria-current", "page");
  const other = reading.getByRole("link", { name: first.title });
  await expect(other).not.toHaveAttribute("aria-current", "page");

  await other.click();
  await expect(page).toHaveURL(new RegExp(`#read/${first.paperId}$`));
  await expect(page.getByRole("main")).toContainText(first.title);
  await expect(
    reading.getByRole("link", { name: first.title }),
  ).toHaveAttribute("aria-current", "page");
});

test("the sidebar collapses to its icons", async ({ page }) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  await openReader(page, { paperId });

  await sidebar(page).getByRole("button", { name: "收起侧栏" }).click();
  // Collapsed, an item is named by its label although the label is not drawn.
  await expect(
    sidebar(page).getByRole("link", { name: "全部", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar(page).getByRole("button", { name: "展开侧栏" }),
  ).toBeVisible();
});

test("the old reader's address opens the new reader, where it pointed", async ({
  page,
}) => {
  await signIn(page);
  const { paperId, fileId, title } = await createPaperWithPdf(page, {
    pages: 3,
  });

  await page.goto(`/#paper/${paperId}?file=${fileId}&page=2&note=old`);
  await expect(page).toHaveURL(
    new RegExp(`#read/${paperId}\\?file=${fileId}&page=2$`),
  );
  await expect(
    page.getByRole("main").getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
  await expect(page.locator(".reader-page")).toHaveCount(0);
});

test("the right panel folds away on a narrow window", async ({ page }) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  await openReader(page, { paperId });
  await expect(panelTabs(page)).toBeVisible();

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(panelTabs(page)).toBeHidden();
  const show = page.getByRole("button", { name: "展开右侧面板" });
  await expect(show).toBeVisible();
  await expect(show).toHaveAttribute("aria-expanded", "false");

  // Open: it floats over the paper, below the header, so the toggle stays in reach.
  await show.click();
  await expect(panelTabs(page)).toBeVisible();
  await expect(
    panelTabs(page).getByRole("tab", { name: "助手" }),
  ).toBeFocused();
  const hide = page.getByRole("button", { name: "收起右侧面板" });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await settled(page);
  const panel = page.getByRole("complementary");
  const [panelBox, toggleBox, viewport] = await Promise.all([
    panel.boundingBox(),
    hide.boundingBox(),
    page.viewportSize(),
  ]);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(panelBox!.y).toBeGreaterThanOrEqual(toggleBox!.y + toggleBox!.height);
  // It is not squeezed into the paper: the paper keeps the whole width.
  const paperBox = await page.getByRole("main").boundingBox();
  expect(paperBox!.x + paperBox!.width).toBeGreaterThan(panelBox!.x);

  // Esc folds it again and hands the keyboard back to the toggle.
  await page.keyboard.press("Escape");
  await expect(panelTabs(page)).toBeHidden();
  await expect(show).toBeFocused();

  // The toggle opens and closes it too.
  await show.click();
  await expect(panelTabs(page)).toBeVisible();
  await hide.click();
  await expect(panelTabs(page)).toBeHidden();
  await expect(show).toBeFocused();

  // Wide again: docked, its toggle puts it away; narrow again: still folded.
  await show.click();
  await expect(panelTabs(page)).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(panelTabs(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /右侧面板/ })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "收起右侧面板" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(panelTabs(page)).toBeHidden();
});

// Continue reading: each paper opens at the page it was last read at, on this device.
const scroller = (page: Page) =>
  page.getByRole("region", { name: "论文页面", exact: true });
const pdfPage = (page: Page, number: number) =>
  page.locator(`[data-page="${number}"]`);
const pageInput = (page: Page) =>
  page.getByRole("main").getByRole("textbox", { name: "页码", exact: true });

/** The pages the reader has written down on this device, by paper (whoever they are for). */
const remembered = (page: Page) =>
  page.evaluate(() => {
    const pages: Record<string, number> = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      if (key.startsWith("paper-last-page:"))
        Object.assign(pages, JSON.parse(localStorage.getItem(key)!));
    }
    return pages;
  });
/** Waits until the page written down for the paper is `number`. */
const expectRemembered = (page: Page, paperId: string, number: number) =>
  expect.poll(async () => (await remembered(page))[paperId]).toBe(number);
/** Writes a page down for the paper, as if it had been read there (a page was written for it before). */
const remember = (page: Page, paperId: string, number: number) =>
  page.evaluate(
    ([id, value]) => {
      const key = Object.keys(localStorage).find((name) =>
        name.startsWith("paper-last-page:"),
      )!;
      const pages = JSON.parse(localStorage.getItem(key)!);
      pages[id] = value;
      localStorage.setItem(key, JSON.stringify(pages));
    },
    [paperId, number] as const,
  );

/** Through the page field, as a person does; resolves once the page is at the top of the desk. */
async function jumpTo(page: Page, number: number) {
  await pageInput(page).fill(String(number));
  await pageInput(page).press("Enter");
  await expect(pageInput(page)).toHaveValue(String(number));
  await expectAtTop(page, number);
}

/** The page's top is just under the top of the desk (the desk pads the first page by 20px). */
async function expectAtTop(page: Page, number: number) {
  await expect
    .poll(async () => {
      const [sheet, desk] = await Promise.all([
        pdfPage(page, number).boundingBox(),
        scroller(page).boundingBox(),
      ]);
      return Math.abs(sheet!.y - desk!.y - 20);
    })
    .toBeLessThan(6);
}

/** Opens the paper afresh (a full load, not a move inside the loaded page) and waits for its pages to be there. */
async function openAnew(page: Page, route: Parameters<typeof openReader>[1]) {
  await page.goto("about:blank");
  await openReader(page, route);
  await expect(scroller(page)).toBeVisible();
}

test("reopening continues where you left off", async ({ page }) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page, { pages: 12 });
  await openReader(page, { paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");

  await jumpTo(page, 7);
  await expectRemembered(page, paperId, 7);

  // The address names no page: it is the one that was read last.
  await page.reload();
  await expect(pageInput(page)).toHaveValue("7");
  await expectAtTop(page, 7);

  // Another paper is not taken there.
  const other = await createPaperWithPdf(page, { pages: 12 });
  await openAnew(page, { paperId: other.paperId });
  await expect(pageInput(page)).toHaveValue("1");
  await expectAtTop(page, 1);
});

test("a page in the address, or a reference, wins over the page remembered", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page, { pages: 12 });
  await openReader(page, { paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  await jumpTo(page, 7);
  await expectRemembered(page, paperId, 7);

  await openAnew(page, { paperId, page: 2 });
  await expect(pageInput(page)).toHaveValue("2");
  await expectAtTop(page, 2);
  // What is read now is what is remembered next.
  await expectRemembered(page, paperId, 2);

  // A quote carries its own page (the first, when the address names none).
  await remember(page, paperId, 7);
  await openAnew(page, { paperId, quote: "Page 3 of 12" });
  await page.waitForTimeout(500);
  await expect(pageInput(page)).toHaveValue("1");
  await expectAtTop(page, 1);
});

test("a page past the end of the document opens at the last page", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page, { pages: 5 });
  await openReader(page, { paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  await jumpTo(page, 3);
  await expectRemembered(page, paperId, 3);

  // The file was replaced by a shorter one since.
  await remember(page, paperId, 99);
  await openAnew(page, { paperId });
  await expect(pageInput(page)).toHaveValue("5");
  await expect(pdfPage(page, 5)).toBeInViewport();
});

test("the page is written once the reading has stopped, not as it scrolls", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page, { pages: 30 });
  await openReader(page, { paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  // Opening it is a visit too.
  await expectRemembered(page, paperId, 1);

  await page.evaluate(() => {
    const counted = window as unknown as { pageWrites: string[] };
    counted.pageWrites = [];
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("paper-last-page:")) counted.pageWrites.push(value);
      return set.call(this, key, value);
    };
  });
  const writes = () =>
    page.evaluate(
      () => (window as unknown as { pageWrites: string[] }).pageWrites,
    );

  // Many pages go by in well under the time it waits for.
  await scroller(page).hover();
  for (let step = 0; step < 12; step++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  const shown = Number(await pageInput(page).inputValue());
  expect(shown).toBeGreaterThan(6);
  expect(await writes()).toEqual([]);

  await expectRemembered(page, paperId, shown);
  await page.waitForTimeout(1300);
  expect(await writes()).toHaveLength(1);
});

test("leaving the paper, or the page, writes the page that has not been written yet", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page, { pages: 20 });
  await openReader(page, { paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");

  // To another screen straight after: well inside the second the page is waited on for.
  await jumpTo(page, 9);
  await page.goto("/#library");
  await expect(scroller(page)).toHaveCount(0);
  await expect
    .poll(async () => (await remembered(page))[paperId], { timeout: 600 })
    .toBe(9);

  // It opens there again; and closing or reloading the page straight after a change writes that one.
  await openReader(page, { paperId });
  await expect(pageInput(page)).toHaveValue("9");
  await jumpTo(page, 14);
  await page.reload();
  await expect(pageInput(page)).toHaveValue("14");
  await expectAtTop(page, 14);
});

test.describe("in English", () => {
  test.use({ locale: "en-US" });

  test("the screen speaks English", async ({ page }) => {
    await signIn(page);
    const { paperId, title } = await createPaperWithPdf(page);
    await openReader(page, { paperId });

    await expect(
      page.getByRole("main").getByRole("heading", { level: 1, name: title }),
    ).toBeVisible();
    await expect(
      sidebar(page).getByRole("link", { name: "All", exact: true }),
    ).toBeVisible();
    for (const name of ["Assistant", "Notes", "Related"])
      await expect(panelTabs(page).getByRole("tab", { name })).toBeVisible();

    await openReader(page, { paperId: "does-not-exist" });
    await expect(page.getByRole("main")).toContainText("can't be found");
    await expect(
      page.getByRole("main").getByRole("link", { name: "Back to library" }),
    ).toBeVisible();
  });
});

test("a wide window can put the panel away, and it stays away", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  await openReader(page, { paperId });
  const paper = page.getByRole("main");
  await expect(panelTabs(page)).toBeVisible();
  const before = (await paper.boundingBox())!.width;

  await page.getByRole("button", { name: "收起右侧面板" }).click();
  await expect(panelTabs(page)).toBeHidden();
  // The paper takes the room; the docked question box goes with the panel.
  await expect
    .poll(async () => (await paper.boundingBox())!.width)
    .toBeGreaterThan(before + 300);
  await expect(page.getByRole("textbox", { name: "向助手提问" })).toHaveCount(
    0,
  );

  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开右侧面板" }),
  ).toBeVisible();
  await expect(panelTabs(page)).toBeHidden();

  await page.getByRole("button", { name: "展开右侧面板" }).click();
  await expect(panelTabs(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "收起右侧面板" }),
  ).toBeVisible();
});
