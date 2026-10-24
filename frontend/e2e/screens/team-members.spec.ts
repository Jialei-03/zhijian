import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../reader/fixtures";
import { createTranslator } from "../../src/i18n/i18n";
import type {
  LibraryMember,
  MemberConfig,
  TeamMember,
} from "../../src/screens/research/team-api";

// Routes only accept UUID channel ids, as the app's channels have.
const dmId = (member: string) =>
  `d0000000-0000-4000-8000-${Buffer.from(member).toString("hex").padStart(12, "0").slice(-12)}`;

const wid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const defaults = (name: string): MemberConfig => ({
  name,
  description: "Checks evidence",
  wake_minutes: 20,
  avatar_color: "blue",
  avatar: "",
  role_description: "# Skill\nCheck evidence",
  model_config_id: "",
  permissions: {
    papers: true,
    files: true,
    commands: false,
    machines: ["host"],
    readonly: false,
  },
  wake_turns: 32,
  wake_tokens: 200000,
});
function documentSource(
  config: MemberConfig,
  previous = "",
  channels: string[] = [],
) {
  const extra = previous.split("\n").find((line) => line.startsWith("future:"));
  return `---\nname: ${config.name}\navatar: ${config.avatar ?? ""}\ndescription: ${config.description ?? ""}\ntools: [files, web]\nbudget: {turns: ${config.wake_turns}, tokens: ${config.wake_tokens}, minutes: ${config.wake_minutes ?? 20}}\nchannels: ${JSON.stringify(channels)}\n${extra ? `${extra}\n` : ""}---\n\n${config.role_description}`;
}
function sourceConfig(source: string): MemberConfig {
  return {
    ...defaults(source.match(/^name: (.+)$/m)?.[1] ?? "Ada"),
    description: source.match(/^description: (.+)$/m)?.[1] ?? "",
    avatar: source.match(/^avatar: (.+)$/m)?.[1] ?? "",
    role_description: source.split("---").slice(2).join("---").trim(),
  };
}
async function setup(page: Page, extraMembers: TeamMember[] = []) {
  let members: TeamMember[] = [
    {
      id: "human",
      role: "human",
      ...defaults("研究者"),
      builtin: true,
      enabled: true,
      status: "idle",
      active_run_id: null,
    },
    {
      id: "advisor",
      role: "advisor",
      ...defaults("导师"),
      builtin: true,
      enabled: true,
      status: "idle",
      active_run_id: null,
    },
    ...extraMembers,
  ];
  const library: LibraryMember[] = [
    { id: "library-ada", version: 1, config: defaults("Ada"), teams: [] },
  ];
  const saved: Record<string, unknown>[] = [];
  const images = new Map<string, { extension: string; content: string }>();
  const channels = () => [
    {
      id: cid,
      key: "general",
      name: "闲聊",
      member_id: null,
      unread: 0,
      last_message: null,
      last_at: "2026-10-23T00:00:00Z",
      working_member_ids: [],
    },
    ...members
      .filter((m) => m.role !== "human")
      .map((m) => ({
        id: dmId(m.id),
        key: `dm:${m.id}`,
        name: m.name,
        member_id: m.id,
        unread: 0,
        last_message: null,
        last_at: "2026-10-23T00:00:00Z",
        working_member_ids: [],
      })),
  ];
  await page.route("**/api/v1/health", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, mode: "local" } });
  });
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        configured: true,
        active_id: "fake",
        models: [{ id: "fake", model: "Fake", name: "Fake" }],
      },
    }),
  );
  await page.route("**/api/v1/research/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/v1/research",
      "",
    );
    const method = route.request().method();
    if (path === "/navigation")
      return route.fulfill({
        json: {
          workspaces: [
            {
              id: wid,
              name: "团队",
              kind: "research",
              archived: false,
              location: { kind: "managed", path: "", connection_id: "" },
              researches: [],
            },
          ],
          collections: [],
        },
      });
    if (path === "/settings")
      return route.fulfill({
        json: {
          computes: [{ id: "host", name: "本机", kind: "host" }],
          states: {},
        },
      });
    if (path.endsWith("/agent-document")) {
      const body = route.request().postDataJSON();
      if (!body.config && body.source.includes("tools: broken"))
        return route.fulfill({
          status: 422,
          json: { detail: "第 4 行 / Line 4: Invalid tools" },
        });
      const config = body.config ?? sourceConfig(body.source);
      return route.fulfill({
        json: {
          source: body.config
            ? documentSource(config, body.source, body.channels)
            : body.source,
          config: { ...config, channels: body.channels ?? [] },
          warnings: [],
        },
      });
    }
    if (path.endsWith("/import-agent")) {
      const body = route.request().postDataJSON();
      const config = body.filename.endsWith(".toml")
        ? {
            ...defaults("codex-reader"),
            description: "Codex role",
            role_description: "Read the evidence",
          }
        : {
            ...defaults("Claude reader"),
            description: "Claude role",
            role_description: "Check every source",
            permissions: { ...defaults("x").permissions, file_readonly: true },
          };
      return route.fulfill({
        json: {
          source: documentSource(config, "future: keep"),
          config,
          warnings: body.filename.endsWith(".md")
            ? ["未知工具 / Unknown tool: FutureTool"]
            : [],
        },
      });
    }
    if (path.endsWith("/team"))
      return route.fulfill({
        json: {
          workspace_id: wid,
          members,
          channels: channels(),
          notifications: [],
          workflow: {
            id: "research",
            name: "Research",
            builtin: true,
            version: 1,
            rules: [],
            layout: { members: {}, channels: {} },
          },
        },
      });
    if (path.endsWith("/library")) return route.fulfill({ json: library });
    if (path.includes("/library/")) {
      const body = route.request().postDataJSON();
      saved.push(body);
      library[0] = {
        ...library[0],
        config: body.config,
        version: library[0].version + 1,
      };
      return route.fulfill({ json: library[0] });
    }
    if (path.endsWith("/members") && method === "POST") {
      const body = route.request().postDataJSON();
      saved.push(body);
      const config = {
        ...(body.config ||
          library.find((l) => l.id === body.library_id)?.config ||
          defaults("导师")),
      };
      const id = `custom-${members.length}`;
      if (body.avatar_upload) {
        config.avatar = `.ora/avatars/${config.name}.${body.avatar_upload.extension}`;
        images.set(id, body.avatar_upload);
      }
      members = [
        ...members,
        {
          ...config,
          id,
          role: `custom_${id}`,
          builtin: false,
          library_id: body.library_id || `library-${id}`,
          enabled: true,
          status: "idle",
          active_run_id: null,
          subscriptions: body.subscriptions || [],
          source: body.avatar_upload
            ? documentSource(config, body.source)
            : body.source || documentSource(config),
          avatar_url: body.avatar_upload
            ? `/api/v1/research/workspaces/${wid}/team/members/${id}/avatar?v=1`
            : null,
          revision: "v1",
        },
      ];
      return route.fulfill({ json: { id } });
    }
    if (path.endsWith("/avatar")) {
      const image = images.get(path.split("/").at(-2)!);
      return image
        ? route.fulfill({
            body: Buffer.from(image.content, "base64"),
            contentType:
              image.extension === "svg"
                ? "image/svg+xml"
                : `image/${image.extension}`,
          })
        : route.fulfill({ status: 404 });
    }
    if (path.includes("/members/")) {
      const id = path.split("/").at(-1)!;
      const member = members.find((m) => m.id === id)!;
      if (method === "PATCH") {
        const body = route.request().postDataJSON();
        saved.push(body);
        members = members.map((m) =>
          m.id === id
            ? {
                ...m,
                ...body.config,
                ...(body.source ? { source: body.source } : {}),
                revision: "v2",
                ...(body.enabled !== undefined
                  ? { enabled: body.enabled }
                  : {}),
                ...(body.paused !== undefined ? { paused: body.paused } : {}),
                ...(body.subscriptions
                  ? { subscriptions: body.subscriptions }
                  : {}),
                ...(body.restore_builtin
                  ? {
                      ...defaults(m.role === "advisor" ? "导师" : "文献员"),
                      builtin_update_available: false,
                      source: documentSource(
                        defaults(m.role === "advisor" ? "导师" : "文献员"),
                      ),
                    }
                  : {}),
              }
            : m,
        );
        return route.fulfill({ json: { ok: true } });
      }
      if (method === "DELETE") {
        members = members.filter((m) => m.id !== id);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({
        json: {
          ...member,
          tokens: 120,
          activity: "Reading evidence",
          threads: [
            {
              id: "thread",
              channel_id: cid,
              text: "Evidence",
              last_message_at: "2026-10-24T00:00:00Z",
            },
          ],
        },
      });
    }
    if (path.endsWith("/messages"))
      return route.fulfill({
        json: {
          messages: extraMembers.map((member) => ({
            id: `message-${member.id}`,
            channel_id: cid,
            thread_id: null,
            author_id: member.id,
            text: `Message from ${member.name}`,
            kind: "text",
            mentions: [],
            data: {},
            created_at: "2026-10-24T00:00:00Z",
            replies: 0,
          })),
          root: null,
          research_id: null,
        },
      });
    return route.fulfill({ json: [] });
  });
  await signIn(page);
  await page.goto(`/#team/${wid}/settings?thread=members`);
  return {
    saved,
    externalUpdate: (name: string, source: string, error = "") => {
      members = members.map((m) =>
        m.name === name
          ? {
              ...m,
              ...(error ? {} : sourceConfig(source)),
              source,
              file_error: error,
              revision: `external-${source.length}`,
            }
          : m,
      );
    },
  };
}

