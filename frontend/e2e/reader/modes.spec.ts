import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createPaperWithPdf,
  openReader,
  pdfWithPages,
  signIn,
} from "./fixtures";

// The interface follows the browser's language; these specs read it in Chinese, bar the one that reads it in English.
test.use({ locale: "zh-CN" });

const PAGES = 8;
const MODELS = [
  { id: "model-1", name: "Fixture model", model: "fixture" },
  { id: "model-2", name: "Second model", model: "second" },
];

type Row = Record<string, unknown>;

/** What the mocked service holds about translating; a test changes it while the page runs. */
type Service = {
  /** `pdf_layout_enabled` of the settings. */
  layout: boolean;
  models: Row[];
  /** The paper's translation jobs, newest first. */
  jobs: Row[];
  /** The bodies of the requests that started a translation, and the ids of the jobs asked to stop. */
  started: Row[];
  cancelled: string[];
  /** The bodies of the requests for a page's translation (对照), in the order they came. */
  pageAsks: Row[];
};

/** A layout translation job of this PDF, running unless the fields say otherwise. */
const job = (fileId: string, fields: Row = {}): Row => ({
  id: "job-1",
  engine: "pdf",
  status: "running",
  stage: "正在翻译第 3 页",
  completed: 42,
  total: 100,
  error: "",
  source_file: fileId,
  translated_file: "",
  alignment: [],
  ...fields,
});

/** The service's answers about translating, in place of a model: set before the reader is opened. */
async function serve(
  page: Page,
  paperId: string,
  fileId: string,
  start: Partial<Service> = {},
): Promise<Service> {
  const service: Service = {
    layout: true,
    models: MODELS,
    jobs: [],
    started: [],
    cancelled: [],
    pageAsks: [],
    ...start,
  };
  // 对照: each page asked for is being translated, and stays so (what the column shows of it is parallel.spec's).
  const pageRows = new Map<string, Row>();
  await page.route(`**/api/v1/papers/${paperId}/reading-artifacts`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: [...pageRows.values()].reverse() });
    const body = route.request().postDataJSON() as Row;
    if (body.kind !== "page_translation") return route.fallback();
    service.pageAsks.push(body);
    const row: Row = {
      id: `pt-${service.pageAsks.length}`,
      file_id: body.file_id,
      kind: "page_translation",
      status: "running",
      model_config_id: body.model_config_id,
      error: "",
      parameters: { page: body.page, language: body.language },
      result: null,
    };
    pageRows.set(row.id as string, row);
    return route.fulfill({ json: row });
  });
  await page.route("**/api/v1/reading-artifacts/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const row = pageRows.get(id);
    return row
      ? route.fulfill({ json: row })
      : route.fulfill({ status: 404, json: { detail: "not found" } });
  });
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        models: service.models,
        active_id: (service.models[0] as { id?: string } | undefined)?.id ?? "",
        configured: service.models.length > 0,
        pdf_layout_enabled: service.layout,
      },
    }),
  );
  await page.route(`**/api/v1/papers/${paperId}/translations`, (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill({ json: service.jobs });
    service.started.push(route.request().postDataJSON());
    const created = job(fileId, {
      id: "job-new",
      status: "queued",
      stage: "",
      completed: 0,
    });
    service.jobs.unshift(created);
    return route.fulfill({ json: created });
  });
  await page.route("**/api/v1/translations/*/cancel", (route) => {
    const id = route.request().url().split("/").at(-2)!;
    service.cancelled.push(id);
    const stopped = service.jobs.find((row) => row.id === id);
    if (stopped) Object.assign(stopped, { status: "cancelled", stage: "" });
    return route.fulfill({ json: stopped ?? {} });
  });
  return service;
}

const main = (page: Page) => page.getByRole("main");
const scroller = (page: Page) =>
  page.getByRole("region", { name: "论文页面", exact: true });
const pdfPage = (page: Page, number: number) =>
  page.locator(`[data-page="${number}"]`);
const pageInput = (page: Page) =>
  main(page).getByRole("textbox", { name: "页码", exact: true });
const modeSwitch = (page: Page) =>
  main(page).getByRole("radiogroup", { name: "阅读方式", exact: true });
