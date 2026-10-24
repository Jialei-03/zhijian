import { expect, test, type Page } from "@playwright/test";
import type { Workflow } from "../src/screens/team/workflow/workflow-model";

const state = async (page: Page): Promise<Workflow> =>
  JSON.parse((await page.getByTestId("workflow-state").textContent())!);
const row = (page: Page, id: string) => page.locator(`[data-rule-id="${id}"]`);
const node = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const edge = (page: Page, id: string) =>
  page.locator(`.react-flow__edge[data-id="${id}"]`);
// Edge labels render above the nodes, outside the edge's SVG group.
const label = (page: Page, id: string) =>
  page.locator(`[data-edge-label="${id}"]`);

async function expectReadableCanvas(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvasElement = document.querySelector(
          '[data-testid="workflow-canvas"]',
        )!;
        const canvas = canvasElement.getBoundingClientRect();
        const nodes = [...document.querySelectorAll(".react-flow__node")].map(
          (element) => element.getBoundingClientRect(),
        );
        const viewport = document.querySelector<HTMLElement>(
          ".react-flow__viewport",
        )!;
        const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
          .a;
        const paths = [
          ...document.querySelectorAll<SVGPathElement>(
            ".react-flow__edge-path",
          ),
        ];
        const boxes = [
          ...nodes,
          ...paths.map((path) => path.getBoundingClientRect()),
        ];
        const bounds = {
          left: Math.min(...boxes.map((box) => box.left)),
          right: Math.max(...boxes.map((box) => box.right)),
          top: Math.min(...boxes.map((box) => box.top)),
          bottom: Math.max(...boxes.map((box) => box.bottom)),
        };
        const graphWidth = (bounds.right - bounds.left) / zoom;
        const graphHeight = (bounds.bottom - bounds.top) / zoom;
        const fits =
          graphWidth <= canvas.width - 48 && graphHeight <= canvas.height - 48;
        const intersects = (a: DOMRect, b: DOMRect) =>
          a.left < b.right - 1 &&
          a.right > b.left + 1 &&
          a.top < b.bottom - 1 &&
          a.bottom > b.top + 1;
        return (
          nodes.length > 0 &&
          zoom >= 0.85 &&
          zoom <= 1 &&
          (fits
            ? zoom === 1 &&
              Math.abs(
                (bounds.left + bounds.right) / 2 -
                  (canvas.left + canvas.width / 2),
              ) < 2 &&
              Math.abs(
                (bounds.top + bounds.bottom) / 2 -
                  (canvas.top + canvas.height / 2),
              ) < 2
            : Math.abs(
                Math.min(...nodes.map((box) => box.left)) - canvas.left - 24,
              ) < 2 &&
              Math.abs(
                zoom -
                  Math.max(
                    0.85,
                    Math.min(
                      1,
                      (canvas.width - 48) / graphWidth,
                      (canvas.height - 48) / graphHeight,
                    ),
                  ),
              ) < 0.001) &&
          nodes.every(
            (box, index) =>
              Math.abs(box.width / zoom - 168) < 1 &&
              Math.abs(box.height / zoom - 44) < 1 &&
              nodes.slice(index + 1).every((other) => !intersects(box, other)),
          ) &&
          paths.every((path) =>
            /^M [^C]+(?: C [^CLQ]+)+$/.test(path.getAttribute("d") ?? ""),
          ) &&
          [...document.querySelectorAll(".react-flow__edge-text")].every(
            (label) => {
              const style = getComputedStyle(label);
              const background = label.parentElement!.querySelector(
                ".react-flow__edge-textbg",
              );
              return (
                style.fontSize ===
                  style.getPropertyValue("--ui-text-12").trim() &&
                background !== null &&
                background.getBoundingClientRect().width > 0 &&
                getComputedStyle(background).fill ===
                  getComputedStyle(canvasElement).backgroundColor
              );
            },
          ) &&
          [...document.querySelectorAll('[role="status"][data-status]')].every(
            (dot) => dot.textContent === "" && !!dot.getAttribute("aria-label"),
          )
        );
      }),
    )
    .toBe(true);
}

