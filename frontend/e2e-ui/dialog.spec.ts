import { expect, test, type Locator, type Page } from "@playwright/test";
import { contrast, openKit } from "./helpers";

const section = (page: Page) =>
  page.getByRole("region", { name: "Dialog", exact: true });
const opener = (page: Page, name: string) =>
  section(page).getByRole("button", { name, exact: true });
const rename = (page: Page) =>
  page.getByRole("dialog", { name: "Rename paper" });
const locked = (page: Page) =>
  page.getByRole("dialog", { name: "Discard changes?" });
const wide = (page: Page) =>
  page.getByRole("dialog", { name: "Paper details" });
const nameField = (page: Page) =>
  rename(page).getByRole("textbox", { name: "Name" });
const menu = (page: Page) => page.getByRole("menu", { name: "Item actions" });

/**
 * A dialog is still open once a close would have been over. Checked after the exit
 * (120ms) is done, because one on its way out still looks visible.
 */
async function expectOpen(page: Page, dialog: Locator) {
  await page.waitForTimeout(300);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty("open", true);
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
    true,
  );
}

/** A point on the backdrop: the dialog is in the middle, this is in the corner of the window. */
const pressBackdrop = (page: Page) => page.mouse.click(8, 8);

const cssOf = (locator: Locator, property: string) =>
  locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );

/** The four sides of a box property, as the browser computes them. */
const sidesOf = (locator: Locator, property: "padding") =>
  locator.evaluate((element, name) => {
    const style = getComputedStyle(element);
    return ["top", "right", "bottom", "left"].map((side) =>
      style.getPropertyValue(`${name}-${side}`),
    );
  }, property);

/** Wait for every running transition, so rectangles and colors are the settled ones. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        // A transition that is cut short (its element went away) has finished with it.
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );

/** What a CSS value (a token, say) computes to as the given property. */
const resolved = (page: Page, property: string, value: string) =>
  page.evaluate(
    ([name, css]) => {
      const probe = document.createElement("div");
      probe.style.setProperty(name, css);
      document.body.append(probe);
      const result = getComputedStyle(probe).getPropertyValue(name);
      probe.remove();
      return result;
    },
    [property, value] as const,
  );

const header = (dialog: Locator) =>
  dialog.getByRole("heading").locator("xpath=../..");
const footer = (dialog: Locator) =>
  dialog.getByRole("button", { name: "Save", exact: true }).locator("xpath=..");
const body = (dialog: Locator) =>
  dialog.getByRole("textbox", { name: "Name" }).locator("xpath=../../..");

const overflowOfPage = (page: Page) =>
  page.evaluate(() => document.documentElement.style.overflow);

test("opens modally with an accessible name and description", async ({
  page,
}) => {
  await openKit(page);
  await opener(page, "Open dialog").click();
  const dialog = rename(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(
    "The new name appears in your library.",
  );
  await expect(
    dialog.getByRole("heading", { name: "Rename paper" }),
  ).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
    true,
  );

  // The page behind it cannot be reached: the pointer lands on the backdrop, not on the button.
  const behind = page
    .getByRole("region", { name: "Menu", exact: true })
    .getByRole("button", { name: "More" });
  await behind.scrollIntoViewIfNeeded();
  expect(
    await behind.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const hit = document.elementFromPoint(x + width / 2, y + height / 2);
      return hit === element || element.contains(hit);
    }),
  ).toBe(false);
  await expect(behind.click({ trial: true, timeout: 1000 })).rejects.toThrow();
});

test("a dialog without a description has no description to point at", async ({
  page,
}) => {
  await openKit(page);
  await opener(page, "Open wide dialog").click();
  await expect(wide(page)).toBeVisible();
  await expect(wide(page)).not.toHaveAttribute("aria-describedby");
  await expect(wide(page)).toHaveAccessibleDescription("");
});

