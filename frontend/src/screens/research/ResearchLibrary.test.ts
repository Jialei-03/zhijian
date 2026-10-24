import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import type { NavigationResearch } from "./navigation-api";
import { ResearchRows } from "./ResearchLibrary";

const active = {
  id: "active",
  title: "Short title",
  question: "A long question. ".repeat(30),
  progress: "A long conclusion. ".repeat(100),
  status: "finished",
  archived_at: null,
  updated_at: "2026-10-24T00:00:00Z",
} as NavigationResearch;
const archived = { ...active, id: "archived", archived_at: active.updated_at };

describe("research list", () => {
  for (const locale of ["zh", "en"] as const) {
    const { t } = createTranslator(locale);
    const render = (rows: NavigationResearch[]) =>
      renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(ResearchRows, { rows, go: vi.fn() }),
        }),
      );

    it(`${locale} puts search before archive choices and starts unarchived`, () => {
      const html = render([archived, active]);
      expect(html).toContain(
        `role="radiogroup" aria-label="${t("research.archiveFilter")}"`,
      );
      expect(html).toMatch(
        new RegExp(
          `role="radio" aria-checked="true"[^>]*><span[^>]*>${t("research.unarchived")}</span>`,
        ),
      );
      expect(html).toContain(t("projects.sessions.archived"));
      expect(html).toContain('type="search"');
      expect(html.indexOf('type="search"')).toBeLessThan(
        html.indexOf('role="radiogroup"'),
      );
      expect(html).toContain(`placeholder="${t("workspace.searchResearch")}"`);
      expect(html).toContain('href="#research/active"');
      expect(html).not.toContain('href="#research/archived"');
      expect(html).toContain(active.question);
      expect(html).toContain(active.progress!);
    });

    it(`${locale} keeps the archive filter reachable when no research matches`, () => {
      const html = render([archived]);
      expect(html).toContain(t("projects.noResearch"));
      expect(html).toContain(t("projects.sessions.archived"));
      expect(html).not.toContain('href="#research/');
    });
  }
});
