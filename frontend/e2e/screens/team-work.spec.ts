import { expect, test } from "@playwright/test";
import { createTranslator } from "../../src/i18n/i18n";
import type {
  AttentionMetrics,
  TeamWork,
} from "../../src/screens/research/team-work-api";
import type { TeamMessage } from "../../src/screens/research/team-api";
import { experiments, mockTeam } from "../fixtures/team";
import { signIn } from "../reader/fixtures";

test.use({ locale: "zh-CN" });

test("work navigation groups derived work, opens threads and shows member attention", async ({
  page,
}) => {
  const wid = "10000000-0000-4000-8000-000000000001";
  const { t, tn } = createTranslator("zh");
  const attention: AttentionMetrics = {
    asks: 2,
    pending: 1,
    median_wait_seconds: 60,
    waiting_seconds: 120,
    total_seconds: 240,
    waiting_share: 0.5,
    partial: true,
  };
  const member = {
    id: "writer",
    role: "custom",
    name: "Ada",
    status: "idle" as const,
    active_run_id: null,
  };
  const root: TeamMessage = {
    id: "thread-waiting",
    channel_id: experiments,
    thread_id: null,
    author_id: "writer",
    text: "Waiting topic",
    kind: "text",
    mentions: [],
    data: {},
    replies: 1,
    created_at: "2026-10-24T10:00:00Z",
  };
  const work: TeamWork = {
    generated_at: root.created_at,
    counts: { waiting: 1, review: 1, working: 1, queued: 1, done: 1 },
    attention: {
      total: attention,
      members: { writer: attention },
      researches: [],
    },
    items: (["waiting", "review", "working", "queued", "done"] as const).map(
      (group) => ({
        id: group,
        channel_id: experiments,
        thread_id: `thread-${group}`,
        research_id: null,
        title: `${group} topic`,
        group,
        status: group,
        member_ids: ["writer"],
        current_step: null,
        elapsed_seconds: 120,
        stuck: group === "waiting" ? ["owner_wait"] : [],
      }),
    ),
  };
  await page.addInitScript(() => localStorage.setItem("paper-locale", "zh"));
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({ json: { mode: "local" } }),
  );
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        configured: true,
        active_id: "offline",
        models: [{ id: "offline", name: "Offline", model: "Offline" }],
      },
    }),
  );
  await page.route("**/api/v1/research/**", (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/settings"))
      return route.fulfill({ json: { computes: [], states: {} } });
    if (new URL(route.request().url()).pathname.endsWith("/navigation"))
      return route.fulfill({
        json: {
          workspaces: [
            {
              id: wid,
              name: "Team",
              kind: "research",
              archived: false,
              researches: [],
              location: { kind: "managed", path: "", connection_id: "" },
            },
          ],
          collections: [],
        },
      });
    return route.fulfill({ json: [] });
  });
  await mockTeam(page, {
    team: () => ({ members: [member] }),
    messages: (_channel, thread) => (thread ? [] : [root]),
  });
  await page.route("**/team/work", (route) => route.fulfill({ json: work }));
  await page.route("**/team/members/writer", (route) =>
    route.fulfill({
      json: { ...member, activity: "", threads: [], attention },
    }),
  );
  await signIn(page);
  await page.goto(`/#team/${wid}/threads`);
  await page
    .locator('[data-sidebar-place="research"] [data-id="work"]')
    .click();
  const board = page.getByTestId("team-work");
  await expect(board).toBeVisible();
  await expect(
    board.getByRole("heading", { name: tn("team.work.headline", 1) }),
  ).toBeVisible();
  await expect(board).toContainText(tn("team.work.asks", 2));
  await expect(board).toContainText(t("team.work.partial"));
  await expect(board).toContainText(t("team.work.stuck"));
  const done = board
    .locator("details")
    .filter({ hasText: tn("team.work.group.done", 1) });
  await expect(done).not.toHaveAttribute("open");
  await expect(done.getByRole("link")).toBeHidden();
  await done.locator("summary").click();
  await expect(done.getByRole("link")).toBeVisible();
  await board.getByRole("link").filter({ hasText: "waiting topic" }).click();
  await expect(page).toHaveURL(
    new RegExp(`team/${wid}/${experiments}\\?thread=thread-waiting`),
  );
  await page.goto(`/#team/${wid}/settings?thread=member%3Awriter`);
  await expect(page.getByLabel(t("team.work.attention"))).toContainText(
    tn("team.work.asks", 2),
  );
});
