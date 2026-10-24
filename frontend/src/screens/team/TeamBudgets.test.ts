import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import type { Team, TeamBudget } from "../research/team-api";
import { TeamBudgets } from "./TeamBudgets";

describe("team budgets", () => {
  for (const locale of ["zh", "en"] as const) {
    const { t } = createTranslator(locale);
    const render = (budget?: TeamBudget) =>
      renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(TeamBudgets, {
            team: {
              workspace_id: "team",
              members: [],
              channels: [],
              notifications: [],
              tokens: 25570999,
              budget,
            } as Team,
          }),
        }),
      );

    it(`${locale} starts without limits and formats used tokens`, () => {
      const html = render();
      expect(html).toContain(t("team.tokensUsed", { n: "25,570,999" }));
      expect(html).not.toContain('type="number"');
      expect(html).not.toContain(t("team.periodHours"));
      expect(html.match(/checked=""/g)).toHaveLength(2);
    });

    it(`${locale} displays finite values and keeps concurrency independent`, () => {
      const finite = render({
        max_tokens: 1000,
        max_concurrent: 2,
        period_hours: 12,
      });
      expect(finite.match(/type="number"/g)).toHaveLength(3);
      for (const n of [1000, 2, 12]) expect(finite).toContain(`value="${n}"`);
      const tokenOnly = render({
        max_tokens: 1000,
        max_concurrent: 0,
        period_hours: 12,
      });
      expect(tokenOnly.match(/type="number"/g)).toHaveLength(2);
      const concurrentOnly = render({
        max_tokens: 0,
        max_concurrent: 2,
        period_hours: 12,
      });
      expect(concurrentOnly.match(/type="number"/g)).toHaveLength(1);
      expect(concurrentOnly).not.toContain(t("team.periodHours"));
      expect(concurrentOnly).toContain(
        `aria-label="${t("team.tokenLimit")} ${t("team.unlimited")}"`,
      );
    });
  }
});
