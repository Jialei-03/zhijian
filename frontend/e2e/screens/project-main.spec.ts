import { expect, test, type Page } from "@playwright/test";
import { createTranslator } from "../../src/i18n/i18n";
import type { ModelSettings } from "../../src/screens/setup/model-api";
import type { Paper } from "../../src/api";
import type {
  BoardCard,
  ChatControl,
  ChatTurn,
  ProjectSession,
  ResearchNote,
  ResearchMerge,
  ResearchProject,
  ResearchSummary,
  Workspace,
} from "../../src/screens/research/research-api";
import { createPaperWithPdf, signIn } from "../reader/fixtures";
import { advisorDM, experiments, mockTeam } from "../fixtures/team";
import {
  teamHash,
  type TeamMessage,
} from "../../src/screens/research/team-api";

const at = "2026-10-22T08:00:00Z";
const wid = "11111111-1111-4111-8111-111111111111";
const lead = "22222222-2222-4222-8222-222222222222";
const rid = "33333333-3333-4333-8333-333333333333";
const old = "44444444-4444-4444-8444-444444444444";
const copy = "55555555-5555-4555-8555-555555555555";
const direct = "66666666-6666-4666-8666-666666666666";
const fresh = "77777777-7777-4777-8777-777777777777";
const researchSession = "88888888-8888-4888-8888-888888888888";
const workspace: Workspace = {
  id: wid,
  name: "表示学习",
  description: "项目简介",
  instructions: "比较表示质量",
  model_config_id: "model-1",
  compute_id: "host",
  kind: "research",
  archived: false,
  session_id: lead,
  created_at: at,
  updated_at: at,
};
const research: ResearchSummary = {
  id: rid,
  question: "更小的表示是否足够",
  stage: "scoping",
  status: "waiting",
  end_reason: "",
  column: "review",
  rounds: 0,
  best: null,
  working: "",
  waiting: 1,
  planned: true,
  compute_id: "host",
  updated_at: at,
  said: "计划已写好，比较两个维度",
  progress: "第一轮对比已完成",
};
function turn(id: string, prompt: string, response: string): ChatTurn {
  return {
    id,
    prompt,
    response,
    status: "completed",
    error: "",
    steps: [],
    runtime: { context: { tokens: 1200, contextWindow: 128000 } },
    model_config_id: "model-1",
    created_at: at,
    updated_at: at,
  };
}
function session(
  id: string,
  title: string,
  kind: ProjectSession["kind"] = "project_chat",
): ProjectSession {
  return {
    id,
    title,
    kind,
    workspace_id: wid,
    model_config_id: "model-1",
    research_id: kind === "research" ? rid : null,
    question: kind === "research" ? research.question : "",
    source_session_id: null,
    source_run_id: null,
    pinned_at: kind === "project_lead" ? at : null,
    archived_at: null,
    status: kind === "research" ? "waiting" : "idle",
    progress: kind === "research" ? research.progress! : "",
    created_at: at,
    updated_at: at,
    capabilities: {
      send: kind !== "research",
      coordinate: kind === "project_lead",
      rename: kind !== "research",
      pin: kind !== "project_lead",
      archive: kind === "project_chat",
      delete: kind === "project_chat",
      clone: kind !== "research",
      compact: kind !== "research",
      steer: kind !== "research",
    },
  };
}

