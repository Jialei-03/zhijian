已归档：2026-10-24，现行设计见 [研究团队](../agent-team.md)。

# 成员文件化后的团队走查修复

工作区：`codex/team-port`。修复按 `agent-files.md` 的「叫醒和护栏」移植；原始 `team-polish.patch`、`team-polish-result.md`、`team-findings.md` 已删除。未提交、未修改工作区 Git 元数据，未启动浏览器、调用真实模型、访问个人数据目录或连接 SSH。

## 14 项落点

| 项 | 当前实现 | 回归验证 |
| --- | --- | --- |
| 1 | `backend/research_team.py:mentions/dispatch` 按出现顺序识别全部 @，`team_rules.match` 全部派发；保留用户原话，顺序由用户和工作流决定。 | `test_team_polish.py:test_all_mentions_and_language_at_front`、`test_agent_mentions_all_and_configurable_same_scope_limit` |
| 2 | `research_team.language_part/context` 复用 `researcher_language`，读取团队最近的研究者发言；`team_members.apply_runtime` 将语言要求放在最新文件正文及共享说明之前。排队期间外部编辑的定义也会在启动时重读。 | `test_all_mentions_and_language_at_front`、`test_queued_run_reads_external_file_budget_at_start` |
| 3 | `frontend/src/screens/research/TeamScreen.tsx:MessageRow` 给 `RunTurn` 传 `hideAuthor`，保留消息头的一处姓名。 | `research-team.spec.ts`：one author… |
| 4 | `backend/academic_search.py` 三源关键词检索；`research_team_tools.py` 的 `team_search_papers/team_import_paper` 负责结果存储、归属检查、去重导入和元数据。`team_members.allowed` 在工具提供与执行两处读取文件的 literature 权限。部分/全部网络失败明确返回；arXiv 引用数为 null。 | 假响应检索、错误、导入幂等/隔离、外部修改工具权限测试 |
| 5 | `TeamScreen.tsx:MessagePane` 私信空状态使用现有 `MemberAvatar` 和成员名称。 | `research-team.spec.ts`：DM empty state… |
| 6 | `0048_team_polish.py` 为已有团队记录升级通知边界；`research_team.notify_jobs` 只通知晚于边界结束的作业。新团队以创建时间为边界。 | `test_migration_boundary_and_file_definitions_unchanged`、`test_old_jobs_stay_silent_and_running_jobs_notify_when_finished` |
| 7 | `backend/team_workspace.py:workdir/seal` 使用项目主工作树，与成员文件编辑器和 `AGENTS.md` 共用真实文件；模型 cwd 与文件工具一致。完成、失败、限时后 checkpoint，消息附文件与提交号；`TeamFilePreview.tsx` 和 `/team/file` 提供有归属及路径边界的右侧预览。研究线程保持现有独立工作树。 | `test_failed_empty_and_time_limited_output`、文件越界与用户隔离断言、文件预览浏览器用例 |
| 8 | `backend/team_workflows.py:unstarted/apply` 合并同频道、同线程、同成员尚未开始的投递，包括已创建而未认领的 run；保留所有要求、规则指令、附件，立即发送可升级投递。 | 三种重复叫醒测试、`test_merged_wake_retains_attachments_and_rule_instructions`、立即发送测试 |
| 9 | `research_team_tools._call` 的普通回复和评审填充原 run 占位，`research_team.settle` 只结算/路由一次；`message_out` 给已结束的空回答明确失败状态。 | `test_placeholder_filled_and_routed_once`、`test_finished_empty_placeholder_has_failure_instead_of_spinner` |
| 10 | `dispatch` 将回复绑定原请求线程；跨频道发帖在原占位附结果链接，并携带原 `routing_scope`，接力计数不会随换频道重置。 | `test_cross_channel_post_links_back_and_uses_origin_relay`、thread results… 浏览器用例 |
| 11 | `team_workflows.apply/research_event` 存状态与原因；`TeamScreen` 使用中英文目录渲染等待、预算、接力、评审上限，只显示当前界面语言。 | system wait messages use only zh/en 浏览器用例；前端文案目录检查 |
| 12 | `team_members.apply_runtime` 和 `team_budgets.snapshot` 从成员文件读取 `budget.turns/tokens/minutes`；`agent_worker` 在子进程和主管进程使用对应时长，在请求/用量边界执行预算。正文保留且错误只显示一次；输入框仅列研究者自己的未投递消息；`/messages/{id}/continue` 幂等继续。 | 文件预算/超过默认 32 轮/外部修改测试；实际计时停止、保留文字/文件、通知和继续；one author… 浏览器用例 |
| 13 | `team_budgets.py` 提供周期 token、并发和接力设置；`team_rules.match` 默认 12 次 agent 接力、0 可关闭，人的 @ 不消耗接力。不限制多人 @，不根据导师措辞暂停。仅规则 `wait_for_owner` 或 `team_wait_for_owner` 主动问题进入等待。到上限在线程通知负责人；暂时不足保留投递队列，恢复后继续。原生研究尚未启动的 run 也计入并发及预算。 | 接力可调/关闭、跨频道计数、主动等待/导师不停、并发排队/恢复/通知、周期恢复、原生研究预算测试 |
| 14 | `TeamSettings.module.css` 使主区伸展；列表沿用 960px 上限，`workflow/Workflow.module.css` 使画布全宽且至少 600px 高。隐藏重复工作流标题，`WorkflowCanvas.tsx` 的频道分组过滤 DM。尺寸由间距 token 计算，未修改共享组件尺寸。 | `team-wire.spec.ts`：team canvas…，覆盖宽屏和 720px；只收集，交由负责人运行浏览器 |

