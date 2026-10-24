import { expect, test } from "@playwright/test";
import type { Workflow } from "../../src/screens/team/workflow/workflow-model";
import { createTranslator } from "../../src/i18n/i18n";
import type {
  TeamActivity,
  TeamMessage,
} from "../../src/screens/research/team-api";
import { signIn } from "../reader/fixtures";

test.use({ locale: "zh-CN", timezoneId: "Asia/Singapore" });
const wid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dm = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const cid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const members = [
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
const fresh = (): Workflow => ({
  id: "peers",
  name: "Peers",
  builtin: false,
  version: 1,
  rules: [
    {
      id: "source-review",
      enabled: true,
      when: { event: "message", from_role: "executor", kind: "result" },
      then: {
        action: "review",
        role: "advisor",
        on_fail: "executor",
        max_rounds: 3,
      },
      limit: { per_thread: 10 },
    },
  ],
  layout: { members: {}, channels: {} },
});

async function setup(page: import("@playwright/test").Page) {
  let workflow = fresh();
  const writes: Workflow[] = [];
  const libraryWrites: Workflow[] = [];
  const reply: TeamMessage = {
    id: "reply",
    channel_id: cid,
    thread_id: null,
    author_id: "advisor",
    text: "已评审",
    kind: "text",
    mentions: [],
    replies: 0,
    created_at: "2026-10-23T15:44:00Z",
    data: {},
    run: {
      id: "review-run",
      status: "completed",
      response: "已评审",
      error: "",
      steps: [],
      runtime: {},
      created_at: "2026-10-23T15:27:00Z",
      updated_at: "2026-10-23T15:44:00Z",
    },
  };
  await page.route("**/api/v1/health", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, mode: "local" } });
  });
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        configured: true,
        active_id: "fake",
        models: [{ id: "fake", model: "Fake", name: "Fake" }],
      },
    }),
  );
  await page.route("**/api/v1/research/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/v1/research",
      "",
    );
    if (path === "/navigation")
      return route.fulfill({
        json: {
          workspaces: [
            {
              id: wid,
              name: "团队",
              kind: "research",
              archived: false,
              location: { kind: "managed", path: "", connection_id: "" },
              researches: [],
            },
          ],
          collections: [],
        },
      });
    if (path === "/workflows" || path.startsWith("/workflows/")) {
      if (["POST", "PUT"].includes(route.request().method())) {
        const body = route.request().postDataJSON() as Workflow;
        libraryWrites.push(body);
        workflow = {
          ...body,
          id: path === "/workflows" ? "copied" : workflow.id,
        };
        return route.fulfill({ json: workflow });
      }
      return route.fulfill({
        json: [workflow, { ...fresh(), id: "second", name: "Second" }],
      });
    }
    if (path.endsWith("/team/workflow")) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as Workflow;
        expect(body.version).toBe(workflow.version);
        writes.push(body);
        workflow = { ...body, version: body.version + 1 };
      }
      if (route.request().method() === "POST")
        workflow = { ...fresh(), id: "second", name: "Second" };
      return route.fulfill({ json: workflow });
    }
    if (path.endsWith("/team"))
      return route.fulfill({
        json: {
          workspace_id: wid,
          workflow,
          members,
          runtime: {
            members: { advisor: "working" },
            fired: [{ rule: "source-review", at: new Date().toISOString() }],
          },
          channels: [
            {
              id: cid,
              key: "experiments",
              name: "实验",
              member_id: null,
              unread: 0,
              last_message: {
                author_id: "advisor",
                author_name: "advisor",
                text: reply.text,
                created_at: reply.created_at,
              },
              last_at: reply.created_at,
              working_member_ids:
                reply.run?.status === "queued" ||
                reply.run?.status === "running"
                  ? ["advisor"]
                  : [],
            },
            {
              id: dm,
              key: "dm:advisor",
              name: "导师",
              member_id: "advisor",
              unread: 0,
              last_message: null,
              last_at: "2026-10-22T00:00:00Z",
              working_member_ids: [],
            },
          ],
          notifications: [],
          tokens: 25570999,
        },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({
        json: {
          root: null,
          research_id: null,
          messages: [
            {
              ...reply,
              data: {
                rule: "source-review",
                workflow: workflow.id,
                workflow_version: workflow.version,
              },
            },
          ],
        },
      });
    if (path.endsWith("/read")) return route.fulfill({ json: { ok: true } });
    if (path === "/compare") return route.fulfill({ json: { threads: [] } });
    if (path === "/schedules")
      return route.fulfill({
        json: [
          {
            id: "timer",
            title: "Daily",
            timezone: "UTC",
            paused: false,
            next_run_at: "2026-10-24T09:00:00Z",
            editor_url: `team/${wid}/settings?thread=rule%3Apeers%3A1%3Asource-review`,
          },
        ],
      });
    if (path === "/settings")
      return route.fulfill({ json: { computes: [], states: {} } });
    return route.fulfill({ json: [] });
  });
  await signIn(page);
  return { writes, libraryWrites, reply };
}

