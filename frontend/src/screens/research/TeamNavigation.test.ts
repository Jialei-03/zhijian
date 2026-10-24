import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { TeamConversationList } from "./TeamNavigation";
import type { Team, TeamChannel } from "./team-api";

const channel = (
  id: string,
  member: string | null,
  at: string,
): TeamChannel => ({
  id,
  key: id,
  name: id,
  member_id: member,
  unread: 0,
  last_at: at,
  last_message: {
    author_id: member,
    author_name: "System",
    text: `Preview ${id}`,
    created_at: at,
  },
  working_member_ids: [],
});
const newChannel = "10000000-0000-4000-8000-000000000001";
const team: Team = {
  workspace_id: "workspace",
  members: Array.from({ length: 8 }, (_, index) => ({
    id: `member-${index}`,
    role: "custom",
    name: `Member ${index}`,
    avatar_color: "amber",
    status: index === 0 ? "working" : "idle",
    active_run_id: null,
    deleted: index === 6,
  })),
  channels: [
    channel("channel-old", null, "2026-10-20T00:00:00Z"),
    ...Array.from({ length: 7 }, (_, index) =>
      channel(`dm-${index}`, `member-${index}`, `2026-10-2${index}T00:00:00Z`),
    ),
    { ...channel("channel-new", null, "2026-10-24T01:00:00Z"), id: newChannel },
    {
      ...channel("empty-dm", "member-7", "2026-10-27T00:00:00Z"),
      last_message: null,
    },
    channel("missing-member", "absent", "2026-10-28T00:00:00Z"),
  ],
  notifications: [],
  threads_unread: 123,
  mentions_unread: 7,
};
const render = (value = team, locale: "zh" | "en" = "zh") =>
  renderToStaticMarkup(
    createElement(I18nProvider, {
      locale,
      children: createElement(TeamConversationList, {
        team: value,
        id: "workspace",
        hash: `team/10000000-0000-4000-8000-000000000002/${newChannel}`,
        go() {},
        onCreate() {},
      }),
    }),
  );

describe("team conversation navigation", () => {
  it("merges channels and DMs by activity and excludes deleted or missing members", () => {
    const html = render();
    const list = html.split('aria-labelledby="team-conversations"')[1];
    expect(
      [...list.matchAll(/href="#team\/workspace\/([^"?]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual([
      "empty-dm",
      "dm-5",
      newChannel,
      "dm-4",
      "dm-3",
      "dm-2",
      "dm-1",
      "channel-old",
      "settings",
    ]);
    expect(html).toContain('aria-label="channel-new" aria-current="page"');
    expect(html).not.toContain("missing-member");
    expect(html).not.toContain("Member 6");
    expect(team.channels[0].id).toBe("channel-old");
  });

  it("keeps current, working and unread conversations beyond the first eight", () => {
    const extra = Array.from({ length: 12 }, (_, index) => ({
      ...channel(
        `extra-${index}`,
        null,
        new Date(Date.UTC(2026, 9, 24, 0, 12 - index)).toISOString(),
      ),
      id: index === 9 ? newChannel : `extra-${index}`,
      unread: index === 11 ? 1 : 0,
      working_member_ids: index === 10 ? ["member-0"] : [],
    }));
    const html = render({ ...team, channels: extra });
    const ids = [
      ...html.matchAll(
        /data-id="conversation" href="#team\/workspace\/([^"?]+)"/g,
      ),
    ].map((match) => match[1]);
    expect(ids).toEqual(
      [...extra.slice(0, 8), ...extra.slice(9)].map((row) => row.id),
    );
    expect(html).not.toContain('href="#team/workspace/extra-8"');
  });

  for (const locale of ["zh", "en"] as const) {
    it(`${locale} shows paused status even while existing work continues`, () => {
      const { t } = createTranslator(locale);
      const html = render(
        { ...team, members: team.members.map((m) => ({ ...m, paused: true })) },
        locale,
      );
      expect(html).toContain('data-status="paused"');
      expect(html).toContain(t("team.status.paused"));
    });
    it(`${locale} has fixed navigation and no duplicate member shortcuts`, () => {
      const html = render(team, locale);
      for (const id of ["threads", "activity", "work", "team-settings"])
        expect(html).toContain(`data-id="${id}"`);
      expect(html).not.toContain('aria-label="常用成员"');
      expect(html).not.toContain('aria-label="Frequent members"');
      expect((html.match(/href="#team\/workspace\/dm-5"/g) || []).length).toBe(
        1,
      );
      expect(html).toContain('data-id="messages-more"');
      expect(html).toContain(locale === "zh" ? "再显示 1 个" : "Show 1 more");
      expect(render({ ...team, channels: [] }, locale)).toContain(
        'data-id="threads"',
      );
    });

    it(`${locale} shows per-conversation work and numeric unread badges`, () => {
      const { t } = createTranslator(locale);
      const html = render(
        {
          ...team,
          channels: team.channels.map((c) =>
            c.id === newChannel
              ? { ...c, unread: 42, working_member_ids: ["member-0"] }
              : c.id === "dm-0"
                ? { ...c, unread: 1 }
                : c,
          ),
        },
        locale,
      );
      expect(html).toContain(
        t("team.colleague.working", {
          task: t("team.colleague.thinking"),
          elapsed: t("reader.assistant.duration.seconds", { seconds: 0 }),
        }),
      );
      expect(html).not.toContain("Preview channel-new");
      expect(html).not.toContain("Preview dm-0");
      for (const count of [123, 7, 42])
        expect(html).toContain(
          `aria-label="${locale === "zh" ? `${count} 条未读` : `${count} unread`}">${count}</span>`,
        );
      expect(html).toContain('data-status="working"');
      expect(html).toContain('aria-label="channel-new"');
      expect(html).toContain(locale === "zh" ? "消息" : "Messages");
      expect(html).toContain(
        locale === "zh"
          ? 'aria-label="新建频道"'
          : 'aria-label="Create channel"',
      );
      const activity = render({ ...team, activity_unread: 19 }, locale);
      expect(activity).toContain(t("team.activity"));
      expect(activity).toContain(
        `aria-label="${t("team.unreadCount", { count: 19 })}">19</span>`,
      );
      expect(activity).not.toContain(
        `aria-label="${t("team.unreadCount", { count: 7 })}">7</span>`,
      );
    });
    it(`${locale} shows a working member's status in conversation previews`, () => {
      const html = render(
        {
          ...team,
          members: team.members.map((member) => ({
            ...member,
            status_text: "Checking evidence",
            current_step: {
              name: "read",
              arguments: { path: "trace.md" },
              status: "running",
            },
          })),
          channels: team.channels.map((c) =>
            c.id === newChannel
              ? { ...c, working_member_ids: ["member-0"] }
              : c,
          ),
        },
        locale,
      );
      expect(html).toContain("Checking evidence");
      expect(html).not.toContain("trace.md");
    });
  }
});
