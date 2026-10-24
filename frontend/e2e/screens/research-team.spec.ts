import { expect, test } from "@playwright/test";
import { signIn } from "../reader/fixtures";
import { createTranslator } from "../../src/i18n/i18n";
import type {
  TeamMember,
  TeamMessage,
  TeamCatchup,
} from "../../src/screens/research/team-api";

// Fake team and model transport; no provider requests are made by these flows.
test.use({ locale: "zh-CN", timezoneId: "Asia/Singapore" });
const workspace = "10000000-0000-0000-0000-000000000001";
const channel = "10000000-0000-0000-0000-000000000002";
const dm = "10000000-0000-0000-0000-000000000003";
const research = "10000000-0000-0000-0000-000000000004";
const otherWorkspace = "10000000-0000-0000-0000-000000000005";
const stamp = "2026-10-23T10:00:00+00:00";

function changedReply(): TeamMessage {
  return {
    id: "file-changes",
    channel_id: channel,
    thread_id: null,
    author_id: "writer",
    text: "Saved draft",
    kind: "text",
    mentions: [],
    created_at: stamp,
    replies: 0,
    data: {
      files: [{ path: "draft.md", name: "draft.md" }],
      commit: "a".repeat(40),
      changes: {
        commit: "a".repeat(40),
        files: [
          { path: "draft.md", added: 13, removed: 0, status: "A" },
          { path: "deleted.md", added: 0, removed: 2, status: "D" },
        ],
        added: 13,
        removed: 2,
      },
    },
  };
}

for (const [locale, theme, width] of [
  ["zh", "light", 1440],
  ["en", "dark", 720],
] as const) {
  test(`${locale}: colleague profile, live status and recent files`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem("paper-locale", locale);
        localStorage.setItem("paper-appearance", theme);
      },
      { locale, theme },
    );
    const { members, messages } = await setup(page);
    const member = members.find((member) => member.id === "writer")!;
    Object.assign(member, {
      description: "Checks evidence",
      tools: ["files", "shell"],
      status: "working",
      active_model: "Offline model",
      elapsed_seconds: 72,
      current_step: {
        name: "bash",
        status: "running",
        arguments: { command: "python train.py" },
      },
    });
    messages.push({
      id: "colleague-message",
      channel_id: channel,
      thread_id: null,
      author_id: "writer",
      text: "Evidence ready",
      kind: "text",
      mentions: [],
      data: { woken_by: "reviewer" },
      replies: 0,
      created_at: stamp,
    });
    let filesRead = 0;
    await page.route("**/team/members/writer", (route) =>
      route.fulfill({
        json: {
          ...member,
          activity: "",
          threads: [],
          recent_files: ["conclusion.md", "shared/plan.md", "metrics.csv"].map(
            (path) => ({ path, name: path }),
          ),
        },
      }),
    );
    await page.route("**/team/file?**", (route) => {
      filesRead++;
      return route.fulfill({
        json: { kind: "markdown", content: "# Saved conclusion" },
      });
    });
    await page.reload();
    const row = page.locator('[data-message-id="colleague-message"]');
    await expect(row).toContainText(t("team.wokenBy", { name: "reviewer" }));
    const profile = row.getByRole("button", {
      name: t("team.colleague.card", { name: "writer" }),
      exact: true,
    });
    await profile.first().hover();
    const card = page.getByRole("dialog", { name: "writer", exact: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText(
      t("team.colleague.working", {
        task: `${t("team.colleague.run")} python train.py`,
        elapsed: t("reader.assistant.duration.minutes", {
          minutes: 1,
          seconds: 12,
        }),
      }),
    );
    await expect(card).toContainText("Checks evidence");
    await expect(card).toContainText("Offline model");
    member.status_text = "Checking citations";
    await page.evaluate(() =>
      window.dispatchEvent(new Event("research-team-updated")),
    );
    await expect(card).toContainText(
      t("team.colleague.working", {
        task: "Checking citations",
        elapsed: t("reader.assistant.duration.minutes", {
          minutes: 1,
          seconds: 12,
        }),
      }),
    );
    await expect(card).not.toContainText("python train.py");
    await expect(
      card.getByRole("button", { name: /\.md$|\.csv$/ }),
    ).toHaveCount(3);
    expect(filesRead).toBe(0);
    await profile.last().click();
    await card
      .getByRole("button", { name: "conclusion.md", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "conclusion.md", exact: true }),
    ).toContainText("Saved conclusion");
    expect(filesRead).toBe(1);
    await page
      .getByRole("complementary", { name: "conclusion.md", exact: true })
      .getByRole("button", { name: t("common.close"), exact: true })
      .click();
    await profile.last().click();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(profile.last()).toBeFocused();
    await profile.last().press("Enter");
    await card
      .getByRole("button", { name: t("team.colleague.send"), exact: true })
      .click();
    const direct = `10000000-0000-0000-0000-${String(members.filter((member) => member.role !== "human").findIndex((member) => member.id === "writer") + 10).padStart(12, "0")}`;
    await expect(page).toHaveURL(new RegExp(`#team/${workspace}/${direct}$`));
    const header = page.getByTestId("team-screen").locator("header").first();
    await expect(header).toContainText("Checking citations");
    if (width === 1440)
      await expect(
        page.locator(
          `[data-id="conversation"][href="#team/${workspace}/${direct}"]`,
        ),
      ).toContainText("Checking citations");
    member.status_text = "";
    await page.evaluate(() =>
      window.dispatchEvent(new Event("research-team-updated")),
    );
    await expect(header).toContainText("python train.py");
    member.active_model = "";
    member.status = "idle";
    await page.evaluate(() =>
      window.dispatchEvent(new Event("research-team-updated")),
    );
    await expect(header).toContainText(t("team.status.idle"));
    await header
      .getByRole("button", {
        name: t("team.colleague.card", { name: "writer" }),
        exact: true,
      })
      .click();
    await expect(card).toContainText("Fake");
    await card
      .getByRole("button", { name: t("team.colleague.details"), exact: true })
      .click();
    await expect(page).toHaveURL(/settings\?thread=member%3Awriter$/);
  });

  test(`${locale}: catch-up stays above unread messages across polling and supports files, collapse and jump`, async ({
    page,
  }) => {
    const { t, tn } = createTranslator(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem("paper-locale", locale);
        localStorage.setItem("paper-appearance", theme);
      },
      { locale, theme },
    );
    const { messages } = await setup(page);
    await expect(
      page.locator(`[data-message-id="research:${research}"]`),
    ).toBeVisible();
    for (let index = 0; index < 6; index++)
      messages.push({
        id: `catchup-${index}`,
        channel_id: channel,
        thread_id: null,
        author_id: "writer",
        text: `Update ${index}`,
        kind: "text",
        mentions: [],
        data: {},
        replies: 0,
        created_at: `2026-10-23T10:0${index}:00+00:00`,
      });
    const data: TeamCatchup = {
      since: stamp,
      through: "2026-10-23T11:00:00+00:00",
      show: true,
      new_messages: 5,
      first_unread: { id: "catchup-1", thread_id: null },
      completed: [{ member_id: "writer", count: 2 }],
      files: [{ path: "conclusion.md", name: "conclusion.md" }],
      handoffs: [
        { message_id: "handoff", member_id: "writer", to: ["reviewer"] },
      ],
      waiting: [
        { message_id: "decision", member_id: "writer", text: "Approve?" },
      ],
      failed: [
        { message_id: "failure", member_id: "executor", text: "Exit 1" },
      ],
    };
    let summaries = 0;
    let reads = 0;
    await page.route("**/team/channels/*/summary", (route) => {
      summaries++;
      return route.fulfill({ json: data });
    });
    await page.route("**/team/channels/*/read", (route) => {
      reads++;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/team/file?**", (route) =>
      route.fulfill({
        json: { kind: "markdown", content: "# Saved conclusion" },
      }),
    );
    await page.reload();
    const summary = page.getByTestId("team-catchup");
    await expect(summary).toBeInViewport();
    await expect(summary).toContainText(
      tn("team.catchup.completed", 2, { name: "writer" }),
    );
    await expect(summary).toContainText("Approve?");
    await expect(summary).toContainText("Exit 1");
    expect(
      await summary.evaluate((element) =>
        element.nextElementSibling?.getAttribute("data-message-id"),
      ),
    ).toBe("catchup-1");
    await summary
      .getByRole("button", { name: t("team.catchup.collapse"), exact: true })
      .click();
    await expect(summary.getByText("Approve?", { exact: false })).toHaveCount(
      0,
    );
    await summary
      .getByRole("button", { name: t("team.catchup.expand"), exact: true })
      .click();
    await summary
      .getByRole("button", { name: t("team.catchup.jump"), exact: true })
      .click();
    await expect(page.locator('[data-message-id="catchup-1"]')).toBeFocused();
    await summary
      .getByRole("button", { name: "conclusion.md", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "conclusion.md", exact: true }),
    ).toContainText("Saved conclusion");
    // At 720px the preview replaces the channel, so the summary is checked
    // with the preview closed.
    await page
      .getByRole("complementary", { name: "conclusion.md", exact: true })
      .getByRole("button", { name: t("common.close"), exact: true })
      .click();
    const readBeforePoll = reads;
    data.show = false;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("research-team-updated")),
    );
    await expect.poll(() => reads).toBeGreaterThan(readBeforePoll);
    expect(summaries).toBe(1);
    await expect(summary).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(summary).toHaveCount(0);
    messages.push({
      ...messages[1],
      id: "thread-first",
      thread_id: "catchup-0",
      text: "First unread reply",
    });
    data.show = true;
    data.first_unread = { id: "thread-first", thread_id: "catchup-0" };
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(summary).toBeVisible();
    await summary
      .getByRole("button", { name: t("team.catchup.jump"), exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: t("team.thread"), exact: true })
        .locator('[data-message-id="thread-first"]'),
    ).toBeFocused();
  });
}

