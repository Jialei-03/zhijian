import {
  ChevronRight,
  ClipboardCheck,
  Crosshair,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Map as MapIcon,
  Play,
  Search,
  Stamp,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../../../i18n/I18nProvider";
import type { MessageKey, PluralBase } from "../../../i18n/i18n";
import { fadeTail, useSmoothText } from "../../../reader/stream";
import type { Agent } from "../scene/frames";
import { Mascot } from "../scene/Mascot";
import {
  current,
  isLive,
  JOB_TOOLS,
  jobReport,
  logText,
  mainMetric,
  output,
  segment,
  shortDuration,
  summary,
  target,
  type ResearchRun,
  type Row,
  type RunStep,
} from "./model";
import styles from "./Process.module.css";

const ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  read: FileText,
  write: FilePen,
  edit: FilePen,
  grep: Search,
  find: Search,
  ls: FolderOpen,
  web_read: Globe,
  search_papers: Search,
  read_paper: FileText,
  research_map_read: MapIcon,
  focus: Crosshair,
  run_job: Play,
  job_logs: Terminal,
  job_status: Terminal,
  record_result: ClipboardCheck,
  advise: Stamp,
  propose_plan: FileText,
  finish_step: ClipboardCheck,
  review_step: Stamp,
  start_research: Play,
  message_research: FilePen,
};

const AGENT: Record<string, Agent> = {
  executor: "executor",
  workflow: "executor",
  review: "advisor",
  advisor: "advisor",
  scoping: "advisor",
  discussion: "advisor",
  distiller: "distiller",
  chat: "advisor",
  lead: "advisor",
};

const OUTPUT_LINES = 40;

function useVerb() {
  const { t } = useI18n();
  return (step: Pick<RunStep, "name" | "label">) => {
    const key = `research.tool.${step.name}` as MessageKey;
    // Old runs may carry descriptions as labels; never render those.
    const said = t(key);
    return said && said !== key ? said : step.name;
  };
}

/** What the agent wrote, revealed at an even pace while it is being written. */
export const Words = memo(function Words({
  text,
  live,
}: {
  text: string;
  live: boolean;
}) {
  const { text: shown, flowing } = useSmoothText(text, { done: !live });
  return (
    <div className={styles.words}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={flowing ? [fadeTail] : []}
        skipHtml
      >
        {shown}
      </ReactMarkdown>
    </div>
  );
});

