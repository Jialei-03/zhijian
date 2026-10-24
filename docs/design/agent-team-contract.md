# 研究团队接口契约

以下为 `backend/team_rules.py` 与 `frontend/src/screens/team/workflow/workflow-model.ts` 共用的数据契约；代码与数据库之间的转换由 `team_workflows.py` 完成。消息和成员定义见 [研究团队](agent-team.md) 与 [成员文件](agent-files.md)。下列代码块是字段示意，`|` 表示可选值。

## 成员和频道的引用

- 成员：`{ "id": str, "name": str, "kind": "human" | "agent", "role": str }`。内置 agent 的 role：`advisor`（导师）、`executor`（执行者）、`librarian`（文献员）、`reviewer`（评审）、`writer`（写手）、`distiller`（提炼者）。我（研究者）的 role 是 `owner`。
- 成员还可带 `enabled: bool`、`subscriptions: str[]`，用于过滤停用成员和按频道订阅投递。数据库中的研究者角色 `human` 在这里映射为 `kind=human, role=owner`。
- 成员头像输出 `avatar` 原字符串、`avatar_url`（安全图片接口或 `null`）和 `avatar_seed`（缺省像素动物种子）；画布沿用同一组头像数据。
- 频道：`{ "id": str, "name": str, "kind": "channel" | "dm" }`。

## 规则（Rule）

```json
{
  "id": "r-…",
  "enabled": true,
  "when": {
    "event": "message" | "mention" | "job_finished" | "plan_approved" | "conclusion_proposed" | "review_failed" | "accepted" | "changes_requested" | "schedule",
    "channel": "频道 id，可省略表示任意",
    "from_role": "可省略",
    "from_member": "可省略",
    "kind": "消息类型，可省略：text | result | plan | conclusion | draft | review",
    "cron": "仅 schedule：分 时 日 月 周",
    "timezone": "仅 schedule"
  },
  "then": {
    "action": "wake" | "review" | "wait_for_owner" | "post",
    "member": "成员 id（wake / review）；裁决事件可用 $author 指向原作者",
    "role": "或者按角色找成员",
    "subscribers": true,
    "instruction": "给被叫醒成员的一句话",
    "on_fail": "review 不通过时交给谁（成员 id 或 role）",
    "max_rounds": 0,
    "channel": "post 发到哪",
    "text": "post 的内容"
  },
  "limit": { "per_thread": 0 },
  "position": { "x": 0, "y": 0 }
}
```

`max_rounds` 和 `limit.per_thread` 缺省或为 0 时不限；只有显式填写的正数限制评审退回次数和规则触发次数。

`wake/review` 的 `member`、`role`、`subscribers: true` 三选一；订阅者只允许 `message → wake`。按角色解析必须唯一匹配一个 agent。评审必须有 `on_fail`，`post` 必须有目标频道与正文。`enabled` 默认 `true`，`instruction` 默认空，`position` 可省略；保留的规则 ID `@mention` 不能用于用户规则。

## 事件（Event）——规则引擎的输入

```json
{ "type": "message" | "mention" | "job_finished" | "plan_approved" | "conclusion_proposed" | "review_failed" | "accepted" | "changes_requested" | "schedule",
  "team": "团队 id", "channel": "频道 id", "thread": "线程根消息 id 或 null",
  "author": { "id", "kind", "role" }, "kind": "消息类型", "mentions": ["成员 id"], "at": "ISO 时间" }
```

`author` 对系统事件可为 `null`，`at` 必须带时区。`mentions` 是适配层已经解析好的收件人：用户的文字 `@`、私信隐式收件人、agent 的 `team_send_message.to`；引擎不扫描正文。用户可同时叫醒所有指定成员，不限人数；agent 正文 `@` 只是提到，提及负责人可保留通知。

交付物裁决事件由研究者发出，另带 `original_author` 指向被裁决消息作者，`kind` 为原消息类型；作者过滤和 `$author` 按该字段解析。`accepted` 记录并匹配规则，不投递唤醒；`changes_requested` 默认向原作者投递意见，并与规则唤醒去重。发送方式 `record` 只保存消息，绕过事件路由。`done_when` 是可选消息数据，随唤醒 prompt 和后续评审上下文传递。

适配层还可传 `scope: [team, channel, thread]` 保留跨频道的原路由范围，以及 `pending_members: str[]` 合并尚未开工的投递。agent 主动发起等待只能用 `team_wait_for_owner`，适配成显式等待事件；正文提及不会触发等待。工作流显式 `wait_for_owner` 与研究审批仍按各自状态机执行。

## 动作（Action）——规则引擎的输出

```json
{ "rule": "规则 id", "action": "wake" | "review" | "wait_for_owner" | "post",
  "member": "成员 id", "instruction": "…", "channel": "…", "thread": "…", "text": "…" }
```

达到用户显式设置的评审退回上限时，引擎还会输出 `action="limit", reason="review", limit=N`；`limit` 不是可编辑的规则动作。agent 接力没有上限。

## 工作流（Workflow）

```json
{ "id": "…", "name": "…", "builtin": true | false, "version": 1,
  "rules": [Rule], "layout": { "members": { "成员 id": {"x","y"} }, "channels": { "频道 id": {"x","y"} } } }
```

## 运行状态（给画布叠加显示）

```json
{ "members": { "成员 id": "idle" | "working" | "waiting" }, "fired": [{ "rule": "规则 id", "at": "ISO" }] }
```

## 比较（Comparison）

```json
{ "threads": [{ "id", "title", "workflow": "名称", "status", "conclusion": "一句话",
  "numbers": [{"name", "value"}], "tokens": int, "job_seconds": int, "elapsed_seconds": int,
  "rounds": int, "members": [{"id", "name", "messages": int, "tokens": int}] }] }
```

比较条目的 `id` 是 `ResearchProject.id`；团队的研究线程标识为 `research:<id>`，不混用普通根消息 ID。