for (const [locale, theme, width] of [
  ["zh", "light", 1440],
  ["en", "dark", 720],
] as const) {
  test(`${locale} ${theme}: member changes support lazy diffs, confirmation and a persistent revert receipt`, async ({
    page,
  }) => {
    const { t, tn } = createTranslator(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem("paper-locale", locale);
        localStorage.setItem("paper-appearance", theme);
      },
      { locale, theme },
    );
    const { messages } = await setup(page);
    const reply = changedReply();
    reply.text = "";
    reply.run = {
      id: "file-run",
      status: "completed",
      response: "",
      error: "",
      steps: [],
      runtime: {},
      created_at: stamp,
      updated_at: stamp,
    };
    messages.push(reply, {
      ...reply,
      id: "no-changes",
      text: "No files",
      data: {},
    });
    const reads: string[] = [];
    let reverts = 0;
    await page.route("**/team/messages/file-changes/diff?**", (route) => {
      const path = new URL(route.request().url()).searchParams.get("path")!;
      reads.push(path);
      return route.fulfill({
        json: {
          path,
          diff:
            path === "draft.md"
              ? "--- /dev/null\n+++ b/draft.md\n@@ -0,0 +1 @@\n+Saved draft"
              : "--- a/deleted.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-Old draft",
          truncated: false,
        },
      });
    });
    await page.route("**/team/messages/file-changes/revert", (route) => {
      expect(route.request().method()).toBe("POST");
      reverts++;
      reply.data.reverted_by = "b".repeat(40);
      return route.fulfill({ json: reply });
    });
    await page.reload();
    const row = page.locator('[data-message-id="file-changes"]');
    await expect(
      row.getByText(t("team.noContent"), { exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByText(t("team.noAnswer"), { exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByText(tn("team.changes.files", 2), { exact: true }),
    ).toBeVisible();
    await expect(row.getByText("+13", { exact: true })).toBeVisible();
    await expect(row.getByText("−2", { exact: true })).toBeVisible();
    await expect(
      page
        .locator('[data-message-id="no-changes"]')
        .getByRole("button", { name: t("team.changes.view"), exact: true }),
    ).toHaveCount(0);
    expect(reads).toEqual([]);
    const file = await row
      .getByRole("button", { name: "draft.md", exact: true })
      .boundingBox();
    const view = row.getByRole("button", {
      name: t("team.changes.view"),
      exact: true,
    });
    const actions = await view.boundingBox();
    expect(actions!.y).toBeGreaterThanOrEqual(file!.y + file!.height);
    await view.click();
    const diff = page.getByRole("dialog", {
      name: t("research.changes.view"),
      exact: true,
    });
    await expect(diff.locator("pre")).toContainText("+Saved draft");
    expect(reads).toEqual(["draft.md"]);
    await diff.locator("summary").filter({ hasText: "deleted.md" }).click();
    await expect(diff.locator("pre").last()).toContainText("-Old draft");
    expect(reads).toEqual(["draft.md", "deleted.md"]);
    await diff
      .getByRole("button", { name: t("common.close"), exact: true })
      .click();
    await row
      .getByRole("button", { name: t("research.changes.undo"), exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: t("team.changes.confirm"),
      exact: true,
    });
    expect(reverts).toBe(0);
    await confirmation
      .getByRole("button", { name: t("common.cancel"), exact: true })
      .click();
    expect(reverts).toBe(0);
    await row
      .getByRole("button", { name: t("research.changes.undo"), exact: true })
      .click();
    await confirmation
      .getByRole("button", { name: t("research.changes.undo"), exact: true })
      .click();
    await expect(row.getByRole("status")).toHaveText(
      t("team.changes.reverted"),
    );
    expect(reverts).toBe(1);
    await expect(
      row.getByRole("button", {
        name: t("research.changes.undo"),
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(view).toBeVisible();
    await page.reload();
    await expect(row.getByRole("status")).toHaveText(
      t("team.changes.reverted"),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("member changes keep conflicts visible and retry diff reads", async ({
  page,
}) => {
  const { messages } = await setup(page);
  messages.push(changedReply());
  let reads = 0;
  await page.route("**/team/messages/file-changes/diff?**", (route) => {
    reads++;
    return reads === 1
      ? route.fulfill({ status: 409, json: { detail: "Diff unavailable" } })
      : route.fulfill({
          json: { path: "draft.md", diff: "+partial draft", truncated: true },
        });
  });
  await page.route("**/team/messages/file-changes/revert", (route) =>
    route.fulfill({
      status: 409,
      json: {
        detail: {
          message: "撤销冲突 / Revert conflict",
          conflicts: ["draft.md"],
        },
      },
    }),
  );
  await page.reload();
  const row = page.locator('[data-message-id="file-changes"]');
  await row.getByRole("button", { name: "查看", exact: true }).click();
  const diff = page.getByRole("dialog", { name: "查看变更", exact: true });
  await expect(diff.getByRole("alert")).toContainText("Diff unavailable");
  await diff.getByRole("button", { name: "重试", exact: true }).click();
  await expect(diff.locator("pre")).toContainText("+partial draft");
  await expect(diff.getByText("已截断", { exact: true })).toBeVisible();
  await diff.getByRole("button", { name: "关闭", exact: true }).click();
  await row.getByRole("button", { name: "撤销", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: "撤销这次改动？",
    exact: true,
  });
  await confirmation.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toHaveText(
    "撤销冲突 / Revert conflict · draft.md",
  );
  await expect(row.getByText("已撤销", { exact: true })).toHaveCount(0);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "撤销", exact: true }),
  ).toBeVisible();
});

for (const [locale, theme, width] of [
  ["zh", "light", 1440],
  ["en", "dark", 720],
] as const) {
  test(`${locale}: reactions toggle, forwards link to sources, selected quotes become thread replies`, async ({
    page,
  }) => {
    const { t, tn } = createTranslator(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem("paper-locale", locale);
        localStorage.setItem("paper-appearance", theme);
      },
      { locale, theme },
    );
    const { messages, posted } = await setup(page);
    messages.push({
      id: "feature-source",
      channel_id: channel,
      thread_id: null,
      author_id: "librarian",
      text: "A useful finding",
      kind: "text",
      mentions: [],
      data: {},
      created_at: stamp,
      replies: 0,
    });
    await page.reload();
    const source = page.locator('[data-message-id="feature-source"]');
    await source.hover();
    for (const emoji of ["👍", "👎", "✅"]) {
      await source.hover();
      await source
        .getByRole("button", { name: t("team.react"), exact: true })
        .click();
      const picker = page.getByRole("menu", {
        name: t("team.react"),
        exact: true,
      });
      await expect(picker.getByRole("menuitem")).toHaveCount(3);
      await picker.getByRole("menuitem", { name: emoji, exact: true }).click();
      const reaction = source.getByRole("button", {
        name: `${emoji} ${tn("team.reactionCount", 1)}`,
        exact: true,
      });
      await expect(reaction).toHaveAttribute("aria-pressed", "true");
      await reaction.click();
      await expect(reaction).toHaveCount(0);
    }
    await source.hover();
    await source
      .getByRole("button", { name: t("research.actions"), exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: t("team.forward"), exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: t("team.forward"),
      exact: true,
    });
    await dialog
      .getByRole("button", { name: t("team.forwardTo"), exact: true })
      .click();
    await page
      .getByRole("menu", { name: t("team.forwardTo"), exact: true })
      .getByRole("menuitemradio", { name: "advisor", exact: true })
      .click();
    await dialog
      .getByRole("textbox", { name: t("team.forwardNote"), exact: true })
      .fill("Please check");
    await dialog
      .getByRole("button", { name: t("team.forward"), exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(() =>
        posted.some(
          (body) =>
            body.forward_message_id === "feature-source" &&
            body.text === "Please check",
        ),
      )
      .toBe(true);
    await page.goto(`/#team/${workspace}/${dm}`);
    const forwarded = page.getByTestId("team-forward");
    await expect(forwarded).toContainText("A useful finding");
    await expect(forwarded).toContainText("librarian");
    await expect(forwarded.locator("time")).toHaveAttribute("datetime", stamp);
    await forwarded.click();
    await expect(source).toHaveAttribute("data-located", "true");
    const selectQuote = async () => {
      await source.locator("[data-message-text] p").evaluate((element) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, 2);
        range.setEnd(element.firstChild!, element.textContent!.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await source
        .getByRole("button", { name: t("team.quote"), exact: true })
        .click();
    };
    await selectQuote();
    const draft = page.getByTestId("team-quote-draft");
    await expect(draft).toContainText("useful finding");
    await draft
      .getByRole("button", { name: t("team.removeQuote"), exact: true })
      .click();
    await expect(draft).toHaveCount(0);
    await selectQuote();
    const composer = page.getByRole("textbox", {
      name: t("team.message"),
      exact: true,
    });
    await composer.fill("Quote comment");
    await composer.press("Enter");
    await expect
      .poll(() =>
        posted.some(
          (body) =>
            body.thread_id === "feature-source" &&
            (body.quote as { text?: string })?.text === "useful finding",
        ),
      )
      .toBe(true);
    const thread = page.getByRole("region", {
      name: t("team.thread"),
      exact: true,
    });
    await expect(thread.getByTestId("team-quote")).toContainText(
      "useful finding",
    );
    await expect(thread.getByTestId("team-quote-draft")).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });
}

async function setup(page: import("@playwright/test").Page) {
  let working = false;
  const posted: Record<string, unknown>[] = [];
  const messages: TeamMessage[] = [];
  const saved = new Map<
    string,
    { message: TeamMessage; completed: boolean; saved_at: string }
  >();
  const deliveries: Record<string, unknown>[] = [];
  const members: TeamMember[] = [
    "human",
    "advisor",
    "executor",
    "librarian",
    "reviewer",
    "writer",
    "distiller",
  ].map((role) => ({
    id: role,
    role,
    name: role,
    status: "idle",
    active_run_id: null,
  }));
  const project = {
    id: research,
    workspace_id: workspace,
    session_id: "session",
    question: "研究问题",
    title: "研究问题",
    stage: "scoping",
    status: "paused",
    plan: {},
    conclusion_record: {},
    environment: {},
    budget: {},
    spent: {},
    workflow: null,
    created_at: stamp,
    updated_at: stamp,
  };
  const root: TeamMessage = {
    id: `research:${research}`,
    channel_id: channel,
    thread_id: null,
    author_id: "human",
    text: "研究问题",
    kind: "research",
    mentions: [],
    data: { research_id: research, title: "研究问题" },
    replies: 1,
    created_at: stamp,
  };
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({ json: { mode: "local" } }),
  );
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        configured: true,
        active_id: "model",
        models: [
          { id: "model", name: "Fake", model: "Fake", protocol: "openai" },
        ],
      },
    }),
  );
  await page.route("**/api/v1/research/navigation", (route) =>
    route.fulfill({
      json: {
        workspaces: [
          {
            id: workspace,
            name: "表示学习",
            location: { kind: "managed", path: "", connection_id: "" },
            researches: [],
            archived: false,
          },
          {
            id: otherWorkspace,
            name: "图学习",
            location: { kind: "managed", path: "", connection_id: "" },
            researches: [],
            archived: false,
          },
        ],
        collections: [],
      },
    }),
  );
  await page.route("**/api/v1/research/connections", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/research/settings", (route) =>
    route.fulfill({ json: { computes: [], states: {} } }),
  );
  await page.route(`**/api/v1/research/projects/${research}`, (route) =>
    route.fulfill({
      json: {
        project,
        nodes: [],
        sprints: [],
        jobs: [],
        datasets: [],
        input_needed: "",
        docker: {},
      },
    }),
  );
  await page.route(`**/api/v1/research/projects/${research}/events*`, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(`**/api/v1/research/projects/${research}/changes`, (route) =>
    route.fulfill({ json: { files: [], added: 0, removed: 0 } }),
  );
  await page.route(`**/api/v1/research/projects/${research}/runs`, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/research/workspaces/*/team**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith("/team"))
      return route.fulfill({
        json: {
          workspace_id: path.split("/")[5],
          members: members.map((m) => ({
            ...m,
            status: working && m.role === "advisor" ? "working" : m.status,
          })),
          channels: [
            {
              id: channel,
              key: "experiments",
              name: "实验",
              member_id: null,
              unread: 0,
              pinned_count: [root, ...messages].filter(
                (m) => m.channel_id === channel && m.pinned,
              ).length,
              last_message: null,
              last_at: stamp,
              working_member_ids: working ? ["advisor"] : [],
            },
            ...members
              .filter((m) => m.role !== "human")
              .map((m, index) => ({
                id:
                  m.role === "advisor"
                    ? dm
                    : `10000000-0000-0000-0000-${String(index + 10).padStart(12, "0")}`,
                key: `dm:${m.role}`,
                name: m.name,
                member_id: m.id,
                unread: 0,
                last_message: null,
                last_at: stamp,
                working_member_ids:
                  working && m.role === "advisor" ? [m.id] : [],
              })),
          ],
          notifications: [],
        },
      });
    if (path.endsWith("/read")) return route.fulfill({ json: { ok: true } });
    if (path.includes("/reactions/")) {
      const [messageId, encodedEmoji] = path
        .split("/messages/")[1]
        .split("/reactions/");
      const message = messages.find((message) => message.id === messageId);
      if (!message) return route.fulfill({ status: 404, json: {} });
      const emoji = decodeURIComponent(encodedEmoji) as "👍" | "👎" | "✅";
      message.reactions = (message.reactions || []).filter(
        (reaction) => reaction.emoji !== emoji,
      );
      if (request.method() === "PUT")
        message.reactions.push({ emoji, count: 1, mine: true });
      return route.fulfill({ json: message.reactions });
    }
    if (path.endsWith("/summary"))
      return route.fulfill({
        json: {
          since: stamp,
          through: stamp,
          show: false,
          new_messages: 0,
          first_unread: null,
          completed: [],
          files: [],
          handoffs: [],
          waiting: [],
          failed: [],
        },
      });
    if (path.endsWith("/saved"))
      return route.fulfill({
        json: [...saved.values()].map(({ message, ...state }) => ({
          ...message,
          ...state,
        })),
      });
    if (path.includes("/marks/")) {
      const body = request.postDataJSON();
      const identifier = decodeURIComponent(
        path.split("/messages/")[1].split("/marks/")[0],
      );
      const message = [root, ...messages].find((m) => m.id === identifier);
      if (!message || message.channel_id !== body.channel_id)
        return route.fulfill({ status: 404, json: {} });
      if (path.endsWith("/pin")) message.pinned = request.method() !== "DELETE";
      else if (request.method() === "DELETE") saved.delete(identifier);
      else
        saved.set(identifier, {
          message,
          completed:
            body.completed ?? saved.get(identifier)?.completed ?? false,
          saved_at: stamp,
        });
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/deliveries"))
      return route.fulfill({ json: deliveries });
    if (path.includes("/deliveries/")) {
      const body = request.postDataJSON();
      posted.push(body);
      const index = deliveries.findIndex(
        (d) => d.id === path.split("/").at(-1),
      );
      if (index < 0) return route.fulfill({ status: 404, json: {} });
      if (body.cancel) deliveries.splice(index, 1);
      else {
        Object.assign(deliveries[index], body);
        if (body.text)
          messages.find((m) => m.id === deliveries[index].message_id)!.text =
            body.text;
        if (body.mode === "immediate") deliveries[index].status = "steering";
      }
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/messages")) {
      const target = path.split("/channels/")[1].split("/")[0];
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        posted.push(body);
        const sourceReference = (id: string, text?: string) => {
          const source = messages.find((message) => message.id === id)!;
          return {
            message_id: source.id,
            channel_id: source.channel_id,
            thread_id: source.thread_id,
            author_id: source.author_id,
            author_name:
              members.find((member) => member.id === source.author_id)?.name ||
              "",
            created_at: source.created_at,
            text: text ?? source.text,
          };
        };
        const message: TeamMessage = {
          id: crypto.randomUUID(),
          channel_id: target,
          thread_id: body.thread_id || null,
          author_id: "human",
          text: body.text,
          kind: "message",
          mentions: [],
          data: {
            ...(body.forward_message_id
              ? { forward: sourceReference(body.forward_message_id) }
              : {}),
            ...(body.quote
              ? {
                  quote: sourceReference(
                    body.quote.message_id,
                    body.quote.text,
                  ),
                }
              : {}),
          },
          created_at: stamp,
          replies: 0,
        };
        messages.push(message);
        if (body.also_channel) {
          message.data.also_channel = true;
          messages.push({
            ...message,
            id: crypto.randomUUID(),
            thread_id: null,
            data: {
              thread_origin: {
                thread_id: message.thread_id!,
                message_id: message.id,
              },
            },
          });
        }
        if (working && body.mode === "queue")
          deliveries.push({
            id: crypto.randomUUID(),
            member_id: "advisor",
            message_id: message.id,
            channel_id: target,
            thread_id: message.thread_id,
            text: body.text,
            mode: body.mode,
            status: "queued",
            error: "",
            editable: true,
          });
        working =
          body.text.includes("@advisor") ||
          body.text.includes("@导师") ||
          target === dm;
        return route.fulfill({ json: message });
      }
      const thread = url.searchParams.get("thread_id");
      const messageOut = (message: TeamMessage) => {
        const replies = messages
          .filter((m) => m.thread_id === message.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return replies.length
          ? {
              ...message,
              replies: replies.length,
              reply_authors: [
                ...new Set(
                  replies.map((m) => m.author_id).filter((id) => !!id),
                ),
              ],
              last_message_at: replies[0].created_at,
            }
          : message;
      };
      return route.fulfill({
        json: {
          activity: thread
            ? []
            : [
                ...(target === channel ? [root] : []),
                ...messages.filter((m) => m.channel_id === target),
              ],
          messages: [
            ...(!thread && target === channel ? [root] : []),
            ...messages.filter(
              (m) =>
                m.channel_id === target && m.thread_id === (thread || null),
            ),
          ].map(messageOut),
          root:
            thread === root.id
              ? root
              : messages.find((m) => m.id === thread) || null,
          research_id: thread === root.id ? research : null,
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  await signIn(page);
  await page.goto(`/#team/${workspace}/${channel}`);
  return { posted, messages, members };
}

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: pins locate thread messages and Later keeps private completion state`, async ({
    page,
  }) => {
    const { t, tn } = createTranslator(locale);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript((value) => {
      localStorage.setItem("paper-locale", value);
      localStorage.setItem("team-side-panel", "true");
    }, locale);
    const { messages } = await setup(page);
    const request: TeamMessage = {
      id: "pin-root",
      channel_id: channel,
      thread_id: null,
      author_id: "human",
      text: "Question",
      kind: "text",
      mentions: [],
      data: {},
      created_at: stamp,
      replies: 1,
    };
    messages.push(request, {
      ...request,
      id: "pinned-answer",
      thread_id: request.id,
      author_id: "writer",
      text: "A pinned finding",
      replies: 0,
      data: { files: [{ path: "finding.md", name: "finding.md" }] },
    });
    await page.goto(`/#team/${workspace}/${channel}?thread=${request.id}`);
    const thread = page.getByRole("region", {
      name: t("team.thread"),
      exact: true,
    });
    const answer = thread.locator('[data-message-id="pinned-answer"]');
    const more = async (label: string) => {
      await answer.hover();
      await answer
        .getByRole("button", { name: t("research.actions"), exact: true })
        .click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    await more(t("team.pin"));
    await expect(
      page.getByRole("button", { name: tn("team.pins", 1), exact: true }),
    ).toBeVisible();
    await more(t("team.saveLater"));
    await thread
      .getByRole("button", { name: t("common.close"), exact: true })
      .click();
    const panel = page.getByTestId("team-side-panel");
    const pin = panel.locator('[data-pin-id="pinned-answer"]');
    await expect(pin).toContainText("A pinned finding");
    await expect(pin).toContainText("finding.md");
    await pin.click();
    await expect(answer).toHaveAttribute("data-located", "true");
    await more(t("team.unpin"));
    await expect(
      page.getByRole("button", { name: tn("team.pins", 0), exact: true }),
    ).toBeVisible();
    await page.goto(`/#team/${workspace}/mentions`);
    const later = () =>
      page.getByRole("radio", { name: t("team.later"), exact: true });
    await later().click();
    const saved = page.locator('[data-saved-id="pinned-answer"]');
    await expect(saved).toContainText("A pinned finding");
    await saved
      .getByRole("button", { name: t("team.later.complete"), exact: true })
      .click();
    await expect(saved).toHaveAttribute("data-completed", "true");
    await page.reload();
    await later().click();
    await expect(saved).toContainText(t("team.later.completed"));
    await saved
      .getByRole("button", { name: t("team.later.reopen"), exact: true })
      .click();
    await expect(saved).not.toHaveAttribute("data-completed", "true");
    await saved.getByRole("button").first().click();
    await expect(answer).toHaveAttribute("data-located", "true");
    await page.goto(`/#team/${workspace}/mentions`);
    await later().click();
    await saved
      .getByRole("button", { name: t("team.later.remove"), exact: true })
      .click();
    await expect(saved).toHaveCount(0);
  });

  test(`${locale}: thread checkbox shares one reply to the channel and links back`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    const { messages, posted } = await setup(page);
    messages.push({
      id: "broadcast-root",
      channel_id: channel,
      thread_id: null,
      author_id: "human",
      text: "Question",
      kind: "text",
      mentions: [],
      data: {},
      created_at: stamp,
      replies: 0,
    });
    await page.goto(`/#team/${workspace}/${channel}?thread=broadcast-root`);
    const thread = page.getByRole("region", {
      name: t("team.thread"),
      exact: true,
    });
    const checkbox = thread.getByRole("checkbox", {
      name: t("team.alsoChannel", {
        channel: locale === "zh" ? "#实验" : "#Experiments",
      }),
      exact: true,
    });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    const composer = thread.getByRole("textbox", {
      name: t("team.message"),
      exact: true,
    });
    await composer.fill("Shared conclusion");
    await composer.press("Enter");
    await expect
      .poll(() => posted.filter((p) => p.text === "Shared conclusion").length)
      .toBe(1);
    expect(posted.find((p) => p.text === "Shared conclusion")).toMatchObject({
      also_channel: true,
      thread_id: "broadcast-root",
    });
    const broadcast = messages.find((m) => m.data.thread_origin)!;
    expect(messages.filter((m) => m.text === "Shared conclusion")).toHaveLength(
      2,
    );
    await thread
      .getByRole("button", { name: t("common.close"), exact: true })
      .click();
    const channelReply = page.locator(`[data-message-id="${broadcast.id}"]`);
    await expect(channelReply).toContainText("Shared conclusion");
    await channelReply
      .getByRole("button", { name: t("team.fromThread"), exact: true })
      .click();
    await expect(
      thread.locator(
        `[data-message-id="${broadcast.data.thread_origin!.message_id}"]`,
      ),
    ).toHaveAttribute("data-located", "true");
    await checkbox.uncheck();
    await composer.fill("Thread only");
    await composer.press("Enter");
    await expect
      .poll(() => posted.some((p) => p.text === "Thread only"))
      .toBe(true);
    expect(posted.find((p) => p.text === "Thread only")).toMatchObject({
      also_channel: false,
    });
    expect(messages.filter((m) => m.text === "Thread only")).toHaveLength(1);
    await page.goto(`/#team/${workspace}/${dm}?thread=direct-root`);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });
}

test("member answers stay inline until the user replies; threads show participants", async ({
  page,
}) => {
  const { posted, messages } = await setup(page);
  const screen = page.getByTestId("team-screen");
  const composer = screen.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("频道消息");
  await composer.press("Enter");
  const message = screen.locator("article").filter({ hasText: "频道消息" });
  await expect(message).toBeVisible();
  messages.push({
    ...messages[0],
    id: "inline-answer",
    author_id: "librarian",
    text: "会话中的回答",
    created_at: "2026-10-23T10:01:00+00:00",
  });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("research-team-updated")),
  );
  const answer = screen.locator('[data-message-id="inline-answer"]');
  await expect(answer.getByText("会话中的回答", { exact: true })).toBeVisible();
  await expect(answer).toHaveAttribute("data-author", "agent");
  await expect(answer.getByText("智能体", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "线程", exact: true }),
  ).toHaveCount(0);
  await expect(answer.getByRole("button", { name: /条回复/ })).toHaveCount(0);
  await answer.hover();
  await answer.getByRole("button", { name: "回复", exact: true }).click();
  const thread = page.getByRole("region", { name: "线程", exact: true });
  await thread
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("@writer 线程回复");
  await thread
    .getByRole("textbox", { name: "消息", exact: true })
    .press("Enter");
  await expect
    .poll(() => posted.some((m) => m.thread_id === "inline-answer"))
    .toBe(true);
  messages.push({
    ...messages[0],
    id: "thread-answer",
    thread_id: "inline-answer",
    author_id: "writer",
    text: "线程中的回答",
    created_at: "2026-10-23T10:02:00+00:00",
  });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("research-team-updated")),
  );
  await expect(thread.getByText("线程中的回答", { exact: true })).toBeVisible();
  await thread.getByRole("button", { name: "全屏线程" }).click();
  await expect(thread).toBeVisible();
  await thread.getByRole("button", { name: "关闭", exact: true }).click();
  const entry = answer.getByRole("button", { name: "2 条回复", exact: true });
  await expect(entry).toBeVisible();
  await expect(
    entry.getByRole("group", { name: "参与者", exact: true }).getByRole("img"),
  ).toHaveCount(2);
  await expect(entry.locator("time")).toHaveAttribute(
    "datetime",
    "2026-10-23T10:02:00+00:00",
  );
  await expect(screen.locator('[data-message-id="thread-answer"]')).toHaveCount(
    0,
  );
  await screen.getByRole("button", { name: "研究问题", exact: true }).click();
  await expect(thread.getByRole("heading", { name: "研究问题" })).toBeVisible();
});

test("mention completion, queue edits, immediate send and direct messages", async ({
  page,
}) => {
  const { posted } = await setup(page);
  let composer = page
    .getByTestId("team-screen")
    .getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("@ad");
  await page.getByRole("option", { name: /^advisor / }).click();
  await expect(composer).toHaveValue("@advisor ");
  await composer.press("End");
  await composer.press("a");
  await composer.press("Enter");
  await expect
    .poll(() => posted.some((m) => m.text === "@advisor a"))
    .toBe(true);
  await composer.fill("@advisor 排队消息");
  await expect(
    page.getByRole("navigation").getByRole("img", { name: "工作中" }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("team-screen")
      .getByRole("button", { name: "立即发送", exact: true }),
  ).toBeVisible();
  await composer.press("Enter");
  const queued = page
    .getByTestId("team-queue")
    .filter({ hasText: "@advisor 排队消息" });
  await expect(queued.getByText("排队中", { exact: true })).toBeVisible();
  await queued.getByRole("button", { name: "编辑消息", exact: true }).click();
  await page
    .getByRole("textbox", { name: "编辑消息", exact: true })
    .fill("@advisor 修改后");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() => posted.some((m) => m.text === "@advisor 修改后"))
    .toBe(true);
  await expect(
    page.getByTestId("team-queue").filter({ hasText: "@advisor 修改后" }),
  ).toBeVisible();
  await composer.fill("@advisor 撤回消息");
  await composer.press("Enter");
  await page
    .getByTestId("team-queue")
    .filter({ hasText: "@advisor 撤回消息" })
    .getByRole("button", { name: "撤回", exact: true })
    .click();
  await expect.poll(() => posted.some((m) => m.cancel === true)).toBe(true);
  await expect(
    page.getByTestId("team-queue").filter({ hasText: "@advisor 撤回消息" }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("team-queue").filter({ hasText: "@advisor 修改后" }),
  ).toBeVisible();
  await composer.fill("@advisor 改成立即发送");
  await composer.press("Enter");
  await page
    .getByTestId("team-queue")
    .filter({ hasText: "@advisor 改成立即发送" })
    .getByRole("button", { name: "立即发送", exact: true })
    .click();
  await expect
    .poll(() => posted.some((m) => m.mode === "immediate" && !m.client_id))
    .toBe(true);
  const steering = page
    .getByTestId("team-queue")
    .filter({ hasText: "@advisor 改成立即发送" });
  await expect(steering.getByText("发送中", { exact: true })).toBeVisible();
  await expect(steering.getByRole("button")).toHaveCount(0);
  await composer.fill("@advisor 插话");
  await composer.press("Control+Enter");
  await expect
    .poll(() =>
      posted.some(
        (m) =>
          m.mode === "immediate" && m.text === "@advisor 插话" && !!m.client_id,
      ),
    )
    .toBe(true);
  await page.goto(`/#team/${workspace}/${dm}`);
  composer = page
    .getByTestId("team-screen")
    .getByRole("textbox", { name: "消息", exact: true });
  await expect(
    page.getByRole("region", { name: "advisor", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Fake", exact: true }),
  ).toBeVisible();
  await composer.fill("私信消息");
  await composer.press("Enter");
  await expect
    .poll(() => posted.find((m) => m.text === "私信消息"))
    .toMatchObject({
      text: "私信消息",
      model_config_id: "model",
      mode: "queue",
    });
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: team name, composer focus, actions and member status stay consistent`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("paper-appearance", value),
      theme,
    );
    const { messages, members } = await setup(page);
    members.find((m) => m.role === "advisor")!.status = "working";
    members.find((m) => m.role === "reviewer")!.status = "waiting";
    for (const role of ["advisor", "reviewer", "writer"]) {
      messages.push({
        id: `status-${role}`,
        channel_id: channel,
        thread_id: null,
        author_id: role,
        text: `来自 ${role}`,
        kind: "message",
        mentions: [],
        data: {},
        created_at: stamp,
        replies: 0,
      });
    }
    await page.reload();
    const screen = page.getByTestId("team-screen");
    const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
    const switcher = sidebar.getByRole("button", {
      name: "切换项目",
      exact: true,
    });
    await expect(switcher).toHaveText("表示学习");
    for (const [role, status] of [
      ["advisor", "工作中"],
      ["reviewer", "等你"],
      ["writer", "空闲"],
    ]) {
      // The author avatar and its DM row must expose the same status and geometry.
      const avatar = screen
        .locator(`[data-message-id="status-${role}"]`)
        .getByRole("img", { name: status, exact: true });
      const dmRow = sidebar
        .getByRole("group", { name: "消息", exact: true })
        .getByRole("link", { name: role, exact: true });
      const marker = dmRow
        .locator("..")
        .getByRole("img", { name: status, exact: true });
      await expect(
        marker.locator("..").locator('svg[shape-rendering="crispEdges"]'),
      ).toBeVisible();
      await expect(marker).toHaveCSS("position", "absolute");
      await expect(marker).toHaveCSS("right", "0px");
      await expect(marker).toHaveCSS("bottom", "0px");
      await expect(avatar).toBeVisible();
      await expect(avatar).toHaveCSS(
        "width",
        await marker.evaluate((el) => getComputedStyle(el).width),
      );
      await expect(avatar).toHaveCSS(
        "height",
        await marker.evaluate((el) => getComputedStyle(el).height),
      );
      await expect(avatar).toHaveCSS(
        "background-color",
        await marker.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      if (role === "writer") {
        const neutral = await avatar.evaluate((el) => {
          const style = document.createElement("span").style;
          style.color = getComputedStyle(el).getPropertyValue("--ui-fg-3");
          return style.color;
        });
        await expect(avatar).toHaveCSS("background-color", neutral);
      }
    }
    const header = screen.locator("header").first();
    await expect(header).toHaveCSS("height", "52px");
    await expect(header).toHaveCSS("border-bottom-width", "0px");
    await expect(
      header.getByRole("button", { name: "新研究", exact: true }),
    ).toHaveCount(0);
    await header.getByRole("button", { name: "更多操作", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "新研究", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const input = screen.getByRole("textbox", { name: "消息", exact: true });
    await input.focus();
    await expect(input).toHaveCSS("border-top-width", "0px");
    await expect(input).toHaveCSS("box-shadow", "none");
    await expect(input).toHaveCSS("font-size", "15px");
    await expect(input).toHaveCSS("line-height", "24px");
    await expect(input).toHaveCSS("min-height", "36px");
    await expect(input).toHaveCSS("max-height", "280px");
    await expect(input).toHaveCSS("padding", "4px 6px 8px");
    const composer = input.locator("..");
    await expect(composer).toHaveCSS("padding", "10px 10px 10px 12px");
    await expect(composer.locator("footer")).toHaveCSS("gap", "2px");
    await expect(composer.locator("footer")).toHaveCSS("padding-top", "0px");
    const send = composer.getByRole("button", { name: "发送", exact: true });
    await expect(send).toHaveCSS("width", "34px");
    await expect(send).toHaveCSS("height", "34px");
    await expect(send).toHaveCSS("opacity", "1");
    await expect(send.locator("svg")).toHaveCSS("width", "18px");
    expect(
      await input
        .locator("..")
        .evaluate((el) => getComputedStyle(el).boxShadow),
    ).not.toBe("none");
    await page.setViewportSize({ width: 720, height: 900 });
    await input.focus();
    await expect(input).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await sidebar
      .getByRole("button", { name: "展开侧栏", exact: true })
      .click();
    await switcher.click();
    const picker = page.getByRole("dialog", { name: "选择项目", exact: true });
    await picker.getByRole("option", { name: /图学习/ }).click();
    await expect(page).toHaveURL(new RegExp(`#team/${otherWorkspace}$`));
    await sidebar
      .getByRole("button", { name: "展开侧栏", exact: true })
      .click();
    await expect(switcher).toHaveText("图学习");
  });
}

test("DM empty state shows its member card", async ({ page }) => {
  const { members } = await setup(page);
  Object.assign(members.find((m) => m.id === "advisor")!, {
    description: "研究规划",
    model_config_id: "model",
    tools: ["literature", "files"],
  });
  await page.goto(`/#team/${workspace}/${dm}`);
  const empty = page.getByTestId("team-empty");
  // The decorative pixel avatar leaves the file-defined name on the card.
  await expect(
    empty.locator('svg[shape-rendering="crispEdges"]'),
  ).toBeVisible();
  await expect(empty.locator('span[aria-hidden="true"]')).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(empty.getByText("advisor", { exact: true })).toBeVisible();
  await expect(empty.getByText("研究规划", { exact: true })).toBeVisible();
  await expect(empty.getByText("Fake", { exact: true })).toBeVisible();
  await expect(empty.getByText("文献", { exact: true })).toBeVisible();
  await expect(empty.getByText("文件", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveAttribute("placeholder", "发送给 advisor");
});

test("one author, preserved draft, one timeout and Continue on the agent message", async ({
  page,
}) => {
  const { messages } = await setup(page);
  messages.push({
    id: "limited",
    channel_id: channel,
    thread_id: null,
    author_id: "writer",
    text: "已写好的引言",
    kind: "text",
    mentions: [],
    created_at: stamp,
    replies: 0,
    data: { files: [{ path: "drafts/intro.md", name: "intro.md" }] },
    run: {
      id: "run-limited",
      status: "failed",
      response: "已写好的引言",
      error: "timeout",
      steps: [],
      runtime: { time_limit_reached: true, max_execution_seconds: 1200 },
      created_at: stamp,
      updated_at: stamp,
    },
  });
  await page.route("**/team/file?**", (route) =>
    route.fulfill({
      json: { kind: "markdown", content: "# 引言\n\n已保存的正文" },
    }),
  );
  await page.route("**/team/deliveries", (route) =>
    route.fulfill({
      json: [
        {
          id: "agent-failure",
          channel_id: channel,
          thread_id: null,
          editable: false,
          status: "failed",
          error: "timeout",
          text: "",
          mode: "queue",
        },
      ],
    }),
  );
  let continued = 0;
  await page.route("**/team/messages/limited/continue", (route) => {
    continued++;
    return route.fulfill({ json: {} });
  });
  await page.reload();
  const row = page.locator('[data-message-id="limited"]');
  await expect(row.getByText("writer", { exact: true })).toHaveCount(1);
  await expect(row.locator('svg[shape-rendering="crispEdges"]')).toBeVisible();
  await expect(row.getByText("已写好的引言", { exact: true })).toBeVisible();
  await expect(
    row.getByText("已到时间上限，已保存内容", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByTestId("team-queue")).toHaveCount(0);
  await row.getByRole("button", { name: "intro.md", exact: true }).click();
  const preview = page.getByRole("complementary", {
    name: "drafts/intro.md",
    exact: true,
  });
  await expect(
    preview.getByText("已保存的正文", { exact: true }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "关闭", exact: true }).click();
  await row.getByRole("button", { name: "继续", exact: true }).click();
  await expect.poll(() => continued).toBe(1);
});

test("thread results stay with their request and link to cross-channel posts", async ({
  page,
}) => {
  const { messages } = await setup(page);
  messages.push(
    {
      id: "request",
      channel_id: channel,
      thread_id: null,
      author_id: "human",
      text: "找论文再写引言",
      kind: "text",
      mentions: [],
      created_at: stamp,
      replies: 1,
      data: {},
    },
    {
      id: "reply",
      channel_id: channel,
      thread_id: "request",
      author_id: "librarian",
      text: "找到了三篇论文",
      kind: "text",
      mentions: [],
      created_at: stamp,
      replies: 0,
      data: {
        links: [{ channel_id: channel, thread_id: "draft", name: "写作" }],
      },
    },
  );
  await page.goto(`/#team/${workspace}/${channel}?thread=request`);
  const thread = page.getByRole("region", { name: "线程", exact: true });
  await expect(
    thread.getByText("找到了三篇论文", { exact: true }),
  ).toBeVisible();
  await expect(
    thread.getByRole("link", { name: "结果见 #写作", exact: true }),
  ).toHaveAttribute("href", `#team/${workspace}/${channel}?thread=draft`);
});

test("inline queued replies become working turns and settle in completion order", async ({
  page,
}) => {
  const { messages } = await setup(page);
  const started = "2026-10-23T15:27:00Z";
  const finished = "2026-10-23T15:44:00Z";
  const request: TeamMessage = {
    id: "timed-request",
    channel_id: channel,
    thread_id: null,
    author_id: "human",
    text: "查找论文",
    kind: "text",
    mentions: [],
    data: {},
    replies: 0,
    created_at: stamp,
  };
  const reply: TeamMessage = {
    ...request,
    id: "timed-reply",
    author_id: "librarian",
    thread_id: null,
    text: "",
    replies: 0,
    created_at: started,
    run: {
      id: "timed-run",
      status: "queued",
      response: "",
      error: "",
      steps: [],
      runtime: {},
      created_at: started,
      updated_at: started,
    },
  };
  messages.push(request, reply, {
    ...request,
    id: "intervening-update",
    thread_id: null,
    text: "补充要求",
    replies: 0,
    created_at: "2026-10-23T15:35:00Z",
  });
  messages.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      ...request,
      id: `history-${index}`,
      text: `Earlier message ${index}`,
      created_at: "2026-10-23T15:00:00Z",
    })),
  );
  await page.goto(`/#team/${workspace}/${channel}`);
  const thread = page.getByRole("region", { name: "实验", exact: true });
  const row = thread.locator('[data-message-id="timed-reply"]');
  const rows = thread.locator("[data-message-id]");
  const order = () =>
    rows.evaluateAll(
      (els, ids) =>
        els
          .map((el) => el.getAttribute("data-message-id"))
          .filter((id) => id && ids.includes(id)),
      [request.id, reply.id, "intervening-update"],
    );
  await expect(row.getByRole("status")).toHaveText("排队中");
  await expect(row.locator('svg[shape-rendering="crispEdges"]')).toBeVisible();
  await expect(row.getByText("librarian", { exact: true })).toHaveCount(1);
  await expect(row.locator("time, section")).toHaveCount(0);
  await expect(row.getByText("等着开始…", { exact: true })).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "回复", exact: true }),
  ).toHaveCount(0);
  await row.hover();
  await expect(
    row.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await expect
    .poll(order)
    .toEqual([request.id, reply.id, "intervening-update"]);
  const scroller = row.locator("..");
  const atBottom = () =>
    scroller.evaluate(
      (el) => el.scrollHeight - el.clientHeight - el.scrollTop < 2,
    );
  await expect.poll(atBottom).toBe(true);
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });

  reply.run!.status = "running";
  reply.run!.updated_at = "2026-10-23T15:36:00Z";
  await page.evaluate(() =>
    window.dispatchEvent(new Event("research-team-updated")),
  );
  await expect(row.locator('[data-live="true"]')).toBeVisible();
  await expect(row.locator("time")).toHaveAttribute("datetime", started);
  await expect(row.getByText("排队中", { exact: true })).toHaveCount(0);
  await expect
    .poll(order)
    .toEqual([request.id, reply.id, "intervening-update"]);

  reply.created_at = finished;
  reply.text = reply.run!.response = "找到三篇论文";
  reply.run!.status = "completed";
  reply.run!.updated_at = finished;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("research-team-updated")),
  );
  await expect(row.getByText("找到三篇论文", { exact: true })).toBeVisible();
  await expect(row.locator("time")).toHaveAttribute("datetime", finished);
  const displayed = await page.evaluate(
    (value) =>
      new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    finished,
  );
  await expect(row.locator("time")).toHaveText(displayed);
  await expect(
    row.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(order)
    .toEqual([request.id, "intervening-update", reply.id]);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  messages.push({
    ...request,
    id: "new-inline",
    author_id: "writer",
    text: "新的会话回复",
    created_at: "2026-10-23T15:45:00Z",
  });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("research-team-updated")),
  );
  await expect(thread.getByText("新的会话回复", { exact: true })).toBeVisible();
  await expect.poll(atBottom).toBe(true);
});