for (const locale of ["en", "zh"] as const) {
  test(`${locale} auto layout merges rules, keeps readable zoom and persists arranged positions`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(
      `/e2e-ui/workflow.html?locale=${locale}&layout=auto&parallel=1&theme=dark`,
    );
    const canvasTab = page.getByRole("tab", {
      name: locale === "en" ? "Canvas" : "画布",
      exact: true,
    });
    await canvasTab.click();
    await expectReadableCanvas(page);
    await expect(page.locator(".react-flow__edge")).toHaveCount(5);
    await expect(label(page, "rule:review")).toContainText(
      locale === "en" ? "Review ×2 · Wake" : "评审 ×2 · 唤醒",
    );
    await expect(label(page, "return:review")).toContainText(
      locale === "en" ? "Return ×2" : "退回 ×2",
    );
    await expect(edge(page, "rule:wake")).toHaveCount(0);
    expect((await state(page)).layout).toEqual({ members: {}, channels: {} });
    const bounds = await page
      .locator(".react-flow__node")
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((node) => [
            node.getAttribute("data-id"),
            node.getBoundingClientRect().x,
          ]),
        ),
      );
    expect(bounds["member:owner"]).toBeLessThan(bounds["channel:papers"]);
    expect(bounds["channel:papers"]).toBeLessThan(bounds["member:executor"]);
    expect(bounds["member:executor"]).toBeLessThan(bounds["member:reviewer"]);

    const palette = page.getByRole("complementary", {
      name: locale === "en" ? "Node actions" : "节点操作",
      exact: true,
    });
    const placedMember = palette.getByRole("button", {
      name: "Alex",
      exact: true,
    });
    const unplacedMember = palette.getByRole("button", {
      name: locale === "en" ? "Add Sam" : "添加 Sam",
      exact: true,
    });
    const placedChannel = palette.getByRole("button", {
      name: "Papers",
      exact: true,
    });
    await expect(placedMember).toHaveAttribute("data-placed", "true");
    await expect(unplacedMember).toHaveAttribute("data-placed", "false");
    await expect(placedMember.locator("svg.lucide-plus")).toHaveCount(0);
    await expect(unplacedMember.locator("svg.lucide-plus")).toHaveCount(1);
    await expect(placedChannel.locator("svg.lucide-hash")).toHaveCount(1);
    const textLeft = async (button: typeof placedMember) =>
      (await button.locator("span").last().boundingBox())!.x;
    expect(await textLeft(placedMember)).toBeCloseTo(
      await textLeft(unplacedMember),
      0,
    );
    expect(await textLeft(placedMember)).toBeCloseTo(
      await textLeft(placedChannel),
      0,
    );

    await node(page, "member:executor").press("ArrowRight");
    await expect
      .poll(async () => Object.keys((await state(page)).layout.members))
      .toEqual(["executor"]);
    const moved = (await state(page)).layout.members.executor;
    await page
      .getByRole("tab", {
        name: locale === "en" ? "List" : "列表",
        exact: true,
      })
      .click();
    await canvasTab.click();
    expect((await state(page)).layout.members.executor).toEqual(moved);

    const arrange = page.getByRole("button", {
      name: locale === "en" ? "Auto arrange" : "自动整理",
      exact: true,
    });
    await arrange.click();
    await expect
      .poll(async () => Object.keys((await state(page)).layout.members).length)
      .toBe(3);
    const arranged = await state(page);
    expect(arranged.layout.members.executor).not.toEqual(moved);
    await expectReadableCanvas(page);
    await arrange.click();
    await expect
      .poll(async () => (await state(page)).layout)
      .toEqual(arranged.layout);
    await page
      .getByRole("tab", {
        name: locale === "en" ? "List" : "列表",
        exact: true,
      })
      .click();
    await canvasTab.click();
    expect((await state(page)).layout).toEqual(arranged.layout);
    await expectReadableCanvas(page);
    await edge(page, "rule:review").press("Enter");
    const rules = page.getByRole("dialog", {
      name: locale === "en" ? "Rules" : "规则",
      exact: true,
    });
    await expect(rules.locator("[data-rule-id]")).toHaveCount(3);
    await rules.getByRole("button", { name: /^wake:/ }).click();
    const editor = page.getByRole("dialog", {
      name: locale === "en" ? "Edit rule" : "编辑规则",
      exact: true,
    });
    await expect(
      editor.getByLabel(locale === "en" ? "Action" : "动作", { exact: true }),
    ).toHaveValue("wake");
    await editor
      .getByLabel(locale === "en" ? "Instruction" : "指示", { exact: true })
      .fill("Selected wake rule");
    await editor
      .getByRole("button", {
        name: locale === "en" ? "Save" : "保存",
        exact: true,
      })
      .click();
    expect(
      (await state(page)).rules.find((rule) => rule.id === "wake")!.then
        .instruction,
    ).toBe("Selected wake rule");
    expect(
      (await state(page)).rules.find((rule) => rule.id === "review")!.then
        .instruction,
    ).toBe("Check results");
  });
}

