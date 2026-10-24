import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { I18nProvider } from "../../../i18n/I18nProvider";
import type { ResearchProject, ResearchSprint } from "../research-api";
import { ThreadView, type ThreadActions } from "./ThreadView";
import type { ThreadItem } from "./thread";

it("exposes native messages and sprint blocks as activity location targets", () => {
  const items: ThreadItem[] = [
    {
      id: "event",
      kind: "message",
      who: "advisor",
      text: "Evidence",
      at: "2026-10-23T10:00:00Z",
    },
    {
      id: "sprint",
      kind: "work",
      sprint: {
        id: "sprint",
        number: 1,
        role: "executor",
        status: "ended",
        summary: "Result",
        created_at: "2026-10-23T10:00:00Z",
        updated_at: "2026-10-23T11:00:00Z",
      } as ResearchSprint,
      steps: [],
      jobs: [],
      at: "2026-10-23T10:00:00Z",
    },
  ];
  for (const locateId of ["event", "sprint"]) {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        locale: "en",
        children: createElement(ThreadView, {
          items,
          locateId,
          project: {} as ResearchProject,
          computes: [],
          actions: {} as ThreadActions,
          runs: new Map(),
        }),
      }),
    );
    expect(html).toContain(`data-research-item="${locateId}"`);
    expect(html).toMatch(
      new RegExp(`class="[^"]*located[^"]*" data-research-item="${locateId}"`),
    );
    expect(html).toContain('tabindex="-1"');
  }
});
