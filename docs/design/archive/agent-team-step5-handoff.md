已归档：2026-10-24，现行设计见 [工作流](../workflows.md)。

# 第 5 步：比较协作方式

工作区：`codex/team-compare`。没有新增成员、频道或消息模型。

## 对外接口

- `backend.team_compare.comparison(d, projects, *, members_by_thread=None, at=None) -> Comparison`。`projects` 是已经通过权限检查的 `ResearchProject` 列表；`at` 是可选的 ISO 时间。`members_by_thread` 为 `{research_id: [{id, name, messages, tokens}]}`，接第 1 步的消息统计，测试有假成员数据。
- `GET /api/v1/research/compare?ids=<research_id>&ids=<research_id>`。1–12 个 id，去重并保留顺序；全部通过现有 `project_of` 检查后才返回结果。仅本机、人类登录、同一用户可读。
- `POST /api/v1/research/projects/{id}/forks` 沿用原请求，新增 `workflow_id?: string`，默认 `research`。保存工作流快照以及 `forked_from.workflow_id` / `forked_from.workflow`；重试编号也检查工作流，创建后暂停。
- `backend.team_compare.create_batch(d, owner, workspace, body, create_research) -> ResearchEvaluationBatch`。`body` 是 `BatchInput`；`create_research(ProjectInput) -> ResearchProject` 是不提交事务、不启动模型、不操作 Git 的现有创建器回调。调用方持有工作区锁并提交事务。
- `POST /api/v1/research/workspaces/{id}/evaluations`：`{name, questions: string[], workflow_ids: string[], model_config_id, defer_start?: boolean}`。限 `kind="eval"` 的未归档项目；默认让创建的研究进入现有调度器，`defer_start=true` 则暂停。最多 50 个问题、10 套工作流、100 项研究，拒绝空白或重复项。整批一起提交或回滚。
- `GET /api/v1/research/workspaces/{id}/evaluations` 返回分组列表；`GET /api/v1/research/evaluations/{id}` 返回分组元数据及 contract 的 `threads`。`cells` 为 `[{question: 问题下标, workflow_id, research_id}]`，可恢复矩阵而不依赖列表顺序。
- `CompareView({comparison: Comparison, onOpenResearch?: (id: string) => void})`：独立 props 组件，点击列头打开研究，没有回调时仍有真实 hash 链接。
- `BatchResultsTable({results: EvaluationResults, onOpenResearch?: (id: string) => void})`：问题 × 工作流的结果表。
- `ComparePanel({workspaceId, researches: {id, title?, question}[], evaluation?, onOpenResearch})`：接口加载、研究选择、评测创建和轮询。已接 `#workspaces/<id>/compare` 页签及研究菜单入口。
- `ForkDialog` 增加 `rerun?: boolean`，用于「换个工作流再做一遍」。

## 统计口径与设计差异

- 比较的 id 当前仍为 `ResearchProject.id`，不是尚未合并的线程根消息 id。
- 未提供成员统计时，按实际研究角色汇总。已有 `message` 事件按条数计数；未持久化消息的角色用轮次数代替消息数，token 来自本研究的轮次。继承历史不重复计轮次或费用。
- 关键数字采用确定性选择，最多 5 项：优先结论/计划提及的名称、地图证据引用的成功作业指标，以及地图节点证据摘要中的具名数字。布尔值、非有限数和失败作业指标不作为结果；不假定数值越高越好。
- token 和作业费用取账本与本研究轮次/作业记录的较大值，避免账本滞后以及重复相加；正在运行的作业计到查询时间，排队时间不算作业时间。用时为创建到查询时间的墙钟时间；暂停/完成研究截止到 `updated_at`，包含此前等待时间，不是 CPU 活跃时间。
- 比较最多选择 12 项，每页显示 3 列，保持窄窗口可读。缺失指标显示 `—`，不作为零；数值差异采用中性高亮。
- 重跑仍要求已有可靠轮次检查点，并继承该检查点的研究地图；不是从空白启动。继续沿用已有分叉的暂停和计划批准约束。
- 当前复用仓库已有的线性工作流注册表/快照机制；第 3 步规则引擎尚未合并，没有另写规则模型。
- 批量增加独立的 `research_evaluation_batches` 分组表，保存问题、工作流名称/id、研究引用；没有新增团队基础数据表。

## 合并时要接的线

1. 将团队线程映射到研究 id，并把第 1 步成员消息/token 汇总传给 `members_by_thread`。前端直接接受同一 Comparison contract。
2. 将 `research_workflows.definition` / `snapshot` 的工作流解析和运行绑定接到第 3 步规则引擎，保留分叉来源与分组中的工作流 id/名称。
3. 协调 Alembic 迁移头：本分支是 `0043_team_comparison`，父版本 `0042`。其他 worktree 同时新增迁移时，负责人调整父版本或增加 merge revision。
4. 执行 `frontend/e2e/screens/team-compare.spec.ts`：两种主题、720px、键盘打开列头、批量创建及工作流重跑。此工作区按要求没有启动浏览器或运行 Playwright。

## 验证

- 相关 pytest：`71 passed, 2 warnings`；最后调整结论断句后重新执行新增模块：`9 passed, 2 warnings`。
- `npm run check`：通过，catalog 1610 keys。
- `npx vitest run`：47 个文件、353 项测试通过。
- `npm run build`：通过；Vite 保留现有 chunk 大小警告。
- 没有调用真实模型、访问用户运行数据、连接 SSH、安装依赖或提交 git。新后端测试用临时数据库，并模拟分叉 Git 操作；已有分叉回归测试使用其临时仓库。
- `frontend/node_modules` 原来是指向主工作区的单个链接。为满足沙箱写入范围，改成本工作区目录中的现有依赖链接，让 `.vite` / `.vite-temp` 写在本工作区；没有更改共享依赖。

### 首次 Vitest 启动失败原文（已解决）

```text
failed to load config from /Users/leslie/Desktop/ORA-worktrees/team-compare/frontend/vite.config.ts

⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/team-compare/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792741661980-ee399dc6de31f.mjs'
    at async open (node:internal/fs/promises:639:25)
    at async Object.writeFile (node:internal/fs/promises:1219:14)
    at async loadConfigFromBundledFile (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:49588:5)
    at async bundleAndLoadConfigFile (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:49433:22)
    at async loadConfigFromFile (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:49396:44)
    at async resolveConfig (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:48891:24)
    at async _createServer (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:38478:66)
    at async createViteServer (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vitest/dist/chunks/cli-api.BkDphVBG.js:6911:17)
    at async createVitest (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vitest/dist/chunks/cli-api.BkDphVBG.js:10202:17)
    at async prepareVitest (file:///Users/leslie/Desktop/ORA/frontend/node_modules/vitest/dist/chunks/cli-api.BkDphVBG.js:10541:14) {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/Users/leslie/Desktop/ORA-worktrees/team-compare/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792741661980-ee399dc6de31f.mjs'
}
```

### 额外的 E2E 独立类型检查失败原文

这不是 `npm run check` 的检查范围。现有共用 fixtures 缺少 Node 类型声明，未安装新依赖。

执行：`npx tsc --noEmit --skipLibCheck --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --jsx react-jsx --strict e2e/screens/team-compare.spec.ts`

```text
e2e/fixtures/pdf.ts(24,18): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/fixtures/pdf.ts(27,16): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/fixtures/pdf.ts(35,10): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(11,24): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(22,11): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(124,4): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(243,18): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(246,16): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(253,10): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(257,72): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
e2e/reader/fixtures.ts(287,14): error TS2580: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
```
