import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { RecentReading } from "./SectionNavigation";
import {
  MESSAGE_FIRST,
  PAGE_MORE,
  pageRows,
  READING_FIRST,
  readSidebarPage,
  sidebarPageKey,
  SidebarPagination,
} from "./sidebar-pagination";

afterEach(() => vi.unstubAllGlobals());

describe("sidebar pagination", () => {
  it("pages by twenty and retains important rows in activity order without duplicates", () => {
    const items = Array.from({ length: 55 }, (_, index) => index);
    const keep = (index: number) => [1, 40, 42, 54].includes(index);
    expect(pageRows(items, MESSAGE_FIRST, keep)).toEqual({
      rows: [0, 1, 2, 3, 4, 5, 6, 7, 40, 42, 54],
      hidden: 44,
    });
    expect(pageRows(items, MESSAGE_FIRST + PAGE_MORE, keep).rows).toHaveLength(
      31,
    );
    expect(pageRows(items, 100, keep)).toEqual({ rows: items, hidden: 0 });
    expect(pageRows([], READING_FIRST, keep)).toEqual({ rows: [], hidden: 0 });
    expect(pageRows(items, MESSAGE_FIRST, () => true).hidden).toBe(0);
  });

  it("restores validated limits separately per owner, project and list", () => {
    const key = sidebarPageKey("owner", "project", "messages");
    const saved = new Map([[key, "28"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
    });
    expect(readSidebarPage(key, MESSAGE_FIRST)).toBe(28);
    for (const other of [
      sidebarPageKey("other", "project", "messages"),
      sidebarPageKey("owner", "other", "messages"),
      sidebarPageKey("owner", "project", "recent"),
    ])
      expect(readSidebarPage(other, MESSAGE_FIRST)).toBe(MESSAGE_FIRST);
    for (const value of ["null", "Infinity", "-1", "1.5", "7", "{}"]) {
      saved.set(key, value);
      expect(readSidebarPage(key, MESSAGE_FIRST)).toBe(MESSAGE_FIRST);
    }
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
    });
    expect(readSidebarPage(key, MESSAGE_FIRST)).toBe(MESSAGE_FIRST);
  });

  for (const locale of ["zh", "en"] as const) {
    const render = (children: ReturnType<typeof createElement>) =>
      renderToStaticMarkup(createElement(I18nProvider, { locale, children }));
    it(`${locale} renders plural labels, another page and collapse independently`, () => {
      for (const count of [1, 20]) {
        const html = render(
          createElement(SidebarPagination, {
            list: "messages",
            first: 8,
            limit: 28,
            hidden: count,
            choose() {},
          }),
        );
        expect(html).toContain(
          locale === "zh" ? `再显示 ${count} 个` : `Show ${count} more`,
        );
        expect(html).toContain('data-id="messages-less"');
      }
      expect(
        render(
          createElement(SidebarPagination, {
            list: "messages",
            first: 8,
            limit: 8,
            hidden: 0,
            choose() {},
          }),
        ),
      ).toBe("");
      const last = render(
        createElement(SidebarPagination, {
          list: "messages",
          first: 8,
          limit: 28,
          hidden: 0,
          choose() {},
        }),
      );
      expect(last).not.toContain('data-id="messages-more"');
      expect(last).toContain('data-id="messages-less"');
    });

    it(`${locale} keeps the open paper beyond the first five recent papers`, () => {
      const reading = Array.from({ length: 9 }, (_, index) => ({
        id: `paper-${index}`,
        title: `Paper ${index}`,
      }));
      const html = render(
        createElement(RecentReading, {
          reading,
          route: { screen: "reader", reader: { paperId: "paper-8" } },
          hash: "read/paper-8",
          go() {},
        }),
      );
      expect(html.match(/data-id="recent-paper"/g)).toHaveLength(6);
      expect(html).toContain("Paper 8");
      expect(html).not.toContain("Paper 6");
      expect(html).toContain(locale === "zh" ? "再显示 3 个" : "Show 3 more");
    });
  }
});
