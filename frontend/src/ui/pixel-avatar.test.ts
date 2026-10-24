import { describe, expect, it } from "vitest";
import { newAvatarSeed, pixelAvatar, pixelAvatarSvg } from "./pixel-avatar";

describe("pixel animals", () => {
  it("keeps each seed deterministic and distinguishes different seeds", () => {
    expect(pixelAvatar("Ada")).toEqual(pixelAvatar("Ada"));
    expect(pixelAvatarSvg("Ada")).toBe(pixelAvatarSvg("Ada"));
    expect(
      new Set(Array.from({ length: 100 }, (_, i) => pixelAvatarSvg(String(i))))
        .size,
    ).toBe(100);
    expect(newAvatarSeed()).toMatch(/^[a-z0-9]+$/);
  });

  it("produces a standalone SVG from generated shapes, including for markup-like seeds", () => {
    const svg = pixelAvatarSvg('</svg><script>alert("seed")</script>');
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="-2 -2.5 20 20" shape-rendering="crispEdges">/,
    );
    expect(svg).toMatch(/<rect[^>]+\/>/);
    expect(svg).toMatch(/<\/svg>$/);
    expect(svg.replace(/<svg[^>]+>|<rect[^>]+\/>|<\/svg>/g, "")).toBe("");
    expect(svg).not.toContain("script");
    expect(pixelAvatar("Ada").grid).toHaveLength(16);
    expect(pixelAvatar("Ada").grid.every((row) => row.length === 16)).toBe(
      true,
    );
  });
});
