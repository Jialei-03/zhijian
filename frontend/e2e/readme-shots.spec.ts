import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTranslator } from "../src/i18n/i18n";

/*
 * Offline data from scripts/demo_workspace.py, served by backend.local.
 * `bash scripts/readme-shots.sh` rebuilds both languages in docs/images/.
 * For an existing demo server: README_SHOTS=1 README_SHOTS_DATA=/tmp/ora-demo
 * README_SHOTS_LANG=zh E2E_PORT=8766 npx playwright test e2e/readme-shots.spec.ts
 */
test.skip(process.env.README_SHOTS !== "1", "README screenshots are opt-in");
test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});

type Demo = {
  lang: "zh" | "en";
  clock: string;
  owner_id: string;
  workspace_id: string;
  channel_id: string;
  research_id: string;
  paper_ids: string[];
  file_id: string;
  changes_message_id: string;
};

const out = resolve(process.cwd(), "../docs/images");

async function shoot(page: Page, name: string, lang: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const inView = (node: Element) => {
          const box = node.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.height > 0 &&
            box.bottom > 0 &&
            box.top < innerHeight &&
            box.right > 0 &&
            box.left < innerWidth
          );
        };
        return (
          Array.from(document.images)
            .filter(inView)
            .every((img) => img.complete && img.naturalWidth > 0) &&
          !Array.from(
            document.querySelectorAll('[data-thumb="placeholder"]'),
          ).some(inView)
        );
      }),
    )
    .toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: resolve(out, `${name}.${lang}.png`),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
}

for (const lang of ["zh", "en"] as const) {
  test.describe(lang, () => {
    test.use({ locale: lang === "zh" ? "zh-CN" : "en-US" });
    test(`README screenshots: ${lang}`, async ({ page, context, baseURL }) => {
      test.skip(
        lang !== (process.env.README_SHOTS_LANG || "zh"),
        "Each language uses its own seeded local server",
      );
      test.setTimeout(120_000);
      expect(
        process.env.README_SHOTS_DATA,
        "Set the demo data directory",
      ).toBeTruthy();
      const demo: Demo = JSON.parse(
        readFileSync(
          resolve(process.env.README_SHOTS_DATA!, "demo.json"),
          "utf8",
        ),
      );
      expect(demo.lang).toBe(lang);
      const { t, tn } = createTranslator(lang);
      mkdirSync(out, { recursive: true });

      // Keep the capture on this server, including fonts and PDF worker assets.
      await context.route(/^https?:\/\//, (route) =>
        new URL(route.request().url()).origin === new URL(baseURL!).origin
          ? route.continue()
          : route.abort("blockedbyclient"),
      );
      await page.clock.setFixedTime(new Date(demo.clock));
      await page.addInitScript(
        ({ lang, owner, papers, clock }) => {
          localStorage.setItem("paper-locale", lang);
          localStorage.setItem("paper-appearance", "light");
          localStorage.setItem("paper-library-view", "list");
          localStorage.setItem("paper-library-sort", "added");
          localStorage.setItem("team-side-panel", "false");
          localStorage.setItem(
            `paper-recent:${owner}`,
            JSON.stringify(
              Object.fromEntries(
                papers
                  .slice(0, 3)
                  .map((id, i) => [id, Date.parse(clock) - i * 60_000]),
              ),
            ),
          );
        },
        {
          lang,
          owner: demo.owner_id,
          papers: demo.paper_ids,
          clock: demo.clock,
        },
      );

      const me = await page.request.get("/api/v1/auth/me");
      expect(me.ok()).toBeTruthy();
      expect((await me.json()).user.id).toBe(demo.owner_id);

      await page.goto("/#new");
      await expect(
        page.getByRole("heading", {
          name: t("workspace.startQuestion"),
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: t("new.recent"), exact: true }),
      ).toBeVisible();
      await shoot(page, "home", lang);

      const teamUrl = `/#team/${demo.workspace_id}/${demo.channel_id}`;
      await page.goto(teamUrl);
      const screen = page.getByTestId("team-screen");
      await expect(
        screen.getByRole("heading", {
          name: lang === "zh" ? "综合" : "General",
          exact: true,
        }),
      ).toBeVisible();
      const changes = screen.locator(
        `[data-message-id="${demo.changes_message_id}"]`,
      );
      await expect(
        changes.getByRole("group", {
          name: tn("team.changes.files", 2),
          exact: true,
        }),
      ).toBeVisible();
      await shoot(page, "team", lang);

      await page.goto(
        `${teamUrl}?thread=${encodeURIComponent(`research:${demo.research_id}`)}&full=1`,
      );
      const thread = page.getByRole("region", {
        name: t("team.thread"),
        exact: true,
      });
      const plan = thread.getByRole("article", {
        name: t("research.plan.title"),
        exact: true,
      });
      await expect(
        plan.getByText(t("research.plan.approved"), { exact: true }),
      ).toBeAttached();
      await plan.scrollIntoViewIfNeeded();
      await expect(plan).toBeVisible();
      await shoot(page, "research", lang);

      await page.goto(`/#workspaces/${demo.workspace_id}/board`);
      await expect(
        page.getByRole("heading", {
          name:
            lang === "zh"
              ? "长上下文检索头"
              : "Retrieval heads in long context",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page
          .getByText(
            lang === "zh"
              ? "检索头的质量与显存"
              : "Recall and memory with retrieval heads",
            { exact: true },
          )
          .first(),
      ).toBeVisible();
      await shoot(page, "project", lang);

      await page.goto("/#library");
      await expect(
        page.getByRole("heading", {
          name: t("library.filter.all"),
          exact: true,
        }),
      ).toBeVisible();
      const table = page.locator('table[data-view="list"]');
      await expect(table.locator("tbody tr")).toHaveCount(6);
      await expect(
        table.getByText("Retrieval Heads for Long-Context Reading", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        table.getByText("ICLR", { exact: true }).first(),
      ).toBeVisible();
      await shoot(page, "library", lang);

      await page.goto(
        `/#read/${demo.paper_ids[0]}?file=${demo.file_id}&page=1`,
      );
      await expect(page.locator('[data-page="1"]')).toHaveAttribute(
        "data-rendered",
        "true",
      );
      await page
        .getByRole("tab", { name: t("reader.tab.assistant"), exact: true })
        .click();
      await expect(
        page.getByText(
          lang === "zh"
            ? "少量注意力头承担远距离事实检索。"
            : "A small set of heads retrieves distant facts.",
          { exact: true },
        ),
      ).toBeVisible();
      await shoot(page, "reader", lang);
    });
  });
}
