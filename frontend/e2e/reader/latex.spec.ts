import { expect, test, type Page } from "@playwright/test";
import {
  createPaperWithPdf,
  openReader,
  pdfWithPages,
  signIn,
} from "./fixtures";

// 译文 for an arXiv paper: translated from its LaTeX source and compiled again
// (engine "latex"), else re-typeset on the original PDF (engine "pdf"). The jobs
// and the settings are mocked; the translating itself is the service's
// (backend/tests/test_translation.py, backend/tests/test_latex_install.py).
test.use({ locale: "zh-CN" });

type Row = Record<string, unknown>;

type Service = {
  /** `latex_translation_available`, `latex_installable` and `pdf_layout_enabled` of the settings. */
  latex: boolean;
  installable: boolean;
  layout: boolean;
  jobs: Row[];
  started: Row[];
  cancelled: string[];
  /** The local build's Tectonic install, as `GET /latex-install` says it. */
  install: Row;
  installCalls: string[];
};

type Paper = {
  paperId: string;
  fileId: string;
  versionId: string;
};

/** A paper with a PDF; with an arXiv id of a fixed version when `arxiv` is given. */
async function makePaper(page: Page, arxiv = ""): Promise<Paper> {
  const { paperId, fileId } = await createPaperWithPdf(page, { pages: 3 });
  let paper = await (
    await page.request.get(`/api/v1/papers/${paperId}`)
  ).json();
  if (arxiv) {
    const csrf = (await page.context().cookies()).find(
      (cookie) => cookie.name === "paper_csrf",
    )!.value;
    const patched = await page.request.patch(`/api/v1/papers/${paperId}`, {
      headers: {
        "X-CSRF-Token": csrf,
        "Idempotency-Key": crypto.randomUUID(),
        "If-Match": String(paper.revision),
      },
      data: { external_id: arxiv },
    });
    expect(patched.ok()).toBeTruthy();
    paper = await patched.json();
  }
  return { paperId, fileId, versionId: paper.current_version };
}

async function serve(
  page: Page,
  paper: Paper,
  start: Partial<Service> = {},
): Promise<Service> {
  const service: Service = {
    latex: true,
    installable: false,
    layout: true,
    jobs: [],
    started: [],
    cancelled: [],
    install: {
      status: "idle",
      stage: "",
      progress: 0,
      error: "",
      supported: true,
      installed: false,
      available: false,
    },
    installCalls: [],
    ...start,
  };
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        models: [{ id: "model-1", name: "Fixture model", model: "fixture" }],
        active_id: "model-1",
        configured: true,
        pdf_layout_enabled: service.layout,
        latex_translation_available: service.latex,
        latex_installable: service.installable,
      },
    }),
  );
  await page.route(
    `**/api/v1/papers/${paper.paperId}/translations`,
    (route) => {
      if (route.request().method() !== "POST")
        return route.fulfill({ json: service.jobs });
      const body = route.request().postDataJSON() as Row;
      service.started.push(body);
      const created: Row = {
        id: `job-${service.started.length}`,
        engine: body.engine,
        version_id: paper.versionId,
        status: "queued",
        stage: "",
        completed: 0,
        total: body.engine === "pdf" ? 100 : 0,
        error: "",
        no_source: false,
        source_file: body.engine === "pdf" ? paper.fileId : "",
        translated_file: "",
      };
      service.jobs.unshift(created);
      return route.fulfill({ json: created });
    },
  );
  await page.route("**/api/v1/translations/*/cancel", (route) => {
    const id = route.request().url().split("/").at(-2)!;
    service.cancelled.push(id);
    const stopped = service.jobs.find((row) => row.id === id);
    if (stopped) Object.assign(stopped, { status: "cancelled", stage: "" });
    return route.fulfill({ json: stopped ?? {} });
  });
  await page.route("**/api/v1/latex-install**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      service.installCalls.push(path);
      Object.assign(service.install, {
        status: "running",
        stage: "download",
        progress: 20,
      });
    }
    return route.fulfill({ json: service.install });
  });
  return service;
}

const main = (page: Page) => page.getByRole("main");
const panel = (page: Page) =>
  main(page).getByRole("region", { name: "全文翻译", exact: true });
/** One of the two ways, as its own block of the panel. */
const way = (page: Page, name: "源码重编" | "版面翻译") =>
  panel(page).getByRole("region", { name, exact: true });