for (const locale of ["zh", "en"] as const) {
  for (const available of [false, true]) {
    test(`${locale} 内置成员${available ? "更新" : "恢复"}先确认覆盖修改`, async ({
      page,
    }) => {
      const { saved } = await setup(page, [
        {
          id: "builtin-customized",
          role: "librarian",
          ...defaults("Customized"),
          builtin: true,
          builtin_update_available: available,
          revision: "v1",
          status: "idle",
          active_run_id: null,
        },
      ]);
      await page.evaluate(
        (value) => localStorage.setItem("paper-locale", value),
        locale,
      );
      await page.goto(
        `/#team/${wid}/settings?thread=member:builtin-customized`,
      );
      await page.reload();
      const t = createTranslator(locale).t;
      const label = t(
        available ? "members.updateBuiltin" : "members.restoreBuiltin",
      );
      const button = page.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      await button.click();
      const dialog = page.getByRole("dialog", {
        name: t("members.confirmRestoreBuiltin"),
        exact: true,
      });
      await expect(dialog).toBeVisible();
      expect(saved).toHaveLength(0);
      await dialog
        .getByRole("button", { name: t("common.cancel"), exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      expect(saved).toHaveLength(0);
      await button.click();
      await dialog.getByRole("button", { name: label, exact: true }).click();
      await expect.poll(() => saved.length).toBe(1);
      expect(saved[0]).toEqual({ restore_builtin: true, revision: "v1" });
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByRole("button", {
          name: t("members.restoreBuiltin"),
          exact: true,
        }),
      ).toBeVisible();
    });
  }
}

test("上传头像随成员保存，取消不写入", async ({ page }) => {
  const { saved } = await setup(page);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAC0lEQVR4nGNgQAYAAA4AAamRc7EAAAAASUVORK5CYII=",
    "base64",
  );
  for (const save of [false, true]) {
    await page.getByRole("button", { name: "添加成员", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("名字", { exact: true }).fill("Ada");
    await dialog.getByLabel("上传图片", { exact: true }).setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: png,
    });
    const avatar = dialog.getByRole("group", { name: "头像", exact: true });
    await expect(avatar.locator("img")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    expect(saved).toHaveLength(0);
    await dialog.getByLabel("名字", { exact: true }).fill("Ada II");
    await dialog
      .getByRole("button", { name: save ? "保存" : "取消", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  }
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    config: { name: "Ada II" },
    avatar_upload: { extension: "png", content: png.toString("base64") },
  });
  const row = page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: "Ada II", exact: true }) });
  await expect(row.locator("img")).toBeVisible();
});

