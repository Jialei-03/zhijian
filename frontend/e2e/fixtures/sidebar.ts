import type { Page } from "@playwright/test";
import type { Paper } from "../../src/api";
import type { ResearchNavigation } from "../../src/screens/research/navigation-api";
import type { Team } from "../../src/screens/research/team-api";
import type { SmokeData } from "./smoke";
import { advisorDM, experiments } from "./team";

/** Extend the existing offline smoke transport, without starting a runtime. */
export async function seedSidebarState(page: Page, smoke: SmokeData) {
  const [navigation, team, papers, owner] = (await page.evaluate(
    async (workspace) => {
      const read = async (path: string) =>
        (await fetch(`/api/v1${path}`)).json();
      return Promise.all([
        read("/research/navigation"),
        read(`/research/workspaces/${workspace}/team`),
        read("/papers"),
        read("/auth/me"),
      ]);
    },
    smoke.workspaceId,
  )) as [ResearchNavigation, Team, Paper[], { user: { id: string } }];
  const basePaper = papers.find((paper) => paper.id === smoke.paper.paperId)!;
  const recent = Array.from({ length: 32 }, (_, index) => ({
    ...basePaper,
    id: `sidebar-paper-${index}`,
    title: `侧栏论文 ${index}`,
    external_id: "",
  }));
  const firstWorkspace = navigation.workspaces[0];
  firstWorkspace.researches[0].status = "waiting";
  const otherWorkspace = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
  navigation.workspaces.push({
    ...firstWorkspace,
    id: otherWorkspace,
    name: "另一项目",
    researches: [],
  });
  team.channels = Array.from({ length: 35 }, (_, index) => ({
    id:
      index === 0
        ? advisorDM
        : index === 32
          ? experiments
          : `eeeeeeee-eeee-4eee-8eee-${String(index + 10).padStart(12, "0")}`,
    key: index === 32 ? "experiments" : `sidebar-${index}`,
    name: index === 32 ? "冒烟频道" : `侧栏会话 ${index}`,
    member_id: null,
    unread: index === 34 ? 3 : 0,
    last_at: new Date(Date.UTC(2026, 9, 24, 8, 35 - index)).toISOString(),
    last_message: null,
    working_member_ids: index === 33 ? [smoke.memberId] : [],
  }));
  team.notifications = [
    {
      id: smoke.threadId,
      channel_id: experiments,
      thread_id: null,
      author_id: smoke.memberId,
      text: "冒烟决定",
      kind: "text",
      mentions: [],
      data: { waiting: true },
      created_at: "2026-10-24T09:00:00Z",
      replies: 1,
    },
  ];
  await page.route("**/api/v1/research/navigation", (route) =>
    route.fulfill({ json: navigation }),
  );
  await page.route("**/api/v1/research/workspaces/*/team", (route) => {
    const workspace = new URL(route.request().url()).pathname.split("/")[5];
    return route.fulfill({
      json: {
        ...team,
        workspace_id: workspace,
        notifications:
          workspace === smoke.workspaceId ? team.notifications : [],
      },
    });
  });
  await page.route("**/api/v1/papers", (route) =>
    route.fulfill({ json: [basePaper, ...recent] }),
  );
  await page.route("**/api/v1/papers/sidebar-paper-*/files", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.evaluate(
    ({ owner, papers }) => {
      localStorage.setItem(
        `paper-recent:${owner}`,
        JSON.stringify(
          Object.fromEntries(
            papers.map((paper, index) => [paper.id, Date.now() - index * 1000]),
          ),
        ),
      );
    },
    { owner: owner.user.id, papers: recent },
  );
  return { navigation, team, recent, owner: owner.user.id, otherWorkspace };
}
