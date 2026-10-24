import {
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";
import { PLACES, type SidebarPlace } from "../../src/app/sidebar-entries";
import { seedSidebarState } from "../fixtures/sidebar";
import { parseAppRoute } from "../../src/app/routes";
import { createTranslator } from "../../src/i18n/i18n";
import { zh } from "../../src/i18n/messages/zh";
import { seedSmokeData, type SmokeData } from "../fixtures/smoke";
import { advisorDM, experiments } from "../fixtures/team";

const { t } = createTranslator("zh");
const quickOpenName = new RegExp(`^${zh["app.quickOpen"]}`);
const sidebar = (page: Page) =>
  page.getByRole("navigation", {
    name: zh["reader.region.sidebar"],
    exact: true,
  });
const test = base.extend<{ diagnostics: void; smoke: SmokeData }>({
  diagnostics: [
    async ({ page, baseURL }, use, testInfo) => {
      const errors: string[] = [];
      const outside: string[] = [];
      // HTTP statuses and requestfailed events alone are not failures.
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // The browser's own line for a 4xx/5xx response: a status is not a failure on its own.
        if (message.text().startsWith("Failed to load resource")) return;
        const source = message.location();
        errors.push(
          `[console.error] ${page.url()}\n${message.text()}\n${source.url}:${source.lineNumber}:${source.columnNumber}`,
        );
      });
      page.on("pageerror", (error) =>
        errors.push(
          `[pageerror] ${page.url()}\n${error.stack || error.message}`,
        ),
      );
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          ["http:", "https:"].includes(url.protocol) &&
          url.origin !== new URL(baseURL!).origin
        )
          outside.push(url.href);
      });
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (
          ["http:", "https:"].includes(url.protocol) &&
          url.origin !== new URL(baseURL!).origin
        ) {
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      await page.addInitScript(() => {
        localStorage.setItem("paper-locale", "zh");
        // Opening a paper must not start automatic model work in a UI smoke test.
        localStorage.setItem("paper-keypoints", "off");
      });
      await use();
      if (!page.isClosed()) {
        try {
          await settle(page);
        } catch (error) {
          errors.push(`[settle] ${String(error)}`);
        }
      }
      if (errors.length || outside.length) {
        const report = [
          ...errors,
          ...outside.map((url) => `[blocked external request] ${url}`),
        ].join("\n\n");
        console.log(report);
        await testInfo.attach("smoke-errors", {
          body: report,
          contentType: "text/plain",
        });
      }
      expect.soft(errors, errors.join("\n\n")).toEqual([]);
      expect
        .soft(outside, "Smoke tests only use the local E2E server")
        .toEqual([]);
    },
    { auto: true },
  ],
  smoke: async ({ page, diagnostics }, use) => {
    void diagnostics;
    const data = await seedSmokeData(page);
    await use(data);
  },
});

test.use({
  locale: "zh-CN",
  timezoneId: "Asia/Singapore",
  colorScheme: "light",
  serviceWorkers: "block",
});
// Each case walks many screens and their navigation, rather than one operation.
test.setTimeout(180_000);