test("自定义头像加载失败回退到像素动物", async ({ page }) => {
  await setup(page, [
    {
      id: "broken",
      role: "custom_broken",
      ...defaults("Broken"),
      avatar: ".ora/avatars/missing.png",
      avatar_url: `/api/v1/research/workspaces/${wid}/team/members/broken/avatar`,
      enabled: true,
      status: "idle",
      active_run_id: null,
    },
  ]);
  const row = page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: "Broken", exact: true }) });
  await expect(row.locator("img")).toHaveCount(0);
  await expect(row.locator('svg[shape-rendering="crispEdges"]')).toBeVisible();
});

test("创建、工具、权限、订阅和成员详情", async ({ page }) => {
  const { saved: writes } = await setup(page);
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名字", { exact: true }).fill("Ada");
  await dialog
    .getByLabel("角色说明", { exact: true })
    .fill("# Role heading\n## Evidence\n### Sources\nVerify every claim");
  const avatar = dialog.getByRole("group", { name: "头像", exact: true });
  const before = await avatar.locator("svg").evaluate((svg) => svg.outerHTML);
  await avatar.getByRole("button", { name: "换一个", exact: true }).click();
  await expect(avatar.locator("svg")).not.toHaveJSProperty("outerHTML", before);
  const expectedAvatar = await avatar
    .locator("svg")
    .evaluate((svg) => svg.outerHTML);
  await expect(dialog.getByLabel("头像颜色", { exact: true })).toHaveCount(0);
  await expect(
    avatar.getByRole("button", { name: "上传图片", exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("只读", { exact: true }).check();
  await expect(dialog.getByLabel("命令行", { exact: true })).toBeDisabled();
  await dialog.getByLabel("只读", { exact: true }).uncheck();
  await dialog.getByLabel("网页", { exact: true }).uncheck();
  await expect(dialog.getByLabel("每次唤醒轮数")).toHaveCount(0);
  await dialog.getByLabel("#闲聊", { exact: true }).check();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ada", exact: true }),
  ).toBeVisible();
  expect(writes[0]).toMatchObject({
    config: {
      name: "Ada",
      avatar: expect.stringMatching(/^pixel:.+/),
      wake_turns: 0,
      wake_minutes: 0,
      wake_tokens: 0,
    },
    subscriptions: [cid],
  });
  // The sidebar's avatar is the member's card trigger beside the conversation link.
  await expect(
    page
      .getByRole("navigation", { name: "侧栏", exact: true })
      .getByRole("button", {
        name: createTranslator("zh").t("team.colleague.card", { name: "Ada" }),
        exact: true,
      })
      .locator('svg[shape-rendering="crispEdges"]'),
  ).toHaveJSProperty("outerHTML", expectedAvatar);
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const title = page.getByRole("heading", { name: "Ada", exact: true });
  const back = page.getByRole("button", { name: "返回", exact: true });
  await expect(back).toBeVisible();
  await expect(back.locator("svg")).toBeVisible();
  await expect(back).toHaveText("");
  const titleBox = await title.boundingBox();
  const backBox = await back.boundingBox();
  expect(backBox!.x + backBox!.width).toBeLessThan(titleBox!.x);
  for (const heading of ["Role heading", "Evidence", "Sources"]) {
    const bodyHeading = page.getByRole("heading", {
      name: heading,
      exact: true,
    });
    await expect(bodyHeading).toBeVisible();
    expect(
      await bodyHeading.evaluate((node) =>
        parseFloat(getComputedStyle(node).fontSize),
      ),
    ).toBeLessThan(
      await title.evaluate((node) =>
        parseFloat(getComputedStyle(node).fontSize),
      ),
    );
  }
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(back).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(720);
  await expect(
    page.getByText("Reading evidence", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "参与的线程", exact: true })
      .getByRole("button", { name: /^Evidence/ }),
  ).toBeVisible();
  await page.goto(`/#team/${wid}/${cid}`);
  const composer = page
    .getByTestId("team-screen")
    .getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("@Ad");
  await expect(page.getByRole("option", { name: /Ada/ })).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Ada/ }).locator("svg"),
  ).toHaveJSProperty("outerHTML", expectedAvatar);
  await page.goto(`/#team/${wid}/settings?thread=member%3Acustom-2`);
  await page.getByRole("button", { name: "发私信", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${dmId("custom-2")}$`));
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: member threads use regular list rows, ellipsis and activity dates`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await setup(page);
    await page.clock.setFixedTime(new Date("2026-10-24T07:00:00Z"));
    await page.evaluate(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    const title = "A long thread title with evidence and references. ".repeat(
      30,
    );
    await page.route("**/team/members/advisor", (route) =>
      route.fulfill({
        json: {
          id: "advisor",
          role: "advisor",
          ...defaults("导师"),
          status: "idle",
          active_run_id: null,
          activity: "",
          threads: [
            {
              id: "thread",
              channel_id: cid,
              text: title,
              last_message_at: "2025-12-31T12:00:00Z",
            },
          ],
        },
      }),
    );
    await page.goto(`/#team/${wid}/settings?thread=member:advisor`);
    await page.reload();
    const list = page.getByRole("list", {
      name: t("members.threads"),
      exact: true,
    });
    const row = list.getByRole("button");
    await expect(row.locator("time")).toHaveAttribute(
      "datetime",
      "2025-12-31T12:00:00Z",
    );
    await expect(row.locator("time")).toHaveText(
      locale === "zh" ? "2025年12月31日" : "Dec 31, 2025",
    );
    await expect(row.locator("svg")).toHaveClass(/lucide-message-square/);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => (document.documentElement.dataset.theme = value),
        theme,
      );
      for (const width of [1440, 720]) {
        await page.setViewportSize({ width, height: 1000 });
        const name = row.locator(":scope > span");
        await expect(name).toHaveCSS("font-weight", "400");
        await expect(name).toHaveCSS("white-space", "nowrap");
        await expect(name).toHaveCSS("text-overflow", "ellipsis");
        expect(
          await name.evaluate((node) => node.scrollWidth > node.clientWidth),
        ).toBe(true);
        // Both edges come from one layout: the page is still resizing after the viewport changes.
        const edges = await row.evaluate((element) => ({
          time: element.querySelector("time")!.getBoundingClientRect().left,
          name: element.querySelector(":scope > span")!.getBoundingClientRect()
            .right,
        }));
        expect(edges.time).toBeGreaterThanOrEqual(edges.name);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    }
    await row.click();
    await expect(page).toHaveURL(
      new RegExp(`#team/${wid}/${cid}\\?thread=thread$`),
    );
  });
}

