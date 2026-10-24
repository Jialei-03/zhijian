import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n/I18nProvider";
import { parseAppRoute } from "../../../app/routes";
import { CompareView, BatchResultsTable } from "./CompareView";
import {
  differs,
  type ComparisonThread,
  type EvaluationResults,
} from "./compare-api";

export const first: ComparisonThread = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "L2 regularization",
  workflow: "Review",
  status: "finished",
  conclusion: "L2 improves accuracy.",
  numbers: [{ name: "accuracy", value: 0.91 }],
  tokens: 1000,
  job_seconds: 90,
  elapsed_seconds: 9408,
  rounds: 2,
  members: [{ id: "executor", name: "executor", messages: 2, tokens: 1000 }],
};
export const second: ComparisonThread = {
  ...first,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Peer review",
  workflow: "Peers",
  numbers: [{ name: "accuracy", value: 0.95 }],
  tokens: 800,
  job_seconds: 6758,
};

describe("comparison contract views", () => {
  it("highlights differences without treating missing values as zero", () => {
    expect(differs([0, 2])).toBe(true);
    expect(differs([1, 1, undefined])).toBe(false);
    expect(differs([undefined, 0])).toBe(false);
  });
  for (const locale of ["zh", "en"] as const) {
    it(`${locale} renders comparable rows, links, roles and numeric differences`, () => {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(CompareView, {
            comparison: { threads: [first, second] },
          }),
        }),
      );
      expect(html).toContain(`href="#research/${first.id}"`);
      expect(html).toContain("L2 improves accuracy.");
      expect(html).toContain('data-different="true">0.91');
      expect(html).toContain('data-different="true">800');
      expect(html).toContain(locale === "zh" ? "成员参与" : "Participation");
      expect(html).toContain(locale === "zh" ? "执行者" : "Executor");
      expect(html).toContain(locale === "zh" ? "1 分 30 秒" : "1m 30s");
      expect(html).toContain(locale === "zh" ? "2 小时 37 分" : "2h 37m");
      expect(html).toContain(locale === "zh" ? "1 小时 53 分" : "1h 53m");
      expect(html).not.toContain("9,408");
      expect(html).not.toContain("undefined");
    });
  }
  it("renders the batch cross product by question and workflow", () => {
    const results: EvaluationResults = {
      id: "batch",
      workspace_id: "workspace",
      name: "Evaluation",
      questions: ["Does L2 help?"],
      workflows: [
        { id: "a", name: "Review" },
        { id: "b", name: "Peers" },
      ],
      created_at: "",
      cells: [
        { question: 0, workflow_id: "a", research_id: first.id },
        { question: 0, workflow_id: "b", research_id: second.id },
      ],
      threads: [first, second],
    };
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        locale: "en",
        children: createElement(BatchResultsTable, { results }),
      }),
    );
    expect(html).toContain("Does L2 help?");
    expect(html).toContain("0.91");
    expect(html).toContain("0.95");
    expect(html).toContain(`#research/${second.id}`);
    expect(html).toContain("2h 37m");
  });
  it("routes a workspace comparison without redirecting to the research list", () => {
    expect(parseAppRoute(`workspaces/${first.id}/compare`)).toEqual({
      screen: "workspaces",
      workspaceId: first.id,
      tab: "compare",
    });
  });
});
