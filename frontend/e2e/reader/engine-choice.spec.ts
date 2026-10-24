import { expect, test, type Page } from "@playwright/test";
import {
  createPaperWithPdf,
  openReader,
  pdfWithPages,
  signIn,
} from "./fixtures";

// 译文 has two ways to translate the whole paper (源码重编 from the arXiv LaTeX
// source, 版面翻译 on the original PDF). They are chosen and started by the
// person, run apart, keep their own results, and the reader shows the selected
// one. Jobs, settings and the translated files are mocked or uploaded here; the
// service side is backend/tests/test_translation_engines.py.
test.use({ locale: "zh-CN" });

type Row = Record<string, unknown>;
type Engine = "latex" | "pdf";

type Service = {
  jobs: Row[];
  started: Row[];
  cancelled: string[];
  paperId: string;
  fileId: string;
  versionId: string;
  /** The translated PDFs the two ways made, once they are uploaded. */
  files: Record<Engine, string>;
};

const main = (page: Page) => page.getByRole("main");
const panel = (page: Page) =>
  main(page).getByRole("region", { name: "全文翻译", exact: true });
const way = (page: Page, name: "源码重编" | "版面翻译") =>
  panel(page).getByRole("region", { name, exact: true });
const modeSwitch = (page: Page) =>
  main(page).getByRole("radiogroup", { name: "阅读方式", exact: true });
const engineSwitch = (page: Page) =>
  main(page).getByRole("radiogroup", { name: "译文做法", exact: true });
const scroller = (page: Page) =>
  page.getByRole("region", { name: "论文页面", exact: true });

async function upload(
  page: Page,
  service: Service,
  name: string,
  text: string,
) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "paper_csrf",
  )!.value;
  const response = await page.request.post(
    `/api/v1/papers/${service.paperId}/files`,
    {
      headers: { "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() },
      multipart: {
        version_id: service.versionId,
        file: {
          name,
          mimeType: "application/pdf",
          buffer: pdfWithPages(3, [], { words: { 1: text } }),
        },
      },
    },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()).id as string;
}

/** An arXiv paper whose service can run both ways; the jobs are whatever the test puts in `service.jobs`. */
async function setup(page: Page): Promise<Service> {
  await signIn(page);
  const { paperId, fileId } = await createPaperWithPdf(page, { pages: 3 });
  const record = await (
    await page.request.get(`/api/v1/papers/${paperId}`)
  ).json();
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "paper_csrf",
  )!.value;
  const patched = await page.request.patch(`/api/v1/papers/${paperId}`, {
    headers: {
      "X-CSRF-Token": csrf,
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": String(record.revision),
    },
    data: { external_id: "arxiv:2504.19413v1" },
  });
  expect(patched.ok()).toBeTruthy();
  const service: Service = {
    jobs: [],
    started: [],
    cancelled: [],
    paperId,
    fileId,
    versionId: (await patched.json()).current_version,
    files: { latex: "", pdf: "" },
  };
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        models: [{ id: "model-1", name: "Fixture model", model: "fixture" }],
        active_id: "model-1",
        configured: true,
        pdf_layout_enabled: true,
        latex_translation_available: true,
        latex_installable: false,
      },
    }),
  );
  await page.route(`**/api/v1/papers/${paperId}/translations`, (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill({ json: service.jobs });
    const body = route.request().postDataJSON() as Row;
    service.started.push(body);
    const engine = body.engine as Engine;
    // Starting a method returns its own running job (or, to retry, makes it again).
    service.jobs = service.jobs.filter((row) => row.engine !== engine);
    const created = job(service, engine, {
      id: `${engine}-new`,
      status: "running",
      stage: "正在翻译",
      completed: 20,
      total: 100,
    });
    service.jobs.unshift(created);
    return route.fulfill({ json: created });
  });
  await page.route("**/api/v1/translations/*/cancel", (route) => {
    const id = route.request().url().split("/").at(-2)!;
    service.cancelled.push(id);
    return route.fulfill({ json: {} });
  });
  return service;
}

