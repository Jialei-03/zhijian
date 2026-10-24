"""Bilingual rule templates and the storage-free legacy definition compiler."""

from copy import deepcopy


def definitions(locale="zh"):
    if locale not in {"zh", "en"}:
        raise ValueError("locale must be zh or en")

    def text(zh, en):
        return zh if locale == "zh" else en

    def step(zh, en, kind, instructions, outputs=(), **extra):
        result = {
            "name": text(zh, en),
            "type": kind,
            "instructions": text(*instructions),
            "outputs": list(outputs),
            **extra,
        }
        if kind == "experiment":
            result["review_instructions"] = text(
                "评审实验结果、证据与止损条件；不通过就给出具体修改意见。",
                "Review the experiment results, evidence and stopping criteria; give specific revisions on failure.",
            )
        return result

    literature = [
        step(
            "收集论文",
            "Collect papers",
            "agent",
            (
                "从资料库与检索中收集相关论文，记录来源。",
                "Collect relevant papers from the library and search, recording sources.",
            ),
            ["review/sources.md"],
        ),
        step(
            "精读要点",
            "Read closely",
            "agent",
            (
                "逐篇整理问题、方法、结果、局限，并注明出处。",
                "Record each paper's question, methods, results and limitations with citations.",
            ),
            ["review/notes.md"],
        ),
        step(
            "综述成文",
            "Write the review",
            "agent",
            (
                "依据来源和精读要点撰写文献综述。",
                "Write a literature review using the sources and reading notes.",
            ),
            ["review/review.md"],
        ),
        step(
            "评审",
            "Review",
            "review",
            (
                "评审综述的准确性、覆盖面和引用。",
                "Review accuracy, coverage and citations.",
            ),
        ),
    ]
    writing = [
        step(
            "汇总项目结论",
            "Outline the paper",
            "agent",
            (
                "读取项目记忆及各研究结论，整理论文提纲。",
                "Read project memory and research conclusions to outline the paper.",
            ),
            ["paper/outline.md"],
        ),
        step(
            "写草稿",
            "Write a draft",
            "agent",
            (
                "依据提纲与真实研究证据撰写论文草稿。",
                "Draft the paper using the outline and actual research evidence.",
            ),
            ["paper/draft.md"],
        ),
        step(
            "自审",
            "Self-review",
            "review",
            (
                "检查论点、证据和引用；不通过就给出具体修改意见。",
                "Check claims, evidence and citations; give specific revisions on failure.",
            ),
            confirmation=True,
        ),
    ]
    data = {
        "research": (
            text("研究", "Research"),
            [
                step(
                    "定题",
                    "Plan",
                    "plan",
                    (
                        "明确研究问题、假设和止损条件，提交计划等待负责人批准。",
                        "Define the question, hypotheses and stopping criteria; submit the plan for owner approval.",
                    ),
                ),
                step(
                    "实验",
                    "Experiments",
                    "experiment",
                    (
                        "按批准的计划执行实验，记录可核验的结果并交导师评审。",
                        "Run the approved experiments, record verifiable results and ask the advisor to review.",
                    ),
                ),
                step(
                    "结论",
                    "Conclusion",
                    "agent",
                    (
                        "总结实验结论，等待研究者确认。",
                        "Summarize the experiment conclusions and wait for owner confirmation.",
                    ),
                    action="conclusion",
                    confirmation=True,
                ),
                step(
                    "复盘",
                    "Retrospective",
                    "agent",
                    ("提炼本次研究的经验。", "Distill lessons from this research."),
                    action="retrospective",
                ),
            ],
            ["advisor", "executor", "advisor", "distiller"],
        ),
        "literature-review": (
            text("文献综述", "Literature review"),
            literature,
            ["librarian", "librarian", "writer", "reviewer"],
        ),
        "reproduction": (
            text("复现一篇论文", "Paper reproduction"),
            [
                step(
                    "选定论文",
                    "Choose a paper",
                    "plan",
                    (
                        "说清复现哪个结果、怎么算成功。",
                        "Specify the result to reproduce and the success criteria.",
                    ),
                ),
                step(
                    "复现实验",
                    "Reproduce experiments",
                    "experiment",
                    (
                        "复现实验并记录配置、数据与结果。",
                        "Reproduce the experiments, recording configuration, data and results.",
                    ),
                ),
                step(
                    "对比报告",
                    "Comparison report",
                    "agent",
                    (
                        "对照论文数字，撰写复现结果与差异。",
                        "Compare the reproduction with the paper's numbers and explain differences.",
                    ),
                    ["reproduction.md"],
                ),
            ],
            ["executor", "executor", "writer"],
        ),
        "paper-writing": (
            text("写论文", "Paper writing"),
            writing,
            ["writer", "writer", "reviewer"],
        ),
        "read-to-write": (
            text("从读到写", "Read to write"),
            [
                *literature,
                step(
                    "找方向",
                    "Find a direction",
                    "agent",
                    (
                        "从综述中提出 3–5 个可做的问题，以 idea 卡片作为产出，等待研究者选择。",
                        "Propose 3–5 feasible questions as idea cards from the review and wait for the owner to choose.",
                    ),
                    confirmation=True,
                ),
                step(
                    "研究",
                    "Research",
                    "agent",
                    (
                        "以研究工作流派出子研究，完成后提交研究结论。",
                        "Start child research using the research workflow and return its conclusions.",
                    ),
                    action="child_research",
                ),
                *writing,
            ],
            [
                "librarian",
                "librarian",
                "writer",
                "reviewer",
                "advisor",
                "executor",
                "writer",
                "writer",
                "reviewer",
            ],
        ),
    }
    return {
        key: (
            {
                "id": key,
                "name": name,
                "version": 1,
                "builtin": True,
                "steps": deepcopy(steps),
            },
            roles,
        )
        for key, (name, steps, roles) in data.items()
    }


