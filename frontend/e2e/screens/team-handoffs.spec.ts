import { expect, test } from "@playwright/test";
import { createTranslator } from "../../src/i18n/i18n";
import type { TeamMessage } from "../../src/screens/research/team-api";
import { advisorDM, experiments, mockTeam } from "../fixtures/team";
import { signIn } from "../reader/fixtures";

test.use({ timezoneId: "Asia/Singapore" });
const workspace = "10000000-0000-0000-0000-000000000001";
const stamp = "2026-10-24T10:00:00Z";

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: deliverable decisions, record-only sends and completion criteria`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.addInitScript(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    const messages: TeamMessage[] = [
      {
        id: "draft",
        channel_id: experiments,
        thread_id: null,
        author_id: "writer",
        kind: "draft",
        text: "Draft with evidence",
        mentions: [],
        replies: 0,
        created_at: stamp,
        data: {
          done_when: "Sources checked",
          files: [{ path: "draft.md", name: "draft.md" }],
        },
      },
    ];
    const writes: Record<string, unknown>[] = [];
    await page.route("**/api/v1/translation-settings", (route) =>
      route.fulfill({
        json: {
          configured: true,
          active_id: "fake",
          models: [
            { id: "fake", name: "Fake", model: "Fake", protocol: "openai" },
          ],
        },
      }),
    );
    await page.route("**/api/v1/health", (route) =>
      route.fulfill({ json: { mode: "local" } }),
    );
    await page.route("**/api/v1/research/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        json: path.endsWith("/navigation")
          ? {
              workspaces: [
                {
                  id: workspace,
                  name: "Team",
                  location: { kind: "managed", path: "", connection_id: "" },
                  researches: [],
                  archived: false,
                },
              ],
              collections: [],
            }
          : path.endsWith("/settings")
            ? { computes: [], states: {} }
            : [],
      });
    });
    await mockTeam(page, {
      messages: (channel, thread) =>
        messages.filter(
          (message) =>
            message.channel_id === channel && message.thread_id === thread,
        ),
    });
    await page.route("**/team/messages/*/decision", (route) => {
      const body = route.request().postDataJSON();
      writes.push(body);
      messages[0].data.decision = {
        ...body,
        event_id: "event",
        created_at: stamp,
      };
      return route.fulfill({ json: messages[0] });
    });
    await page.route("**/team/channels/*/messages", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON();
      writes.push(body);
      const message: TeamMessage = {
        id: crypto.randomUUID(),
        channel_id: new URL(route.request().url()).pathname
          .split("/channels/")[1]
          .split("/")[0],
        thread_id: null,
        author_id: "human",
        kind: "text",
        text: body.text,
        mentions: [],
        data: { done_when: body.done_when, mode: body.mode },
        created_at: stamp,
        replies: 0,
      };
      messages.push(message);
      return route.fulfill({ json: message });
    });
    await signIn(page);
    await page.goto(`/#team/${workspace}/${experiments}`);
    const card = page.locator('[data-message-id="draft"]');
    await expect(card).toContainText(
      t("team.doneWhenValue", { value: "Sources checked" }),
    );
    await card
      .getByRole("button", { name: t("team.requestChanges"), exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: t("team.requestChanges"),
      exact: true,
    });
    const requestChanges = dialog.getByRole("button", {
      name: t("team.requestChanges"),
      exact: true,
    });
    await expect(requestChanges).toBeDisabled();
    await dialog
      .getByRole("textbox", { name: t("team.revisionFeedback"), exact: true })
      .fill("   ");
    await expect(requestChanges).toBeDisabled();
    await dialog
      .getByRole("textbox", { name: t("team.revisionFeedback"), exact: true })
      .fill("Add citations");
    await requestChanges.click();
    await expect(card.getByRole("status")).toHaveText(
      `${t("team.changesRequested")} · Add citations`,
    );
    await expect
      .poll(() =>
        writes.some(
          (body) =>
            body.status === "changes_requested" &&
            body.feedback === "Add citations",
        ),
      )
      .toBe(true);
    await card
      .getByRole("button", { name: t("team.accept"), exact: true })
      .click();
    await expect(card.getByRole("status")).toHaveText(t("team.accepted"));

    for (const channel of [experiments, advisorDM]) {
      await page.goto(`/#team/${workspace}/${channel}`);
      const composer = page.getByRole("textbox", {
        name: t("team.message"),
        exact: true,
      });
      await expect(
        page.getByRole("textbox", { name: t("team.doneWhen"), exact: true }),
      ).toHaveCount(0);
      await composer.fill("@writer Check sources");
      await page
        .getByRole("textbox", { name: t("team.doneWhen"), exact: true })
        .fill("Citations verified");
      await page
        .getByRole("button", { name: t("team.sendMode"), exact: true })
        .click();
      for (const key of [
        "team.queue",
        "team.immediate",
        "team.recordOnly",
      ] as const)
        await expect(
          page.getByRole("menuitemradio", { name: t(key), exact: true }),
        ).toBeVisible();
      await page
        .getByRole("menuitemradio", { name: t("team.recordOnly"), exact: true })
        .click();
      await composer.press("Enter");
      await expect
        .poll(() => writes.filter((body) => body.mode === "record").length)
        .toBe(channel === experiments ? 1 : 2);
      await expect(page.getByTestId("team-queue")).toHaveCount(0);
    }
    expect(writes.filter((body) => body.mode === "record")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ done_when: "Citations verified" }),
      ]),
    );
  });
}
