import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { MessageKey } from "../../../i18n/i18n";
import { Dialog, IconButton, SegmentedControl } from "../../../ui";
import { followLink } from "../../../reader/route";
import {
  jobSeries,
  type Compute,
  type ProjectDetail,
  type ResearchJob,
  type SeriesPoint,
} from "../research-api";
import { useResearchNavigation, ResearchState } from "../ResearchNavigation";
import { ReviewChanges, type ReviewTarget } from "../ReviewChanges";
import type { useChanges } from "../use-changes";
import { WorkflowProgress } from "../../workflows/WorkflowProgress";
import { FileView } from "../files/FileView";
import { FilesPanel } from "../files/FilesPanel";
import { settledKey } from "../files/files-api";
import { plainCommand } from "../process/model";
import { RunCard, trackerLink, type ThreadActions } from "./ThreadView";
import styles from "./Talk.module.css";

export type RecordTab = "progress" | "changes" | "experiments";

export function RecordPanel({
  detail,
  outputFile,
  onOutputFile,
  computes,
  run,
  onRun,
  actions,
  go,
  tab,
  onTab,
  onClose,
  width,
  changes,
  review,
  refreshKey,
}: {
  detail: ProjectDetail;
  outputFile: string;
  onOutputFile(path: string): void;
  computes: Compute[];
  run: string;
  onRun(id: string): void;
  actions: ThreadActions;
  go(hash: string): void;
  tab: RecordTab;
  onTab(tab: RecordTab): void;
  onClose(): void;
  width: number;
  changes: ReturnType<typeof useChanges>;
  review: ReviewTarget;
  refreshKey: string;
}) {
  const { t } = useI18n();
  const { data } = useResearchNavigation();
  const [sources, setSources] = useState(false);
  const p = detail.project;
  const children = data.workspaces
    .flatMap((w) => w.researches)
    .filter((r) => r.parent_id === p.id && !r.archived_at);
  const nodes = detail.nodes.filter((n) => n.parent_id);
  const selected = detail.jobs.find((j) => j.id === run);
  const panelId = (value: RecordTab) => `research-record-${p.id}-${value}`;
  return (
    <aside
      className={styles.record}
      style={{ "--panel-width": `${width}px` } as CSSProperties}
      aria-label={t("research.record.title")}
    >
      <header className={styles.recordHead}>
        <SegmentedControl
          kind="tabs"
          size="sm"
          label={t("research.record.title")}
          value={tab}
          onChange={(value) => {
            onOutputFile("");
            onTab(value);
          }}
          options={[
            {
              value: "progress",
              label: t("research.record.progress"),
              panelId: panelId("progress"),
            },
            {
              value: "changes",
              label: t("research.panel.changes"),
              panelId: panelId("changes"),
            },
            {
              value: "experiments",
              label: t("research.record.runs"),
              panelId: panelId("experiments"),
            },
          ]}
        />
        <IconButton
          icon={X}
          size="sm"
          className={styles.recordClose}
          label={t("common.close")}
          onClick={onClose}
        />
      </header>
      <div
        className={styles.recordPane}
        role="tabpanel"
        id={panelId(tab)}
        aria-labelledby={`${panelId(tab)}-tab`}
      >
        {outputFile ? (
          <FileView
            projectId={p.id}
            path={outputFile}
            settled={p.updated_at}
            onBack={() => onOutputFile("")}
            actions={null}
          />
        ) : tab === "changes" ? (
          <ReviewChanges
            detail={detail}
            total={changes}
            target={review}
            refreshKey={refreshKey}
            onReview={(sprintId) => actions.review?.(sprintId)}
            onOpen={onOutputFile}
            onChanged={() => actions.changed?.()}
          />
        ) : tab === "experiments" ? (
          <div className={`${styles.recordBody} ${styles.experiments}`}>
            {detail.jobs.map((job) => (
              <RunCard
                compact
                key={job.id}
                job={job}
                computes={computes}
                actions={actions}
              />
            ))}
            {!detail.jobs.length && (
              <p className={styles.empty}>{t("research.record.noRuns")}</p>
            )}
          </div>
        ) : (
          <div className={styles.recordBody}>
            {p.workflow && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t("workflows.title")}</h3>
                <WorkflowProgress workflow={p.workflow} />
              </section>
            )}
            {(!!p.plan?.hypotheses?.length || !!nodes.length) && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>
                  {t("research.record.plan")}
                </h3>
                {nodes.length
                  ? nodes.map((node) => (
                      <div key={node.id} className={styles.nodeRow}>
                        <span>{node.title}</span>
                        <small>
                          {t(`research.node.${node.status}` as MessageKey)}
                        </small>
                      </div>
                    ))
                  : p.plan.hypotheses.map((h) => (
                      <div key={h.title} className={styles.nodeRow}>
                        {h.title}
                      </div>
                    ))}
              </section>
            )}
            {p.conclusion_record?.summary && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>
                  {t("research.ask.conclusion")}
                </h3>
                <p>{p.conclusion_record.summary}</p>
              </section>
            )}
            {!!children.length && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>
                  {t("research.panel.children")}
                  <span>
                    {t("research.panel.completed", {
                      n: children.filter((r) => r.status === "finished").length,
                    })}
                  </span>
                </h3>
                {children.map((r) => (
                  <a
                    key={r.id}
                    className={styles.childResearch}
                    href={`#research/${r.id}`}
                    onClick={followLink(go, `research/${r.id}`)}
                  >
                    <span>{r.title || r.question}</span>
                    <ResearchState research={r} />
                  </a>
                ))}
              </section>
            )}
            {!!detail.datasets.length && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>
                  {t("research.panel.sources")}
                  <IconButton
                    icon={Plus}
                    label={t("research.attach")}
                    size="sm"
                    onClick={() => setSources(true)}
                  />
                </h3>
                {detail.datasets.map((source) => (
                  <div key={source.id} className={styles.nodeRow}>
                    <span>{source.name}</span>
                    <small>
                      {t(`research.data.${source.status}` as MessageKey)}
                    </small>
                    {source.files.map((file) => (
                      <small key={file.name}>{file.name}</small>
                    ))}
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
      <Dialog
        open={sources}
        title={t("research.panel.sources")}
        onClose={() => setSources(false)}
        size="lg"
      >
        <FilesPanel
          projectId={p.id}
          settled={settledKey(detail.sprints, detail.jobs)}
        />
      </Dialog>
      <Dialog
        open={!!selected}
        title={t("research.record.run")}
        onClose={() => onRun("")}
        size="lg"
      >
        {selected && (
          <RunDetail projectId={p.id} job={selected} actions={actions} />
        )}
      </Dialog>
    </aside>
  );
}

function RunDetail({
  projectId,
  job,
  actions,
}: {
  projectId: string;
  job: ResearchJob;
  actions: ThreadActions;
}) {
  const { t } = useI18n();
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [metric, setMetric] = useState("");
  useEffect(() => {
    if (!job.points) {
      setSeries([]);
      return;
    }
    jobSeries(projectId, job.id).then(setSeries, () => setSeries([]));
  }, [projectId, job.id, job.points]);
  const keys = useMemo(() => {
    const out = new Set<string>();
    for (const row of series)
      for (const [k, v] of Object.entries(row))
        if (k !== "step" && k !== "t" && typeof v === "number") out.add(k);
    return [...out];
  }, [series]);
  const shown = keys.includes(metric) ? metric : (keys[0] ?? "");
  const tracker = trackerLink(job.tracker_url ?? "");
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t("research.record.run")}</h3>
      <code className={styles.mono} title={job.command}>
        {plainCommand(job.command)}
      </code>
      {shown && (
        <div className={styles.chart}>
          <div className={styles.tags}>
            {keys.map((k) => (
              <button
                key={k}
                type="button"
                className={styles.chip}
                aria-pressed={k === shown}
                onClick={() => setMetric(k)}
              >
                {k}
              </button>
            ))}
          </div>
          <Curve
            points={series
              .map((r) => r[shown])
              .filter((v): v is number => typeof v === "number")}
          />
        </div>
      )}
      {Object.keys(job.config ?? {}).length > 0 && (
        <dl className={styles.kv}>
          {Object.entries(job.config).map(([k, v]) => (
            <Fragment key={k} k={k} v={String(v)} />
          ))}
        </dl>
      )}
      <div className={styles.runFoot}>
        <button
          type="button"
          className={styles.link}
          onClick={() => actions.openLog(job.id)}
        >
          {t("research.run.log")}
        </button>
        {tracker ? (
          <a
            className={styles.link}
            href={tracker}
            target="_blank"
            rel="noreferrer"
          >
            {t("research.run.tracker")}
          </a>
        ) : job.tracker_url.startsWith("local:") ? (
          <span title={job.tracker_url.slice(6)}>
            {t("research.run.trackerLocal")}
          </span>
        ) : job.tracker_url.startsWith("error") ? (
          <span title={job.tracker_url}>{t("research.run.trackerError")}</span>
        ) : null}
      </div>
    </section>
  );
}

function Fragment({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={styles.mono}>{v}</dd>
    </>
  );
}

/** A metric over its steps: one line, its lowest and highest values marked. */
function Curve({ points }: { points: number[] }) {
  if (points.length < 2)
    return <p className={styles.empty}>{points.length ? points[0] : ""}</p>;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  const xy = points.map(
    (v, i) =>
      [(i / (points.length - 1)) * 100, 100 - ((v - lo) / span) * 100] as const,
  );
  const line = xy.map(([x, y]) => `${x},${y}`).join(" ");
  return (
    <>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${lo} – ${hi}`}
      >
        <polygon
          className={styles.chartArea}
          points={`0,100 ${line} 100,100`}
        />
        <polyline className={styles.chartLine} points={line} />
      </svg>
      <div className={styles.chartAxis}>
        <span>{lo.toPrecision(4)}</span>
        <span>{points[points.length - 1].toPrecision(4)}</span>
        <span>{hi.toPrecision(4)}</span>
      </div>
    </>
  );
}