for (const locale of ["en", "zh"] as const) {
  test(`${locale} research canvas groups fifteen rules, separates feedback and keeps panning readable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1096, height: 800 });
    await page.goto(
      `/e2e-ui/workflow.html?fixture=research&locale=${locale}&theme=${locale === "en" ? "light" : "dark"}`,
    );
    await page
      .getByRole("tab", {
        name: locale === "en" ? "Canvas" : "画布",
        exact: true,
      })
      .click();
    await expect(page.locator(".react-flow__node")).toHaveCount(6);
    await expect(page.locator(".react-flow__edge")).toHaveCount(10);
    await expectReadableCanvas(page);
    expect((await state(page)).rules).toHaveLength(15);
    const labWake = edge(page, "rule:research:lab:job_finished");
    await expect(
      label(page, (await labWake.getAttribute("data-id"))!),
    ).toContainText(locale === "en" ? "Wake ×3" : "唤醒 ×3");
    await expect(edge(page, "rule:research:lab:plan_approved")).toHaveCount(0);
    await expect(edge(page, "rule:research:lab:review_failed")).toHaveCount(0);
    await expect(label(page, "rule:research:approved-start")).toContainText(
      locale === "en" ? "Wake ×2" : "唤醒 ×2",
    );
    await expect(label(page, "return:research:1:result")).toContainText(
      locale === "en" ? "Return · Wake" : "退回 · 唤醒",
    );
    const midpoint = (id: string) =>
      edge(page, id)
        .locator(".react-flow__edge-path")
        .evaluate((element) => {
          const path = element as SVGPathElement;
          return path.getPointAtLength(path.getTotalLength() / 2).y;
        });
    expect(await midpoint("rule:research:start")).toBeLessThan(
      await midpoint("rule:research:0:wait"),
    );
    const loop = await edge(page, "rule:research:2:continue")
      .locator(".react-flow__edge-path")
      .evaluate((element) => {
        const bounds = (element as SVGPathElement).getBBox();
        return { width: bounds.width, height: bounds.height };
      });
    expect(loop.width).toBeCloseTo(28);
    expect(loop.height).toBeCloseTo(28);
    const geometry = await page.evaluate(() => {
      const matrix = new DOMMatrixReadOnly(
        getComputedStyle(
          document.querySelector(".react-flow__viewport")!,
        ).transform,
      );
      const nodes = [...document.querySelectorAll(".react-flow__node")].map(
        (node) => node.getBoundingClientRect(),
      );
      const paths = [
        ...document.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
      ];
      const boxes = [
        ...nodes,
        ...paths.map((path) => path.getBoundingClientRect()),
      ];
      return {
        zoom: matrix.a,
        width:
          (Math.max(...boxes.map((box) => box.right)) -
            Math.min(...boxes.map((box) => box.left))) /
          matrix.a,
        height:
          (Math.max(...boxes.map((box) => box.bottom)) -
            Math.min(...boxes.map((box) => box.top))) /
          matrix.a,
        feedbackHeights: paths
          .filter(
            (path) =>
              (path.getAttribute("d")!.match(/ C /g) ?? []).length === 2,
          )
          .map((path) => {
            const start = path.getPointAtLength(0);
            const end = path.getPointAtLength(path.getTotalLength());
            const bounds = path.getBBox();
            return bounds.y + bounds.height - Math.max(start.y, end.y);
          }),
      };
    });
    expect(geometry.zoom).toBe(1);
    expect(geometry.width).toBeLessThanOrEqual(900);
    expect(geometry.height).toBeLessThanOrEqual(520);
    expect(geometry.feedbackHeights.length).toBeGreaterThan(0);
    for (const height of geometry.feedbackHeights) {
      expect(height).toBeCloseTo(42);
      expect(height).toBeLessThanOrEqual(70);
    }
    await expect(
      node(page, "member:executor").locator('[data-size="sm"]'),
    ).toHaveCount(1);

    const rules = page.getByRole("dialog", {
      name: locale === "en" ? "Rules" : "规则",
      exact: true,
    });
    const editor = page.getByRole("dialog", {
      name: locale === "en" ? "Edit rule" : "编辑规则",
      exact: true,
    });
    for (const event of ["job_finished", "plan_approved", "review_failed"]) {
      await page
        .locator(`[data-edge-label="${await labWake.getAttribute("data-id")}"]`)
        .click();
      await expect(rules.locator("[data-rule-id]")).toHaveCount(3);
      expect(
        await rules
          .locator("[data-rule-id]")
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute("data-rule-id")),
          ),
      ).toEqual([
        "research:lab:job_finished",
        "research:lab:plan_approved",
        "research:lab:review_failed",
      ]);
      await rules
        .locator(`[data-rule-id="research:lab:${event}"]`)
        .getByRole("button")
        .click();
      await expect(
        editor.getByLabel(locale === "en" ? "Event" : "事件", { exact: true }),
      ).toHaveValue(event);
      await editor
        .getByLabel(locale === "en" ? "Instruction" : "指示", { exact: true })
        .fill(event);
      await editor
        .getByRole("button", {
          name: locale === "en" ? "Save" : "保存",
          exact: true,
        })
        .click();
    }
    expect(
      (await state(page)).rules
        .filter((rule) => rule.id.startsWith("research:lab:"))
        .map((rule) => rule.then.instruction),
    ).toEqual(["job_finished", "plan_approved", "review_failed"]);
    await expect(
      label(page, (await labWake.getAttribute("data-id"))!),
    ).toContainText(locale === "en" ? "Wake ×3" : "唤醒 ×3");
    await expect(page.locator(".react-flow__edge")).toHaveCount(10);

    await page.locator('[data-edge-label="rule:research:start"]').click();
    await expect(rules.locator("[data-rule-id]")).toHaveCount(2);
    await rules
      .getByRole("button", { name: /^research:discuss-conclusion:/ })
      .click();
    await expect(
      editor.getByLabel(locale === "en" ? "Message type" : "消息类型", {
        exact: true,
      }),
    ).toHaveValue("text");
    await editor
      .getByRole("button", {
        name: locale === "en" ? "Cancel" : "取消",
        exact: true,
      })
      .click();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("ora-workflow-runtime", {
          detail: {
            members: {},
            fired: [{ rule: "research:reopen", at: new Date().toISOString() }],
          },
        }),
      ),
    );
    await expect(edge(page, "rule:research:approved-start")).toHaveClass(
      /animated/,
    );

    const viewport = () =>
      page.locator(".react-flow__viewport").evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(
          getComputedStyle(element).transform,
        );
        return { x: matrix.e, zoom: matrix.a };
      });
    const before = await viewport();
    const canvas = (await page.getByTestId("workflow-canvas").boundingBox())!;
    await page.mouse.move(canvas.x + canvas.width - 24, canvas.y + 24);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width - 224, canvas.y + 24, {
      steps: 8,
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await viewport()).x)
      .toBeLessThan(before.x - 100);
    expect((await viewport()).zoom).toBe(before.zoom);
    expect((await state(page)).layout).toEqual({ members: {}, channels: {} });
    for (let index = 0; index < 6; index++)
      await page
        .getByRole("button", {
          name: locale === "en" ? "Zoom out" : "缩小",
          exact: true,
        })
        .click();
    await expect.poll(async () => (await viewport()).zoom).toBe(0.85);
    await page
      .getByRole("button", {
        name: locale === "en" ? "Fit canvas" : "适应画布",
        exact: true,
      })
      .click();
    await expectReadableCanvas(page);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`workflow edits, keyboard layout and runtime stay shared at 720px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await page.goto(`/e2e-ui/workflow.html?theme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await row(page, "review").getByRole("button", { name: /When/ }).click();
    const editor = page.getByRole("dialog", { name: "Edit rule", exact: true });
    await editor
      .getByLabel("Instruction", { exact: true })
      .fill("Check uncertainty");
    await editor.getByLabel("Trigger limit per thread").fill("7");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row(page, "review")).not.toContainText("Check uncertainty");
    await expect(
      row(page, "review").getByRole("button", { name: /^When/ }),
    ).toHaveText(
      "When Lab · Alex · Message received · Result → Morgan · Review",
    );
    await row(page, "review").getByRole("switch").click();
    await expect(row(page, "review").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await row(page, "review")
      .getByRole("button", { name: "Drag to reorder", exact: true })
      .focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect
      .poll(async () => (await state(page)).rules.map((rule) => rule.id))
      .toEqual(["wait", "review", "subscribe", "schedule"]);

    await page.getByRole("tab", { name: "Canvas", exact: true }).click();
    await expectReadableCanvas(page);
    expect(
      await page
        .locator(".react-flow__viewport")
        .evaluate(
          (element) =>
            new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
        ),
    ).toBe(0.85);
    await expect(node(page, "member:executor")).toBeVisible();
    await expect(
      node(page, "member:executor").getByRole("status", {
        name: "Working",
        exact: true,
      }),
    ).toBeAttached();
    await expect(
      node(page, "member:reviewer").getByRole("status", {
        name: "Waiting for you",
        exact: true,
      }),
    ).toBeAttached();
    await edge(page, "rule:review").focus();
    await page.keyboard.press("Enter");
    await expect(editor.getByLabel("Instruction", { exact: true })).toHaveValue(
      "Check uncertainty",
    );
    await expect(editor.getByLabel("Trigger limit per thread")).toHaveValue(
      "7",
    );
    await editor.getByLabel("Review limit", { exact: true }).fill("4");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await edge(page, "return:review").focus();
    await page.keyboard.press("Enter");
    await expect(
      editor.getByLabel("Review limit", { exact: true }),
    ).toHaveValue("4");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();

    await node(page, "member:executor").focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => (await state(page)).layout.members.executor.x)
      .toBe(10);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workflow-opened")).toHaveText(
      JSON.stringify({ kind: "member", id: "executor" }),
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("ora-workflow-runtime", {
          detail: {
            members: { executor: "waiting" },
            fired: [{ rule: "subscribe", at: new Date().toISOString() }],
          },
        }),
      ),
    );
    await expect(
      node(page, "member:executor").getByRole("status", {
        name: "Waiting for you",
        exact: true,
      }),
    ).toBeAttached();
    await expect(edge(page, "rule:subscribe")).toHaveClass(/animated/);
    await expect(edge(page, "rule:subscribe")).not.toHaveClass(/animated/, {
      timeout: 4000,
    });
    await page.getByRole("button", { name: "Add Sam", exact: true }).click();
    await expect(node(page, "member:writer")).toBeAttached();
    await page
      .getByRole("button", { name: "Add Writing", exact: true })
      .dragTo(page.locator(".react-flow__pane"));
    await expect
      .poll(async () => (await state(page)).layout.channels.writing)
      .toBeTruthy();
    await page.getByRole("tab", { name: "List", exact: true }).click();
    await expect(row(page, "review")).not.toContainText("Up to 4 times");
    await expect(row(page, "review").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("dragging a connection creates a rule only after saving the shared editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/e2e-ui/workflow.html");
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await expectReadableCanvas(page);
  // Keyboard focus pans saved nodes into view without reducing the readable zoom.
  await page.keyboard.press("Tab");
  await node(page, "member:executor").focus();
  const source = node(page, "member:executor").locator('[data-handleid="out"]');
  const target = node(page, "member:reviewer").locator('[data-handleid="in"]');
  await expect(source).toBeInViewport();
  await expect(target).toBeInViewport();
  const dragConnection = async () => {
    const start = (await source.boundingBox())!;
    const end = (await target.boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
  };
  await dragConnection();
  const editor = page.getByRole("dialog", { name: "Edit rule", exact: true });
  await expect(editor.getByLabel("Author", { exact: true })).toHaveValue(
    "m:executor",
  );
  await expect(editor.getByLabel("Member", { exact: true })).toHaveValue(
    "m:reviewer",
  );
  expect((await state(page)).rules).toHaveLength(4);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await state(page)).rules).toHaveLength(4);
  await dragConnection();
  const triggerLimit = editor.getByLabel("Trigger limit per thread");
  await expect(triggerLimit).toHaveValue("");
  await expect(triggerLimit).toHaveAttribute("placeholder", "Unlimited");
  await editor.getByLabel("Action", { exact: true }).selectOption("review");
  const reviewLimit = editor.getByLabel("Review limit", { exact: true });
  await expect(reviewLimit).toHaveValue("");
  await expect(reviewLimit).toHaveAttribute("placeholder", "Unlimited");
  await triggerLimit.fill("2");
  await reviewLimit.fill("2");
  await triggerLimit.fill("");
  await reviewLimit.fill("");
  await triggerLimit.fill("0");
  await reviewLimit.fill("0");
  await expect(triggerLimit).toHaveValue("");
  await expect(reviewLimit).toHaveValue("");
  await editor.getByLabel("Instruction", { exact: true }).fill("Cross-check");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await state(page)).rules.length).toBe(5);
  expect((await state(page)).rules.at(-1)).toMatchObject({
    limit: { per_thread: 0 },
    then: { action: "review", max_rounds: 0 },
  });
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /When Alex.*Morgan · Review/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "List", exact: true }),
  ).not.toContainText("Cross-check");
});

for (const locale of ["en", "zh"] as const) {
  test(`${locale} list keeps long summaries on one line and full instructions in the editor`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await page.goto(`/e2e-ui/workflow.html?locale=${locale}`);
    const labels =
      locale === "en"
        ? {
            edit: "Edit rule",
            instruction: "Instruction",
            save: "Save",
            cancel: "Cancel",
            schedule: "Schedule",
            list: "List",
          }
        : {
            edit: "编辑规则",
            instruction: "指示",
            save: "保存",
            cancel: "取消",
            schedule: "定时",
            list: "列表",
          };
    const summary = row(page, "schedule").getByRole("button", {
      name: /^(When|当)/,
    });
    await summary.click();
    const editor = page.getByRole("dialog", { name: labels.edit, exact: true });
    const instruction =
      "总结实验结论。".repeat(100) +
      "\naction: conclusion\naction: retrospective";
    await editor
      .getByLabel(labels.instruction, { exact: true })
      .fill(instruction);
    // A valid long cron expression exercises actual ellipsis overflow at 720px.
    await editor
      .getByLabel(labels.schedule, { exact: true })
      .fill(
        Array.from({ length: 60 }, (_, index) => index).join(",") + " 9 * * *",
      );
    await editor
      .getByRole("button", { name: labels.save, exact: true })
      .click();
    const list = page.getByRole("list", { name: labels.list, exact: true });
    await expect(list).not.toContainText("action:");
    await expect(list).not.toContainText("总结实验结论");
    const singleLine = await summary.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        whiteSpace: style.whiteSpace,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        truncated: element.scrollWidth > element.clientWidth,
      };
    });
    expect(singleLine).toEqual({
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      truncated: true,
    });
    await summary.click();
    await expect(
      editor.getByLabel(labels.instruction, { exact: true }),
    ).toHaveValue(instruction);
    await editor
      .getByRole("button", { name: labels.cancel, exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("Chinese list supports drag ordering and confirmed deletion", async ({
  page,
}) => {
  await page.goto("/e2e-ui/workflow.html?locale=zh");
  await row(page, "schedule")
    .getByRole("button", { name: "拖动排序", exact: true })
    .dragTo(row(page, "review"));
  await expect
    .poll(async () => (await state(page)).rules[0].id)
    .toBe("schedule");
  await row(page, "schedule")
    .getByRole("button", { name: "规则操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "删除规则", exact: true }).click();
  const confirm = page.getByRole("dialog", {
    name: "删除这条规则？",
    exact: true,
  });
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row(page, "schedule")).toBeVisible();
  await row(page, "schedule")
    .getByRole("button", { name: "规则操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "删除规则", exact: true }).click();
  await confirm.getByRole("button", { name: "删除规则", exact: true }).click();
  await expect(row(page, "schedule")).toHaveCount(0);
});
