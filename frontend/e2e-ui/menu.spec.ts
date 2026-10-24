import { expect, test, type Locator, type Page } from "@playwright/test";
import { contrast, openKit, scrollAncestorBy } from "./helpers";

const section = (page: Page) =>
  page.getByRole("region", { name: "Menu", exact: true });
const more = (page: Page) =>
  section(page).getByRole("button", { name: "More" });
const menu = (page: Page) => page.getByRole("menu", { name: "Item actions" });
const item = (page: Page, name: string) =>
  page.getByRole("menuitem", { name, exact: true });
const selected = (page: Page, label: string) =>
  section(page).getByText(`Selected: ${label}`);
const cssOf = (locator: Locator, property: string) =>
  locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );

/** Wait for finite transitions and menu animations before reading settled geometry. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );

/** A CSS color (a token, say) as the browser computes it for a background. */
const resolved = (page: Page, css: string) =>
  page.evaluate((value) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, css);

/** Open the kit's menu the way a keyboard user does: focus the button, press ArrowDown. */
async function openWithKeyboard(page: Page) {
  await openKit(page);
  await more(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Rename")).toBeFocused();
}

test("opens with the keyboard and focuses the first item", async ({ page }) => {
  await openKit(page);
  const trigger = more(page);
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(menu(page)).toHaveCount(0);

  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Rename")).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // The button points at the list it opened.
  const id = await menu(page).getAttribute("id");
  expect(id).toBeTruthy();
  await expect(trigger).toHaveAttribute("aria-controls", id!);
});

test("Enter and Space open it on the first item, ArrowUp on the last", async ({
  page,
}) => {
  await openKit(page);
  for (const [key, name] of [
    ["Enter", "Rename"],
    ["Space", "Rename"],
    ["ArrowUp", "Delete"],
  ] as const) {
    await more(page).focus();
    await page.keyboard.press(key);
    await expect(item(page, name)).toBeFocused();
    await expect(more(page)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(more(page)).toBeFocused();
  }
});

test("a click opens it on the first item and a second click closes it", async ({
  page,
}) => {
  await openKit(page);
  await more(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(item(page, "Rename")).toBeFocused();
  // The button counts as part of the menu: pressing it is a toggle, not a dismissal and a reopening.
  await more(page).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  await expect(more(page)).toBeFocused();
});

test("the list, its items and its separator are described for assistive technology", async ({
  page,
}) => {
  await openWithKeyboard(page);
  const list = menu(page);
  await expect(list).toHaveAttribute("aria-orientation", "vertical");
  // The text includes the shortcut that is drawn; the accessible name does not.
  await expect(list.getByRole("menuitem")).toHaveText([
    /^Rename/,
    /^Duplicate/,
    /^Archive/,
    /^Delete/,
  ]);
  for (const name of ["Rename", "Duplicate", "Archive", "Delete"])
    await expect(item(page, name)).toHaveAttribute("tabindex", "-1");
  await expect(item(page, "Archive")).toHaveAttribute("aria-disabled", "true");
  await expect(item(page, "Duplicate")).not.toHaveAttribute("aria-disabled");
  await expect(list.getByRole("separator")).toHaveCount(1);
  // Only the one that has a shortcut announces it.
  await expect(item(page, "Duplicate")).not.toHaveAttribute(
    "aria-keyshortcuts",
  );
});

test("it opens below the button, level with its start edge, in the top layer", async ({
  page,
}) => {
  await openKit(page);
  // Scrolled up the card, so that there is room below the button.
  await scrollAncestorBy(
    more(page),
    (await more(page).evaluate((el) => el.getBoundingClientRect().top)) - 200,
  );
  await more(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Rename")).toBeFocused();
  await settled(page);
  const [list, trigger] = await Promise.all([
    menu(page).evaluate((el) => el.getBoundingClientRect().toJSON()),
    more(page).evaluate((el) => el.getBoundingClientRect().toJSON()),
  ]);
  expect(list.top).toBeGreaterThanOrEqual(trigger.bottom);
  expect(Math.abs(list.left - trigger.left)).toBeLessThanOrEqual(1);
  expect(
    await menu(page).evaluate(
      (el) => !!el.parentElement?.matches(":popover-open"),
    ),
  ).toBe(true);
});

test("arrow keys skip disabled items and wrap", async ({ page }) => {
  await openWithKeyboard(page);
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Duplicate")).toBeFocused();
  // Archive is disabled and the separator is not an item: on to Delete.
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Delete")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Rename")).toBeFocused();
  // And back the other way round.
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "Delete")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "Duplicate")).toBeFocused();
});

