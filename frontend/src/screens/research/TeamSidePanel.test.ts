import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import type { Delivery, Team, TeamMessage } from "./team-api";
import {
  conversationOutputs,
  conversationProgress,
  TeamSidePanel,
} from "./TeamSidePanel";

const team: Team = {
  workspace_id: "workspace",
  channels: [],
  notifications: [],
  members: ["working", "queued", "elsewhere"].map((id) => ({
    id,
    name: id,
    role: "custom_agent",
    status: "working",
    active_run_id: null,
  })),
};
const message: TeamMessage = {
  id: "request",
  channel_id: "channel",
  thread_id: null,
  author_id: "human",
  kind: "text",
  text: "Request",
  data: {},
  mentions: [],
  replies: 0,
  created_at: "2026-10-24T10:00:00Z",
};
const run = {
  id: "run",
  status: "running",
  steps: [],
  response: "",
  error: "",
  runtime: {},
  created_at: message.created_at,
  updated_at: message.created_at,
};
const working = {
  ...message,
  id: "reply",
  author_id: "working",
  thread_id: message.id,
  run,
};
const delivery: Delivery = {
  id: "delivery",
  member_id: "queued",
  message_id: message.id,
  channel_id: message.channel_id,
  thread_id: null,
  text: "Request",
  mode: "queue",
  status: "queued",
  error: "",
  editable: true,
};

describe("conversation outputs", () => {
  it("deduplicates paths, attachments and cited URLs from message data", () => {
    const outputs = conversationOutputs([
      {
        ...message,
        data: {
          files: [{ path: "draft.md", name: "draft.md" }],
          attachments: [
            { id: "upload", name: "input.csv", url: "/attachments/input" },
          ],
          paper: { title: "Paper", url: "https://example.test/paper" },
          citations: ["https://example.test/cited"],
        },
      },
      {
        ...working,
        data: {
          files: [{ path: "draft.md", name: "draft.md" }],
          citation: { name: "Paper", href: "https://example.test/paper" },
          citations: ["https://example.test/paper"],
          papers: [
            { title: "Unsafe", url: "javascript:alert(1)" },
            { title: "Local", href: "#reader/paper" },
          ],
        },
      },
    ]);
    expect(outputs.files.map((file) => file.name)).toEqual([
      "draft.md",
      "input.csv",
    ]);
    expect(outputs.sources).toEqual([
      { url: "https://example.test/paper", title: "Paper" },
      {
        url: "https://example.test/cited",
        title: "https://example.test/cited",
      },
      { url: "#reader/paper", title: "Local" },
    ]);
  });

  it("does not invent sources from prose or unrelated channel links", () => {
    expect(
      conversationOutputs([
        {
          ...message,
          text: "https://example.test/paper",
          data: {
            links: [
              { channel_id: "other", thread_id: "thread", name: "Other" },
            ],
          },
        },
      ]).sources,
    ).toEqual([]);
    expect(conversationOutputs([])).toEqual({ files: [], sources: [] });
  });
});

describe("conversation progress", () => {
  it("locates work inside threads and queued deliveries without showing other conversations", () => {
    const progress = conversationProgress(
      team,
      [message, working],
      [
        delivery,
        { ...delivery, member_id: "elsewhere", message_id: "unrelated" },
      ],
    );
    expect(
      progress.map(({ member, status, messageId }) => [
        member.id,
        status,
        messageId,
      ]),
    ).toEqual([
      ["working", "working", "reply"],
      ["queued", "queued", "request"],
    ]);
  });

  it("removes completed work and withdrawn deliveries", () => {
    expect(
      conversationProgress(
        team,
        [message, { ...working, run: { ...run, status: "completed" } }],
        [{ ...delivery, status: "cancelled" }],
      ),
    ).toEqual([]);
  });

  it("lists each member once when a second request is queued", () => {
    expect(
      conversationProgress(
        team,
        [message, working],
        [{ ...delivery, member_id: "working" }],
      ),
    ).toHaveLength(1);
  });
  it("keeps the running message as the target when the same member has a queued run", () => {
    const queued = {
      ...working,
      id: "queued-reply",
      run: { ...run, status: "queued" },
    };
    for (const messages of [
      [working, queued],
      [queued, working],
    ]) {
      expect(
        conversationProgress(team, messages, []).map(
          ({ status, messageId }) => [status, messageId],
        ),
      ).toEqual([["working", working.id]]);
    }
  });
});