async function settle(page: Page) {
  // Let effects and popup dismissal finish without networkidle (team views poll).
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Wait for actual screen content, not just the shell surviving a hash change. */
async function ready(page: Page, data: SmokeData) {
  const hash = new URL(page.url()).hash.slice(1);
  const route = parseAppRoute(hash);
  let title: string;
  if (data.edition === "cloud" && route.screen === "new-research") {
    await expect(
      page.getByRole("heading", {
        name: zh["research.localOnly.title"],
        level: 1,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: zh["research.localOnly.guide"],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", {
        name: zh["workspace.firstMessage"],
        exact: true,
      }),
    ).toHaveCount(0);
    await healthy(page);
    return;
  }
  switch (route.screen) {
    case "settings":
      await expect(
        page.getByRole("dialog", { name: zh["settings.title"], exact: true }),
      ).toBeVisible();
      title = t(
        `settings.category.${route.category || "general"}` as "settings.category.general",
      );
      break;
    case "home":
      title = zh["app.home"];
      break;
    case "new-research":
      title = zh["workspace.startQuestion"];
      await expect(
        page.getByRole("textbox", {
          name: zh["workspace.firstMessage"],
          exact: true,
        }),
      ).toBeVisible();
      break;
    case "library": {
      const view = new URLSearchParams(hash.split("?")[1]).get("view") || "all";
      title = t(
        view === "all"
          ? "library.filter.all"
          : (`library.status.${view}` as "library.status.reading"),
      );
      await expect(
        page.getByRole("searchbox", {
          name: zh["library.search"],
          exact: true,
        }),
      ).toBeVisible();
      break;
    }
    case "discover":
      title = zh["app.discover"];
      break;
    case "research":
      title = "冒烟研究";
      break;
    case "workspaces":
      title = route.workspaceId ? "冒烟项目" : zh["workspace.workspaces"];
      break;
    case "research-collections":
      title =
        route.collectionId === "unclassified"
          ? zh["workspace.unclassified"]
          : route.collectionId
            ? "冒烟分组"
            : zh["workspace.collections"];
      break;
    case "customize":
      title = t(`customize.${route.section}`);
      if (route.section === "roles")
        await expect(
          page.getByRole("button", {
            name: `${zh["customize.role.advisor"]} ${zh["customize.readOnly"]}`,
            exact: true,
          }),
        ).toBeVisible();
      break;
    case "schedules":
      title =
        route.scheduleId === "new"
          ? zh["schedules.new"]
          : route.scheduleId
            ? "冒烟定时任务"
            : zh["schedules.title"];
      if (route.scheduleId)
        await expect(
          page.getByRole("textbox", {
            name: zh["schedules.prompt"],
            exact: true,
          }),
        ).toBeVisible();
      break;
    case "team":
      if (route.threadId && route.channelId !== "settings") {
        await expect(
          page.getByRole("region", { name: zh["team.thread"], exact: true }),
        ).toBeVisible();
        if (!route.threadId.startsWith("research:"))
          await expect(
            page.getByText("冒烟线程回复", { exact: true }),
          ).toBeVisible();
        if (route.full) {
          await healthy(page);
          return;
        }
      }
      title =
        route.channelId === "settings"
          ? zh["team.settings"]
          : route.channelId === "threads"
            ? zh["team.threads"]
            : route.channelId === "mentions"
              ? zh["team.activity"]
              : route.channelId === "work"
                ? zh["team.work.title"]
                : route.channelId === advisorDM
                  ? "冒烟成员"
                  : "冒烟频道";
      if (
        !route.channelId ||
        [experiments, advisorDM].includes(route.channelId)
      )
        await expect(
          page
            .getByRole("region", { name: title, exact: true })
            .getByRole("textbox", { name: zh["team.message"], exact: true }),
        ).toBeVisible();
      break;
    case "projects":
      title = "冒烟成员";
      break;
    case "reader":
      title = data.paper.title;
      await expect(
        page.getByRole("textbox", {
          name: zh["reader.page.input"],
          exact: true,
        }),
      ).toHaveValue("1");
      await expect(
        page.getByRole("region", {
          name: zh["reader.pdf.region"],
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("group", {
          name: t("reader.pdf.page", { page: 1 }),
          exact: true,
        }),
      ).toBeVisible();
      break;
    default:
      throw new Error(
        `Missing smoke readiness check: ${route.screen} (${hash})`,
      );
  }
  await expect(
    page.getByRole("heading", { name: title, level: 1, exact: true }),
  ).toBeVisible();
  await healthy(page);
}

async function healthy(page: Page) {
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Dialog keeps its children mounted while closed. Only a visible loader
  // means the current screen (or an open dialog) has not finished loading.
  await expect(
    page
      .getByLabel(zh["common.loading"], { exact: true })
      .filter({ visible: true }),
  ).toHaveCount(0);
  await settle(page);
}

async function visit(page: Page, data: SmokeData, hash: string) {
  await page.goto(`/#${hash}`);
  // Redirects such as #board are resolved by the app before checking content.
  const target = parseAppRoute(hash);
  await expect(page).toHaveURL(
    (url) => url.hash === `#${target.redirect || hash}`,
  );
  await ready(page, data);
}

async function escapeDialog(page: Page, name: string | RegExp) {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/** Scope message menus to their own article; ARIA ids distinguish the header. */
async function menus(page: Page, scope: Page | Locator = page) {
  const triggers = await scope
    .getByRole("button")
    .and(page.locator('[aria-haspopup="menu"]'))
    .evaluateAll((buttons) =>
      buttons.map((button) => ({
        name: button.getAttribute("aria-label") || button.textContent!.trim(),
        controls: button.getAttribute("aria-controls")!,
        message: !!button.closest("article[data-message-id]"),
      })),
    );
  for (const trigger of triggers) {
    const named = page
      .getByRole("button", { name: trigger.name, exact: true })
      .and(page.locator(`[aria-controls=${JSON.stringify(trigger.controls)}]`));
    if (trigger.message) {
      // The same root message can appear in both the channel and thread. Its
      // menu id identifies the matching article without relying on position.
      const message = scope.getByRole("article").filter({ has: named });
      await message.getByTestId("team-message-bubble").hover();
    }
    const button = scope
      .getByRole("button", { name: trigger.name, exact: true })
      .and(named);
    if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
    await test.step(`菜单：${trigger.name}`, async () => {
      await button.click();
      const menu = page
        .getByRole("menu")
        .and(page.locator(`[id=${JSON.stringify(trigger.controls)}]`));
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    });
  }
  // These popovers expose dialog semantics and a name, without aria-controls.
  // A member's card opens from several places (avatar, name, header, sidebar)
  // under one name, so each trigger of a name is tried in turn.
  const dialogNames = new Set(
    await scope
      .getByRole("button")
      .and(page.locator('[aria-haspopup="dialog"]'))
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")!),
      ),
  );
  for (const name of dialogNames) {
    const buttons = scope.getByRole("button", { name, exact: true });
    // A member's card trigger reads "<name> · card"; the card itself is named by the member.
    const [, cardSuffix] = zh["team.colleague.card"].split("{name}");
    const title = [
      zh["team.switch"],
      zh["workspace.choose"],
      zh["workspace.chooseFolder"],
    ].some((label) => label === name)
      ? zh["workspace.choose"]
      : name.endsWith(cardSuffix)
        ? name.slice(0, -cardSuffix.length)
        : name;
    for (let index = 0; index < (await buttons.count()); index++) {
      const button = buttons.nth(index);
      if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
      const before = await page.getByRole("dialog").count();
      await button.click();
      await expect(page.getByRole("dialog")).toHaveCount(before + 1);
      await escapeDialog(page, title);
      await expect(page.getByRole("dialog")).toHaveCount(before);
    }
  }
}

/** Click the actual links (including the rail), then restore the screen. */
async function collapseSidebar(page: Page, collapsed: boolean) {
  const nav = sidebar(page);
  const toggle = nav.getByRole("button", {
    name: collapsed ? zh["sidebar.collapse"] : zh["sidebar.expand"],
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
  await expect(
    nav.getByRole("button", {
      name: collapsed ? zh["sidebar.expand"] : zh["sidebar.collapse"],
      exact: true,
    }),
  ).toBeVisible();
}

async function navigation(page: Page, data: SmokeData) {
  const original = new URL(page.url()).hash.slice(1);
  const nav = sidebar(page);
  await expect(nav).toBeVisible();
  await collapseSidebar(page, false);
  const conversations = nav.getByRole("group", {
    name: zh["team.messages"],
    exact: true,
  });
  if (await conversations.count())
    await expect(conversations.getByRole("link")).toHaveCount(2);
  const targets = [
    ...new Set(
      await nav
        .getByRole("link")
        .evaluateAll((links) =>
          links
            .map((link) => link.getAttribute("href")!)
            .filter((href) => href?.startsWith("#")),
        ),
    ),
  ];
  for (const href of targets) {
    await test.step(`侧栏：${href}`, async () => {
      // Link + href stays stable when unread counts and message previews change.
      await nav
        .getByRole("link")
        .and(page.locator(`[href=${JSON.stringify(href)}]`))
        .first()
        .click();
      await ready(page, data);
      if (new URLSearchParams(href.split("?")[1]).has("import"))
        await escapeDialog(page, zh["library.import"]);
      if (parseAppRoute(href.slice(1)).screen === "settings")
        await escapeDialog(page, zh["settings.title"]);
      await visit(page, data, original);
      await collapseSidebar(page, false);
    });
  }
  // Exercise the fixed rail on each screen too.
  await collapseSidebar(page, true);
  await menus(page, nav);
  const railTargets = [
    ...new Set(
      await nav
        .getByRole("link")
        .evaluateAll((links) =>
          links.map((link) => link.getAttribute("href")!),
        ),
    ),
  ];
  for (const href of railTargets) {
    // The reader mounts its own sidebar, so returning can reset its state.
    await collapseSidebar(page, true);
    await nav
      .getByRole("link")
      .and(page.locator(`[href=${JSON.stringify(href)}]`))
      .first()
      .click();
    await ready(page, data);
    if (parseAppRoute(href.slice(1)).screen === "settings")
      await escapeDialog(page, zh["settings.title"]);
    await visit(page, data, original);
  }
  await collapseSidebar(page, false);
  // Search has no aria-haspopup; open and dismiss it explicitly.
  await nav.getByRole("button", { name: quickOpenName }).click();
  await expect(
    page.getByRole("dialog", { name: quickOpenName }).getByRole("combobox"),
  ).toBeVisible();
  await escapeDialog(page, quickOpenName);
}

async function screen(page: Page, data: SmokeData, hash: string) {
  await test.step(`屏幕：#${hash}`, async () => {
    await visit(page, data, hash);
    await menus(page);
    await navigation(page, data);
  });
}

test("项目、新研究、研究记录和定时任务的入口", async ({ page, smoke }) => {
  for (const hash of [
    "new",
    `new?workspace=${smoke.workspaceId}`,
    `new?collection=${smoke.collectionId}`,
    "workspaces",
    ...["", "/board", "/about", "/results", "/compare"].map(
      (tab) => `workspaces/${smoke.workspaceId}${tab}`,
    ),
    "collections",
    `collections/${smoke.collectionId}`,
    "collections/unclassified",
    `research/${smoke.researchId}`,
    `projects/${smoke.workspaceId}/chats/${smoke.researchId}`,
    "schedules",
    "schedules/new",
    ...["papers", "weekly", "experiments", "night"].map(
      (template) => `schedules/new?template=${template}`,
    ),
    `schedules/${smoke.scheduleId}`,
  ])
    await screen(page, smoke, hash);
  await visit(page, smoke, "workspaces");
  await page
    .getByRole("button", { name: zh["projects.new"], exact: true })
    .click();
  await escapeDialog(page, zh["projects.new"]);
  await page
    .getByRole("button", { name: zh["workspace.connections"], exact: true })
    .click();
  await escapeDialog(page, zh["workspace.connections"]);
  await visit(page, smoke, "collections");
  await page
    .getByRole("button", { name: zh["projects.new"], exact: true })
    .click();
  await escapeDialog(page, zh["projects.new"]);
  await visit(page, smoke, `research/${smoke.researchId}`);
  await page
    .getByRole("button", { name: zh["research.actions"], exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: zh["projects.sessions.rename"],
      exact: true,
    })
    .click();
  await escapeDialog(page, zh["projects.sessions.rename"]);
  // Compatibility routes resolve to the same usable screens.
  for (const hash of [
    "board",
    "projects",
    "research",
    "scheduled",
    "tasks",
    `projects/${smoke.workspaceId}/board`,
  ])
    await visit(page, smoke, hash);
  await visit(page, smoke, `schedules/${smoke.scheduleId}`);
  await page
    .getByRole("button", { name: zh["reader.more.menu"], exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: zh["schedules.delete"], exact: true })
    .click();
  await escapeDialog(page, zh["schedules.deleteTitle"]);
});

test("团队会话、私信、线程、动态、成员、工作流、比较和预算", async ({
  page,
  smoke,
}) => {
  const team = `team/${smoke.workspaceId}`;
  for (const hash of [
    team,
    `${team}/${experiments}`,
    `${team}/${advisorDM}`,
    `${team}/threads`,
    `${team}/mentions`,
    `${team}/${experiments}?thread=${smoke.threadId}`,
    `${team}/${experiments}?thread=${smoke.threadId}&full=1`,
    `${team}/${experiments}?thread=research%3A${smoke.researchId}`,
    `${team}/settings`,
    ...[
      "members",
      "workflow",
      "compare",
      "budget",
      `member:${smoke.memberId}`,
    ].map((tab) => `${team}/settings?thread=${encodeURIComponent(tab)}`),
  ])
    await screen(page, smoke, hash);
  await visit(page, smoke, `${team}/${experiments}`);
  await sidebar(page)
    .getByRole("button", { name: zh["team.addChannel"], exact: true })
    .click();
  await escapeDialog(page, zh["team.addChannel"]);
  const conversation = page.getByRole("region", {
    name: "冒烟频道",
    exact: true,
  });
  await conversation
    .locator("header")
    .getByRole("button", { name: zh["research.actions"], exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: zh["team.renameChannel"], exact: true })
    .click();
  await escapeDialog(page, zh["team.renameChannel"]);
  await conversation
    .getByRole("button", { name: zh["team.search"], exact: true })
    .click();
  await escapeDialog(page, quickOpenName);
  await conversation
    .getByRole("button", { name: zh["team.files"], exact: true })
    .click();
  await expect(
    conversation.getByRole("button", {
      name: zh["team.hidePanel"],
      exact: true,
    }),
  ).toBeVisible();
  await conversation
    .getByRole("button", { name: zh["team.hidePanel"], exact: true })
    .click();
  await conversation
    .getByRole("button", { name: zh["team.showPanel"], exact: true })
    .click();
  await visit(page, smoke, `${team}/settings?thread=members`);
  await page
    .getByRole("button", { name: zh["members.add"], exact: true })
    .click();
  await escapeDialog(page, zh["members.add"]);
  await page
    .getByRole("radio", { name: zh["workflows.title"], exact: true })
    .click();
  await page
    .getByRole("button", { name: zh["teamWorkflow.new"], exact: true })
    .click();
  await escapeDialog(page, zh["teamWorkflow.edit"]);
  await page
    .getByRole("list", { name: zh["teamWorkflow.list"], exact: true })
    .getByRole("button")
    .filter({ hasText: "冒烟成员" })
    .click();
  await escapeDialog(page, zh["teamWorkflow.edit"]);
  await page
    .getByRole("tab", { name: zh["teamWorkflow.canvas"], exact: true })
    .click();
  await expect(
    page
      .getByRole("tabpanel", { name: zh["teamWorkflow.canvas"], exact: true })
      .getByLabel(zh["teamWorkflow.canvas"], { exact: true }),
  ).toBeVisible();
  await menus(page);
  for (const name of [
    zh["teamWorkflow.zoomIn"],
    zh["teamWorkflow.zoomOut"],
    zh["teamWorkflow.fit"],
  ])
    await page.getByRole("button", { name, exact: true }).click();
  await navigation(page, smoke);
  await page
    .getByRole("tab", { name: zh["teamWorkflow.list"], exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", {
      name: zh["teamWorkflow.search"],
      exact: true,
    }),
  ).toBeVisible();
  for (const name of [
    zh["compare.title"],
    zh["team.budgets"],
    zh["team.members"],
    zh["workflows.title"],
  ]) {
    await page.getByRole("radio", { name, exact: true }).click();
    await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
    await ready(page, smoke);
  }
});

test("文库分组、发现、阅读器及其菜单和对话框", async ({ page, smoke }) => {
  for (const hash of [
    "library",
    "library?view=reading",
    "library?view=unread",
    "library?view=read",
    "discover",
    `read/${smoke.paper.paperId}`,
  ])
    await screen(page, smoke, hash);
  await visit(page, smoke, "library");
  await sidebar(page)
    .getByRole("link", { name: zh["library.import"], exact: true })
    .click();
  await escapeDialog(page, zh["library.import"]);
  await page
    .getByRole("button", {
      name: t("library.menu", { title: smoke.paper.title }),
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: zh["details.title"], exact: true })
    .click();
  await menus(
    page,
    page.getByRole("dialog", { name: zh["details.title"], exact: true }),
  );
  await escapeDialog(page, zh["details.title"]);
  await visit(page, smoke, `read/${smoke.paper.paperId}`);
  await page
    .getByRole("button", { name: zh["reader.find.open"], exact: true })
    .click();
  await expect(
    page.getByRole("search", { name: zh["reader.find.region"], exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: zh["reader.find.close"], exact: true })
    .click();
  await page
    .getByRole("button", { name: zh["reader.more.menu"], exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: zh["reader.more.download"], exact: true })
    .click();
  await escapeDialog(page, zh["reader.download.title"]);
  const expandPanel = page.getByRole("button", {
    name: zh["reader.panel.show"],
    exact: true,
  });
  if (await expandPanel.isVisible()) await expandPanel.click();
  const panelTabs = page.getByRole("tablist", {
    name: zh["reader.panel.tabs"],
    exact: true,
  });
  await expect(panelTabs).toBeVisible();
  for (const tab of await panelTabs.getByRole("tab").all()) {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  // Extension entry: return the existing local fixture rather than fetching a URL.
  const paper = await (
    await page.request.get(`/api/v1/papers/${smoke.paper.paperId}`)
  ).json();
  let releaseImport = () => {};
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  await page.route("**/api/v1/import/url", async (route) => {
    await importGate;
    await route.fulfill({ json: paper });
  });
  await page.route("**/api/v1/import/arxiv/progress/*", (route) =>
    route.fulfill({ json: { stage: "metadata", received: 0, total: null } }),
  );
  try {
    await page.goto(
      `/#open?url=${encodeURIComponent("https://example.test/smoke.pdf")}`,
    );
    await expect(
      page.getByRole("heading", {
        name: zh["open.title"],
        level: 1,
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    releaseImport();
  }
  await expect(page).toHaveURL(
    (url) => url.hash === `#read/${smoke.paper.paperId}`,
  );
  await ready(page, smoke);
});

test("自定义各页和设置各分类", async ({ page, smoke }) => {
  for (const section of [
    "playbook",
    "roles",
    "machines",
    "tracking",
    "models",
    "workflows",
  ])
    await screen(page, smoke, `customize/${section}`);
  await visit(page, smoke, "customize/playbook");
  await page
    .getByRole("button", { name: /^核对来源/ })
    .and(page.locator(":not([aria-haspopup])"))
    .click();
  await escapeDialog(page, zh["customize.playbook"]);
  await visit(page, smoke, "customize/roles");
  await page
    .getByRole("button", {
      name: `${zh["customize.role.advisor"]} ${zh["customize.readOnly"]}`,
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: zh["customize.role.advisor"], exact: true })
      .getByText("冒烟角色", { exact: true }),
  ).toBeVisible();
  await escapeDialog(page, zh["customize.role.advisor"]);
  await visit(page, smoke, "customize/machines");
  await page
    .getByRole("button", { name: zh["settings.research.add"], exact: true })
    .click();
  await escapeDialog(page, zh["settings.research.add"]);
  await visit(page, smoke, "customize/tracking");
  await page
    .getByRole("button", {
      name: t("customize.more", { name: "SwanLab" }),
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: zh["settings.research.edit"], exact: true })
    .click();
  await escapeDialog(page, "SwanLab");
  await visit(page, smoke, "customize/models");
  await page
    .getByRole("button", { name: zh["settings.models.dialog"], exact: true })
    .click();
  await escapeDialog(page, zh["settings.models.dialog"]);
  await page
    .getByRole("button", {
      name: t("customize.more", { name: "Offline" }),
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", {
      name: zh["settings.models.renameTitle"],
      exact: true,
    })
    .click();
  await escapeDialog(page, zh["settings.models.renameTitle"]);
  await page
    .getByRole("button", { name: zh["reader.more.menu"], exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: zh["library.import"], exact: true })
    .click();
  await escapeDialog(page, zh["settings.import.title"]);
  await visit(page, smoke, "customize/workflows");
  await page.getByRole("button", { name: "冒烟工作流", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: zh["workflows.name"], exact: true }),
  ).toBeVisible();
  await page
    .getByRole("tab", { name: zh["teamWorkflow.canvas"], exact: true })
    .click();
  await expect(
    page
      .getByRole("tabpanel", { name: zh["teamWorkflow.canvas"], exact: true })
      .getByLabel(zh["teamWorkflow.canvas"], { exact: true }),
  ).toBeVisible();
  await menus(page);
  await page
    .getByRole("button", { name: zh["workflows.title"], exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: zh["workflows.title"],
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: zh["workflows.create"], exact: true })
    .click();
  await page
    .getByRole("button", { name: zh["teamWorkflow.new"], exact: true })
    .click();
  await escapeDialog(page, zh["teamWorkflow.edit"]);
  await page
    .getByRole("button", { name: zh["workflows.title"], exact: true })
    .click();
  await visit(page, smoke, "new");
  await sidebar(page)
    .getByRole("link", { name: zh["settings.title"], exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: zh["settings.title"],
    exact: true,
  });
  for (const [category, name] of [
    ["general", zh["settings.category.general"]],
    ["data", zh["settings.category.data"]],
    ["usage", zh["settings.category.usage"]],
    ["access", zh["settings.category.access"]],
    ["cloud", zh["settings.category.cloud"]],
  ]) {
    await test.step(`设置：${category}`, async () => {
      await settings
        .getByRole("navigation", { name: zh["settings.title"], exact: true })
        .getByRole("button", { name, exact: true })
        .click();
      await ready(page, smoke);
      await menus(page, settings);
    });
  }
  await escapeDialog(page, zh["settings.title"]);
  // Direct category links must work as well as the settings navigation.
  for (const category of ["general", "data", "usage", "access", "cloud"]) {
    await visit(page, smoke, `settings/${category}`);
    await escapeDialog(page, zh["settings.title"]);
  }
});

test("首页与深色主题下的首页、团队会话和文库", async ({ page, smoke }) => {
  const edition = async (mode: "local" | "cloud", hash: string) => {
    smoke.edition = mode;
    await page.route("**/api/v1/health", (route) =>
      route.fulfill({ json: { status: "ok", mode, version: "smoke" } }),
    );
    // useLocal caches /health per document. Changing the query forces a new
    // document before #home can be redirected by the previous local edition.
    await page.goto(`/?smoke-edition=${mode}#${hash}`);
    await ready(page, smoke);
  };
  // The local edition replaces #home with #new; exercise the hosted home too.
  await edition("cloud", "home");
  await menus(page);
  await navigation(page, smoke);
  await edition("local", "new");
  await page.goto("/#home");
  await expect(page).toHaveURL(/#new$/);
  await ready(page, smoke);
  await sidebar(page)
    .getByRole("link", { name: zh["settings.title"], exact: true })
    .click();
  await page
    .getByRole("radiogroup", {
      name: zh["settings.appearance.label"],
      exact: true,
    })
    .getByRole("radio", { name: zh["settings.appearance.dark"], exact: true })
    .click();
  await expect(
    page.getByRole("radio", {
      name: zh["settings.appearance.dark"],
      exact: true,
    }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await escapeDialog(page, zh["settings.title"]);
  await edition("cloud", "home");
  await menus(page);
  await navigation(page, smoke);
  await edition("local", `team/${smoke.workspaceId}/${experiments}`);
  await screen(page, smoke, `team/${smoke.workspaceId}/${experiments}`);
  await screen(page, smoke, "library");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("侧栏入口登记表、按需事项、分页和固定 rail", async ({ page, smoke }) => {
  const fixture = await seedSidebarState(page, smoke);
  const seen = new Map<SidebarPlace, Set<string>>();
  // Parse the registry by place; a nested section cannot satisfy its parent's ids.
  const collect = async (place: SidebarPlace) => {
    // From the page: a place may be the sidebar's own element (the hosted one is).
    const ids = await page
      .locator(`[data-sidebar-place="${place}"]`)
      .evaluateAll(
        (scopes, place) =>
          scopes
            .flatMap((scope) => [scope, ...scope.querySelectorAll("[data-id]")])
            .filter(
              (node) =>
                node
                  .closest("[data-sidebar-place]")
                  ?.getAttribute("data-sidebar-place") === place,
            )
            .map((node) => node.getAttribute("data-id"))
            .filter((id): id is string => !!id),
        place,
      );
    const entries = seen.get(place) || new Set<string>();
    for (const id of ids) entries.add(id);
    seen.set(place, entries);
  };
  const railIds = () =>
    sidebar(page)
      .locator('[data-sidebar-place="rail"] [data-id]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-id")).sort(),
      );
  const fixedRail = [...PLACES.rail].sort();
  const assertRail = async () => {
    await expect.poll(railIds).toEqual(fixedRail);
    await collapseSidebar(page, true);
    await expect.poll(railIds).toEqual(fixedRail);
    await collapseSidebar(page, false);
    await expect.poll(railIds).toEqual(fixedRail);
  };
  await visit(page, smoke, `team/${smoke.workspaceId}/${experiments}`);
  const nav = sidebar(page);
  await expect(nav.locator('[data-id="conversation"]')).toHaveCount(11);
  for (const index of [32, 33, 34])
    await expect(
      nav.getByRole("link", {
        name: index === 32 ? "冒烟频道" : `侧栏会话 ${index}`,
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    nav.getByRole("group", { name: "常用成员", exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole("button", { name: "通知", exact: true }),
  ).toHaveCount(0);
  const attention = nav.getByRole("region", {
    name: zh["sidebar.needsYou"],
    exact: true,
  });
  await expect(attention.getByRole("link")).toHaveCount(2);
  await expect(attention).toContainText(zh["sidebar.waiting"]);
  for (const place of [
    "rail",
    "research",
    "attention",
    "messages",
    "team",
  ] as const)
    await collect(place);
  await assertRail();
  await nav.locator('[data-id="messages-more"]').click();
  await expect(nav.locator('[data-id="conversation"]')).toHaveCount(31);
  await collect("messages");
  await page.reload();
  await expect(nav.locator('[data-id="conversation"]')).toHaveCount(31);
  await nav.locator('[data-id="messages-more"]').click();
  await expect(nav.locator('[data-id="conversation"]')).toHaveCount(35);
  await expect(nav.locator('[data-id="messages-more"]')).toHaveCount(0);
  // A second project starts at eight; returning restores the first project's limit.
  await page.goto(`/#new?workspace=${fixture.otherWorkspace}`);
  await expect(nav.locator('[data-id="conversation"]')).toHaveCount(10);
  await page.goto(`/#team/${smoke.workspaceId}/${experiments}`);
  await expect(nav.locator('[data-id="conversation"]')).toHaveCount(35);
  await nav.locator('[data-id="messages-less"]').click();
  await expect(nav.locator('[data-id="conversation"]')).toHaveCount(11);
  await attention.getByRole("link", { name: /冒烟决定/ }).click();
  await expect(page).toHaveURL(
    (url) =>
      new URLSearchParams(url.hash.split("?")[1]).get("thread") ===
      smoke.threadId,
  );
  await attention
    .getByRole("link", { name: /冒烟研究|核对离线研究页面/ })
    .click();
  await expect(page).toHaveURL(
    (url) =>
      new URLSearchParams(url.hash.split("?")[1]).get("thread") ===
      `research:${smoke.researchId}`,
  );
  fixture.navigation.workspaces[0].researches[0].status = "finished";
  fixture.navigation.workspaces[0].researches[0].unread = true;
  fixture.team.notifications[0].data = {}; // a normal mention is not a decision
  await page.reload();
  await expect(attention).toHaveCount(0);
  for (const id of ["new-research", "threads", "activity"])
    await expect(nav.locator(`[data-id="${id}"]`)).toHaveCount(1);
  await assertRail();

  await visit(page, smoke, "library");
  await expect(nav.locator('[data-id="recent-paper"]')).toHaveCount(5);
  await collect("materials");
  await collect("recent");
  await nav.locator('[data-id="recent-more"]').click();
  await expect(nav.locator('[data-id="recent-paper"]')).toHaveCount(25);
  await collect("recent");
  await page.reload();
  await expect(nav.locator('[data-id="recent-paper"]')).toHaveCount(25);
  await nav.locator('[data-id="recent-more"]').click();
  await expect(nav.locator('[data-id="recent-paper"]')).toHaveCount(32);
  await nav.locator('[data-id="recent-less"]').click();
  await expect(nav.locator('[data-id="recent-paper"]')).toHaveCount(5);
  await assertRail();
  await visit(page, smoke, "customize/playbook");
  await collect("customize");
  await assertRail();
  await visit(page, smoke, "schedules");
  await expect(nav.locator('[data-id="task"]')).toHaveCount(1);
  await collect("tasks");
  await assertRail();

  // The hosted edition keeps its sign-out action at the foot of the sidebar.
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({ json: { status: "ok", mode: "cloud", version: "smoke" } }),
  );
  await page.goto("/?smoke-edition=cloud#home");
  await ready(page, { ...smoke, edition: "cloud" });
  await expect(nav.locator('[data-id="sign-out"]')).toBeVisible();
  await collect("account");
  await collect("hosted");
  for (const [place, ids] of Object.entries(PLACES))
    for (const id of ids)
      expect(
        seen.get(place as SidebarPlace)?.has(id),
        `${place}:${id} must render in its own place`,
      ).toBe(true);
});