test("focus starts inside and returns to the opener", async ({ page }) => {
  await openKit(page);
  // The way a keyboard user does it.
  await opener(page, "Open dialog").focus();
  await page.keyboard.press("Enter");
  await expect(rename(page)).toBeVisible();
  await expect(nameField(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rename(page)).toBeHidden();
  await expect(opener(page, "Open dialog")).toBeFocused();

  // And with the pointer, closing from a footer button.
  await opener(page, "Open dialog").click();
  await expect(nameField(page)).toBeFocused();
  await rename(page).getByRole("button", { name: "Cancel" }).click();
  await expect(rename(page)).toBeHidden();
  await expect(opener(page, "Open dialog")).toBeFocused();
});

const summary = (page: Page) =>
  wide(page).getByRole("textbox", { name: "Summary" });

/** Take the named controls of the wide dialog out of reach (it is closed, and React leaves the attribute alone). */
const disableInWide = (page: Page, texts: string[]) =>
  page.evaluate((names) => {
    const dialog = [...document.querySelectorAll("dialog")].find((element) =>
      element.textContent?.includes("Paper details"),
    )!;
    for (const control of dialog.querySelectorAll<
      HTMLButtonElement | HTMLTextAreaElement
    >("textarea, button")) {
      const name =
        control instanceof HTMLTextAreaElement
          ? "textarea"
          : control.textContent;
      if (names.includes(name ?? "")) control.disabled = true;
    }
  }, texts);

test("initial focus: initialFocus, else data-autofocus, else the first control of the body", async ({
  page,
}) => {
  await openKit(page, { locale: "en" });
  // initialFocus: the safe choice of a dialog that asks about losing something.
  await opener(page, "Open locked dialog").click();
  await expect(
    locked(page).getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await locked(page).getByRole("button", { name: "Keep editing" }).click();
  await expect(locked(page)).toBeHidden();

  // Neither given: the first control in the body, not the close button that comes before it.
  await opener(page, "Open wide dialog").click();
  await expect(summary(page)).toBeFocused();
});

test("with nothing marked, a dialog opened by keyboard starts on its first control and one Escape closes it", async ({
  page,
}) => {
  await openKit(page, { locale: "en" });
  await opener(page, "Open wide dialog").focus();
  await page.keyboard.press("Enter");
  await expect(wide(page)).toBeVisible();
  await expect(summary(page)).toBeFocused();
  // Nothing was focused on the way that shows a tooltip, and none is left behind.
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(wide(page)).toBeHidden();
  await expect(opener(page, "Open wide dialog")).toBeFocused();
});

test("the focus falls through to the footer, and last of all to the close button", async ({
  page,
}) => {
  await openKit(page, { locale: "en" });
  // Nothing in the body to focus: the footer's first button.
  await disableInWide(page, ["textarea", "Discard changes"]);
  await opener(page, "Open wide dialog").click();
  await expect(
    wide(page).getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(wide(page)).toBeHidden();

  // Nothing in the footer either: the close button, as there is nothing else.
  await disableInWide(page, ["Cancel", "Save"]);
  await opener(page, "Open wide dialog").click();
  await expect(wide(page).getByRole("button", { name: "Close" })).toBeFocused();
});

test("Tab stays inside the dialog", async ({ page }) => {
  await openKit(page);
  await opener(page, "Open dialog").click();
  const dialog = rename(page);
  await expect(nameField(page)).toBeFocused();
  const visited = new Set<string>();
  for (const key of [
    ...Array<string>(6).fill("Tab"),
    ...Array<string>(6).fill("Shift+Tab"),
  ]) {
    await page.keyboard.press(key);
    const state = await dialog.evaluate((element) => ({
      inside: element.contains(document.activeElement),
      name:
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.textContent ??
        "",
    }));
    expect(state.inside, `after ${key}`).toBe(true);
    visited.add(state.name);
  }
  // It really went round: close, the field, the menu button, Cancel and Save.
  expect(visited.size).toBeGreaterThanOrEqual(4);
});

test("a click on the backdrop closes it and gives the focus back", async ({
  page,
}) => {
  await openKit(page);
  await opener(page, "Open dialog").click();
  await expect(rename(page)).toBeVisible();
  // On the dialog itself, nothing happens.
  await rename(page).getByRole("heading").click();
  await expectOpen(page, rename(page));

  await pressBackdrop(page);
  await expect(rename(page)).toBeHidden();
  await expect(opener(page, "Open dialog")).toBeFocused();
});

test("a drag that starts in the dialog and ends on the backdrop does not close it", async ({
  page,
}) => {
  await openKit(page);
  await opener(page, "Open dialog").click();
  const box = (await nameField(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(8, 8, { steps: 6 });
  await page.mouse.up();
  await expectOpen(page, rename(page));

  // The other way round: pressed on the backdrop, released inside.
  await page.mouse.move(8, 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expectOpen(page, rename(page));
});

test("an open tooltip does not swallow the first press on the backdrop", async ({
  page,
}) => {
  await openKit(page, { locale: "en" });
  await opener(page, "Open wide dialog").click();
  // Onto the close button by keyboard, however the focus started: its tooltip shows at once.
  const close = wide(page).getByRole("button", { name: "Close" });
  await close.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await expect(page.locator('[role="tooltip"]')).toBeVisible();

  await pressBackdrop(page);
  await expect(wide(page)).toBeHidden();
  await expect(opener(page, "Open wide dialog")).toBeFocused();
});

test("the close button closes it", async ({ page }) => {
  await openKit(page, { locale: "en" });
  await opener(page, "Open dialog").click();
  await rename(page).getByRole("button", { name: "Close" }).click();
  await expect(rename(page)).toBeHidden();
  await expect(opener(page, "Open dialog")).toBeFocused();
});

test("the close button is named in the interface language", async ({
  page,
}) => {
  await openKit(page, { locale: "zh" });
  await opener(page, "Open dialog").click();
  await rename(page).getByRole("button", { name: "关闭" }).click();
  await expect(rename(page)).toBeHidden();
});

test("a locked dialog ignores Escape and the backdrop; only its buttons close it", async ({
  page,
}) => {
  await openKit(page, { locale: "en" });
  await opener(page, "Open locked dialog").click();
  const dialog = locked(page);
  await expect(dialog).toBeVisible();
  // No close button: it is not a way out.
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);

  // More than once: a browser may close a dialog on a repeated Escape by itself.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await pressBackdrop(page);
  await expectOpen(page, dialog);

  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener(page, "Open locked dialog")).toBeFocused();
});

test("page scroll is locked while open and comes back after", async ({
  page,
}) => {
  await openKit(page);
  // The sample window is as high as the window, so the page does not scroll by itself: give it room to.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "1500px";
    document.body.append(spacer);
  });
  await opener(page, "Open dialog").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 150));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBe(150);
  expect(await overflowOfPage(page)).toBe("");

  await opener(page, "Open dialog").click();
  await expect(rename(page)).toBeVisible();
  expect(await overflowOfPage(page)).toBe("hidden");
  await page.mouse.move(8, 8);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

  await page.keyboard.press("Escape");
  await expect(rename(page)).toBeHidden();
  expect(await overflowOfPage(page)).toBe("");
  await page.mouse.wheel(0, -600);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeLessThan(scrolled);
});

