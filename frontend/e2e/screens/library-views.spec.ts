import { expect, test, type Page } from "@playwright/test";
import { createPaperWithPdf, signIn } from "../reader/fixtures";

// The screens follow the browser's language; these specs read them in Chinese.
test.use({ locale: "zh-CN" });

const LIBRARY = "/#library";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        active_id: "model-1",
        configured: true,
        models: [{ id: "model-1" }],
      },
    }),
  );
});

/** Changes fields of a paper through the API, the way the web app does. */
async function patchPaper(
  page: Page,
  paperId: string,
  data: Record<string, unknown>,
) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "paper_csrf",
  )!.value;
  const current = await (
    await page.request.get(`/api/v1/papers/${paperId}`)
  ).json();
  const response = await page.request.patch(`/api/v1/papers/${paperId}`, {
    headers: {
      "X-CSRF-Token": csrf,
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": String(current.revision),
    },
    data,
  });
  expect(response.ok()).toBeTruthy();
}

test("the library starts as a list, opens paper cards on request and remembers either view", async ({
  page,
}) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const paper = await createPaperWithPdf(page, {
    title: `Cards Paper ${stamp}`,
    pages: 5,
  });
  await patchPaper(page, paper.paperId, { external_id: "arxiv:2301.12345" });
  await page.goto(LIBRARY);
  const library = page.getByRole("main");
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);

  const card = library.locator(`[data-paper="${paper.paperId}"]`);
  const view = library.getByRole("radiogroup", { name: "视图" });
  await expect(library.locator("[data-view=list]")).toBeVisible();
  await view.getByRole("radio", { name: "卡片" }).click();
  await expect(library.locator("[data-view=grid]")).toBeVisible();
  // The first page is the server's picture, not drawn in the browser.
  await expect(card.locator('img[data-thumb="image"]')).toHaveAttribute(
    "src",
    /^\/api\/v1\/files\/[0-9a-f-]+\/thumbnail$/,
  );
  await expect(card.getByRole("heading", { name: paper.title })).toBeVisible();
  await expect(card).toContainText("A. Author, B. Author");
  await expect(card.getByRole("progressbar")).toHaveCount(0);

  // The list is a table; the choice is remembered.
  await view.getByRole("radio", { name: "列表" }).click();
  await expect(library.locator("[data-view=list]")).toBeVisible();
  await expect(
    library.getByRole("row", { name: new RegExp(paper.title) }),
  ).toBeVisible();
  await page.reload();
  await expect(library.locator("[data-view=list]")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("paper-library-view")),
  ).toBe("list");
  await view.getByRole("radio", { name: "卡片" }).click();
  await expect(library.locator("[data-view=grid]")).toBeVisible();
  await page.reload();
  await expect(library.locator("[data-view=grid]")).toBeVisible();
});

test("the source column abbreviates conferences and keeps source capitalization", async ({
  page,
}) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const examples = [
    ["neural information processing systems", "NeurIPS"],
    ["conference on empirical methods in natural language processing", "EMNLP"],
    ["eLife", "eLife"],
    ["journal of unusual results", "Journal Of Unusual Results"],
  ];
  const records: Record<
    string,
    { paper_id: string; status: "ok"; venue: string }
  > = {};
  const papers = [];
  for (const [venue, label] of examples) {
    const paper = await createPaperWithPdf(page, {
      title: `${label} ${stamp}`,
    });
    records[paper.paperId] = { paper_id: paper.paperId, status: "ok", venue };
    papers.push({ id: paper.paperId, venue, label });
  }
  await page.route("**/api/v1/paper-metadata", (route) =>
    route.fulfill({ json: records }),
  );
  await page.goto(LIBRARY);
  const library = page.getByRole("main");
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);
  await expect(
    library.getByRole("columnheader", { name: "来源", exact: true }),
  ).toBeVisible();
  for (const { id, label } of papers) {
    const source = library
      .locator(`[data-paper="${id}"]`)
      .getByRole("cell")
      .nth(1);
    await expect(source).toHaveText(label);
    await expect(source).toHaveAttribute("title", label);
  }
  // Formatting belongs to the view: API records still contain their source text.
  const response = await page.evaluate(async () =>
    (await fetch("/api/v1/paper-metadata")).json(),
  );
  for (const { id, venue } of papers) expect(response[id].venue).toBe(venue);
});