for (const [locale, theme, width] of [
  ["zh", "light", 1440],
  ["en", "dark", 720],
] as const) {
  test(`${locale}: completed empty replies become a compact no-content row`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem("paper-locale", locale);
        localStorage.setItem("paper-appearance", theme);
      },
      { locale, theme },
    );
    const { messages } = await setup(page);
    const request: TeamMessage = {
      id: "empty-request",
      channel_id: channel,
      thread_id: null,
      author_id: "human",
      text: "Read the conversation",
      kind: "text",
      mentions: [],
      data: {},
      replies: 0,
      created_at: stamp,
    };
    const reply: TeamMessage = {
      ...request,
      id: "empty-reply",
      thread_id: null,
      author_id: "librarian",
      text: "",
      replies: 0,
      run: {
        id: "empty-run",
        status: "queued",
        response: "",
        error: "",
        steps: [],
        runtime: {},
        created_at: stamp,
        updated_at: stamp,
      },
    };
    messages.push(request, reply, {
      ...reply,
      id: "after-empty",
      text: "Later answer",
      run: undefined,
      created_at: "2026-10-23T10:02:00+00:00",
    });
    await page.goto(`/#team/${workspace}/${channel}`);
    const thread = page.getByRole("region", {
      name: t("team.channel.experiments"),
      exact: true,
    });
    const row = thread.locator('[data-message-id="empty-reply"]');
    await expect(row.getByRole("status")).toHaveText(t("team.queued"));
    reply.run!.status = "running";
    reply.run!.steps = [
      { name: "read", status: "completed", arguments: { path: "notes.md" } },
    ];
    await page.evaluate(() =>
      window.dispatchEvent(new Event("research-team-updated")),
    );
    await expect(row.locator('[data-live="true"]')).toBeVisible();
    reply.run!.status = "completed";
    reply.text = reply.run!.response = " \n\t";
    reply.created_at = reply.run!.updated_at = "2026-10-23T10:01:00+00:00";
    await page.evaluate(() =>
      window.dispatchEvent(new Event("research-team-updated")),
    );
    await expect(row.getByRole("status")).toHaveText(t("team.noContent"));
    await expect(
      row.locator('svg[shape-rendering="crispEdges"]'),
    ).toBeVisible();
    await expect(row.getByText("librarian", { exact: true })).toHaveCount(1);
    await expect(row.getByTestId("team-message-bubble")).toHaveCount(0);
    await expect(row.locator("time, section")).toHaveCount(0);
    await expect(
      row.getByRole("button", {
        name: t("team.colleague.card", { name: "librarian" }),
        exact: true,
      }),
    ).toHaveCount(2);
    await row.hover();
    await expect(
      row.getByRole("button", { name: t("research.actions"), exact: true }),
    ).toBeVisible();
    await expect(
      row.getByText(t("team.noAnswer"), { exact: true }),
    ).toHaveCount(0);
    await expect(
      thread.locator('[data-message-id="after-empty"] header strong'),
    ).toHaveText("librarian");
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  });
}