test("Home and End go to the first and last item", async ({ page }) => {
  await openWithKeyboard(page);
  await page.keyboard.press("End");
  await expect(item(page, "Delete")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(item(page, "Rename")).toBeFocused();
});

test("typeahead jumps to the matching item", async ({ page }) => {
  await openWithKeyboard(page);
  await page.keyboard.press("d");
  await expect(item(page, "Duplicate")).toBeFocused();
  // The buffer is cleared after a pause: a new "d" is a new search, which starts after the current item.
  await page.waitForTimeout(600);
  await page.keyboard.press("d");
  await expect(item(page, "Delete")).toBeFocused();
  await page.waitForTimeout(600);
  await page.keyboard.press("d");
  await expect(item(page, "Duplicate")).toBeFocused();
});

test("typeahead builds a prefix, skips disabled items and ignores letters that match nothing", async ({
  page,
}) => {
  await openWithKeyboard(page);
  // "d" then "e" quickly is the prefix "de": Delete, not Duplicate.
  await page.keyboard.press("d");
  await expect(item(page, "Duplicate")).toBeFocused();
  await page.keyboard.press("e");
  await expect(item(page, "Delete")).toBeFocused();
  await page.waitForTimeout(600);

  // Archive is disabled: it is never a match.
  await page.keyboard.press("a");
  await expect(item(page, "Delete")).toBeFocused();
  await page.waitForTimeout(600);
  await page.keyboard.press("x");
  await expect(item(page, "Delete")).toBeFocused();
  await expect(menu(page)).toBeVisible();
});

test("Enter selects, closes and returns focus", async ({ page }) => {
  await openWithKeyboard(page);
  await page.keyboard.press("Enter");
  await expect(selected(page, "Rename")).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).toBeFocused();
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
});

test("Space selects too", async ({ page }) => {
  await openWithKeyboard(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(selected(page, "Duplicate")).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).toBeFocused();
  // The key was handled on the way down: the button did not take it as its own press.
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
});

test("a click on an item selects it and closes the menu", async ({ page }) => {
  await openKit(page);
  await more(page).click();
  await item(page, "Delete").click();
  await expect(selected(page, "Delete")).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).toBeFocused();
});

test("a disabled item does nothing and does not take the focus", async ({
  page,
}) => {
  await openWithKeyboard(page);
  await item(page, "Archive").click({ force: true });
  await expect(menu(page)).toBeVisible();
  await expect(section(page).getByText(/^Selected: Archive/)).toHaveCount(0);
  await expect(item(page, "Rename")).toBeFocused();
  // Nor does the keyboard get to it by typing.
  await page.keyboard.press("Enter");
  await expect(selected(page, "Rename")).toBeVisible();
});

test("Escape closes and returns focus", async ({ page }) => {
  await openWithKeyboard(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).toBeFocused();
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  await expect(section(page).getByText(/^Selected: [A-Z]/)).toHaveCount(0);
});

test("click outside closes without moving focus to the trigger", async ({
  page,
}) => {
  await openKit(page);
  await more(page).click();
  await expect(menu(page)).toBeVisible();
  await page.getByRole("heading", { name: "Menu", exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).not.toBeFocused();
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");

  // Another control that is pressed gets the focus, not the button the menu came from.
  await more(page).click();
  await expect(menu(page)).toBeVisible();
  const clear = section(page).getByRole("button", { name: "Clear" });
  await clear.click();
  await expect(menu(page)).toHaveCount(0);
  await expect(clear).toBeFocused();
});

for (const key of ["Tab", "Shift+Tab"]) {
  test(`${key} closes the menu and lets the focus move on`, async ({
    page,
  }) => {
    await openWithKeyboard(page);
    await page.keyboard.press(key);
    await expect(menu(page)).toHaveCount(0);
    await expect(more(page)).toHaveAttribute("aria-expanded", "false");
    // Not trapped, not dropped on the page, and not left on the button either.
    await expect(more(page)).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      "BUTTON",
    );
  });
}