/** Four squares lit in turn: the step is running. */
function WorkDots() {
  return (
    <span className={styles.dots} aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function Glyph({ row }: { row: Row }) {
  const last = row.steps[row.steps.length - 1];
  if (last.status === "failed")
    return <X size={14} className={styles.failedGlyph} aria-hidden />;
  if (last.status !== "completed") return <WorkDots />;
  const Icon = ICONS[row.name] ?? Wrench;
  return <Icon size={14} aria-hidden />;
}

/**
 * What a step returned, as text to read. A job tool's result is a job's state
 * and log, so it reads as a status line over numbered log lines, not as JSON.
 */
function useStepText() {
  const { t } = useI18n();
  return (step: RunStep): string => {
    const raw = output(step);
    if (step.error || !JOB_TOOLS.has(step.name)) return raw;
    const report = jobReport(raw);
    if (!report) return raw;
    const head: string[] = [];
    if (report.status === "queued" && report.queuePosition)
      head.push(t("research.job.queuedAt", { n: report.queuePosition }));
    else if (report.status)
      head.push(
        t(`research.job.${report.status}` as MessageKey) || report.status,
      );
    if (report.exitCode !== null && report.exitCode !== undefined)
      head.push(t("research.process.exitCode", { code: report.exitCode }));
    if (report.elapsedSeconds)
      head.push(
        t("research.process.elapsed", {
          time: shortDuration(report.elapsedSeconds),
        }),
      );
    const main = mainMetric(report.metrics);
    if (main) head.push(`${main[0]} ${main[1].toPrecision(4)}`);
    // A status alone (job_status) also says how long the log is: once it is
    // done, since a running job's lines are only counted at the end.
    if (
      !report.lines.length &&
      report.total !== undefined &&
      report.status &&
      report.status !== "running" &&
      report.status !== "queued"
    )
      head.push(t("research.process.logLines", { n: report.total }));
    return [head.join(" · "), logText(report)].filter(Boolean).join("\n");
  };
}

/** One row of the trail: a verb, its target in a chip, its state, its output a click away. */
function StepRow({ row }: { row: Row }) {
  const { t } = useI18n();
  const verb = useVerb();
  const last = row.steps[row.steps.length - 1];
  const failed = last.status === "failed";
  const running = last.status !== "completed" && !failed;
  const [open, setOpen] = useState(failed);
  const [all, setAll] = useState(false);
  const first = target(row.steps[0]);
  const many = row.steps.length > 1;
  const stepText = useStepText();
  const text = row.steps
    .map(
      (s) =>
        (many ? `$ ${target(s)}\n` : "") +
        stepText(s)
          .replace(/^\s*\n/, "")
          .trimEnd(),
    )
    .filter(Boolean)
    .join("\n\n");
  const lines = text.split("\n");
  const cut = !all && lines.length > OUTPUT_LINES;
  const shown = cut ? lines.slice(0, OUTPUT_LINES).join("\n") : text;
  return (
    <li
      className={styles.row}
      data-state={failed ? "failed" : running ? "running" : "done"}
    >
      <button
        type="button"
        className={styles.head}
        aria-expanded={text ? open : undefined}
        disabled={!text}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.glyph}>
          <Glyph row={row} />
        </span>
        <span className={styles.verb}>
          {verb(last)}
          {many && <span className={styles.times}>×{row.steps.length}</span>}
        </span>
        {first && (
          <code className={styles.chip} title={first}>
            {first}
            {many ? t("research.process.andMore") : ""}
          </code>
        )}
        <span className={styles.spacer} />
        <span className={styles.state}>
          {failed
            ? t("research.run.step.failed")
            : running
              ? t("research.run.step.running")
              : ""}
        </span>
        {text && (
          <ChevronRight size={12} className={styles.chevron} aria-hidden />
        )}
      </button>
      {open && text && (
        <div className={styles.out}>
          <pre className={failed ? styles.errText : undefined}>{shown}</pre>
          {cut && (
            <button
              type="button"
              className={styles.more}
              onClick={() => setAll(true)}
            >
              {t("research.process.showAll", { lines: lines.length })}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Words and tool rows in the order they happened. Words before a step are
 * complete once the step exists: only the words still being written (the
 * run's response, shown after the trail) flow in.
 */
export function Trail({ steps }: { steps: RunStep[]; live?: boolean }) {
  const segments = segment(steps);
  return (
    <div className={styles.trail}>
      {segments.map((s, i) =>
        s.kind === "said" ? (
          <Words key={i} text={s.text} live={false} />
        ) : (
          <ol key={i} className={styles.rows}>
            {s.rows.map((row, j) => (
              <StepRow key={j} row={row} />
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

/** "已处理 · 运行 5 条命令 · 读了 2 处": the work of a finished run, in one line. */
export function SummaryLine({
  steps,
  status,
  open,
  onToggle,
}: {
  steps: RunStep[];
  status?: string;
  open: boolean;
  onToggle(): void;
}) {
  const { t, tn } = useI18n();
  const parts = summary(steps).map(([kind, n]) =>
    tn(`research.process.sum.${kind}` as PluralBase, n),
  );
  const label =
    status === "failed"
      ? "research.process.failed"
      : status === "cancelled"
        ? "research.process.cancelled"
        : "research.process.done";
  return (
    <button
      type="button"
      className={styles.summary}
      data-status={status}
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronRight size={12} className={styles.chevron} aria-hidden />
      {[t(label), ...parts].join(" · ")}
    </button>
  );
}

/**
 * One run as an assistant turn: who, then the work. While it runs every step
 * shows; once done the work folds into one line (opened on demand), and what
 * it handed over stays in view.
 */
export function RunTurn({
  run,
  role,
  title,
  final,
  children,
  elapsed,
  footer,
  hideAuthor = false,
}: {
  hideAuthor?: boolean;
  elapsed?: number;
  footer?: ReactNode;
  run: ResearchRun | undefined;
  role: string;
  title: string;
  /** What the round handed over, shown under the folded work. */
  final?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const live = !!run && isLive(run);
  const [open, setOpen] = useState(false);
  const steps = run?.steps ?? [];
  const lastSaid = [...steps].reverse().find((s) => s.said)?.said ?? "";
  // While it writes, the words in progress are the response, unless the last step already shows them.
  const writing =
    live && run?.response && run.response.trim() !== lastSaid.trim()
      ? run.response
      : "";
  return (
    <section className={styles.turn} data-live={live || undefined}>
      {live && !hideAuthor && (
        <header className={styles.who}>
          <Mascot
            agent={AGENT[role] ?? "executor"}
            size={20}
            pose={live ? "work" : "idle"}
          />
          <span>{title}</span>
        </header>
      )}
      {live ? (
        <>
          <Trail steps={steps} live />
          {writing && <Words text={writing} live />}
          {steps.length === 0 && !writing && (
            <p className={`${styles.pending} ${styles.sweep}`}>
              {t(
                run?.status === "queued"
                  ? "research.process.waitingTurn"
                  : "research.process.pending",
              )}
            </p>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            className={styles.summary}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight size={13} className={styles.chevron} aria-hidden />
            {t("research.turn.elapsed", {
              time: clock(
                run?.runtime?.execution_seconds ??
                  elapsed ??
                  (run
                    ? (Date.parse(run.updated_at) -
                        Date.parse(run.created_at)) /
                      1000
                    : 0),
              ),
            })}
          </button>
          {open && <Trail steps={steps} live={false} />}
          {final && <Words text={final.replaceAll("\\n", "\n")} live={false} />}
          {(run?.status === "cancelled" ||
            (run?.status === "failed" && !run.error)) && (
            <p className={styles.pending}>
              {t(
                run.status === "failed"
                  ? "research.process.failed"
                  : "research.process.cancelled",
              )}
            </p>
          )}
          {run?.status === "failed" && run.error && (
            <p className={styles.error}>{run.error}</p>
          )}
        </>
      )}
      {footer}
      {children}
    </section>
  );
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Pinned over the composer while an agent works: who, what it is doing, how long. */
export function LiveCard({
  run,
  role,
  name,
}: {
  run: ResearchRun;
  role: string;
  name: string;
}) {
  const { t } = useI18n();
  const verb = useVerb();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const step = current(run.steps ?? []);
  const what = step
    ? t("research.process.doing", { who: name, verb: verb(step) })
    : run.status === "queued"
      ? t("research.process.queued", { who: name })
      : t("research.process.thinking", { who: name });
  const done = (run.steps ?? []).filter((s) => s.status === "completed").length;
  const started = new Date(
    run.created_at.endsWith("Z") || run.created_at.includes("+")
      ? run.created_at
      : run.created_at + "Z",
  );
  return (
    <div className={styles.live} role="status">
      <Mascot agent={AGENT[role] ?? "executor"} size={22} pose="work" />
      <span className={styles.phase}>
        <span className={styles.sweep}>{what}</span>
        {step && target(step) && (
          <code className={styles.chip}>{target(step)}</code>
        )}
      </span>
      <span className={styles.count}>
        {t("research.process.steps", { n: done })}
      </span>
      <span className={styles.clock}>{clock((now - +started) / 1000)}</span>
    </div>
  );
}
