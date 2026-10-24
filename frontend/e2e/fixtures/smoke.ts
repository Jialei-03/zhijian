import { expect, type Page } from "@playwright/test";
import type {
  NavigationWorkspace,
  ResearchCollection,
} from "../../src/screens/research/navigation-api";
import type { ResearchProject } from "../../src/screens/research/research-api";
import type {
  TeamMember,
  TeamMessage,
} from "../../src/screens/research/team-api";
import type { ScheduleDetail } from "../../src/screens/schedules/schedules-api";
import type { Workflow } from "../../src/screens/team/workflow/workflow-model";
import { createPaperWithPdf, who } from "../reader/fixtures";
import { testPdf } from "./pdf";
import { advisorDM, experiments, mockTeam } from "./team";

const at = "2026-10-24T08:00:00Z";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const researchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const collectionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const memberId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const scheduleId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/**
 * Like mockTeam, research lives in an in-memory API: the shared E2E server is
 * hosted and deliberately rejects local research. Login, papers and PDF upload
 * use the real disposable backend. No runtime, shell, SSH or model is started.
 */
export async function seedSmokeData(page: Page) {
  let workspace: NavigationWorkspace | undefined;
  let collection: ResearchCollection | undefined;
  let project: ResearchProject | undefined;
  let schedule: ScheduleDetail | undefined;
  let seeding = true;
  const members: TeamMember[] = [
    {
      id: "human",
      name: "研究者",
      role: "human",
      status: "idle",
      active_run_id: null,
    },
  ];
  const messages: TeamMessage[] = [];
  const workflow: Workflow = {
    id: "smoke-workflow",
    name: "冒烟工作流",
    builtin: false,
    version: 1,
    rules: [
      {
        id: "smoke-rule",
        enabled: true,
        when: { event: "message", from_member: memberId },
        then: { action: "post", channel: experiments, text: "已归档" },
      },
    ],
    layout: { members: {}, channels: {} },
  };
  const channels = () =>
    [
      {
        id: experiments,
        key: "experiments",
        name: "冒烟频道",
        member_id: null,
      },
      {
        id: advisorDM,
        key: "dm:advisor",
        name: "冒烟成员",
        member_id: memberId,
      },
    ].map((channel) => {
      const last = messages
        .filter(
          (message) => message.channel_id === channel.id && !message.thread_id,
        )
        .at(-1);
      return {
        ...channel,
        unread: 0,
        last_at: at,
        last_message: last
          ? {
              author_id: last.author_id,
              author_name: "研究者",
              text: last.text,
              created_at: at,
            }
          : null,
        working_member_ids: [],
      };
    });
  const researches = () =>
    project
      ? [
          {
            ...project,
            title: project.title!,
            column: "done" as const,
            rounds: 1,
            best: null,
            working: "",
            waiting: 0,
            collection_id: collectionId,
            on_board: true,
            pinned_at: null,
          },
        ]
      : [];

  await mockTeam(page, {
    researches,
    team: () => ({
      members,
      channels: channels(),
      workflow,
      budget: { max_tokens: 0, period_hours: 24, max_concurrent: 0 },
      tokens: 0,
    }),
    messages: (channel, thread) =>
      messages.filter(
        (message) =>
          message.channel_id === channel && message.thread_id === thread,
      ),
  });
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({ json: { status: "ok", mode: "local", version: "smoke" } }),
  );
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        active_id: "offline",
        configured: true,
        models: [
          {
            id: "offline",
            name: "Offline",
            model: "offline",
            protocol: "openai",
            base_url: "http://127.0.0.1:1/v1",
          },
        ],
        allowed_hosts: ["127.0.0.1"],
      },
    }),
  );
  await page.route("**/api/v1/cloud-link", (route) =>
    route.fulfill({ json: { connected: false, sync: {} } }),
  );
  for (const engine of ["latex", "layout"]) {
    await page.route(`**/api/v1/${engine}-install`, (route) =>
      route.fulfill({
        json: {
          status: "completed",
          stage: "",
          progress: 100,
          error: "",
          supported: true,
          installed: true,
          available: true,
        },
      }),
    );
  }
  await page.route("**/api/v1/research/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice("/api/v1/research".length);
    const method = request.method();
    const reply = (json: unknown) => route.fulfill({ json });
    // Construct the in-memory research records through the same transport as the UI.
    if (seeding && method === "POST") {
      const body = request.postDataJSON();
      if (path === "/workspaces") {
        workspace = {
          ...body,
          id: workspaceId,
          description: "",
          instructions: "# 冒烟项目",
          kind: "research",
          compute_id: "host",
          model_config_id: "offline",
          archived: false,
          created_at: at,
          updated_at: at,
          researches: [],
        };
        return reply(workspace);
      }
      if (path === "/collections") {
        collection = {
          ...body,
          id: collectionId,
          archived: false,
          description: "",
          research_ids: [researchId],
        };
        return reply(collection);
      }
      if (path.endsWith("/team/members")) {
        const member: TeamMember = {
          id: memberId,
          role: "advisor",
          name: body.config.name,
          description: "核对冒烟测试",
          role_description: "# 冒烟成员",
          enabled: true,
          status: "idle",
          active_run_id: null,
          model_config_id: "",
          subscriptions: [],
          tokens: 0,
        };
        members.push(member);
        return reply(member);
      }
      if (path.endsWith("/team/channels")) return reply(channels()[0]);
      if (path.endsWith("/messages")) {
        const message: TeamMessage = {
          ...body,
          id: crypto.randomUUID(),
          channel_id: path.split("/")[5],
          thread_id: body.thread_id || null,
          author_id: "human",
          kind: "text",
          mentions: [],
          data: {},
          created_at: at,
          replies: 0,
        };
        messages.push(message);
        if (message.thread_id)
          messages.find((root) => root.id === message.thread_id)!.replies++;
        return reply(message);
      }
      if (path === "/projects") {
        project = {
          ...body,
          id: researchId,
          title: "冒烟研究",
          status: "finished",
          stage: "done",
          end_reason: "concluded",
          background: "",
          session_id: researchId,
          model_config_id: "offline",
          compute_id: "host",
          budget: {
            max_sprints: null,
            max_tokens: null,
            max_job_seconds: null,
          },
          spent: { sprints: 1, tokens: 0, job_seconds: 0 },
          plan: {},
          conclusion_record: {},
          environment: {},
          created_at: at,
          updated_at: at,
        };
        return reply(project);
      }
      if (path === "/schedules") {
        schedule = {
          ...body,
          id: scheduleId,
          next_run_at: at,
          created_at: at,
          updated_at: at,
          runs: [],
        };
        return reply(schedule);
      }
    }
    // Reading indicators are UI bookkeeping, not model work.
    if (method === "POST" && path.endsWith("/read"))
      return reply({ ok: true, read_at: at });
    // Machines checks the host on mount. Keep that probe in the fixture too.
    if (method === "POST" && path === "/environments/host/check")
      return reply({ status: "connected", checked_at: at });
    if (method === "GET") {
      if (path === "/navigation")
        return reply({
          workspaces: workspace
            ? [{ ...workspace, researches: researches() }]
            : [],
          collections: collection ? [collection] : [],
        });
      if (path === "/workspaces") return reply(workspace ? [workspace] : []);
      if (path === `/workspaces/${workspaceId}`)
        return reply({ ...workspace, researches: researches() });
      if (path === "/collections") return reply(collection ? [collection] : []);
      if (path === "/projects") return reply(project ? [project] : []);
      if (path === `/projects/${researchId}`)
        return reply({
          project,
          nodes: [],
          sprints: [],
          jobs: [],
          datasets: [],
          docker: { available: false, reason: "offline" },
          input_needed: "",
        });
      if (path === `/projects/${researchId}/workspace/list`)
        return reply({
          path: url.searchParams.get("path") || "",
          entries: [],
          truncated: false,
          round: null,
          changed: [],
          compute: "host",
        });
      if (path === "/settings")
        return reply({
          computes: [{ id: "host", kind: "host", name: "本机" }],
          default_compute: "host",
          states: {},
          tracker: {
            kind: "swanlab",
            mode: "local",
            project: "smoke",
            has_key: false,
          },
        });
      if (path === "/playbook")
        return reply({
          version: 1,
          rules: [
            {
              id: "smoke-playbook",
              when: "发现新论文",
              do: "核对来源",
              why: "",
              sources: [],
              helpful: 0,
              harmful: 0,
              status: "active",
              created_at: at,
            },
          ],
          history: [],
        });
      if (path === "/roles")
        return reply([{ id: "research-advisor", title: "导师" }]);
      if (path === "/roles/research-advisor")
        return reply({
          id: "research-advisor",
          title: "导师",
          body: "# 冒烟角色",
        });
      if (path === "/workflows") return reply([workflow]);
      if (path === "/folders")
        return reply({
          path: "/smoke",
          parent: null,
          entries: [],
          project_error: "",
        });
      if (path === "/schedules") return reply(schedule ? [schedule] : []);
      if (path === `/schedules/${scheduleId}`) return reply(schedule);
      if (path === "/compare")
        return reply({
          threads: project
            ? [
                {
                  id: researchId,
                  title: project.title,
                  workflow: workflow.name,
                  status: "finished",
                  conclusion: "离线核对完成",
                  numbers: [],
                  tokens: 0,
                  job_seconds: 0,
                  elapsed_seconds: 1,
                  rounds: 1,
                  members: [],
                },
              ]
            : [],
        });
      if (path.endsWith(`/team/members/${memberId}`))
        return reply({ ...members[1], activity: "", threads: [] });
      if (path.endsWith("/team/library")) return reply([]);
      if (path.endsWith("/team/activity")) return reply([]);
      if (path.endsWith("/team/saved")) return reply([]);
      if (path.endsWith("/team/workflow")) return reply(workflow);
      if (path.includes("/team")) return route.fallback();
      if (path.endsWith("/events"))
        return reply([
          {
            id: "smoke-event",
            action: "message",
            actor: "human",
            detail: { text: "冒烟研究记录" },
            created_at: at,
            sprint_id: null,
            node_id: null,
          },
        ]);
      if (path.endsWith("/forks/options"))
        return reply({ can_fork: false, reason: "", rounds: [] });
      if (path.endsWith("/changes"))
        return reply({ files: [], added: 0, removed: 0 });
      if (path.endsWith("/sessions"))
        return reply({ items: [], next_cursor: null });
      if (
        ["/connections", "/ssh-hosts", "/recent"].includes(path) ||
        /\/(runs|notes|memory|merges|files|decisions)$/.test(path)
      )
        return reply([]);
    }
    return route.fallback();
  });
  // Catch accidental model/translation execution even when a new button is added.
  await page.route("**/api/v1/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (
      route.request().method() === "POST" &&
      /\/(agent\/runs|translations|papers\/[^/]+\/(reading-artifacts|preparation)|translation-settings\/configs\/[^/]+\/test)(\/|$)/.test(
        pathname,
      )
    ) {
      return route.fulfill({
        status: 501,
        json: { detail: "Smoke tests never run models" },
      });
    }
    return route.fallback();
  });

  // Authenticate before opening the app, so its first /auth/me succeeds and
  // every browser console.error (including HTTP resource errors) stays fatal.
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: who("alice"), password: process.env.E2E_TEST_PASSWORD! },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto("/#new");
  await expect(page.getByRole("navigation")).toBeVisible();
  // Seed through fetch so the same mocked API transport as the UI is exercised.
  // APIRequestContext bypasses page.route; login and PDF upload use the local backend.
  const threadId = await page.evaluate(
    async ({ workspaceId, collectionId, memberId, experiments, advisorDM }) => {
      const csrf = document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith("paper_csrf="))!
        .split("=")[1];
      const post = async (path: string, data: unknown) => {
        const response = await fetch(`/api/v1/research${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(data),
        });
        if (!response.ok)
          throw new Error(
            `${path}: ${response.status} ${await response.text()}`,
          );
        return response.json();
      };
      await post("/workspaces", {
        name: "冒烟项目",
        location: { kind: "managed", path: "", connection_id: "" },
      });
      await post("/collections", { name: "冒烟分组" });
      await post(`/workspaces/${workspaceId}/team/members`, {
        config: { name: "冒烟成员" },
      });
      await post(`/workspaces/${workspaceId}/team/channels`, {
        name: "冒烟频道",
      });
      const message = (channel: string, text: string, thread_id?: string) =>
        post(`/workspaces/${workspaceId}/team/channels/${channel}/messages`, {
          text,
          thread_id,
          mode: "queue",
          client_id: crypto.randomUUID(),
        });
      const root = await message(experiments, "冒烟频道根消息");
      await message(experiments, "冒烟频道第二条消息");
      await message(experiments, "冒烟频道第三条消息");
      await message(experiments, "冒烟线程回复", root.id);
      for (const text of ["冒烟私信第一条", "冒烟私信第二条", "冒烟私信第三条"])
        await message(advisorDM, text);
      await post("/projects", {
        question: "核对离线研究页面",
        workspace_id: workspaceId,
        collection_id: collectionId,
      });
      await post("/schedules", {
        title: "冒烟定时任务",
        prompt: "离线核对",
        workspace_id: workspaceId,
        destination: "new",
        research_id: null,
        workflow_id: "smoke-workflow",
        frequency: "daily",
        local_time: "09:00",
        weekday: 1,
        interval_hours: 24,
        timezone: "Asia/Singapore",
        paused: true,
      });
      return root.id as string;
    },
    { workspaceId, collectionId, memberId, experiments, advisorDM },
  );
  seeding = false;
  const paper = await createPaperWithPdf(page, {
    title: `冒烟论文 ${crypto.randomUUID().slice(0, 8)}`,
    buffer: testPdf(),
  });
  // Start a fresh app read after constructing navigation and paper data.
  await page.reload();
  expect(
    messages.filter((message) => message.channel_id === advisorDM),
  ).toHaveLength(3);
  return {
    edition: "local" as "local" | "cloud",
    workspaceId,
    researchId,
    collectionId,
    memberId,
    scheduleId,
    threadId,
    paper,
  };
}

export type SmokeData = Awaited<ReturnType<typeof seedSmokeData>>;
