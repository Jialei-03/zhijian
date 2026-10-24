import { ruleHash } from "../team-api";
import settingStyles from "../../team/TeamSettings.module.css";
import {
  Check,
  Copy,
  GitFork,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  FileText,
  Gauge,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../../../i18n/I18nProvider";
import type { MessageKey } from "../../../i18n/i18n";
import { Button, IconButton, Spinner, toast } from "../../../ui";
import { describeStep } from "../describe";
import type {
  Compute,
  ResearchJob,
  ResearchPlan,
  ResearchProject,
} from "../research-api";
import type { Agent } from "../scene/frames";
import { Mascot } from "../scene/Mascot";
import { mainMetric, plainCommand, type ResearchRun } from "../process/model";
import { RunTurn } from "../process/Process";
import type { ThreadItem } from "./thread";
import { WorkflowBoundary } from "../../workflows/WorkflowProgress";
import { CheckpointCard } from "../ChangeCards";
import styles from "./Talk.module.css";

const ROLE_AGENT: Record<string, Agent> = {
  executor: "executor",
  workflow: "executor",
  review: "advisor",
  advisor: "advisor",
  lead: "advisor",
  scoping: "advisor",
  discussion: "advisor",
  distiller: "distiller",
  system: "system",
};

export function Prose({ text }: { text: string }) {
  return (
    <div className={styles.prose}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {text.replaceAll("\\n", "\n")}
      </ReactMarkdown>
    </div>
  );
}

function Speaker({
  role,
  note,
  action,
}: {
  role: string;
  note?: string;
  action?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.speaker}>
      <Mascot agent={ROLE_AGENT[role] ?? "advisor"} size={20} />
      {t(
        `research.role.${role === "scoping" ? "discussion" : role}` as MessageKey,
      )}
      {note && <span className={styles.speakerNote}>{note}</span>}
      {action}
    </div>
  );
}

export interface ThreadActions {
  approvePlan(version: number): void;
  decide(id: string, approve: boolean, note: string): void;
  openLog(jobId: string): void;
  openRun(jobId: string): void;
  openOutput?(path: string): void;
  moveCompute(computeId: string): void;
  busy: boolean;
  fork?(sprintId?: string): void;
  changed?(): void;
  review?(sprintId?: string, path?: string): void;
}

export function ThreadView({
  items,
  project,
  computes,
  actions,
  runs,
  locateId,
}: {
  items: ThreadItem[];
  project: ResearchProject;
  computes: Compute[];
  actions: ThreadActions;
  /** Each round's run, by sprint: what it said and did, step by step. */
  runs: Map<string, ResearchRun>;
  locateId?: string;
}) {
  return (
    <>
      {items.map((item, index) => {
        const boundary = items
          .slice(0, index)
          .reverse()
          .find((row) => row.kind === "work" && row.sprint.commit_sha);
        const sprintId =
          boundary?.kind === "work" ? boundary.sprint.id : undefined;
        switch (item.kind) {
          case "workflow":
            return (
              <WorkflowBoundary
                key={item.id}
                id={item.id}
                index={item.index}
                status={item.status}
                outputs={item.outputs}
                workflow={project.workflow}
                open={actions.openOutput}
              />
            );
          case "message":
            return (
              <MessageItem
                key={item.id}
                id={item.id}
                located={item.id === locateId}
                who={item.who}
                text={item.text}
                at={item.at}
                sprintId={sprintId}
                actions={actions}
              />
            );
          case "plan":
            return (
              <PlanCard
                key={item.id}
                id={item.id}
                plan={item.plan}
                current={item.current}
                approved={
                  project.plan?.version === item.plan.version &&
                  !!project.plan?.approved_at
                }
                computes={computes}
                actions={actions}
              />
            );
          case "stage":
            return <StageMark key={item.id} to={item.to} note={item.note} />;
          case "notice":
            return <Notice key={item.id} item={item} />;
          case "decision":
            return <DecisionCard key={item.id} item={item} actions={actions} />;
          case "work":
            const work = (
              <WorkBlock
                key={item.id}
                item={item}
                project={project}
                computes={computes}
                actions={actions}
                run={runs.get(item.sprint.id)}
              />
            );
            return item.id === locateId ? (
              <div
                key={item.id}
                className={styles.located}
                data-research-item={item.id}
                tabIndex={-1}
              >
                {work}
              </div>
            ) : (
              work
            );
          default:
            return null;
        }
      })}
    </>
  );
}

