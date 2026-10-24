import { describe, expect, it } from "vitest";
import { PLACES, sidebarId } from "./sidebar-entries";

describe("sidebar entry registry", () => {
  it("has unique places and globally unambiguous, typed entry ids", () => {
    const ids = Object.values(PLACES).flat();
    expect(new Set(ids).size).toBe(ids.length);
    for (const [place, entries] of Object.entries(PLACES)) {
      expect(place).toMatch(/^[a-z]+$/);
      expect(entries.length).toBeGreaterThan(0);
      for (const id of entries) {
        expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
        expect(sidebarId(id)).toBe(id);
      }
    }
  });

  it("keeps the rail independent of sidebar contents", () => {
    expect(PLACES.rail).toEqual([
      "collapse",
      "research",
      "materials",
      "tasks",
      "customize",
      "settings",
    ]);
    expect(PLACES.rail).not.toContain("new-research");
    expect(PLACES.rail).not.toContain("search");
    expect(PLACES.research).toEqual([
      "workspace",
      "search",
      "new-research",
      "threads",
      "activity",
      "work",
    ]);
  });
});
