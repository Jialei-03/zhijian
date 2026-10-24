已归档：2026-10-24，现行设计见 [会话管理](../session-management.md)。

# 第 2 阶段：项目主会话

本页保留初版第 2 阶段的范围和验收记录。2026-10-23 起，项目中的普通研究对话共享项目读取和派出子研究的能力，旧导师按普通对话保留；见[应用结构实现记录](app-structure-implementation.md)。2026-10-22 的[会话管理改造](../session-management.md)已更新新聊天、复制、归档、运行控制和通报展示；这些行为以新记录和当前代码为准，下文的验收数字对应初版。

范围是项目主会话、派出定题研究、给研究带话和被动通报。分叉、合并和资料库不在本阶段。

## 实现选择

- 继续使用 `research_chat.py` 和 Pi `AgentSession`，不引入新的会话运行器。`ResearchWorkspace.session_id` 指向固定主会话，角色为 `lead`；历史对话仍用 `chat`，可以继续、改名、换模型和压缩。
- 新建一个空主会话，不把某段历史对话自动提升成有写权限的导师。旧对话保留在「历史」；克隆仍是独立的历史对话。`/new` 打开历史页已有的手动研究入口，不重置主会话。
- 只增加 `start_research` 和 `message_research` 两个写工具。派出的研究从定题开始，继承本项目说明、默认环境和主会话所选模型，计划批准仍走人的原有接口。主导师不能执行实验、改地图、改文件或批准事项。
- 通报用 `research_notes` 保存，引用唯一的原研究事件；在写事件的同一事务里记录。它不创建 `AgentRun`，不调用模型，也不依赖模型总结。前端按时间把通报插入主会话；导师开始回答前重新读取概览和最近 60 条通报，完整历史仍保留在数据库和界面。
- 没有实现设计草案里的 `seen_at`：本阶段不提供未读回执，读取通报不改变其状态。也没有提前加入父子研究分叉图、合并记录或资料库。
- 主会话并发发送在数据库里串行准入，避免两个运行同时续写同一 Pi 历史。在研究轮已经开始后收到的带话，只有真正读过它的后续轮才会消费。

## 文件

| 部分 | 文件与作用 |
|---|---|
| 数据与升级 | `backend/models.py`、`backend/migrations/versions/0034_project_lead.py`：主会话指针、研究来源、事件通报；为旧项目建立空主会话、回填既有通报。运行上下文由 String(200) 扩展为 Text，允许 PostgreSQL 保存完整项目概览；降级保留 Text，避免丢失对话内容。 |
| 主会话 | `backend/research_chat.py`、`backend/research_workspaces.py`、`backend/research_routes.py`：创建和继续主会话、派出研究、带话、项目进展和通报接口。 |
| 权限与 Pi | `backend/research_tools.py`、`backend/agent_worker.py`、`backend/agents.py`、`agent-runtime/skills/research-lead/SKILL.md`：角色白名单、所有权和项目范围检查、持续 Pi 历史、执行前刷新上下文；防止通用运行接口绕过项目权限或删除主会话。 |
| 研究回报 | `backend/research_map.py`、`backend/research_notes.py`、`backend/research_worker.py`：计划、决定、结论和异常转成通报，不自动唤醒主会话模型。 |
| 带话 | `backend/research_stages.py`、`backend/research_brief.py`、`backend/research_worker.py`：单独保留 `lead` 操作者身份、向下一轮提供消息、保住忙碌期间新到的指令。 |
| 项目界面 | `frontend/src/screens/research/projects/ProjectPage.tsx`、`ProjectChats.tsx`、`Projects.module.css`：默认主会话、研究卡片、通报时间线；保留看板、历史和项目设置入口。 |
| 类型与呈现 | `frontend/src/screens/research/research-api.ts`、`process/Process.tsx`、`process/model.ts`、`talk/ThreadView.tsx`、`frontend/src/i18n/messages/zh.ts`、`en.ts`：接口类型、导师和工具名称、极简中英文状态文案。 |
| 验证 | `backend/tests/test_research_lead.py`、`frontend/e2e/screens/project-main.spec.ts`、`frontend/src/screens/research/process/model.test.ts`：持续对话、工具权限、旧数据、模型/压缩、四类通报、并发和在途带话、界面入口。 |
| 使用说明 | `docs/DEVELOPMENT.md`、`docs/RESEARCH.md`、本记录 `docs/design/archive/project-lead.md`：同步主会话和通报的行为、代码地图。 |

本次没有改动 `research_repo.py`。开始工作时仓库已存在第 1 阶段的未提交改动以及桌面打包改动，均保留。

## 参考与取舍