test("复制内置成员、编辑和停用", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("成员来源", { exact: true })
    .selectOption("m:advisor");
  await dialog.getByLabel("名字", { exact: true }).fill("Peer");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "Peer", exact: true }).click();
  await page.getByRole("button", { name: "编辑成员", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("名字", { exact: true })
    .fill("Peer II");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Peer II", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  const row = page.getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Peer II", exact: true }),
  });
  await row.getByRole("button", { name: "成员操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "停用成员", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "停用成员", exact: true })
    .click();
  await expect(row.getByText("已停用", { exact: true })).toBeVisible();
});

test("成员库加入团队和同步确认", async ({ page }) => {
  const { saved: writes } = await setup(page);
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("成员来源", { exact: true })
    .selectOption("l:library-ada");
  await expect(
    page.getByRole("dialog").getByLabel("名字", { exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  expect(writes[0]).toMatchObject({ library_id: "library-ada" });
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  await page.getByRole("button", { name: "编辑库配置", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("角色说明", { exact: true })
    .fill("# Revised library skill");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "同步到各团队？",
    exact: true,
  });
  await confirmation.getByRole("button", { name: "同步", exact: true }).click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      sync: true,
      version: 1,
      config: { role_description: "# Revised library skill" },
    });
});

test("表单、源文件互转保留扩展字段，错误保留当前内容", async ({ page }) => {
  const { saved } = await setup(page);
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名字", { exact: true }).fill("Ada");
  await dialog.getByLabel("简介", { exact: true }).fill("Checks references");
  await dialog.getByLabel("角色说明", { exact: true }).fill("# Form body");
  await dialog.getByRole("button", { name: "源文件", exact: true }).click();
  const editor = dialog.getByLabel("源文件", { exact: true });
  await expect(editor).toHaveValue(/# Form body/);
  const source = (await editor.inputValue()).replace(
    "---\n\n# Form body",
    "future: keep\n---\n\n# Source body",
  );
  await editor.fill(source);
  await dialog.getByRole("button", { name: "表单", exact: true }).click();
  await expect(dialog.getByLabel("角色说明", { exact: true })).toHaveValue(
    "# Source body",
  );
  await dialog.getByRole("button", { name: "源文件", exact: true }).click();
  await expect(editor).toHaveValue(/future: keep/);
  const valid = await editor.inputValue();
  await editor.fill(valid.replace("tools: [files, web]", "tools: broken"));
  await dialog.getByRole("button", { name: "表单", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Line 4");
  await expect(editor).toHaveValue(/tools: broken/);
  await editor.fill(valid);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => saved.at(-1))
    .toMatchObject({
      source: expect.stringContaining("future: keep"),
      config: { name: "Ada", role_description: "# Source body" },
    });
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Source body" }),
  ).toBeVisible();
});

test("选择 Claude 文件和粘贴 Codex 角色", async ({ page }) => {
  const { saved } = await setup(page);
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "导入", exact: true }).click();
  await dialog.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "reader.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "---\nname: Claude reader\ntools: Read, FutureTool\n---\nCheck every source",
    ),
  });
  await expect(dialog.getByLabel("名字", { exact: true })).toHaveValue(
    "Claude reader",
  );
  await expect(dialog.getByRole("status")).toContainText("FutureTool");
  await expect(dialog.getByLabel("文件只读", { exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Claude reader", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => saved[0])
    .toMatchObject({ config: { name: "Claude reader" } });
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "导入", exact: true }).click();
  await dialog.getByLabel("格式", { exact: true }).selectOption("agent.toml");
  await dialog
    .getByLabel("粘贴内容", { exact: true })
    .fill(
      'description = "Codex role"\ndeveloper_instructions = "Read the evidence"',
    );
  await dialog
    .getByRole("button", { name: "导入", exact: true })
    .last()
    .click();
  await expect(dialog.getByLabel("名字", { exact: true })).toHaveValue(
    "codex-reader",
  );
  await expect(dialog.getByLabel("角色说明", { exact: true })).toHaveValue(
    "Read the evidence",
  );
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => saved.at(-1))
    .toMatchObject({
      config: { name: "codex-reader", role_description: "Read the evidence" },
      source: expect.stringContaining("future: keep"),
    });
  await expect(
    page.getByRole("button", { name: "codex-reader", exact: true }),
  ).toBeVisible();
});