export function MessageActions({
  text,
  at,
  sprintId,
  actions,
}: {
  text: string;
  at: string;
  sprintId?: string;
  actions: ThreadActions;
}) {
  const { t, locale } = useI18n();
  return (
    <div className={styles.messageActions}>
      <IconButton
        icon={Copy}
        label={t("research.message.copy")}
        size="sm"
        onClick={() =>
          navigator.clipboard
            .writeText(text)
            .catch((error) =>
              toast.show({ message: String(error), tone: "error" }),
            )
        }
      />
      <IconButton
        icon={GitFork}
        label={t("research.message.fork")}
        size="sm"
        disabled={!sprintId || !actions.fork}
        onClick={() => actions.fork?.(sprintId)}
      />
      <time dateTime={at} title={new Date(at).toLocaleString(locale)}>
        {new Date(at).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
    </div>
  );
}

function MessageItem({
  id,
  located,
  who,
  text,
  at,
  sprintId,
  actions,
}: {
  id: string;
  located: boolean;
  who: string;
  text: string;
  at: string;
  sprintId?: string;
  actions: ThreadActions;
}) {
  if (who === "system") return <p className={styles.systemLine}>{text}</p>;
  return (
    <div
      className={`${styles.message} ${located ? styles.located : ""}`}
      data-research-item={id}
      data-human={who === "human" || undefined}
      tabIndex={-1}
    >
      <div className={who === "human" ? styles.mine : styles.theirs}>
        {who === "human" ? text : <Prose text={text} />}
      </div>
      <MessageActions
        text={text}
        at={at}
        sprintId={sprintId}
        actions={actions}
      />
    </div>
  );
}

/** One thing the system did by itself, said in a quiet line. */
function Notice({ item }: { item: Extract<ThreadItem, { kind: "notice" }> }) {
  const { t } = useI18n();
  const text = (key: string) => String(item.detail[key] ?? "");
  const mb = Number(item.detail.bytes ?? 0) / 1024 ** 2;
  const line =
    item.action === "dataset_fetching"
      ? t("research.notice.fetching", { name: text("name") })
      : item.action === "dataset_ready"
        ? t("research.notice.ready", {
            name: text("name"),
            size: mb >= 1 ? `${mb.toFixed(0)} MB` : "",
            source: text("source"),
          })
        : item.action === "model_changed"
          ? t("research.notice.model", { name: text("name") })
          : item.action === "dataset_failed"
            ? t("research.notice.failed", {
                name: text("name"),
                reason: text("reason"),
              })
            : t("research.notice.paused", { reason: text("reason") });
  return (
    <p className={styles.notice} data-failed={item.failed || undefined}>
      {line}
    </p>
  );
}

function StageMark({ to, note }: { to: string; note: string }) {
  const { t } = useI18n();
  return (
    <div className={styles.stageMark} role="separator">
      <span>
        <strong>{t(`research.stage.${to}` as MessageKey)}</strong>
        {note ? t("research.thread.withNote", { text: note }) : ""}
      </span>
    </div>
  );
}

function PlanCard({
  id,
  plan,
  current,
  approved,
  computes,
  actions,
}: {
  id: string;
  plan: ResearchPlan;
  current: boolean;
  approved: boolean;
  computes: Compute[];
  actions: ThreadActions;
}) {
  const { t } = useI18n();
  const compute = computes.find((c) => c.id === plan.compute_id);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    if (approved) setWhole(false);
  }, [approved]);
  const shownHypotheses = whole ? plan.hypotheses : plan.hypotheses.slice(0, 2);
  // Experiments need the environment ready; say so before the person agrees.
  const unready = !!compute && compute.ready === false;
  return (
    <article
      id={`research-plan-${id}`}
      tabIndex={-1}
      className={styles.card}
      data-faded={(!current && !approved) || undefined}
      aria-label={t("research.plan.title")}
    >
      <header className={styles.cardHead}>
        <FileText size={15} aria-hidden />
        <strong>{t("research.plan.title")}</strong>
        <span>{t("research.plan.version", { n: plan.version })}</span>
        {approved ? (
          <span className={styles.tag} data-tone="good">
            <Check size={12} aria-hidden />
            {t("research.plan.approved")}
          </span>
        ) : !current ? (
          <span className={styles.tag}>{t("research.plan.superseded")}</span>
        ) : (
          <span />
        )}
      </header>
      {(approved || !current) && (
        <button
          type="button"
          className={styles.planCompact}
          aria-expanded={whole}
          onClick={() => setWhole(!whole)}
        >
          <ChevronRight size={14} aria-hidden />
          <span>
            {approved
              ? t("research.plan.compact", { n: plan.hypotheses.length })
              : plan.question || t("research.plan.title")}
          </span>
          <span className={styles.planToggle}>
            {t(whole ? "research.plan.less" : "research.plan.more")}
          </span>
        </button>
      )}
      {((current && !approved) || whole) && (
        <div className={styles.cardBody}>
          {plan.question && (
            <h3
              className={styles.planQuestion}
              data-clamped={!whole || undefined}
            >
              {plan.question}
            </h3>
          )}
          {plan.summary && (
            <div className={styles.summary} data-clamped={!whole || undefined}>
              <Prose text={plan.summary} />
            </div>
          )}
          <dl className={styles.facts} data-clamped={!whole || undefined}>
            {plan.metric && (
              <>
                <dt>{t("research.plan.metric")}</dt>
                <dd>{plan.metric}</dd>
              </>
            )}
            {plan.baseline && (
              <>
                <dt>{t("research.plan.baseline")}</dt>
                <dd>{plan.baseline}</dd>
              </>
            )}
            {plan.goal && (
              <>
                <dt>{t("research.plan.goal")}</dt>
                <dd>{plan.goal}</dd>
              </>
            )}
          </dl>
          <ol className={styles.hyps}>
            {shownHypotheses.map((h, i) => (
              <li key={h.title} className={styles.hyp}>
                <span
                  className={styles.hypTitle}
                  data-clamped={!whole || undefined}
                >
                  {h.title}
                  {i === 0 && plan.hypotheses.length > 1 && (
                    <span className={styles.first}>
                      {t("research.plan.first")}
                    </span>
                  )}
                </span>
                {whole && (
                  <span className={styles.hypKill}>
                    {t("research.plan.killIf", { text: h.kill_if })}
                  </span>
                )}
                {whole && h.value && (
                  <span className={styles.hypKill}>
                    {t("research.plan.value", { text: h.value })}
                  </span>
                )}
                {whole && h.cost && (
                  <span className={styles.hypKill}>
                    {t("research.plan.cost", { text: h.cost })}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {!whole && plan.hypotheses.length > shownHypotheses.length && (
            <p className={styles.planRemaining}>
              {t("research.plan.remaining", {
                n: plan.hypotheses.length - shownHypotheses.length,
              })}
            </p>
          )}
          {current && !approved && (
            <button
              type="button"
              className={styles.more}
              aria-expanded={whole}
              onClick={() => setWhole(!whole)}
            >
              {t(whole ? "research.plan.less" : "research.plan.more")}
            </button>
          )}
          <div className={styles.tags}>
            {plan.datasets.map((name) => (
              <span key={name} className={styles.tag}>
                <Database size={12} aria-hidden />
                {name}
              </span>
            ))}
            <span
              className={styles.tag}
              data-tone={unready && !approved ? "warn" : undefined}
            >
              <Cpu size={12} aria-hidden />
              {compute?.name ?? plan.compute_id}
            </span>
            <span className={styles.tag}>
              <Gauge size={12} aria-hidden />
              {plan.budget?.max_sprints || plan.budget?.max_job_hours
                ? t("research.plan.budget", {
                    sprints: plan.budget.max_sprints ?? "∞",
                    hours: plan.budget.max_job_hours ?? "∞",
                  })
                : t("research.plan.noLimit")}
            </span>
          </div>
        </div>
      )}
      {current && !approved && (
        <footer className={styles.cardFoot}>
          <Button
            variant="primary"
            size="sm"
            loading={actions.busy}
            disabled={!!plan.inherited}
            onClick={() => {
              if (!plan.inherited) actions.approvePlan(plan.version);
            }}
          >
            {t("research.plan.start")}
          </Button>
        </footer>
      )}
    </article>
  );
}

function DecisionCard({
  item,
  actions,
}: {
  item: Extract<ThreadItem, { kind: "decision" }>;
  actions: ThreadActions;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [whole, setWhole] = useState(false);
  const d = item.event.detail as Record<string, string>;
  const long =
    (d.reason || "").length > 320 || (d.reason || "").split("\n").length > 6;
  const workflow = d.kind === "workflow_step";
  const choices = Array.isArray(item.event.detail.choices)
    ? (item.event.detail.choices as { title: string }[])
    : [];
  const conclusion = d.kind === "conclusion";
  const budget = d.kind === "budget";
  // The advisor asks something only the researcher knows; the work goes on meanwhile.
  const question = d.kind === "question";
  return (
    <article
      id={`research-decision-${item.id}`}
      tabIndex={-1}
      className={`${styles.card} ${item.open ? styles.ask : ""}`}
      aria-label={t("research.ask.title")}
    >
      <header className={styles.cardHead}>
        <Mascot
          agent={item.event.actor === "system" ? "system" : "advisor"}
          size={18}
        />
        <strong>
          {workflow
            ? t("workflows.status.waiting")
            : conclusion
              ? t("research.ask.conclusion")
              : budget
                ? t("research.ask.budget")
                : question
                  ? t("research.ask.question")
                  : t("research.ask.title")}
        </strong>
        {conclusion ? (
          <span
            className={styles.tag}
            data-tone={d.status === "refuted" ? "warn" : "good"}
          >
            {t(`research.end.${d.status || "concluded"}` as MessageKey)}
          </span>
        ) : d.proposal && !budget && !question ? (
          <span className={styles.tag}>
            {t(`research.talk.verdict.${d.proposal}` as MessageKey)}
          </span>
        ) : (
          <span />
        )}
      </header>
      <div className={styles.cardBody}>
        <div
          className={styles.summary}
          data-clamped={(long && !whole) || undefined}
        >
          <Prose text={d.reason || ""} />
        </div>
        {long && (
          <button
            type="button"
            className={styles.more}
            aria-expanded={whole}
            onClick={() => setWhole(!whole)}
          >
            {t(whole ? "research.plan.less" : "research.plan.more")}
          </button>
        )}
        {item.open &&
          choices.map((choice, index) => (
            <Button
              key={index}
              size="sm"
              variant={note === choice.title ? "secondary" : "ghost"}
              aria-pressed={note === choice.title}
              onClick={() => setNote(choice.title)}
            >
              {choice.title}
            </Button>
          ))}
        {item.open && (
          <textarea
            className={styles.note}
            rows={question ? 3 : 2}
            value={note}
            aria-label={t("research.ask.note")}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </div>
      <footer className={styles.cardFoot}>
        {item.open && question ? (
          <>
            <Button
              size="sm"
              variant="primary"
              loading={actions.busy}
              disabled={!note.trim()}
              onClick={() => actions.decide(item.id, true, note)}
            >
              {t("research.ask.answer")}
            </Button>
          </>
        ) : item.open ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={actions.busy}
              onClick={() => actions.decide(item.id, false, note)}
            >
              {t(
                workflow
                  ? "workflows.redo"
                  : conclusion
                    ? "research.ask.more"
                    : budget
                      ? "research.ask.budgetStop"
                      : "research.ask.no",
              )}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={actions.busy}
              disabled={!!choices.length && !note.trim()}
              onClick={() => actions.decide(item.id, true, note)}
            >
              {t(
                workflow
                  ? "workflows.continue"
                  : conclusion
                    ? "research.ask.accept"
                    : budget
                      ? "research.ask.budgetMore"
                      : "research.ask.yes",
              )}
            </Button>
          </>
        ) : (
          <span className={styles.answered}>{t("research.ask.answered")}</span>
        )}
      </footer>
    </article>
  );
}

const number = (value: unknown) =>
  typeof value === "number"
    ? Math.abs(value) >= 1000 || Number.isInteger(value)
      ? String(value)
      : value.toPrecision(4)
    : String(value);

/** The numbers worth a glance: the final ones, not the step counter. */
export function headline(metrics: Record<string, unknown>) {
  return Object.entries(metrics)
    .filter(
      ([k, v]) =>
        k !== "step" && (typeof v === "number" || typeof v === "string"),
    )
    .slice(0, 6);
}

export function trackerLink(url: string) {
  return url.startsWith("http") ? url : "";
}

function duration(job: ResearchJob) {
  if (job.status === "queued") return "";
  const end = job.finished_at ? new Date(job.finished_at) : new Date();
  const s = Math.max(0, Math.round((+end - +new Date(job.started_at)) / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m${s % 60}s`
      : `${s}s`;
}

/** How a job stands, in words; a queued one with its place in the queue. */
export function JobState({ job }: { job: ResearchJob }) {
  const { t } = useI18n();
  return job.status === "queued" && job.queue_position
    ? t("research.job.queuedAt", { n: job.queue_position })
    : t(`research.job.${job.status}` as MessageKey);
}

/** One experiment, as one line: how it went, what it is, its number, how long. */
export function RunCard({
  job,
  computes,
  actions,
  compact = false,
}: {
  compact?: boolean;
  job: ResearchJob;
  computes: Compute[];
  actions: ThreadActions;
}) {
  const { t } = useI18n();
  const main = mainMetric(job.metrics ?? {});
  const tag = typeof job.config?.tag === "string" ? job.config.tag : "";
  return (
    <button
      type="button"
      className={styles.runLine}
      data-status={job.status}
      onClick={() => actions.openRun(job.id)}
      title={job.command}
    >
      <span className={styles.status} data-status={job.status}>
        {job.status === "running" ? (
          <Spinner size={14} />
        ) : job.status === "queued" ? (
          <Clock size={13} aria-hidden />
        ) : job.status === "succeeded" ? (
          <Check size={13} aria-hidden />
        ) : (
          <X size={13} aria-hidden />
        )}
      </span>
      <span className={styles.runName}>
        {compact ? plainCommand(job.command) : tag || plainCommand(job.command)}
      </span>
      {main ? (
        <span className={styles.runMain}>
          <span>{main[0]}</span>
          <strong>{main[1].toPrecision(4)}</strong>
        </span>
      ) : job.status !== "running" && job.status !== "succeeded" ? (
        <span className={styles.runMain}>
          <JobState job={job} />
        </span>
      ) : null}
      <span className={styles.workMeta}>
        {computes.find((c) => c.id === job.compute_id)?.name || job.compute_id}
      </span>
      <span className={styles.workMeta}>{duration(job)}</span>
    </button>
  );
}

function WorkBlock({
  item,
  project,
  computes,
  actions,
  run,
}: {
  item: Extract<ThreadItem, { kind: "work" }>;
  project: ResearchProject;
  computes: Compute[];
  actions: ThreadActions;
  run: ResearchRun | undefined;
}) {
  const { t } = useI18n();
  const role = item.sprint.role;

  if (item.sprint.number === 0) {
    // A note by the system between sprints: one line.
    const said = item.steps
      .map((step) => describeStep(t, step))
      .find((x) => x !== null);
    if (!said) return null;
    return (
      <p className={styles.systemLine}>
        {said.label}
        {said.note ? t("research.thread.withNote", { text: said.note }) : ""}
      </p>
    );
  }
  const title = t(
    ["executor", "workflow"].includes(role)
      ? "research.work.executor"
      : role === "distiller"
        ? "research.work.distiller"
        : "research.work.advisor",
    { n: item.sprint.number },
  );
  return (
    <RunTurn
      run={run}
      role={role}
      title={title}
      final={
        item.sprint.status === "running"
          ? ""
          : item.reply || run?.response || item.sprint.summary
      }
      elapsed={Math.max(
        0,
        (Date.parse(item.sprint.updated_at) -
          Date.parse(item.sprint.created_at)) /
          1000,
      )}
      footer={
        item.sprint.status !== "running" && (
          <MessageActions
            text={item.reply || run?.response || item.sprint.summary}
            at={item.replyAt || item.sprint.updated_at}
            sprintId={item.sprint.commit_sha ? item.sprint.id : undefined}
            actions={actions}
          />
        )
      }
    >
      {run?.runtime.rule && project.workspace_id && (
        <a
          className={settingStyles.ruleLink}
          href={`#${ruleHash(project.workspace_id, run.runtime.rule.workflow, run.runtime.rule.workflow_version, run.runtime.rule.rule)}`}
        >
          {run.runtime.rule.rule}
        </a>
      )}
      {item.jobs.map((job) => (
        <RunCard key={job.id} job={job} computes={computes} actions={actions} />
      ))}
      {item.sprint.commit_sha && item.sprint.status !== "running" && (
        <CheckpointCard
          id={project.id}
          sprintId={item.sprint.id}
          refreshKey={project.updated_at + project.status}
          onReview={(path) => actions.review?.(item.sprint.id, path)}
        />
      )}
    </RunTurn>
  );
}
