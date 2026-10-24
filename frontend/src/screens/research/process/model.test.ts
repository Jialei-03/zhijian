import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../i18n/i18n";
import {
  current,
  jobReport,
  logText,
  mainMetric,
  output,
  plainCommand,
  segment,
  shortDuration,
  summary,
  target,
  type RunStep,
} from "./model";

it("localizes short durations at seconds, minutes and hours without capping them", () => {
  for (const [locale, expected] of [
    [
      "zh",
      [
        "0 秒",
        "59 秒",
        "1 分 0 秒",
        "1 分 30 秒",
        "59 分 59 秒",
        "1 小时 0 分",
        "2 小时 37 分",
        "1 小时 53 分",
        "48 小时 0 分",
      ],
    ],
    [
      "en",
      [
        "0s",
        "59s",
        "1m 0s",
        "1m 30s",
        "59m 59s",
        "1h 0m",
        "2h 37m",
        "1h 53m",
        "48h 0m",
      ],
    ],
  ] as const) {
    const { t } = createTranslator(locale);
    expect(
      [0, 59, 60, 90, 3599, 3600, 9408, 6758, 172800].map((s) =>
        shortDuration(s, t),
      ),
    ).toEqual(expected);
  }
});

const step = (
  name: string,
  status = "completed",
  extra: Partial<RunStep> = {},
): RunStep => ({
  name,
  status,
  ...extra,
});

