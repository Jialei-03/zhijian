已归档：2026-10-24，现行设计见 [成员文件](../agent-files.md)。

# 研究团队第 2 步：自定义成员

工作区：`codex/team-2`。实现接在 `0045` 和现有团队投递、工作流、画布、比较之上。没有启动浏览器、调用真实模型、访问 `~/.open-paper-reader`、连接 SSH 或写入 Git 元数据。

## 实现

- 团队设置的成员页支持搜索、创建、编辑、复制、停用、重新启用和删除。表单包含名字、名字生成的头像及颜色、Markdown 角色说明、模型、工具权限、机器、每次唤醒的轮数/token 和频道订阅。内置成员保留身份，可以修改模型、权限、预算和订阅，不能删除。
- 成员详情显示头像、状态、最近活动、参与的普通/研究线程和累计 token，可以打开线程和私信。
- `member_library` 按用户保存全局自定义配置；团队成员保存有效配置及覆盖字段。添加成员时可选库成员，在多个团队中创建独立实例。编辑库配置必须明确选择是否同步；同步只更新未被团队覆盖的字段。可恢复库配置。版本不匹配返回 409。
- 普通成员运行和绑定团队的研究轮次都把角色说明放在模型简报最前面。实际工具清单按权限和机器过滤，执行入口再次校验，拒绝会写入 `permission_denied` 系统消息；运行过程同样保留工具错误。只读禁止文件写入及命令，团队通信和研究交接仍可用。
- 每次唤醒的轮数/token 限制进入运行器及后端模型请求准入。研究用量沿用原研究账本，每次只给成员计费一次。内置成员修改的模型也用于研究轮次、研究问答和复盘。
- 停用取消待投递消息；@、订阅者和普通规则不会再叫醒该成员，已经认领的投递也在运行前复查。运行中的成员在下一次模型请求或工具调用时复查状态和权限。
- 规则新增 `then.subscribers: true`，用于 `message → wake`。只唤醒当前频道的有效订阅者，排除发言者；沿用显式 @ 优先、规则触发次数及团队连续接力上限。一次消息给多个订阅者投递只记一次规则触发。
- 成员真实身份和自定义名字用于侧栏私信、@ 补全、消息、规则选择及画布。画布显示订阅规则到实际订阅者的边；点成员继续打开其私信，成员列表可进入详情。保留删除/停用成员的历史引用。
- 新界面只有名称、标签、状态和动作；中英文同步。使用现有 UI 组件及布局 token，没有调整共享组件尺寸。

## 与设计的差异及边界

- 删除采用软删除，实例、历史消息和规则引用保留；全局库条目保留，之后仍可加入其他团队。停用不撤销已经完成的操作。
- 全局成员库的入口放在“添加成员”的来源选择和成员详情的“编辑库配置”，没有增加顶级导航。频道订阅是团队自己的频道 ID，不跨团队同步。
- 预算按已返回的实际模型用量结算，在下一次请求前拦截；正在进行的一次模型调用可能让 token 超出阈值。单次输出上限也受到唤醒 token 限制。继续保留第 1 步的成员累计预算和团队总预算。
- 内置角色说明继续来自已有 skill 文件；自定义说明作为数据库里的 Markdown 提供给模型，没有为每名成员创建磁盘 skill 目录。

## 迁移

`0046_custom_team_members`，`down_revision = "0045"`：新增 `member_library`，以及团队实例的库引用、覆盖字段、角色说明、头像颜色、权限、订阅、启停/删除标记和单次预算。旧成员按原角色读取默认 skill/权限。升级兼容旧表以及早期迁移使用最新模型创建过的表；新增库外键延后创建，以兼容 PostgreSQL 从空库升级。测试覆盖保留旧记录、重复升级及降级；另用临时空库完成升级到 0046、降到 0045 后重升和外键完整性检查，并校验 PostgreSQL 的外键延后 DDL。

## 验证

按要求依次完成以下检查：

| 检查 | 结果 |
| --- | --- |
| 完整 pytest | 1622 passed、18 skipped；5 项已注明的沙箱失败 |
| agent-runtime `node --test` | 20 passed |
| frontend `npm run check` | 1772 个文案键、TypeScript、Prettier 通过 |
| Vitest | 标准启动受 `.vite-temp` 限制；runner 模式下 51 个文件、380 passed |
| build | 标准命令的 TypeScript 通过，Vite 启动受限；runner 构建及 copy-docs 通过，保留已有大 chunk 警告 |
| Playwright | 收集 3 个用例；未运行浏览器 |
| `git diff --check` | 通过 |