test("team settings persist rules, switch workflows and open canvas messages", async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto(`/#team/${wid}/${cid}`);
  await page.getByRole("link", { name: "团队设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "团队设置" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "团队设置", exact: true })
      .getByRole("button", { name: "librarian", exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "工作流", exact: true }).click();
  await page.getByRole("switch").click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByRole("tab", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("workflow-canvas")).toBeVisible();
  const advisor = page.locator('.react-flow__node[data-id="member:advisor"]');
  await expect(
    advisor.getByRole("status", { name: "工作中", exact: true }),
  ).toHaveText("");
  await expect(advisor.locator('[data-size="sm"]')).toHaveCount(1);
  await page.locator('[data-id="member:advisor"]').press("Enter");
  await expect(page).toHaveURL(new RegExp(dm));
  await page.goto(`/#team/${wid}/settings?thread=workflow`);
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page.getByRole("menuitem", { name: "Second", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "工作流", exact: true }),
  ).toContainText("Second");
});

test("message provenance and schedule links locate the rule editor at 720px", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(`/#team/${wid}/${cid}`);
  const reply = page.locator('[data-message-id="reply"]');
  await expect(reply).toHaveAttribute("data-author", "agent");
  await expect(reply.getByText("智能体", { exact: true })).toBeVisible();
  await expect(reply.locator("footer time")).toHaveAttribute(
    "datetime",
    "2026-10-23T15:44:00Z",
  );
  await page.getByRole("link", { name: "source-review", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.goto("/#schedules");
  await page.getByRole("link", { name: "Daily", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("queued rule wakes stay inline and compact until work starts", async ({
  page,
}) => {
  const { reply } = await setup(page);
  reply.text = "";
  reply.created_at = reply.run!.created_at;
  reply.run!.status = "queued";
  reply.run!.response = "";
  await page.goto(`/#team/${wid}/${cid}`);
  const row = page.locator('[data-message-id="reply"]');
  await expect(
    page.getByRole("region", { name: "线程", exact: true }),
  ).toHaveCount(0);
  await expect(row.getByRole("button", { name: /条回复/ })).toHaveCount(0);
  const conversations = page
    .getByRole("navigation", { name: "侧栏", exact: true })
    .getByRole("group", { name: "消息", exact: true });
  const conversation = conversations.getByRole("link", {
    name: "实验",
    exact: true,
  });
  await expect(
    conversation.getByText("工作中…", { exact: true }),
  ).toBeVisible();
  await expect(conversations.getByRole("link").first()).toHaveAccessibleName(
    "实验",
  );
  await expect(
    conversations
      .getByRole("link", { name: "advisor", exact: true })
      .getByText("工作中…", { exact: true }),
  ).toHaveCount(0);
  await expect(row.getByRole("status")).toHaveText("排队中");
  await expect(row.locator("time, section")).toHaveCount(0);
  await expect(
    row.getByRole("link", { name: "source-review", exact: true }),
  ).toHaveCount(0);
  reply.run!.status = "running";
  await page.evaluate(() =>
    window.dispatchEvent(new Event("research-team-updated")),
  );
  await expect(row.locator('[data-live="true"]')).toBeVisible();
  await expect(row).toHaveAttribute("data-author", "agent");
  await expect(row.getByText("排队中", { exact: true })).toHaveCount(0);
  reply.text = reply.run!.response = "已完成核对";
  reply.run!.status = "completed";
  await page.evaluate(() =>
    window.dispatchEvent(new Event("research-team-updated")),
  );
  await expect(conversation).toContainText("advisor：已完成核对");
  await expect(conversation.getByText("工作中…", { exact: true })).toHaveCount(
    0,
  );
  await row.getByRole("link", { name: "source-review", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("customization manages rule workflows with the same list and canvas editor", async ({
  page,
}) => {
  const { libraryWrites } = await setup(page);
  await page.goto("/#customize/workflows");
  await page.getByRole("button", { name: "Peers", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "画布", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("Peer rules");
  await page.getByRole("switch").click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => libraryWrites.length).toBe(1);
  expect(libraryWrites[0].rules[0].enabled).toBe(false);
  await expect(
    page.getByRole("button", { name: "Peer rules", exact: true }),
  ).toBeVisible();
});

test("team canvas fills the main area and lists channels without DMs", async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/#team/${wid}/settings?thread=workflow`);
  await expect(
    page.getByRole("heading", { name: "Peers", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "画布", exact: true }).click();
  const canvas = page.getByTestId("workflow-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(600);
  expect(box!.width).toBeGreaterThan(600);
  const palette = page.getByRole("complementary", {
    name: "节点操作",
    exact: true,
  });
  const channelNodes = palette.locator("div").filter({
    has: page.getByRole("heading", { name: "频道", exact: true }),
  });
  await expect(
    channelNodes.getByRole("button", { name: "添加 实验", exact: true }),
  ).toHaveCount(1);
  await expect(channelNodes.getByRole("button")).toHaveCount(1);
  await expect(
    palette.getByRole("button", { name: "advisor", exact: true }),
  ).toHaveCount(1);
  await expect(
    palette.getByRole("button", { name: "advisor", exact: true }),
  ).toHaveAttribute("data-placed", "true");
  await expect(
    palette.getByRole("button", { name: "添加 实验", exact: true }),
  ).toHaveAttribute("data-placed", "false");
  await expect(
    palette.getByRole("button", { name: "添加 导师", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "自动整理", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].layout.members.executor.x).toBeLessThan(
    writes[0].layout.members.advisor.x,
  );
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  await page.getByRole("tab", { name: "画布", exact: true }).click();
  await expect(
    palette.getByRole("button", { name: "advisor", exact: true }),
  ).toHaveAttribute("data-placed", "true");
  await page.setViewportSize({ width: 720, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("team budgets are optional and there is no handoff limit", async ({
  page,
}) => {
  await setup(page);
  const writes: { url: string; body: Record<string, number> }[] = [];
  await page.route("**/team/budget", (route) => {
    const body = route.request().postDataJSON();
    writes.push({ url: route.request().url(), body });
    return route.fulfill({ json: body });
  });
  await page.goto(`/#team/${wid}/settings?thread=budget`);
  const settings = page.getByRole("region", { name: "团队设置", exact: true });
  const tokens = settings.getByRole("spinbutton", {
    name: "Token 上限",
    exact: true,
  });
  const concurrent = settings.getByRole("spinbutton", {
    name: "同时工作的成员数",
    exact: true,
  });
  const period = settings.getByRole("spinbutton", {
    name: "周期（小时）",
    exact: true,
  });
  const tokensUnlimited = settings.getByRole("checkbox", {
    name: "Token 上限 不限",
    exact: true,
  });
  const concurrentUnlimited = settings.getByRole("checkbox", {
    name: "同时工作的成员数 不限",
    exact: true,
  });
  await expect(tokensUnlimited).toBeChecked();
  await expect(concurrentUnlimited).toBeChecked();
  await expect(settings.getByRole("spinbutton")).toHaveCount(0);
  await expect(
    settings.getByText("已用 25,570,999 token", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByText("连续接力上限")).toHaveCount(0);
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).not.toHaveProperty("relay_limit");
  expect(writes[0].body).toEqual({
    max_tokens: 0,
    period_hours: 24,
    max_concurrent: 0,
  });
  await tokensUnlimited.uncheck();
  await expect(tokens).toHaveValue("12000000");
  await expect(period).toHaveValue("24");
  await tokens.fill("");
  await expect(tokens).toBeVisible();
  await expect(tokensUnlimited).not.toBeChecked();
  await tokens.fill("5000");
  await period.fill("12");
  await concurrentUnlimited.uncheck();
  await expect(concurrent).toHaveValue("1");
  await concurrent.fill("3");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body).toEqual({
    max_tokens: 5000,
    period_hours: 12,
    max_concurrent: 3,
  });
  await tokensUnlimited.check();
  await expect(tokens).toHaveCount(0);
  await expect(period).toHaveCount(0);
  await expect(concurrent).toHaveValue("3");
  await concurrentUnlimited.check();
  await expect(concurrent).toHaveCount(0);
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2].body).toEqual({
    max_tokens: 0,
    period_hours: 12,
    max_concurrent: 0,
  });
});

test("threads use latest replies, the sidebar icon and local dates", async ({
  page,
}) => {
  const { reply } = await setup(page);
  await page.clock.setFixedTime(new Date("2026-10-24T07:00:00Z"));
  const rows = [
    {
      ...reply,
      id: "newer",
      text: "昨天的线程",
      participant_ids: ["advisor", "writer", "human", "executor"],
      replies: 4,
      unread: 1,
      created_at: "2026-10-23T00:00:00Z",
    },
    {
      ...reply,
      id: "oldest",
      channel_id: dm,
      text: "去年的线程",
      created_at: "2025-12-31T00:00:00Z",
    },
    {
      ...reply,
      id: "old",
      text: "刚回复的旧线程",
      created_at: "2026-01-01T00:00:00Z",
      last_message_at: "2026-10-24T06:35:00Z",
    },
  ];
  await page.route("**/team/threads?*", (route) =>
    route.fulfill({ json: rows }),
  );
  await page.goto(`/#team/${wid}/threads`);
  const list = page.getByRole("region", { name: "线程", exact: true });
  const threadRows = list.locator("[data-thread-id]");
  await expect(threadRows).toHaveCount(3);
  await expect(threadRows.nth(0)).toContainText("刚回复的旧线程");
  await expect(threadRows.nth(1)).toContainText("昨天的线程");
  await expect(threadRows.nth(2)).toContainText("去年的线程");
  await expect(threadRows.nth(0).locator("time")).toHaveText("14:35");
  await expect(threadRows.nth(1).locator("time")).toHaveText("10月23日");
  await expect(threadRows.nth(2).locator("time")).toHaveText("2025年12月31日");
  await expect(threadRows.nth(1)).toContainText("#实验");
  await expect(threadRows.nth(1)).toContainText("4 条回复");
  await expect(threadRows.nth(2)).toContainText("advisor");
  await expect(
    threadRows.nth(2).locator('svg[shape-rendering="crispEdges"]'),
  ).toHaveCount(2);
  await expect(threadRows.nth(1)).toHaveAttribute("data-unread", "true");
  await expect(
    threadRows.nth(1).locator('svg[shape-rendering="crispEdges"]'),
  ).toHaveCount(4);
  const sidebarIcon = page
    .getByRole("link", { name: "线程", exact: true })
    .locator("svg");
  await expect(list.locator("header > svg")).toHaveAttribute(
    "class",
    (await sidebarIcon.getAttribute("class"))!,
  );
  await expect(list.locator("time").first()).toHaveAttribute(
    "datetime",
    "2026-10-24T06:35:00Z",
  );
  rows[0].last_message_at = "2026-10-24T06:40:00Z";
  await expect(threadRows.first()).toContainText("昨天的线程");
  await expect(threadRows.first().locator("time")).toHaveText("14:40");
  await threadRows.first().click();
  await expect(page).toHaveURL(
    new RegExp(`#team/${wid}/${cid}\\?thread=newer$`),
  );
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: activity filters, read receipts, message location and icon-only empty state`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.addInitScript(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    const { reply } = await setup(page);
    await page.clock.setFixedTime(new Date("2026-10-24T07:00:00Z"));
    const events: TeamActivity[] = [
      "mention",
      "reply",
      "completed",
      "waiting",
      "budget",
      "limit",
    ].map((kind, index) => ({
      ...reply,
      id: `activity-${kind}`,
      thread_id: kind === "reply" ? "root" : null,
      text: `Activity summary ${kind}`,
      run: undefined,
      actor_id: "advisor",
      activity_type: kind as TeamActivity["activity_type"],
      activity_types: [kind] as TeamActivity["activity_types"],
      unread: true,
      created_at: `2026-10-24T06:${50 - index}:00Z`,
    }));
    const reads: { through: string; message_id?: string }[] = [];
    await page.route("**/team/activity", (route) =>
      route.fulfill({ json: events }),
    );
    await page.route("**/team/activity/read", (route) => {
      const body = route.request().postDataJSON();
      reads.push(body);
      for (const event of events)
        if (
          (!body.message_id || body.message_id === event.id) &&
          event.created_at <= body.through
        )
          event.unread = false;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/team/channels/*/messages*", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const thread = query.get("thread_id");
      return route.fulfill({
        json: {
          root: thread ? { ...reply, id: "root", run: undefined } : null,
          research_id: null,
          messages: events.filter(
            (event) => event.thread_id === (thread || null),
          ),
        },
      });
    });
    await page.goto(`/#team/${wid}/mentions`);
    const activity = page.getByRole("region", {
      name: t("team.activity"),
      exact: true,
    });
    const rows = activity.locator("[data-activity-id]");
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText(
      t("team.activity.event", {
        name: "advisor",
        channel: locale === "zh" ? "#实验" : "#Experiments",
        action: t("team.activity.mention"),
      }),
    );
    await expect(
      rows.first().locator('svg[shape-rendering="crispEdges"]'),
    ).toHaveCount(1);
    await expect(rows.first().locator("time")).toHaveText(
      locale === "zh" ? "10分钟前" : "10 minutes ago",
    );
    await activity
      .getByRole("radio", { name: t("team.activity.mentions"), exact: true })
      .click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute(
      "data-activity-id",
      "activity-mention",
    );
    await activity
      .getByRole("radio", { name: t("team.activity.replies"), exact: true })
      .click();
    await expect(rows).toHaveCount(1);
    await rows.first().click();
    const thread = page.getByRole("region", {
      name: t("team.thread"),
      exact: true,
    });
    const located = thread.locator('[data-message-id="activity-reply"]');
    await expect(located).toHaveAttribute("data-located", "true");
    await expect(located).toBeFocused();
    await expect.poll(() => reads[0]?.message_id).toBe("activity-reply");
    await page.goto(`/#team/${wid}/mentions`);
    await activity
      .getByRole("radio", { name: t("team.activity.all"), exact: true })
      .click();
    await activity
      .getByRole("button", { name: t("team.activity.readAll"), exact: true })
      .click();
    await expect(activity.locator("[data-unread]")).toHaveCount(0);
    await expect.poll(() => reads.some((read) => !read.message_id)).toBe(true);
    await expect(
      activity.getByRole("button", {
        name: t("team.activity.readAll"),
        exact: true,
      }),
    ).toBeDisabled();
    await rows.first().click();
    const channel = page.getByRole("region", {
      name: locale === "zh" ? "实验" : "Experiments",
      exact: true,
    });
    await expect(
      channel.locator('[data-message-id="activity-mention"]'),
    ).toHaveAttribute("data-located", "true");
    events.length = 0;
    await page.goto(`/#team/${wid}/mentions`);
    await expect(activity.locator("[data-activity-id]")).toHaveCount(0);
    await expect(activity.locator('[class*="empty"]')).toHaveText("");
    await expect(activity.locator('[class*="empty"] > svg')).toBeVisible();
  });
}
