已归档：2026-10-24，现行设计见 [工作流](../workflows.md)。

# 工作流列表与画布：前端接线

实现只使用 `agent-team-contract.md` 的成员、频道、规则、工作流与运行状态。没有请求接口、持久化存储或新依赖。

## 入口

`frontend/src/screens/team/workflow/WorkflowView.tsx`

```ts
interface WorkflowViewProps {
  workflow: Workflow;
  members: WorkflowMember[]; // { id, name, kind: "human" | "agent", role }
  channels: WorkflowChannel[]; // { id, name, kind: "channel" | "dm" }
  onChange(workflow: Workflow): void;
  runtime?: WorkflowRuntime;
  initialView?: "list" | "canvas";
  onOpenNode?(target: { kind: "member" | "channel"; id: string }): void;
}
```

完整类型从同目录 `workflow-model.ts` 导出。挂在现有 `I18nProvider` 和有确定高度的团队主区内；深浅色沿用全局 tokens。`WorkflowView` 持有视图切换及编辑器草稿，外层持有唯一的工作流数据。切换工作流 ID 会清除旧编辑草稿。

`onChange` 同步返回完整的新工作流。外层立即更新 props，再对接保存接口和失败反馈；`version` 原样保留，由外层/服务端处理版本冲突。保存规则、启停、排序、删除、添加节点、节点排版都走这个回调。拖线只打开草稿，取消不触发保存。

`onOpenNode` 对接第 1 步的成员私信/频道最近消息。鼠标点击与键盘 Enter 都交给同一回调。未提供时显示节点操作对话框。

## 独立组件

```ts
WorkflowRules(props: WorkflowDataProps & {
  onEdit(rule: WorkflowRule): void;
  query?: string;
}): React.JSX.Element;

WorkflowCanvas(props: WorkflowDataProps & {
  runtime?: WorkflowRuntime;
  onEdit(rule: WorkflowRule): void;
  onCreate(rule: WorkflowRule): void;
  onOpenNode?(target: WorkflowNodeTarget): void;
}): React.JSX.Element;

RuleEditor(props: {
  rule: WorkflowRule;
  members: WorkflowMember[];
  channels: WorkflowChannel[];
  onSave(rule: WorkflowRule): void;
  onClose(): void;
}): React.JSX.Element;
```

单独使用视图时，调用方管理并挂载同一个 `RuleEditor`；切换编辑规则时以规则 ID 为 React key。

## 数据映射

- 成员、频道：使用引用 ID；位置在 `layout.members` / `layout.channels`。未被规则引用且没有布局记录的实体留在侧栏，可拖入或用键盘按钮添加。
- 订阅：`message + channel → wake`，没有新增 action。
- 评审：主线和退回线都只保存原规则 ID，任意一条线打开同一编辑器。`on_fail` 支持成员 ID 和角色。
- 按角色引用时，画布显示传入成员中的首个匹配项；原规则仍保留角色引用，执行解析由规则引擎负责。
- 等我：优先取 `kind=human, role=owner`，否则取首个人类成员。尚未传入人类成员时显示不可拖动的“我”占位节点，不增加成员记录。
- 定时：时钟节点的位置存 `Rule.position`；没有频道或作者的其他事件也用事件节点表示，位置同样存 `Rule.position`。定时编辑接受五段数字 cron（含范围、列表、步进）和有效时区。
- 运行状态：从 `runtime.members` 叠加；`runtime.fired` 使用 ISO 时间，高亮最近 1.6 秒触发的规则，自动恢复。运行状态变化不覆盖正在拖动的节点位置。
- 无头像字段时由名字生成字母头像；不新增头像数据接口。

## 键盘与测试

列表：Enter 编辑；开关即时生效；菜单中上移、下移、删除；拖动柄可用 Alt+↑/↓ 排序。画布：Tab 聚焦节点和连线；Enter/Space 打开；节点方向键移动，Shift 加大步长；侧栏按钮为拖入节点提供键盘入口。

Vitest：`src/screens/team/workflow/workflow-model.test.ts` 覆盖规则/连线、编辑保存、排序、输入校验、布局回调、运行状态和中英文表单。

Playwright：`frontend/e2e-ui/workflow.spec.ts` 使用独立的 `/e2e-ui/workflow.html`，不经过业务后端。演示入口只在 `import.meta.env.DEV` 挂载，也不进入生产构建。负责人运行：

```sh
cd frontend
npx playwright test -c playwright.ui.config.ts e2e-ui/workflow.spec.ts
```

用例覆盖深浅色、720px、列表和连线编辑、键盘布局、消息回调、运行状态、侧栏添加/拖入、拖线新建、拖动排序及删除确认。本工作区遵守限制未启动浏览器，合并时需实际运行这些用例。

共享 `node_modules` 指向另一个工作区时，沙箱不允许 Vite 写 `.vite-temp`。可用 `npx vitest run --configLoader runner --cache=false` 与 `npx vite build --configLoader runner`，不需要安装依赖或修改共享目录。

## 合并负责人接线

1. 在团队工作流入口挂 `WorkflowView`，把第 1 步成员/频道投影为 contract 引用。
2. 把当前工作流及 `onChange` 接到规则和布局的读取/保存接口，保留数组顺序。
3. 把运行状态订阅接到 `runtime`，时间使用 ISO 格式。
4. 把 `onOpenNode` 接到成员私信和频道消息视图。
5. 合并 `teamWorkflow.*` 中英文文案；运行 Playwright 并做实际视觉验收。

## 本工作区验证（2026-10-23）

- 相关 Vitest：21 项通过，其中工作流测试 13 项。
- `npm run check`：通过（catalog、TypeScript、Prettier）。
- 全量 Vitest runner：47 个文件、361 项通过。
- 业务构建：TypeScript 通过；Vite runner 构建通过；`copy-docs.mjs` 通过。保留现有大 chunk 警告。
- 独立演示入口：以 DEV 定义开启后单独打包通过，验证新组件和 CSS 实际参与打包。
- Playwright 用例 TypeScript 检查：通过；4 个浏览器用例未运行。
- `.venv/bin/python -m pytest -n 0 backend/tests/test_research_workflows.py backend/tests/test_research_schedules.py`：42 项通过，2 个已有依赖弃用警告。夹具使用临时 SQLite 和脚本模型。

标准命令在当前沙箱中的失败原文（Vite 要写入指向其他工作区的共享 `node_modules`，runner 方式已通过）：

`npx vitest run`

```text
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/team-canvas/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792741990921-80e241bbff808.mjs'
```

`npm run build`

```text
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/team-canvas/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792742004659-3a1034685e8f9.mjs'
```

独立演示入口首次编译发现并已修复的错误原文：

```text
[vite:css] [postcss] composition is only allowed when selector is single :local class name not in ":local(.header) h1"
```

修复为标题本身的 `.heading` 类后，独立编译通过。