describe("a run, read as a turn", () => {
  it("keeps words and tools in order and merges finished runs of one tool", () => {
    const segments = segment([
      step("bash", "completed", { said: "先看显卡" }),
      step("bash"),
      step("bash"),
      step("read"),
      step("bash", "failed"),
      step("bash", "running", { said: "再试一次" }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual([
      "said",
      "steps",
      "said",
      "steps",
    ]);
    const rows = segments[1].kind === "steps" ? segments[1].rows : [];
    expect(rows.map((r) => [r.name, r.steps.length])).toEqual([
      ["bash", 3],
      ["read", 1],
      ["bash", 1],
    ]);
  });

  it("sums the work up by kind, in a fixed order", () => {
    expect(
      summary([
        step("read"),
        step("bash"),
        step("run_job"),
        step("bash"),
        step("edit"),
      ]),
    ).toEqual([
      ["command", 2],
      ["experiment", 1],
      ["read", 1],
      ["write", 1],
    ]);
  });

  it("reports project supervision without claiming to execute commands or experiments", () => {
    expect(
      summary([
        step("project_overview"),
        step("research_read"),
        step("start_research"),
        step("message_research"),
      ]),
    ).toEqual([
      ["read", 2],
      ["record", 2],
    ]);
  });

  it("names what a step was about, and what came back", () => {
    expect(
      target(
        step("bash", "completed", {
          arguments: '{"command":"nvidia-smi\\nls"}',
        }),
      ),
    ).toBe("nvidia-smi");
    expect(
      target(
        step("research_read", "completed", {
          arguments: { research_id: "research-1" },
        }),
      ),
    ).toBe("research-1");
    const printed = JSON.stringify({
      content: [{ type: "text", text: "RTX 5060 Ti" }],
    });
    expect(
      output(step("bash", "completed", { result: { summary: printed } })),
    ).toBe("RTX 5060 Ti");
    expect(output(step("bash", "failed", { error: "超时" }))).toBe("超时");
  });

  it("finds the step in progress", () => {
    expect(
      current([
        step("read"),
        step("bash", "running", { arguments: { command: "x" } }),
      ])?.name,
    ).toBe("bash");
    expect(current([step("read")])).toBeNull();
  });
});

describe("what a person reads of a run", () => {
  it("shows a command without its plumbing", () => {
    expect(
      plainCommand(
        "cd /home/lab/ora-research/c558/work && export OMP_NUM_THREADS=2 && python3 -u train.py --seed 0 2>&1 | tail -20",
      ),
    ).toBe("python3 -u train.py --seed 0");
    expect(
      plainCommand(
        "(nohup setsid python3 train_gpu.py --seed 1 > logs/a.log 2>&1 &)",
      ),
    ).toBe("python3 train_gpu.py --seed 1");
    expect(plainCommand("ls -la")).toBe("ls -la");
  });

  it("judges a run by its test accuracy, else validation, never by nan", () => {
    expect(
      mainMetric({ step: 3, val_acc: 0.98, final_test_acc: 0.993 }),
    ).toEqual(["final_test_acc", 0.993]);
    expect(
      mainMetric({ lr: 0.1, val_acc: 0.97, final_test_acc: "nan" }),
    ).toEqual(["val_acc", 0.97]);
    expect(mainMetric({})).toBeNull();
  });
});

describe("a job tool's result, read back", () => {
  // The service stores a result the way Python's json.dumps writes it.
  const logs = JSON.stringify({
    lines: [
      { n: 7, text: "epoch 1 loss 2.31" },
      { n: 8, text: 'val_acc 0.41 "best"' },
      { n: 10, text: "done" },
    ],
    total: 12,
  })
    .replace(/":/g, '": ')
    .replace(/,"/g, ', "');

  it("reads job_logs as numbered lines and marks that more follow", () => {
    const report = jobReport(logs)!;
    expect(report.lines.map((l) => l.n)).toEqual([7, 8, 10]);
    expect(report.total).toBe(12);
    expect(report.cut).toBe(false);
    expect(logText(report)).toBe(
      [
        " 7  epoch 1 loss 2.31",
        ' 8  val_acc 0.41 "best"',
        "10  done",
        "    …",
      ].join("\n"),
    );
  });

  it("keeps the whole lines of a log the service cut short", () => {
    const cut = logs.slice(0, logs.indexOf("done") + 2);
    const report = jobReport(cut)!;
    expect(report.cut).toBe(true);
    expect(report.lines.map((l) => l.text)).toEqual([
      "epoch 1 loss 2.31",
      'val_acc 0.41 "best"',
    ]);
    expect(logText(report).split("\n").pop()).toBe("   …");
  });

  it("ends without a mark when the log is read to its end", () => {
    const report = jobReport(
      '{"lines": [{"n": 1, "text": "ok"}], "total": 1}',
    )!;
    expect(logText(report)).toBe("1  ok");
    expect(logText(jobReport('{"lines": [], "total": 0}')!)).toBe("");
  });

  it("reads job_status: state, exit code, time and metrics", () => {
    const report = jobReport(
      JSON.stringify({
        status: "running",
        exit_code: null,
        elapsed_seconds: 192,
        log_lines: 40,
        command: "python train.py",
        metrics: { step: 3, val_acc: 0.912 },
        points: 3,
      }),
    )!;
    expect(report).toMatchObject({
      status: "running",
      exitCode: null,
      elapsedSeconds: 192,
      total: 40,
      metrics: { val_acc: 0.912 },
      lines: [],
    });
    expect(shortDuration(192)).toBe("3m12s");
    expect(shortDuration(7500)).toBe("2h5m");
  });

  it("reads a queued job: its place in this machine's queue", () => {
    const report = jobReport(
      JSON.stringify({
        job_id: "j2",
        status: "queued",
        queue_position: 2,
        hint: "本机实验依次运行",
      }),
    )!;
    expect(report).toMatchObject({ status: "queued", queuePosition: 2 });
  });

  it("reads a finished run_job wait, cut short, with its state", () => {
    const raw =
      '{"job_id": "j1", "status": "failed", "exit_code": 1, "log_lines": 300, "lines": [{"n": 1, "text": "Traceback"}, {"n": 2, "text": "  Fi';
    const report = jobReport(raw)!;
    expect(report).toMatchObject({ status: "failed", exitCode: 1, total: 300 });
    expect(report.lines).toEqual([{ n: 1, text: "Traceback" }]);
  });

  it("leaves anything else alone", () => {
    expect(jobReport("plain text")).toBeNull();
    expect(jobReport('{"ok": true}')).toBeNull();
  });
});
