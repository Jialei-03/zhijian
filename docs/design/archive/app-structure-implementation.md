已归档：2026-10-24，现行设计见 [应用结构](../app-structure.md)。

# 应用结构与研究交互：实现与验收

2026-10-23。对应 `app-structure.md` 本轮范围，不包含定时任务执行器和自定义能力扩展。

## 对应七项要求

1. 图标栏只保留研究、资料、定时任务、自定义和底部设置。定时任务为时钟、短标题与禁用的新建按钮。删除任务状态中心和独立看板；旧看板地址转到项目列表，项目页提供列表/看板切换。资料无首页，清除旧首页的分区记忆；本机版默认新研究，关闭设置返回原对话或新研究。
2. 项目侧栏只显示项目名，独立展开按钮和悬停新建入口；默认五条对话，子研究/分叉按来源缩进，并列出跨项目最近对话。运行转圈、未读/待确认蓝点，通知铃铛聚合待处理对话。0040 保存读回执，并给旧历史建立已读基线。旧导师和聊天复用原研究、会话及 Pi 历史；旧导师默认标题改为首条问题，原地址仍可打开。普通定题/讨论阶段能读项目、派出子研究、带话，权限仍检查所有者、项目、会话和归档状态；不会替人批准实验。
3. 居中标题“想研究什么？”，输入底部左侧为附加文件、项目下拉和机器，右侧模型及发送。支持先写草稿再选择项目/模型。附加文件时先创建暂停对话，上传完成后才恢复定题；上传失败打开仍暂停的对话，避免隐式继续或重复创建。
4. 顶栏为文件夹、短标题、一个菜单和面板开关。菜单包含重命名、分叉、暂停/继续、停止、归档；已完成研究里的新回答可单独停止。每轮折叠过程并保留最后回复；计划、实验、结论及检查点变更卡片沿用真实领域记录。消息提供复制、分叉和时间。输入占位为“接着说”。
5. 右侧为一张浮动卡片，依次显示有内容的变更、子研究、实验、计划、来源。文件对比只读，合并仍走现有预览与确认；文件浏览/上传、实验详情通过对话框打开，没有面板页签。
6. 切换研究先显示对话骨架，侧栏和外壳保留。旧请求有取消检查，不会覆盖后打开的研究。
7. 删除应用、资料、设置和阅读器中的引导段落、副标题、字段说明、空状态描述，并同步删除中英文目录条目。保留用户/研究内容、错误状态和删除确认中实际操作对象的信息。托管版的研究空状态也只保留图标、标题和按钮。

## 实现取舍

- 标题用规则截取最多 16 个字符，不增加模型请求；人工改名保留。
- 机器跟随项目绑定的真实目录，物理项目不提供独立改机器的选择器，避免机器和目录相互矛盾。旧 managed 项目保留默认算力设置。
- 消息分叉选择该位置最近的已封存轮次，不伪造任意消息中间的文件状态。缺少历史快照的旧轮次不能分叉。新讨论轮次保存对话快照并复用已有代码提交，不扫描其他研究可能正在修改的执行目录。
- 撤销仅允许最新、已暂停/完成、没有活动运行的已封存轮次。检查预期提交、未保存修改、共享目录活动和真实文件内容；以反向提交保留历史。旧轮次仍可看对比，撤销按钮禁用。
- 文件附件复用已有上传能力（包括 PDF），没有新增资料市场或未实现的附件入口。来源为空时可由输入区“+”添加。

## 测试结果

按后端 → Node → 前端检查、Vitest、构建、Playwright 顺序执行，没有并行运行重测试。

- 最后完整后端：1426 passed、16 skipped，5 项环境探测失败。另一次检查点/迁移定向测试 18 passed。
- Node：19 passed，0 failed。
- `npm run check`：通过，1422 个目录键，格式和 TypeScript 通过。
- Vitest：42 个文件，320 项通过。
- 构建：通过；保留已有 chunk 大于 500 kB 的提示。
- Playwright：330 failed、4 skipped、1 passed。330 项均在 Chromium 启动时失败，尚未进入页面断言；不能视为浏览器自动验收通过。
- 通过现有 Chrome 手动检查中文新研究页、定时任务空状态、旧研究对话、顶栏菜单、通知、父子缩进和右侧内容顺序；390×844 新研究页无横向溢出。未发送研究消息，未批准计划，未启动实验/模型/SSH。

Chromium 原始错误节选：