test("shortcut is announced", async ({ page }) => {
  await openWithKeyboard(page);
  const rename = item(page, "Rename");
  await expect(rename).toHaveAttribute("aria-keyshortcuts", "r");
  // It is also shown, but not read out twice.
  await expect(rename.locator("kbd")).toHaveText("R");
  await expect(rename.locator("kbd")).toHaveAttribute("aria-hidden", "true");
});

test("hovering an item makes it the current one", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWithKeyboard(page);
  await item(page, "Duplicate").hover();
  await expect(item(page, "Duplicate")).toBeFocused();
  await settled(page);
  expect(await cssOf(item(page, "Duplicate"), "background-color")).toBe(
    await resolved(page, "var(--ui-selected)"),
  );
  // Only one is highlighted at a time.
  expect(await cssOf(item(page, "Rename"), "background-color")).toBe(
    "rgba(0, 0, 0, 0)",
  );
  // A disabled one is not highlighted, and is not made current.
  await item(page, "Archive").hover();
  await expect(item(page, "Duplicate")).toBeFocused();
  expect(await cssOf(item(page, "Archive"), "background-color")).toBe(
    "rgba(0, 0, 0, 0)",
  );
});

test("the measurements are the design's", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWithKeyboard(page);
  const list = menu(page);
  const rename = item(page, "Rename");
  expect(await cssOf(list, "min-width")).toBe("180px");
  expect(await cssOf(list, "border-top-left-radius")).toBe("16px");
  expect(await cssOf(list, "padding-top")).toBe("6px");
  expect(await cssOf(list, "background-color")).toBe(
    await resolved(page, "var(--ui-elev)"),
  );
  expect(await cssOf(rename, "min-height")).toBe("34px");
  expect(await cssOf(rename, "height")).toBe("34px");
  expect(await cssOf(rename, "font-size")).toBe("14px");
  expect(await cssOf(rename, "padding-top")).toBe("5px");
  expect(await cssOf(rename, "padding-bottom")).toBe("5px");
  expect(await cssOf(rename, "padding-left")).toBe("10px");
  expect(await cssOf(rename, "padding-right")).toBe("10px");
  expect(await cssOf(rename, "border-top-left-radius")).toBe("8px");
  const separator = list.getByRole("separator");
  expect(await cssOf(separator, "height")).toBe("1px");
  expect(await cssOf(separator, "margin-top")).toBe("4px");
  expect(await cssOf(separator, "margin-bottom")).toBe("4px");
  expect(await cssOf(separator, "margin-left")).toBe("6px");
  expect(await cssOf(separator, "margin-right")).toBe("6px");
  expect(await cssOf(separator, "background-color")).toBe(
    await resolved(page, "var(--ui-edge-subtle)"),
  );
  // The current item takes the strong text color; a dangerous one keeps its own.
  expect(await cssOf(rename, "color")).toBe(
    await resolved(page, "var(--ui-fg)").then((c) => c),
  );
  expect(await cssOf(rename.locator("svg"), "color")).toBe(
    await resolved(page, "var(--ui-fg-1)"),
  );
  expect(await cssOf(item(page, "Duplicate").locator("svg"), "color")).toBe(
    await resolved(page, "var(--ui-fg-3)"),
  );
  await page.keyboard.press("End");
  expect(await cssOf(item(page, "Delete"), "color")).toBe(
    await resolved(page, "var(--ui-danger-text)"),
  );
  // The resting color of an item that is not current.
  expect(await cssOf(item(page, "Duplicate"), "color")).toBe(
    await resolved(page, "var(--ui-fg)"),
  );
});

test("a pressed menu item uses the active layer", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWithKeyboard(page);
  const rename = item(page, "Rename");
  await rename.hover();
  await page.mouse.down();
  await expect(rename).toHaveCSS(
    "background-color",
    await resolved(page, "var(--ui-active)"),
  );
  await page.mouse.up();
});

