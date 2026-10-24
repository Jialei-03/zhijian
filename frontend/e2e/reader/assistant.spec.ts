import { expect, test, type Locator, type Page } from "@playwright/test";
import { createPaperWithPdf, openReader, signIn } from "./fixtures";

// The interface follows the browser's language; these specs read it in Chinese.
test.use({ locale: "zh-CN" });

const SESSION = "assistant-spec-session";
const MODEL = {
  id: "assistant-spec-model",
  name: "Spec model",
  model: "spec-model",
};

type Step = {
  name: string;
  label: string;
  status: string;
  arguments: Record<string, unknown>;
  result?: { summary: string; truncated: boolean };
  error?: string;
};

type Run = {
  id: string;
  prompt: string;
  response: string;
  status: string;
  error: string;
  writable: boolean;
  steps: Step[];
  runtime: Record<string, unknown>;
};

/**
 * The assistant's side of the service, played by the test: one discussion
 * whose runs change only when the test changes them, as a worker would write
 * them. The reader reads them by polling, as it reads the real ones.
 */
class FakeAssistant {
  runs: Run[] = [];
  /** The bodies of the runs the reader created, in order. */
  created: Record<string, unknown>[] = [];
  cancelled: string[] = [];
  /** How many times the runs have been read. */
  polls = 0;
  private count = 0;

  async install(page: Page, models: (typeof MODEL)[] = [MODEL]) {
    await page.route("**/api/v1/translation-settings", (route) =>
      route.fulfill({
        json: {
          active_id: models[0]?.id ?? "",
          configured: models.length > 0,
          models,
        },
      }),
    );
    await page.route("**/api/v1/papers/*/discussion", (route) =>
      route.fulfill({ json: { id: SESSION, title: "Discussion" } }),
    );
    await page.route(`**/api/v1/agent/sessions/${SESSION}/runs`, (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        this.created.push(body);
        const context = body.reader_context as
          | Record<string, unknown>
          | undefined;
        return route.fulfill({
          json: this.add({
            prompt: String(body.prompt),
            status: "queued",
            runtime: context
              ? {
                  reader_context: {
                    ...context,
                    file_name: "paper.pdf",
                    source_url: "#",
                  },
                }
              : {},
          }),
        });
      }
      this.polls += 1;
      return route.fulfill({ json: this.runs });
    });
    await page.route("**/api/v1/agent/runs/*/cancel", (route) => {
      const id = route.request().url().split("/").at(-2)!;
      this.cancelled.push(id);
      const run = this.runs.find((row) => row.id === id)!;
      run.status = "cancelled";
      run.runtime = { ...run.runtime, phase: "cancelled" };
      return route.fulfill({ json: run });
    });
  }

  /** A run in the discussion, as if it had been asked before (or just now). */
  add(fields: Partial<Run>): Run {
    const run: Run = {
      id: `run-${++this.count}`,
      prompt: "",
      response: "",
      status: "completed",
      error: "",
      writable: false,
      steps: [],
      runtime: {},
      ...fields,
    };
    this.runs.push(run);
    return run;
  }
}

const read = (page: number, pages: number, status = "completed"): Step => ({
  name: "read_file",
  label: "读取论文附件文本",
  status,
  arguments: { id: "file", page, pages },
  ...(status === "completed"
    ? { result: { summary: '{"pages": []}', truncated: false } }
    : {}),
});

// As the service writes a search's result (backend agent_reading.py search_file), cut at 2000 characters.
const search = (query: string, total: number): Step => ({
  name: "search_file",
  label: "在论文 PDF 的全部页面里搜索文字",
  status: "completed",
  arguments: { id: "file", query },
  result: {
    summary: JSON.stringify({
      file_id: "file",
      query,
      total_matches: total,
      pages_with_matches: [1],
      matches: Array.from({ length: 40 }, (_, index) => ({
        page: 1,
        count: 1,
        snippet: `…a long snippet around the match, number ${index}…`.repeat(2),
      })),
      truncated: false,
    }).slice(0, 2000),
    truncated: true,
  },
});

