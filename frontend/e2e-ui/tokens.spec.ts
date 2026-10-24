import { expect, test } from "@playwright/test";
import { contrastOfTokens, openKit } from "./helpers";

for (const theme of ["light", "dark"] as const) {
  test(`text tokens meet WCAG AA in ${theme}`, async ({ page }) => {
    await openKit(page, { theme });
    const pairs: [string, string[]][] = [
      ["--ui-fg", ["--ui-bg", "--ui-bg-1", "--ui-bg-2", "--ui-elev"]],
      ["--ui-fg-1", ["--ui-bg", "--ui-bg-1", "--ui-bg-2", "--ui-elev"]],
      ["--ui-fg-2", ["--ui-bg", "--ui-bg-1", "--ui-bg-2", "--ui-elev"]],
      ["--ui-fg-3", ["--ui-bg", "--ui-bg-1", "--ui-elev"]],
      ["--ui-accent-text", ["--ui-bg", "--ui-bg-1", "--ui-elev"]],
      ["--ui-danger-text", ["--ui-bg", "--ui-elev"]],
      ["--ui-success-text", ["--ui-bg", "--ui-elev"]],
      ["--ui-warning-text", ["--ui-bg", "--ui-elev"]],
      ["--ui-primary-fg", ["--ui-primary"]],
    ];
    for (const [fg, bgs] of pairs)
      for (const bg of bgs)
        expect(
          await contrastOfTokens(page, fg, bg),
          `${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
    // Orange text on the orange tint (the context label).
    expect(
      await contrastOfTokens(
        page,
        "--ui-accent-text",
        "--ui-accent-soft",
        "--ui-bg",
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test(`elevations have the ${theme} edge rings`, async ({ page }) => {
    await openKit(page, { theme });
    const shadows = await page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.append(probe);
      const values = [
        "ring-1",
        "ring-2",
        "elev-1",
        "elev-2",
        "elev-3",
        "elev-composer",
      ].map((name) => {
        probe.style.boxShadow = `var(--ui-${name})`;
        return getComputedStyle(probe).boxShadow;
      });
      probe.remove();
      return values;
    });
    const [ring1, ring2, attached, floating, modal, composer] = shadows;
    expect(attached).toContain(ring1);
    for (const shadow of [floating, modal, composer])
      expect(shadow).toContain(ring2);
    for (const ring of [ring1, ring2]) {
      expect(ring).not.toBe("none");
      expect(ring.includes("inset")).toBe(theme === "dark");
    }
    if (theme === "dark") {
      expect(ring1).toContain("rgba(255, 255, 255, 0.06)");
      expect(ring1).toContain("rgba(0, 0, 0, 0.4)");
      expect(ring2).toContain("rgba(255, 255, 255, 0.1)");
      expect(ring2).toContain("rgba(0, 0, 0, 0.5)");
    }
  });
}

test("layout and font features match the desktop reference", async ({
  page,
}) => {
  await openKit(page);
  const html = page.locator("html");
  for (const [token, value] of [
    ["--ui-sidebar-width", "264px"],
    ["--ui-sidebar-top", "52px"],
    ["--ui-settings-nav", "260px"],
    ["--ui-dialog-md", "540px"],
  ])
    await expect(html).toHaveCSS(token, value);
  await expect(html).toHaveCSS(
    "font-feature-settings",
    '"cv11", "ss03", "calt"',
  );
  await expect(html).toHaveCSS("font-optical-sizing", "auto");
  await expect(html).toHaveCSS("font-synthesis-weight", "none");
  await expect(html).toHaveCSS("text-autospace", "normal");
});
test("system appearance follows the OS live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/ui-kit.html");
  await page.evaluate(() => localStorage.setItem("paper-appearance", "system"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});
test("reduced motion zeroes the duration tokens", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openKit(page);
  const dur = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--ui-dur-2")
      .trim(),
  );
  expect(dur).toBe("0.01ms");
});
