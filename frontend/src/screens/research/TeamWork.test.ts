import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseAppRoute } from "../../app/routes";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { AttentionLine, TeamWorkView } from "./TeamWork";
import { teamHash, type Team } from "./team-api";
import {
  workGroups,
  type AttentionMetrics,
  type TeamWork,
} from "./team-work-api";

const wid = "10000000-0000-4000-8000-000000000001";
const cid = "10000000-0000-4000-8000-000000000002";
const stats: AttentionMetrics = {
  asks: 2,
  pending: 1,
  median_wait_seconds: 60,
  waiting_seconds: 120,
  total_seconds: 240,
  waiting_share: 0.5,
  partial: false,
};
const team: Team = {
  workspace_id: wid,
  channels: [],
  notifications: [],
  members: [
    {
      id: "writer",
      name: "Ada",
      role: "custom",
      status: "idle",
      active_run_id: null,
    },
  ],
};
const work: TeamWork = {
  generated_at: "2026-10-24T12:00:00Z",
  counts: { waiting: 1, review: 1, working: 1, queued: 1, done: 1 },
  attention: {
    total: stats,
    members: { writer: stats },
    researches: [{ ...stats, research_id: "r", title: "Research R" }],
  },
  items: [...workGroups].reverse().map((group) => ({
    id: group,
    channel_id: cid,
    thread_id: `thread-${group}`,
    research_id: null,
    title: `Topic ${group}`,
    group,
    status: group,
    member_ids: ["writer"],
    current_step:
      group === "working"
        ? { name: "read", arguments: { path: "draft.md" }, status: "running" }
        : null,
    elapsed_seconds: 120,
    stuck: group === "waiting" ? ["owner_wait"] : [],
  })),
};

describe("team work projection view", () => {
  it("routes work and keeps thread links encoded", () => {
    expect(parseAppRoute(teamHash(wid, "work"))).toEqual({
      screen: "team",
      workspaceId: wid,
      channelId: "work",
      threadId: undefined,
      full: false,
    });
    expect(parseAppRoute(teamHash(wid, cid, "research:a/b"))).toMatchObject({
      threadId: "research:a/b",
    });
  });
  for (const locale of ["zh", "en"] as const) {
    const { t, tn } = createTranslator(locale);
    const render = (value = work) =>
      renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(TeamWorkView, { team, work: value, go() {} }),
        }),
      );
    it(`${locale} groups by priority, collapses completed work and links each conversation`, () => {
      const html = render();
      let previous = -1;
      for (const group of workGroups) {
        const index = html.indexOf(`Topic ${group}`);
        expect(index).toBeGreaterThan(previous);
        previous = index;
        expect(html).toContain(tn(`team.work.group.${group}`, 1));
        expect(html).toContain(
          `href="#${teamHash(wid, cid, `thread-${group}`)}"`,
        );
      }
      expect(html).toMatch(
        /<details[^>]*><summary>[^<]+<\/summary><ul><li><a[^>]*thread-done/,
      );
      expect(html).not.toMatch(/<details[^>]*\bopen/);
      expect(html).toContain(tn("team.work.headline", 1));
      expect(html).toContain(t("team.work.stuck"));
      expect(html).toContain("draft.md");
      expect(html).toContain('title="Ada"');
      expect(html).toContain("Research R");
      expect(html).toContain(tn("team.work.asks", 2));
      expect(html).not.toContain(t("team.work.partial"));
    });
    it(`${locale} shows zero waits and marks incomplete metrics without inventing zero durations`, () => {
      expect(
        render({ ...work, counts: { ...work.counts, waiting: 0 }, items: [] }),
      ).toContain(t("team.work.clear"));
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(AttentionLine, {
            value: {
              ...stats,
              asks: 1,
              median_wait_seconds: null,
              waiting_share: null,
              partial: true,
            },
          }),
        }),
      );
      expect(html).toContain(tn("team.work.asks", 1));
      expect(html).toContain(t("team.work.partial"));
      expect(html).toContain(t("team.work.median", { value: "—" }));
      expect(html).toContain(t("team.work.share", { value: "—" }));
    });
  }
});