function job(service: Service, engine: Engine, fields: Row = {}): Row {
  return {
    id: `${engine}-1`,
    engine,
    version_id: service.versionId,
    status: "completed",
    stage: "翻译完成",
    completed: 100,
    total: 100,
    error: "",
    no_source: false,
    source_file: engine === "pdf" ? service.fileId : "",
    translated_file: service.files[engine],
    alignment: [],
    ...fields,
  };
}

async function openTranslated(page: Page, service: Service) {
  await openReader(page, { paperId: service.paperId });
  await expect(page.locator('[data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
  );
  await modeSwitch(page)
    .getByRole("radio", { name: "译文", exact: true })
    .click();
}

const alone = (page: Page) =>
  main(page).getByRole("radio", { name: "仅译文", exact: true }).click();

test("each way is chosen and started by the person, and nothing starts by itself", async ({
  page,
}) => {
  const service = await setup(page);
  await openTranslated(page, service);

  await expect(panel(page)).toBeVisible();
  await expect(way(page, "源码重编")).toContainText("未开始");
  await expect(way(page, "版面翻译")).toContainText("未开始");
  await expect(
    way(page, "源码重编").getByRole("button", { name: "开始源码重编" }),
  ).toBeEnabled();
  await expect(
    way(page, "版面翻译").getByRole("button", { name: "开始版面翻译" }),
  ).toBeEnabled();
  expect(service.started).toEqual([]);

  await way(page, "源码重编")
    .getByRole("button", { name: "开始源码重编" })
    .click();
  await expect
    .poll(() => service.started)
    .toEqual([{ model_config_id: "model-1", engine: "latex" }]);
  await expect(
    way(page, "源码重编").getByRole("progressbar", { name: "源码重编进度" }),
  ).toBeVisible();
  // The other way was not started with it, and can be started beside it.
  await expect(way(page, "版面翻译")).toContainText("未开始");
  await way(page, "版面翻译")
    .getByRole("button", { name: "开始版面翻译" })
    .click();
  await expect.poll(() => service.started.length).toBe(2);
  expect(service.started[1]).toEqual({
    model_config_id: "model-1",
    engine: "pdf",
    source_file_id: service.fileId,
  });
  await expect(
    way(page, "源码重编").getByRole("progressbar", { name: "源码重编进度" }),
  ).toBeVisible();
  await expect(
    way(page, "版面翻译").getByRole("progressbar", { name: "版面翻译进度" }),
  ).toBeVisible();
});

test("both results coexist, the reader switches between them and remembers the choice", async ({
  page,
}) => {
  const service = await setup(page);
  service.files.latex = await upload(
    page,
    service,
    "zh-latex.pdf",
    "Source copy",
  );
  service.files.pdf = await upload(
    page,
    service,
    "zh-layout.pdf",
    "Layout copy",
  );
  service.jobs = [job(service, "pdf"), job(service, "latex")];
  await openTranslated(page, service);

  // Both are done: the source one (best typography) is shown first.
  await expect(engineSwitch(page)).toBeVisible();
  await alone(page);
  await expect(scroller(page)).toHaveAttribute(
    "data-file",
    service.files.latex,
  );
  await expect(engineSwitch(page).getByRole("radio")).toHaveText([
    "源码重编",
    "版面翻译",
  ]);

  await engineSwitch(page).getByRole("radio", { name: "版面翻译" }).click();
  await expect(scroller(page)).toHaveAttribute("data-file", service.files.pdf);
  await expect(panel(page)).toHaveCount(0);

  // Remembered for this paper.
  await page.reload();
  await modeSwitch(page)
    .getByRole("radio", { name: "译文", exact: true })
    .click();
  await alone(page);
  await expect(scroller(page)).toHaveAttribute("data-file", service.files.pdf);
  await engineSwitch(page).getByRole("radio", { name: "源码重编" }).click();
  await expect(scroller(page)).toHaveAttribute(
    "data-file",
    service.files.latex,
  );
});

test("a failed way gives its reason and a retry while the other still shows", async ({
  page,
}) => {
  const service = await setup(page);
  service.files.latex = await upload(
    page,
    service,
    "zh-latex.pdf",
    "Source copy",
  );
  service.jobs = [
    job(service, "pdf", {
      status: "failed",
      stage: "翻译失败",
      error: "版面模型没有回应，请稍后重试。",
      translated_file: "",
    }),
    job(service, "latex"),
  ];
  await openTranslated(page, service);

  // The finished one is read; the failure is named on its switch item.
  await alone(page);
  await expect(scroller(page)).toHaveAttribute(
    "data-file",
    service.files.latex,
  );
  await expect(
    engineSwitch(page).getByRole("radio", { name: /版面翻译 · 失败/ }),
  ).toBeVisible();

  await engineSwitch(page)
    .getByRole("radio", { name: /版面翻译/ })
    .click();
  await expect(
    way(page, "版面翻译").getByText("版面模型没有回应，请稍后重试。"),
  ).toBeVisible();
  // The finished way is still there to go back to.
  await expect(way(page, "源码重编")).toContainText("已完成");
  await way(page, "版面翻译").getByRole("button", { name: "重试" }).click();
  await expect
    .poll(() => service.started)
    .toEqual([
      {
        model_config_id: "model-1",
        engine: "pdf",
        source_file_id: service.fileId,
      },
    ]);
  await expect(
    way(page, "版面翻译").getByRole("progressbar", { name: "版面翻译进度" }),
  ).toBeVisible();

  await way(page, "源码重编")
    .getByRole("button", { name: "查看这份译文" })
    .click();
  await expect(panel(page)).toHaveCount(0);
  await expect(scroller(page).or(main(page))).toBeVisible();
});

test("the download dialog offers each completed translation", async ({
  page,
}) => {
  const service = await setup(page);
  service.files.latex = await upload(
    page,
    service,
    "zh-latex.pdf",
    "Source copy",
  );
  service.files.pdf = await upload(
    page,
    service,
    "zh-layout.pdf",
    "Layout copy",
  );
  service.jobs = [job(service, "pdf"), job(service, "latex")];
  const asked: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/v1\/files\/[^/]+\/content$/.test(path))
      asked.push(path.split("/")[4]);
  });
  await openReader(page, { paperId: service.paperId });
  await expect(page.locator('[data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
  );
  await main(page).getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "下载…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "下载", exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  await dialog.getByRole("radio", { name: "译文 PDF · 版面翻译" }).check();
  const mark = asked.length;
  const [saved] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "下载", exact: true }).click(),
  ]);
  expect(saved.suggestedFilename()).toMatch(/-译文-版面翻译\.pdf$/);
  expect(asked.slice(mark)).toEqual([service.files.pdf]);
});

test("the side by side view follows the selected result", async ({ page }) => {
  const service = await setup(page);
  service.files.latex = await upload(
    page,
    service,
    "zh-latex.pdf",
    "Source copy",
  );
  service.files.pdf = await upload(
    page,
    service,
    "zh-layout.pdf",
    "Layout copy",
  );
  service.jobs = [
    job(service, "pdf"),
    job(service, "latex", {
      alignment: [
        {
          id: "u1",
          source_text: "x",
          translated_text: "y",
          source: { page: 1, quote: "x" },
          translated: { page: 1, quote: "y" },
        },
      ],
    }),
  ];
  await openTranslated(page, service);

  const translated = page.locator('[data-pane="translated"] .opr-pdf');
  await expect(translated).toHaveAttribute("data-file", service.files.latex);
  await expect(main(page)).toContainText("按页码位置滚动");
  await engineSwitch(page).getByRole("radio", { name: "版面翻译" }).click();
  await expect(translated).toHaveAttribute("data-file", service.files.pdf);
  await expect(main(page)).toContainText("按页码位置滚动");
});
