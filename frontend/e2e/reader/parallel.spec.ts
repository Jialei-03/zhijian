import { expect, test, type Locator, type Page } from "@playwright/test";
import { createPaperWithPdf, openReader, signIn } from "./fixtures";

// The interface follows the browser's language; these specs read it in Chinese.
test.use({ locale: "zh-CN" });

const MODEL = { id: "fixture-model", name: "Fixture model", model: "fixture" };

type Row = Record<string, unknown>;
type Paragraph = { kind: string; original: string; translation: string };
type Reply = { status: number; json: unknown };

/** Everything the mocked service holds about the translations; a test changes it while the page runs. */
type Service = {
  models: unknown[];
  /** The page translations, by id, oldest first. */
  rows: Map<string, Row>;
  /** The bodies of the requests that asked for a page's translation, and when they came. */
  posts: (Row & { at: number })[];
  /** How a request for a page is answered; by default with a translation just started. */
  answer: (body: Row, service: Service) => Reply | undefined;
};

/** A page's translation, as the service has it. */
function translation(fileId: string, page: number, fields: Row = {}): Row {
  return {
    id: `pt-${page}`,
    file_id: fileId,
    kind: "page_translation",
    status: "running",
    run_id: `run-${page}`,
    model_config_id: MODEL.id,
    error: "",
    parameters: { page, language: "zh" },
    result: null,
    ...fields,
  };
}

/** Changes the translation of a page (the next read of it gets this). */
function update(service: Service, page: number, fields: Row) {
  const row = service.rows.get(`pt-${page}`)!;
  service.rows.set(`pt-${page}`, { ...row, ...fields });
}

const sentences = (page: number): Paragraph[] => [
  {
    kind: "heading",
    original: `Page ${page} of 5`,
    translation: `第 ${page} 页（共 5 页）`,
  },
  {
    kind: "text",
    original: "A sentence.",
    translation: `第 ${page} 页的第一句译文。`,
  },
  {
    kind: "caption",
    original: "Figure 1.",
    translation: `第 ${page} 页的图注。`,
  },
  { kind: "page_number", original: `${page}`, translation: `${page}` },
];

/** The service's answers about translations and models, in place of the model: set before 对照 is chosen. */
async function serve(
  page: Page,
  paperId: string,
  fileId: string,
  start: Partial<Service> = {},
): Promise<Service> {
  const service: Service = {
    models: [MODEL],
    rows: new Map(),
    posts: [],
    answer: (body) => {
      const row = translation(fileId, body.page as number);
      service.rows.set(row.id as string, row);
      return { status: 200, json: row };
    },
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
  await page.route(`**/api/v1/papers/${paperId}/reading-artifacts`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: [...service.rows.values()].reverse() });
    const body = route.request().postDataJSON() as Row;
    if (body.kind !== "page_translation") return route.fallback();
    service.posts.push({ ...body, at: Date.now() });
    const reply = service.answer(body, service)!;
    return route.fulfill(
      reply.status === 200
        ? { json: reply.json }
        : { status: reply.status, json: { detail: reply.json } },
    );
  });
  await page.route("**/api/v1/reading-artifacts/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const row = service.rows.get(id);
    return row
      ? route.fulfill({ json: row })
      : route.fulfill({ status: 404, json: { detail: "not found" } });
  });
  return service;
}

const pdfPage = (page: Page, number: number) =>
  page.locator(`[data-page="${number}"]`);
const column = (page: Page, number: number) =>
  page.getByRole("group", { name: `第 ${number} 页的译文`, exact: true });
const status = (page: Page, number: number) =>
  column(page, number).getByRole("status");
const mode = (page: Page, name: "原文" | "对照") =>
  page
    .getByRole("radiogroup", { name: "阅读方式" })
    .getByRole("radio", { name, exact: true });
/** Where the strip has no room for the switch, the reading modes are in one menu, its button saying the chosen one. */
async function chooseInMenu(page: Page, name: "原文" | "对照") {
  await page
    .getByRole("main")
    .getByRole("button", { name: /^阅读方式：/ })
    .click();
  await page
    .getByRole("menu", { name: "翻译设置" })
    .getByRole("menuitemradio", { name, exact: true })
    .click();
}
const pageInput = (page: Page) =>
  page.getByRole("main").getByRole("textbox", { name: "页码", exact: true });
const menu = (page: Page) =>
  page.getByRole("menu", { name: "划选的文字", exact: true });
const pagesAsked = (service: Service) => service.posts.map((post) => post.page);

const box = async (locator: Locator) => (await locator.boundingBox())!;