test("dialogs stack: the page stays locked until the last one closes", async ({
  page,
}) => {
  await openKit(page, { locale: "en" });
  // A value that was there before is the one that comes back.
  await page.evaluate(() => {
    document.documentElement.style.overflow = "auto";
  });
  await opener(page, "Open wide dialog").click();
  await expect(wide(page)).toBeVisible();
  expect(await overflowOfPage(page)).toBe("hidden");

  const discard = wide(page).getByRole("button", {
    name: "Discard changes",
    exact: true,
  });
  await discard.click();
  await expect(locked(page)).toBeVisible();
  expect(await overflowOfPage(page)).toBe("hidden");
  // Escape is for the one on top, and that one is locked.
  await page.keyboard.press("Escape");
  await expectOpen(page, locked(page));
  await expectOpen(page, wide(page));

  await locked(page).getByRole("button", { name: "Keep editing" }).click();
  await expect(locked(page)).toBeHidden();
  await expect(wide(page)).toBeVisible();
  // The one underneath is usable again, and has its focus back.
  await expect(discard).toBeFocused();
  expect(await overflowOfPage(page)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(wide(page)).toBeHidden();
  expect(await overflowOfPage(page)).toBe("auto");
  await expect(opener(page, "Open wide dialog")).toBeFocused();
});

test("a menu in the dialog opens above it and works with the pointer", async ({
  page,
}) => {
  await openKit(page);
  await opener(page, "Open dialog").click();
  const trigger = rename(page).getByRole("button", { name: "More" });
  await trigger.click();
  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(rename(page).getByText("Selected: Duplicate")).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expectOpen(page, rename(page));
  await expect(trigger).toBeFocused();
});

test("a press on the backdrop closes an open menu first, not the dialog", async ({
  page,
}) => {
  await openKit(page);
  await opener(page, "Open dialog").click();
  await rename(page).getByRole("button", { name: "More" }).click();
  await expect(menu(page)).toBeVisible();

  await pressBackdrop(page);
  await expect(menu(page)).toHaveCount(0);
  await expectOpen(page, rename(page));

  await pressBackdrop(page);
  await expect(rename(page)).toBeHidden();
});

test("the measurements are the design's", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openKit(page);
  await opener(page, "Open dialog").click();
  const dialog = rename(page);
  await expect(dialog).toBeVisible();
  await settled(page);

  const widthOf = async (target: Locator) =>
    (await target.boundingBox())!.width;
  expect(await widthOf(dialog)).toBe(540);
  expect(await cssOf(dialog, "border-top-left-radius")).toBe("24px");
  expect(await cssOf(dialog, "background-color")).toBe(
    await resolved(page, "background-color", "var(--ui-elev)"),
  );
  expect(await cssOf(dialog, "box-shadow")).toBe(
    await resolved(page, "box-shadow", "var(--ui-elev-3)"),
  );

  expect(await sidesOf(header(dialog), "padding")).toEqual([
    "20px",
    "20px",
    "8px",
    "20px",
  ]);
  const title = dialog.getByRole("heading", { name: "Rename paper" });
  expect(await cssOf(title, "font-size")).toBe("16px");
  expect(await cssOf(title, "font-weight")).toBe("600");
  const description = dialog.getByText("The new name appears in your library.");
  expect(await cssOf(description, "font-size")).toBe("13px");
  expect(await cssOf(description, "color")).toBe(
    await resolved(page, "color", "var(--ui-fg-2)"),
  );

  expect(await sidesOf(body(dialog), "padding")).toEqual([
    "8px",
    "20px",
    "8px",
    "20px",
  ]);
  expect(await sidesOf(footer(dialog), "padding")).toEqual([
    "16px",
    "20px",
    "20px",
    "20px",
  ]);
  expect(await cssOf(footer(dialog), "justify-content")).toBe("flex-end");
  expect(await cssOf(footer(dialog), "column-gap")).toBe("8px");
  // The buttons are at the right edge, inside the padding.
  const [save, frame] = await Promise.all([
    dialog.getByRole("button", { name: "Save" }).boundingBox(),
    dialog.boundingBox(),
  ]);
  expect(frame!.x + frame!.width - (save!.x + save!.width)).toBeCloseTo(20, 0);

  // It is centered in the window.
  const viewport = page.viewportSize()!;
  expect(frame!.x + frame!.width / 2).toBeCloseTo(viewport.width / 2, 0);
  expect(frame!.y + frame!.height / 2).toBeCloseTo(viewport.height / 2, 0);
});

