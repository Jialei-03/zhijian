import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import {
  defaultPanelOpen,
  groupMessages,
  MessageRow,
  TeamComposer,
} from "./TeamScreen";
import { orderedMessages } from "./team-model";
import type { Team, TeamMessage } from "./team-api";

const started = "2026-10-23T15:27:00Z";
const finished = "2026-10-23T15:44:00Z";
const team: Team = {
  workspace_id: "workspace",
  channels: [],
  notifications: [],
  members: [
    {
      id: "human",
      role: "human",
      name: "human",
      status: "idle",
      active_run_id: null,
    },
    {
      id: "writer",
      role: "writer",
      name: "writer",
      status: "idle",
      active_run_id: null,
    },
    {
      id: "member",
      role: "librarian",
      name: "Ada",
      status: "working",
      active_run_id: "run",
    },
  ],
};
const message: TeamMessage = {
  id: "reply",
  channel_id: "channel",
  thread_id: null,
  author_id: "member",
  kind: "message",
  text: "",
  mentions: [],
  data: {},
  replies: 0,
  created_at: started,
  run: {
    id: "run",
    status: "queued",
    response: "",
    error: "",
    steps: [],
    runtime: {},
    created_at: started,
    updated_at: started,
  },
};

describe("team member replies", () => {
  for (const locale of ["zh", "en"] as const) {
    const { t, tn } = createTranslator(locale);
    const render = (value: TeamMessage, grouped = false) =>
      renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(MessageRow, {
            message: value,
            grouped,
            modelName: "offline-model",
            team,
            openThread() {},
            fork() {},
            onFile() {},
          }),
        }),
      );

    it(`${locale} puts the researcher's message in its own bubble without an avatar or visible name`, () => {
      const html = render({
        ...message,
        author_id: "human",
        run: undefined,
        text: "My request",
      });
      expect(html).toContain('data-author="human"');
      expect(html).toContain(`aria-label="${t("team.member.human")}"`);
      expect(html).not.toContain('shape-rendering="crispEdges"');
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<strong>");
      expect(html).toContain(`<time dateTime="${started}">`);
      expect(html).toContain("My request");
    });
    it(`${locale} labels a broadcast reply with its thread origin`, () => {
      const html = render({
        ...message,
        run: undefined,
        kind: "thread_broadcast",
        text: "Conclusion",
        data: { thread_origin: { thread_id: "root", message_id: "source" } },
      });
      expect(html).toContain(t("team.fromThread"));
      expect(html).toContain("Conclusion");
      expect(html).toContain(`aria-label="${t("research.actions")}"`);
    });
    it(`${locale} attributes colleague wakes on queued, running and completed messages`, () => {
      const label = t("team.wokenBy", { name: "writer" });
      for (const status of ["queued", "running", "completed"]) {
        const value = {
          ...message,
          data: { woken_by: "writer" },
          run: { ...message.run!, status, response: "Finding" },
        };
        expect(render(value)).toContain(label);
        expect(render(value, true)).toContain(label);
      }
      expect(render({ ...message, data: { woken_by: "human" } })).not.toContain(
        t("team.wokenBy", { name: t("team.member.human") }),
      );
      expect(render(message)).not.toContain(label);
    });
    it(`${locale} offers channel sharing only for a channel thread composer`, () => {
      for (const member_id of [null, "writer"]) {
        for (const threadId of [undefined, "root"]) {
          const html = renderToStaticMarkup(
            createElement(I18nProvider, {
              locale,
              children: createElement(TeamComposer, {
                team,
                threadId,
                channel: {
                  id: "channel",
                  key: "general",
                  name: "Lab",
                  member_id,
                  unread: 0,
                },
                models: [],
                model: "",
                modelsKnown: false,
                onModel() {},
                sent() {},
              }),
            }),
          );
          expect(html.includes('type="checkbox"')).toBe(
            !!threadId && !member_id,
          );
          if (threadId && !member_id)
            expect(html).toContain(t("team.alsoChannel", { channel: "#Lab" }));
        }
      }
    });

    it(`${locale} keeps agent identity, handoff, model, files and replies accessible`, () => {
      const html = render({
        ...message,
        run: undefined,
        text: "Answer",
        replies: 3,
        data: {
          to: ["writer"],
          files: [{ path: "draft.md", name: "draft.md" }],
          attachments: [
            { id: "attachment", name: "data.csv", url: "/attachments/data" },
          ],
        },
      });
      expect(html).toContain('data-author="agent"');
      expect(html).toContain(t("team.agent"));
      expect(html).toContain(t("team.handoff", { name: "writer" }));
      expect(html).toContain("offline-model");
      expect(html).toContain(tn("team.replies", 3));
      expect(html).toContain('aria-label="draft.md"');
      expect(html).toContain('aria-label="data.csv"');
      expect(html).toContain(t("team.open"));
    });

    it(`${locale} shows up to three recent participants and the last reply time on a thread entry`, () => {
      const html = render({
        ...message,
        run: undefined,
        text: "Root message",
        replies: 5,
        reply_authors: ["writer", "member", "human", "fourth"],
        last_message_at: finished,
      });
      expect(html).toContain(`aria-label="${t("team.threadParticipants")}"`);
      expect(html.match(/<span role="img"/g)).toHaveLength(3);
      expect(html).toContain('aria-label="writer" title="writer"');
      expect(html).toContain('aria-label="Ada" title="Ada"');
      expect(html).toContain(
        `aria-label="${t("team.member.human")}" title="${t("team.member.human")}"`,
      );
      expect(html).not.toContain("fourth");
      expect(html.indexOf('title="writer"')).toBeLessThan(
        html.indexOf('title="Ada"'),
      );
      expect(html.indexOf('title="Ada"')).toBeLessThan(
        html.indexOf(`<span>${tn("team.replies", 5)}</span>`),
      );
      expect(html).toContain(`<time dateTime="${finished}">`);
      expect(html).toContain(`aria-label="${t("team.reply")}"`);
    });

    it(`${locale} shows inline answers as agent cards and only offers a thread entry after replies exist`, () => {
      const html = render({
        ...message,
        run: undefined,
        text: "Inline answer",
      });
      expect(html).toContain('data-author="agent"');
      expect(html).toContain('data-testid="team-message-bubble"');
      expect(html).toContain("Inline answer");
      expect(html).toContain(`aria-label="${t("team.reply")}"`);
      expect(html).not.toContain(t("team.threadParticipants"));
      expect(html).not.toContain(tn("team.replies", 0));
      expect(
        render({ ...message, run: undefined, thread_id: "root", replies: 2 }),
      ).not.toContain(tn("team.replies", 2));
    });

    it(`${locale} groups consecutive agent messages without repeating their identity`, () => {
      const html = render(
        { ...message, run: undefined, text: "Follow-up" },
        true,
      );
      expect(html).toContain('data-grouped="true"');
      expect(html).not.toContain('shape-rendering="crispEdges"');
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<strong>");
      expect(html).toContain("Follow-up");
      expect(html).toContain(`aria-label="${t("team.reply")}"`);
    });

    const changes = {
      commit: "a".repeat(40),
      files: [
        { path: "draft.md", added: 13, removed: 2, status: "M" },
        { path: "deleted.md", added: 0, removed: 1, status: "D" },
      ],
      added: 13,
      removed: 3,
    };
    it(`${locale} shows file changes after the file cards with view and undo actions`, () => {
      const html = render({
        ...message,
        run: undefined,
        data: { files: [{ path: "draft.md", name: "draft.md" }], changes },
      });
      expect(html).toContain(tn("team.changes.files", 2));
      expect(html).toContain("+13");
      expect(html).toContain("−3");
      expect(html).toContain(`>${t("team.changes.view")}</span>`);
      expect(html).toContain(`>${t("research.changes.undo")}</span>`);
      expect(html.indexOf('aria-label="draft.md"')).toBeLessThan(
        html.indexOf(tn("team.changes.files", 2)),
      );
      expect(html).not.toContain(t("team.changes.confirm"));
    });
    it(`${locale} hides empty changes, including commits with no line or file changes`, () => {
      for (const data of [
        {},
        { commit: changes.commit },
        { changes: { ...changes, files: [], added: 0, removed: 0 } },
      ]) {
        const html = render({ ...message, run: undefined, data });
        expect(html).not.toContain(t("team.changes.view"));
        expect(html).not.toContain(t("research.changes.undo"));
      }
      const binary = render({
        ...message,
        run: undefined,
        data: {
          changes: {
            ...changes,
            files: [{ path: "image.png", added: 0, removed: 0, status: "A" }],
            added: 0,
            removed: 0,
          },
        },
      });
      expect(binary).toContain(tn("team.changes.files", 1));
    });
    it(`${locale} keeps reverted changes reviewable and removes the undo action`, () => {
      const html = render({
        ...message,
        run: undefined,
        data: { changes, reverted_by: "b".repeat(40) },
      });
      expect(html).toContain(
        `role="status">${t("team.changes.reverted")}</span>`,
      );
      expect(html).toContain(`>${t("team.changes.view")}</span>`);
      expect(html).not.toContain(`>${t("research.changes.undo")}</span>`);
    });

    it(`${locale} centers system statuses with a more menu and no identity`, () => {
      const html = render({
        ...message,
        author_id: null,
        kind: "relay_limit",
        run: undefined,
        data: { waiting: true },
        text: "等你 / Waiting for you",
      });
      expect(html).toContain(`aria-label="${t("team.system")}"`);
      expect(html).toContain(`<span>${t("team.status.waiting")}</span>`);
      expect(html).not.toContain("<img");
      expect(html).toContain(`aria-label="${t("research.actions")}"`);
      expect(html).not.toContain("<time");
    });

    it(`${locale} never invents an agent limit in a system notice`, () => {
      const html = render({
        ...message,
        author_id: null,
        kind: "relay_limit",
        run: undefined,
        data: {},
      });
      expect(html).toContain(t("team.limitReached"));
      expect(html).not.toContain(t("team.relayLimit", { n: 12 }));
    });

    it(`${locale} folds tools while preserving the answer and live status`, () => {
      const html = render({
        ...message,
        text: "Visible answer",
        run: {
          ...message.run!,
          status: "running",
          steps: [
            {
              name: "read",
              status: "completed",
              arguments: { path: "folded-path.md" },
            },
          ],
        },
      });
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain(t("team.status.working"));
      expect(html).not.toContain(t("research.process.done"));
      expect(html).not.toContain("folded-path.md");
      expect(html).toContain("Visible answer");
    });

    it(`${locale} addresses the conversation and exposes mention and attachment controls`, () => {
      for (const [member_id, name, label] of [
        [null, "闲聊", `#${t("team.channel.general")}`],
        ["member", "Ada", "Ada"],
        ["deleted-member", "Former member", "Former member"],
      ] as const) {
        const html = renderToStaticMarkup(
          createElement(I18nProvider, {
            locale,
            children: createElement(TeamComposer, {
              team,
              channel: {
                id: "channel",
                key: "general",
                name,
                member_id,
                unread: 0,
              },
              models: [],
              model: "",
              onModel() {},
              sent() {},
            }),
          }),
        );
        expect(html).toContain(
          `placeholder="${t("team.sendTo", { name: label })}"`,
        );
        expect(html).toContain(`aria-label="${t("team.mention")}"`);
        expect(html).toContain(`aria-label="${t("research.attach")}"`);
      }
    });

    it(`${locale} queues with avatar, name, short status, stop and more`, () => {
      const html = render(message);
      expect(html).toContain(`<strong>Ada</strong>`);
      expect(html).toContain(`role="status">${t("team.queued")}</span>`);
      expect(html).toContain(`aria-label="${t("research.stop")}"`);
      expect(html).not.toContain(`aria-label="${t("team.reply")}"`);
      expect(html).not.toContain(`aria-label="${t("team.copy")}"`);
      expect(html).not.toContain("<time");
      expect(html).not.toContain("<section");
      expect(html).not.toContain(t("research.process.waitingTurn"));
    });

    it(`${locale} starts the normal working turn at its original time`, () => {
      const html = render({
        ...message,
        run: { ...message.run!, status: "running", updated_at: finished },
      });
      expect(html).toContain(`dateTime="${started}"`);
      expect(html).toContain('data-live="true"');
      expect(html).toContain(t("research.process.pending"));
      expect(html).not.toContain(t("team.queued"));
    });

    it(`${locale} displays the settled completion time and keeps the answer`, () => {
      const html = render({
        ...message,
        created_at: finished,
        text: "Saved answer",
        run: { ...message.run!, status: "completed", updated_at: finished },
      });
      expect(html).toContain(`dateTime="${finished}"`);
      expect(html).toContain("Saved answer");
      expect(html).not.toContain(`aria-label="${t("research.stop")}"`);
    });

    for (const steps of [
      [],
      [{ name: "read", status: "completed", arguments: { path: "notes.md" } }],
    ]) {
      it(`${locale} shows only identity and no new content after completing with ${steps.length} steps`, () => {
        for (const data of [
          {},
          { files: [], attachments: [], links: [] },
          { commit: changes.commit },
          { changes: { ...changes, files: [] } },
        ]) {
          const html = render(
            {
              ...message,
              text: " \n\t",
              data,
              run: { ...message.run!, status: "completed", steps },
            },
            true,
          );
          expect(html).toContain("<strong>Ada</strong>");
          expect(html).toContain('shape-rendering="crispEdges"');
          expect(html).toContain(`role="status">${t("team.noContent")}</span>`);
          expect(html).not.toContain('data-testid="team-message-bubble"');
          expect(html).not.toContain("<time");
          expect(html).not.toContain("<section");
          expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
          expect(html).not.toContain('aria-label="' + t("team.reply") + '"');
          expect(html).toContain(`aria-label="${t("research.actions")}"`);
          expect(html).not.toContain("offline-model");
          expect(html).not.toContain("notes.md");
          expect(html).not.toContain(t("team.noAnswer"));
          expect(html).not.toContain(t("team.queued"));
        }
      });
    }

    it(`${locale} preserves file cards, deletions, attachments, links and file errors without reply text`, () => {
      const cases: [TeamMessage["data"], string][] = [
        [{ files: [{ path: "draft.md", name: "draft.md" }] }, "draft.md"],
        [{ changes }, tn("team.changes.files", 2)],
        [
          {
            changes: {
              ...changes,
              files: [
                { path: "deleted.md", added: 0, removed: 3, status: "D" },
              ],
            },
          },
          tn("team.changes.files", 1),
        ],
        [
          { attachments: [{ id: "file", name: "attached.md", url: "/file" }] },
          "attached.md",
        ],
        [
          {
            links: [{ channel_id: "other", thread_id: "post", name: "Other" }],
          },
          t("team.resultIn", { name: "Other" }),
        ],
        [{ file_error: "File error" }, "File error"],
      ];
      for (const [data, content] of cases) {
        const html = render({
          ...message,
          data,
          run: { ...message.run!, status: "completed" },
        });
        expect(html).toContain(content);
        expect(html).toContain('data-testid="team-message-bubble"');
        expect(html).not.toContain(t("team.noContent"));
        expect(html).not.toContain(t("team.noAnswer"));
      }
    });

    it(`${locale} keeps empty failures and errors out of the no-content row`, () => {
      for (const run of [
        { ...message.run!, status: "failed" },
        { ...message.run!, status: "failed", error: "Test failure" },
        { ...message.run!, status: "completed", error: "Test failure" },
      ]) {
        const html = render({ ...message, run });
        expect(html).toContain('data-testid="team-message-bubble"');
        expect(html).not.toContain(t("team.noContent"));
        if (run.status === "failed")
          expect(html).toContain(run.error || t("research.process.failed"));
      }
    });

    for (const steps of [
      [],
      [{ name: "read", status: "completed", arguments: { path: "notes.md" } }],
    ]) {
      it(`${locale} shows stopped after cancellation with ${steps.length} steps`, () => {
        const html = render({
          ...message,
          text: "Saved answer",
          run: { ...message.run!, status: "cancelled", steps },
        });
        expect(html).toContain(t("research.process.cancelled"));
        expect(html).toContain("Saved answer");
        expect(html).not.toContain(t("team.queued"));
        expect(html).not.toContain(`aria-label="${t("research.stop")}"`);
      });
      it(`${locale} labels a failure without an error with ${steps.length} steps`, () => {
        const html = render({
          ...message,
          text: "Saved answer",
          run: { ...message.run!, status: "failed", steps },
        });
        expect(html).toContain(t("research.process.failed"));
        expect(html).toContain("Saved answer");
        expect(html).not.toContain(t("team.queued"));
        expect(html).not.toContain(`aria-label="${t("research.stop")}"`);
      });
    }

    it(`${locale} keeps the failure and saved output visible`, () => {
      const html = render({
        ...message,
        text: "Saved answer",
        run: { ...message.run!, status: "failed", error: "Test failure" },
      });
      expect(html).toContain("Test failure");
      expect(html).toContain("Saved answer");
      expect(html).not.toContain(t("team.queued"));
      expect(html).not.toContain(t("research.process.cancelled"));
      expect(html).not.toContain(`aria-label="${t("research.stop")}"`);
    });
  }

  it("moves a settled reply after intervening messages without duplicating it", () => {
    const update = {
      ...message,
      id: "update",
      created_at: "2026-10-23T15:35:00Z",
    };
    expect(orderedMessages([message, update]).map((m) => m.id)).toEqual([
      "reply",
      "update",
    ]);
    const settled = { ...message, created_at: finished };
    expect(
      orderedMessages([message, update, settled]).map((m) => m.id),
    ).toEqual(["update", "reply"]);
    expect(message.created_at).toBe(started);
  });
});

