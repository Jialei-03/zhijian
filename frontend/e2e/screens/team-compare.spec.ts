import { expect, test } from "@playwright/test";
import { signIn } from "../reader/fixtures";
import { mockTeam } from "../fixtures/team";

test.use({ locale: "zh-CN" });

test("evaluation matrix and rerun preserve the selected workflow", async ({
  page,
}) => {
  const wid = "44444444-4444-4444-8444-444444444444";
  const rid = "55555555-5555-4555-8555-555555555555";
  const child = "66666666-6666-4666-8666-666666666666";
  const at = "2026-10-23T00:00:00Z";
  const workflows = [
    { id: "research", name: "研究", builtin: true, version: 1, steps: [] },
    { id: "peers", name: "Peers", builtin: false, version: 1, steps: [] },
  ];
  const project = {
    id: rid,
    workspace_id: wid,
    title: "Q1",
    question: "Q1",
    session_id: rid,
    model_config_id: "model",
    status: "paused",
    stage: "scoping",
    end_reason: "",
    background: "",
    plan: {},
    conclusion_record: {},
    budget: {},
    spent: { sprints: 0, tokens: 0, job_seconds: 0 },
    environment: {},
    compute_id: "host",
    created_at: at,
    updated_at: at,
  };
  let batch: Record<string, unknown> | null = null;
  let createdBody: Record<string, unknown> | null = null;
  let forkBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/health", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, mode: "local" } });
  });
  await page.route("**/api/v1/translation-settings", (route) =>
    route.fulfill({
      json: {
        active_id: "model",
        configured: true,
        models: [{ id: "model", model: "Test", name: "Test" }],
      },
    }),
  );
  await page.route("**/api/v1/research/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/v1/research",
      "",
    );
    if (path === "/navigation")
      return route.fulfill({
        json: {
          workspaces: [
            {
              id: wid,
              name: "Evaluation",
              kind: "eval",
              archived: false,
              location: { kind: "managed", path: "", connection_id: "" },
              researches: [],
            },
          ],
          collections: [],
        },
      });
    if (path === "/workflows") return route.fulfill({ json: workflows });
    if (path === `/workspaces/${wid}/evaluations`) {
      if (route.request().method() === "POST") {
        createdBody = route.request().postDataJSON();
        batch = {
          ...createdBody,
          id: "matrix",
          workspace_id: wid,
          workflows,
          cells: [
            { question: 0, workflow_id: "research", research_id: rid },
            { question: 0, workflow_id: "peers", research_id: child },
          ],
          created_at: at,
        };
        return route.fulfill({ json: batch });
      }
      return route.fulfill({ json: batch ? [batch] : [] });
    }
    if (path === "/evaluations/matrix")
      return route.fulfill({
        json: {
          ...batch,
          threads: [rid, child].map((id, index) => ({
            id,
            title: "Q1",
            workflow: workflows[index].name,
            status: "finished",
            conclusion: "L2 helps.",
            numbers: [],
            tokens: 100,
            job_seconds: 0,
            elapsed_seconds: 90,
            rounds: 1,
            members: [],
          })),
        },
      });
    if (path.endsWith("/forks/options"))
      return route.fulfill({
        json: {
          can_fork: true,
          reason: "",
          rounds: [
            {
              sprint_id: "sprint",
              number: 1,
              role: "executor",
              status: "ended",
              summary: "Done",
              commit_sha: "a".repeat(40),
              available: true,
              reason: "",
            },
          ],
        },
      });
    if (path.endsWith("/forks")) {
      forkBody = route.request().postDataJSON();
      return route.fulfill({ json: { ...project, id: child } });
    }
    if (path === `/projects/${rid}` || path === `/projects/${child}`)
      return route.fulfill({
        json: {
          project: { ...project, id: path.split("/").pop() },
          nodes: [],
          sprints: [],
          jobs: [],
          datasets: [],
          docker: { available: true, reason: "" },
          input_needed: "",
        },
      });
    if (path === "/settings")
      return route.fulfill({ json: { computes: [], states: {} } });
    if (path.endsWith("/changes"))
      return route.fulfill({ json: { files: [], added: 0, removed: 0 } });
    return route.fulfill({ json: [] });
  });
  await mockTeam(page);
  await signIn(page);
  await page.goto(`/#workspaces/${wid}/compare`);
  await page.getByRole("button", { name: "新建评测", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill("Matrix");
  await dialog.getByLabel("问题", { exact: true }).fill("Q1");
  await dialog.getByLabel("研究", { exact: true }).check();
  await dialog.getByLabel("Peers", { exact: true }).check();
  await dialog.getByRole("button", { name: "运行评测", exact: true }).click();
  await expect
    .poll(() => createdBody?.workflow_ids)
    .toEqual(["research", "peers"]);
  await expect(page.getByRole("table", { name: "Matrix" })).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Matrix" })
      .getByRole("columnheader", { name: "研究", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Matrix" })
      .getByText("1 分 30 秒", { exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("table", { name: "Matrix" })
    .getByRole("link", { name: "已完成" })
    .first()
    .click();
  await page
    .getByRole("button", { name: "更多操作", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "换个工作流再做一遍", exact: true })
    .click();
  await page.getByRole("dialog").getByLabel("Peers", { exact: true }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建分叉", exact: true })
    .click();
  await expect.poll(() => forkBody?.workflow_id).toBe("peers");
  await expect(page).toHaveURL(new RegExp(`#research/${child}$`));
});

for (const theme of ["light", "dark"]) {
  test(`comparison: columns, differences, navigation and narrow layout (${theme})`, async ({
    page,
  }) => {
    const wid = "11111111-1111-4111-8111-111111111111";
    const ids = [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    await page.addInitScript(
      (value) => localStorage.setItem("paper-appearance", value),
      theme,
    );
    await page.route("**/api/v1/health", async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({ json: { ...real, mode: "local" } });
    });
    await page.route("**/api/v1/research/navigation", (route) =>
      route.fulfill({
        json: {
          workspaces: [
            {
              id: wid,
              name: "Comparison",
              kind: "research",
              archived: false,
              location: { kind: "managed", path: "", connection_id: "" },
              researches: ids.map((id, index) => ({
                id,
                title: `Study ${index + 1}`,
                question: "L2?",
                status: "finished",
                stage: "done",
                column: "done",
                workspace_id: wid,
              })),
            },
          ],
          collections: [],
        },
      }),
    );
    await page.route("**/api/v1/research/compare?*", (route) =>
      route.fulfill({
        json: {
          threads: ids.map((id, index) => ({
            id,
            title: `Study ${index + 1}`,
            workflow: index ? "Peers" : "研究",
            status: "finished",
            conclusion: "L2 helps.",
            numbers: [{ name: "accuracy", value: index ? 0.95 : 0.91 }],
            tokens: index ? 800 : 1000,
            job_seconds: 90,
            elapsed_seconds: index ? 6758 : 9408,
            rounds: 2,
            members: [
              { id: "executor", name: "executor", messages: 2, tokens: 800 },
            ],
          })),
        },
      }),
    );
    await signIn(page);
    await page.goto(`/#workspaces/${wid}/compare`);
    const table = page.getByRole("table", { name: "比较" });
    await expect(
      table.getByRole("columnheader", { name: /Study 1/ }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: /Study 1/ }),
    ).toContainText("研究");
    await expect(
      table.getByRole("columnheader", { name: /Study 1/ }),
    ).not.toContainText("research");
    await expect(table.getByText("1 分 30 秒", { exact: true })).toHaveCount(2);
    await expect(
      table.getByText("2 小时 37 分", { exact: true }),
    ).toBeVisible();
    await expect(
      table.getByText("1 小时 53 分", { exact: true }),
    ).toBeVisible();
    await expect(
      table.locator('[data-different="true"]').filter({ hasText: "0.95" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 720, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await table.getByRole("link", { name: "Study 2" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#research/${ids[1]}$`));
  });
}
