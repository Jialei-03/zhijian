import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { MemberPause } from "../team/MemberPause";
import { MemberStatus } from "./TeamNavigation";
import { ActivityRow } from "./TeamActivity";
import { activityTarget, mentionMatches } from "./team-model";
import {
  editTeamMember,
  remindTeamMessage,
  type TeamActivity,
  type TeamMember,
  type TeamMessage,
} from "./team-api";
import {
  localReminderTime,
  reminderTime,
  TeamReminderDialog,
} from "./TeamReminderDialog";
import { notifyTeamReminders } from "./team-reminder-notifications";

const member: TeamMember = {
  id: "ada",
  name: "Ada",
  role: "custom",
  status: "working",
  active_run_id: "run",
  paused: true,
};
const message: TeamMessage = {
  id: "original",
  channel_id: "channel",
  thread_id: "root",
  author_id: "ada",
  kind: "text",
  text: "Evidence summary",
  mentions: [],
  data: {},
  replies: 0,
  created_at: "2026-10-24T10:00:00Z",
};
const reminder: TeamActivity = {
  ...message,
  id: "reminder",
  kind: "reminder",
  data: {
    reminder: {
      message_id: message.id,
      channel_id: message.channel_id,
      thread_id: message.thread_id,
    },
  },
  actor_id: null,
  activity_type: "reminder",
  activity_types: ["reminder"],
  unread: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("member leave and reminders", () => {
  it("keeps paused members available to mention", () => {
    expect(mentionMatches([member], "ada", (m) => m.name)).toEqual([member]);
  });
  it("computes relative delays and tomorrow at local 9 AM across month boundaries", () => {
    const now = new Date(2026, 9, 31, 23, 50);
    expect(reminderTime("minutes", "", now).getTime() - now.getTime()).toBe(
      20 * 60_000,
    );
    expect(reminderTime("hour", "", now).getTime() - now.getTime()).toBe(
      60 * 60_000,
    );
    expect(localReminderTime(reminderTime("morning", "", now))).toBe(
      "2026-11-01T09:00",
    );
    expect(
      localReminderTime(reminderTime("custom", "2027-01-02T08:15", now)),
    ).toBe("2027-01-02T08:15");
    expect(Number.isNaN(reminderTime("custom", "", now).getTime())).toBe(true);
  });
  it("targets the original thread reply and preserves ordinary activity targets", () => {
    expect(activityTarget(reminder)).toEqual({
      id: "original",
      channel_id: "channel",
      thread_id: "root",
    });
    expect(activityTarget(message)).toBe(message);
  });
  it("writes pause state and timezone-aware reminder timestamps through the team transport", async () => {
    vi.stubGlobal("document", { cookie: "" });
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    await editTeamMember("team", "ada", { paused: true });
    await remindTeamMessage("team", message, "2026-10-25T01:00:00.000Z");
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/v1/research/workspaces/team/team/members/ada",
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ paused: true });
    expect(fetch.mock.calls[1][0]).toBe(
      "/api/v1/research/workspaces/team/team/channels/channel/messages/original/reminders",
    );
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      remind_at: "2026-10-25T01:00:00.000Z",
    });
  });
  it("sends only unread reminders through the desktop bridge", () => {
    const notifyReminder = vi.fn();
    vi.stubGlobal("window", { oraDesktop: { notifyReminder } });
    notifyTeamReminders(
      "team",
      [
        message,
        { ...message, kind: "reminder" },
        { ...message, kind: "reminder", data: { read: true } },
      ],
      "Remind me",
    );
    expect(notifyReminder).toHaveBeenCalledExactlyOnceWith({
      id: message.id,
      title: "Remind me",
      body: message.text,
      hash: "team/team/mentions",
    });
    vi.stubGlobal("window", {});
    expect(() =>
      notifyTeamReminders("team", [message], "Remind me"),
    ).not.toThrow();
  });
  for (const locale of ["zh", "en"] as const) {
    const { t } = createTranslator(locale);
    const render = (child: ReturnType<typeof createElement>) =>
      renderToStaticMarkup(
        createElement(I18nProvider, { locale, children: child }),
      );
    it(`${locale} presents pause and resume independently of running state`, () => {
      expect(
        render(createElement(MemberPause, { workspace: "team", member })),
      ).toContain(t("members.resume"));
      expect(
        render(
          createElement(MemberPause, {
            workspace: "team",
            member: { ...member, paused: false },
          }),
        ),
      ).toContain(t("members.pause"));
      expect(render(createElement(MemberStatus, member))).toContain(
        'data-status="paused"',
      );
    });
    it(`${locale} displays reminder excerpts, unread state and the time selector`, () => {
      const html = render(
        createElement(ActivityRow, {
          team: {
            workspace_id: "team",
            members: [member],
            channels: [],
            notifications: [],
          },
          event: reminder,
          open() {},
        }),
      );
      expect(html).toContain("Evidence summary");
      expect(html).toContain(t("team.activity.reminder"));
      expect(html).toContain('data-unread="true"');
      const dialog = render(
        createElement(TeamReminderDialog, {
          workspace: "team",
          message,
          onClose() {},
        }),
      );
      expect(dialog).toContain(t("team.reminder.minutes"));
      expect(dialog).toContain(t("team.reminder.create"));
    });
  }
});