test("the sizes are 400, 540 and 720 and never wider than the window less 32px", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openKit(page);
  const widthOf = async (target: Locator) =>
    (await target.boundingBox())!.width;

  await opener(page, "Open locked dialog").click();
  await expect(locked(page)).toBeVisible();
  await settled(page);
  expect(await widthOf(locked(page))).toBe(400);
  await locked(page).getByRole("button", { name: "Keep editing" }).click();
  await expect(locked(page)).toBeHidden();

  await opener(page, "Open wide dialog").click();
  await expect(wide(page)).toBeVisible();
  await settled(page);
  expect(await widthOf(wide(page))).toBe(720);
  await page.keyboard.press("Escape");
  await expect(wide(page)).toBeHidden();

  await page.setViewportSize({ width: 360, height: 700 });
  await opener(page, "Open wide dialog").click();
  await expect(wide(page)).toBeVisible();
  await settled(page);
  expect(await widthOf(wide(page))).toBe(328);
});

test("a tall dialog keeps its header and footer and scrolls its body", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 800, height: 360 });
  await openKit(page);
  await opener(page, "Open wide dialog").click();
  await expect(wide(page)).toBeVisible();
  await settled(page);
  const box = (await wide(page).boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(360);
  // Even when the content is taller than the window, the buttons stay in it.
  const save = (await wide(page)
    .getByRole("button", { name: "Save" })
    .boundingBox())!;
  expect(save.y + save.height).toBeLessThanOrEqual(360);
});