async function project(page: Page) {
  const state = {
    workspaces: [
      {
        ...workspace,
        location: {
          kind: "local",
          path: "/home/leslie/ORA",
          connection_id: "",
        },
      },
    ],
    collections: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "表示学习分类",
        description: "分类",
        archived: false,
        research_ids: [rid],
      },
    ],
    connections: [] as {
      id: string;
      name: string;
      kind: string;
      host: string;
      port: number;
      identity_file: string;
    }[],
    workspaceRequests: [] as Record<string, any>[],
    folderRequests: [] as {
      kind: string;
      path: string;
      connection_id: string;
    }[],
    connectionRequests: [] as Record<string, any>[],
    organizations: [] as Record<string, any>[],
    connectionFails: false,
    sent: [] as {
      id: string;
      message: string;
      model_config_id?: string;
      command?: string;
    }[],
    patched: [] as {
      id: string;
      title?: string;
      archived?: boolean;
      pinned?: boolean;
    }[],
    direct: [] as Record<string, unknown>[],
    created: 0,
    pageSize: 40,
    holdAbort: false,
    sessions: [
      session(lead, "项目导师", "project_lead"),
      session(researchSession, research.question, "research"),
      session(old, "以前的项目对话"),
    ],
    researches: [structuredClone(research)],
    cards: [
      {
        id: "board-old",
        kind: "idea",
        title: "以前的看板想法",
        summary: "",
        column: "triage",
        movable: true,
        research: null,
        working: "",
        updated_at: at,
      },
    ] as BoardCard[],
    notes: (["plan", "decision", "conclusion", "error"] as const).map(
      (kind, n): ResearchNote => ({
        id: `note-${n}`,
        workspace_id: wid,
        project_id: rid,
        kind,
        text: [
          "请批准第一版计划",
          "需要选择数据集。".repeat(40),
          "两个维度的结果相近",
          "机器连接中断",
        ][n],
        created_at: `2026-10-22T08:0${n + 1}:00Z`,
        pending: n === 0,
        status: n === 0 ? "pending" : n === 3 ? "historical" : "resolved",
      }),
    ),
    controls: [] as ChatControl[],
    turns: {
      [lead]: [turn("turn-1", "项目到哪了", "第一项研究正在等待计划批准")],
      [old]: [turn("turn-old", "以前的问题", "以前的回答")],
      [copy]: [],
      [fresh]: [],
    } as Record<string, ChatTurn[]>,
  };
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({ json: { status: "ok", version: "test", mode: "local" } }),
  );
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        active_id: "model-1",
        configured: true,
        models: [1, 2].map((n) => ({
          id: `model-${n}`,
          name: `模型${n}`,
          model: `test-${n}`,
          protocol: "openai",
          base_url: "https://example.com/v1",
        })),
      },
    }),
  );
  await page.route("**/api/v1/research/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1/research", "");
    if (path.endsWith("/read")) return route.fulfill({ json: { read_at: at } });
    if (path.endsWith("/changes"))
      return route.fulfill({ json: { files: [], added: 0, removed: 0 } });
    if (path === "/workflows")
      return route.fulfill({
        json: [
          {
            id: "research",
            name: "Research",
            version: 1,
            builtin: true,
            steps: [],
          },
        ],
      });
    if (path === "/navigation")
      return route.fulfill({
        json: {
          workspaces: state.workspaces.map((item) => ({
            ...item,
            researches: state.researches
              .filter((row) => (row.workspace_id || wid) === item.id)
              .map((row) => ({
                ...row,
                title: row.title || row.question,
                workspace_id: row.workspace_id || wid,
                session_id: researchSession,
                collection_id:
                  row.collection_id === undefined
                    ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                    : row.collection_id,
                on_board: row.on_board || false,
                pinned_at: row.pinned_at || null,
              })),
          })),
          collections: state.collections,
        },
      });
    if (path === "/workspaces" && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      state.workspaceRequests.push(body);
      const next = {
        ...workspace,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: body.name,
        location: {
          ...body.location,
          path: body.create_folder
            ? `${body.location.path}/${body.name}`
            : body.location.path,
        },
      };
      state.workspaces.push(next);
      return route.fulfill({ json: next });
    }
    if (path === "/collections") {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const item = {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          name: body.name,
          description: body.description || "",
          archived: false,
          research_ids: [],
        };
        state.collections.push(item);
        return route.fulfill({ json: item });
      }
      return route.fulfill({ json: state.collections });
    }
    if (path === "/connections") {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        state.connectionRequests.push(body);
        if (state.connectionFails)
          return route.fulfill({
            status: 409,
            json: { detail: "SSH 连接验证失败" },
          });
        const connection = { id: "ssh-test", kind: "ssh", ...body };
        state.connections.push(connection);
        return route.fulfill({ json: connection });
      }
      return route.fulfill({ json: state.connections });
    }
    if (path === "/folders") {
      const kind = url.searchParams.get("kind") || "local";
      const given = url.searchParams.get("path") || "";
      const connection_id = url.searchParams.get("connection_id") || "";
      state.folderRequests.push({ kind, path: given, connection_id });
      const home = kind === "ssh" ? "/home/runner" : "/home/leslie";
      const folder = given || `${home}/ORA`;
      return route.fulfill({
        json: {
          path: folder,
          parent:
            folder === "/"
              ? null
              : folder.slice(0, folder.lastIndexOf("/")) || "/",
          project_error:
            folder === "/"
              ? "root"
              : folder === home
                ? "home"
                : folder === "/System"
                  ? "system"
                  : folder === `${home}/Desktop`
                    ? "personal"
                    : "",
          entries:
            folder === `${home}/ORA`
              ? [
                  {
                    name: "lab",
                    path: `${folder}/lab`,
                  },
                ]
              : [],
        },
      });
    }
    if (path === "/board")
      return route.fulfill({
        json: {
          columns: ["triage", "todo", "running", "review", "done", "dropped"],
          cards: state.researches
            .filter((row) => row.on_board)
            .map((row) => ({ ...row, title: row.title || row.question })),
        },
      });
    const organization = path.match(/^\/projects\/([^/]+)\/organization$/);
    if (organization) {
      const body = route.request().postDataJSON();
      state.organizations.push({ id: organization[1], ...body });
      const row = state.researches.find((item) => item.id === organization[1])!;
      Object.assign(row, body);
      if (body.pinned !== undefined) row.pinned_at = body.pinned ? at : null;
      return route.fulfill({ json: row });
    }
    if (path === "/recent") return route.fulfill({ json: [] });
    if (path === "/projects") {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        state.direct.push(body);
        state.researches.push({
          ...research,
          id: direct,
          title: body.message,
          question: body.message,
          workspace_id: body.workspace_id,
          collection_id: body.collection_id,
          on_board: false,
        });
        return route.fulfill({ json: { id: direct } });
      }
      return route.fulfill({ json: [] });
    }
    if (path === "/settings")
      return route.fulfill({
        json: {
          computes: [{ id: "host", name: "本机", kind: "host", gpus: "" }],
          default_compute: "host",
          states: {},
          tracker: { kind: "none", mode: "local", project: "", has_key: false },
        },
      });
    if (path === `/workspaces/${wid}`)
      return route.fulfill({
        json: { ...workspace, researches: state.researches },
      });
    if (path === `/workspaces/${wid}/notes`)
      return route.fulfill({ json: state.notes });
    if (path === `/workspaces/${wid}/sessions`) {
      if (route.request().method() === "POST") {
        state.created++;
        const chat = session(fresh, "新聊天");
        state.sessions.push(chat);
        return route.fulfill({ json: chat });
      }
      const search = (url.searchParams.get("search") || "").toLowerCase();
      const archived = url.searchParams.get("archived") === "true";
      const items = state.sessions
        .filter(
          (row) =>
            !!row.archived_at === archived &&
            `${row.title} ${row.question}`.toLowerCase().includes(search),
        )
        .sort((a, b) => Number(!!b.pinned_at) - Number(!!a.pinned_at));
      const start = Number(url.searchParams.get("cursor") || 0);
      const end = start + state.pageSize;
      return route.fulfill({
        json: {
          items: items.slice(start, end),
          next_cursor: end < items.length ? String(end) : null,
        },
      });
    }
    if (path === `/workspaces/${wid}/board`)
      return route.fulfill({
        json: {
          columns: ["triage", "todo", "running", "review", "done", "dropped"],
          cards: state.cards,
        },
      });
    if (path === `/workspaces/${wid}/cards`) {
      const body = route.request().postDataJSON();
      state.cards.push({
        id: "first-idea",
        kind: "idea",
        title: body.title,
        summary: "",
        column: "triage",
        movable: true,
        research: null,
        working: "",
        updated_at: at,
      });
      return route.fulfill({ json: state.cards.at(-1) });
    }
    const message = path.match(/^\/chats\/([^/]+)\/messages$/);
    if (message) {
      const body = route.request().postDataJSON();
      state.sent.push({ id: message[1], ...body });
      const next = turn(
        `turn-${state.sent.length + 1}`,
        body.message,
        `收到：${body.message}`,
      );
      next.model_config_id = body.model_config_id || "model-1";
      if (body.command === "compact") {
        next.runtime.command = "compact";
        next.runtime.compaction = { tokens_before: 1200 };
      }
      state.turns[message[1]].push(next);
      return route.fulfill({
        json: state.sessions.find((row) => row.id === message[1]),
      });
    }
    if (path === `/chats/${lead}/clone`) {
      state.turns[copy] = [...state.turns[lead]];
      const chat = {
        ...session(copy, "项目导师（副本）"),
        source_session_id: lead,
      };
      state.sessions.push(chat);
      return route.fulfill({ json: chat });
    }
    if (/^\/projects\/[^/]+\/events$/.test(path))
      return route.fulfill({
        json: [
          {
            id: "event-lead",
            actor: "lead",
            action: "message",
            detail: { text: "来自主会话的补充" },
            node_id: null,
            sprint_id: null,
            created_at: at,
          },
        ],
      });
    if (/^\/projects\/[^/]+\/workspace\/list$/.test(path))
      return route.fulfill({
        json: {
          path: "",
          entries: [],
          truncated: false,
          round: null,
          changed: [],
          compute: "ssh",
        },
      });
    if (/^\/projects\/[^/]+$/.test(path))
      return route.fulfill({
        json: {
          project: {
            ...(state.researches.find(
              (row) => row.id === path.split("/").at(-1),
            ) || research),
            id: path.split("/").at(-1),
            background: "",
            model_config_id: "model-1",
            budget: {},
            spent: { sprints: 0, tokens: 0, job_seconds: 0 },
            session_id: researchSession,
            workspace_id:
              state.researches.find((row) => row.id === path.split("/").at(-1))
                ?.workspace_id || wid,
            location: state.workspaces.find(
              (item) =>
                item.id ===
                (state.researches.find(
                  (row) => row.id === path.split("/").at(-1),
                )?.workspace_id || wid),
            )?.location,
            plan: {},
            conclusion_record: {},
            environment: {},
            created_at: at,
          },
          nodes: [],
          sprints: [],
          jobs: [],
          docker: { available: true, reason: "" },
          input_needed: "",
          datasets: [],
        },
      });
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/v1/agent/sessions/**", async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(
      /\/sessions\/([^/]+)(?:\/(runs|controls))?$/,
    )!;
    const id = match[1];
    if (match[2] === "runs")
      return route.fulfill({ json: state.turns[id] || [] });
    if (match[2] === "controls") {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const control: ChatControl = {
          id: `control-${state.controls.length}`,
          session_id: id,
          run_id: body.expected_run_id,
          kind: body.kind,
          text: body.text,
          status: "accepted",
          error: "",
          created_at: at,
          updated_at: at,
        };
        state.controls.push(control);
        if (body.kind === "abort") {
          const active = state.turns[id].find(
            (run) => run.id === body.expected_run_id,
          )!;
          if (state.holdAbort) active.runtime.phase = "stopping";
          else active.status = "cancelled";
        }
        return route.fulfill({ json: control });
      }
      return route.fulfill({
        json: state.controls.filter(
          (control) =>
            control.session_id === id &&
            (!url.searchParams.get("run_id") ||
              control.run_id === url.searchParams.get("run_id")),
        ),
      });
    }
    const chat = state.sessions.find((row) => row.id === id)!;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      state.patched.push({ id, ...body });
      if (body.title !== undefined) chat.title = body.title;
      if (body.pinned !== undefined) chat.pinned_at = body.pinned ? at : null;
      if (body.archived !== undefined)
        chat.archived_at = body.archived ? at : null;
    }
    return route.fulfill({ json: chat });
  });
  await mockTeam(page, {
    researches: (id) =>
      state.researches.filter((r) => (r.workspace_id || wid) === id),
    history: () =>
      Object.values(state.turns).flatMap((turns) =>
        turns.flatMap((run): TeamMessage[] => [
          {
            id: `legacy-user:${run.id}`,
            channel_id: advisorDM,
            thread_id: null,
            author_id: "human",
            text: run.prompt,
            kind: "legacy",
            mentions: [],
            data: {},
            created_at: run.created_at,
            replies: 0,
          },
          {
            id: `legacy:${run.id}`,
            channel_id: advisorDM,
            thread_id: null,
            author_id: "advisor",
            text: run.response,
            kind: "legacy",
            mentions: [],
            data: {},
            created_at: run.updated_at,
            replies: 0,
          },
        ]),
      ),
  });
  await signIn(page);
  await page.goto(`/#new?workspace=${wid}`);
  await expect(
    page
      .getByTestId("new-research")
      .getByRole("textbox", { name: /^(开始研究|Start research)$/ }),
  ).toBeEnabled();
  return state;
}

test("scheduled tasks open a real editor and templates without a status dashboard", async ({
  page,
}) => {
  const state = await project(page);
  const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
  await sidebar.getByRole("link", { name: "定时任务", exact: true }).click();
  await expect(page).toHaveURL(/#schedules$/);
  await expect(
    sidebar.getByRole("link", { name: "定时任务", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("安排任务", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "定时任务", exact: true })
      .getByRole("button", { name: "新建任务" }),
  ).toBeEnabled();
  const create = sidebar.getByRole("link", { name: "新建任务", exact: true });
  await expect(create).toHaveAttribute("href", "#schedules/new");
  await expect(
    sidebar.getByRole("link", { name: "看板", exact: true }),
  ).toHaveCount(0);
  const editor = page.getByRole("region", { name: "定时任务", exact: true });
  await expect(
    editor.locator("p").filter({ hasNotText: "安排任务" }),
  ).toHaveCount(0);
  await create.click();
  await expect(page).toHaveURL(/#schedules\/new$/);
  await expect(editor.getByRole("heading", { name: "新建任务" })).toBeVisible();
  await expect(
    editor.getByRole("combobox", { name: "项目", exact: true }),
  ).toHaveValue(wid);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(/#schedules$/);
  for (const title of ["每日论文速递", "每周研究周报", "跟踪实验", "夜间复跑"])
    await expect(
      editor.getByRole("button", { name: new RegExp(title) }),
    ).toBeVisible();
  await page
    .getByRole("region", { name: "定时任务", exact: true })
    .getByRole("button", { name: /每周研究周报/ })
    .click();
  await expect(page).toHaveURL(/#schedules\/new\?template=weekly$/);
  await expect(
    editor.getByRole("textbox", { name: "标题", exact: true }),
  ).toHaveValue("每周研究周报");
  await expect(
    editor.getByRole("combobox", { name: "频率", exact: true }),
  ).toHaveValue("weekly");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(/#schedules$/);
  expect(state.direct).toEqual([]);
  expect(state.sent).toEqual([]);
});

test("customize switches between the saved research playbook and real model settings", async ({
  page,
}) => {
  const state = await project(page);
  await page.route("**/api/v1/research/playbook", (route) =>
    route.fulfill({
      json: {
        version: 3,
        rules: [
          {
            id: "rule-navigation",
            when: "比较两个表示维度时",
            do: "固定数据和随机种子再比较",
            why: "让每次研究沿用已经验证过的判断规则。",
            sources: [rid],
            helpful: 2,
            harmful: 0,
            status: "active",
            created_at: at,
          },
        ],
        history: [],
      },
    }),
  );
  const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
  const customize = sidebar.getByRole("link", { name: "自定义", exact: true });
  await customize.click();
  await expect(page).toHaveURL(/#customize\/playbook$/);
  await expect(customize).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "研究手册", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("第 3 版", { exact: true })).toBeVisible();
  await expect(
    page.getByText("固定数据和随机种子再比较", { exact: false }),
  ).toBeVisible();
  await sidebar.locator('a[href="#customize/models"]').click();
  await expect(page).toHaveURL(/#customize\/models$/);
  await expect(page.getByText("模型1", { exact: true })).toBeVisible();
  await expect(page.getByText("模型2", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "模型2 的更多操作", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "使用", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(customize).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("模型1", { exact: true })).toBeVisible();
  await sidebar.locator('a[href="#customize/playbook"]').click();
  await expect(
    page.getByRole("heading", { name: "研究手册", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("第 3 版", { exact: true })).toBeVisible();
  expect(state.direct).toEqual([]);
  expect(state.sent).toEqual([]);
});

test("materials routes filter real paper records and dismiss sidebar imports without losing view or search", async ({
  page,
}) => {
  const papers: Paper[] = ["reading", "unread", "read"].map((status, n) => ({
    id: `90909090-9090-4090-8090-${String(n).padStart(12, "0")}`,
    title: `${status === "reading" ? "在读" : status === "unread" ? "未读" : "已读"}资料`,
    authors: "ORA Test",
    abstract: "",
    external_id: "",
    tags: [],
    current_version: "v1",
    agent_status: "idle",
    reading_status: status,
    favorite: false,
    archived: false,
    revision: 1,
    updated_at: at,
  }));
  await page.route("**/api/v1/papers", (route) =>
    route.fulfill({ json: papers }),
  );
  await page.route("**/api/v1/papers/*/files", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/paper-metadata", (route) =>
    route.fulfill({ json: {} }),
  );
  const state = await project(page);
  const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
  const materials = sidebar.getByRole("link", { name: "资料", exact: true });
  await materials.click();
  await expect(page).toHaveURL(/#library$/);
  await expect(materials).toHaveAttribute("aria-current", "page");
  await expect(sidebar).toContainText("资料");
  const library = page.getByRole("main");
  // project() explicitly identifies this as the local edition: status lives in the sidebar.
  await expect(
    library.getByRole("radiogroup", { name: "阅读状态" }),
  ).toHaveCount(0);
  await expect(library.locator("[data-view=list]")).toBeVisible();
  await expect(library.locator("[data-paper]")).toHaveCount(3);
  await sidebar.getByRole("link", { name: "在读", exact: true }).click();
  await expect(page).toHaveURL(/#library\?view=reading$/);
  await expect(library.locator("[data-paper]")).toHaveCount(1);
  await expect(library.locator(`[data-paper="${papers[0].id}"]`)).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "在读", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sidebar.getByRole("link", { name: "未读", exact: true }).click();
  await expect(page).toHaveURL(/#library\?view=unread$/);
  await expect(library.locator("[data-paper]")).toHaveCount(1);
  await expect(library.locator(`[data-paper="${papers[1].id}"]`)).toBeVisible();
  await sidebar.getByRole("link", { name: "全部", exact: true }).click();
  await expect(library.locator("[data-paper]")).toHaveCount(3);

  await page.goto(
    `/#library?view=reading&q=${encodeURIComponent("资料")}&import=1`,
  );
  const importing = page.getByRole("dialog", { name: "导入", exact: true });
  await expect(importing).toBeVisible();
  await importing.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(importing).toHaveCount(0);
  const params = () =>
    new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  await expect.poll(() => params().has("import")).toBe(false);
  expect(params().get("view")).toBe("reading");
  expect(params().get("q")).toBe("资料");
  await page.reload();
  await expect(importing).toHaveCount(0);
  await expect(
    library.getByRole("searchbox", { name: "搜索文库" }),
  ).toHaveValue("资料");
  await expect(
    sidebar.getByRole("link", { name: "在读", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const search = library.getByRole("searchbox", { name: "搜索文库" });
  await search.fill("在读资料");
  await expect.poll(() => params().get("q")).toBe("在读资料");
  expect(params().get("view")).toBe("reading");
  await sidebar.getByRole("link", { name: "导入", exact: true }).click();
  await expect(importing).toBeVisible();
  expect(params().get("import")).toBe("1");
  expect(params().get("view")).toBe("reading");
  expect(params().get("q")).toBe("在读资料");
  await importing.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(importing).toHaveCount(0);
  await expect.poll(() => params().has("import")).toBe(false);
  expect(params().get("view")).toBe("reading");
  expect(params().get("q")).toBe("在读资料");
  await expect(search).toHaveValue("在读资料");
  await expect(library.locator("[data-paper]")).toHaveCount(1);
  await expect(
    sidebar.getByRole("link", { name: "在读", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(state.direct).toEqual([]);
  expect(state.workspaceRequests).toEqual([]);
});

test("global quick open searches project sessions and keeps papers first for keyboard navigation", async ({
  page,
}) => {
  const state = await project(page);
  const paper = await createPaperWithPdf(page, {
    title: `${workspace.name} 检索论文 ${Date.now().toString(36)}`,
  });
  const paperResponse = await page.request.get(
    `/api/v1/papers/${paper.paperId}`,
  );
  expect(paperResponse.ok()).toBeTruthy();
  const paperRecord = await paperResponse.json();
  await page.route("**/api/v1/papers", (route) =>
    route.fulfill({ json: [paperRecord] }),
  );
  // A same-screen hash change does not refresh AppShell's paper snapshot.
  await page.reload();
  const requests: { search: string; limit: string | null }[] = [];
  await page.route("**/api/v1/research/sessions**", (route) => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get("search") || "";
    requests.push({ search, limit: url.searchParams.get("limit") });
    const items = state.sessions
      .map((row) => ({ ...row, workspace_name: workspace.name }))
      .filter((row) =>
        `${row.title} ${row.question} ${row.workspace_name}`.includes(search),
      );
    return route.fulfill({ json: { items, next_cursor: null } });
  });
  await page.goto(`/#projects/${wid}/chats/${old}`);
  await expect(
    page
      .getByTestId("team-screen")
      .getByRole("textbox", { name: "消息", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("region", { name: "advisor", exact: true }),
  ).toContainText("以前的问题");
  await expect(
    page.getByRole("region", { name: "advisor", exact: true }),
  ).toContainText("以前的回答");
  await expect(
    page.getByRole("button", { name: "搜索论文、项目与会话", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "搜索论文、项目与会话" });
  const field = dialog.getByRole("combobox", { name: "搜索论文、项目与会话" });
  await field.fill(workspace.name);
  await expect
    .poll(() => requests.at(-1))
    .toEqual({ search: workspace.name, limit: "8" });
  await expect(
    dialog.getByRole("option").first().getByText(paper.title, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("option").first().locator("svg.lucide-file-text"),
  ).toHaveCount(1);
  await expect(dialog.getByText(workspace.name, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("option").nth(1)).toContainText(workspace.name);
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#workspaces/${wid}$`));

  for (const [query, hash] of [
    ["以前的项目对话", `projects/${wid}/chats/${old}`],
    [research.question, `research/${rid}`],
  ] as const) {
    await page.keyboard.press("ControlOrMeta+k");
    await field.fill(query);
    await expect.poll(() => requests.at(-1)?.search).toBe(query);
    await expect(dialog.getByText(query, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("option").first()).toContainText(query);
    await field.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#${hash}$`));
  }

  await page.keyboard.press("ControlOrMeta+k");
  await field.fill(paper.title);
  await expect(
    dialog.getByRole("option").first().getByText(paper.title, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("option").first().locator("svg.lucide-file-text"),
  ).toHaveCount(1);
  await field.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#read/${paper.paperId}$`));
  await expect(
    page.getByRole("heading", { name: paper.title, exact: true }),
  ).toBeVisible();
});

test("global session search failures leave local paper search available", async ({
  page,
}) => {
  await project(page);
  const paper = await createPaperWithPdf(page, {
    title: `仍可检索论文 ${Date.now().toString(36)}`,
  });
  const paperResponse = await page.request.get(
    `/api/v1/papers/${paper.paperId}`,
  );
  expect(paperResponse.ok()).toBeTruthy();
  const paperRecord = await paperResponse.json();
  await page.route("**/api/v1/papers", (route) =>
    route.fulfill({ json: [paperRecord] }),
  );
  await page.reload();
  await page.route("**/api/v1/research/sessions**", (route) =>
    route.fulfill({ status: 503, json: { detail: "Search unavailable" } }),
  );
  await page.goto(`/#new?workspace=${wid}`);
  await expect(
    page
      .getByTestId("new-research")
      .getByRole("textbox", { name: /^(开始研究|Start research)$/ }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "搜索论文、项目与会话", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "搜索论文、项目与会话" });
  const field = dialog.getByRole("combobox", { name: "搜索论文、项目与会话" });
  await field.fill(paper.title);
  await expect(dialog.getByRole("status")).toHaveText(
    "项目与会话暂时无法搜索；仍可搜索文库，或重新打开后重试。",
  );
  await expect(
    dialog.getByRole("option").first().getByText(paper.title, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("option").first().locator("svg.lucide-file-text"),
  ).toHaveCount(1);
  await field.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#read/${paper.paperId}$`));
  await expect(
    page.getByRole("heading", { name: paper.title, exact: true }),
  ).toBeVisible();
});

for (const [locale, theme, width] of [
  ["zh", "light", 1440],
  ["en", "dark", 720],
] as const) {
  for (const screen of ["new", "dm", "research"] as const) {
    test(`${locale} ${screen}: first model setup preserves the draft and returns ready to send`, async ({
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
      const state = await project(page);
      const settings: ModelSettings = {
        active_id: "",
        configured: false,
        models: [],
      };
      let tests = 0;
      const sent: Record<string, unknown>[] = [];
      const switched: string[] = [];
      await page.route("**/api/v1/translation-settings", (route) =>
        route.fulfill({ json: settings }),
      );
      await page.route("**/api/v1/translation-settings/configs**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/test")) {
          tests++;
          return route.fulfill({ json: { ok: true } });
        }
        if (path.endsWith("/select")) {
          settings.active_id = "onboarding-model";
          settings.configured = true;
        } else if (
          route.request().method() === "POST" &&
          path.endsWith("/configs")
        ) {
          settings.models.push({
            id: "onboarding-model",
            name: "First model",
            model: "first-test",
            protocol: "openai",
            base_url: "https://example.invalid/v1",
          });
        } else throw new Error(`Unexpected model request: ${path}`);
        return route.fulfill({ json: settings });
      });
      await page.route(`**/api/v1/research/projects/${rid}/model`, (route) => {
        switched.push(route.request().postDataJSON().model_config_id);
        return route.fulfill({ json: {} });
      });
      for (const path of [
        `/api/v1/research/projects/${rid}/messages`,
        `/api/v1/research/workspaces/${wid}/team/channels/${advisorDM}/messages`,
      ]) {
        await page.route(`**${path}`, (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          sent.push(route.request().postDataJSON());
          return route.fulfill({ json: {} });
        });
      }
      const hash =
        screen === "new"
          ? `new?workspace=${wid}`
          : screen === "dm"
            ? teamHash(wid, advisorDM)
            : `research/${rid}`;
      await page.goto(`/#${hash}`);
      await page.reload();
      const input = page.getByRole("textbox", {
        name: t(
          screen === "new"
            ? "workspace.firstMessage"
            : screen === "dm"
              ? "team.message"
              : "research.composer.label",
        ),
        exact: true,
      });
      const composer = input.locator("..");
      const add = composer.getByRole("button", {
        name: t("settings.models.add"),
        exact: true,
      });
      await expect(add).toBeVisible();
      await expect(add).toHaveClass(/primary/);
      await expect(
        page.getByRole("button", {
          name: t("settings.models.add"),
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(
        composer.getByRole("button", {
          name: t("research.home.model"),
          exact: true,
        }),
      ).toHaveCount(0);
      // Empty drafts can enter setup through the primary button.
      await add.click();
      const dialog = page.getByRole("dialog", {
        name: t("settings.models.dialog"),
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole("button", { name: t("common.cancel"), exact: true })
        .click();
      await page.goBack();
      await expect(input).toBeEmpty();
      const draft = "Keep this unsent question";
      await input.fill(draft);
      const send = composer.getByRole("button", {
        name: t("research.home.send"),
        exact: true,
      });
      await expect(send).toBeEnabled();
      if (screen === "dm") await input.press("Enter");
      else await send.click();
      await expect(page).toHaveURL(
        (url) =>
          url.hash.startsWith("#customize/models?") &&
          new URLSearchParams(url.hash.split("?")[1]).get("returnTo") === hash,
      );
      await expect(dialog).toBeVisible();
      expect(state.direct).toEqual([]);
      expect(sent).toEqual([]);
      expect(switched).toEqual([]);
      // Reopening the page restores the saved draft before a model exists.
      await dialog
        .getByRole("button", { name: t("common.cancel"), exact: true })
        .click();
      await page.goBack();
      await expect(input).toHaveValue(draft);
      await page.reload();
      await expect(input).toHaveValue(draft);
      await expect(add).toBeVisible();
      await input.press("Enter");
      await expect(dialog).toBeVisible();
      await dialog
        .getByLabel(t("model.baseUrl"), { exact: true })
        .fill("https://example.invalid/v1");
      await dialog
        .getByLabel(t("model.key"), { exact: true })
        .fill("test-only-placeholder");
      await dialog
        .getByLabel(t("model.name"), { exact: true })
        .fill("first-test");
      await dialog
        .getByRole("button", { name: t("model.test"), exact: true })
        .click();
      await expect(page).toHaveURL((url) => url.hash === `#${hash}`);
      await expect(input).toHaveValue(draft);
      await expect(add).toHaveCount(0);
      await expect(
        composer.getByRole("button", { name: "First model", exact: true }),
      ).toBeVisible();
      await expect(send).toBeEnabled();
      expect(tests).toBe(1);
      await send.click();
      if (screen === "new") {
        await expect
          .poll(() => state.direct)
          .toEqual([
            expect.objectContaining({
              message: draft,
              model_config_id: "onboarding-model",
            }),
          ]);
      } else {
        await expect
          .poll(() => sent)
          .toEqual([
            expect.objectContaining({
              text: draft,
              ...(screen === "dm"
                ? { model_config_id: "onboarding-model" }
                : {}),
            }),
          ]);
        if (screen === "research")
          expect(switched).toEqual(["onboarding-model"]);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
}

test("new research stays empty until the first message chooses a physical workspace and optional project", async ({
  page,
}, testInfo) => {
  const state = await project(page);
  const start = page.getByTestId("new-research");
  await expect(start.getByRole("heading", { level: 1 })).toHaveText(
    "想研究什么？",
  );
  await expect(start.getByRole("textbox", { name: "开始研究" })).toBeEmpty();
  await expect(
    start.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  expect(state.direct).toEqual([]);
  await start
    .getByRole("textbox", { name: "开始研究" })
    .fill("比较两个维度的表示质量");
  await page.screenshot({
    path: testInfo.outputPath("new-research-zh-desktop.png"),
  });
  await start.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.hash === `#${teamHash(wid, experiments, `research:${direct}`)}`,
  );
  await expect(
    page.getByRole("region", { name: "线程", exact: true }),
  ).toBeVisible();
  expect(state.direct).toEqual([
    {
      message: "比较两个维度的表示质量",
      model_config_id: "model-1",
      workflow_id: "research",
      workspace_id: wid,
      collection_id: null,
    },
  ]);
  await expect(
    page.getByRole("heading", { name: /比较两个维度/ }),
  ).toBeVisible();
});

test("new research keeps the workspace and classification of the open research", async ({
  page,
}) => {
  const state = await project(page);
  await page.goto(`/#${teamHash(wid, experiments, `research:${rid}`)}`);
  const start = page
    .getByRole("navigation", { name: "侧栏" })
    .getByRole("link", { name: "新研究", exact: true });
  await expect(start).toHaveAttribute(
    "href",
    `#new?workspace=${wid}&collection=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  );
  await start.click();
  const startPage = page.getByTestId("new-research");
  await expect(startPage.getByRole("heading", { level: 1 })).toHaveText(
    "想研究什么？",
  );
  await expect(
    startPage.getByRole("button", { name: "选择项目", exact: true }),
  ).toContainText(workspace.name);
  expect(state.direct).toEqual([]);
});

test("a missing explicit workspace asks for a folder instead of silently changing machines", async ({
  page,
}) => {
  const state = await project(page);
  await page.getByRole("textbox", { name: "开始研究" }).fill("保留这个问题");
  await page.goto("/#new?workspace=00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("alert")).toHaveText("工作区不可用");
  await expect(page.getByRole("textbox", { name: "开始研究" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "开始研究" })).toHaveValue(
    "保留这个问题",
  );
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await page
    .getByTestId("new-research")
    .getByRole("button", { name: "选择项目", exact: true })
    .click();
  // An ordinary navigation refresh must not unmount the recovery picker.
  await expect(
    page.getByRole("dialog", { name: "选择项目", exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: /表示学习 本机/ }).click();
  await expect(page.getByRole("textbox", { name: "开始研究" })).toHaveValue(
    "保留这个问题",
  );
  expect(state.workspaceRequests).toEqual([]);
  expect(state.direct).toEqual([]);
});

test("a new user creates a project through the fixed switcher and empty list", async ({
  page,
}) => {
  const state = await project(page);
  state.workspaces = [];
  state.researches = [];
  state.collections = [];
  await page.goto("/#new");
  await page.reload();
  const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
  for (const id of ["threads", "activity", "team-settings", "create-channel"])
    await expect(sidebar.locator(`[data-id="${id}"]`)).toBeDisabled();
  await sidebar.getByRole("button", { name: "切换项目", exact: true }).click();
  await page
    .getByRole("dialog", { name: "选择项目", exact: true })
    .getByRole("button", { name: "新建项目", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page).not.toHaveURL(/#workspaces/);
  await expect(sidebar.getByText("新建团队", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto("/#workspaces");
  const main = page.getByRole("main");
  const empty = main.locator('[class*="emptyProjects"]');
  await expect(empty.locator("svg").first()).toBeVisible();
  await expect(main.getByText("暂无项目", { exact: true })).toHaveCount(0);
  await empty.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "项目名称" })).toHaveValue(
    "未命名项目",
  );
  await expect(
    dialog.getByRole("region", { name: "已选文件夹" }),
  ).toContainText("/home/leslie/ORA/未命名项目");
  await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.workspaceRequests).toEqual([
    {
      name: "未命名项目",
      create_folder: true,
      location: { kind: "local", path: "/home/leslie/ORA", connection_id: "" },
    },
  ]);
  expect(state.direct).toEqual([]);
});

for (const kind of ["local", "ssh"] as const) {
  test(`${kind} protected folders disable project creation with a short reason`, async ({
    page,
  }) => {
    const state = await project(page);
    state.connections.push({
      id: "lab",
      kind: "ssh",
      name: "Lab",
      host: "runner@lab",
      port: 22,
      identity_file: "",
    });
    await page.goto("/#workspaces");
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await dialog
      .getByRole("radio", { name: "选择已有文件夹", exact: true })
      .click();
    if (kind === "ssh")
      await dialog
        .getByRole("button", { name: "Lab runner@lab", exact: true })
        .click();
    const home = kind === "ssh" ? "/home/runner" : "/home/leslie";
    const address = dialog.getByRole("textbox", { name: "目录路径" });
    await expect(address).toHaveValue(`${home}/ORA`);
    const submit = dialog.getByRole("button", {
      name: "使用此文件夹",
      exact: true,
    });
    for (const [path, reason] of [
      [home, "不能用主目录"],
      ["/", "不能用根目录"],
      ["/System", "不能用系统目录"],
      [`${home}/Desktop`, "不能用个人目录"],
    ]) {
      await address.fill(path);
      await expect(submit).toBeDisabled();
      await address.press("Enter");
      await expect(dialog.getByRole("status")).toHaveText(reason);
      await expect(submit).toBeDisabled();
    }
    expect(state.workspaceRequests).toEqual([]);
    await address.fill(`${home}/ORA/lab`);
    await address.press("Enter");
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await expect(submit).toBeEnabled();
  });
}

test("workspace chooser creates a new folder without an empty research", async ({
  page,
}) => {
  const state = await project(page);
  await page
    .getByTestId("new-research")
    .getByRole("button", { name: "选择项目", exact: true })
    .click();
  const chooser = page.getByRole("dialog", { name: "选择项目", exact: true });
  await chooser
    .getByRole("searchbox", { name: "搜索项目" })
    .fill("no such folder");
  await expect(chooser.getByRole("option")).toHaveCount(0);
  await chooser.getByRole("button", { name: "新建项目", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
  await expect(
    dialog.getByRole("button", { name: "本机", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("radio", { name: "新建文件夹", exact: true }),
  ).toBeChecked();
  await expect(dialog.getByRole("region", { name: "浏览文件夹" })).toHaveCount(
    0,
  );
  const selectedFolder = dialog.getByRole("region", { name: "已选文件夹" });
  await expect(selectedFolder).toContainText("本机");
  await expect(selectedFolder).toContainText("/home/leslie/ORA");
  const name = dialog.getByRole("textbox", { name: "项目名称" });
  await expect(name).toHaveValue("未命名项目");
  await expect(name).toBeFocused();
  expect(
    await name.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, "未命名项目".length]);
  await name.fill("");
  await expect(
    dialog.getByRole("button", { name: "新建项目", exact: true }),
  ).toBeDisabled();
  await name.fill("../escape");
  await expect(dialog.getByRole("status")).toHaveText("文件夹名称不合法");
  await expect(
    dialog.getByRole("button", { name: "新建项目", exact: true }),
  ).toBeDisabled();
  await name.fill("实验目录");
  await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("new-research")).toContainText("实验目录");
  expect(state.workspaceRequests).toEqual([
    {
      name: "实验目录",
      create_folder: true,
      location: { kind: "local", path: "/home/leslie/ORA", connection_id: "" },
    },
  ]);
  expect(state.direct).toEqual([]);
  expect(state.folderRequests).toContainEqual({
    kind: "local",
    path: "",
    connection_id: "",
  });
});

test("workspace folders hide dot directories by default and still open a hidden path directly", async ({
  page,
}) => {
  const state = await project(page);
  await page.route("**/api/v1/research/folders?**", async (route) => {
    const url = new URL(route.request().url());
    const given = url.searchParams.get("path") || "";
    if (url.searchParams.get("kind") !== "local") return route.fallback();
    state.folderRequests.push({
      kind: "local",
      path: given,
      connection_id: "",
    });
    const path = given || "/home/leslie/ORA";
    return route.fulfill({
      json: {
        path,
        parent: "/home/leslie",
        project_error: "",
        entries:
          path === "/home/leslie/ORA"
            ? [
                { name: ".private", path: "/home/leslie/ORA/.private" },
                { name: "lab", path: "/home/leslie/ORA/lab" },
              ]
            : [],
      },
    });
  });
  await page
    .getByTestId("new-research")
    .getByRole("button", { name: "选择项目", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "选择项目", exact: true })
    .getByRole("button", { name: "新建项目", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
  await dialog
    .getByRole("radio", { name: "选择已有文件夹", exact: true })
    .click();
  const folders = dialog.getByRole("region", { name: "浏览文件夹" });
  const hidden = folders.getByRole("button", { name: ".private", exact: true });
  const showHidden = folders.getByRole("checkbox", { name: "显示隐藏文件夹" });
  await expect(
    folders.getByRole("button", { name: "lab", exact: true }),
  ).toBeVisible();
  await expect(showHidden).not.toBeChecked();
  await expect(hidden).toHaveCount(0);
  await showHidden.check();
  await expect(hidden).toBeVisible();
  await showHidden.uncheck();
  await expect(hidden).toHaveCount(0);
  const address = folders.getByRole("textbox", { name: "目录路径" });
  await address.fill("/home/leslie/ORA/.private");
  await expect(
    dialog.getByRole("button", { name: "使用此文件夹" }),
  ).toBeDisabled();
  await address.press("Enter");
  await expect(
    dialog.getByRole("region", { name: "已选文件夹" }),
  ).toContainText("/home/leslie/ORA/.private");
  await expect(dialog.getByRole("textbox", { name: "项目名称" })).toHaveValue(
    "未命名项目",
  );
  await dialog
    .getByRole("button", { name: "使用此文件夹", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.workspaceRequests).toEqual([
    {
      name: "未命名项目",
      location: {
        kind: "local",
        path: "/home/leslie/ORA/.private",
        connection_id: "",
      },
    },
  ]);
  expect(state.direct).toEqual([]);
});

test("SSH connections validate before a remote folder can become a workspace", async ({
  page,
}) => {
  const state = await project(page);
  state.connectionFails = true;
  await page.goto("/#workspaces");
  await page.getByRole("button", { name: "SSH 连接", exact: true }).click();
  const connection = page.getByRole("dialog", {
    name: "SSH 连接",
    exact: true,
  });
  await connection
    .getByRole("textbox", { name: "显示名称" })
    .fill("实验服务器");
  await connection.getByRole("textbox", { name: "主机名" }).fill("runner@lab");
  await connection
    .getByRole("textbox", { name: "身份文件（可选）" })
    .fill("~/.ssh/id_ed25519");
  await connection.getByRole("button", { name: "保存并验证" }).click();
  await expect(connection.getByRole("alert")).toContainText("SSH 连接验证失败");
  expect(state.connections).toEqual([]);
  state.connectionFails = false;
  await connection.getByRole("button", { name: "保存并验证" }).click();
  await expect(connection).toContainText("实验服务器");
  await connection
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const workspaceDialog = page.getByRole("dialog", {
    name: "新建项目",
    exact: true,
  });
  await workspaceDialog
    .getByRole("radio", { name: "选择已有文件夹", exact: true })
    .click();
  await workspaceDialog
    .getByRole("button", { name: "实验服务器 runner@lab", exact: true })
    .click();
  await expect(
    workspaceDialog.getByRole("button", {
      name: "实验服务器 runner@lab",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await workspaceDialog
    .getByRole("region", { name: "浏览文件夹" })
    .getByRole("button", { name: "lab", exact: true })
    .click();
  await expect(
    workspaceDialog.getByRole("textbox", { name: "目录路径" }),
  ).toHaveValue("/home/runner/ORA/lab");
  await workspaceDialog
    .getByRole("textbox", { name: "项目名称" })
    .fill("远端实验");
  await expect(
    workspaceDialog.getByRole("region", { name: "已选文件夹" }),
  ).toContainText("实验服务器");
  await expect(
    workspaceDialog.getByRole("region", { name: "已选文件夹" }),
  ).toContainText("/home/runner/ORA/lab");
  await workspaceDialog
    .getByRole("button", { name: "使用此文件夹", exact: true })
    .click();
  await expect
    .poll(() => state.workspaceRequests.at(-1))
    .toEqual({
      name: "远端实验",
      location: {
        kind: "ssh",
        path: "/home/runner/ORA/lab",
        connection_id: "ssh-test",
      },
    });
  await expect(workspaceDialog).toHaveCount(0);
  await expect(page).toHaveURL(
    /#workspaces\/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb$/,
  );
  expect(state.folderRequests).toContainEqual({
    kind: "ssh",
    path: "",
    connection_id: "ssh-test",
  });
  expect(state.direct).toEqual([]);
  await expect(
    page
      .getByRole("main")
      .getByTitle("实验服务器 · SSH · runner@lab · /home/runner/ORA/lab", {
        exact: true,
      }),
  ).toHaveText("实验服务器");
  await expect(
    page
      .getByRole("navigation", { name: "侧栏", exact: true })
      .getByRole("button", { name: "切换项目", exact: true }),
  ).toHaveText("远端实验");
  await expect(
    page
      .getByRole("main")
      .getByRole("heading", { name: "远端实验", exact: true }),
  ).toBeVisible();
  await page.goto("/#new?workspace=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await expect(
    page
      .getByTestId("new-research")
      .getByTitle("实验服务器 · SSH · runner@lab", {
        exact: true,
      }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId("new-research")
      .getByRole("button", { name: "选择项目", exact: true }),
  ).toHaveText("远端实验");
  await page
    .getByTestId("new-research")
    .getByRole("button", { name: "选择项目", exact: true })
    .click();
  const folderPicker = page.getByRole("dialog", {
    name: "选择项目",
    exact: true,
  });
  await folderPicker
    .getByRole("searchbox", { name: "搜索项目" })
    .fill("runner@lab");
  await expect(folderPicker.getByRole("option")).toHaveCount(1);
  await expect(folderPicker.getByRole("option")).toContainText(
    "实验服务器 · /home/runner/ORA/lab",
  );
  await page.keyboard.press("Escape");
  state.researches[0].workspace_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await page.goto(`/#research/${rid}`);
  await expect(
    page.getByTitle("/home/runner/lab", { exact: true }).last(),
  ).toHaveCount(0);
  const showRecord = page.getByRole("button", {
    name: "显示研究记录",
    exact: true,
  });
  await expect(showRecord).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "研究记录" }),
  ).toHaveCount(0);
  await showRecord.click();
  await expect(
    page.getByRole("complementary", { name: "研究记录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "研究记录" }).getByRole("tab"),
  ).toHaveText(["进度", "变更", "实验"]);
  await page.getByRole("button", { name: "收起研究记录", exact: true }).click();
  await page.goto("/#workspaces/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await expect(
    page
      .getByRole("main")
      .getByTitle("实验服务器 · SSH · runner@lab · /home/runner/ORA/lab", {
        exact: true,
      }),
  ).toHaveText("实验服务器");
  await page.getByRole("main").locator(`a[href="#research/${rid}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#research/${rid}$`));
});

test("conversation actions rename the title and the project owns list and board views", async ({
  page,
}) => {
  const state = await project(page);
  await page.goto(`/#research/${rid}`);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名" });
  await dialog.getByRole("textbox", { name: "研究标题" }).fill("小表示对比");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "小表示对比" })).toBeVisible();
  expect(state.researches[0].question).toBe(research.question);
  await page.goto(`/#workspaces/${wid}`);
  await page.getByRole("radio", { name: "看板", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#workspaces/${wid}/board$`));
  const boardResearch = page
    .getByRole("main")
    .locator(`a[href="#research/${rid}"]`);
  await expect(boardResearch).toContainText("小表示对比");
  await expect(boardResearch).toContainText(research.progress!);
  await page.getByRole("radio", { name: "列表", exact: true }).click();
  await expect(
    page.getByRole("main").getByRole("link", { name: /小表示对比/ }),
  ).toBeVisible();
  await page.getByRole("main").locator(`a[href="#research/${rid}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#research/${rid}$`));
  await expect(
    page.getByRole("heading", { name: "小表示对比", exact: true }),
  ).toBeVisible();
  expect(state.direct).toEqual([]);
});

test("the project list puts search before archive filtering and clamps research summaries", async ({
  page,
}) => {
  const state = await project(page);
  const question = "研究问题需要比较不同数据集上的表示质量。".repeat(40);
  const conclusion = "结论来自重复实验，适用于这组数据和设置。".repeat(120);
  Object.assign(state.researches[0], {
    title: "当前研究",
    question,
    progress: conclusion,
    status: "finished",
  });
  const archived = {
    ...research,
    id: copy,
    title: "归档研究",
    archived_at: at,
  };
  state.researches.push(archived);
  const untitled = {
    ...research,
    id: fresh,
    question: "没有独立标题的长问题也只显示一行。".repeat(40),
  };
  state.researches.push(untitled);
  await page.evaluate(() => localStorage.removeItem("paper-appearance"));
  await page.goto(`/#workspaces/${wid}`);
  const main = page.getByRole("main");
  const filter = main.getByRole("radiogroup", {
    name: "归档状态",
    exact: true,
  });
  const unarchived = filter.getByRole("radio", { name: "未归档", exact: true });
  const archivedChoice = filter.getByRole("radio", {
    name: "已归档",
    exact: true,
  });
  const search = main.getByRole("searchbox", { name: "搜索研究", exact: true });
  const current = main.locator(`a[href="#research/${rid}"]`);
  const oldResearch = main.locator(`a[href="#research/${copy}"]`);
  await expect(unarchived).toBeChecked();
  await expect(current).toBeVisible();
  await expect(oldResearch).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "已归档", exact: true }),
  ).toHaveCount(0);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      colorScheme,
    );
    for (const width of [1280, 720]) {
      await page.setViewportSize({ width, height: 900 });
      const questionLine = current.getByText(question, { exact: true });
      const summary = current.getByText(conclusion, { exact: true });
      await expect(questionLine).toHaveCSS("-webkit-line-clamp", "1");
      await expect(summary).toHaveCSS("-webkit-line-clamp", "2");
      for (const [element, lines] of [
        [questionLine, 1],
        [summary, 2],
      ] as const) {
        const box = await element.evaluate((el) => ({
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          clipped: el.scrollHeight > el.clientHeight,
        }));
        expect(box.height).toBeLessThanOrEqual(box.lineHeight * lines + 1);
        expect(box.clipped).toBe(true);
      }
      const title = main
        .locator(`a[href="#research/${fresh}"]`)
        .getByText(untitled.question, { exact: true });
      await expect(title).toHaveCSS("white-space", "nowrap");
      await expect(title).toHaveCSS("text-overflow", "ellipsis");
      expect(
        await title.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      const filterBox = (await filter.boundingBox())!;
      const searchBox = (await search.boundingBox())!;
      expect(Math.abs(filterBox.y - searchBox.y)).toBeLessThan(4);
      expect(searchBox.x + searchBox.width).toBeLessThan(filterBox.x);
      const toolbarBox = (await search
        .locator("xpath=ancestor::div[2]")
        .boundingBox())!;
      expect(
        Math.abs(
          filterBox.x + filterBox.width - toolbarBox.x - toolbarBox.width,
        ),
      ).toBeLessThan(1);
      expect(
        await main.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  }

  await search.fill("研究");
  await unarchived.focus();
  await page.keyboard.press("ArrowRight");
  await expect(archivedChoice).toBeChecked();
  await expect(current).toHaveCount(0);
  await expect(oldResearch).toBeVisible();
  await expect(search).toHaveValue("研究");
  await expect(
    oldResearch.getByRole("button", { name: "恢复", exact: true }),
  ).toBeVisible();
  await search.fill("没有匹配项");
  await expect(oldResearch).toHaveCount(0);
  await expect(archivedChoice).toBeChecked();
  await search.fill("");
  await unarchived.click();
  await expect(current).toBeVisible();
  await expect(oldResearch).toHaveCount(0);
});

test("needs you opens pending conversations and sidebar entries expose real state", async ({
  page,
}) => {
  const state = await project(page);
  state.researches[0].status = "waiting";
  await page.reload();
  const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
  const conversations = sidebar.getByRole("group", {
    name: "消息",
    exact: true,
  });
  await expect(
    conversations.getByRole("link", { name: "advisor", exact: true }),
  ).toBeVisible();
  // The status dot is on the member's card trigger beside the conversation link.
  await expect(
    conversations
      .getByRole("button", {
        name: createTranslator("zh").t("team.colleague.card", {
          name: "advisor",
        }),
        exact: true,
      })
      .getByRole("img", { name: "等你", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "通知", exact: true }),
  ).toHaveCount(0);
  const attention = sidebar.getByRole("region", {
    name: "需要你",
    exact: true,
  });
  await expect(attention).toContainText(research.question);
  await expect(attention).toContainText("等你决定");
  await attention
    .getByRole("link", { name: new RegExp(research.question) })
    .click();
  await expect(page).toHaveURL(
    (url) => url.hash === `#${teamHash(wid, "", `research:${rid}`)}`,
  );
  const thread = page.getByRole("region", { name: "线程", exact: true });
  await expect(
    thread.getByRole("heading", { name: research.question, exact: true }),
  ).toBeVisible();
  await expect(
    thread.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveAttribute("placeholder", "发送给 #实验");
  expect(state.direct).toEqual([]);
});

test("team channels keep every research and derived conversation accessible as a thread", async ({
  page,
}) => {
  const state = await project(page);
  state.researches = Array.from({ length: 7 }, (_, n) => ({
    ...research,
    id:
      n === 0 ? rid : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `研究 ${n}`,
    updated_at: `2026-10-22T08:0${n}:00Z`,
    parent_id: n === 5 ? rid : null,
  }));
  await page.goto(`/#${teamHash(wid, experiments)}`);
  const sidebar = page.getByRole("navigation", { name: "侧栏" });
  const conversations = sidebar.getByRole("group", {
    name: "消息",
    exact: true,
  });
  await expect(
    conversations.getByRole("link", { name: "实验", exact: true }),
  ).toBeVisible();
  await expect(
    conversations.getByRole("link", { name: "advisor", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "切换项目", exact: true }),
  ).toHaveText(workspace.name);
  const channel = page.getByRole("region", { name: "实验", exact: true });
  await expect(channel.getByRole("article")).toHaveCount(7);
  await expect(
    channel.getByRole("button", { name: "研究 0", exact: true }),
  ).toBeVisible();
  await channel.getByRole("button", { name: "研究 5", exact: true }).click();
  const thread = page.getByRole("region", { name: "线程", exact: true });
  await expect(
    thread.getByRole("heading", { name: "研究 5", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.hash ===
      `#${teamHash(wid, experiments, `research:${state.researches[5].id}`)}`,
  );
  await thread.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(thread).toHaveCount(0);
  await expect(channel.getByRole("article")).toHaveCount(7);
  expect(state.direct).toEqual([]);
});

test("team thread selection survives reload and remains accessible after visiting materials", async ({
  page,
}) => {
  const state = await project(page);
  const sidebar = page.getByRole("navigation", { name: "侧栏" });
  await page.goto(`/#${teamHash(wid, experiments)}`);
  await page
    .getByRole("button", { name: research.question, exact: true })
    .click();
  const thread = page.getByRole("region", { name: "线程", exact: true });
  await expect(
    thread.getByRole("heading", { name: research.question, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    thread.getByRole("heading", { name: research.question, exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "实验", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sidebar.getByRole("link", { name: "资料", exact: true }).click();
  await sidebar.getByRole("link", { name: "研究", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.hash === `#${teamHash(wid, experiments, `research:${rid}`)}`,
  );
  await expect(
    thread.getByRole("heading", { name: research.question, exact: true }),
  ).toBeVisible();
  expect(state.direct).toEqual([]);
});

test("new-research drafts and models survive reading, folder and project changes, while legacy project links open folders", async ({
  page,
}) => {
  const state = await project(page);
  const input = page.getByRole("textbox", { name: "开始研究" });
  await input.fill("ORA 中未发送的想法");
  const start = page.getByTestId("new-research");
  await start.getByRole("button", { name: "模型1", exact: true }).click();
  await page.getByRole("menuitem", { name: "模型2", exact: true }).click();
  await page.goto("/#library");
  await page.goto(`/#new?workspace=${wid}`);
  await expect(input).toHaveValue("ORA 中未发送的想法");
  await expect(
    start.getByRole("button", { name: "模型2", exact: true }),
  ).toBeVisible();
  state.workspaces.push({
    ...workspace,
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    name: "另一目录",
    location: { kind: "local", path: "/home/leslie/Other", connection_id: "" },
  });
  await page.reload();
  await start.getByRole("button", { name: "选择项目", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "选择项目", exact: true }),
  ).toBeVisible();
  expect(state.direct).toEqual([]);
  await page.getByRole("option", { name: /另一目录/ }).click();
  await expect(page).toHaveURL(
    /#new\?workspace=dddddddd-dddd-4ddd-8ddd-dddddddddddd$/,
  );
  await expect(input).toHaveValue("ORA 中未发送的想法");
  await expect(
    start.getByRole("button", { name: "模型2", exact: true }),
  ).toBeVisible();
  await input.fill("保留问题，改用另一目录");
  await page.goto(`/#new?workspace=${wid}`);
  await expect(input).toHaveValue("保留问题，改用另一目录");
  await page.goto("/#new?workspace=dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  await expect(input).toHaveValue("保留问题，改用另一目录");
  await expect(input).toHaveValue("保留问题，改用另一目录");
  await expect(
    start.getByRole("button", { name: "模型2", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue("保留问题，改用另一目录");
  await expect(
    start.getByRole("button", { name: "模型2", exact: true }),
  ).toBeVisible();
  await page.goto(`/#projects/${wid}`);
  await expect(page).toHaveURL(new RegExp(`#workspaces/${wid}$`));
  await expect(
    page.getByRole("button", { name: "项目导师", exact: true }),
  ).toHaveCount(0);
  expect(state.direct).toEqual([]);
});

test("a finished research accepts a discussion and stops only its current answer", async ({
  page,
}) => {
  const state = await project(page);
  const sent: { text: string }[] = [];
  const controls: {
    expected_run_id: string;
    kind: string;
    client_id: string;
  }[] = [];
  let active = false;
  let started = false;
  let completed = false;
  const discussionReply =
    "已有证据支持小表示，适用条件是数据分布与当前实验一致。";
  const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const sprintId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const finished: ResearchProject = {
    ...research,
    title: "已完成的表示研究",
    background: "",
    model_config_id: "model-1",
    status: "finished",
    stage: "done",
    end_reason: "concluded",
    budget: { max_sprints: null, max_tokens: null, max_job_seconds: null },
    spent: { sprints: 1, tokens: 1000, job_seconds: 12 },
    session_id: researchSession,
    workspace_id: wid,
    plan: {},
    conclusion_record: {
      status: "concluded",
      answer: "小表示足够",
      summary: "小表示已通过三个种子核验",
      proposed_at: at,
      accepted: true,
      note: "",
    },
    environment: {},
    created_at: at,
  };
  await page.route(`**/api/v1/research/projects/${rid}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/projects/${rid}`))
      return route.fulfill({
        json: {
          project: finished,
          nodes: [],
          jobs: [],
          datasets: [],
          docker: { available: true, reason: "" },
          input_needed: "",
          sprints: started
            ? [
                {
                  id: sprintId,
                  number: 2,
                  role: "discussion",
                  run_id: runId,
                  status: active ? "running" : "ended",
                  focus_node_id: null,
                  summary: completed ? discussionReply : "",
                  next_focus: "",
                  waiting_on: [],
                  tokens: 0,
                  created_at: at,
                  updated_at: at,
                },
              ]
            : [],
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({
        json: [
          {
            id: "finished-answer",
            actor: "advisor",
            action: "message",
            detail: { text: "已确认的研究结论" },
            node_id: null,
            sprint_id: null,
            created_at: at,
          },
          ...sent.map((item, n) => ({
            id: `discussion-user-${n}`,
            actor: "human",
            action: "message",
            detail: item,
            node_id: null,
            sprint_id: null,
            created_at: at,
          })),
          ...(completed
            ? [
                {
                  id: "discussion-complete",
                  actor: "advisor",
                  action: "message",
                  detail: { text: discussionReply },
                  node_id: null,
                  sprint_id: sprintId,
                  created_at: at,
                },
                {
                  id: "discussion-ended",
                  actor: "system",
                  action: "sprint_ended",
                  detail: {},
                  node_id: null,
                  sprint_id: sprintId,
                  created_at: at,
                },
              ]
            : []),
        ],
      });
    if (path.endsWith("/runs"))
      return route.fulfill({
        json: started
          ? [
              {
                id: runId,
                status: active
                  ? "running"
                  : completed
                    ? "completed"
                    : "cancelled",
                response: completed ? discussionReply : "正在解释已有证据",
                error: "",
                steps: [],
                role: "discussion",
                runtime: {
                  phase: active ? "responding" : "stopped",
                  read_only: true,
                },
                created_at: at,
                updated_at: at,
                sprint_id: sprintId,
                sprint_number: 2,
              },
            ]
          : [],
      });
    if (path.endsWith("/messages") && route.request().method() === "POST") {
      sent.push(route.request().postDataJSON());
      active = true;
      started = true;
      completed = false;
      return route.fulfill({ json: finished });
    }
    return route.fallback();
  });
  await page.route(
    `**/api/v1/agent/sessions/${researchSession}/controls`,
    async (route) => {
      if (route.request().method() !== "POST")
        return route.fulfill({ json: [] });
      const body = route.request().postDataJSON();
      controls.push(body);
      active = false;
      return route.fulfill({
        json: {
          id: "discussion-abort",
          session_id: researchSession,
          run_id: runId,
          kind: "abort",
          text: "",
          status: "applied",
          error: "",
          created_at: at,
          updated_at: at,
        },
      });
    },
  );
  await page.goto(`/#research/${rid}`);
  const input = page.getByRole("textbox", {
    name: "研究会话消息",
    exact: true,
  });
  await expect(input).toBeEnabled();
  const finishedPlaceholder = "接着说";
  await expect(input).toHaveAttribute("placeholder", finishedPlaceholder);
  await expect(
    page.getByRole("complementary", { name: "研究记录" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "显示研究记录", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "研究记录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "研究记录" }),
  ).toContainText("小表示已通过三个种子核验");
  await expect(
    page
      .getByRole("complementary", { name: "研究记录" })
      .getByRole("button", { name: "查看变更", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "研究记录" }).getByRole("tab"),
  ).toHaveText(["进度", "变更", "实验"]);
  await page.getByRole("button", { name: "收起研究记录", exact: true }).click();
  await input.fill("解释这个结论的适用条件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  const stop = page.getByRole("menuitem", { name: "停止", exact: true });
  await expect(stop).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByText("复盘", { exact: true })).toHaveCount(0);
  expect(sent).toEqual([{ text: "解释这个结论的适用条件" }]);
  await input.fill("未发送的追问");
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(input).toHaveValue("未发送的追问");
  await expect(input).toHaveAttribute("placeholder", finishedPlaceholder);
  await expect(
    page.getByText("已确认的研究结论", { exact: true }),
  ).toBeVisible();
  expect(controls).toHaveLength(1);
  expect(controls[0]).toMatchObject({ expected_run_id: runId, kind: "abort" });
  expect(controls[0].client_id).toMatch(/^[0-9a-f-]{36}$/);
  await input.fill("请完整说明适用条件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  completed = true;
  active = false;
  await expect(stop).toHaveCount(0);
  const reply = page.getByText(discussionReply, { exact: true });
  await expect(reply).toHaveCount(1);

  await expect(page.getByText("复盘", { exact: true })).toHaveCount(0);
  await expect(input).toHaveAttribute("placeholder", finishedPlaceholder);
  expect(sent).toEqual([
    { text: "解释这个结论的适用条件" },
    { text: "请完整说明适用条件" },
  ]);
  expect(finished.status).toBe("finished");
  expect(finished.question).toBe(research.question);
  expect(state.direct).toEqual([]);
});

test.describe("a narrow English research start", () => {
  test.use({
    locale: "en-US",
    colorScheme: "dark",
    viewport: { width: 390, height: 844 },
  });
  test("keeps workspace selection, a draft, and model input usable", async ({
    page,
  }, testInfo) => {
    const state = await project(page);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const start = page.getByTestId("new-research");
    await expect(start.getByRole("heading", { level: 1 })).toHaveText(
      "What do you want to research?",
    );
    await expect(
      start.getByRole("textbox", { name: "Start research" }),
    ).toBeInViewport();
    await start
      .getByRole("textbox", { name: "Start research" })
      .fill("Compare representation quality");
    await start
      .getByRole("button", { name: "Choose project", exact: true })
      .click();
    const chooser = page.getByRole("dialog", {
      name: "Choose project",
      exact: true,
    });
    await chooser.getByRole("searchbox").fill("表示");
    await chooser.getByRole("searchbox").press("ArrowDown");
    await expect(chooser.getByRole("option").first()).toBeFocused();
    await chooser.getByRole("option").first().press("Enter");
    await expect(chooser).toHaveCount(0);
    await expect(
      start.getByRole("button", { name: "Choose project", exact: true }),
    ).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#new\\?workspace=${wid}$`));
    await expect(
      start.getByRole("textbox", { name: "Start research" }),
    ).toHaveValue("Compare representation quality");
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      )
      .toBeLessThanOrEqual(2);
    expect(state.direct).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("new-research-en-dark-narrow.png"),
    });
  });
});

const branchId = "99999999-9999-4999-8999-999999999999";
const checkpoint = "a".repeat(40);
const mainCommit = "b".repeat(40);
const mergedCommit = "c".repeat(40);

async function branches(page: Page, handoffPending = false) {
  const base = await project(page);
  const source: ResearchProject = {
    ...research,
    status: handoffPending ? "active" : "finished",
    stage: handoffPending ? "experiments" : "done",
    end_reason: "concluded",
    background: "比较表示维度",
    model_config_id: "model-1",
    budget: { max_sprints: null, max_tokens: null, max_job_seconds: null },
    spent: { sprints: 2, tokens: 2000, job_seconds: 30 },
    session_id: researchSession,
    workspace_id: wid,
    location: { kind: "local", path: "/private/fork-cwd", connection_id: "" },
    plan: {},
    conclusion_record: {
      status: "concluded",
      answer: "小表示足够",
      summary: "三个种子均支持小表示",
      proposed_at: at,
      accepted: true,
      note: "",
    },
    environment: {},
    created_at: at,
  };
  const state = {
    ...base,
    forkChecks: 0,
    child: null as ResearchProject | null,
    forks: [] as Record<string, string>[],
    resumes: 0,
    previews: [] as { kind: "memory" | "code"; paths?: string[] }[],
    applies: [] as Record<string, string>[],
    cancelled: [] as string[],
    records: [] as ResearchMerge[],
    codeConflict: false,
    staleNext: false,
  };
  const files = ["train.py", "docs/notes.md"].map((path) => ({
    path,
    status: "M",
    diff: `diff --git a/${path} b/${path}\n-old\n+verified result`,
  }));
  await page.route("**/api/v1/research/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/v1/research",
      "",
    );
    if (path === `/projects/${rid}/forks/options`) {
      state.forkChecks++;
      return route.fulfill({
        json: {
          can_fork: true,
          reason: "",
          rounds: [
            {
              sprint_id: "older",
              number: 1,
              role: "executor",
              status: "ended",
              commit_sha: "",
              available: false,
              reason: "此轮没有历史快照",
            },
            {
              sprint_id: "checkpoint",
              number: 2,
              role: "executor",
              status: "ended",
              commit_sha: checkpoint,
              available: !handoffPending || state.forkChecks > 1,
              reason:
                handoffPending && state.forkChecks === 1
                  ? "原始运行仍在收尾"
                  : "",
            },
            {
              sprint_id: "running",
              number: 3,
              role: "executor",
              status: "running",
              commit_sha: "",
              available: false,
              reason: "此轮尚未结束",
            },
          ],
        },
      });
    }
    if (path === `/projects/${rid}/forks`) {
      const body = route.request().postDataJSON();
      state.forks.push(body);
      state.child = {
        ...source,
        id: branchId,
        question: "更小的表示是否足够 · 分叉",
        status: "paused",
        stage: "scoping",
        end_reason: "",
        parent_id: rid,
        conclusion_record: {},
        forked_from: {
          research_id: rid,
          source_session_id: researchSession,
          sprint_id: "checkpoint",
          number: 2,
          commit: checkpoint,
          change: body.change,
          at,
          question: source.question,
        },
      };
      return route.fulfill({ json: state.child });
    }
    if (path === `/projects/${branchId}/resume`) {
      state.resumes++;
      return route.fulfill({ json: state.child });
    }
    if (path === `/projects/${rid}/merge-options`)
      return route.fulfill({ json: { memory: true, code: true, reason: "" } });
    if (
      path === `/projects/${rid}/merges` ||
      path === `/workspaces/${wid}/merges`
    )
      return route.fulfill({ json: state.records });
    if (path === `/workspaces/${wid}/memory`)
      return route.fulfill({
        json: state.records
          .filter((item) => item.kind === "memory" && item.status === "applied")
          .map((item) => ({
            path: `memory/${rid}.md`,
            research_id: rid,
            title: source.question,
            commit_sha: item.commit_sha,
            updated_at: at,
            text: item.memory_text,
          })),
      });
    if (path === `/projects/${rid}/merge-preview`) {
      const body = route.request().postDataJSON();
      state.previews.push(body);
      const selected = body.paths || files.map((file) => file.path);
      const item: ResearchMerge = {
        id: `merge-${state.previews.length}`,
        kind: body.kind,
        status:
          body.kind === "code" && state.codeConflict ? "conflict" : "preview",
        expected_main_commit: mainCommit,
        expected_source_commit: checkpoint,
        target_location: {
          kind: "local",
          path: "/home/leslie/actual-workspace",
          connection_id: "",
        },
        files:
          body.kind === "code"
            ? files.filter((file) => selected.includes(file.path))
            : [],
        paths: body.kind === "code" ? selected : [`memory/${rid}.md`],
        memory_text:
          body.kind === "memory"
            ? "# 小表示足够\n\n证据：三个种子 0.91、0.92、0.91。"
            : "",
        conflicts:
          body.kind === "code" && state.codeConflict
            ? [
                {
                  path: "train.py",
                  diff: "<<<<<<< main\nold\n=======\nverified result\n>>>>>>> research",
                },
              ]
            : [],
        commit_sha: "",
        error: "",
        created_at: at,
        research_id: rid,
        question: source.question,
      };
      state.records.push(item);
      return route.fulfill({ json: item });
    }
    const mutation = path.match(
      new RegExp(`^/projects/${rid}/merges/([^/]+)/(apply|cancel)$`),
    );
    if (mutation) {
      const item = state.records.find((row) => row.id === mutation[1])!;
      if (mutation[2] === "cancel") {
        state.cancelled.push(item.id);
        item.status = "cancelled";
        return route.fulfill({ json: item });
      }
      state.applies.push(route.request().postDataJSON());
      if (state.staleNext) {
        state.staleNext = false;
        return route.fulfill({
          status: 409,
          json: { detail: "项目代码已变化" },
        });
      }
      item.status = "applied";
      item.commit_sha = mergedCommit;
      base.researches[0].merged = {
        [item.kind]: {
          merge_id: item.id,
          commit_sha: mergedCommit,
          paths: item.paths,
          at,
        },
      };
      base.sessions.find((row) => row.research_id === rid)!.merged = {
        [item.kind]: {
          merge_id: item.id,
          commit_sha: mergedCommit,
          paths: item.paths,
          at,
        },
      };
      base.notes.push({
        id: item.id,
        workspace_id: wid,
        project_id: rid,
        kind: "merged",
        text: "小表示研究成果已合并",
        created_at: at,
        pending: false,
        status: "historical",
      });
      return route.fulfill({ json: item });
    }
    if (path === `/projects/${rid}` || path === `/projects/${branchId}`)
      return route.fulfill({
        json: {
          project: path.endsWith(branchId) ? state.child : source,
          nodes: [],
          sprints: [],
          jobs: [],
          datasets: [],
          docker: { available: true, reason: "" },
          input_needed: "",
          inherited_history: path.endsWith(branchId)
            ? {
                events: [
                  {
                    id: "source-approval",
                    actor: "human",
                    action: "human_decision",
                    node_id: null,
                    sprint_id: null,
                    detail: { approve: true, text: "原批准只属于来源研究" },
                    created_at: at,
                  },
                  {
                    id: "source-msg",
                    actor: "advisor",
                    action: "message",
                    node_id: null,
                    sprint_id: null,
                    detail: { text: "原轮次的证据与建议" },
                    created_at: at,
                  },
                  {
                    id: "source-budget",
                    actor: "system",
                    action: "decision_requested",
                    node_id: null,
                    sprint_id: null,
                    detail: { kind: "budget", reason: "原轮次预算已用完" },
                    created_at: at,
                  },
                ],
                sprints: [],
              }
            : undefined,
        },
      });
    if (path === `/projects/${branchId}/events`)
      return route.fulfill({
        json: [
          {
            id: "child-change",
            actor: "human",
            action: "message",
            detail: { text: state.child?.forked_from?.change },
            node_id: null,
            sprint_id: null,
            created_at: at,
          },
        ],
      });
    return route.fallback();
  });
  await page.goto(`/#research/${rid}`);
  await expect(
    page.getByRole("button", { name: "更多操作", exact: true }),
  ).toBeVisible();
  return state;
}

test("research forks use a real ended checkpoint and keep source history read-only", async ({
  page,
}, testInfo) => {
  const state = await branches(page);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "从此轮分叉", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "从此轮分叉" });
  await expect(dialog.getByRole("radio", { name: /第 1 轮/ })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: /第 3 轮/ })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: /第 2 轮/ })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "创建分叉" })).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "这次换什么" })
    .fill("只改正则强度，固定其他条件");

  await page.screenshot({
    path: testInfo.outputPath("research-fork-preview.png"),
  });
  await dialog.getByRole("button", { name: "创建分叉" }).click();
  await expect(page).toHaveURL(new RegExp(`#research/${branchId}$`));
  expect(state.forks).toHaveLength(1);
  expect(state.forks[0]).toMatchObject({
    sprint_id: "checkpoint",
    expected_commit: checkpoint,
    change: "只改正则强度，固定其他条件",
  });
  expect(state.forks[0].client_id).toMatch(/^[0-9a-f-]{36}$/);
  const origin = page.getByRole("region", { name: "分叉来源" });
  await expect(
    origin.getByRole("link", { name: research.question }),
  ).toHaveAttribute("href", `#research/${rid}`);
  await expect(origin).toContainText(checkpoint.slice(0, 10));
  await expect(origin.getByRole("button", { name: "继续定题" })).toBeVisible();
  await origin.locator("summary").filter({ hasText: "来源历史" }).click();
  await expect(origin).toContainText("原轮次的证据与建议");
  await expect(origin).toContainText("原轮次预算已用完");
  await expect(
    origin.locator("small").filter({ hasText: "系统" }),
  ).toBeVisible();
  await expect(origin.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "开始实验" })).toHaveCount(0);
  expect(state.resumes).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("research-fork-independent.png"),
  });
});

test("memory merge requires an evidence preview and explicit confirmation, then appears in project results", async ({
  page,
}) => {
  const state = await branches(page);
  await page.getByRole("button", { name: "显示研究记录", exact: true }).click();
  await page
    .getByRole("complementary", { name: "研究记录" })
    .getByRole("tab", { name: "变更", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "研究记录" })
    .getByRole("button", { name: "合并到项目", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "合并到项目" });
  await expect(dialog.getByRole("button", { name: "确认合并" })).toBeDisabled();
  await expect(dialog).toContainText("/home/leslie/ORA");
  await expect(dialog.getByTitle("本机", { exact: true })).toHaveText("本机");
  await expect(dialog).not.toContainText("/private/fork-cwd");
  await dialog.getByRole("button", { name: "预览", exact: true }).click();
  await expect(dialog).toContainText("/home/leslie/actual-workspace");
  await expect(dialog).not.toContainText("/private/fork-cwd");
  await expect(dialog).toContainText("三个种子 0.91、0.92、0.91");
  await expect(dialog.getByRole("button", { name: "确认合并" })).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "确认将以上结论与证据写入工作区记忆。" })
    .check();
  await dialog.getByRole("button", { name: "确认合并" }).click();
  await expect(dialog.getByRole("status")).toContainText("已合并");
  expect(state.applies).toEqual([
    { expected_main_commit: mainCommit, expected_source_commit: checkpoint },
  ]);
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.goto(`/#workspaces/${wid}/results`);
  await expect(
    page.getByRole("radio", { name: "成果", exact: true }),
  ).toBeChecked();
  const memory = page
    .locator("details")
    .filter({ has: page.getByText(research.question, { exact: true }) })
    .first();
  await memory.locator("summary").first().click();
  await expect(memory).toContainText("三个种子 0.91、0.92、0.91");
  await page.getByRole("radio", { name: "列表", exact: true }).click();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: new RegExp(research.question) })
      .first(),
  ).toContainText("已合并");
});

test("code merge blocks conflicts, binds selected paths, and requires a refreshed stale preview", async ({
  page,
}, testInfo) => {
  const state = await branches(page);
  state.codeConflict = true;
  await page.getByRole("button", { name: "显示研究记录", exact: true }).click();
  await page
    .getByRole("complementary", { name: "研究记录" })
    .getByRole("tab", { name: "变更", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "研究记录" })
    .getByRole("button", { name: "合并到项目", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "合并到项目" });
  await dialog.getByRole("radio", { name: "代码", exact: true }).click();
  await dialog.getByRole("button", { name: "预览", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "合并冲突" })).toContainText(
    "<<<<<<< main",
  );
  await expect(dialog.getByRole("button", { name: "确认合并" })).toBeDisabled();
  state.codeConflict = false;
  await dialog.getByRole("button", { name: "重新预览", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /docs\/notes.md/ }).uncheck();
  await expect(dialog).toContainText("选择已变更，请更新预览。");
  await expect(dialog.getByRole("button", { name: "确认合并" })).toBeDisabled();
  await dialog.getByRole("button", { name: "重新预览", exact: true }).click();
  await expect
    .poll(() => state.previews.at(-1))
    .toEqual({ kind: "code", paths: ["train.py"] });
  await dialog
    .getByRole("checkbox", { name: "确认将所选代码合并到工作区。" })
    .check();
  state.staleNext = true;
  await dialog.getByRole("button", { name: "确认合并" }).click();
  await expect(dialog).toContainText("预览已过期，请重新预览后确认。");
  await expect(dialog.getByRole("button", { name: "确认合并" })).toBeDisabled();
  await dialog.getByRole("button", { name: "重新预览", exact: true }).click();
  const confirmation = dialog.getByRole("checkbox", {
    name: "确认将所选代码合并到工作区。",
  });
  await expect(confirmation).not.toBeChecked();
  await dialog
    .locator("details")
    .filter({ hasText: "diff --git" })
    .locator("summary")
    .first()
    .click();
  await page.screenshot({
    path: testInfo.outputPath("research-code-selected-preview.png"),
  });
  await confirmation.check();
  await dialog.getByRole("button", { name: "确认合并" }).click();
  await expect(dialog.getByRole("status")).toContainText("已合并");
  expect(state.applies).toHaveLength(2);
  expect(
    state.records.find((item) => item.status === "applied")?.paths,
  ).toEqual(["train.py"]);
  expect(state.cancelled.length).toBeGreaterThanOrEqual(3);
});

test("conversation turns open per-round review in an independent tabbed panel", async ({
  page,
}, testInfo) => {
  await branches(page);
  let undos = 0;
  const turn = {
    id: "checkpoint",
    number: 2,
    role: "executor",
    run_id: "run-checkpoint",
    status: "ended",
    focus_node_id: null,
    summary: "对比结果已保存",
    next_focus: "",
    waiting_on: [],
    tokens: 20,
    created_at: at,
    updated_at: "2026-10-22T08:03:12Z",
    commit_sha: checkpoint,
  };
  const diff = {
    base_commit: mainCommit,
    commit_sha: checkpoint,
    added: 4,
    removed: 1,
    can_undo: true,
    files: [
      {
        path: "train.py",
        added: 4,
        removed: 1,
        diff: "diff --git a/train.py b/train.py\n--- a/train.py\n+++ b/train.py\n@@ -1 +1,4 @@\n-old\n+verified result\n+first\n+second\n+third",
      },
    ],
  };
  await page.route(`**/api/v1/research/projects/${rid}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/undo")) {
      undos++;
      return route.fulfill({ json: { commit_sha: mergedCommit } });
    }
    if (path.endsWith("/changes"))
      return route.fulfill({ json: { ...diff, can_undo: undos === 0 } });
    if (path.endsWith("/runs"))
      return route.fulfill({
        json: [
          {
            id: "run-checkpoint",
            status: "completed",
            response: "对比结果已保存",
            error: "",
            steps: [
              {
                name: "read",
                status: "completed",
                arguments: { path: "train.py" },
                said: "检查训练结果",
              },
            ],
            role: "executor",
            runtime: { execution_seconds: 192 },
            created_at: at,
            updated_at: turn.updated_at,
            sprint_id: turn.id,
          },
        ],
      });
    if (path.endsWith("/events"))
      return route.fulfill({
        json: [
          {
            id: "question",
            actor: "human",
            action: "message",
            detail: { text: "比较两个维度" },
            node_id: null,
            sprint_id: null,
            created_at: at,
          },
          {
            id: "reply",
            actor: "advisor",
            action: "message",
            detail: { text: "对比结果已保存" },
            node_id: null,
            sprint_id: turn.id,
            created_at: turn.updated_at,
          },
        ],
      });
    if (path.endsWith(`/projects/${rid}`))
      return route.fulfill({
        json: {
          project: {
            ...research,
            title: "表示维度对比",
            status: "paused",
            stage: "experiments",
            background: "",
            model_config_id: "model-1",
            budget: {},
            spent: { sprints: 2, tokens: 20, job_seconds: 12 },
            session_id: researchSession,
            workspace_id: wid,
            plan: {
              version: 1,
              hypotheses: [{ title: "小表示足够", kill_if: "精度下降" }],
              datasets: [],
              compute_id: "local",
            },
            conclusion_record: {},
            environment: {},
            created_at: at,
          },
          sprints: [turn],
          nodes: [],
          jobs: [
            {
              id: "experiment-1",
              sprint_id: turn.id,
              node_id: "node",
              command: "python train.py",
              compute_id: "local",
              status: "succeeded",
              metrics: { accuracy: 0.92 },
              config: { tag: "维度对比" },
              started_at: at,
              finished_at: turn.updated_at,
              tracker_url: "",
              points: 0,
            },
          ],
          datasets: [
            { id: "dataset", name: "MNIST", status: "ready", files: [] },
          ],
          docker: { available: true, reason: "" },
          input_needed: "",
        },
      });
    return route.fallback();
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "表示维度对比", exact: true }),
  ).toBeVisible();
  const elapsed = page.getByRole("button", { name: "用时 3:12", exact: true });
  await expect(elapsed).toBeVisible();
  await expect(page.getByText("检查训练结果", { exact: true })).toHaveCount(0);
  await elapsed.click();
  await expect(page.getByText("检查训练结果", { exact: true })).toBeVisible();
  await elapsed.click();
  await expect(page.getByText("对比结果已保存", { exact: true })).toHaveCount(
    1,
  );
  const changes = page.getByRole("article", { name: "改了 1 个文件" });
  await expect(changes).toContainText("+4");
  await expect(changes.getByRole("button", { name: /train.py/ })).toContainText(
    "−1",
  );
  const viewChanges = changes.getByRole("button", {
    name: "审阅",
    exact: true,
  });
  await viewChanges.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "研究记录" });
  await expect(panel.getByRole("tab")).toHaveText(["进度", "变更", "实验"]);
  await expect(
    panel.getByRole("tab", { name: "变更", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator("[data-review-round]")).toHaveAttribute(
    "data-review-round",
    turn.id,
  );
  await expect(
    panel.getByRole("button", { name: "对比基准", exact: true }),
  ).toHaveText("第 2 轮检查点");
  await expect(panel.locator("pre")).toContainText("+verified result");
  await expect(panel.locator('[data-kind="del"]')).toContainText("-old");
  await expect(panel.locator('[data-kind="add"]').first()).toContainText(
    "+verified result",
  );
  await expect(page.getByRole("dialog", { name: "查看变更" })).toHaveCount(0);
  const reviewedFile = panel.locator('details[data-path="train.py"]');
  await reviewedFile.locator("summary").click();
  await expect(reviewedFile).not.toHaveAttribute("open", "");
  await changes.getByRole("button", { name: /train.py/ }).click();
  await expect(reviewedFile).toHaveAttribute("open", "");
  await expect(reviewedFile.locator("summary")).toBeFocused();
  const separator = page.getByRole("separator", {
    name: "调整研究记录宽度",
    exact: true,
  });
  const before = Number(await separator.getAttribute("aria-valuenow"));
  await separator.focus();
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", String(before + 24));
  const main = page.getByTestId("research-conversation");
  const mainBox = (await main.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(Math.round(panelBox.x - mainBox.x - mainBox.width)).toBe(8);
  expect(Math.round(panelBox.y)).toBe(Math.round(mainBox.y));
  const total = page
    .getByRole("heading", { name: "表示维度对比", exact: true })
    .locator("..")
    .getByRole("button", { name: "审阅", exact: true });
  await expect(total).toContainText("+4−1");
  await total.click();
  await expect(panel.locator("[data-review-round]")).toHaveAttribute(
    "data-review-round",
    "",
  );
  await panel.getByRole("button", { name: "对比基准", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "第 2 轮检查点", exact: true })
    .click();
  await panel.getByRole("button", { name: "放弃", exact: true }).click();
  const confirm = page.getByRole("dialog", {
    name: "放弃这轮改动？",
    exact: true,
  });
  expect(undos).toBe(0);
  await confirm.getByRole("button", { name: "放弃", exact: true }).click();
  await expect.poll(() => undos).toBe(1);
  await expect(
    panel.getByRole("button", { name: "放弃", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("tab", { name: "实验", exact: true }).click();
  const experiment = panel.getByRole("button", { name: /train.py/ });
  await expect(experiment).toContainText("accuracy");
  await expect(experiment).toContainText("3m12s");
  expect((await experiment.boundingBox())!.height).toBe(32);
  await page.reload();
  await expect(
    panel.getByRole("tab", { name: "实验", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "显示研究记录", exact: true }).click();
  await expect(
    panel.getByRole("tab", { name: "实验", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: "进度", exact: true }).click();
  await expect(panel).toContainText("小表示足够");
  await expect(panel).toContainText("MNIST");
  await panel.getByRole("tab", { name: "变更", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("conversation-review-zh.png"),
  });
  await page.setViewportSize({ width: 720, height: 900 });
  const overlayBox = (await panel.boundingBox())!;
  const underBox = (await main.boundingBox())!;
  expect(overlayBox.x).toBeLessThan(underBox.x + underBox.width);
  expect(overlayBox.x + overlayBox.width).toBeLessThanOrEqual(720);
  await expect(separator).toBeHidden();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 720);
  await page.screenshot({
    path: testInfo.outputPath("conversation-review-narrow-zh.png"),
  });
});

test("switching conversations draws a skeleton before a delayed detail response", async ({
  page,
}) => {
  await project(page);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/research/projects/${rid}`, async (route) => {
    await wait;
    return route.fallback();
  });
  await page.goto(`/#research/${rid}`);
  await expect(page.locator('[class*="threadSkeleton"]')).toBeVisible();
  release();
  await expect(
    page.getByRole("heading", { name: research.question, exact: true }),
  ).toBeVisible();
  await expect(page.locator('[class*="threadSkeleton"]')).toHaveCount(0);
});

test("a fresh local app returns from settings to new research", async ({
  page,
}) => {
  await project(page);
  await page.goto("/");
  await expect(page.getByTestId("new-research")).toBeVisible();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(page).toHaveURL(/#new$/);
  await expect(page.getByTestId("new-research")).toBeVisible();
  await page.getByRole("link", { name: "资料", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(
    page
      .getByRole("navigation", { name: "侧栏", exact: true })
      .getByRole("link", { name: "首页", exact: true }),
  ).toHaveCount(0);
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: plan shortcut follows visibility and card actions work from the keyboard`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    await page.setViewportSize({ width: 720, height: 800 });
    await project(page);
    let approved = false;
    let accepted = false;
    const plan = {
      version: 1,
      question: "MNIST: AdamW vs SGD",
      summary: "比较三个随机种子",
      hypotheses: [{ title: "AdamW 更稳定", kill_if: "方差没有降低" }],
      datasets: [],
      compute_id: "host",
    };
    await page.route(`**/api/v1/research/projects/${rid}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/plan/approve")) {
        approved = true;
        return route.fulfill({ json: {} });
      }
      if (path.endsWith("/decisions/conclusion")) {
        accepted = route.request().postDataJSON().approve;
        return route.fulfill({ json: {} });
      }
      if (path.endsWith("/runs")) return route.fulfill({ json: [] });
      if (path.endsWith("/events"))
        return route.fulfill({
          json: [
            {
              id: "plan",
              actor: "advisor",
              action: "plan_proposed",
              detail: { plan },
              created_at: at,
            },
            ...Array.from({ length: 30 }, (_, i) => ({
              id: `message-${i}`,
              actor: "human",
              action: "message",
              detail: {
                text: `Follow-up ${i}: keep all seeds and the baseline fixed.`,
              },
              created_at: at,
            })),
            ...(approved
              ? [
                  {
                    id: "conclusion",
                    actor: "advisor",
                    action: "decision_requested",
                    detail: {
                      kind: "conclusion",
                      reason: "AdamW has lower variance.",
                      status: "concluded",
                    },
                    created_at: at,
                  },
                ]
              : []),
          ],
        });
      if (path.endsWith(`/projects/${rid}`))
        return route.fulfill({
          json: {
            project: {
              ...research,
              id: rid,
              title: "MNIST 优化器对比",
              status: "waiting",
              stage: approved ? "conclusion" : "scoping",
              background: "",
              model_config_id: "model-1",
              budget: {},
              spent: {},
              session_id: researchSession,
              workspace_id: wid,
              plan: { ...plan, approved_at: approved ? at : undefined },
              conclusion_record: {},
              environment: {},
              created_at: at,
            },
            nodes: [],
            sprints: [],
            jobs: [],
            datasets: [],
            docker: { available: true, reason: "" },
            input_needed: "",
          },
        });
      return route.fallback();
    });
    await page.goto(`/#research/${rid}`);
    const view = page.getByRole("button", {
      name: locale === "zh" ? "查看计划" : "View plan",
      exact: true,
    });
    await expect(view).toBeVisible();
    await expect(
      page.getByText("计划已准备好，确认后才会开始执行。", { exact: true }),
    ).toHaveCount(0);
    await view.focus();
    await page.keyboard.press("Enter");
    const card = page.getByRole("article", {
      name: locale === "zh" ? "研究计划" : "Research plan",
      exact: true,
    });
    await expect(card).toBeInViewport();
    await expect(view).toHaveCount(0);
    const start = card.getByRole("button", {
      name: locale === "zh" ? "开始实验" : "Start experiments",
      exact: true,
    });
    expect(await start.evaluate((element) => element.tagName)).toBe("BUTTON");
    await start.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(start).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => approved).toBe(true);
    const accept = page.getByRole("button", {
      name: locale === "zh" ? "接受结论" : "Accept conclusion",
      exact: true,
    });
    await expect(accept).toBeEnabled();
    await accept.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(accept).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => accepted).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