const assistantTab = (page: Page) =>
  page.getByRole("tablist").getByRole("tab", { name: "助手" });
const thread = (page: Page) =>
  page.getByRole("log", { name: "与助手的对话", exact: true });
const questionBox = (page: Page) =>
  page.getByRole("textbox", { name: "向助手提问", exact: true });
const sendButton = (page: Page) =>
  page.getByRole("button", { name: "发送", exact: true });
const stopButton = (page: Page) =>
  page.getByRole("button", { name: "停止回答", exact: true });
const pageInput = (page: Page) =>
  page.getByRole("main").getByRole("textbox", { name: "页码", exact: true });
const pdfPage = (page: Page, number: number) =>
  page.locator(`[data-page="${number}"]`);

/** The part of the panel that scrolls (the thread's views share it). */
const panelScroller = (log: Locator) =>
  log.evaluateHandle(
    (element) => element.closest('[role="tabpanel"]')!.parentElement!,
  );

test("a question sent with Enter is asked of the paper's discussion, and its answer is written into the thread", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page);
  await openReader(page, { paperId });

  // The composer is docked in the foot of the panel: its width, at the bottom.
  const box = questionBox(page);
  await expect(box).toBeEnabled();
  await expect(box).toHaveAttribute(
    "placeholder",
    "问这一页、这段，或整篇论文…",
  );
  const [side, composer] = await Promise.all([
    page.getByRole("complementary").boundingBox(),
    box.evaluate((element) => {
      const { x, y, width, height } = element
        .closest('[class*="composer"]')!
        .getBoundingClientRect();
      return { x, y, width, height };
    }),
  ]);
  expect(composer.x).toBeGreaterThan(side!.x);
  expect(composer.x + composer.width).toBeLessThan(side!.x + side!.width);
  expect(side!.width - composer.width).toBeLessThan(40);
  const below = side!.y + side!.height - (composer.y + composer.height);
  expect(below).toBeGreaterThan(8);
  expect(below).toBeLessThan(24);

  await assistantTab(page).click();
  // No prompts of its own: the guide opens the view.
  await expect(page.getByRole("tabpanel")).not.toContainText(
    "像问一位读过这篇论文的同事",
  );

  // Shift+Enter is a new line; Enter sends.
  await box.fill("第一行");
  await box.press("Shift+Enter");
  await box.pressSequentially("这篇论文做了什么？");
  await expect(box).toHaveValue("第一行\n这篇论文做了什么？");
  expect(server.created).toEqual([]);
  await expect(sendButton(page)).toBeEnabled();
  await box.press("Enter");
  await expect.poll(() => server.created.length).toBe(1);
  expect(server.created[0]).toEqual({
    prompt: "第一行\n这篇论文做了什么？",
    model_config_id: MODEL.id,
    writable: false,
    context: `paper/${paperId}`,
  });
  await expect(box).toHaveValue("");

  // The question, on the right, in a bubble.
  const log = thread(page);
  const bubble = log.getByText("这篇论文做了什么？");
  await expect(bubble).toBeVisible();
  const [bubbleBox, logBox] = await Promise.all([
    bubble.boundingBox(),
    log.boundingBox(),
  ]);
  expect(bubbleBox!.x).toBeGreaterThan(logBox!.x + 40);
  await expect(log).toContainText("排队中…");
  // While it is answered, the send button is a stop button.
  await expect(stopButton(page)).toBeVisible();

  // Working: the reader reads the runs every 700ms while one is running.
  const run = server.runs[0];
  Object.assign(run, {
    status: "running",
    steps: [read(3, 2, "running")],
    runtime: { phase: "tool", execution_seconds: 2.2 },
  });
  await expect(log).toContainText("处理中 · 2 秒 · 读了 2 页");
  const before = server.polls;
  await page.waitForTimeout(2200);
  expect(server.polls - before).toBeGreaterThanOrEqual(2);

  // The answer grows as it is written.
  Object.assign(run, {
    steps: [read(3, 2), search("evidence", 4)],
    response: "这篇论文提出",
  });
  await expect(log).toContainText("这篇论文提出");
  run.response = "这篇论文提出了一种把**证据**连回原文的方法。";
  await expect(log.locator("strong", { hasText: "证据" })).toBeVisible();
  await expect(log).toContainText("这篇论文提出了一种把证据连回原文的方法。");

  // Done: the process folds into one line, which opens to the steps.
  Object.assign(run, {
    status: "completed",
    steps: [read(3, 2), search("evidence", 4), read(5, 1)],
    runtime: { phase: "completed", execution_seconds: 9.4 },
  });
  const process = log.getByRole("button", {
    name: "已处理 9 秒 · 读了 3 页 · 搜索 1 次",
    exact: true,
  });
  await expect(process).toHaveAttribute("aria-expanded", "false");
  await expect(log.getByRole("listitem")).toHaveCount(0);
  await expect(sendButton(page)).toBeVisible();
  // Nothing is being written: the runs are read only every 3s.
  const idle = server.polls;
  await page.waitForTimeout(2200);
  expect(server.polls - idle).toBeLessThanOrEqual(1);

  await process.click();
  await expect(process).toHaveAttribute("aria-expanded", "true");
  const steps = log.getByRole("listitem");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText("读取");
  await expect(steps.nth(0)).toContainText("第 3–4 页");
  await expect(steps.nth(0)).toContainText("完成");
  await expect(steps.nth(1)).toContainText("evidence");
  await expect(steps.nth(1)).toContainText("找到 4 处");
  await expect(steps.nth(2)).toContainText("第 5 页");
  await process.click();
  await expect(log.getByRole("listitem")).toHaveCount(0);
});

