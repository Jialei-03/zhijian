import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import {
  ForwardMessageDialog,
  MessageReference,
  QuoteDraft,
} from "./TeamMessageFeatures";
import { MessageRow, TeamComposer } from "./TeamScreen";
import {
  sendTeamMessage,
  setTeamReaction,
  type Team,
  type TeamMessage,
  type TeamMessageReference,
} from "./team-api";

const team: Team = {
  workspace_id: "workspace",
  members: [
    {
      id: "human",
      role: "human",
      name: "Researcher",
      status: "idle",
      active_run_id: null,
    },
    {
      id: "ada",
      role: "librarian",
      name: "Ada",
      status: "idle",
      active_run_id: null,
    },
  ],
  channels: [
    { id: "channel", key: "general", name: "闲聊", member_id: null, unread: 0 },
  ],
  notifications: [],
};
const reference: TeamMessageReference = {
  message_id: "source",
  channel_id: "channel",
  thread_id: null,
  author_id: "ada",
  author_name: "Ada",
  created_at: "2026-10-24T10:00:00Z",
  text: "An original finding <script>",
};
const message: TeamMessage = {
  id: "message",
  channel_id: "channel",
  thread_id: null,
  author_id: "human",
  kind: "text",
  text: "",
  data: {
    forward: reference,
    quote: { ...reference, text: "original finding" },
  },
  mentions: [],
  replies: 0,
  created_at: reference.created_at,
  reactions: [
    { emoji: "👍", count: 1, mine: true },
    { emoji: "✅", count: 2, mine: false },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("team message feedback and references", () => {
  for (const locale of ["zh", "en"] as const) {
    const { t, tn } = createTranslator(locale);
    const render = (children: ReactNode) =>
      renderToStaticMarkup(createElement(I18nProvider, { locale, children }));

    it(`${locale} renders references, reaction counts and the reaction toolbar`, () => {
      const html = render(
        createElement(MessageRow, {
          team,
          message,
          openThread() {},
          fork() {},
          onFile() {},
        }),
      );
      expect(html).toContain('data-testid="team-forward"');
      expect(html).toContain('data-testid="team-quote"');
      expect(html).toContain('href="#team/workspace/channel?thread=source"');
      expect(html).toContain("Ada");
      expect(html).toContain(`dateTime="${reference.created_at}"`);
      expect(html).toContain("An original finding &lt;script&gt;");
      expect(html).not.toContain("<script>");
      expect(html).toContain(`aria-label="👍 ${tn("team.reactionCount", 1)}"`);
      expect(html).toContain(`aria-label="✅ ${tn("team.reactionCount", 2)}"`);
      expect(html).toContain('aria-pressed="true"');
      expect(html).toContain('aria-pressed="false"');
      expect(html).toContain(`aria-label="${t("team.react")}"`);
    });

    it(`${locale} keeps a reference-only completed message visible`, () => {
      const html = render(
        createElement(MessageRow, {
          team,
          message: {
            ...message,
            run: {
              id: "run",
              status: "completed",
              response: "",
              error: "",
              steps: [],
              runtime: {},
              created_at: reference.created_at,
              updated_at: reference.created_at,
            },
          },
          openThread() {},
          fork() {},
          onFile() {},
        }),
      );
      expect(html).toContain('data-testid="team-forward"');
      expect(html).not.toContain(t("team.noContent"));
    });

    it(`${locale} provides a cancellable quote draft and permits quote-only replies`, () => {
      const draft = render(
        createElement(QuoteDraft, { quote: reference, onClear() {} }),
      );
      expect(draft).toContain(reference.author_name);
      expect(draft).toContain(t("team.removeQuote"));
      const html = render(
        createElement(TeamComposer, {
          team,
          channel: team.channels[0],
          quote: reference,
          onClearQuote() {},
          models: [],
          model: "",
          onModel() {},
          sent() {},
        }),
      );
      expect(html).toContain('data-testid="team-quote-draft"');
      expect(html).toMatch(
        /<button[^>]*aria-label="(?:发送|Send)"[^>]*type="submit"/,
      );
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    });

    it(`${locale} keeps forwarded replies linked to their original thread and exposes only short form labels`, () => {
      const html = render(
        createElement(MessageReference, {
          team,
          reference: { ...reference, thread_id: "root" },
          kind: "forward",
        }),
      );
      expect(html).toContain('href="#team/workspace/channel?thread=root"');
      const dialog = render(
        createElement(ForwardMessageDialog, { team, message, onClose() {} }),
      );
      expect(dialog).toContain(t("team.forwardTo"));
      expect(dialog).toContain(t("team.forwardNote"));
      expect(dialog).not.toContain("aria-describedby");
    });
  }

  it("encodes each fixed reaction and uses explicit idempotent add/remove requests", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("[]")));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { cookie: "" });
    for (const emoji of ["👍", "👎", "✅"] as const) {
      for (const remove of [false, true]) {
        await setTeamReaction("workspace", "message/id", emoji, remove);
        expect(fetch).toHaveBeenLastCalledWith(
          `/api/v1/research/workspaces/workspace/team/messages/message%2Fid/reactions/${encodeURIComponent(emoji)}`,
          expect.objectContaining({ method: remove ? "DELETE" : "PUT" }),
        );
      }
    }
  });

  it("sends only source identifiers and the selected quote; the server supplies provenance", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(message)));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { cookie: "" });
    const body = {
      text: "",
      mode: "queue" as const,
      client_id: "retry",
      forward_message_id: reference.message_id,
      thread_id: "root",
      quote: { message_id: reference.message_id, text: "original finding" },
    };
    await sendTeamMessage("workspace", "channel", body);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
  });
});
