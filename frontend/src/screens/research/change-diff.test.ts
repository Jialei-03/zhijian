import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { RoundChangesCard } from "./ChangeCards";
import { ReviewFile, UnifiedDiff } from "./ReviewChanges";
import { initiallyExpanded, unifiedLines } from "./change-diff";

const diff =
  "diff --git a/src/a.ts b/src/a.ts\nindex abc..def 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5,3 +5,4 @@\n same\n-old\n+new\n+\n end\n@@ -20 +21 @@\n-last\n+next\n\\ No newline at end of file\n";
const file = { path: "src/a.ts", added: 3, removed: 2, diff };
const render = (child: ReactElement, locale: "zh" | "en" = "en") =>
  renderToStaticMarkup(
    createElement(I18nProvider, { locale, children: child }),
  );

describe("research review", () => {
  it("numbers both sides, resets at each hunk and excludes patch headers", () => {
    const lines = unifiedLines(diff);
    expect(lines.map(({ kind, old, next }) => [kind, old, next])).toEqual([
      ["hunk", null, null],
      ["context", 5, 5],
      ["del", 6, null],
      ["add", null, 6],
      ["add", null, 7],
      ["context", 7, 8],
      ["hunk", null, null],
      ["del", 20, null],
      ["add", null, 21],
      ["meta", null, null],
    ]);
    expect(lines.some((line) => line.text.startsWith("index "))).toBe(false);
  });

  it("handles new files, deleted files and partial patches without inventing line numbers", () => {
    expect(
      unifiedLines("@@ -0,0 +1,2 @@\n+first\n+second")
        .slice(1)
        .map((line) => [line.old, line.next]),
    ).toEqual([
      [null, 1],
      [null, 2],
    ]);
    expect(
      unifiedLines("@@ -1,2 +0,0 @@\n-first\n-second\n")
        .slice(1)
        .map((line) => [line.old, line.next]),
    ).toEqual([
      [1, null],
      [2, null],
    ]);
    expect(unifiedLines("-old\n+new")).toEqual([
      { kind: "del", old: null, next: null, text: "-old" },
      { kind: "add", old: null, next: null, text: "+new" },
    ]);
    expect(unifiedLines("")).toEqual([]);
  });

  it("preserves content that resembles a file header inside a hunk", () => {
    expect(
      unifiedLines("@@ -1 +1 @@\n--- old\n+++ new")
        .slice(1)
        .map((line) => line.kind),
    ).toEqual(["del", "add"]);
  });

  it("renders a unified diff with two number gutters and semantic row colors", () => {
    const html = render(createElement(UnifiedDiff, { diff }));
    expect(html).toContain('data-kind="del"');
    expect(html).toContain('data-kind="add"');
    expect(html).toContain('aria-hidden="true">20</span>');
    expect(html).toContain('aria-hidden="true">21</span>');
    expect(html).not.toContain("diff --git");
  });

  it("starts large, binary and truncated files folded without cutting their data", () => {
    const large = {
      ...file,
      diff: "@@ -0,0 +1,250 @@\n" + "+line\n".repeat(250),
    };
    expect(initiallyExpanded(file)).toBe(true);
    for (const folded of [
      large,
      { ...file, binary: true },
      { ...file, truncated: true },
    ]) {
      expect(initiallyExpanded(folded)).toBe(false);
      const html = render(
        createElement(ReviewFile, { file: folded, onOpen() {} }),
      );
      expect(html).not.toContain('open=""');
      expect(html).not.toContain("<pre");
      expect(html).toContain('aria-label="Open file"');
    }
    expect(unifiedLines(large.diff)).toHaveLength(251);
  });

  it("shows three file rows before an expandable remainder and uses both plural forms", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      ...file,
      path: `src/file-${i}.ts`,
    }));
    const html = render(
      createElement(RoundChangesCard, {
        changes: { added: 15, removed: 10, files },
        onReview() {},
      }),
    );
    expect(html).toContain("Changed 5 files");
    expect(html.split("<details")[0]).toContain("file-2.ts");
    expect(html.split("<details")[0]).not.toContain("file-3.ts");
    expect(html).toContain("2 more files");
    expect(html).toContain("file-4.ts");
    expect(
      render(
        createElement(RoundChangesCard, {
          changes: { added: 3, removed: 2, files: [file] },
          onReview() {},
        }),
      ),
    ).toContain("Changed 1 file");
    expect(
      render(
        createElement(RoundChangesCard, {
          changes: { added: 3, removed: 2, files: [file] },
          onReview() {},
        }),
        "zh",
      ),
    ).toContain("改了 1 个文件");
  });

  it("omits empty rounds and distinguishes directory prefixes from filenames", () => {
    expect(
      render(
        createElement(RoundChangesCard, {
          changes: { added: 0, removed: 0, files: [] },
          onReview() {},
        }),
      ),
    ).toBe("");
    const html = render(createElement(ReviewFile, { file, onOpen() {} }));
    expect(html).toContain("<span>src/</span><span>a.ts</span>");
    expect(html).toContain('open=""');
  });
});