const translated = (page: Page) =>
  main(page)
    .getByRole("radiogroup", { name: "阅读方式", exact: true })
    .getByRole("radio", { name: "译文", exact: true });

async function open(page: Page, paper: Paper) {
  await openReader(page, { paperId: paper.paperId });
  await expect(page.locator('[data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
  );
  await translated(page).click();
  await expect(panel(page)).toBeVisible();
}

test("an arXiv paper is translated from its LaTeX source, and the job is followed and can be stopped", async ({
  page,
}) => {
  await signIn(page);
  const paper = await makePaper(page, "arxiv:2504.19413v1");
  const service = await serve(page, paper);
  await open(page, paper);

  // Both ways are there to choose; nothing has been started for the person.
  await expect(
    way(page, "源码重编").getByRole("button", { name: "开始源码重编" }),
  ).toBeEnabled();
  await expect(
    way(page, "版面翻译").getByRole("button", { name: "开始版面翻译" }),
  ).toBeEnabled();
  await expect(way(page, "源码重编")).toContainText("未开始");
  expect(service.started).toEqual([]);
  await way(page, "源码重编")
    .getByRole("button", { name: "开始源码重编" })
    .click();
  await expect
    .poll(() => service.started)
    .toEqual([{ model_config_id: "model-1", engine: "latex" }]);

  // The service's stages and counts, as the job reports them.
  Object.assign(service.jobs[0], {
    status: "running",
    stage: "翻译章节与公式",
    completed: 3,
    total: 10,
  });
  await expect(way(page, "源码重编").getByText("翻译章节与公式")).toBeVisible();
  await expect(
    way(page, "源码重编").getByRole("progressbar", { name: "源码重编进度" }),
  ).toHaveAttribute("aria-valuenow", "30");
  // The other way is not touched by it.
  await expect(way(page, "版面翻译")).toContainText("未开始");

  await way(page, "源码重编").getByRole("button", { name: "取消翻译" }).click();
  await expect.poll(() => service.cancelled).toEqual(["job-1"]);
  await expect(
    way(page, "源码重编").getByRole("button", { name: "开始源码重编" }),
  ).toBeVisible();
});

test("a paper that is not from arXiv can only be translated on its PDF", async ({
  page,
}) => {
  await signIn(page);
  const paper = await makePaper(page);
  const service = await serve(page, paper);
  await open(page, paper);

  await expect(way(page, "源码重编")).toContainText("这篇论文不是");
  await expect(
    way(page, "源码重编").getByRole("button", { name: "开始源码重编" }),
  ).toHaveCount(0);
  await way(page, "版面翻译")
    .getByRole("button", { name: "开始版面翻译" })
    .click();
  await expect
    .poll(() => service.started)
    .toEqual([
      {
        model_config_id: "model-1",
        engine: "pdf",
        source_file_id: paper.fileId,
      },
    ]);
});

test("an arXiv version without LaTeX source says so, and the layout way is still there to start", async ({
  page,
}) => {
  await signIn(page);
  const paper = await makePaper(page, "arxiv:2504.19413v1");
  const service = await serve(page, paper, {
    jobs: [
      {
        id: "job-0",
        engine: "latex",
        version_id: paper.versionId,
        status: "failed",
        stage: "翻译未完成",
        completed: 0,
        total: 0,
        error: "该版本未提供可用的 LaTeX 源码",
        no_source: true,
        source_file: paper.fileId,
        translated_file: "",
      },
    ],
  });
  await open(page, paper);

  await expect(
    way(page, "源码重编").getByText("arXiv 没有这个版本的 LaTeX 源码。"),
  ).toBeVisible();
  // Trying the source again cannot help: no retry there.
  await expect(panel(page).getByRole("button", { name: "重试" })).toHaveCount(
    0,
  );
  await way(page, "版面翻译")
    .getByRole("button", { name: "开始版面翻译" })
    .click();
  await expect
    .poll(() => service.started)
    .toEqual([
      {
        model_config_id: "model-1",
        engine: "pdf",
        source_file_id: paper.fileId,
      },
    ]);
  await expect(
    way(page, "版面翻译").getByRole("progressbar", { name: "版面翻译进度" }),
  ).toBeVisible();
});

test("another LaTeX failure gives its reason and can be tried again, with the layout way beside it", async ({
  page,
}) => {
  await signIn(page);
  const paper = await makePaper(page, "arxiv:2504.19413v1");
  const service = await serve(page, paper, {
    jobs: [
      {
        id: "job-0",
        engine: "latex",
        version_id: paper.versionId,
        status: "failed",
        stage: "中文 PDF 编译失败",
        completed: 10,
        total: 10,
        error: "中文 PDF 编译失败：宏包或排版编译失败",
        no_source: false,
        source_file: paper.fileId,
        translated_file: "",
      },
    ],
  });
  await open(page, paper);

  await expect(
    way(page, "源码重编").getByText("中文 PDF 编译失败：宏包或排版编译失败"),
  ).toBeVisible();
  await expect(
    way(page, "版面翻译").getByRole("button", { name: "开始版面翻译" }),
  ).toBeVisible();
  await way(page, "源码重编").getByRole("button", { name: "重试" }).click();
  await expect
    .poll(() => service.started)
    .toEqual([{ model_config_id: "model-1", engine: "latex" }]);
});

test("a finished LaTeX translation is read in the engine", async ({ page }) => {
  await signIn(page);
  const paper = await makePaper(page, "arxiv:2504.19413v1");
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "paper_csrf",
  )!.value;
  const upload = await page.request.post(
    `/api/v1/papers/${paper.paperId}/files`,
    {
      headers: { "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() },
      multipart: {
        version_id: paper.versionId,
        file: {
          name: "zh-2504.19413v1.pdf",
          mimeType: "application/pdf",
          buffer: pdfWithPages(3, [], { words: { 1: "Compiled copy" } }),
        },
      },
    },
  );
  expect(upload.ok()).toBeTruthy();
  const translatedId = (await upload.json()).id;
  await serve(page, paper, {
    jobs: [
      {
        id: "job-0",
        engine: "latex",
        version_id: paper.versionId,
        status: "completed",
        stage: "翻译完成",
        completed: 10,
        total: 10,
        error: "",
        no_source: false,
        source_file: paper.fileId,
        translated_file: translatedId,
      },
    ],
  });
  await openReader(page, { paperId: paper.paperId });
  await translated(page).click();
  // Beside the original by default: this one reads the translation alone.
  await page
    .getByRole("main")
    .getByRole("radio", { name: "仅译文", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "论文页面", exact: true }),
  ).toHaveAttribute("data-file", translatedId);
  await expect(panel(page)).toHaveCount(0);
});

