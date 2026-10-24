已归档：2026-10-24，现行设计见 [成员文件](../agent-files.md)。

# 成员就是文件：实现与验收

工作区：`codex/agent-files`。成员定义从文件读取，旧 SQL 定义字段作为迁移档案保留，不再接收定义编辑。状态、消息、花费、成员 ID、角色路由身份、库引用和文件路径仍在数据库中。

## 文件和读取

- 团队：`research_repo.repo_dir(settings, workspace.id)/.ora/agents/<名字>.md`；个人库：数据目录 `agents/`；云端按 owner 哈希分目录，避免不同用户共用文件。
- 内置六个成员位于 `backend/agents/*.md`，作为 Python 包数据发布。正文来自 `agent-runtime/skills/research-*`：导师沿用 `research-lead`，其余对应同名 skill。初始化团队时复制，之后可编辑、复制、停用或恢复内置文件。
- 项目仓库的写入使用现有 Git 二进制、锁和隔离配置，只提交本次成员文件；提交信息包含修改者的用户名、账号 ID 和成员名字。改名字会同时重命名文件。个人库文件不进入团队 Git 历史。
- 读界面、准备成员简报、权限检查、订阅匹配和预算读取，都经过同一个文件定义边界。每次读文件内容，缓存仅复用相同内容的解析结果；用户直接修改工作区或外部提交都会生效。外部新增的有效成员文件会注册运行身份和私信频道。
- YAML 使用 `ruamel.yaml` 往返解析；未知字段、未知工具名、嵌套值及 YAML 注释保留。重写表单对应的已知字段时可能规范化其排版。
- 语法及类型错误包含行号；无效文件继续使用数据目录 `agent-state/<成员 ID>.valid.md` 的上一份有效文件，重启后仍可恢复。成员详情和源文件编辑器显示原始错误文件与错误信息。缺失文件也会沿用有效快照。
- 库同步以 `agent-state/<成员 ID>.base.md` 为上次库基线，保留团队改过的字段及未知字段，包括外部编辑造成的覆盖。频道订阅归各团队所有。同步仍要求明确选择“只保存到库”或“同步”，源文件摘要也用于检测外部修改冲突。

## 最终字段

文件由 `---` 包围的 YAML 头和 Markdown 正文组成。

| 字段 | 类型 / 默认 | 用途 |
| --- | --- | --- |
| `name` | 必填字符串，1–100 字符 | 名字和保存文件名；拒绝路径分隔符等非法文件名字符 |
| `description` | 字符串，默认空 | 列表简介 |
| `model` | 字符串，默认空 | 已配置模型 ID、配置名或模型名；空值沿用团队模型 |
| `tools` | 字符串数组；省略取角色默认 | `literature`、`files`、`shell`、`experiments`、`web`、`project`；未知名称保留且不授予能力 |
| `machines` | 字符串数组；默认 `[host, local, docker]` | 可以使用的机器 ID |
| `channels` | 字符串数组，默认 `[]` | `#频道名`；兼容旧频道 ID；未知频道名保留 |
| `budget.turns` | 整数 1–256，默认 32 | 单次轮数，现有运行器与后端准入读取文件 |
| `budget.tokens` | 整数 1–2,000,000，默认 200,000 | 单次 token，沿用现有结算与拦截 |
| `budget.minutes` | 整数 1–1,440，默认 20 | 单次分钟数；暴露为 `member.wake_minutes`，计时护栏由 `codex/team-polish` 接入 |
| `budget.total_tokens` | 整数 1–10¹²，默认 2,000,000 | 兼容既有成员累计 token 上限，旧值迁入文件 |
| `color` | `blue/green/amber/red/violet/slate`，默认 `blue` | 头像颜色 |
| `readonly` | 布尔值，默认 `false` | 既有全局只读权限 |
| `file_readonly` | 布尔值，默认 `false` | 只禁止文件写入；用于 Claude 的 Read/Grep/Glob，不影响单独授权的 Bash |
| `enabled` | 布尔值，默认 `true` | 停用/启用；软删除身份仍保存在数据库中 |
| 正文 | Markdown，最多 50,000 字符 | 成员角色说明 |
| 其他字段 | 原样保留 | 包括未知的预算子字段；不作为 ORA 的授权 |