/**
 * A paper of five pages, opened in the reader once the first page is drawn.
 * The pages are twice a letter page's height, so that only the first is in
 * view at the top.
 */
async function open(
  page: Page,
  start: (fileId: string) => Partial<Service> = () => ({}),
) {
  await signIn(page);
  const { paperId, fileId } = await createPaperWithPdf(page, {
    pages: 5,
    size: [612, 1584],
  });
  const service = await serve(page, paperId, fileId, start(fileId));
  await openReader(page, { paperId });
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  return { service, paperId, fileId };
}

test("对照 translates the page in view first, beside it, as it is written", async ({
  page,
}) => {
  const { service, fileId } = await open(page);
  await expect(mode(page, "原文")).toBeChecked();
  await expect(column(page, 1)).toHaveCount(0);
  // Nothing is asked of the service until 对照 is chosen.
  expect(service.posts).toEqual([]);

  await mode(page, "对照").click();
  await expect(column(page, 1)).toBeVisible();

  // The page in view first, then the one after it: two at once, no more.
  await expect.poll(() => pagesAsked(service)).toEqual([1, 2]);
  expect(service.posts[0]).toMatchObject({
    file_id: fileId,
    model_config_id: MODEL.id,
    kind: "page_translation",
    page: 1,
    language: "zh",
  });
  expect(service.posts[0].regenerate).toBeUndefined();

  // The column is beside the page, level with its top, and the page takes 56% of the room.
  const sheet = await box(pdfPage(page, 1));
  const side = await box(column(page, 1));
  expect(side.x).toBeGreaterThan(sheet.x + sheet.width);
  expect(Math.abs(side.y - sheet.y)).toBeLessThan(2);
  const room = side.x + side.width - sheet.x;
  expect(sheet.width / (room - (side.x - sheet.x - sheet.width))).toBeCloseTo(
    0.56,
    1,
  );
  await expect(status(page, 1)).toHaveText("翻译中…");

  // What the model has written so far shows as it comes.
  update(service, 1, { preview: { paragraphs: sentences(1).slice(0, 1) } });
  await expect(column(page, 1)).toContainText("第 1 页（共 5 页）");
  await expect(column(page, 1)).not.toContainText("第 1 页的第一句译文。");
  await expect(status(page, 1)).toHaveText("翻译中…");
  update(service, 1, { preview: { paragraphs: sentences(1).slice(0, 2) } });
  await expect(column(page, 1)).toContainText("第 1 页的第一句译文。");

  // Done: all of it, the heading stronger and the caption quieter; the page number is not repeated.
  update(service, 1, {
    status: "completed",
    preview: undefined,
    result: { paragraphs: sentences(1) },
  });
  await expect(status(page, 1)).toHaveText("已翻译");
  const lines = column(page, 1).locator("p[data-kind]");
  await expect(lines).toHaveText([
    "第 1 页（共 5 页）",
    "第 1 页的第一句译文。",
    "第 1 页的图注。",
  ]);
  const look = (index: number) =>
    lines
      .nth(index)
      .evaluate((element) => [
        getComputedStyle(element).fontWeight,
        getComputedStyle(element).fontSize,
      ]);
  expect((await look(0))[0]).toBe("600");
  expect((await look(1))[1]).toBe("14px");
  expect(parseFloat((await look(2))[1])).toBeLessThan(14);

  // A third page waits for one of the two to be done.
  expect(pagesAsked(service)).toEqual([1, 2]);
  update(service, 2, {
    status: "completed",
    result: { paragraphs: sentences(2) },
  });
  await expect(column(page, 2)).toContainText("第 2 页的第一句译文。");

  // Scrolled on to page 3, it is translated next: the service is busy at first, and asked again
  // two seconds later.
  service.answer = (body, service) => {
    const asked = service.posts.filter((post) => post.page === body.page);
    if (body.page === 3 && asked.length === 1)
      return { status: 409, json: "最多同时翻译 2 页，请稍候" };
    const row = translation(fileId, body.page as number);
    service.rows.set(row.id as string, row);
    return { status: 200, json: row };
  };
  await pageInput(page).fill("3");
  await pageInput(page).press("Enter");
  await expect.poll(() => pagesAsked(service).slice(2, 3)).toEqual([3]);
  await expect(status(page, 3)).toHaveText("翻译中…");
  await expect
    .poll(() => service.posts.filter((post) => post.page === 3).length, {
      timeout: 10000,
    })
    .toBe(2);
  const [first, again] = service.posts.filter((post) => post.page === 3);
  expect(again.at - first.at).toBeGreaterThanOrEqual(1900);
  update(service, 3, {
    status: "completed",
    result: { paragraphs: sentences(3) },
  });
  await expect(column(page, 3)).toContainText("第 3 页的第一句译文。");
  // The next page after it, too (the one before is done already).
  await expect.poll(() => pagesAsked(service)).toContain(4);
  expect(pagesAsked(service).filter((number) => number === 1)).toEqual([1]);
});