## 迁移与文件边界

- 新链为 `0046_custom_team_members → 0047_agent_files → 0048_team_polish`，没有复制旧的冲突迁移。
- 0048 只在已有 `research_workspaces.workflow_state` 中初始化 `job_notifications_after` 及默认团队 `budget`，保留已有设置。无需新增表或成员定义列；降级保留团队预算及磁盘文件。
- 成员预算仍通过现有成员表单/源文件编辑器写入 `.ora/agents/*.md`；不提供旧补丁的 SQL 成员预算接口。`AgentRun.runtime` 的 seconds/turns/token 字段只是这次运行的有效预算回执。
- 成员默认沿用文件格式：32 轮、200,000 token、20 分钟；保留既有 `budget.total_tokens` 累计上限兼容扩展。成员预算的取值范围继续由文件格式校验。团队默认最近 24 小时 12,000,000 token、并发不限、接力上限 12；团队上限为 0 表示关闭。
- token 按现有 `ModelUsage` 回执结算，缺失用量时保守计入预留数；一次已返回的响应可能越过额度，之后停止。普通团队运行由可见预算控制，不再额外受隐藏的 64 次工具调用总数限制。
- 与旧补丁的独立 team 分支选择不同，此次共用项目主工作树，避免成员定义及共享说明在分支上形成过期副本。研究分支隔离机制保持原样。

## 自动验证

按完整 pytest → runtime → frontend check → Vitest → build 的顺序完成。完整命令与退出码见 [results.json](../team-port-validation/results.json)。

| 检查 | 结果 | 原始输出 |
| --- | --- | --- |
| 完整 pytest | 1674 passed、18 skipped；仅 5 项约定忽略的沙箱失败 | [pytest](../team-port-validation/pytest.txt) |
| runtime | 22 passed | [node](../team-port-validation/node.txt) |
| frontend check | 1803 个中英文键、TypeScript、Prettier 通过 | [check](../team-port-validation/check.txt) |
| Vitest | runner 模式 52 个文件、389 passed | [Vitest](../team-port-validation/vitest.txt) |
| build | runner 构建与 copy-docs 通过，保留已有大 chunk 提示 | [build](../team-port-validation/build.txt) |
| 迁移往返 | 空库至 0047/0048、降级、重升；文件、设置、外键均通过 | [migration](../team-port-validation/migration.txt) |
| Playwright | 3 个文件、20 项收集成功；未启动浏览器 | [list](../team-port-validation/playwright-list.txt) |
| 静态检查 | diff 空白与 Python 静态错误检查通过 | [static](../team-port-validation/static.txt) |