默认工具为 `literature/files/web/project`，执行者与写手再有 `shell/experiments`。导师、文献员、评审、提炼者随包文件的文件权限默认只读。

## 界面、导入与共享说明

- 沿用成员页的编辑对话框，采用现有 `lg` 尺寸；宽窗口左侧表单、右侧 Markdown 正文，窄窗口单列。源文件模式编辑整份文件。没有改变共享组件的尺寸，也没有加入说明性文案；中英文标签同步。
- 列表显示头像、名字、简介、状态点和状态；内置名字被编辑后使用实际名字。保留私信、工作记录、累计花费、订阅、库同步和团队覆盖操作。
- 可选择 `.md/.toml` 文件，或粘贴 Claude/Codex 内容。Claude `Read/Grep/Glob → files + file_readonly`，`Edit/Write → files`，`Bash → shell`，`WebFetch/WebSearch → web`；未知工具保留并显示提示。Codex 的 `description` 留在头部，`developer_instructions` 移到正文，其余字段保留。
- `AGENTS.md` 是团队共享说明。成员简报、项目现状和研究简报读取它；原有项目说明编辑入口也写入它并提交。旧 `PROJECT.md` 在已有仓库中原样改名并单独提交一次；同时存在两个文件时不覆盖已有 `AGENTS.md`，保留原文件。
- 成员初始化只创建私有项目仓库，不为了打开成员页抓取本地/SSH 源码；原有研究工作树创建时仍完成代码快照。测试使用临时目录及假运行器；没有调用真实模型、访问个人数据目录或连接 SSH。

## 迁移与设计差异

`0047_agent_files` 接在 `0046` 后面，为成员和库添加文件路径。标准 Alembic 环境传入所选数据目录，迁移时导出库和团队定义、迁移共享说明；手动迁移连接未提供目录时，在第一次读取成员时补齐导出。迁移可重复执行，降级保留磁盘文件。

为保证旧数据及降级能力，旧 SQL 定义列没有删除，改为 `legacy_*` 映射的只读迁移档案。文件已有路径后，运行不会再把这些列当作定义；实际编辑不写这些列。`budget.total_tokens`、`enabled`、两种只读字段是为保留第 2 步行为而添加的格式扩展。旧数据中存在同名定义时，迁移文件名附成员 ID，避免覆盖。

数据库中的 `deleted` 是历史身份的软删除状态；停用由文件 `enabled` 决定。内置文件的用户编辑完全开放，删除仍沿用第 2 步的限制。没有改叫醒选择、调度、并发、接力及计时护栏算法。

## 验证

测试结果和原始日志见同目录 `agent-files-validation/`。最终命令按完整 pytest → Node → frontend check → Vitest → build 的顺序执行。Playwright 只收集，交由负责人启动浏览器执行。

依赖环境：共享 `.venv` 位于可写根目录之外，新依赖只安装在临时目录。完整验证期间使用临时虚拟环境叠加共享依赖，避免 CLI 测试清空 `PYTHONPATH` 后找不到 `ruamel.yaml`；验证结束恢复原 `.venv` 链接。项目依赖已同步写入 `pyproject.toml` 和 `backend/requirements.txt`。

| 检查 | 最终结果 | 原始日志 |
| --- | --- | --- |
| 完整 pytest | 1653 passed、16 skipped；5 项已约定的沙箱失败 | [pytest](../agent-files-validation/pytest.log) |
| 成员/文件专项 | 41 passed | [backend-files](../agent-files-validation/backend-files.log) |
| 迁移 | 空库升到 0047 → 降到 0046 → 重升；外键检查通过；旧数据导出与幂等见专项 | [migration-smoke](../agent-files-validation/migration-smoke.log) |
| Node | 20 passed | [node](../agent-files-validation/node.log) |
| frontend check | 1783 个文案键、TypeScript、Prettier 通过 | [check](../agent-files-validation/check.log) |
| Vitest | runner 模式：52 个文件、388 passed | [vitest](../agent-files-validation/vitest.log) |
| build | 标准命令的 TypeScript 通过；runner 构建及 copy-docs 通过，保留已有大 chunk 警告 | [build](../agent-files-validation/build.log) |
| Playwright | 6 个用例收集通过；未启动浏览器 | [playwright-list](../agent-files-validation/playwright-list.log) |
| Ruff / diff | 通过 | `git diff --check` |