新增后端用例 12 项，包括 CRUD/隔离、复制内置、停用与排队、订阅者规则、权限/机器/只读拦截及审计、单次轮数/token 拦截、库同步/团队覆盖/版本冲突和迁移升降级；预算用假运行器验证，没有调用真实模型。新增前端单测 6 项，覆盖表单校验、权限选择、身份锁定、双语字段、自定义名字及订阅者规则。

最终完整 pytest 的失败原文：

```text
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[15]
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[1]
FAILED backend/tests/test_local_lifecycle.py::test_workers_leave_when_the_cli_is_killed
FAILED backend/tests/test_local_lifecycle.py::test_a_killed_worker_is_restarted_and_health_says_so
FAILED backend/tests/test_research_host.py::test_the_probe_names_this_machines_chip
5 failed, 1622 passed, 18 skipped, 8 warnings in 149.03s (0:02:29)
```

错误原文：

```text
E                   PermissionError: [Errno 1] Operation not permitted: 'ps'
E           AssertionError: assert ''
```

前端标准命令启动失败原文；使用指定 runner 后均通过：

```text
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/team-2/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792752938139-822fcee8c8a88.mjs'
Error: EPERM: operation not permitted, open '/Users/leslie/Desktop/ORA-worktrees/team-2/frontend/node_modules/.vite-temp/vite.config.ts.timestamp-1792752978279-7ecaef89d5b24.mjs'
```

完整原始日志：

- [最终 pytest](../agent-team-step2-validation/pytest.log)；[首次全量的研究运行格式回归，已修复](../agent-team-step2-validation/pytest-first.log)
- [迁移空库/重升检查](../agent-team-step2-validation/migration-smoke.log)
- [成员与规则回归](../agent-team-step2-validation/backend-members-final.log)；[迁移及运行检查](../agent-team-step2-validation/migration-runtime.log)
- [Node](../agent-team-step2-validation/node.log)；[前端 check](../agent-team-step2-validation/check.log)
- [Vitest 标准启动失败](../agent-team-step2-validation/vitest-standard.log) / [runner 结果](../agent-team-step2-validation/vitest.log)
- [build 标准启动失败](../agent-team-step2-validation/build-standard.log) / [runner 结果](../agent-team-step2-validation/build.log)
- [Playwright 收集](../agent-team-step2-validation/playwright-list.log)；[命令、退出码](../agent-team-step2-validation/check-results.json)

中间开发测试的失败和复测也保留在上述日志目录中。

Playwright 用例：`frontend/e2e/screens/team-members.spec.ts`，覆盖创建表单、只读与命令权限、预算、订阅、成员详情、私信、@ 补全、复制内置、编辑、停用、库成员加入及同步确认。沙箱内不执行浏览器用例。

## 负责人浏览器验收

1. 团队设置 → 成员 → 添加成员：填写名字、换头像颜色、写 Markdown skill、选模型和机器、调整轮数/token、订阅频道；保存、刷新，确认配置保留。
2. 打开成员详情，检查头像、状态、最近活动、token 和参与的线程；打开线程、发私信；在频道输入 @，确认自定义成员可补全，消息和私信使用其名字。
3. 从内置成员复制后修改；内置成员编辑身份字段应锁定，但模型、权限、预算可保存，菜单没有删除。自定义成员可编辑、停用、启用及删除，危险操作有确认。
4. 给成员关闭命令权限，用假模型请求 bash/实验命令，确认工具未提供；强制调用应被拒绝，消息和运行过程留下记录。选择只读、取消机器权限，检查文件写入/机器调用同样被拒绝。小预算下确认不会继续请求下一轮模型。
5. 建“频道新消息 → 订阅者”的规则，发送普通消息，只唤醒订阅者；显式 @、规则次数和接力上限仍生效。停用成员后发送 @、私信和命中规则的消息，确认不再启动运行，原排队消息取消。
6. 在另一团队添加同一个库成员；在其中一队修改角色说明形成覆盖，再编辑库配置，分别选择“只保存到库”和“同步”。确认同步保留团队覆盖，未覆盖字段更新；“恢复库配置”能撤销覆盖。
7. 工作流列表和画布中选择自定义成员；查看订阅者连线，点成员打开私信，成员列表进入详情。已有研究仍按原阶段、审批、实验、评审、结论和复盘推进；比较仍统计真实成员。
8. 中文/英文、深色/浅色、720px 窄窗口和键盘操作检查：表单标签、焦点、对话框和菜单无横向溢出。

负责人执行：

```sh
cd frontend
npx playwright test e2e/screens/team-members.spec.ts e2e/screens/research-team.spec.ts e2e/screens/team-wire.spec.ts
```