test("the list shows when a paper was last opened", async ({ page }) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const paper = await createPaperWithPdf(page, {
    title: `Progress Paper ${stamp}`,
    pages: 8,
  });
  // Read to page 4: the reader writes the page down once it has settled there.
  await page.goto(`/#read/${paper.paperId}`);
  const pageInput = page
    .getByRole("main")
    .getByRole("textbox", { name: "页码", exact: true });
  await pageInput.fill("4");
  await pageInput.press("Enter");
  await expect(pageInput).toHaveValue("4");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("paper-last-page:"))
            .map((key) => JSON.parse(localStorage.getItem(key)!)[id])
            .find(Boolean),
        paper.paperId,
      ),
    )
    .toBe(4);
  await page.goto(LIBRARY);
  const library = page.getByRole("main");
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);
  const card = library.locator(`[data-paper="${paper.paperId}"]`);
  await expect(card.locator("time")).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T/,
  );
  await expect(
    library.getByRole("columnheader", { name: "上次打开时间" }),
  ).toBeVisible();
});

test("papers can be sorted by title and by when they were added", async ({
  page,
}) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const bravo = await createPaperWithPdf(page, { title: `Bravo ${stamp}` });
  const alpha = await createPaperWithPdf(page, { title: `Alpha ${stamp}` });
  await page.goto(LIBRARY);
  const library = page.getByRole("main");
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);
  const order = () =>
    library
      .locator("[data-paper]")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-paper")),
      );

  const sort = library.getByRole("button", { name: /^排序：/ });
  await sort.click();
  await page.getByRole("menuitem", { name: "标题" }).click();
  await expect.poll(order).toEqual([alpha.paperId, bravo.paperId]);
  await expect(sort).toHaveText(/标题/);

  await sort.click();
  await page.getByRole("menuitem", { name: "最近添加" }).click();
  // The last one added comes first.
  await expect.poll(order).toEqual([alpha.paperId, bravo.paperId]);
  await sort.click();
  await page.getByRole("menuitem", { name: "标题" }).click();
  await patchPaper(page, bravo.paperId, { title: `Aardvark ${stamp}` });
  await page.reload();
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);
  await expect.poll(order).toEqual([bravo.paperId, alpha.paperId]);
  expect(
    await page.evaluate(() => localStorage.getItem("paper-library-sort")),
  ).toBe("title");
});

test("the details sheet shows a paper, stars it and edits its title", async ({
  page,
}) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const paper = await createPaperWithPdf(page, {
    title: `Details Paper ${stamp}`,
    pages: 3,
  });
  await patchPaper(page, paper.paperId, { external_id: "arxiv:2105.01234v2" });
  await page.goto(LIBRARY);
  const library = page.getByRole("main");
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);
  await library.getByRole("button", { name: `${paper.title} 的操作` }).click();
  await page.getByRole("menuitem", { name: "论文详情" }).click();

  const sheet = page.getByRole("dialog", { name: "论文详情" });
  await expect(sheet).toContainText(paper.title);
  await expect(sheet).toContainText("A. Author, B. Author");
  await expect(sheet).toContainText(
    "A paper made for the reader's browser tests.",
  );
  await expect(
    sheet.getByRole("link", { name: /arXiv:2105\.01234/ }),
  ).toHaveAttribute("href", "https://arxiv.org/abs/2105.01234");
  await expect(sheet.getByText("3 页")).toBeVisible();
  await expect(sheet.getByText("高亮")).toBeVisible();
  await expect(sheet.getByText("添加时间")).toBeVisible();
  await expect(sheet.getByText("未读", { exact: true }).first()).toBeVisible();

  // Star.
  await sheet.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "收藏", exact: true }).click();
  await sheet.getByRole("button", { name: "更多", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "已收藏", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(
    (await (await page.request.get(`/api/v1/papers/${paper.paperId}`)).json())
      .favorite,
  ).toBe(true);

  // Edit the title.
  await sheet.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const renamed = `Renamed ${stamp}`;
  await sheet.getByRole("textbox", { name: "标题" }).fill(renamed);
  await sheet.getByRole("button", { name: "保存", exact: true }).click();
  await expect(sheet.getByRole("heading", { name: renamed })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/v1/papers/${paper.paperId}`)).json())
      .title,
  ).toBe(renamed);

  // Open.
  await sheet.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#read/${paper.paperId}$`));
});

