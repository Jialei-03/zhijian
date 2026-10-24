import type { Translator } from "../../../i18n/i18n";

/**
 * An agent's run, read the way claude-web reads a turn: what it said and the
 * tools it used, in order; runs of the same finished tool merged into one row;
 * and a one-line summary of the work once it is done. Pure, so tests read it
 * the same way the thread does.
 */

export interface RunStep {
  name: string;
  label?: string;
  status: string;
  arguments?: Record<string, unknown> | string;
  result?: { summary?: string } | string;
  error?: string;
  /** What the agent wrote just before this step: why it takes it. */
  said?: string;
}

export interface ResearchRun {
  id: string;
  status: string;
  response: string;
  error: string;
  steps: RunStep[];
  role: string;
  runtime: {
    phase?: string;
    execution_seconds?: number;
    time_limit_reached?: boolean;
    no_answer?: boolean;
    max_execution_seconds?: number;
    budget_limit?: string;
    rule?: { rule: string; workflow: string; workflow_version: number };
  };
  created_at: string;
  updated_at: string;
  sprint_id?: string;
  sprint_number?: number;
}

export type Segment =
  | { kind: "said"; text: string }
  | { kind: "steps"; rows: Row[] };

/** One row of the trail: a step, or several finished steps of the same tool. */
export interface Row {
  name: string;
  steps: RunStep[];
}

export const isLive = (run: Pick<ResearchRun, "status">) =>
  run.status === "queued" || run.status === "running";

const done = (step: RunStep) => step.status === "completed";

/** Words and tool rows in the order they happened. */
export function segment(steps: RunStep[]): Segment[] {
  const out: Segment[] = [];
  for (const step of steps) {
    if (step.said) out.push({ kind: "said", text: step.said });
    const last = out[out.length - 1];
    if (last?.kind !== "steps") {
      out.push({ kind: "steps", rows: [{ name: step.name, steps: [step] }] });
      continue;
    }
    const row = last.rows[last.rows.length - 1];
    // Only finished steps of the same tool merge: a running or failed one stands alone.
    if (
      !step.said &&
      row.name === step.name &&
      done(step) &&
      row.steps.every(done)
    )
      row.steps.push(step);
    else last.rows.push({ name: step.name, steps: [step] });
  }
  return out;
}

/** What kind of work a tool is, for the summary line. */
export type Kind =
  | "command"
  | "read"
  | "write"
  | "search"
  | "experiment"
  | "record";

export const KIND: Record<string, Kind> = {
  bash: "command",
  read: "read",
  read_paper: "read",
  web_read: "read",
  job_logs: "read",
  job_status: "read",
  research_map_read: "read",
  project_overview: "read",
  research_read: "read",
  write: "write",
  edit: "write",
  grep: "search",
  find: "search",
  ls: "search",
  search_papers: "search",
  run_job: "experiment",
  record_result: "record",
  update_node: "record",
  add_node: "record",
  advise: "record",
  propose_plan: "record",
  start_research: "record",
  message_research: "record",
  focus: "record",
  end_sprint: "record",
};

