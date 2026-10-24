import { expect, test, type Page } from "@playwright/test";
import { createPaperWithPdf, signIn } from "../reader/fixtures";

// The screens follow the browser's language; these specs read them in Chinese.
test.use({ locale: "zh-CN" });

const record = (paperId: string, patch: Record<string, unknown> = {}) => ({
  paper_id: paperId,
  status: "ok",
  fetched_at: "2026-10-19T08:00:00+00:00",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  venue: "Advances in Neural Information Processing Systems",
  kind: "conference",
  pages: "5998-6008",
  citation_count: 123456,
  reference_count: 41,
  doi: "",
  arxiv: "1706.03762",
  source: "Semantic Scholar",
  ...patch,
});

/** The public look-ups are answered here; the service is never asked to reach the internet. */
async function mockRecords(
  page: Page,
  records: Record<string, ReturnType<typeof record>>,
  after: Record<string, ReturnType<typeof record>> = {},
) {
  const refreshed: string[] = [];
  let failing = false;
  await page.route("**/api/v1/paper-metadata", (route) =>
    route.fulfill({ json: records }),
  );
  await page.route(/\/api\/v1\/papers\/[^/]+\/metadata$/, (route) => {
    const id = route.request().url().split("/").slice(-2)[0];
    return route.fulfill({
      json: records[id] ?? { paper_id: id, status: "none" },
    });
  });
  await page.route(/\/api\/v1\/papers\/[^/]+\/metadata\/refresh$/, (route) => {
    const id = route.request().url().split("/").slice(-3)[0];
    refreshed.push(id);
    if (failing)
      return route.fulfill({ status: 503, json: { detail: "down" } });
    records[id] = after[id] ?? records[id] ?? record(id);
    return route.fulfill({ json: records[id] });
  });
  return {
    refreshed,
    fail: (value: boolean) => {
      failing = value;
    },
  };
}

test("the sheet shows the public record, refreshes it and copies three citations", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  const stamp = Date.now().toString(36);
  const paper = await createPaperWithPdf(page, {
    title: `Attention Is All You Need ${stamp}`,
  });
  const mock = await mockRecords(
    page,
    {},
    { [paper.paperId]: record(paper.paperId) },
  );
  await page.goto("/#library");
  const library = page.getByRole("main");
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);
  await library.getByRole("button", { name: `${paper.title} 的操作` }).click();
  await page.getByRole("menuitem", { name: "论文详情" }).click();

  // Never looked up: it is looked up once, on opening.
  const sheet = page.getByRole("dialog", { name: "论文详情" });
  const facts = sheet.getByTestId("paper-record");
  await expect(facts).toContainText("Advances in Neural Information");
  await expect(facts).toContainText("2017");
  await expect(facts).toContainText("123,456");
  await expect(facts).toContainText("41");
  expect(mock.refreshed).toEqual([paper.paperId]);

  // Three formats, each copied as shown.
  const text = sheet.getByTestId("citation-text");
  const formats = sheet.getByRole("radiogroup", { name: "引用格式" });
  await expect(text).toContainText("@inproceedings{");
  await sheet.getByRole("button", { name: "复制", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "booktitle = {Advances in Neural Information Processing Systems}",
  );
  await formats.getByRole("radio", { name: "APA" }).click();
  await expect(text).toContainText("In Advances in Neural Information");
  await formats.getByRole("radio", { name: "GB/T 7714" }).click();
  await expect(text).toContainText("[C]//Advances in Neural Information");
  await expect(text).toContainText("5998-6008");

  // A refresh that fails says why and keeps what was shown.
  mock.fail(true);
  await sheet.getByRole("button", { name: "重新查询这篇论文" }).click();
  await expect(sheet.getByRole("alert")).toContainText("连不上公开文献库");
  await expect(facts).toContainText("123,456");
  mock.fail(false);
  await sheet.getByRole("button", { name: "重新查询这篇论文" }).click();
  await expect(sheet.getByRole("alert")).toHaveCount(0);
  // Each press asked again (a busy page may ask once more; that is fine).
  expect(mock.refreshed.length).toBeGreaterThanOrEqual(3);
});

test("the library shows sources, sorts by citations and exports a .bib", async ({
  page,
}) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const few = await createPaperWithPdf(page, { title: `Few Cited ${stamp}` });
  const many = await createPaperWithPdf(page, { title: `Many Cited ${stamp}` });
  const none = await createPaperWithPdf(page, { title: `Unknown ${stamp}` });
  await mockRecords(page, {
    [few.paperId]: record(few.paperId, {
      venue: "Nature",
      kind: "journal",
      year: 2015,
      citation_count: 12,
      volume: "521",
      issue: "7553",
      pages: "436-444",
      doi: "10.1038/nature14539",
    }),
    [many.paperId]: record(many.paperId, { citation_count: 98765 }),
  });
  await page.goto("/#library");
  const library = page.getByRole("main");
  await library.getByRole("searchbox", { name: "搜索文库" }).fill(stamp);
  const card = (id: string) => library.locator(`[data-paper="${id}"]`);
  await expect(card(few.paperId)).toContainText("Nature");
  // Known venues show their short name.
  await expect(card(many.paperId)).toContainText("NeurIPS");
  await expect(card(none.paperId)).not.toContainText("被引");

  await library.getByRole("button", { name: /^排序/ }).click();
  await page.getByRole("menuitem", { name: "引用最多" }).click();
  await expect
    .poll(() =>
      library
        .locator("[data-paper]")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-paper"))),
    )
    .toEqual([many.paperId, few.paperId, none.paperId]);

  // Choose two and export.
  await library.getByRole("button", { name: "选择", exact: true }).click();
  await expect(
    library.getByRole("button", { name: "导出 .bib" }),
  ).toBeDisabled();
  await card(few.paperId).getByRole("checkbox").check();
  await card(many.paperId).getByRole("checkbox").check();
  await expect(library.getByText("已选 2 篇")).toBeVisible();
  const download = page.waitForEvent("download");
  await library.getByRole("button", { name: "导出 .bib" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("references.bib");
  const body = await (
    await import("node:fs/promises")
  ).readFile((await file.path())!, "utf8");
  expect(body).toContain("@article{");
  expect(body).toContain("journal = {Nature}");
  expect(body).toContain("pages = {436--444}");
  expect(body).toContain("@inproceedings{");
  expect(body).not.toContain("Unknown");
  await library.getByRole("button", { name: "完成", exact: true }).click();
  await expect(library.getByRole("checkbox")).toHaveCount(0);
});

test("the reader's details sheet carries the record too", async ({ page }) => {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: 2 });
  await mockRecords(page, {
    [paper.paperId]: record(paper.paperId, { venue: "Journal of Tests" }),
  });
  await page.goto(`/#read/${paper.paperId}`);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "论文详情" }).click();
  const sheet = page.getByRole("dialog", { name: "论文详情" });
  await expect(sheet.getByTestId("paper-record")).toContainText(
    "Journal of Tests",
  );
  await expect(sheet.getByTestId("citation-text")).toBeVisible();
});
