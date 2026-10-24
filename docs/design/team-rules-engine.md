# 工作流规则引擎接口

`backend/team_rules.py` 只接收和返回内存中的 contract 字典，不读写模型、数据库、文件或时钟，不启动运行器。

## 校验

```python
validate_rule(rule, *, members=None, channels=None) -> dict
validate_workflow(workflow, *, members=None, channels=None) -> dict
```

返回规范化的独立副本；格式错误抛出 Pydantic `ValidationError`（包含字段路径），引用错误抛出 `ValueError`；工作流校验会附上规则 id。未提供成员或频道时只校验格式。传入的成员、频道就是 [团队接口契约](agent-team-contract.md) 的字典列表；不需要本模块专用的成员或频道模型。角色目标必须唯一解析为 agent，`member` 只按 id 查找；`on_fail` 先按 id、再按 role 查找。订阅者目标通过 `then.subscribers: true` 表达，只允许 `message → wake`。

规则默认启用；每线程触发次数和 review 退回次数默认不限，缺省或 0 都表示不限，只有显式填写的正数才设限。未知字段、重复规则 id、无效动作字段、非整数上限、无效时区或 cron 均拒绝。空规则列表合法。

## 事件和状态

```python
match(workflow, event, state, *, members) -> MatchResult
# MatchResult 是 NamedTuple：actions: list[Action], state: dict
actions, new_state = match(workflow, event, state, members=members)
```

Rule / Workflow / Action 均保持 contract 的字段名。事件作者使用成员引用中的 `id/kind/role`；系统产生的 `job_finished` / `schedule` 事件可用 `author=None`。`at` 必须带时区。成员列表和作者身份由调用方提供可信的团队数据。

返回可解包的 `(actions, state)`，动作与新计数由调用方一起持久化。输入对象均不修改，新状态可直接 JSON 序列化。`event.mentions` 来自适配层解析的用户 `@`、私信隐式收件人或 agent 的 `team_send_message.to`，不扫描 agent 正文；正文 `@` 不叫醒成员。

`state.threads` 按 JSON 编码的 `[team, channel, thread]` 分区，显式 `event.scope` 可保留跨频道的原范围。`thread=None` 使用该频道的独立计数区。每个区记录共享的 `relay`、`waiting`，并在 `workflows` 中按 `[workflow id, version]` 记录 `counts`、`reviews`、`cursor`。工作流切换不解除等我状态；规则计数按工作流版本隔离。`relay` 仅记录 agent 接力次数，没有执行上限。存储层原子地读出旧状态、调用引擎、保存新状态并入队动作，防止并发事件覆盖计数。

行为顺序：

1. 只有 `kind=human, role=owner` 的负责人发言解除等待并重置接力计数。其他人、作业和定时事件都不能解除。
2. 等我期间所有动作暂停；每次输出 wait 也清除该区尚未完成的评审，避免晚到的失败事件重新打开旧工作。
3. 对应当前待评审任务的 `review_failed` 退回 `on_fail`；只有显式填写正数 `max_rounds` 时限制退回次数，达到后下一次失败输出 `limit`。同一待评审任务在消费失败后不会再次退回；结果按线程和评审成员关联，无法唯一关联时明确报错。失败退回和超限动作都计入原评审规则的触发次数。投递层需按评审运行去重结果；contract 没有运行关联 id，引擎无法区分跨轮迟到的旧结果和新结果。
4. 匹配到 `wait_for_owner` 的规则优先于同事件的其他动作，包括 @。
5. 有显式收件人时优先运行匹配的 mention 规则，其次使用目标正好在收件人中的普通规则（例如把结果交给导师仍是 review，保留退回状态），其他有效 agent 用 `rule="@mention"` 直接叫醒，不限收件人数。忽略未知 id、human 和停用成员；一个成员每事件最多叫醒一次。匹配的规则耗尽显式上限后不会用直接叫醒绕过该上限。
6. 否则按规则列表顺序匹配，频道、作者角色、作者 id、消息类型同时满足才触发。只有实际产出的动作才计数。规则的触发上限在负责人发言后仍保留。
7. 非负责人事件的 wake 和 review 记录接力次数，包含作业唤醒、agent 显式收件人和评审退回；用户 `@` 与合并 `pending_members` 中的未开工投递不增加接力次数。接力没有上限，post 也不增加接力次数。订阅者一次唤醒多人只计一次规则触发。

本模块不计算团队 token、费用、并发运行、消息队列或 steer；这些由 `team_budgets.py`、`research_team.py` 和现有运行器处理，成员、研究、团队预算默认不限。agent 主动等待仅由 `team_wait_for_owner` 提出并适配为等待事件；正文提及负责人只通知，不进入等待。显式规则 `wait_for_owner` 继续按上述优先级执行。停止是消息上的运行控制，不依赖接力计数。`state` 是持久计数，不是给画布展示的 `members/fired` 叠加状态；适配层记录实际触发时间。