test("stopping a queued member leaves a stopped reply and failures keep their output", async ({
  page,
}) => {
  const { messages } = await setup(page);
  const reply: TeamMessage = {
    id: "stopped-reply",
    channel_id: channel,
    thread_id: null,
    author_id: "librarian",
    text: "",
    kind: "text",
    mentions: [],
    data: {},
    replies: 0,
    created_at: stamp,
    run: {
      id: "stopped-run",
      status: "queued",
      response: "",
      error: "",
      steps: [],
      runtime: {},
      created_at: stamp,
      updated_at: stamp,
    },
  };
  messages.push(reply, {
    ...reply,
    id: "failed-reply",
    text: "已保存的草稿",
    run: {
      ...reply.run!,
      id: "failed-run",
      status: "failed",
      error: "测试错误",
    },
  });
  let cancelled = 0;
  await page.route("**/api/v1/agent/runs/stopped-run/cancel", (route) => {
    expect(route.request().method()).toBe("POST");
    reply.run!.status = "cancelled";
    cancelled++;
    return route.fulfill({ json: reply.run });
  });
  await page.reload();
  const row = page.locator('[data-message-id="stopped-reply"]');
  await expect(row.getByRole("status")).toHaveText("排队中");
  await row.hover();
  await row.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => cancelled).toBe(1);
  await expect(row.getByText("已停止", { exact: true })).toHaveCount(1);
  await expect(row.getByText("排队中", { exact: true })).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0);
  const failed = page.locator('[data-message-id="failed-reply"]');
  await expect(failed.getByText("已保存的草稿", { exact: true })).toBeVisible();
  await expect(failed.getByText("测试错误", { exact: true })).toBeVisible();
  await expect(
    failed.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("team-queue")).toHaveCount(0);
});