test("in the local build without the TeX engine, an arXiv paper offers to install it and then uses it", async ({
  page,
}) => {
  await signIn(page);
  const paper = await makePaper(page, "arxiv:2504.19413v1");
  const service = await serve(page, paper, { latex: false, installable: true });
  await open(page, paper);

  // Meanwhile the layout way can be started.
  await expect(
    way(page, "版面翻译").getByRole("button", { name: "开始版面翻译" }),
  ).toBeVisible();
  await way(page, "源码重编")
    .getByRole("button", { name: "安装 LaTeX 编译器" })
    .click();
  await expect
    .poll(() => service.installCalls)
    .toEqual(["/api/v1/latex-install"]);
  await expect(
    panel(page).getByRole("progressbar", { name: "安装进度" }),
  ).toBeVisible();

  // Installed: the settings say so, and the source way is the one offered.
  Object.assign(service.install, {
    status: "completed",
    stage: "",
    progress: 100,
    installed: true,
    available: true,
  });
  Object.assign(service, { latex: true, installable: false });
  await way(page, "源码重编")
    .getByRole("button", { name: "开始源码重编" })
    .click();
  await expect
    .poll(() => service.started)
    .toEqual([{ model_config_id: "model-1", engine: "latex" }]);
});

test("without any way to compile or re-typeset, the local build offers the LaTeX compiler", async ({
  page,
}) => {
  await signIn(page);
  const paper = await makePaper(page, "arxiv:2504.19413v1");
  await serve(page, paper, { latex: false, installable: true, layout: false });
  await open(page, paper);

  await expect(way(page, "源码重编")).toContainText("未安装 LaTeX 编译器");
  await expect(way(page, "版面翻译")).toContainText("未配置版面翻译");
  await expect(
    panel(page).getByRole("button", { name: "安装 LaTeX 编译器" }),
  ).toBeVisible();
});