const mode = (page: Page, name: string) =>
  modeSwitch(page).getByRole("radio", { name, exact: true });
const menuButton = (page: Page) =>
  main(page).getByRole("button", { name: "翻译设置", exact: true });
const layoutPanel = (page: Page) =>
  main(page).getByRole("region", { name: "全文翻译", exact: true });
const progressBar = (page: Page) =>
  layoutPanel(page).getByRole("progressbar", { name: "翻译进度" });
const column = (page: Page, number: number) =>
  page.getByRole("group", { name: `第 ${number} 页的译文`, exact: true });
const selectionMenu = (page: Page) =>
  page.getByRole("menu", { name: "划选的文字", exact: true });

/** Drag across a line of a page's text, in whole pixels (Chromium starts no selection at a fraction of one). */
async function selectLine(page: Page, line: Locator) {
  const from = (await line.boundingBox())!;
  await page.mouse.move(
    Math.round(from.x + 2),
    Math.round(from.y + from.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.round(from.x + from.width - 2),
    Math.round(from.y + from.height / 2),
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(selectionMenu(page)).toBeVisible();
}

/** Sign in and open a paper of eight pages with the service mocked; wait for the first page to be drawn. */
async function open(
  page: Page,
  start: Partial<Service> | ((fileId: string) => Partial<Service>) = {},
) {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: PAGES });
  const service = await serve(
    page,
    paper.paperId,
    paper.fileId,
    typeof start === "function" ? start(paper.fileId) : start,
  );
  await openReader(page, { paperId: paper.paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  return { ...paper, service };
}

/** The headers a write to the API needs: the session's CSRF token and a fresh idempotency key. */
async function writeHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "paper_csrf",
  )?.value;
  expect(csrf, "sign in first").toBeTruthy();
  return { "X-CSRF-Token": csrf!, "Idempotency-Key": crypto.randomUUID() };
}