for (const [theme, shade] of [
  ["light", "rgba(40, 30, 20, 0.18)"],
  ["dark", "rgba(0, 0, 0, 0.54)"],
] as const) {
  test(`the backdrop shades the page in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openKit(page, { theme });
    await opener(page, "Open dialog").click();
    await expect(rename(page)).toBeVisible();
    await settled(page);
    expect(
      await rename(page).evaluate(
        (element) => getComputedStyle(element, "::backdrop").backgroundColor,
      ),
    ).toBe(shade);
  });

  test(`title and description meet WCAG AA in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openKit(page, { theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await opener(page, "Open dialog").click();
    const dialog = rename(page);
    await expect(dialog).toBeVisible();
    await settled(page);
    const base = await cssOf(dialog, "background-color");
    for (const target of [
      dialog.getByRole("heading", { name: "Rename paper" }),
      dialog.getByText("The new name appears in your library."),
    ]) {
      expect(
        await contrast(page, await cssOf(target, "color"), base),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("it fades and scales in, and out", async ({ page }) => {
  await openKit(page);
  // Read in the task after the click, when React has just shown or closed it: the very start of each transition, not a matter of frame timing.
  const trace = await page.evaluate(async () => {
    const find = (selector: string, text: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find((element) =>
        element.textContent?.includes(text),
      )!;
    const dialog = find("dialog", "Rename paper");
    const read = () => {
      const style = getComputedStyle(dialog);
      const moving = dialog
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => ({
          property: animation.transitionProperty,
          duration: Number(animation.effect?.getTiming().duration),
        }));
      return {
        opacity: Number(style.opacity),
        transform: style.transform,
        display: style.display,
        moving,
      };
    };
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const before = read();
    find("button", "Open dialog").click();
    await wait(0);
    const entering = read();
    await wait(500);
    const entered = read();
    [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel")!
      .click();
    await wait(0);
    const leaving = read();
    await wait(500);
    const left = read();
    return { before, entering, entered, leaving, left };
  });

  expect(trace.before.display).toBe("none");
  // In: it starts clear and slightly small, takes 180ms for both, and ends whole.
  expect(trace.entering.opacity).toBeLessThan(0.5);
  expect(trace.entering.transform).toMatch(/^matrix\(0\.9\d*, /);
  for (const property of ["opacity", "transform"])
    expect(trace.entering.moving).toContainEqual({ property, duration: 180 });
  expect(trace.entered.opacity).toBe(1);
  expect(trace.entered.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
  // Out: it is still there while it fades, in 120ms, and then gone.
  expect(trace.leaving.display).not.toBe("none");
  for (const property of ["opacity", "transform"])
    expect(trace.leaving.moving).toContainEqual({ property, duration: 120 });
  expect(trace.left.display).toBe("none");
});

test("in takes the longer duration, out the shorter, both with the shared easing; reduced motion makes both instant", async ({
  page,
}) => {
  await openKit(page);
  const open = await resolved(page, "transition-duration", "var(--ui-dur-2)");
  const close = await resolved(page, "transition-duration", "var(--ui-dur-1)");
  const ease = await resolved(
    page,
    "transition-timing-function",
    "var(--ui-ease-out)",
  );
  expect(open).not.toBe(close);

  const dialog = page.locator("dialog").first();
  const motionOf = () =>
    dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        durations: style.transitionDuration.split(", "),
        behavior: style.transitionBehavior,
        property: style.transitionProperty,
        easing: style.transitionTimingFunction,
      };
    });

  // Closed, which is how it leaves.
  const out = await motionOf();
  expect(out.durations.every((value) => value === close)).toBe(true);
  expect(out.behavior).toContain("allow-discrete");
  expect(out.property).toContain("opacity");
  expect(out.property).toContain("transform");
  // One easing for each of the properties.
  expect(out.easing.split(ease).length - 1).toBe(
    out.property.split(", ").length,
  );

  // Open, which is how it arrives.
  await opener(page, "Open dialog").click();
  await expect(rename(page)).toBeVisible();
  const into = await motionOf();
  expect(into.durations.every((value) => value === open)).toBe(true);
  expect(into.easing.split(ease).length - 1).toBe(
    into.property.split(", ").length,
  );

  await page.keyboard.press("Escape");
  await expect(rename(page)).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await opener(page, "Open dialog").click();
  await expect(rename(page)).toBeVisible();
  const instant = await motionOf();
  expect(instant.durations.every((value) => parseFloat(value) < 0.001)).toBe(
    true,
  );
});