const SENTENCE = "Evidence stays connected to its source.";

test("a page an answer cites is a label that leads to the sentence in the paper, marked", async ({
  page,
}) => {
  await signIn(page);
  const paper = await createPaperWithPdf(page, {
    pages: 6,
    words: { 3: SENTENCE },
  });
  const server = new FakeAssistant();
  await server.install(page);
  server.add({
    prompt: "证据怎么和原文连起来？",
    response: `每条证据都记着出处[p.3](#paper/${paper.paperId}?file=${paper.fileId}&page=3&quote=${encodeURIComponent(SENTENCE)})，见[原文](https://example.org/paper)。`,
    runtime: { phase: "completed", execution_seconds: 4 },
  });
  await openReader(page, { paperId: paper.paperId });
  await expect(pageInput(page)).toHaveValue("1");
  await assistantTab(page).click();

  const cite = thread(page).getByRole("link", {
    name: "跳到原文第 3 页",
    exact: true,
  });
  await expect(cite).toHaveText("第 3 页");
  // Links elsewhere stay links, to a new tab.
  await expect(
    thread(page).getByRole("link", { name: "原文", exact: true }),
  ).toHaveAttribute("target", "_blank");

  await cite.click();
  await expect(pageInput(page)).toHaveValue("3");
  await expect(
    pdfPage(page, 3)
      .locator(".pdf-reference-lines .pdf-reference-underline")
      .first(),
  ).toBeVisible();
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(
    `#read/${paper.paperId}?file=${paper.fileId}&page=3&quote=${SENTENCE}`,
  );

  // Followed again from elsewhere in the paper, it goes back to the sentence.
  await page
    .getByRole("main")
    .getByRole("button", { name: "上一页", exact: true })
    .click();
  await expect(pageInput(page)).toHaveValue("2");
  await cite.click();
  await expect(pageInput(page)).toHaveValue("3");
});

