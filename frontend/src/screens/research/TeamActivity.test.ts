import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { ActivityRow, SavedMessageRow, ThreadRow } from "./TeamActivity";
import type { Team, TeamActivity, TeamMessage } from "./team-api";

const team: Team = {
  workspace_id: "team",
  notifications: [],
  members: ["Ada", "Lin", "Sam", "Jo"].map((name) => ({
    id: name,
    role: "custom",
    name,
    status: "idle",
    active_run_id: null,
    avatar_url: `/${name}.png`,
  })),
  channels: [
    {
      id: "channel",
      key: "experiments",
      name: "实验",
      member_id: null,
      unread: 1,
    },
    { id: "direct", key: "dm:Ada", name: "Ada", member_id: "Ada", unread: 0 },
  ],
};
const message: TeamMessage = {
  id: "root",
  channel_id: "channel",
  thread_id: null,
  author_id: "Ada",
  text: "Root summary",
  kind: "text",
  mentions: [],
  data: {},
  created_at: "2026-10-23T10:00:00Z",
  last_message_at: "2026-10-24T11:00:00Z",
  replies: 4,
  participant_ids: ["Lin", "Sam", "Jo", "Ada"],
  unread: 2,
};
describe("team inbox rows", () => {
  for (const locale of ["zh", "en"] as const) {
    const { t, tn } = createTranslator(locale);
    const render = (children: ReturnType<typeof createElement>) =>
      renderToStaticMarkup(createElement(I18nProvider, { locale, children }));
    it(`${locale} shows activity actor, source, action, summary, time and unread state`, () => {
      for (const kind of [
        "mention",
        "reply",
        "completed",
        "waiting",
        "budget",
        "limit",
        "paused",
        "reminder",
      ] as const) {
        const event: TeamActivity = {
          ...message,
          unread: true,
          actor_id: "Ada",
          activity_type: kind,
          activity_types: [kind],
          data: kind === "paused" ? { paused_member: "Ada" } : message.data,
        };
        const html = render(
          createElement(ActivityRow, { team, event, open() {} }),
        );
        expect(html).toContain(
          t("team.activity.event", {
            name: "Ada",
            channel: locale === "zh" ? "#实验" : "#Experiments",
            action: t(`team.activity.${kind}`),
          }),
        );
        expect(html).toContain('src="/Ada.png"');
        expect(html).toContain(
          kind === "paused"
            ? t("team.memberPaused", { name: "Ada" })
            : "Root summary",
        );
        expect(html).toContain(`dateTime="${event.created_at}"`);
        expect(html).toContain('data-unread="true"');
        const read = render(
          createElement(ActivityRow, {
            team,
            event: { ...event, unread: false },
            open() {},
          }),
        );
        expect(read).not.toContain("data-unread");
      }
    });
    it(`${locale} shows thread origin, root author, three participants, replies and last reply time`, () => {
      const html = render(
        createElement(ThreadRow, { team, message, open() {} }),
      );
      expect(html).toContain(locale === "zh" ? "#实验" : "#Experiments");
      expect(html).toContain("Root summary");
      expect(html).toContain('aria-label="Lin, Sam, Jo"');
      expect(html.match(/<img /g)).toHaveLength(4);
      expect(html).toContain(tn("team.replies", 4));
      expect(html).toContain(`dateTime="${message.last_message_at}"`);
      expect(html).toContain('data-unread="true"');
      const direct = render(
        createElement(ThreadRow, {
          team,
          message: { ...message, channel_id: "direct", unread: 0 },
          open() {},
        }),
      );
      expect(direct).not.toContain("#实验");
      expect(direct).not.toContain("data-unread");
      expect(direct.match(/<img /g)).toHaveLength(5);
      expect(direct).toContain("Ada");
    });
    it(`${locale} lists saved messages with completion and removal actions`, () => {
      for (const completed of [false, true]) {
        const html = render(
          createElement(SavedMessageRow, {
            team,
            message: { ...message, completed, saved_at: message.created_at },
            open() {},
            async change() {},
          }),
        );
        expect(html).toContain('data-saved-id="root"');
        expect(html).toContain("Root summary");
        expect(html).toContain(
          t(completed ? "team.later.reopen" : "team.later.complete"),
        );
        expect(html).toContain(t("team.later.remove"));
        expect(html.includes('data-completed="true"')).toBe(completed);
        expect(html.includes(t("team.later.completed"))).toBe(completed);
        expect(html).not.toContain("data-unread");
      }
    });
  }
});
