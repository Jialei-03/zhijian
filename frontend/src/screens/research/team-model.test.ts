import { describe, expect, it } from "vitest";
import {
  mentionMatches,
  directChannels,
  memberLabel,
  mentionQuery,
  orderedMessages,
  recentThreads,
  sendMode,
  threadDate,
  activityMessages,
  conversationName,
} from "./team-model";
import { createTranslator } from "../../i18n/i18n";
import type {
  TeamActivity,
  TeamChannel,
  TeamMember,
  TeamMessage,
} from "./team-api";

const members: TeamMember[] = [
  {
    id: "advisor",
    role: "advisor",
    name: "导师",
    status: "working",
    active_run_id: "run",
  },
  {
    id: "writer",
    role: "writer",
    name: "写手",
    status: "idle",
    active_run_id: null,
  },
];
describe("team messages", () => {
  it("localizes built-in names and preserves chosen names", () => {
    const { t } = createTranslator("en");
    expect(memberLabel(members[0], t)).toBe("Advisor");
    expect(memberLabel({ ...members[0], name: "Ada" }, t)).toBe("Ada");
    expect(memberLabel(undefined, t)).toBe("");
  });
  it("omits orphaned and deleted direct channels without hiding disabled members", () => {
    const channels: TeamChannel[] = [
      null,
      "advisor",
      "writer",
      "deleted",
      "missing",
    ].map((member_id, index) => ({
      id: String(index),
      key: String(index),
      name: String(index),
      member_id,
      unread: 0,
    }));
    const disabled = { ...members[1], enabled: false };
    expect(
      directChannels({
        channels,
        members: [
          members[0],
          disabled,
          { ...members[0], id: "deleted", deleted: true },
        ],
      }),
    ).toEqual([
      { channel: channels[1], member: members[0] },
      { channel: channels[2], member: disabled },
    ]);
  });
  it("completes the mention at the caret, including Chinese and text after it", () => {
    expect(mentionQuery("hello @导 rest", 8)).toEqual({
      query: "导",
      start: 6,
      end: 8,
    });
    expect(mentionQuery("mail@example.com", 16)).toBeNull();
    expect(mentionMatches(members, "adv", (m) => m.name)).toEqual([members[0]]);
    expect(mentionMatches(members, "写", (m) => m.name)).toEqual([members[1]]);
  });
  it("queues Enter and sends immediately with either platform modifier", () => {
    expect(sendMode({ metaKey: false, ctrlKey: false })).toBe("queue");
    expect(sendMode({ metaKey: true, ctrlKey: false })).toBe("immediate");
    expect(sendMode({ metaKey: false, ctrlKey: true })).toBe("immediate");
  });
  it("assembles live messages once, in order, with normalized handoffs", () => {
    const first = {
      id: "a",
      created_at: "2026-01-01",
      text: "before",
    } as TeamMessage;
    const second = {
      id: "b",
      created_at: "2026-01-02",
      text: "later",
    } as TeamMessage;
    const updated = { ...first, text: "line1\\nline2" };
    expect(
      orderedMessages([second, first, updated]).map((m) => m.text),
    ).toEqual(["line1\nline2", "later"]);
  });

  it("orders threads by their last reply and keeps message chronology unchanged", () => {
    const old = {
      id: "old",
      created_at: "2026-01-01T00:00:00Z",
      text: "old",
    } as TeamMessage;
    const newer = { ...old, id: "newer", created_at: "2026-01-02T00:00:00Z" };
    const replied = { ...old, last_message_at: "2026-01-03T00:00:00Z" };
    expect(recentThreads([old, newer, replied]).map((m) => m.id)).toEqual([
      "old",
      "newer",
    ]);
    expect(orderedMessages([replied, newer]).map((m) => m.id)).toEqual([
      "old",
      "newer",
    ]);
    expect(old).not.toHaveProperty("last_message_at");
    const offset = { ...newer, last_message_at: "2026-01-03T09:00:00+08:00" };
    expect(recentThreads([offset, replied]).map((m) => m.id)).toEqual([
      "newer",
      "old",
    ]);
  });

  for (const locale of ["zh", "en"]) {
    it(`${locale} formats local today, this year and earlier dates`, () => {
      const now = new Date(2026, 9, 24, 15);
      expect(
        threadDate(new Date(2026, 9, 24, 0, 5).toISOString(), locale, now),
      ).toBe("00:05");
      const recent = threadDate(
        new Date(2026, 9, 23, 23, 59).toISOString(),
        locale,
        now,
      );
      expect(recent).toBe(locale === "zh" ? "10月23日" : "Oct 23");
      expect(
        threadDate(new Date(2025, 11, 31).toISOString(), locale, now),
      ).toBe(locale === "zh" ? "2025年12月31日" : "Dec 31, 2025");
      expect(threadDate("invalid", locale, now)).toBe("—");
      const january = new Date(2026, 0, 1);
      expect(
        threadDate(
          new Date(2025, 11, 31, 23, 59).toISOString(),
          locale,
          january,
        ),
      ).toContain("2025");
    });
  }
});