test("the reader's menu opens the same details", async ({ page }) => {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: 2 });
  await page.goto(`/#read/${paper.paperId}`);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "论文详情" }).click();
  const sheet = page.getByRole("dialog", { name: "论文详情" });
  await expect(sheet).toContainText(paper.title);
  await expect(sheet.getByText(/^2 页 ·/)).toBeVisible();
});

test("covers come from the thumbnail route and the PDF itself is not downloaded", async ({
  browser,
  baseURL,
}) => {
  // A fresh context: routed pages (the other specs mock models) switch the HTTP cache off.
  const context = await browser.newContext({ baseURL, locale: "zh-CN" });
  const page = await context.newPage();
  await signIn(page);
  const stamp = Date.now().toString(36);
  const paper = await createPaperWithPdf(page, {
    title: `Cover Cache ${stamp}`,
    pages: 3,
  });
  const contents: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/files\/[^/]+\/content$/.test(url.pathname))
      contents.push(url.pathname);
  });
  const thumbnailPath = `/api/v1/files/${paper.fileId}/thumbnail`;
  const thumbnailUrl = new URL(thumbnailPath, page.url()).href;
  const response = page.waitForResponse(thumbnailUrl);
  await page.goto(`${LIBRARY}?q=${stamp}`);
  await page
    .getByRole("radiogroup", { name: "视图" })
    .getByRole("radio", { name: "卡片" })
    .click();
  const card = page
    .getByRole("main")
    .locator(`[data-paper="${paper.paperId}"]`);
  const image = card.locator('img[data-thumb="image"]');
  await expect(image).toHaveAttribute("src", thumbnailPath);
  await expect
    .poll(() =>
      image.evaluate(
        (el: HTMLImageElement) => el.complete && el.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const headers = (await response).headers();
  expect(headers["content-type"]).toBe("image/jpeg");
  expect(headers["cache-control"]).toContain("immutable");
  expect(headers["cache-control"]).not.toContain("public");
  // A reload reuses the browser's copy of the picture.
  await page.reload();
  await expect(image).toHaveAttribute("src", thumbnailPath);
  await expect
    .poll(() =>
      image.evaluate(
        (el: HTMLImageElement) => el.complete && el.naturalWidth > 0,
      ),
    )
    .toBe(true);
  // Wait for this cover's completed timing entry, not every thumbnail on the page.
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          performance
            .getEntriesByName(url, "resource")
            .map((e) => (e as PerformanceResourceTiming).transferSize),
        thumbnailUrl,
      ),
    )
    .toEqual([0]);
  expect(contents).toEqual([]);
  await context.close();
});

test("Home covers are the server's pictures too, with no PDF download", async ({
  page,
}) => {
  await signIn(page);
  await createPaperWithPdf(page, {
    title: `Home Cover ${Date.now().toString(36)}`,
    pages: 3,
  });
  const contents: string[] = [];
  page.on("request", (request) => {
    if (/\/files\/[^/]+\/content$/.test(new URL(request.url()).pathname))
      contents.push(request.url());
  });
  await page.goto("/#home");
  const image = page
    .getByRole("main")
    .locator('img[data-thumb="image"]')
    .first();
  await expect(image).toHaveAttribute("src", /\/thumbnail$/);
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  expect(contents).toEqual([]);
});
