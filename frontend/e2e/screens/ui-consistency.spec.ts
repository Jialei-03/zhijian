import { expect, test, type Page } from "@playwright/test";
import { createPaperWithPdf, signIn } from "../reader/fixtures";
import { advisorDM, mockTeam } from "../fixtures/team";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const task = {
  id: "7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6",
  title: "Daily papers",
  prompt: "Find papers",
  workspace_id: WORKSPACE,
  destination: "new",
  research_id: null,
  frequency: "daily",
  local_time: "09:00",
  weekday: 4,
  interval_hours: 4,
  timezone: "Asia/Singapore",
  paused: true,
  next_run_at: "2026-10-24T01:00:00+00:00",
  created_at: "2026-10-23T00:00:00+00:00",
  updated_at: "2026-10-23T00:00:00+00:00",
  runs: [],
};

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem("paper-locale", "zh"));
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({ json: { mode: "local", status: "ok" } }),
  );
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({ json: { active_id: "", configured: true, models: [] } }),
  );
  // All research calls are mocked, including automatic machine probes.
  await page.route("**/api/v1/research/**", (route) => {
    const key = new URL(route.request().url()).pathname.replace(
      "/api/v1/research/",
      "",
    );
    const answers: Record<string, unknown> = {
      navigation: {
        collections: [],
        workspaces: [
          {
            id: WORKSPACE,
            name: "UI project",
            archived: false,
            researches: [],
            location: {
              kind: "local",
              path: "/tmp/ui-project",
              connection_id: "",
            },
          },
        ],
      },
      schedules: [task],
      "schedules/7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6": task,
      settings: {
        computes: [],
        default_compute: "host",
        states: {},
        tracker: {
          kind: "wandb",
          mode: "local",
          project: "original",
          has_key: false,
        },
      },
      "ssh-hosts": [],
      roles: [{ id: "research-advisor", title: "Advisor" }],
      "roles/research-advisor": {
        id: "research-advisor",
        title: "Advisor",
        body: "# Advisor",
      },
      playbook: { version: 1, rules: [], history: [] },
    };
    return route.fulfill({ json: answers[key] ?? [] });
  });
  await page.route("**/api/v1/discover/**", (route) =>
    route.fulfill({ json: { state: "no_seeds", items: [] } }),
  );
  for (const engine of ["layout", "latex"]) {
    await page.route(`**/api/v1/${engine}-install`, (route) =>
      route.fulfill({
        json: {
          supported: true,
          installed: false,
          status: "idle",
          progress: 0,
          stage: "",
          error: "",
        },
      }),
    );
  }
  await mockTeam(page);
  await signIn(page);
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const surface = page.locator("dialog[open], [data-app-screen]").last();
  expect(
    await surface.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 720]) {
    test(`${theme}, ${width}px: headers, empty states and settings`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (mode) => localStorage.setItem("paper-appearance", mode),
        theme,
      );
      await setup(page);
      await page.goto("/#new");
      const home = page.getByTestId("new-research");
      await expect(
        home.getByRole("heading", { name: "想研究什么？" }),
      ).toHaveCSS("font-size", "30px");
      await expect(
        home.getByRole("heading", { name: "想研究什么？" }),
      ).toHaveCSS("font-weight", "400");
      await expect(home).toHaveCSS("justify-content", "flex-start");
      await expect(home).toHaveCSS("gap", "0px");
      await expect(home.getByRole("heading", { level: 1 })).toHaveCSS(
        "line-height",
        "40px",
      );
      const message = home.getByRole("textbox", { name: "开始研究" });
      await expect(message).toHaveCSS("min-height", "60px");
      await expect(message).toHaveCSS("max-height", "280px");
      await expect(message).toHaveCSS("font-size", "15px");
      await expect(message).toHaveCSS("line-height", "24px");
      await expect(message).toHaveCSS("padding", "4px 6px 8px");
      await expect(home.locator("form")).toHaveCSS(
        "padding",
        "10px 10px 10px 12px",
      );
      await expect(home.locator("form")).toHaveCSS("gap", "0px");
      for (const name of ["附加文件", "选择项目", "添加模型", "工作流"]) {
        await expect(
          home.getByRole("button", { name, exact: true }),
        ).toBeVisible();
      }
      const send = home.getByRole("button", { name: "发送", exact: true });
      await expect(send).toHaveAttribute("aria-label", "发送");
      await expect(send).toHaveCSS("width", "34px");
      await expect(send).toHaveCSS("height", "34px");
      await expect(send).toHaveCSS("opacity", "1");
      await expect(send.locator("svg")).toHaveCSS("width", "18px");
      await expect(send.locator("svg")).toHaveCSS("height", "18px");
      const attach = home.getByRole("button", {
        name: "附加文件",
        exact: true,
      });
      await expect(attach).toHaveCSS("width", "32px");
      await expect(attach).toHaveCSS("height", "32px");
      for (const name of ["选择项目", "工作流"]) {
        const chip = home.getByRole("button", { name, exact: true });
        await expect(chip).toHaveCSS("height", "32px");
        await expect(chip).toHaveCSS("font-size", "13px");
        await expect(chip).toHaveCSS("font-weight", "400");
      }
      await send.hover();
      await expect(
        page.getByRole("tooltip", { includeHidden: true }),
      ).toHaveText("发送");
      await page.mouse.move(0, 0);
      await noOverflow(page);
      const sidebar = page.getByRole("navigation", {
        name: "侧栏",
        exact: true,
      });
      // Below 900px the sidebar is a rail of the same five links until it is opened.
      if (width < 900)
        await sidebar
          .getByRole("button", { name: "展开侧栏", exact: true })
          .click();
      await expect(
        sidebar.getByRole("link", { name: "新研究", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      for (const name of ["研究", "资料", "定时任务", "自定义", "设置"]) {
        await expect(
          sidebar.getByRole("link", { name, exact: true }).first(),
        ).toBeVisible();
      }
      if (width < 900)
        await sidebar
          .getByRole("button", { name: "收起侧栏", exact: true })
          .click();
      const pages = [
        ["library", "全部"],
        ["library?view=reading", "在读"],
        ["library?view=unread", "未读"],
        ["library?view=read", "已读"],
        ["discover", "发现"],
        ["schedules", "定时任务"],
        ["schedules/new", "新建任务"],
        ["schedules/7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6", "Daily papers"],
        ["customize/playbook", "研究手册"],
        ["customize/roles", "研究角色"],
        ["customize/machines", "机器"],
        ["customize/tracking", "实验追踪"],
        ["customize/models", "模型"],
      ];
      let left: number | undefined;
      for (const [hash, title] of pages) {
        await page.goto(`/#${hash}`);
        const heading = page.getByRole("heading", {
          name: title,
          level: 1,
          exact: true,
        });
        await expect(heading).toBeVisible();
        await expect(heading).toHaveCSS("font-size", "24px");
        await expect(heading).toHaveCSS("font-weight", "400");
        const box = (await heading.boundingBox())!;
        left ??= box.x;
        expect(box.x).toBeCloseTo(left, 0);
        expect(
          await page.locator('button[class*="_primary_"]:visible').count(),
        ).toBeLessThanOrEqual(1);
        await noOverflow(page);
      }
      for (const category of ["general", "data", "usage", "access", "cloud"]) {
        await page.goto(`/#settings/${category}`);
        const dialog = page.getByRole("dialog", { name: "设置", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveCSS("width", `${width}px`);
        await expect(dialog).toHaveCSS("height", "1000px");
        await expect(dialog).toHaveCSS("margin", "0px");
        await expect(dialog).toHaveCSS("max-width", "none");
        await expect(dialog).toHaveCSS("max-height", "none");
        await expect(dialog).toHaveCSS("border-radius", "0px");
        await expect(dialog).toHaveCSS("box-shadow", "none");
        expect(
          await dialog.evaluate(
            (element) =>
              getComputedStyle(element, "::backdrop").backgroundColor,
          ),
        ).toBe("rgba(0, 0, 0, 0)");
        await expect(dialog.locator(":scope > div")).toHaveCSS(
          "padding",
          "8px 8px 8px 0px",
        );
        const navigation = dialog.getByRole("navigation", { name: "设置" });
        await expect(navigation).toHaveCSS("padding", "10px 8px 12px");
        await expect(navigation).toHaveCSS("gap", "0px");
        await expect(navigation).toHaveCSS("border-right-width", "0px");
        const current = navigation.locator('[aria-current="page"]');
        await expect(current).toHaveCSS("height", "32px");
        await expect(current).toHaveCSS("gap", "10px");
        await expect(current).toHaveCSS("font-size", "14px");
        await expect(current).toHaveCSS("font-weight", "400");
        expect(
          await current
            .locator("svg")
            .evaluate(
              (icon) =>
                getComputedStyle(icon).color ===
                getComputedStyle(icon.parentElement!).color,
            ),
        ).toBe(true);
        const groupTitle = navigation.getByText("应用", { exact: true });
        await expect(groupTitle).toHaveCSS("height", "24px");
        await expect(groupTitle).toHaveCSS("font-size", "12px");
        await expect(groupTitle).toHaveCSS("letter-spacing", "0.24px");
        const search = navigation.getByRole("searchbox");
        await expect(search).toHaveCSS("font-size", "14px");
        await expect(search.locator("..")).toHaveCSS("height", "34px");
        await expect(search.locator("..")).toHaveCSS("margin", "8px 2px 6px");
        await expect(search.locator("..")).toHaveCSS(
          "padding",
          "0px 8px 0px 10px",
        );
        await expect(search.locator("..")).toHaveCSS("border-radius", "10px");
        const main = dialog.getByRole("main");
        await expect(main).toHaveCSS("border-radius", "16px");
        await expect(main).not.toHaveCSS("box-shadow", "none");
        const heading = main.getByRole("heading", { level: 1 });
        await expect(heading).toHaveCSS("font-size", "24px");
        await expect(heading).toHaveCSS("font-weight", "400");
        await expect(heading).toHaveCSS("line-height", "32px");
        await expect(heading).toHaveCSS("letter-spacing", "0.24px");
        await expect(heading.locator("..")).toHaveCSS("max-width", "708px");
        await expect(heading.locator("..")).toHaveCSS(
          "padding",
          "34px 24px 72px",
        );
        expect(
          await dialog.locator('button[class*="_primary_"]:visible').count(),
        ).toBeLessThanOrEqual(1);
        if (category === "general") {
          const appearance = dialog.getByRole("radiogroup", {
            name: "主题",
            exact: true,
          });
          const row = appearance.locator("..");
          await expect(row).toHaveCSS("min-height", "56px");
          await expect(row).toHaveCSS("padding", "12px 16px");
          await expect(row).toHaveCSS("gap", "16px");
          await expect(row.locator("..")).toHaveCSS("border-radius", "16px");
          await expect(row.locator("..")).not.toHaveCSS("box-shadow", "none");
          await expect(row.getByText("主题", { exact: true })).toHaveCSS(
            "font-size",
            "14px",
          );
          const sectionHeading = dialog.getByRole("heading", {
            name: "外观",
            exact: true,
          });
          await expect(sectionHeading).toHaveCSS("font-size", "14px");
          await expect(sectionHeading).toHaveCSS("font-weight", "600");
          await expect(sectionHeading.locator("../..")).toHaveCSS(
            "margin",
            "22px 0px 8px 2px",
          );
          await expect(sectionHeading.locator("../..")).toHaveCSS(
            "border-bottom-width",
            "0px",
          );
          const light = appearance.getByRole("radio", {
            name: "浅色",
            exact: true,
          });
          await light.focus();
          await light.press("End");
          await expect(
            appearance.getByRole("radio", { name: "深色", exact: true }),
          ).toHaveAttribute("aria-checked", "true");
          await expect(
            dialog.getByRole("button", { name: "关闭", exact: true }),
          ).toBeVisible();
          await appearance
            .getByRole("radio", {
              name: theme === "light" ? "浅色" : "深色",
              exact: true,
            })
            .click();
        }
        await noOverflow(page);
        expect(
          await main.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }
    });
  }
}

test("keyboard reaches import and destructive menus; tracking cancellation keeps the saved value", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/#library");
  const importButton = page
    .getByRole("main")
    .getByRole("button", { name: "导入", exact: true })
    .first();
  await importButton.focus();
  await importButton.press("Enter");
  await page.getByRole("menuitem", { name: "arXiv 链接或编号" }).focus();
  await page.keyboard.press("Enter");
  const importing = page.getByRole("dialog", { name: "导入", exact: true });
  await expect(importing.getByRole("textbox")).toBeFocused();
  await importing.getByRole("textbox").fill("2401.00001");
  await importing.getByRole("button", { name: "取消" }).click();
  await expect(importing).toBeHidden();
  await expect(importButton).toBeFocused();

  await page.goto("/#schedules/7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6");
  await page.getByRole("button", { name: "更多", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem").last()).toHaveText("删除");
  await page.getByRole("menuitem", { name: "删除", exact: true }).focus();
  await page.keyboard.press("Enter");
  const deleting = page.getByRole("dialog", { name: "删除这个任务？" });
  await expect(deleting).toBeVisible();
  await deleting.getByRole("button", { name: "取消" }).click();
  await expect(deleting).toBeHidden();

  await page.goto("/#customize/tracking");
  await page.getByRole("button", { name: "W&B 的更多操作" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const tracking = page.getByRole("dialog", { name: "W&B", exact: true });
  await tracking.getByRole("textbox").fill("unsaved");
  await tracking.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "W&B 的更多操作" }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await expect(tracking.getByRole("textbox")).toHaveValue("original");
});

test("reader shell stays within a 720px dark window", async ({ page }) => {
  await setup(page);
  const paper = await createPaperWithPdf(page, {
    title: "A long paper title ".repeat(12),
  });
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.addInitScript(() =>
    localStorage.setItem("paper-appearance", "dark"),
  );
  await page.goto(`/#read/${paper.paperId}`);
  const heading = page.getByRole("main").getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCSS("font-size", "14px");
  await noOverflow(page);
  const more = page.getByRole("button", { name: "更多", exact: true });
  await expect(more).toHaveAttribute("aria-label", "更多");
  await more.hover();
  await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveText(
    "更多",
  );
  await more.click();
  await expect(page.getByRole("menuitem", { name: "论文详情" })).toBeVisible();
});

test("orphaned direct channels leave navigation and saved addresses usable", async ({
  page,
}) => {
  await setup(page);
  const orphan = "eeeeeeee-eeee-4eee-8eee-000000000099";
  await page.route("**/api/v1/research/workspaces/*/team", (route) =>
    route.fulfill({
      json: {
        workspace_id: WORKSPACE,
        members: [
          {
            id: "advisor",
            name: "导师",
            role: "advisor",
            status: "idle",
            active_run_id: null,
          },
        ],
        channels: [
          {
            id: advisorDM,
            key: "dm:advisor",
            name: "导师",
            member_id: "advisor",
            unread: 0,
          },
          {
            id: orphan,
            key: "dm:missing",
            name: "Former member",
            member_id: "missing",
            unread: 0,
          },
        ],
        notifications: [],
      },
    }),
  );
  await page.goto("/#new");
  const sidebar = page.getByRole("navigation", { name: "侧栏", exact: true });
  const direct = sidebar.getByRole("group", { name: "消息", exact: true });
  await expect(
    direct.getByRole("link", { name: "导师", exact: true }),
  ).toBeVisible();
  await expect(
    direct.getByRole("link", { name: "Former member", exact: true }),
  ).toHaveCount(0);
  const advisor = direct.getByRole("link", { name: "导师", exact: true });
  await expect(advisor).toHaveAttribute(
    "href",
    `#team/${WORKSPACE}/${advisorDM}`,
  );
  await advisor.click();
  await expect(page).toHaveURL(new RegExp(`#team/${WORKSPACE}/${advisorDM}$`));
  await expect(advisor).toHaveAttribute("aria-current", "page");
  await sidebar.getByRole("link", { name: "新研究", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#new\\?workspace=${WORKSPACE}$`));
  const originalAddress = page.url();
  // A background tab is reported by the context, even when it has no opener.
  const [opened] = await Promise.all([
    page.context().waitForEvent("page"),
    advisor.click({ button: "middle" }),
  ]);
  await expect(opened).toHaveURL(
    new RegExp(`#team/${WORKSPACE}/${advisorDM}$`),
  );
  await expect(page).toHaveURL(originalAddress);
  await opened.close();
  await page.goto(`/#team/${WORKSPACE}/${orphan}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Former member", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("team-empty")).toContainText("Former member");
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveAttribute("placeholder", "发送给 Former member");
  await expect(
    sidebar.getByRole("link", { name: "新研究", exact: true }),
  ).toBeVisible();
});