最终完整 pytest 的失败原文：

```text
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[15]
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[1]
FAILED backend/tests/test_local_lifecycle.py::test_workers_leave_when_the_cli_is_killed
FAILED backend/tests/test_local_lifecycle.py::test_a_killed_worker_is_restarted_and_health_says_so
FAILED backend/tests/test_research_host.py::test_the_probe_names_this_machines_chip
5 failed, 1653 passed, 16 skipped, 8 warnings in 160.16s (0:02:40)
```

错误原文：

```text
E                   PermissionError: [Errno 1] Operation not permitted: 'ps'
E           AssertionError: assert ''
```

标准 Vitest / build 的启动错误原文；随后使用指定 runner 成功：

```text
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/agent-files/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792758001042-b92eb8130a562.mjs'
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/agent-files/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792758006174-d2c1ebd526a3e.mjs'
```

完整命令、退出码和用时：[check-results.json](../agent-files-validation/check-results.json)。早期环境和兼容问题的失败日志保留在 [pytest-first](../agent-files-validation/pytest-first.log)、[pytest-second](../agent-files-validation/pytest-second.log)、[check-first](../agent-files-validation/check-first.log)、[vitest-first](../agent-files-validation/vitest-first.log)；CLI 与翻译复核 [5 passed](../agent-files-validation/cli-layout-recheck.log)。最终全量已无这些额外失败。


## 负责人浏览器流程

1. 团队设置 → 成员 → 添加成员：填写名字、简介、正文、颜色、模型、六种工具组、机器、轮数/token/分钟和频道；在表单与源文件间往返，增加一个未知 YAML 字段和注释，保存后确认仍在项目 `.ora/agents/` 中，Git 提交只包含该成员并注明修改者。
2. 在源文件模式直接创建；再用文件选择导入 Claude `.md`，用粘贴导入 Codex `.toml`。确认正文和简介正确、未知工具提示出现且原名保留，Claude 只读文件工具与 Bash 权限分别记录。
3. 编辑内置成员的名字和正文、复制内置、恢复内置；停用和启用成员。列表核对头像、名字、简介、状态点；详情检查私信、线程和花费。
4. 用编辑器直接改项目仓库的成员文件，分别保留未提交和外部提交两种情况；重新打开成员页或下一次叫醒时确认内容生效。写一个 YAML 错误，检查具体行号、源文件仍可编辑，运行继续使用上一份有效定义；修复后错误消失。
5. 在另一团队添加同一个库成员；在团队文件外部修改正文、权限或其他字段，形成覆盖。编辑库后分别选择只保存到库和同步，确认覆盖保留、未覆盖字段更新，恢复库配置生效；外部修改库文件也应在下次打开时读到。
6. 用临时旧数据启动迁移，检查导出内容、停用和预算、库引用及历史记录；确认 `PROJECT.md` 内容不变地成为 `AGENTS.md`，重复打开不再创建改名提交。外部修改 `AGENTS.md` 后所有成员简报及项目说明页读取新内容。
7. 使用假模型请求越权工具，验证文件写入、机器、shell/web 等权限仍在工具提供和执行入口校验；设置小轮数/token 和累计 token 上限，验证现有预算拦截仍生效。分钟数的实际计时流程由 `codex/team-polish` 的护栏验收覆盖。
8. 中文/英文、浅色/深色、720px 窄窗口及键盘操作检查；没有说明性文案、横向溢出或失效操作。

```sh
# 在负责人可写的开发环境中安装本次新增依赖
.venv/bin/python -m pip install ruamel.yaml==0.18.6
cd frontend
npx playwright test e2e/screens/team-members.spec.ts e2e/screens/research-team.spec.ts e2e/screens/team-wire.spec.ts
```

`team-members.spec.ts` 中的六项浏览器用例使用拦截的假 API 测试界面；实际磁盘、Git、外部编辑与迁移由后端测试和上述人工流程验证。