for (const [locale, waiting] of [
  ["zh", "等你"],
  ["en", "Waiting for you"],
] as const) {
  test(`system wait messages use only ${locale}`, async ({ page }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    const { messages } = await setup(page);
    messages.push({
      id: "owner-wait",
      channel_id: channel,
      thread_id: null,
      author_id: null,
      text: "等你 / Waiting for you",
      kind: "relay_limit",
      mentions: [],
      data: { waiting: true },
      created_at: stamp,
      replies: 0,
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "lang",
      locale === "zh" ? "zh-CN" : "en",
    );
    const message = page.locator('[data-message-id="owner-wait"]');
    await expect(message).toHaveCSS("justify-content", "center");
    await expect(message.locator(":scope > span svg, img, time")).toHaveCount(
      0,
    );
    await message.hover();
    await expect(
      message.getByRole("button", {
        name: createTranslator(locale).t("research.actions"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(message.getByText(waiting, { exact: true })).toHaveCount(1);
    await expect(
      message.getByText(locale === "zh" ? "Waiting for you" : "等你", {
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: Feishu bubbles group authors and keep tool details folded`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(
      (value) => localStorage.setItem("paper-appearance", value),
      theme,
    );
    const { messages } = await setup(page);
    const base: TeamMessage = {
      id: "agent-card",
      channel_id: channel,
      thread_id: null,
      author_id: "writer",
      kind: "text",
      text: "已完成的正文",
      // Start after the research card so it cannot interrupt this author group.
      created_at: "2026-10-23T10:01:00+00:00",
      mentions: [],
      replies: 5,
      reply_authors: ["librarian", "human", "reviewer", "advisor"],
      last_message_at: "2026-10-23T10:02:00+00:00",
      data: {
        to: ["librarian"],
        files: [{ path: "draft.md", name: "draft.md" }],
      },
      run: {
        id: "card-run",
        status: "completed",
        model: "Offline",
        response: "已完成的正文",
        error: "",
        steps: [
          {
            name: "read",
            status: "completed",
            arguments: { path: "folded-notes.md" },
          },
        ],
        runtime: {},
        created_at: "2026-10-23T10:01:00+00:00",
        updated_at: "2026-10-23T10:01:00+00:00",
      },
    };
    messages.push(
      base,
      {
        ...base,
        id: "grouped-card",
        text: "补充正文",
        replies: 0,
        data: {},
        run: undefined,
        created_at: "2026-10-23T10:04:00+00:00",
      },
      {
        ...base,
        id: "ungrouped-card",
        text: "另一段正文",
        replies: 0,
        data: {},
        run: undefined,
        created_at: "2026-10-23T10:10:00+00:00",
      },
      {
        ...base,
        id: "my-message",
        author_id: "human",
        text: "我的要求",
        data: {},
        run: undefined,
        replies: 0,
        created_at: "2026-10-23T10:11:00+00:00",
      },
    );
    await page.reload();
    const screen = page.getByTestId("team-screen");
    const first = screen.locator('[data-message-id="agent-card"]');
    await expect(first).toHaveAttribute("data-author", "agent");
    await expect(first.getByText("智能体", { exact: true })).toBeVisible();
    await expect(
      first.getByText("交给 librarian", { exact: true }),
    ).toBeVisible();
    await expect(first.locator("footer")).toContainText("Offline");
    await expect(
      first.getByRole("button", { name: "5 条回复", exact: true }),
    ).toBeVisible();
    const entry = first.getByRole("button", { name: "5 条回复", exact: true });
    await expect(
      entry
        .getByRole("group", { name: "参与者", exact: true })
        .getByRole("img"),
    ).toHaveCount(3);
    await expect(entry.locator("time")).toHaveAttribute(
      "datetime",
      "2026-10-23T10:02:00+00:00",
    );
    await expect(
      first.getByText("folded-notes.md", { exact: true }),
    ).toHaveCount(0);
    const fold = first.getByRole("button", { name: /^已处理/ });
    await expect(fold).toHaveCSS("padding", "0px 10px 0px 6px");
    await expect(fold).toHaveCSS("border-radius", "8px");
    await expect(fold).toHaveCSS("line-height", "18px");
    await expect(fold).toHaveCSS("font-variant-numeric", "tabular-nums");
    await expect(fold.locator(":scope > :first-child")).toHaveClass(
      /lucide-chevron-right/,
    );
    await fold.click();
    await expect(
      first.getByText("folded-notes.md", { exact: true }),
    ).toBeVisible();
    const grouped = screen.locator('[data-message-id="grouped-card"]');
    await expect(grouped).toHaveAttribute("data-grouped", "true");
    await expect(
      grouped.locator('svg[shape-rendering="crispEdges"], img, strong'),
    ).toHaveCount(0);
    await expect(
      screen
        .locator('[data-message-id="ungrouped-card"]')
        .locator('svg[shape-rendering="crispEdges"]'),
    ).toBeVisible();
    const own = screen.locator('[data-message-id="my-message"]');
    await expect(own).toHaveAttribute("data-author", "human");
    const ownBubble = own.getByTestId("team-message-bubble");
    const memberBubble = first.getByTestId("team-message-bubble");
    await expect(ownBubble).toHaveCSS("border-radius", "18px 18px 6px");
    await expect(memberBubble).toHaveCSS("border-radius", "18px 18px 18px 6px");
    for (const bubble of [ownBubble, memberBubble]) {
      await expect(bubble).toHaveCSS("padding", "10px 16px");
      await expect(bubble.locator("p")).toHaveCSS("font-size", "15px");
      await expect(bubble.locator("p")).toHaveCSS("line-height", "24px");
    }
    await expect(own).toHaveCSS("max-width", "720px");
    await expect(own).toHaveCSS("padding", "10px 0px");
    await expect(
      own.locator('svg[shape-rendering="crispEdges"], img, strong'),
    ).toHaveCount(0);
    await expect(own.locator("time")).toHaveCSS("opacity", "0");
    await own.hover();
    await expect(own.locator("time")).toHaveCSS("opacity", "1");
    const ownBox = await own.getByTestId("team-message-bubble").boundingBox();
    const agentBox = await first
      .getByTestId("team-message-bubble")
      .boundingBox();
    expect(ownBox!.x).toBeGreaterThan(agentBox!.x);
    expect(
      await own
        .getByTestId("team-message-bubble")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).not.toBe(
      await first
        .getByTestId("team-message-bubble")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    await own.getByRole("button", { name: "回复", exact: true }).click();
    await expect(page.getByTestId("team-side-panel")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "线程", exact: true }),
    ).toBeVisible();
  });

  test(`${theme}: sidebar keeps fixed entries and merges conversations with badges at narrow widths`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(
      (value) => localStorage.setItem("paper-appearance", value),
      theme,
    );
    const { members } = await setup(page);
    await page.clock.setFixedTime(new Date("2026-10-24T07:00:00Z"));
    const times = [
      "2026-10-24T06:50:00Z",
      "2026-10-23T06:00:00Z",
      "2026-10-21T06:00:00Z",
      "2026-10-18T06:00:00Z",
      "2026-10-17T06:00:00Z",
      "2026-10-16T06:00:00Z",
    ];
    const directs = members
      .filter((member) => member.role !== "human")
      .map((member, index) => ({
        id:
          member.role === "advisor"
            ? dm
            : `10000000-0000-0000-0000-${String(index + 10).padStart(12, "0")}`,
        key: `dm:${member.role}`,
        name: member.name,
        member_id: member.id,
        unread: index === 0 ? 3 : 0,
        last_at: times[index],
        last_message: {
          author_id: member.id,
          author_name: member.name,
          text: `私信 ${member.name}`,
          created_at: times[index],
        },
        working_member_ids: [],
      }));
    await page.route("**/api/v1/research/workspaces/*/team", (route) =>
      route.fulfill({
        json: {
          workspace_id: workspace,
          members: members.map((member) => ({
            ...member,
            status: member.role === "advisor" ? "working" : "idle",
          })),
          channels: [
            ...[...directs].reverse(),
            {
              id: channel,
              key: "experiments",
              name: "实验",
              member_id: null,
              unread: 12,
              last_at: "2026-10-24T06:40:00Z",
              last_message: {
                author_id: "advisor",
                author_name: "advisor",
                text: "已核对",
                created_at: "2026-10-24T06:40:00Z",
              },
              working_member_ids: ["advisor"],
            },
          ],
          notifications: [],
          threads_unread: 9,
          mentions_unread: 1,
          activity_unread: 2,
        },
      }),
    );
    await page.reload();
    const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
    const rail = sidebar.locator(":scope > div").first();
    await expect(rail).toHaveCSS("padding", "8px 0px 12px");
    await expect(rail).toHaveCSS("border-radius", "0px");
    const destination = rail.getByRole("link", { name: "研究", exact: true });
    await expect(destination).toHaveCSS("width", "36px");
    await expect(destination).toHaveCSS("height", "36px");
    await expect(destination).toHaveCSS("border-radius", "10px");
    await expect(destination.locator("svg")).toHaveAttribute("width", "18");
    await expect(destination.locator("svg")).toHaveCSS("stroke-width", "2px");
    await expect(destination).not.toHaveCSS("box-shadow", "none");
    const pane = sidebar.locator(":scope > div").nth(1);
    await expect(pane).toHaveCSS("width", "264px");
    const switcher = sidebar.getByRole("button", {
      name: "切换项目",
      exact: true,
    });
    await expect(switcher).toHaveCSS("font-size", "14px");
    await expect(switcher.locator("xpath=../..")).toHaveCSS("height", "52px");
    const resize = page.getByRole("separator", {
      name: "调整侧栏宽度",
      exact: true,
    });
    await expect(resize).toHaveAttribute("aria-valuenow", "264");
    for (const label of ["新研究", "线程", "动态"]) {
      const row = sidebar.getByRole("link", { name: label, exact: true });
      await expect(row).toHaveCSS("height", "34px");
      await expect(row).toHaveCSS("font-size", "14px");
      await expect(row).toHaveCSS("padding", "0px 10px");
      await expect(row).toHaveCSS("gap", "10px");
    }
    const messagesHeading = sidebar
      .getByText("消息", { exact: true })
      .locator("..");
    await expect(messagesHeading).toHaveCSS("height", "26px");
    await expect(messagesHeading).toHaveCSS("font-size", "12px");
    await expect(messagesHeading).toHaveCSS("font-weight", "400");
    const addChannel = messagesHeading.getByRole("button");
    await expect(addChannel).toHaveCSS("width", "24px");
    await expect(addChannel).toHaveCSS("height", "24px");
    await expect(addChannel).toHaveCSS("border-radius", "6px");
    const conversations = sidebar.getByRole("group", {
      name: "消息",
      exact: true,
    });
    await expect(conversations).toHaveCSS("gap", "1px");
    const frequent = sidebar.getByRole("group", {
      name: "常用成员",
      exact: true,
    });
    await expect(frequent).toHaveCount(0);
    await expect(conversations.getByRole("link")).toHaveCount(7);
    for (const [index, name] of [
      "advisor",
      "实验",
      "executor",
      "librarian",
      "reviewer",
      "writer",
      "distiller",
    ].entries())
      await expect(
        conversations.getByRole("link").nth(index),
      ).toHaveAccessibleName(name);
    const experiment = conversations.getByRole("link", {
      name: "实验",
      exact: true,
    });
    await expect(experiment).toHaveAttribute("aria-current", "page");
    await expect(
      experiment.getByText("正在：思考中 · 0 秒", { exact: true }),
    ).toBeVisible();
    await expect(
      experiment.getByLabel("12 条未读", { exact: true }),
    ).toHaveText("12");
    const advisor = conversations.getByRole("link", {
      name: "advisor",
      exact: true,
    });
    await expect(advisor).toContainText("正在：思考中 · 0 秒");
    await expect(advisor).not.toContainText("私信 advisor");
    await expect(advisor.getByLabel("3 条未读", { exact: true })).toHaveText(
      "3",
    );
    await expect(advisor.locator("time")).toHaveText("14:50");
    await expect(advisor.locator("time")).toHaveCSS(
      "font-variant-numeric",
      "tabular-nums",
    );
    await expect(
      conversations
        .getByRole("link", { name: "executor", exact: true })
        .locator("time"),
    ).toHaveText("昨天");
    await expect(
      conversations
        .getByRole("link", { name: "librarian", exact: true })
        .locator("time"),
    ).toHaveText("星期三");
    await expect(
      conversations
        .getByRole("link", { name: "reviewer", exact: true })
        .locator("time"),
    ).toHaveText("10月18日");
    for (const [label, count] of [
      ["线程", 9],
      ["动态", 2],
    ] as const) {
      const shortcut = sidebar
        .getByRole("link", { name: label, exact: true })
        .locator("xpath=ancestor::div[1]");
      const badge = shortcut.getByLabel(`${count} 条未读`, { exact: true });
      await expect(badge).toHaveText(String(count));
      const color = await badge.evaluate((node) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ui-danger)";
        node.appendChild(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return expected;
      });
      await expect(badge).toHaveCSS("background-color", color);
    }
    const add = sidebar.getByRole("button", { name: "新建频道", exact: true });
    await add.click();
    await expect(
      page.getByRole("dialog", { name: "新建频道", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await conversations
      .getByRole("link", { name: "writer", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(directs[4].id));
    await expect(
      conversations.getByRole("link", { name: "writer", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(sidebar).toHaveAttribute("data-floating", "true");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await sidebar
      .getByRole("button", { name: "展开侧栏", exact: true })
      .click();
    await expect(conversations).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "团队设置", exact: true }),
    ).toBeVisible();
    expect(
      await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const allDirects = [...directs];
    for (const count of [2, 1, 0, 3]) {
      directs.splice(0, directs.length, ...allDirects.slice(0, count));
      await expect(frequent).toHaveCount(0);
      await expect(conversations.getByRole("link")).toHaveCount(count + 1);
    }
  });
}

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: output panel hides empty sections and centers an icon when empty`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.addInitScript((value) => {
      localStorage.setItem("paper-locale", value);
      localStorage.setItem("team-side-panel", "true");
    }, locale);
    const { messages } = await setup(page);
    const panel = page.getByTestId("team-side-panel");
    const empty = panel.getByRole("img", {
      name: t("team.noOutputs"),
      exact: true,
    });
    await expect(empty).toBeVisible();
    await expect(panel.locator("section, h3")).toHaveCount(0);
    await expect(
      panel.getByText(t("team.noOutputs"), { exact: true }),
    ).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => (document.documentElement.dataset.theme = value),
        theme,
      );
      for (const width of [1440, 720]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width === 720)
          await page
            .getByRole("button", { name: t("team.showPanel"), exact: true })
            .click();
        await expect(panel).toBeVisible();
        const area = panel.locator(":scope > div");
        const areaBox = (await area.boundingBox())!;
        const iconBox = (await empty.boundingBox())!;
        expect(
          Math.abs(
            iconBox.x + iconBox.width / 2 - areaBox.x - areaBox.width / 2,
          ),
        ).toBeLessThan(1);
        expect(
          Math.abs(
            iconBox.y + iconBox.height / 2 - areaBox.y - areaBox.height / 2,
          ),
        ).toBeLessThan(1);
        await expect(empty).toHaveCSS("width", "32px");
        await expect(empty).toHaveCSS("height", "32px");
      }
    }
    const base: TeamMessage = {
      id: "output",
      channel_id: channel,
      thread_id: null,
      author_id: "advisor",
      kind: "text",
      text: "Output",
      data: {},
      mentions: [],
      replies: 0,
      created_at: stamp,
    };
    const cases: ["progress" | "deliverables" | "sources", TeamMessage][] = [
      [
        "progress",
        {
          ...base,
          run: {
            id: "run",
            status: "running",
            response: "",
            error: "",
            steps: [],
            runtime: {},
            created_at: stamp,
            updated_at: stamp,
          },
        },
      ],
      [
        "deliverables",
        { ...base, data: { files: [{ path: "draft.md", name: "draft.md" }] } },
      ],
      [
        "sources",
        {
          ...base,
          data: {
            paper: { title: "Paper", url: "https://example.test/paper" },
          },
        },
      ],
    ];
    // At narrow widths the panel is a drawer over the header; check the rest wide.
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const [key, message] of cases) {
      messages.splice(0, messages.length, message);
      await expect(panel.getByRole("heading", { level: 3 })).toHaveText(
        t(`team.${key}`),
      );
      await expect(empty).toHaveCount(0);
    }
    await page
      .getByTestId("team-screen")
      .locator("header")
      .getByRole("button", { name: t("team.files"), exact: true })
      .first()
      .click();
    await expect(panel.getByRole("heading", { level: 3 })).toHaveText(
      t("team.sources"),
    );
    messages.splice(0);
    await expect(empty).toBeVisible();
    await expect(panel.locator("section, h3")).toHaveCount(0);
  });
}

for (const [locale, width] of [
  ["zh", 1440],
  ["en", 720],
] as const) {
  test(`${locale}: message reminders offer four times, enter activity and locate the original`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    const { messages, members } = await setup(page);
    await page.clock.setFixedTime(new Date("2026-10-24T04:00:00Z"));
    const original: TeamMessage = {
      id: "remind-original",
      channel_id: channel,
      thread_id: null,
      author_id: "advisor",
      text: "Original reminder excerpt",
      kind: "text",
      mentions: [],
      data: {},
      replies: 0,
      created_at: stamp,
    };
    messages.push(original);
    const planned: string[] = [];
    let delivered = false;
    let read = false;
    const reminder = () => ({
      ...original,
      id: "reminder-event",
      kind: "reminder",
      created_at: "2026-10-24T04:20:00Z",
      actor_id: null,
      activity_type: "reminder",
      activity_types: ["reminder"],
      unread: !read,
      data: {
        read,
        reminder: {
          message_id: original.id,
          channel_id: channel,
          thread_id: null,
        },
      },
    });
    await page.route("**/team/channels/*/messages/*/reminders", (route) => {
      planned.push(route.request().postDataJSON().remind_at);
      return route.fulfill({
        json: { id: `reminder-${planned.length}`, remind_at: planned.at(-1) },
      });
    });
    await page.route("**/team/activity", (route) =>
      route.fulfill({ json: delivered ? [reminder()] : [] }),
    );
    await page.route("**/team/activity/read", (route) => {
      read = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/research/workspaces/*/team", (route) =>
      route.fulfill({
        json: {
          workspace_id: workspace,
          members,
          channels: [
            {
              id: channel,
              key: "experiments",
              name: "实验",
              member_id: null,
              unread: 0,
            },
          ],
          activity_unread: delivered && !read ? 1 : 0,
          notifications: delivered && !read ? [reminder()] : [],
        },
      }),
    );
    await page.reload();
    const row = page.locator('[data-message-id="remind-original"]');
    const expected = [
      "2026-10-24T04:20:00.000Z",
      "2026-10-24T05:00:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-26T06:30:00.000Z",
    ];
    for (const [index, preset] of (
      ["minutes", "hour", "morning", "custom"] as const
    ).entries()) {
      await row.hover();
      await row
        .getByRole("button", { name: t("research.actions"), exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: t("team.reminder.action"), exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: t("team.reminder.title"),
        exact: true,
      });
      if (preset !== "minutes") {
        await dialog
          .getByRole("button", {
            name: t("team.reminder.minutes"),
            exact: true,
          })
          .click();
        await page
          .getByRole("menuitemradio", {
            name: t(`team.reminder.${preset}`),
            exact: true,
          })
          .click();
      }
      if (preset === "custom")
        await dialog
          .getByLabel(t("team.reminder.time"), { exact: true })
          .fill("2026-10-26T14:30");
      await dialog
        .getByRole("button", { name: t("team.reminder.create"), exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      expect(planned[index]).toBe(expected[index]);
    }
    delivered = true;
    await page.clock.setFixedTime(new Date("2026-10-24T04:20:00Z"));
    await page.evaluate(() =>
      window.dispatchEvent(new Event("research-team-updated")),
    );
    // Below 900px the sidebar is a rail until it is opened.
    const sidebar = page.getByRole("navigation", {
      name: t("reader.region.sidebar"),
      exact: true,
    });
    const openSidebar = async () => {
      const expand = sidebar.getByRole("button", {
        name: t("sidebar.expand"),
        exact: true,
      });
      if (await expand.isVisible()) await expand.click();
    };
    await openSidebar();
    const activity = page.locator('[data-id="activity"]');
    // The count sits beside the entry; the entry itself is wrapped by its tooltip.
    const shortcut = activity.locator("xpath=ancestor::div[1]");
    await expect(shortcut.getByText("1", { exact: true })).toBeVisible();
    await activity.click();
    const event = page.locator('[data-activity-id="reminder-event"]');
    await expect(event).toHaveAttribute("data-unread", "true");
    await expect(event).toContainText("Original reminder excerpt");
    await event.click();
    await expect(row).toHaveAttribute("data-located", "true");
    await expect(row).toBeFocused();
    await expect.poll(() => read).toBe(true);
    await openSidebar();
    await expect(activity).toBeVisible();
    await expect(shortcut.getByText("1", { exact: true })).toHaveCount(0);
  });
}

for (const [locale, theme, width] of [
  ["zh", "light", 1440],
  ["en", "dark", 720],
] as const) {
  test(`${locale} ${theme}: research review handles file folds, previews and panel preferences`, async ({
    page,
  }, testInfo) => {
    const { t } = createTranslator(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem("paper-locale", locale);
        localStorage.setItem("paper-appearance", theme);
      },
      { locale, theme },
    );
    await setup(page);
    let empty = false;
    const files = [
      {
        path: "src/train.py",
        added: 2,
        removed: 1,
        diff: "@@ -4 +4,2 @@\n-old\n+verified\n+result\n",
      },
      {
        path: "results/large.csv",
        added: 250,
        removed: 0,
        diff: "@@ -0,0 +1,250 @@\n" + "+1,2\n".repeat(250),
      },
      {
        path: "results/model.bin",
        added: 0,
        removed: 0,
        diff: "Binary files differ",
        binary: true,
      },
      {
        path: "notes/truncated.md",
        added: 500,
        removed: 0,
        diff: "@@ -0,0 +1,500 @@\n+partial\n",
        truncated: true,
      },
    ];
    await page.route(
      `**/api/v1/research/projects/${research}/changes`,
      (route) =>
        route.fulfill({
          json: empty
            ? { added: 0, removed: 0, files: [] }
            : { added: 752, removed: 1, files },
        }),
    );
    await page.route(
      `**/api/v1/research/projects/${research}/workspace/file?**`,
      (route) =>
        route.fulfill({
          json: {
            path: "src/train.py",
            name: "train.py",
            size: 19,
            modified: 1792749600,
            kind: "text",
            content: "Saved training file",
          },
        }),
    );
    await page.goto(`/#research/${research}`);
    const total = page
      .getByRole("heading", { name: "研究问题", exact: true })
      .locator("..")
      .getByRole("button", { name: t("research.review.action"), exact: true });
    await expect(total).toContainText("+752−1");
    await total.click();
    const panel = page.getByRole("complementary", {
      name: t("research.record.title"),
      exact: true,
    });
    await expect(panel.getByRole("tab")).toHaveText([
      t("research.record.progress"),
      t("research.panel.changes"),
      t("research.record.runs"),
    ]);
    await expect(
      panel.getByRole("tab", {
        name: t("research.panel.changes"),
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    const small = panel.locator('details[data-path="src/train.py"]');
    const large = panel.locator('details[data-path="results/large.csv"]');
    const binary = panel.locator('details[data-path="results/model.bin"]');
    const truncated = panel.locator('details[data-path="notes/truncated.md"]');
    await expect(small).toHaveAttribute("open", "");
    for (const file of [large, binary, truncated])
      await expect(file).not.toHaveAttribute("open", "");
    await expect(small.locator('[data-kind="del"]')).toContainText("-old");
    await expect(small.locator('[data-kind="add"]').first()).toContainText(
      "+verified",
    );
    await large.locator("summary").click();
    await expect(large.locator('[data-kind="add"]')).toHaveCount(250);
    await large.locator("summary").click();
    await binary.locator("summary").click();
    await expect(binary).toContainText(t("research.merge.binary"));
    await truncated.locator("summary").click();
    await expect(truncated).toContainText(t("research.changes.truncated"));
    await small
      .getByRole("button", { name: t("research.review.openFile"), exact: true })
      .click();
    await expect(panel).toContainText("Saved training file");
    await panel
      .getByRole("button", { name: t("research.files.back"), exact: true })
      .click();
    await expect(small).toHaveAttribute("open", "");
    await page.screenshot({
      path: testInfo.outputPath(
        `research-review-${locale}-${theme}-${width}.png`,
      ),
    });
    await panel
      .getByRole("button", { name: t("common.close"), exact: true })
      .click();
    await page.reload();
    await expect(panel).toHaveCount(0);
    await page
      .getByRole("button", { name: t("research.record.show"), exact: true })
      .click();
    await expect(
      panel.getByRole("tab", {
        name: t("research.panel.changes"),
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    empty = true;
    await page.reload();
    await expect(total).toHaveCount(0);
    await expect(panel).toContainText(t("research.merge.noChanges"));
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });
}