describe("team activity", () => {
  it("keeps one event per message, newest first, including read events and overlapping filters", () => {
    const older = {
      id: "older",
      created_at: "2026-10-23T10:00:00Z",
      activity_types: ["mention", "reply"],
      unread: true,
    } as TeamActivity;
    const latest = {
      ...older,
      id: "latest",
      created_at: "2026-10-23T19:00:00+08:00",
      activity_types: ["waiting"],
      unread: false,
    } as TeamActivity;
    const updated = { ...older, unread: false };
    expect(activityMessages([older, latest, updated], "all")).toEqual([
      latest,
      updated,
    ]);
    expect(activityMessages([older, latest], "mention")).toEqual([older]);
    expect(activityMessages([older, latest], "reply")).toEqual([older]);
    expect(older.unread).toBe(true);
  });

  for (const locale of ["zh", "en"] as const) {
    it(`${locale} formats sources and relative activity times`, () => {
      const { t } = createTranslator(locale);
      expect(
        conversationName(
          { key: "experiments", name: "实验", member_id: null },
          members,
          t,
        ),
      ).toBe(locale === "zh" ? "#实验" : "#Experiments");
      expect(
        conversationName(
          { key: "custom", name: "Evidence", member_id: null },
          members,
          t,
        ),
      ).toBe("#Evidence");
      expect(
        conversationName(
          { key: "dm:advisor", name: "导师", member_id: "advisor" },
          members,
          t,
        ),
      ).toBe(locale === "zh" ? "导师" : "Advisor");
      const now = new Date("2026-10-24T12:00:00Z");
      const relative = (stamp: string) =>
        threadDate(stamp, locale, now, "relative");
      expect(relative("2026-10-24T11:55:00Z")).toBe(
        locale === "zh" ? "5分钟前" : "5 minutes ago",
      );
      expect(relative("2026-10-24T10:00:00Z")).toBe(
        locale === "zh" ? "2小时前" : "2 hours ago",
      );
      expect(relative("2026-10-23T12:00:00Z")).toBe(
        locale === "zh" ? "昨天" : "yesterday",
      );
      expect(relative("2026-10-24T12:00:30Z")).toBe(
        locale === "zh" ? "现在" : "now",
      );
      expect(relative("invalid")).toBe("—");
    });
  }
});

describe("conversation dates", () => {
  for (const locale of ["zh", "en"]) {
    it(`${locale} formats today, yesterday, weekdays and older dates locally`, () => {
      const now = new Date(2026, 9, 24, 15);
      const format = (date: Date, today = now) =>
        threadDate(date.toISOString(), locale, today, "conversation");
      expect(format(new Date(2026, 9, 24, 0, 5))).toBe("00:05");
      expect(format(new Date(2026, 9, 23, 23, 59))).toBe(
        locale === "zh" ? "昨天" : "Yesterday",
      );
      expect(format(new Date(2026, 9, 21, 23, 59))).toBe(
        locale === "zh" ? "星期三" : "Wednesday",
      );
      expect(format(new Date(2026, 9, 18, 23, 59))).toBe(
        locale === "zh" ? "10月18日" : "Oct 18",
      );
      expect(format(new Date(2025, 11, 31))).toBe(
        locale === "zh" ? "12月31日" : "Dec 31",
      );
      // Yesterday wins across both the Monday and New Year boundaries.
      expect(format(new Date(2026, 9, 25, 23, 59), new Date(2026, 9, 26))).toBe(
        locale === "zh" ? "昨天" : "Yesterday",
      );
      expect(format(new Date(2025, 11, 31, 23, 59), new Date(2026, 0, 1))).toBe(
        locale === "zh" ? "昨天" : "Yesterday",
      );
      expect(threadDate("invalid", locale, now, "conversation")).toBe("—");
    });
  }
});
