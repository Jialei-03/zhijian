import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { colleagueStatus } from "./TeamMemberCard";
import { TeamCatchup, catchupAnchor } from "./TeamCatchup";
import type { Team, TeamCatchup as Catchup, TeamMember } from "./team-api";

const member: TeamMember = {
  id: "ada",
  role: "custom",
  name: "Ada",
  status: "working",
  active_run_id: "run",
  elapsed_seconds: 72,
};
const team: Team = {
  workspace_id: "workspace",
  members: [member, { ...member, id: "reviewer", name: "Reviewer" }],
  channels: [],
  notifications: [],
};
const summary: Catchup = {
  since: "2026-10-24T00:00:00Z",
  through: "2026-10-24T01:00:00Z",
  show: true,
  new_messages: 5,
  first_unread: { id: "new", thread_id: null },
  completed: [{ member_id: "ada", count: 1 }],
  files: [
    { path: "draft.md", name: "draft.md" },
    { path: "old.md", name: "old.md", deleted: true },
  ],
  handoffs: [{ member_id: "ada", message_id: "handoff", to: ["reviewer"] }],
  waiting: [{ member_id: "ada", message_id: "decision", text: "Approve?" }],
  failed: [{ member_id: "ada", message_id: "failed", text: "Exit 1" }],
};

describe("colleagues and deterministic catch-up", () => {
  for (const locale of ["zh", "en"] as const) {
    const translator = createTranslator(locale);
    const { t, tn } = translator;
    it(`${locale} prioritizes the member's status while working and drops it at rest`, () => {
      const value = {
        ...member,
        status_text: "Checking evidence",
        current_step: {
          name: "read",
          arguments: { path: "trace.md" },
          status: "completed",
        },
      };
      expect(colleagueStatus(value, translator)).toBe(
        t("team.colleague.working", {
          task: "Checking evidence",
          elapsed: t("reader.assistant.duration.minutes", {
            minutes: 1,
            seconds: 12,
          }),
        }),
      );
      expect(colleagueStatus(value, translator)).not.toContain("trace.md");
      expect(colleagueStatus({ ...value, status: "idle" }, translator)).toBe(
        t("team.status.idle"),
      );
      expect(
        colleagueStatus({ ...value, status_text: "" }, translator),
      ).toContain("trace.md");
    });
    it(`${locale} describes commands, paths, thinking and queues`, () => {
      for (const [step, task] of [
        [
          {
            name: "bash",
            arguments: {
              command: "cd /workspace && python train.py | tail -10",
            },
            status: "running",
          },
          `${t("team.colleague.run")} python train.py`,
        ],
        [
          {
            name: "read",
            arguments: JSON.stringify({ path: "shared/plan.md" }),
            status: "completed",
          },
          `${t("team.colleague.read")} shared/plan.md`,
        ],
        [
          {
            name: "write",
            arguments: {
              path: "conclusion.md",
              content: "Never show file contents",
            },
            status: "completed",
          },
          `${t("team.colleague.write")} conclusion.md`,
        ],
        [null, t("team.colleague.thinking")],
      ] as const) {
        expect(
          colleagueStatus({ ...member, current_step: step }, translator),
        ).toBe(
          t("team.colleague.working", {
            task,
            elapsed: t("reader.assistant.duration.minutes", {
              minutes: 1,
              seconds: 12,
            }),
          }),
        );
      }
      for (const count of [0, 1, 2])
        expect(
          colleagueStatus(
            { ...member, status: "queued", queue_ahead: count },
            translator,
          ),
        ).toBe(tn("team.colleague.ahead", count));
      expect(colleagueStatus({ ...member, status: "idle" }, translator)).toBe(
        t("team.status.idle"),
      );
      expect(colleagueStatus({ ...member, enabled: false }, translator)).toBe(
        t("members.disabled"),
      );
    });

    it(`${locale} renders aggregate events and only opens existing files`, () => {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(TeamCatchup, {
            team,
            summary,
            onFile() {},
            onJump() {},
          }),
        }),
      );
      for (const text of [
        t("team.catchup.title"),
        tn("team.catchup.messages", 5),
        tn("team.catchup.completed", 1, { name: "Ada" }),
        t("team.catchup.handoff", { name: "Ada", to: "Reviewer" }),
        "Approve?",
        "Exit 1",
        t("team.catchup.jump"),
      ])
        expect(html).toContain(text);
      expect(html).toContain('aria-label="draft.md"');
      expect(html).not.toContain('aria-label="old.md"');
      expect(html).toContain(t("team.catchup.deleted", { path: "old.md" }));
      expect(html).not.toContain("tasks");
    });
  }

  it("anchors above the first unread or its thread root and handles completion-only returns", () => {
    const messages = [{ id: "old" }, { id: "new" }, { id: "later" }];
    expect(catchupAnchor(summary, messages)).toBe("new");
    expect(
      catchupAnchor(
        { ...summary, first_unread: { id: "reply", thread_id: "old" } },
        messages,
      ),
    ).toBe("old");
    expect(catchupAnchor({ ...summary, first_unread: null }, messages)).toBe(
      "old",
    );
    expect(catchupAnchor({ ...summary, show: false }, messages)).toBeNull();
    expect(catchupAnchor(summary, [])).toBeNull();
  });
});