```text
    Error: browserType.launch: Target page, context or browser has been closed
    [pid=27670][err] [1023/033929.473612:FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.27670: Permission denied (1100)
  330 failed
  4 skipped
  1 passed (27.9s)
```

后端最后完整失败摘要原文：

```text
=========================== short test summary info ============================
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[15]
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[1]
FAILED backend/tests/test_local_lifecycle.py::test_workers_leave_when_the_cli_is_killed
FAILED backend/tests/test_local_lifecycle.py::test_a_killed_worker_is_restarted_and_health_says_so
FAILED backend/tests/test_research_host.py::test_the_probe_names_this_machines_chip
5 failed, 1426 passed, 16 skipped, 8 warnings in 112.27s (0:01:52)
```

`ps` 的四项生命周期测试错误为 `PermissionError: [Errno 1] Operation not permitted: 'ps'`；芯片测试的本机探测返回空值。未修改这些与本次交互无关的测试来绕过环境限制。

## 修正过的测试失败原文

首轮后端测试包含新 fixture 未导入、旧标题断言尚未更新，之后修正。完整原文见同目录 `backend.log`。

```text
=========================== short test summary info ============================
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[15]
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[1]
FAILED backend/tests/test_local_lifecycle.py::test_workers_leave_when_the_cli_is_killed
FAILED backend/tests/test_local_lifecycle.py::test_a_killed_worker_is_restarted_and_health_says_so
FAILED backend/tests/test_research_map.py::test_create_project_makes_root_and_session
FAILED backend/tests/test_research_host.py::test_the_probe_names_this_machines_chip
ERROR backend/tests/test_app_conversations.py::test_short_titles_read_receipts_and_old_sessions_stay_addressable
ERROR backend/tests/test_app_conversations.py::test_project_conversations_can_delegate_with_ownership_and_plan_boundary
ERROR backend/tests/test_app_conversations.py::test_checkpoint_diff_undo_keeps_history_and_refuses_stale_edits
ERROR backend/tests/test_app_conversations.py::test_deferred_first_message_is_paused_until_attachments_are_uploaded
6 failed, 1418 passed, 16 skipped, 8 warnings, 4 errors in 112.07s (0:01:52)
```

定向测试曾把会话读取地址写错，并在更新断言时使用了错误变量名；随后修正，相关 64 项通过。

```text
=========================== short test summary info ============================
FAILED backend/tests/test_app_conversations.py::test_short_titles_read_receipts_and_old_sessions_stay_addressable
FAILED backend/tests/test_research_map.py::test_create_project_makes_root_and_session
2 failed, 62 passed, 8 warnings in 4.46s
```

首轮 Vitest 暴露了线程排序把既有事件顺序改掉的问题；已改为保持事件顺序，在轮次的首个实际事件前建立工作块，最终 320 项通过。首轮失败摘要原文：

```text
 FAIL  src/screens/research/talk/thread.test.ts > buildThread > shows scoping as a round and only the newest plan is on the table
 FAIL  src/screens/research/talk/thread.test.ts > buildThread > folds a sprint's steps and jobs into one block, and marks answered decisions
 Test Files  1 failed | 41 passed (42)
      Tests  2 failed | 318 passed (320)
```

## 浏览器与环境限制

8777 旧预览进程无法终止：`kill 24447 failed: operation not permitted`。没有触碰真实数据目录，改用 `/tmp/ora-app-structure-preview-20261023` 中的预览数据库副本，在 8778 仅启动 Web 服务（没有工作进程）。8777 尚需在允许结束旧进程的环境中重启。

日志与截图保存在仓库的 `test-results/app-structure-20261023/`（该目录按仓库约定不提交）。截图包括 `new-research-final.jpg`、`new-research-narrow.jpg`、`conversation-final.jpg`、`sidebar-final.jpg`。

## 尚未验证

需要在允许启动 Chromium 的环境重新跑 Playwright，确认全部自动交互断言；本次没有真实模型、实验或 SSH 实测。定时任务执行和自定义扩展按本轮范围留到后续。

## 本地提交方式

原仓库的 `.git` 为只读，`git add` 返回：

```text
fatal: Unable to create '/Users/leslie/Desktop/ORA/.git/index.lock': Operation not permitted
```

本轮改动在临时本地克隆中提交，生成 `test-results/app-structure-20261023/ora-app-structure.bundle`。bundle 基于原提交 `5c565d7`，可在允许写入原仓库的终端导入。原工作目录保留全部改动，原有 `.claude/`、`design-qa.md` 和未跟踪的 `docs/design/app-structure.md` 未纳入提交。没有推送。