for (const locale of ["zh", "en"] as const) {
  const { t } = createTranslator(locale);
  const render = (messages: TeamMessage[], deliveries = [delivery]) =>
    renderToStaticMarkup(
      createElement(I18nProvider, {
        locale,
        children: createElement(TeamSidePanel, {
          team,
          messages,
          deliveries,
          fileRequest: 0,
          onFile() {},
          onLocate() {},
          onClose() {},
        }),
      }),
    );
  it(`${locale} labels the panel and progress and omits absent files and sources`, () => {
    const html = render([message, working]);
    for (const key of ["sidePanel", "progress", "hidePanel"] as const)
      expect(html).toContain(`aria-label="${t(`team.${key}`)}"`);
    expect(html).not.toContain(t("team.sources"));
    expect(html).not.toContain(t("team.deliverables"));
    expect(html).not.toContain(t("team.noOutputs"));
    expect(html).toContain(t("team.status.working"));
    expect(html).toContain(t("team.status.queued"));
  });
  it(`${locale} shows only a labeled icon when every section is empty`, () => {
    for (const messages of [
      [],
      [message],
      [{ ...working, run: { ...run, status: "completed" } }],
    ]) {
      const html = render(messages, []);
      expect(html).not.toContain("<section");
      expect(html).not.toContain("<h3");
      expect(html).toContain(`role="img" aria-label="${t("team.noOutputs")}"`);
      expect(html).not.toContain(`>${t("team.noOutputs")}<`);
      expect(html).not.toMatch(/<p(?:\s|>)/);
    }
  });
  it(`${locale} shows each section only when it has content`, () => {
    const cases: ["progress" | "deliverables" | "sources", TeamMessage[]][] = [
      ["progress", [working]],
      [
        "deliverables",
        [
          {
            ...message,
            data: { files: [{ path: "draft.md", name: "draft.md" }] },
          },
        ],
      ],
      [
        "sources",
        [
          {
            ...message,
            data: {
              paper: { title: "Paper", url: "https://example.test/paper" },
            },
          },
        ],
      ],
    ];
    for (const [key, messages] of cases) {
      const html = render(messages, []);
      for (const section of ["progress", "deliverables", "sources"] as const)
        expect(html.includes(`<h3>${t(`team.${section}`)}</h3>`)).toBe(
          section === key,
        );
      expect(html).not.toContain(t("team.noOutputs"));
    }
  });
  it(`${locale} shows file cards and paper links`, () => {
    const html = render([
      {
        ...message,
        data: {
          files: [{ path: "draft.md", name: "draft.md" }],
          paper: { title: "Cited paper", url: "https://example.test/paper" },
        },
      },
    ]);
    expect(html).toContain('aria-label="draft.md"');
    expect(html).toContain(t("team.open"));
    expect(html).toContain(`aria-label="${t("team.sources")}"`);
    expect(html).toContain('href="https://example.test/paper"');
    expect(html).toContain("Cited paper");
  });
  it(`${locale} shows pinned thread excerpts and files as a location target`, () => {
    const pinned = {
      ...working,
      pinned: true,
      text: "A pinned finding",
      data: { files: [{ path: "finding.md", name: "finding.md" }] },
    };
    const html = render([pinned, pinned], []);
    expect(html).toContain(`aria-label="${t("team.pinned")}"`);
    expect(html).toContain('data-pin-id="reply"');
    expect(html.match(/data-pin-id=/g)).toHaveLength(1);
    expect(html).toContain("A pinned finding");
    expect(html).toContain("finding.md");
    expect(html).not.toContain(t("team.noOutputs"));
  });
}