- [Claude Projects](https://support.claude.com/en/articles/9517075-what-are-projects)：借鉴一个主会话掌握研究和待决定事项的入口。
- [Codex thread-store](https://github.com/openai/codex/tree/main/codex-rs/thread-store)、[agent-graph-store](https://github.com/openai/codex/tree/main/codex-rs/agent-graph-store)、[message-board](https://github.com/openai/codex/tree/main/codex-rs/message-board)、[app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)：区分会话历史、研究关系和持久通报；本阶段只需要既有项目归属，不引入通用图或留言板框架。
- [MiniMax task](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/agent-tools/src/desktop/local-task.ts)、[task append](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/agent-tools/src/desktop/local-task-append.ts)：借鉴后台派出与追加指令；本阶段不增加停止、等待或额外验证模型。
- 本仓库安装的 Pi `docs/sessions.md`、`docs/compaction.md`：继续使用会话条目与压缩；分支摘要留待分叉/合并阶段。

只借鉴设计，没有引入这些项目的代码。

## 验证记录

按后端 → Node 运行器 → 前端检查/单元测试/构建/浏览器的顺序执行，重测试没有交叠。模型集成测试使用本地假模型，不产生外部模型费用。

- 后端最终完整运行：`1250 passed, 16 skipped, 8 warnings in 92.53s (0:01:32)`。
- Node：`15` 项通过，`0` 失败。
- 前端 `npm run check` 通过；`37` 个 Vitest 文件、`291` 项测试通过；构建通过。
- Playwright 最终完整运行：`308 passed (3.5m)`，`7 skipped`；新增的四项项目用例均通过。跳过项是需要显式开启的性能采样/分析和官网截图重制用例（`PERF`、`PROFILE`、`SITE_SHOTS`）。

后端跳过项是未配置 `TEST_POSTGRES_URL` 的 PostgreSQL 集成测试和没有 `REALMEM_FIXTURE_DIR` 的真实论文素材测试。主会话与迁移已在临时 SQLite 数据库上验证；未运行真实模型或真实 GPU/SSH 实验。本次不改变研究执行器本身。

初次全套发现迁移降级没有兼容由 `Base.metadata.create_all` 建出的唯一约束，已修正为只删除确实存在的命名索引。定向复测 3 项通过，最终完整运行也通过。失败摘要原文：

```text
E       sqlite3.OperationalError: no such index: ix_research_workspaces_session_id
FAILED backend/tests/test_ink.py::test_ink_migration_preserves_existing_file
FAILED backend/tests/test_annotations.py::test_annotation_migration_preserves_file
FAILED backend/tests/test_research_models.py::test_migration_0027_upgrades - ...
3 failed, 1246 passed, 16 skipped, 8 warnings in 88.69s (0:01:28)
```

第二次完整运行曾出现既有共享模型排队测试的子进程启动超时；没有改这项无关测试或共享模型代码。单独复测 `1 passed, 2 warnings in 2.65s`，随后完整运行全部通过。该次失败摘要原文：

```text
E                   AssertionError: assert (True and 81925.379295833 < 81921.777093125)
FAILED backend/tests/test_platform_model.py::test_model_waiters_are_fifo_and_dead_waiter_is_removed
1 failed, 1249 passed, 16 skipped, 8 warnings in 125.19s (0:02:05)
```

## 验收对应

| 要求 | 证据 |
|---|---|
| 固定持续主会话、命令、换模型、压缩 | `test_a_project_has_one_main_session_before_anyone_speaks`、`test_the_main_conversation_reuses_pi_history_and_compacts`、模型/压缩与浏览器命令用例。 |
| 读取项目、旧实验和日志 | `test_the_lead_reads_its_researches_and_logs_but_cannot_cross_projects`、`test_the_lead_can_read_old_rounds_and_failed_jobs_beyond_the_overview`。详情工具能读取概览范围以外的早期轮次和失败作业。 |
| 派出定题研究、保留人的审批 | `test_delegation_starts_at_scoping_with_the_project_defaults`、角色工具白名单与通用运行接口绕过测试。 |
| 给已有研究带话 | `test_passing_a_message_does_not_approve_or_restart_a_research`、`test_a_message_arriving_during_a_round_reaches_the_next_round`，覆盖忙碌的定题轮和导师轮。 |
| 四类被动通报、下次回答能读到 | 通报幂等/零新增运行测试、失败定题轮测试、主会话时间线浏览器用例。 |
| 研究问题、状态、最近进展及跳转 | `project-main.spec.ts` 的桌面与英文窄屏交互。 |
| 旧数据、历史对话、直接研究、看板 | 0033 升级测试、旧项目保留测试及浏览器历史/看板用例。 |
| 所有权、项目边界、审批隔离 | 跨项目和跨用户工具测试；主会话身份与工具白名单；带话不批准也不恢复研究。 |
| 极简中英文文案 | 两份文案目录、`npm run check` 以及中英浏览器用例。 |


浏览器首轮完整检查有一项新测试失败：测试把真实 API 的空计划 `{}` 错模拟成 `null`，并使用了研究页不存在的 `main` 定位。修正数据后，定向复测又发现 URL 更新早于页面渲染的定位竞态；改为等待研究页标题和带话内容后再检查导师名称。没有为此修改产品代码、放宽等待时间或删除功能断言。最终四项主会话用例定向通过：`4 passed (11.1s)`。

失败原文节选（完整日志保留在 `test-results/phase2/`）：

```text
    Error: expect(locator).toContainText(expected) failed

    Locator: getByRole('main')
    Expected substring: "项目导师"
    Timeout: 10000ms
    Error: element(s) not found

  1 failed
    e2e/screens/project-main.spec.ts:253:1 › a project opens its continuing main chat, researches, and passive reports
  7 skipped
  307 passed (3.6m)
```

```text
    Error: strict mode violation: getByText('项目导师', { exact: true }) resolved to 3 elements:
```


最终日志：`test-results/phase2/backend-final.log`、`node-final.log`、`frontend-final.log`。修复前的完整失败日志与定向复测日志也保留在该目录，未以最终通过覆盖原记录。

界面已核对：`test-results/phase2/project-main-zh-light-desktop.png`、`project-main-en-dark-narrow.png`。截图来自测试数据驱动的真实前端。

第 2 阶段没有剩余实现项。分叉、合并、资料库按约定留待后续；真实模型、GPU/SSH 和 PostgreSQL 环境的实测不在本次已验证结果之内。未提交或推送代码，原有第 1 阶段及桌面打包工作区改动保留。
