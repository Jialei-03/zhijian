import type { Page } from "@playwright/test";
import type { Team, TeamMessage } from "../../src/screens/research/team-api";

export const experiments = "eeeeeeee-eeee-4eee-8eee-000000000001";
export const advisorDM = "eeeeeeee-eeee-4eee-8eee-000000000002";

/** Mock only the team transport, leaving project details and writes to each spec. */
export async function mockTeam(
  page: Page,
  options: {
    researches?: (workspace: string) => {
      id: string;
      question: string;
      title?: string;
      updated_at?: string;
      status?: string;
      unread?: boolean;
      archived_at?: string | null;
    }[];
    history?: () => TeamMessage[];
    team?: () => Partial<Team>;
    messages?: (channel: string, thread: string | null) => TeamMessage[];
  } = {},
) {
  await page.route("**/api/v1/research/workspaces/*/team**", (route) => {
    const url = new URL(route.request().url());
    const workspace = url.pathname.split("/")[5];
    const roots: TeamMessage[] = (options.researches?.(workspace) || [])
      .filter((r) => !r.archived_at)
      .map((r) => ({
        id: `research:${r.id}`,
        channel_id: experiments,
        thread_id: null,
        author_id: "human",
        text: r.title || r.question,
        kind: "research",
        mentions: [],
        data: { research_id: r.id, title: r.title || r.question },
        created_at: r.updated_at || "2026-10-23T00:00:00Z",
        replies: 1,
      }));
    if (url.pathname.endsWith("/team")) {
      const team: Team = {
        workspace_id: workspace,
        members: [
          "human",
          "advisor",
          "executor",
          "librarian",
          "reviewer",
          "writer",
          "distiller",
        ].map((role) => ({
          id: role,
          name: role,
          role,
          status:
            role === "advisor" &&
            options.researches?.(workspace).some((r) => r.status === "waiting")
              ? "waiting"
              : "idle",
          active_run_id: null,
        })),
        channels: [
          {
            id: experiments,
            key: "experiments",
            name: "实验",
            member_id: null,
            unread: 0,
            last_message: null,
            last_at: "2026-10-23T00:00:00Z",
            working_member_ids: [],
          },
          {
            id: advisorDM,
            key: "dm:advisor",
            name: "导师",
            member_id: "advisor",
            unread: 0,
            last_message: null,
            last_at: "2026-10-23T00:00:00Z",
            working_member_ids: [],
          },
        ],
        notifications: [],
        ...options.team?.(),
      };
      return route.fulfill({ json: team });
    }
    if (url.pathname.endsWith("/messages")) {
      const thread = url.searchParams.get("thread_id");
      return route.fulfill({
        json: {
          messages: options.messages
            ? options.messages(url.pathname.split("/")[8], thread)
            : thread
              ? []
              : url.pathname.includes(advisorDM)
                ? options.history?.() || []
                : roots,
          root:
            roots.find((r) => r.id === thread) ||
            options
              .messages?.(url.pathname.split("/")[8], null)
              .find((r) => r.id === thread) ||
            null,
          research_id: thread?.startsWith("research:") ? thread.slice(9) : null,
        },
      });
    }
    if (url.pathname.endsWith("/read"))
      return route.fulfill({ json: { ok: true } });
    if (url.pathname.endsWith("/threads"))
      return route.fulfill({
        json: options.messages
          ? options
              .messages(experiments, null)
              .filter((message) => message.replies)
          : roots,
      });
    if (url.pathname.endsWith("/deliveries"))
      return route.fulfill({ json: [] });
    if (url.pathname.endsWith("/team/work")) {
      const none = {
        asks: 0,
        pending: 0,
        median_wait_seconds: null,
        waiting_seconds: 0,
        total_seconds: 0,
        waiting_share: null,
        partial: false,
      };
      return route.fulfill({
        json: {
          generated_at: new Date().toISOString(),
          items: [],
          counts: { waiting: 0, review: 0, working: 0, queued: 0, done: 0 },
          attention: { total: none, researches: [], members: {} },
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { detail: "Unexpected team request" },
    });
  });
}