## 定时

```python
due(workflow, now, last_runs, *, members) -> list[Action]
next_cron(cron, timezone_name, after) -> datetime  # UTC，严格晚于 after
```

支持五段数字 cron、`*`、逗号列表、范围、步长，周日为 0 或 7；日与周同时为受限字段时取 OR。时间必须带时区。和 `research_schedules.next_time` 一样，在当地墙上时间构造候选：春季跳时顺延，秋季重复小时只采用第一次。没有添加 cron 依赖。

`last_runs` 是当前工作流内 `{rule_id: 最后一次投递尝试的 ISO 时间或 datetime}`，传入存储层完成隔离的记录。多个漏跑时段只产生一个动作。成功或失败都应把最后投递时间记成当前 `now`，与现有定时任务的跳过积压语义一致。没有历史记录时仅在当前命中的分钟内投递；创建或启用时保存一次基线，就能在停机后补跑。

`due` 是无状态的到期规划；动作 `thread=None`，没有频道限制的 wake/review 不含 channel，由调度器选择默认频道或新线程。post 的频道使用 then.channel。投递层必须原子认领计划并更新 last_runs；本函数不承诺并发认领或消息去重。

如果定时动作投递进已有线程，或需要保留 review 的退回状态，先把到期规则和最终目的地交给 `match`，只分发它的结果：

```python
planned = due(workflow, now, last_runs, members=members)
ids = {action["rule"] for action in planned}
ready = {**workflow, "rules": [r for r in workflow["rules"] if r["id"] in ids]}
# event 使用 contract 格式：type=schedule、author=None、最终 channel/thread、at=now。
actions, new_state = match(ready, event, state, members=members)
```

`match` 信任调度器已经判断 schedule 事件到期；不在这里再次计算 cron。这样定时事件也遵守等我、接力、每线程上限，并登记待评审任务。不要把 planned 和 actions 各分发一次。

## 模板和迁移

```python
builtin_workflows(locale="zh") -> dict[str, dict]  # locale: zh / en
initial_state(workflow) -> dict
convert_linear_workflow(definition, *, roles=None) -> tuple[dict, dict]
```

内置数据在 `backend/team_rule_templates.py`，包括 research、literature-review、reproduction、paper-writing、read-to-write。两种语言保留同样的规则 id 和角色，名称、指示同步。研究流程包含计划批准、执行者结果、导师评审、退回、作业结束、提出结论等我，以及确认后提炼者复盘。模板第一次 match 时自动补入路由元数据，也可提前调用 initial_state。

迁移函数接收旧 `research_workflows` 的 definition（含 id/name/version/steps），返回 contract workflow 和必须一起保存的初始 state。`roles` 可按旧步骤指定角色，默认 agent/plan/experiment 为 executor，review/conclusion 为 advisor，retrospective 为 distiller。纯函数不修改旧输入；持久化、旧研究快照升级及在途阶段恢复由迁移和 `team_workflows.py` 的适配层处理。

contract 没有步骤条件或完成事件，因此规则阶段路由保存在 `state.linear`，每事件只消耗当前阶段的一次转换。额外添加、没有阶段路由的规则照常按事件匹配。旧的产出路径、指示、agent 轮数和 child_research/retrospective 意图交给运行器的 instruction；review.max_retries 映射为 max_rounds。experiment 后的 conclusion 合并为同一个结论等待点，避免重复叫醒导师提出已经存在的结论。需要确认的中间步骤统一使用负责人发出的 `plan_approved`，因为 contract 没有其他批准事件；完成后没有下一步时输出 wait_for_owner，下一次负责人发言仅解除等待。

编译和读取时，相同 `when` / `then` 的规则只保留一条，优先保留改过启用状态、上限或位置的版本，并保留该条的列表顺序。不同指示仍是不同规则。同一规则的多个阶段入口合并在 `state.linear` 的路由内：首个入口仍用 `from` / `to` / `on_fail`，其余入口放在 `alternatives` 数组中；计数、待评审和定时状态随规则 id 合并，避免读取旧数据后丢失运行进度。

纯引擎不执行产出写入、检查点提交、子研究创建或研究阶段推进。`team_workflows.py`、`research_workflows.py`、`research_worker.py` 和 `team_timers.py` 已将 finish_step/review_step、计划批准、结论确认、作业结束与定时接入事件，同时保留原领域执行能力，详见 [工作流](workflows.md)。