test("a link in an answer leads into the paper, or to the web in a new tab, and nowhere else", async ({
  page,
}) => {
  await signIn(page);
  const paper = await createPaperWithPdf(page, { pages: 4 });
  const server = new FakeAssistant();
  await server.install(page);
  server.add({
    prompt: "有哪些链接？",
    response: [
      "[x](//evil.example/login)",
      "[y](/\\evil.example)",
      "[z](javascript:alert(1))",
      "[w](https://example.org/paper)",
      `[p.3](#paper/${paper.paperId}?file=${paper.fileId}&page=3)`,
    ].join(" · "),
    runtime: { phase: "completed", execution_seconds: 1 },
  });
  await openReader(page, { paperId: paper.paperId });
  await expect(pageInput(page)).toHaveValue("1");
  await assistantTab(page).click();
  const log = thread(page);
  await expect(log).toContainText("x · y · z · w");

  // What leads off the app, or runs, is words and nothing more.
  for (const name of ["x", "y", "z"]) {
    await expect(log.getByText(name, { exact: true })).toBeVisible();
    await expect(log.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  await expect(log.locator("a")).toHaveCount(2);
  const web = log.getByRole("link", { name: "w", exact: true });
  await expect(web).toHaveAttribute("href", "https://example.org/paper");
  await expect(web).toHaveAttribute("target", "_blank");
  await expect(web).toHaveAttribute("rel", "noopener noreferrer");

  // A press on the words goes nowhere.
  const before = page.url();
  await log.getByText("y", { exact: true }).click();
  await log.getByText("z", { exact: true }).click();
  expect(page.url()).toBe(before);

  // The citation still leads to its page.
  await log.getByRole("link", { name: "跳到原文第 3 页", exact: true }).click();
  await expect(pageInput(page)).toHaveValue("3");
});

test("a question that could not be sent says so, and 重试 sends it", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page);
  let offline = true;
  await page.route(`**/api/v1/agent/sessions/${SESSION}/runs`, (route) => {
    if (route.request().method() !== "POST" || !offline)
      return route.fallback();
    offline = false;
    return route.abort("internetdisconnected");
  });
  await openReader(page, { paperId });
  const box = questionBox(page);
  await box.fill("第三页的图说明了什么？");
  await box.press("Enter");
  const main = page
    .locator('[class*="composer"]')
    .filter({ has: questionBox(page) });
  await expect(main.getByRole("alert")).toHaveText("连接中断，问题没有发出。");
  await expect(box).toHaveValue("第三页的图说明了什么？");
  expect(server.created).toEqual([]);

  await main.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => server.created.length).toBe(1);
  expect(server.created[0].prompt).toBe("第三页的图说明了什么？");
  await expect(box).toHaveValue("");
  await expect(main.getByRole("alert")).toHaveCount(0);
  await assistantTab(page).click();
  await expect(thread(page)).toContainText("排队中…");
});

test("a hidden tab does not read the runs, and reads them as soon as it is seen", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page);
  const run = server.add({
    prompt: "总结一下",
    status: "running",
    response: "正在写",
    runtime: { phase: "model", execution_seconds: 1 },
  });
  await openReader(page, { paperId });
  await assistantTab(page).click();
  await expect(thread(page)).toContainText("正在写");
  const visibility = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => value,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);

  await visibility(true);
  const before = server.polls;
  await page.waitForTimeout(2500);
  // At most the read already on its way when the tab was hidden.
  expect(server.polls - before).toBeLessThanOrEqual(1);

  run.response = "正在写，写完了。";
  await visibility(false);
  await expect(thread(page)).toContainText("写完了。");
});

test("stop cancels the answer being written", async ({ page }) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page);
  server.add({
    prompt: "总结第二页",
    status: "running",
    response: "第二页讲的是",
    runtime: { phase: "model", execution_seconds: 3 },
  });
  await openReader(page, { paperId });
  await assistantTab(page).click();
  await expect(thread(page)).toContainText("第二页讲的是");

  await stopButton(page).click();
  await expect.poll(() => server.cancelled).toEqual(["run-1"]);
  await expect(thread(page)).toContainText("已停止");
  // What was written stays.
  await expect(thread(page)).toContainText("第二页讲的是");
  await expect(stopButton(page)).toHaveCount(0);
  await expect(sendButton(page)).toBeVisible();
});