test("menus scale in from the top and respect reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openWithKeyboard(page);
  await expect(menu(page)).toHaveCSS("animation-duration", "0.37s");
  await expect(menu(page)).toHaveCSS(
    "animation-timing-function",
    "cubic-bezier(0.23, 1, 0.32, 1)",
  );
  await expect(menu(page)).toHaveCSS("transform-origin", /px 0px$/);
  await settled(page);
  await expect(menu(page)).toHaveCSS("transform", "none");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await more(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toHaveCSS("animation-name", "none");
});

for (const theme of ["light", "dark"] as const) {
  test(`item text, shortcut and danger meet WCAG AA in ${theme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openKit(page, { theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await more(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(item(page, "Rename")).toBeFocused();
    await settled(page);
    const base = await cssOf(menu(page), "background-color");

    for (const name of ["Rename", "Duplicate", "Delete"]) {
      // Once resting, then once current (the tinted background the shortcut sits on).
      for (const current of [false, true]) {
        const target = item(page, name);
        if (current) await target.focus();
        else
          await item(page, name === "Rename" ? "Duplicate" : "Rename").focus();
        await settled(page);
        const background = await cssOf(target, "background-color");
        const text = await cssOf(target, "color");
        expect(
          await contrast(page, text, background, base),
          `${name}${current ? " (current)" : ""}`,
        ).toBeGreaterThanOrEqual(4.5);
        if (name === "Rename") {
          const key = await cssOf(target.locator("kbd"), "color");
          expect(
            await contrast(page, key, background, base),
            "shortcut",
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
}

test("a horizontal list moves with the left and right arrows", async ({
  page,
}) => {
  await openKit(page);
  const list = page.getByRole("menu", { name: "Selection actions" });
  await expect(list).toHaveAttribute("aria-orientation", "horizontal");
  const [first, , last] = await list.getByRole("menuitem").all();
  await first.focus();
  // Up and down are not its axis.
  await page.keyboard.press("ArrowDown");
  await expect(first).toBeFocused();
  // Translate is disabled: Right goes to Copy, and on past the end to Explain.
  await page.keyboard.press("ArrowRight");
  await expect(last).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(last).toBeFocused();
  // The items sit side by side. Both are measured in one turn of the page, from the
  // list's own corner: the list is in a card that scrolls, and a scroll between two
  // readings would move one of them and not the other.
  const [a, b] = await list.evaluate((element) => {
    const items = element.querySelectorAll('[role="menuitem"]');
    const origin = element.getBoundingClientRect();
    return [items[0], items[items.length - 1]].map((item) => {
      const { left, right, top } = item.getBoundingClientRect();
      return {
        left: left - origin.left,
        right: right - origin.left,
        top: top - origin.top,
      };
    });
  });
  expect(b.left).toBeGreaterThanOrEqual(a.right);
  expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);
});

test("an item with a hint says it under the pointer, and to assistive technology", async ({
  page,
}) => {
  await openKit(page);
  const list = page.getByRole("menu", { name: "Selection actions" });
  const translate = list.getByRole("menuitem", { name: "Translate" });
  await expect(translate).toHaveAttribute("aria-disabled", "true");
  await expect(translate).toHaveAccessibleDescription(
    "Not available for this text",
  );
  const tip = page.locator('[role="tooltip"]');
  await expect(tip).toHaveCount(0);
  await translate.hover();
  await expect(tip).toHaveText("Not available for this text");
  // An item without one has no tooltip.
  await list.getByRole("menuitem", { name: "Copy" }).hover();
  await expect(tip).toHaveCount(0);
});

test("menu inside dialog: Escape closes the menu first", async ({ page }) => {
  await openKit(page);
  await page
    .getByRole("region", { name: "Dialog", exact: true })
    .getByRole("button", { name: "Open dialog", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Rename paper" });
  await expect(dialog).toBeVisible();
  const trigger = dialog.getByRole("button", { name: "More" });
  await trigger.click();
  await expect(menu(page)).toBeVisible();
  await expect(item(page, "Rename")).toBeFocused();

  // The first Escape is the menu's: the dialog stays, and the focus goes back to the button in it.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  // Not yet on its way out either: a dialog that is closing still looks visible, so wait out its exit.
  await page.waitForTimeout(300);
  await expect(dialog).toHaveJSProperty("open", true);
  await expect(trigger).toBeFocused();

  // The second one is the dialog's.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
