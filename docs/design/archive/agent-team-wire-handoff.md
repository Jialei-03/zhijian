已归档：2026-10-24，现行设计见 [工作流](../workflows.md)。

# 研究团队接线（codex/team-wire）

## 存储与 API

- `ResearchWorkspace.workflow` 保存当前 contract Workflow，`workflow_state` 保存引擎状态、最近触发、定时认领时间和已执行的工作流版本。按工作流 id 保存团队编辑的定义，切走再切回保留规则与布局。团队读取仍走 Step 1 的 overview，新增 `workflow`、`runtime`。
- `GET/PUT/POST /research/workspaces/{id}/team/workflow` 分别读取、带版本保存、切换；`GET /team/workflows/{workflow_id}/{version}` 用于从消息定位执行时的规则。保存版本冲突返回 409，成员/频道引用错误返回 422。
- `/research/workflows` 现在提供 `team_rules.builtin_workflows()` 与已转换的用户规则。内置模板在自定义分区编辑时另存副本；团队当前模板可直接编辑。旧 `steps` 请求仅作为兼容导入，转换后保存规则。
- 新研究默认使用团队当前工作流；研究、重跑和评测保存独立快照。团队切换不会改写已有研究的快照；已有研究要换规则，通过“换个工作流再做一遍”创建并行研究。

## 事件与执行

- `team_workflows.py` 是模型适配层。Step 1 的 `ensure()` 持有团队行锁；在同一事务中 `match()`、保存新状态、登记最近触发、写投递队列。直接消息、私信的隐式收件人、显式 @ 都进入同一引擎。
- `TeamDelivery.action` 保存完整 Action、指示、工作流 id/version。普通成员仍由既有 Pi 运行器执行；忙时排队与立即 steer 沿用 Step 1。
- 原来 `post()`、`settle()`、研究提及适配中的接力判断/计数已移除。共享接力上限、@ 优先级、等待和每条规则次数全部由引擎决定，初次负责人 @ 也计入最多 6 次叫醒。
- `research_worker` 把已有评审时机（轮次、止损证据、预算标记、停滞）分类为 result/text/review 等事件，实际下一成员取规则 Action。实验等待、预算检查、失败退避、产出和 Git 检查点继续由原执行器处理。
- 计划提出/批准、结论提出/接受、`finish_step`、`review_step` 进入规则；原生定题继续由导师讨论。旧的步骤状态只保留产出、确认、轮数和检查点执行元数据。转换后的线性 cursor 与评审退回次数由规则引擎控制，迁移中的在途评审也恢复其退回次数。
- `team_send_message` 支持 contract 消息 kind。新增 `team_review_result`，只允许被 review Action 叫醒的运行提交评审，一次运行仅接受一个结果，失败交给 `review_failed`。
- 每个已结束作业仍发一条系统消息。`waiting_on` 作业组在全部完成时发一个继续事件，保留原等待屏障；不属于当前等待组的作业在通知时发事件，避免漏掉较早轮次的长作业。
- post Action 发出的消息通过持久标记再次进入消息事件；每次只消费一批，避免 post → post 递归，跨频道不沿用不属于目标频道的线程。
- 原生结论后的等待与后续成员同样取 Action；覆盖为写手交接时不再被旧等待状态截住，也不把其他成员误作为提炼者运行。默认结论确认与复盘通过现有研究测试。
- 消息及研究轮次携带规则来源。历史版本只读，当前规则可编辑；画布成员状态和最近触发取团队运行数据，节点打开成员私信/频道。

## 比较与定时

- 比较接口用 Step 1 的实际成员 id/name，合并研究消息、轮次、团队消息和模型用量；适配引用、转发消息、重复 run 引用不重复计数，继承历史不重复收费。线程总 token 取账本、研究轮次和成员汇总的较大值。
- 重跑/评测选择器按团队读取工作流，后端分叉与批量创建同样读取团队当前覆盖版本。
- `research_schedules.tick()` 委托给唯一的 `team_timers` 调度入口。它调用 `due()` 规划、`match()` 决策，并在团队锁内认领/保存，失败也推进认领时间。
- 旧 `ResearchSchedule` 仅保留新研究/现有研究的投递配置、执行历史以及任意小时周期的精确相位；每天/每周使用 cron，无法由五段 cron 精确表示的小时周期通过同一个入口的相位门控处理，不再有独立的旧调度循环。
- 创建、暂停、编辑旧任务会同步同一条 `schedule:<id>` 规则；画布启停/删除规则反向同步旧任务。改为非定时触发会移除对应定时配置。纯 cron 规则也出现在定时任务分区，并链接同一规则编辑器。

## 迁移

`0045_team_workflows` 接在 `0044` 后面：新增团队的两个 JSON 字段和投递的 action JSON；用户线性定义与已有研究快照用 `convert_linear_workflow` 转成规则，同时保留原执行元数据。空的老研究/团队以及老定时配置在首次使用时幂等接入。

没有改共享组件尺寸，也没有改 Team.module.css、输入框、顶栏、团队名和状态点样式。没有启动浏览器、调用真实模型、访问用户运行目录、连接 SSH 或写入 Git 元数据。

## 浏览器验收