/** A second PDF on the paper, the way a finished translation leaves one; its id. */
async function addTranslatedPdf(page: Page, paperId: string): Promise<string> {
  const paper = await (
    await page.request.get(`/api/v1/papers/${paperId}`)
  ).json();
  const upload = await page.request.post(`/api/v1/papers/${paperId}/files`, {
    headers: await writeHeaders(page),
    multipart: {
      version_id: paper.current_version,
      file: {
        name: "zh-paper.pdf",
        mimeType: "application/pdf",
        buffer: pdfWithPages(PAGES, [], { words: { 1: "Translated copy" } }),
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  return (await upload.json()).id;
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

/** Through the page field, as a person does. */
async function jumpTo(page: Page, number: number) {
  await pageInput(page).fill(String(number));
  await pageInput(page).press("Enter");
  await expect(pageInput(page)).toHaveValue(String(number));
  await expectAtTop(page, number);
}

/** A mode's item exposes its selection without adding a mark to its label. */
const modeItem = (menu: Locator, label: string) =>
  menu.getByRole("menuitemradio", { name: label, exact: true });

const chosen = async (item: Locator) =>
  (await item.getAttribute("aria-checked")) === "true";

test("the strip has the reading modes, with the original chosen", async ({
  page,
}) => {
  await open(page);
  await expect(modeSwitch(page).getByRole("radio")).toHaveText([
    "原文",
    "对照",
    "译文",
  ]);
  await expect(mode(page, "原文")).toHaveAttribute("aria-checked", "true");
  await expect(mode(page, "对照")).toHaveAttribute("aria-checked", "false");
  await expect(mode(page, "译文")).toHaveAttribute("aria-checked", "false");
  await expect(menuButton(page)).toBeVisible();
  await expect(layoutPanel(page)).toHaveCount(0);
});

test("the translated view without a translation offers to make one, and starting sends the right request", async ({
  page,
}) => {
  const { fileId, service } = await open(page);

  await mode(page, "译文").click();
  await expect(mode(page, "译文")).toHaveAttribute("aria-checked", "true");
  await expect(layoutPanel(page)).toBeVisible();
  await expect(
    layoutPanel(page).getByRole("region", { name: "版面翻译", exact: true }),
  ).toContainText("未开始");
  await expect(
    layoutPanel(page).getByRole("button", { name: "开始版面翻译" }),
  ).toBeEnabled();
  // The pages are not drawn behind it.
  await expect(pdfPage(page, 1)).toHaveCount(0);

  await layoutPanel(page).getByRole("button", { name: "开始版面翻译" }).click();
  await expect
    .poll(() => service.started)
    .toEqual([
      { model_config_id: "model-1", engine: "pdf", source_file_id: fileId },
    ]);
  // The job it made is followed at once.
  await expect(progressBar(page)).toBeVisible();
  await expect(
    layoutPanel(page).getByRole("button", { name: "取消翻译" }),
  ).toBeVisible();
  await expect(
    layoutPanel(page).getByRole("button", { name: "开始版面翻译" }),
  ).toHaveCount(0);
});

test("the model chosen in the menu is the one the translation is made with", async ({
  page,
}) => {
  const { service } = await open(page);

  await menuButton(page).click();
  const items = page.getByRole("menu", { name: "翻译设置" });
  expect(
    await chosen(items.getByRole("menuitemradio", { name: /Fixture model/ })),
  ).toBe(true);
  await items.getByRole("menuitemradio", { name: /Second model/ }).click();
  await expect(items).toBeHidden();

  await mode(page, "译文").click();
  await layoutPanel(page).getByRole("button", { name: "开始版面翻译" }).click();
  await expect
    .poll(() => service.started.map((body) => body.model_config_id))
    .toEqual(["model-2"]);
});

test("a layout translation the service cannot make is said so", async ({
  page,
}) => {
  await open(page, { layout: false });

  await mode(page, "译文").click();
  await expect(
    layoutPanel(page).getByRole("region", { name: "版面翻译", exact: true }),
  ).toBeVisible();
  await expect(layoutPanel(page).getByText("未配置版面翻译")).toBeVisible();
  await expect(layoutPanel(page).getByRole("button")).toHaveCount(0);
});

test("without a model the translated view says to add one in settings", async ({
  page,
}) => {
  await open(page, { models: [] });

  await mode(page, "译文").click();
  await expect(layoutPanel(page).getByText("未配置模型")).toBeVisible();
  await expect(
    layoutPanel(page).getByRole("link", { name: "添加模型" }),
  ).toHaveAttribute("href", "#customize/models");
  // Nothing can be started without one.
  await expect(
    layoutPanel(page).getByRole("button", { name: "开始版面翻译" }),
  ).toBeDisabled();
});

test("a running translation shows how far it has got, and can be stopped", async ({
  page,
}) => {
  const { service } = await open(page, (fileId) => ({ jobs: [job(fileId)] }));

  await mode(page, "译文").click();
  await expect(progressBar(page)).toHaveAttribute("aria-valuenow", "42");
  await expect(layoutPanel(page).getByText("正在翻译第 3 页")).toBeVisible();
  await expect(layoutPanel(page).getByText("42%")).toBeVisible();

  await layoutPanel(page).getByRole("button", { name: "取消翻译" }).click();
  await expect.poll(() => service.cancelled).toEqual(["job-1"]);
  // Stopped, it can be started again.
  await expect(
    layoutPanel(page).getByRole("button", { name: "开始版面翻译" }),
  ).toBeVisible();
  await expect(progressBar(page)).toHaveCount(0);
});

test("a failed translation gives the service's reason and can be tried again", async ({
  page,
}) => {
  const { service } = await open(page, (fileId) => ({
    jobs: [
      job(fileId, {
        status: "failed",
        stage: "翻译失败",
        error: "模型没有回应，请稍后重试。",
      }),
    ],
  }));

  await mode(page, "译文").click();
  await expect(
    layoutPanel(page).getByText("模型没有回应，请稍后重试。"),
  ).toBeVisible();

  await layoutPanel(page).getByRole("button", { name: "重试" }).click();
  await expect.poll(() => service.started.length).toBe(1);
  await expect(progressBar(page)).toBeVisible();
});

test("a finished translation is read in the engine, and the modes keep the page", async ({
  page,
}) => {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: PAGES });
  const translatedId = await addTranslatedPdf(page, paper.paperId);
  await serve(page, paper.paperId, paper.fileId, {
    jobs: [
      job(paper.fileId, {
        status: "completed",
        completed: 100,
        stage: "翻译完成",
        translated_file: translatedId,
      }),
    ],
  });
  await openReader(page, { paperId: paper.paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  await expect(scroller(page)).toHaveAttribute("data-file", paper.fileId);

  await jumpTo(page, 5);

  // The translated PDF, at the page that was being read.
  await mode(page, "译文").click();
  await main(page).getByRole("radio", { name: "仅译文", exact: true }).click();
  await expect(scroller(page)).toHaveAttribute("data-file", translatedId);
  await expect(layoutPanel(page)).toHaveCount(0);
  await expect(pdfPage(page, 5)).toHaveAttribute("data-rendered", "true");
  await expect(pageInput(page)).toHaveValue("5");
  await expectAtTop(page, 5);

  // Read on in it, then back to the original at that page.
  await jumpTo(page, 7);
  await mode(page, "原文").click();
  await expect(scroller(page)).toHaveAttribute("data-file", paper.fileId);
  await expect(pdfPage(page, 7)).toHaveAttribute("data-rendered", "true");
  await expect(pageInput(page)).toHaveValue("7");
  await expectAtTop(page, 7);
  await expect(mode(page, "原文")).toHaveAttribute("aria-checked", "true");
});

test("the side by side view keeps the page and the original while it is built", async ({
  page,
}) => {
  await open(page);
  await jumpTo(page, 4);

  await mode(page, "对照").click();
  await expect(mode(page, "对照")).toHaveAttribute("aria-checked", "true");
  await expect(column(page, 4)).toBeVisible();
  await expect(pageInput(page)).toHaveValue("4");
  await expectAtTop(page, 4);
  await expect(layoutPanel(page)).toHaveCount(0);

  // Translating the page again is offered here, and only here.
  await menuButton(page).click();
  const items = page.getByRole("menu", { name: "翻译设置" });
  await expect(
    items.getByRole("menuitem", { name: "重新翻译这一页" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await mode(page, "原文").click();
  await expect(column(page, 4)).toHaveCount(0);
  await expect(pageInput(page)).toHaveValue("4");
  await expectAtTop(page, 4);
  await menuButton(page).click();
  await expect(
    items.getByRole("menuitem", { name: "重新翻译这一页" }),
  ).toHaveCount(0);
});

test("对照 through the switch puts a column beside the page, translated as the menu says", async ({
  page,
}) => {
  const { fileId, service } = await open(page);
  const items = page.getByRole("menu", { name: "翻译设置" });
  await menuButton(page).click();
  await items.getByRole("menuitemradio", { name: /译为 English/ }).click();
  await expect(items).toBeHidden();
  await menuButton(page).click();
  await items.getByRole("menuitemradio", { name: /Second model/ }).click();
  await expect(items).toBeHidden();
  // Nothing is translated page by page until 对照 is chosen.
  await page.waitForTimeout(500);
  expect(service.pageAsks).toEqual([]);

  await mode(page, "对照").click();
  await expect(column(page, 1)).toBeVisible();
  const [sheet, side] = await Promise.all([
    pdfPage(page, 1).boundingBox(),
    column(page, 1).boundingBox(),
  ]);
  expect(side!.x).toBeGreaterThan(sheet!.x + sheet!.width);
  expect(Math.abs(side!.y - sheet!.y)).toBeLessThan(2);
  await expect
    .poll(() => service.pageAsks[0])
    .toMatchObject({
      file_id: fileId,
      kind: "page_translation",
      page: 1,
      language: "en",
      model_config_id: "model-2",
    });
  expect(service.pageAsks.every((body) => body.language === "en")).toBe(true);
});

test("重新翻译这一页 asks for the page being read anew", async ({ page }) => {
  const { service } = await open(page);
  await jumpTo(page, 3);
  await mode(page, "对照").click();
  await expect(column(page, 3)).toBeVisible();
  await expect
    .poll(() => service.pageAsks.map((body) => body.page))
    .toContain(3);
  expect(service.pageAsks.some((body) => body.regenerate)).toBe(false);
  await expect(pageInput(page)).toHaveValue("3");

  await menuButton(page).click();
  await page
    .getByRole("menu", { name: "翻译设置" })
    .getByRole("menuitem", { name: "重新翻译这一页" })
    .click();
  await expect
    .poll(() => service.pageAsks.at(-1))
    .toMatchObject({ page: 3, regenerate: true, language: "zh" });
  expect(service.pageAsks.filter((body) => body.regenerate)).toHaveLength(1);
});

test("in 译文 the translated PDF's text is selected as ever, but not highlighted", async ({
  page,
}) => {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: PAGES });
  const translatedId = await addTranslatedPdf(page, paper.paperId);
  await serve(page, paper.paperId, paper.fileId, {
    jobs: [
      job(paper.fileId, {
        status: "completed",
        completed: 100,
        stage: "翻译完成",
        translated_file: translatedId,
      }),
    ],
  });
  await openReader(page, { paperId: paper.paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/annotations"))
      writes.push(request.url());
  });

  await mode(page, "译文").click();
  await main(page).getByRole("radio", { name: "仅译文", exact: true }).click();
  await expect(scroller(page)).toHaveAttribute("data-file", translatedId);
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  await selectLine(
    page,
    pdfPage(page, 1).locator(".textLayer span", { hasText: "Translated copy" }),
  );
  const highlight = selectionMenu(page).getByRole("menuitem", {
    name: "高亮",
    exact: true,
  });
  await expect(highlight).toHaveAttribute("aria-disabled", "true");
  await expect(highlight).toHaveAccessibleDescription("译文 PDF 上不能高亮");
  await highlight.hover();
  await expect(page.locator('[role="tooltip"]')).toHaveText(
    "译文 PDF 上不能高亮",
  );
  // Its key says so too; the row stays, the rest of it as it was.
  await page.keyboard.press("h");
  await expect(
    page.getByRole("status").filter({ hasText: "译文 PDF 上不能高亮" }),
  ).toBeVisible();
  await expect(selectionMenu(page)).toBeVisible();
  await expect(
    selectionMenu(page).getByRole("menuitem", { name: "解释", exact: true }),
  ).not.toHaveAttribute("aria-disabled");
  expect(writes).toEqual([]);

  // On the paper's own PDF it highlights as ever.
  await page.keyboard.press("Escape");
  await mode(page, "原文").click();
  await expect(scroller(page)).toHaveAttribute("data-file", paper.fileId);
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  await selectLine(
    page,
    pdfPage(page, 1).locator(".textLayer span", { hasText: "Page 1 of" }),
  );
  await expect(highlight).not.toHaveAttribute("aria-disabled");
});

test("the language chosen in the menu is kept for the next visit", async ({
  page,
}) => {
  await open(page);

  await menuButton(page).click();
  const items = page.getByRole("menu", { name: "翻译设置" });
  // The interface is Chinese, so is the language to start with.
  expect(
    await chosen(items.getByRole("menuitemradio", { name: /译为中文/ })),
  ).toBe(true);
  expect(
    await chosen(items.getByRole("menuitemradio", { name: /译为 English/ })),
  ).toBe(false);
  await items.getByRole("menuitemradio", { name: /译为 English/ }).click();
  await expect(items).toBeHidden();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("paper-translation-language"),
    ),
  ).toBe("en");

  await page.reload();
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  await menuButton(page).click();
  expect(
    await chosen(items.getByRole("menuitemradio", { name: /译为 English/ })),
  ).toBe(true);
  expect(
    await chosen(items.getByRole("menuitemradio", { name: /译为中文/ })),
  ).toBe(false);
});

// Where the strip is short of room, the reading modes are one menu; elsewhere a switch and a menu beside it.
for (const [width, compact] of [
  [560, true],
  [600, true],
  [1280, true],
  [1440, false],
] as const) {
  test(`the strip fits a ${width}px window with the modes ${compact ? "in one menu" : "as a switch"}`, async ({
    page,
  }) => {
    await signIn(page);
    const paper = await createPaperWithPdf(page, { pages: PAGES });
    await serve(page, paper.paperId, paper.fileId);
    await page.setViewportSize({ width, height: 800 });
    await openReader(page, { paperId: paper.paperId });
    await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");

    const card = (await main(page).boundingBox())!;
    const within = async (locator: Locator) => {
      const box = (await locator.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(card.x);
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
    };
    const more = main(page).getByRole("button", { name: "更多", exact: true });
    await within(more);
    // The title keeps some room.
    const heading = main(page).getByRole("heading", { level: 1 });
    expect((await heading.boundingBox())!.width).toBeGreaterThan(
      width < 700 ? 60 : 100,
    );

    if (!compact) {
      await within(modeSwitch(page));
      await within(menuButton(page));
      return;
    }
    // One menu: the modes and the translation settings, its button saying which mode is chosen.
    await expect(modeSwitch(page)).toHaveCount(0);
    const button = main(page).getByRole("button", { name: /^阅读方式：/ });
    await expect(button).toHaveAccessibleName("阅读方式：原文");
    await within(button);
    await button.click();
    const items = page.getByRole("menu", { name: "翻译设置" });
    await expect(items.getByRole("menuitemradio")).toHaveText([
      /原文/,
      /对照/,
      /译文/,
      /译为中文/,
      /译为 English/,
      /Fixture model/,
      /Second model/,
    ]);
    expect(
      await chosen(items.getByRole("menuitemradio", { name: /原文/ })),
    ).toBe(true);
    await items.getByRole("menuitemradio", { name: /译文/ }).click();
    await expect(button).toHaveAccessibleName("阅读方式：译文");
    await expect(layoutPanel(page)).toBeVisible();
  });
}

test("where not even one button fits, the modes are in the more menu", async ({
  page,
}) => {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: PAGES });
  await serve(page, paper.paperId, paper.fileId);
  await page.setViewportSize({ width: 375, height: 800 });
  await openReader(page, { paperId: paper.paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");

  await expect(modeSwitch(page)).toHaveCount(0);
  await expect(
    main(page).getByRole("button", { name: /^阅读方式：/ }),
  ).toHaveCount(0);
  await main(page).getByRole("button", { name: "更多", exact: true }).click();
  const items = page.getByRole("menu", { name: "更多", exact: true });
  expect(await chosen(modeItem(items, "原文"))).toBe(true);
  await expect(modeItem(items, "对照")).toBeVisible();
  await expect(
    items.getByRole("menuitemradio", { name: /译为 English/ }),
  ).toBeVisible();
  await expect(
    items.getByRole("menuitemradio", { name: /Second model/ }),
  ).toBeVisible();
  // The rest of the menu is still there.
  await expect(items.getByRole("menuitem", { name: "下载…" })).toBeVisible();

  await modeItem(items, "译文").click();
  await expect(layoutPanel(page)).toBeVisible();
  await main(page).getByRole("button", { name: "更多", exact: true }).click();
  expect(await chosen(modeItem(items, "译文"))).toBe(true);
});

test.describe("in English", () => {
  test.use({ locale: "en-US" });

  test("the modes, the menu and the panel have no stray Chinese", async ({
    page,
  }) => {
    await signIn(page);
    const paper = await createPaperWithPdf(page, { pages: PAGES });
    await serve(page, paper.paperId, paper.fileId);
    await openReader(page, { paperId: paper.paperId });
    await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");

    const radios = main(page)
      .getByRole("radiogroup", { name: "Reading mode", exact: true })
      .getByRole("radio");
    await expect(radios).toHaveText(["Original", "Parallel", "Translated"]);

    await main(page)
      .getByRole("button", { name: "Translation settings", exact: true })
      .click();
    const menu = page.getByRole("menu", { name: "Translation settings" });
    await expect(menu).toContainText("Translate to Chinese");
    await expect(menu).toContainText("Fixture model");
    expect(await menu.textContent()).not.toMatch(/[一-鿿]/);
    await page.keyboard.press("Escape");

    await radios.nth(2).click();
    const panel = main(page).getByRole("region", {
      name: "Full translation",
      exact: true,
    });
    await expect(
      panel.getByRole("button", { name: "Start layout translation" }),
    ).toBeVisible();
    expect(await panel.textContent()).not.toMatch(/[一-鿿]/);
  });
});