describe("conversation grouping and panel defaults", () => {
  const first = { ...message, run: undefined };
  const next = { ...first, id: "next", created_at: "2026-10-23T15:32:00Z" };
  it("groups the same author through five minutes", () => {
    expect(groupMessages(first, next)).toBe(true);
    expect(groupMessages(first, { ...next, created_at: started })).toBe(true);
    expect(
      groupMessages(first, { ...next, created_at: "2026-10-23T15:32:01Z" }),
    ).toBe(false);
  });
  it("breaks at other authors, conversations, queued or empty completed rows and system rows", () => {
    expect(groupMessages(undefined, next)).toBe(false);
    for (const patch of [
      { author_id: "writer" },
      { author_id: null },
      { channel_id: "other" },
      { thread_id: "other" },
      { kind: "budget" },
      { kind: "research" },
      { created_at: "invalid" },
      { created_at: "2026-10-23T15:26:59Z" },
      { run: message.run },
      { run: { ...message.run!, status: "completed" } },
    ]) {
      expect(groupMessages(first, { ...next, ...patch })).toBe(false);
      expect(groupMessages({ ...first, ...patch }, next)).toBe(false);
    }
  });
  it("starts narrow screens closed and restores the desktop preference", () => {
    expect(defaultPanelOpen(899, null)).toBe(false);
    expect(defaultPanelOpen(899, "true")).toBe(false);
    expect(defaultPanelOpen(900, null)).toBe(true);
    expect(defaultPanelOpen(1440, "true")).toBe(true);
    expect(defaultPanelOpen(1440, "false")).toBe(false);
  });
});