test("a page that failed says why, and is translated again on retry", async ({
  page,
}) => {
  const { service } = await open(page, (fileId) => ({
    answer: (body, service) => {
      if (body.page === 1 && !body.regenerate)
        return {
          status: 422,
          json: "指定页面没有已核验的文字；扫描页请使用视觉助手",
        };
      const row = translation(fileId, body.page as number);
      service.rows.set(row.id as string, row);
      return { status: 200, json: row };
    },
  }));
  await mode(page, "对照").click();

  await expect(status(page, 1)).toHaveText("失败");
  await expect(column(page, 1).getByRole("alert")).toHaveText(
    "指定页面没有已核验的文字；扫描页请使用视觉助手",
  );

  // A translation that fails while it is written says the service's reason too.
  await expect(status(page, 2)).toHaveText("翻译中…");
  update(service, 2, { status: "failed", error: "模型服务暂时不可用" });
  await expect(status(page, 2)).toHaveText("失败");
  await expect(column(page, 2).getByRole("alert")).toHaveText(
    "模型服务暂时不可用",
  );

  // Retry asks for the page anew.
  await column(page, 1).getByRole("button", { name: "重试" }).click();
  await expect
    .poll(() => service.posts.at(-1))
    .toMatchObject({
      page: 1,
      regenerate: true,
    });
  await expect(status(page, 1)).toHaveText("翻译中…");
  await expect(column(page, 1).getByRole("alert")).toHaveCount(0);
  update(service, 1, {
    status: "completed",
    result: { paragraphs: sentences(1) },
  });
  await expect(column(page, 1)).toContainText("第 1 页的第一句译文。");
  await expect(status(page, 1)).toHaveText("已翻译");
  // The other failure stays until it is retried itself.
  await expect(status(page, 2)).toHaveText("失败");
  expect(service.posts.filter((post) => post.page === 2)).toHaveLength(1);
});

test("prepared page failures stay on their own page and out of the guide", async ({
  page,
}) => {
  await page.route("**/api/v1/papers/*/preparation", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        status: "failed",
        guide_status: "failed",
        translation_status: "failed",
        layout_status: "unavailable",
        error: "导读失败；第 1 页翻译失败；第 2 页翻译失败",
      },
    }),
  );
  await open(page, (fileId) => ({
    rows: new Map([
      [
        "pt-1",
        translation(fileId, 1, { status: "failed", error: "第 1 页翻译失败" }),
      ],
      [
        "pt-2",
        translation(fileId, 2, { status: "failed", error: "第 2 页翻译失败" }),
      ],
      [
        "guide-1",
        {
          id: "guide-1",
          file_id: fileId,
          kind: "guide",
          status: "failed",
          error: "导读失败",
          parameters: { preparation_id: "preparation-1" },
        },
      ],
    ]),
  }));
  const assistant = page.getByRole("tabpanel");
  await expect(assistant.getByRole("alert")).toHaveText("导读失败");
  await expect(assistant).not.toContainText("翻译失败");
  await mode(page, "对照").click();
  await expect(column(page, 1).getByRole("alert")).toHaveText(
    "第 1 页翻译失败",
  );
  await expect(column(page, 1)).not.toContainText("第 2 页翻译失败");
  await expect(column(page, 2).getByRole("alert")).toHaveText(
    "第 2 页翻译失败",
  );
});