test("a failed answer says why, and retry asks the same question about the same sentence", async ({
  page,
}) => {
  await signIn(page);
  const { paperId, fileId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page);
  const rects = [{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }];
  server.add({
    prompt: "这句话是什么意思？",
    status: "failed",
    error: "模型服务暂时不可用，请稍后重试",
    runtime: {
      phase: "failed",
      reader_context: {
        paper_id: paperId,
        file_id: fileId,
        page: 2,
        source: "selection",
        action: "ask",
        category: null,
        quote: "Page 2 of 2",
        prefix: "",
        rect: null,
        rects,
        title: "A paper",
        file_name: "paper.pdf",
        file_sha256: "0",
        source_url: `#paper/${paperId}?file=${fileId}&page=2`,
      },
    },
  });
  await openReader(page, { paperId });
  await assistantTab(page).click();

  // The sentence the question was about, above it.
  const log = thread(page);
  await expect(log.locator("blockquote")).toHaveText("Page 2 of 2");
  await expect(log).toContainText("这句话是什么意思？");
  await expect(log).toContainText("模型服务暂时不可用，请稍后重试");

  await log.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => server.created.length).toBe(1);
  expect(server.created[0]).toEqual({
    prompt: "这句话是什么意思？",
    model_config_id: MODEL.id,
    writable: false,
    context: `paper/${paperId}`,
    reader_context: {
      paper_id: paperId,
      file_id: fileId,
      page: 2,
      source: "selection",
      action: "ask",
      quote: "Page 2 of 2",
      prefix: "",
      rects,
    },
  });
  // Asked again: a second turn, about the same sentence.
  await expect(log.locator("blockquote")).toHaveCount(2);
  await expect(log).toContainText("排队中…");
});

test("a service that refuses the question keeps its reason, and the question", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page);
  await page.route(`**/api/v1/agent/sessions/${SESSION}/runs`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 429,
          json: { detail: "今天的助手次数已用完，明天再试" },
        })
      : route.fallback(),
  );
  await openReader(page, { paperId });
  const box = questionBox(page);
  await box.fill("这篇论文的结论可靠吗？");
  await box.press("Enter");
  await expect(
    page
      .locator('[class*="composer"]')
      .filter({ has: questionBox(page) })
      .getByRole("alert"),
  ).toHaveText("今天的助手次数已用完，明天再试");
  await expect(box).toHaveValue("这篇论文的结论可靠吗？");
});

test("the thread follows a growing answer, unless the reader has scrolled up", async ({
  page,
}) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page);
  const long = Array.from(
    { length: 6 },
    (_, index) => `第 ${index + 1} 段：${"这是一段很长的回答。".repeat(12)}`,
  ).join("\n\n");
  for (let index = 0; index < 4; index++)
    server.add({ prompt: `问题 ${index + 1}`, response: long });
  const last = server.add({
    prompt: "最后一个问题",
    status: "running",
    response: "开始回答",
    runtime: { phase: "model", execution_seconds: 1 },
  });
  await openReader(page, { paperId });
  await assistantTab(page).click();
  const log = thread(page);
  await expect(log).toContainText("开始回答");
  const scroller = await panelScroller(log);
  const gap = () =>
    scroller.evaluate(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight,
    );
  await expect.poll(gap).toBeLessThan(2);

  // It grows: the view goes with it.
  last.response = `开始回答\n\n${long}`;
  await expect(log).toContainText("第 6 段");
  await expect.poll(gap).toBeLessThan(2);

  // Scrolled up to read: it stays there while the answer grows.
  await scroller.evaluate((element) => {
    element.scrollTop = 200;
  });
  last.response = `开始回答\n\n${long}\n\n${long}\n\n写完了。`;
  await expect(log).toContainText("写完了。");
  await page.waitForTimeout(1000);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(200);
});

test("without a model the composer says where to add one", async ({ page }) => {
  await signIn(page);
  const { paperId } = await createPaperWithPdf(page);
  const server = new FakeAssistant();
  await server.install(page, []);
  await openReader(page, { paperId });

  const main = page
    .locator('[class*="composer"]')
    .filter({ has: questionBox(page) });
  await expect(main).toContainText("未配置模型");
  await expect(questionBox(page)).toBeDisabled();
  await expect(sendButton(page)).toBeDisabled();
  await expect(
    main.getByRole("link", { name: "添加模型", exact: true }),
  ).toHaveAttribute("href", "#customize/models");
  expect(server.created).toEqual([]);
});