1. 团队侧栏进入“团队设置”，查看只读成员、工作流和比较三个页签；在 720px、深浅色下检查滚动和焦点。
2. 工作流列表启停/编辑/排序规则，切到画布拖动节点、连线新建，刷新后确认保存；点成员/频道节点打开私信/消息。
3. 发送命中规则的消息及 @，验证指示、排队/立即发送、等待与 6 次上限；点消息或研究轮次上的规则小字，验证当前定位和历史版本只读。
4. 用假模型跑旧研究：讨论计划 → 批准 → 实验/等待作业 → 导师评审/退回 → 提出结论等你 → 接受 → 复盘；停用对应规则确认不再自动叫醒。
5. 切团队工作流，新建研究验证默认值；同一问题“换个工作流再做一遍”，比较结论、数字、token、用时和实际成员；评测团队验证问题 × 工作流矩阵。
6. 定时任务新建任务，去团队画布检查同一条规则；两边暂停/修改/删除；新增纯 cron 规则后到定时任务分区打开它，检查不会重复投递。
7. 自定义 → 工作流，打开已有规则或内置模板副本，用相同列表/画布编辑并保存，再回团队选择它。

新增浏览器用例：`frontend/e2e/screens/team-wire.spec.ts`；另保留画布独立入口 `frontend/e2e-ui/workflow.spec.ts` 及比较用例。沙箱内未执行 Playwright 用例。

为避开 team-fix，既有浏览器测试文件没有改动；`frontend/e2e/screens/workflows.spec.ts` 第一条仍断言已移除的线性步骤编辑器，应在合并浏览器测试修复时替换为新增的规则编辑流程。第二条的产出、进度、确认语义保留。

## 本工作区验证结果

按要求执行的完整链路：

| 检查 | 结果 |
| --- | --- |
| `.venv/bin/python -m pytest -q` | 1612 passed，5 failed，16 skipped，8 warnings |
| `cd agent-runtime && node --test` | 20 passed |
| `cd frontend && npm run check` | catalog 1728 keys、TypeScript、Prettier 通过 |
| `npx vitest run` | `.vite-temp` EPERM；改用 `--configLoader runner --cache=false` 后 50 个文件、374 passed |
| `npm run build` | TypeScript 通过，Vite `.vite-temp` EPERM；`npx vite build --configLoader runner && node scripts/copy-docs.mjs` 通过，保留大 chunk 警告 |
| `npx playwright test --list e2e/screens/team-wire.spec.ts` | 收集 3 个用例；未启动浏览器、未执行用例 |

最终完整 pytest 仅剩已注明的五个沙箱失败：四项 `ps` 权限限制、一项芯片探测空结果。结论交接分支及既有研究回归另有 107 passed，之后按原顺序重新完成了整条检查链。时间戳使用实际触发时刻，避免长运行消息的占位创建时间使画布无法闪烁。

最终 pytest 失败列表原文：

```text
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[15]
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[1]
FAILED backend/tests/test_local_lifecycle.py::test_workers_leave_when_the_cli_is_killed
FAILED backend/tests/test_local_lifecycle.py::test_a_killed_worker_is_restarted_and_health_says_so
FAILED backend/tests/test_research_host.py::test_the_probe_names_this_machines_chip
5 failed, 1612 passed, 16 skipped, 8 warnings in 130.11s (0:02:10)
```

错误原文：

```text
E                   PermissionError: [Errno 1] Operation not permitted: 'ps'
E           AssertionError: assert ''
```

保留完整、未裁剪日志：

- [最终 pytest](../agent-team-wire-validation/pytest.log)
- [版面翻译单独复测](../agent-team-wire-validation/layout-recheck.log)
- [运行状态接线回归](../agent-team-wire-validation/runtime-followup.log) / [结论与研究回归](../agent-team-wire-validation/conclusion-regression.log)
- [逐项命令及退出码](../agent-team-wire-validation/check-results.json)
- [agent-runtime](../agent-team-wire-validation/node.log)
- [前端 check](../agent-team-wire-validation/check.log)
- [Vitest 标准命令失败](../agent-team-wire-validation/vitest-standard.log) / [runner 成功](../agent-team-wire-validation/vitest.log)
- [build 标准命令失败](../agent-team-wire-validation/build-standard.log) / [runner 成功](../agent-team-wire-validation/build.log)
- [Playwright 收集结果](../agent-team-wire-validation/playwright-list.log)

中间一次版面翻译测试及其单独复测出现沙箱拒绝 `os.killpg` 的 `PermissionError`，最终全量中该用例通过，没有修改版面翻译实现；[单独复测原文](../agent-team-wire-validation/layout-recheck.log) 保留。

中间一次全量还出现未修改的 `test_translation_calls_share_agent_slots` 时序断言 `E       assert 1 == 2`；该用例在串行复核（共 23 项）及后续完整运行中均通过。原文在 [该次全量](../agent-team-wire-validation/pytest-timing-run.log) 与 [串行复核](../agent-team-wire-validation/pytest-timing-recheck.log)。首次前端检查发现并已修复重复 `getTeam` import，[失败原文](../agent-team-wire-validation/check-first.log) 一并保留。

负责人可运行：

```sh
cd frontend
npx playwright test e2e/screens/team-wire.spec.ts e2e/screens/team-compare.spec.ts
npx playwright test -c playwright.ui.config.ts e2e-ui/workflow.spec.ts
```