def compile_linear(definition, *, roles=None):
    from .team_rules import _workflow_key, deduplicate_workflow, validate_workflow

    source = deepcopy(definition)
    base = validate_workflow(
        {
            "id": source.get("id"),
            "name": source.get("name"),
            "version": source.get("version", 1),
            "builtin": source.get("builtin", False),
            "rules": [],
        }
    )
    steps = source.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("steps must be a non-empty list")
    if roles is not None and len(roles) != len(steps):
        raise ValueError("roles must contain one role per step")
    prepared = []
    for index, spec in enumerate(steps):
        if spec.get("type", "agent") not in {"agent", "plan", "experiment", "review"}:
            raise ValueError(f"steps[{index}].type is invalid")
        if not isinstance(spec.get("name"), str) or not spec["name"].strip():
            raise ValueError(f"steps[{index}].name is required")
        spec.setdefault("type", "agent")
        default = {
            "review": "advisor",
            "plan": "executor",
            "experiment": "executor",
        }.get(spec["type"], "executor")
        default = {"conclusion": "advisor", "retrospective": "distiller"}.get(
            spec.get("action"), default
        )
        spec["role"] = roles[index] if roles is not None else default
        # The experiment's conclusion event is already the conclusion proposal.
        if (
            spec.get("action") == "conclusion"
            and prepared
            and prepared[-1]["type"] == "experiment"
        ):
            prepared[-1]["confirmation"] = spec.get("confirmation", False)
            prepared[-1]["conclusion"] = spec
            prepared[-1]["instructions"] = "\n\n".join(
                part
                for part in (
                    prepared[-1].get("instructions", ""),
                    spec.get("instructions", ""),
                )
                if part
            )
            prepared[-1]["outputs"] = list(
                dict.fromkeys(
                    [
                        *prepared[-1].get("outputs", []),
                        *spec.get("outputs", []),
                    ]
                )
            )
            continue
        prepared.append(spec)
    if prepared[0]["type"] == "review":
        raise ValueError("review requires a preceding step")

    rules, routes = [], {}

    def add(label, start, end, event, then, *, role=None, kind=None, on_fail=None):
        rid = f"{base['id']}:{label}"
        when = {"event": event}
        if role:
            when["from_role"] = role
        if kind:
            when["kind"] = kind
        rules.append(
            {
                "id": rid,
                "enabled": True,
                "when": when,
                "then": then,
            }
        )
        routes[rid] = {"from": start, "to": end}
        if on_fail is not None:
            routes[rid]["on_fail"] = on_fail

    def instruction(spec):
        result = f"{spec['name']}: {spec.get('instructions', '')}".strip()
        if spec.get("outputs"):
            result += "\n" + "\n".join(spec["outputs"])
        # Preserve legacy execution settings in the dispatch instruction. They
        # remain executor concerns rather than extending the Rule contract.
        if spec.get("max_rounds") is not None:
            result += f"\nmax_rounds: {spec['max_rounds']}"
        if spec.get("action"):
            result += f"\naction: {spec['action']}"
        return result

    def start(index):
        if index >= len(prepared):
            return {"action": "wait_for_owner"}, "done"
        spec = prepared[index]
        then = {
            "action": "wake",
            "role": spec["role"],
            "instruction": instruction(spec),
        }
        if spec["type"] == "review":
            then.update(
                action="review",
                on_fail=prepared[index - 1]["role"],
                max_rounds=spec.get("max_retries", 0),
            )
        return then, f"step:{index}"

    first, cursor = start(0)
    add("start", "start", cursor, "message", first, role="owner")
    # A migration can begin at an already approved plan without rerunning planning.
    if prepared[0]["type"] == "plan":
        then, end = start(1)
        add(
            "approved-start",
            "start",
            end,
            "plan_approved",
            then,
            role="owner",
            on_fail="step:0" if then["action"] == "review" else None,
        )
    for index, spec in enumerate(prepared):
        cursor = f"step:{index}"
        then, end = start(index + 1)
        back = cursor if then["action"] == "review" else None
        if spec["type"] in {"agent", "review"}:
            add(
                f"{index}:continue",
                cursor,
                cursor,
                "message",
                {
                    "action": "wake",
                    "role": spec["role"],
                    "instruction": instruction(spec),
                },
                role=spec["role"],
                kind="text",
            )
        if spec["type"] == "experiment":
            add(
                f"{index}:result",
                cursor,
                cursor,
                "message",
                {
                    "action": "review",
                    "role": "advisor",
                    "instruction": spec.get(
                        "review_instructions",
                        "评审实验结果。 / Review the experiment results.",
                    ),
                    "on_fail": spec["role"],
                },
                role=spec["role"],
                kind="result",
                on_fail=cursor,
            )
            add(
                f"{index}:review",
                cursor,
                cursor,
                "message",
                {
                    "action": "wake",
                    "role": spec["role"],
                    "instruction": instruction(spec),
                },
                role="advisor",
                kind="review",
            )
            add(
                f"{index}:job",
                cursor,
                cursor,
                "job_finished",
                {
                    "action": "wake",
                    "role": spec["role"],
                    "instruction": instruction(spec),
                },
            )
            event, role, kind = "conclusion_proposed", "advisor", None
        elif spec["type"] == "plan":
            event, role, kind = "message", spec["role"], "plan"
        elif spec.get("action") == "conclusion":
            event, role, kind = "conclusion_proposed", spec["role"], None
        else:
            event, role = "message", spec["role"]
            kind = (
                "review"
                if spec["type"] == "review"
                else ("draft" if spec["role"] == "writer" else "result")
            )
        if spec.get("confirmation") or spec["type"] == "plan":
            terminal = index == len(prepared) - 1
            wait = {"action": "wait_for_owner"}
            if spec.get("conclusion"):
                wait["instruction"] = instruction(spec["conclusion"])
            add(
                f"{index}:wait",
                cursor,
                "done" if terminal else f"confirm:{index}",
                event,
                wait,
                role=role,
                kind=kind,
            )
            if not terminal:
                add(
                    f"{index}:approved",
                    f"confirm:{index}",
                    end,
                    "plan_approved",
                    then,
                    role="owner",
                    kind="conclusion" if spec.get("conclusion") else None,
                    on_fail=back,
                )
        else:
            add(
                f"{index}:done",
                cursor,
                end,
                event,
                then,
                role=role,
                kind=kind,
                on_fail=back,
            )
    if base["id"] == "research" and base["builtin"]:
        add(
            "discuss-conclusion",
            "confirm:1",
            "confirm:1",
            "message",
            {
                "action": "wake",
                "role": "advisor",
                "instruction": instruction(prepared[0]),
            },
            role="owner",
            kind="text",
        )
        add(
            "finished-discussion",
            "done",
            "done",
            "message",
            {
                "action": "wake",
                "role": "advisor",
                "instruction": instruction(prepared[0]),
            },
            role="owner",
            kind="text",
        )
        add(
            "retrospective-discussion",
            "step:2",
            "step:2",
            "message",
            {
                "action": "wake",
                "role": "advisor",
                "instruction": instruction(prepared[0]),
            },
            role="owner",
            kind="text",
        )
        add(
            "reopen",
            "confirm:1",
            "step:1",
            "plan_approved",
            {
                "action": "wake",
                "role": "executor",
                "instruction": instruction(prepared[1]),
            },
            role="owner",
            kind="result",
        )
        add(
            "resume",
            "step:1",
            "step:1",
            "plan_approved",
            {
                "action": "wake",
                "role": "executor",
                "instruction": instruction(prepared[1]),
            },
            role="owner",
            kind="plan",
        )
        add(
            "budget-retrospective",
            "step:1",
            "step:2",
            "conclusion_proposed",
            {
                "action": "wake",
                "role": "distiller",
                "instruction": instruction(prepared[2]),
            },
            role="executor",
        )
        add(
            "continue",
            "step:1",
            "step:1",
            "message",
            {
                "action": "wake",
                "role": "executor",
                "instruction": instruction(prepared[1]),
            },
            role="executor",
            kind="text",
        )
        add(
            "revise-plan",
            "confirm:0",
            "step:0",
            "message",
            {
                "action": "wake",
                "role": "advisor",
                "instruction": instruction(prepared[0]),
            },
            role="owner",
            kind="text",
        )
        add(
            "discuss-plan",
            "step:0",
            "step:0",
            "message",
            {
                "action": "wake",
                "role": "advisor",
                "instruction": instruction(prepared[0]),
            },
            role="owner",
            kind="text",
        )
        add(
            "guidance",
            "step:1",
            "step:1",
            "message",
            {
                "action": "wake",
                "role": "advisor",
                "instruction": instruction(prepared[0]),
            },
            role="owner",
            kind="text",
        )
    workflow = validate_workflow({**base, "rules": rules})
    return deduplicate_workflow(workflow, {"linear": {_workflow_key(workflow): routes}})