完整 pytest 的失败摘要原文（完整 traceback 在上表链接）：

```text
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[15]
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[1]
FAILED backend/tests/test_local_lifecycle.py::test_workers_leave_when_the_cli_is_killed
FAILED backend/tests/test_local_lifecycle.py::test_a_killed_worker_is_restarted_and_health_says_so
FAILED backend/tests/test_research_host.py::test_the_probe_names_this_machines_chip
5 failed, 1674 passed, 18 skipped, 12 warnings in 173.40s (0:02:53)
```

错误原文：

```text
E                   PermissionError: [Errno 1] Operation not permitted: 'ps'
E           AssertionError: assert ''
```

Vitest 和 build 标准启动分别遇到 `.vite-temp` 权限错误，按要求加 runner 后均通过。失败原文如下，完整输出见 [Vitest 默认启动](../team-port-validation/vitest-default.txt)、[build 默认启动](../team-port-validation/build-default.txt)：

```text
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/team-port/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792759455473-306763249732e.mjs'
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/team-port/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792759483693-a2d4e44def438.mjs'
```

本机共享虚拟环境缺少已有项目依赖 `ruamel.yaml`。验证期间只在 `/tmp/team-port-venv` 安装 `ruamel.yaml==0.18.6` 并叠加共享依赖，以此运行上述原始命令；验证结束恢复原 `.venv` 链接，没有修改共享环境。负责人复查时需在自己的可写虚拟环境安装项目声明的依赖。


## 负责人复查流程

1. 在可写开发环境安装项目依赖，用假模型/拦截 API 执行以下 Playwright 用例；本次沙箱只收集测试，不启动浏览器。

   ```sh
   cd frontend
   npx playwright test e2e/screens/research-team.spec.ts e2e/screens/team-wire.spec.ts e2e/screens/team-members.spec.ts
   ```

2. 在中文的 #综述 同时 @ 文献员、写手等多人，确认全部被叫醒、原话及分工保留；检查过程说明与回复语言。改用英文发言再验证一次。文献员分别检索三个来源并导入，确认来源字段、元数据、失败原因和重复导入行为。
3. 给忙碌成员排队、编辑、撤回及立即发送；在同一线程重复 @ 尚未开工的成员，确认只执行一次且要求、附件都在。检查姓名只出现一次，原占位被填充，空回答结束后显示失败。
4. 写手产出草稿后打开文件卡片，核对右侧内容、项目仓库内的真实文件与 checkpoint。让它另往 #写作 发帖，确认原 #综述 线程能通过链接打开结果。
5. 在成员编辑器和外部编辑器中分别修改 `budget`，排队期间再改轮数/分钟，确认启动时使用新定义；写错 YAML 时继续使用上一份有效定义。调低轮数、token、时长，确认内容和文件保留、上限只出现一次、通知负责人、输入框无 agent 失败项，“继续”只创建一项新任务。
6. 团队设置将并发设为 1，检查其他成员排队及名额释放后的继续；接力设为 2，再设为不限；调低团队 token/调整周期，检查上限通知与恢复。跨频道交接仍使用原计数；导师正常判断继续执行，主动问题或显式等待规则才暂停。
7. 以临时旧数据库升级：升级前已结束作业没有补发；升级时运行中的作业结束后恰有一次通知。验证升级、降级、重升不修改成员定义和已有团队设置。
8. 中文/英文、浅色/深色、宽窗口/720px、键盘操作复核私信空状态、系统状态、列表和画布；画布无重复标题、频道分组无私信，且主区宽度和高度符合要求。