test("a regenerate that fails keeps the earlier translation beside the reason", async ({
  page,
}) => {
  const earlier = { paragraphs: sentences(1) };
  const { service } = await open(page, (fileId) => ({
    // As after a reload: the last regenerate failed, the earlier result is kept.
    rows: new Map([
      [
        "pt-1",
        translation(fileId, 1, {
          status: "failed",
          error: "模型服务暂时不可用",
          result: {},
          previous: earlier,
        }),
      ],
    ]),
    answer: (body, service) => {
      const row = translation(fileId, body.page as number, {
        previous: body.page === 1 ? earlier : null,
      });
      service.rows.set(row.id as string, row);
      return { status: 200, json: row };
    },
  }));
  await mode(page, "对照").click();
  await expect(status(page, 1)).toHaveText("失败");
  await expect(column(page, 1).getByRole("alert")).toHaveText(
    "模型服务暂时不可用",
  );
  await expect(column(page, 1)).toContainText("第 1 页的第一句译文。");

  // Retry: the earlier translation stays while the new one is written.
  await column(page, 1).getByRole("button", { name: "重试" }).click();
  await expect(status(page, 1)).toHaveText("翻译中…");
  await expect(column(page, 1)).toContainText("第 1 页的第一句译文。");

  // It fails again: still there, with the reason and a retry.
  update(service, 1, { status: "failed", error: "模型服务暂时不可用" });
  await expect(status(page, 1)).toHaveText("失败");
  await expect(column(page, 1)).toContainText("第 1 页的第一句译文。");
  await expect(
    column(page, 1).getByRole("button", { name: "重试" }),
  ).toBeVisible();

  // Only a completed one replaces it.
  await column(page, 1).getByRole("button", { name: "重试" }).click();
  update(service, 1, {
    status: "completed",
    result: {
      paragraphs: [{ kind: "text", original: "A", translation: "新译文" }],
    },
    previous: null,
  });
  await expect(column(page, 1)).toContainText("新译文");
  await expect(column(page, 1)).not.toContainText("第 1 页的第一句译文。");
});

test("in 对照 text on the page is still selected, a sentence hovered is marked on it, and 原文 gives the page back its width", async ({
  page,
}) => {
  const { service } = await open(page, (fileId) => ({
    rows: new Map([
      [
        "pt-1",
        translation(fileId, 1, {
          status: "completed",
          result: { paragraphs: sentences(1) },
        }),
      ],
    ]),
  }));
  const before = await box(pdfPage(page, 1));

  await mode(page, "对照").click();
  await expect(status(page, 1)).toHaveText("已翻译");
  // A translation there already is shown, not asked for again.
  await expect.poll(() => pagesAsked(service)).toEqual([2]);
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
  const beside = await box(pdfPage(page, 1));
  expect(beside.width).toBeLessThan(before.width);

  // Hovering a sentence marks its original on the page; leaving it takes the mark away.
  const heading = column(page, 1).getByText("第 1 页（共 5 页）");
  await heading.hover();
  const mark = pdfPage(page, 1).locator("[data-hover-quote]");
  await expect(mark).toHaveCount(1);
  await expect(mark.locator(".pdf-reference-underline")).toHaveCount(1);
  const underline = await box(mark.locator(".pdf-reference-underline"));
  const words = await box(
    pdfPage(page, 1).locator(".textLayer span", { hasText: "Page 1 of 5" }),
  );
  expect(Math.abs(underline.y - words.y)).toBeLessThan(6);
  await page.mouse.move(beside.x + beside.width / 2, beside.y + 600);
  await expect(mark).toHaveCount(0);

  // Text on the page is selected as in 原文, and the menu comes for it.
  const line = pdfPage(page, 1).locator(".textLayer span", {
    hasText: "Page 1 of 5",
  });
  const from = await box(line);
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
  await expect(menu(page)).toBeVisible();
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toContain("Page 1 of");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  // Back to 原文: no column, and the page is as wide as it was.
  await mode(page, "原文").click();
  await expect(column(page, 1)).toHaveCount(0);
  await expect
    .poll(async () => (await box(pdfPage(page, 1))).width)
    .toBeCloseTo(before.width, 0);
  await expect(pdfPage(page, 1)).toHaveAttribute("data-rendered", "true");
});

test("without a model, 对照 says to add one in settings and asks for nothing", async ({
  page,
}) => {
  const { service } = await open(page, () => ({ models: [] }));
  await mode(page, "对照").click();

  await expect(column(page, 1)).toContainText("未配置模型");
  await expect(
    column(page, 1).getByRole("link", { name: "添加模型" }),
  ).toHaveAttribute("href", "#customize/models");
  await page.waitForTimeout(1000);
  expect(service.posts).toEqual([]);
});

test("in a card too narrow for a column beside the page, the translation goes under it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await open(page, (fileId) => ({
    rows: new Map([
      [
        "pt-1",
        translation(fileId, 1, {
          status: "completed",
          result: { paragraphs: sentences(1) },
        }),
      ],
    ]),
  }));
  const before = await box(pdfPage(page, 1));
  await chooseInMenu(page, "对照");
  await expect(status(page, 1)).toHaveText("已翻译");

  const sheet = await box(pdfPage(page, 1));
  const under = await box(column(page, 1));
  // The page keeps the width it had; its translation is under it, as wide as the room.
  expect(sheet.width).toBeCloseTo(before.width, 0);
  expect(under.y).toBeGreaterThan(sheet.y + sheet.height);
  expect(under.width).toBeGreaterThanOrEqual(sheet.width - 1);
  await expect(column(page, 1)).toContainText("第 1 页的第一句译文。");
});