test("重新打开成员读取外部修改，坏文件显示行号和上一份定义", async ({
  page,
}) => {
  const { externalUpdate } = await setup(page);
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名字", { exact: true }).fill("Ada");
  await dialog.getByLabel("角色说明", { exact: true }).fill("Last valid body");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Ada", exact: true }),
  ).toBeVisible();
  externalUpdate(
    "Ada",
    documentSource({ ...defaults("Ada"), role_description: "External body" }),
  );
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  await expect(page.getByText("External body", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "搜索成员", exact: true }),
  ).toBeVisible();
  externalUpdate(
    "Ada",
    "---\nname: Ada\ntools: broken\n---",
    "第 3 行 / Line 3: Invalid tools",
  );
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Line 3");
  await expect(page.getByText("External body", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑成员", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByLabel("源文件", { exact: true }),
  ).toHaveValue(/tools: broken/);
});

test("成员列表、私信侧栏和消息头像使用一致的状态点", async ({ page }) => {
  const states = [
    { status: "working", label: "工作中" },
    { status: "queued", label: "排队中" },
    { status: "waiting", label: "等你" },
    { status: "idle", label: "空闲" },
    { status: "working", label: "已停用", enabled: false },
  ] as const;
  const members: TeamMember[] = states.map((state, index) => ({
    ...defaults(`Status ${index}`),
    id: `status-${index}`,
    role: `custom_status_${index}`,
    builtin: false,
    enabled: !("enabled" in state) || state.enabled,
    status: state.status,
    active_run_id: null,
  }));
  await setup(page, members);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const colors = [];
    for (const [index, state] of states.entries()) {
      const row = page.getByRole("listitem").filter({
        has: page.getByRole("button", {
          name: members[index].name,
          exact: true,
        }),
      });
      const dot = row.getByRole("img", { name: state.label, exact: true });
      await expect(dot).toBeVisible();
      await expect(dot).toHaveAttribute(
        "data-status",
        "enabled" in state ? "disabled" : state.status,
      );
      colors.push(
        await dot.evaluate((node) => getComputedStyle(node).backgroundColor),
      );
    }
    expect(new Set(colors).size).toBe(states.length);
    await page.goto(`/#team/${wid}/${cid}`);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const [index, state] of states.entries()) {
      // The avatar and its dot belong to the card trigger beside the conversation link.
      const sidebar = page
        .getByRole("navigation", { name: "侧栏", exact: true })
        .getByRole("group", { name: "消息", exact: true })
        .getByRole("button", {
          name: createTranslator("zh").t("team.colleague.card", {
            name: members[index].name,
          }),
          exact: true,
        });
      const sidebarDot = sidebar.getByRole("img", {
        name: state.label,
        exact: true,
      });
      await expect(
        sidebarDot.locator("..").locator('svg[shape-rendering="crispEdges"]'),
      ).toBeVisible();
      await expect(sidebarDot).toHaveCSS("position", "absolute");
      await expect(sidebarDot).toHaveCSS("right", "0px");
      await expect(sidebarDot).toHaveCSS("bottom", "0px");
      const avatar = page.locator(
        `[data-message-id="message-${members[index].id}"]`,
      );
      for (const container of [sidebar, avatar]) {
        const dot = container.getByRole("img", {
          name: state.label,
          exact: true,
        });
        await expect(dot).toBeVisible();
        await expect(dot).toHaveCSS("background-color", colors[index]);
      }
    }
    await page.goto(`/#team/${wid}/settings?thread=members`);
  }
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: pause and resume a colleague from detail and their card`, async ({
    page,
  }) => {
    const { t } = createTranslator(locale);
    await page.addInitScript(
      (value) => localStorage.setItem("paper-locale", value),
      locale,
    );
    const { saved } = await setup(page);
    await page
      .getByRole("button", { name: t("team.member.advisor"), exact: true })
      .click();
    const pageArea = page.getByTestId("team-screen");
    // The existing member details are reached through settings, without changing their file.
    await page
      .getByRole("button", { name: t("members.pause"), exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: t("members.resume"), exact: true }),
    ).toBeVisible();
    expect(saved.at(-1)).toEqual({ paused: true });
    const direct = page.getByRole("link", {
      name: t("team.member.advisor"),
      exact: true,
    });
    // The status dot is on the card trigger beside the conversation link.
    const dot = page
      .getByRole("navigation", {
        name: t("reader.region.sidebar"),
        exact: true,
      })
      .getByRole("button", {
        name: t("team.colleague.card", { name: t("team.member.advisor") }),
        exact: true,
      });
    await expect(
      dot.getByRole("img", { name: t("team.status.paused"), exact: true }),
    ).toBeVisible();
    await expect(
      direct.getByText(t("team.status.paused"), { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: t("members.message"), exact: true })
      .click();
    const card = pageArea.getByTestId("team-empty");
    await expect(
      card.getByText(t("team.status.paused"), { exact: true }),
    ).toBeVisible();
    await card
      .getByRole("button", { name: t("members.resume"), exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: t("members.pause"), exact: true }),
    ).toBeVisible();
    expect(saved.at(-1)).toEqual({ paused: false });
    await expect(
      dot.getByRole("img", { name: t("team.status.idle"), exact: true }),
    ).toBeVisible();
  });
}
