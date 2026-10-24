import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { MessageRow, TeamComposer } from "./TeamScreen";
import { canDecideMessage } from "./TeamMessageDecision";
import {
  decideTeamMessage,
  sendTeamMessage,
  type Team,
  type TeamMessage,
} from "./team-api";
import { mentionedAgents } from "./team-model";

const team: Team = {
  workspace_id: "workspace",
  members: [
    {
      id: "human",
      name: "Researcher",
      role: "human",
      status: "idle",
      active_run_id: null,
    },
    {
      id: "writer",
      name: "Ada",
      role: "writer",
      status: "idle",
      active_run_id: null,
    },
  ],
  channels: [
    { id: "channel", key: "general", name: "Lab", member_id: null, unread: 0 },
  ],
  notifications: [],
};
const message: TeamMessage = {
  id: "draft",
  channel_id: "channel",
  thread_id: null,
  author_id: "writer",
  kind: "draft",
  text: "Draft",
  mentions: [],
  data: {},
  replies: 0,
  created_at: "2026-10-24T00:00:00Z",
};
afterEach(() => vi.unstubAllGlobals());

describe("team handoffs", () => {
  it("allows deliverables and results while leaving research approvals and working turns alone", () => {
    expect(canDecideMessage(message)).toBe(true);
    expect(canDecideMessage({ ...message, kind: "text" })).toBe(false);
    expect(
      canDecideMessage({
        ...message,
        kind: "text",
        data: { files: [{ path: "draft.md", name: "draft.md" }] },
      }),
    ).toBe(true);
    for (const kind of [
      "plan",
      "conclusion",
      "event_reference",
      "sprint_reference",
      "thread_broadcast",
    ])
      expect(
        canDecideMessage({
          ...message,
          kind,
          data: { files: [{ path: "draft.md", name: "draft.md" }] },
        }),
      ).toBe(false);
    for (const status of ["queued", "running"])
      expect(
        canDecideMessage({
          ...message,
          run: {
            id: "run",
            status,
            response: "",
            error: "",
            steps: [],
            runtime: {},
            created_at: message.created_at,
            updated_at: message.created_at,
          },
        }),
      ).toBe(false);
  });

  for (const locale of ["zh", "en"] as const) {
    const { t } = createTranslator(locale);
    const render = (children: ReactNode) =>
      renderToStaticMarkup(createElement(I18nProvider, { locale, children }));
    const row = (value: TeamMessage) =>
      render(
        createElement(MessageRow, {
          message: value,
          team,
          openThread() {},
          fork() {},
          onFile() {},
        }),
      );
    it(`${locale} renders decisions, feedback and completion criteria`, () => {
      const html = row({
        ...message,
        data: {
          done_when: "Sources checked",
          decision: {
            status: "changes_requested",
            feedback: "Add evidence",
            event_id: "event",
            created_at: message.created_at,
          },
        },
      });
      expect(html).toContain(t("team.accept"));
      expect(html).toContain(t("team.requestChanges"));
      expect(html).toContain(`${t("team.changesRequested")} · Add evidence`);
      expect(html).toContain(
        t("team.doneWhenValue", { value: "Sources checked" }),
      );
      expect(row({ ...message, author_id: "human" })).not.toContain(
        t("team.requestChanges"),
      );
      expect(row({ ...message, kind: "plan" })).not.toContain(
        t("team.requestChanges"),
      );
      expect(
        row({ ...message, kind: "accepted", author_id: "human", text: "" }),
      ).toContain(t("team.accepted"));
    });
    it(`${locale} shows completion criteria only for actual member mentions`, () => {
      for (const text of [
        "",
        "@Researcher",
        "@Adaline",
        "@Ada check sources",
        "@writer check sources",
      ]) {
        vi.stubGlobal("localStorage", { getItem: () => text });
        const html = render(
          createElement(TeamComposer, {
            team,
            channel: team.channels[0],
            models: [],
            modelsKnown: false,
            model: "",
            onModel() {},
            sent() {},
          }),
        );
        expect(html.includes(`<label`)).toBe(
          text.startsWith("@Ada ") || text.startsWith("@writer "),
        );
        expect(html).toContain(t("team.sendMode"));
      }
    });
  }
  it("resolves complete mention aliases without waking references to the researcher", () => {
    const name = (member: Team["members"][number]) => member.name;
    expect(
      mentionedAgents("@Researcher @Adaline @Ada张", team.members, name),
    ).toEqual([]);
    expect(
      mentionedAgents("@writer @Ada", team.members, name).map(
        (member) => member.id,
      ),
    ).toEqual(["writer"]);
  });
  it("sends record mode, criteria and decisions as explicit API fields", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("document", { cookie: "" });
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => message });
    vi.stubGlobal("fetch", fetch);
    await sendTeamMessage("workspace", "channel", {
      text: "@Ada Draft",
      mode: "record",
      done_when: "Check sources",
      client_id: "client",
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      mode: "record",
      done_when: "Check sources",
    });
    await decideTeamMessage(
      "workspace",
      "draft",
      "changes_requested",
      "Add evidence",
    );
    expect(fetch.mock.calls[1][0]).toContain("/messages/draft/decision");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      status: "changes_requested",
      feedback: "Add evidence",
    });
  });
});