/** How many of each kind of work, in a fixed order, leaving out the kinds not done. */
export function summary(steps: RunStep[]): [Kind, number][] {
  const order: Kind[] = [
    "command",
    "experiment",
    "read",
    "write",
    "search",
    "record",
  ];
  const counts = new Map<Kind, number>();
  for (const step of steps) {
    const kind = KIND[step.name] ?? "command";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return order.filter((k) => counts.has(k)).map((k) => [k, counts.get(k)!]);
}

const argsOf = (step: RunStep): Record<string, unknown> => {
  if (typeof step.arguments === "string") {
    try {
      return JSON.parse(step.arguments) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return step.arguments ?? {};
};

/** The thing a step was about, in one line: the command, the file, the query. */
export function target(step: RunStep): string {
  const a = argsOf(step);
  const pick = [
    "command",
    "path",
    "pattern",
    "url",
    "query",
    "intent",
    "title",
    "research_id",
    "node_id",
    "id",
    "job_id",
  ]
    .map((k) => a[k])
    .find((v) => typeof v === "string" && v);
  if (typeof pick !== "string") return "";
  const line =
    typeof a.command === "string" ? plainCommand(pick) : pick.split("\n")[0];
  return line.slice(0, 200);
}

/** What came back, as text: a tool's printed output, or the service's summary. */
export function output(step: RunStep): string {
  if (step.error) return step.error;
  const raw =
    typeof step.result === "string"
      ? step.result
      : (step.result?.summary ?? "");
  try {
    const parsed = JSON.parse(raw) as { content?: { text?: string }[] };
    if (parsed && Array.isArray(parsed.content))
      return parsed.content.map((c) => c.text ?? "").join("\n");
  } catch {
    /* plain text */
  }
  return raw;
}

/** The step in progress, if any: what the live card says the agent is doing. */
export function current(steps: RunStep[]): RunStep | null {
  for (let i = steps.length - 1; i >= 0; i -= 1)
    if (steps[i].status !== "completed" && steps[i].status !== "failed")
      return steps[i];
  return null;
}

/**
 * A command as a person reads it: without the plumbing an agent wraps it in
 * (changing into the workspace, exported variables, nohup/setsid, redirections
 * and a tail of the output).
 */
export function plainCommand(command: string): string {
  let c = command.split("\n")[0].trim();
  for (;;) {
    const before = c;
    c = c
      .replace(/^\(\s*/, "")
      .replace(/^cd\s+\S+\s*(&&|;)\s*/, "")
      .replace(/^export\s+(\w+=\S+\s*)+(&&|;)\s*/, "")
      .replace(/^(\w+=\S+\s+)+/, "")
      .replace(/^(nohup|setsid|exec|time)\s+/, "");
    if (c === before) break;
  }
  return c
    .replace(/\s*\)?\s*(>{1,2}\s*\S+)?\s*2>&1.*$/, "")
    .replace(/\s*\|\s*(tail|head|tee)\b.*$/, "")
    .replace(/\s*&\s*$/, "")
    .trim();
}

/** The one number a run is judged by: test accuracy, else validation, else the first. */
export function mainMetric(
  metrics: Record<string, unknown>,
): [string, number] | null {
  const numbers = Object.entries(metrics).filter(
    (e): e is [string, number] =>
      e[0] !== "step" && typeof e[1] === "number" && Number.isFinite(e[1]),
  );
  const order = [/^final_test_acc$/, /test_acc/, /val_acc/, /acc/, /loss/];
  for (const pattern of order) {
    const hit = numbers.find(([k]) => pattern.test(k));
    if (hit) return hit;
  }
  return numbers[0] ?? null;
}

/** One numbered line of a job's log. */
export interface LogLine {
  n: number;
  text: string;
}

/** What a job tool returned, read back: its state, and the log lines it carried. */
export interface JobReport {
  status?: string;
  exitCode?: number | null;
  elapsedSeconds?: number | null;
  /** While queued: its place in this machine's queue. */
  queuePosition?: number;
  metrics: Record<string, unknown>;
  lines: LogLine[];
  /** How many lines the log has in all, when the result says. */
  total?: number;
  /** The stored result was cut short, so the lines may stop early. */
  cut: boolean;
}

/** The tools whose result is a job's state or log, not printed output. */
export const JOB_TOOLS = new Set([
  "job_logs",
  "job_status",
  "stop_job",
  "run_job",
]);

const LINE = /\{"n":\s*(\d+),\s*"text":\s*("(?:[^"\\]|\\.)*")\s*\}/g;

const field = (raw: string, key: string): string | undefined =>
  new RegExp(`"${key}":\\s*("(?:[^"\\\\]|\\\\.)*"|-?[\\d.]+|null)`).exec(
    raw,
  )?.[1];

const parsed = (v: string | undefined): unknown => {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

/**
 * A job tool's result (job_logs, job_status, run_job's wait, stop_job), read
 * from the stored text. The service keeps only the first part of a result, so
 * a long log arrives cut mid-line: what can be read is kept.
 */
export function jobReport(raw: string): JobReport | null {
  let whole: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v))
      whole = v as Record<string, unknown>;
  } catch {
    /* cut short: read it piece by piece */
  }
  const pick = (key: string): unknown =>
    whole ? whole[key] : parsed(field(raw, key));
  const lines: LogLine[] = [];
  if (whole) {
    if (Array.isArray(whole.lines))
      for (const l of whole.lines as unknown[]) {
        const line = l as Partial<LogLine>;
        if (typeof line?.n === "number" && typeof line.text === "string")
          lines.push({ n: line.n, text: line.text });
      }
  } else {
    for (const m of raw.matchAll(LINE)) {
      const text = parsed(m[2]);
      if (typeof text === "string") lines.push({ n: Number(m[1]), text });
    }
  }
  const status = pick("status");
  const exitCode = pick("exit_code");
  const elapsed = pick("elapsed_seconds");
  const position = pick("queue_position");
  const total = pick("total") ?? pick("log_lines");
  let metrics: Record<string, unknown> = {};
  if (whole && whole.metrics && typeof whole.metrics === "object")
    metrics = whole.metrics as Record<string, unknown>;
  if (typeof status !== "string" && !lines.length && !raw.includes('"lines"'))
    return null;
  return {
    status: typeof status === "string" ? status : undefined,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    elapsedSeconds: typeof elapsed === "number" ? elapsed : null,
    queuePosition: typeof position === "number" ? position : undefined,
    metrics,
    lines,
    total: typeof total === "number" ? total : undefined,
    cut: !whole,
  };
}

/** Log lines as a person reads them: each behind its line number, aligned. */
export function logText(report: Pick<JobReport, "lines" | "total" | "cut">) {
  const { lines } = report;
  if (!lines.length) return "";
  const width = String(lines[lines.length - 1].n).length;
  const body = lines.map((l) => `${String(l.n).padStart(width)}  ${l.text}`);
  const last = lines[lines.length - 1].n;
  if (report.cut || (report.total !== undefined && last < report.total))
    body.push(`${" ".repeat(width)}  …`);
  return body.join("\n");
}

/** A length of time, short: 45s, 3m12s, 2h5m. */
export function shortDuration(seconds: number, t?: Translator["t"]) {
  const s = Math.max(0, Math.round(seconds));
  const minutes = Math.round(s / 60);
  if (t)
    return s >= 3600
      ? t("reader.assistant.duration.hours", {
          hours: Math.floor(minutes / 60),
          minutes: minutes % 60,
        })
      : s >= 60
        ? t("reader.assistant.duration.minutes", {
            minutes: Math.floor(s / 60),
            seconds: s % 60,
          })
        : t("reader.assistant.duration.seconds", { seconds: s });
  return s >= 3600
    ? `${Math.floor(minutes / 60)}h${minutes % 60}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m${s % 60}s`
      : `${s}s`;
}
