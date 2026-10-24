import {
  ArrowUpRight,
  Clock3,
  FileText,
  FlaskConical,
  Moon,
  MoreHorizontal,
  Search,
  Newspaper,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { sidebarId } from "../../app/sidebar-entries";
import { useI18n } from "../../i18n/I18nProvider";
import { followLink } from "../../reader/route";
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  TextArea,
  TextField,
} from "../../ui";
import { useResearchNavigation } from "../research/ResearchNavigation";
import { refreshResearchNavigation } from "../research/navigation-api";
import {
  createSchedule,
  deleteSchedule,
  readSchedule,
  readSchedules,
  refreshSchedules,
  runSchedule,
  SCHEDULES_CHANGED,
  updateSchedule,
  type Schedule,
  type ScheduleDetail,
  type ScheduleInput,
} from "./schedules-api";
import { WorkflowPicker } from "../workflows/WorkflowPicker";
import { frequencyLabel, nextLabel, weekdays } from "./schedule-time";
import styles from "./ScheduleCenter.module.css";
import layout from "../Management.module.css";

const TEMPLATES = ["papers", "weekly", "experiments", "night"] as const;
const ICONS = {
  papers: Newspaper,
  weekly: FileText,
  experiments: FlaskConical,
  night: Moon,
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function useSchedules() {
  const [items, setItems] = useState<Schedule[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      readSchedules()
        .then((data) => {
          if (!cancelled) {
            setItems(data);
            setReady(true);
            setError("");
          }
        })
        .catch((reason: unknown) => !cancelled && setError(errorText(reason)));
    };
    load();
    const timer = window.setInterval(load, 15000);
    window.addEventListener(SCHEDULES_CHANGED, load);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(SCHEDULES_CHANGED, load);
      window.removeEventListener("focus", load);
    };
  }, [reads]);
  return { items, ready, error, retry: () => setReads((n) => n + 1) };
}

export function ScheduleNavigation({
  currentId,
  go,
}: {
  currentId?: string;
  go(hash: string): void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { items, ready, error, retry } = useSchedules();
  return (
    <nav className={styles.navigation} aria-label={t("schedules.title")}>
      <div className={styles.navigationHeading}>{t("schedules.upcoming")}</div>
      {!ready && !error && (
        <div className={styles.skeleton} aria-label={t("common.loading")} />
      )}
      {error && (
        <Button variant="ghost" size="sm" title={error} onClick={retry}>
          {t("common.retry")}
        </Button>
      )}
      <div className={styles.tasks}>
        {items.map((item) => (
          <a
            key={item.id}
            data-id={sidebarId("task")}
            href={`#${item.editor_url || `schedules/${item.id}`}`}
            onClick={followLink(go, item.editor_url || `schedules/${item.id}`)}
            aria-current={currentId === item.id ? "page" : undefined}
          >
            <span>{item.title}</span>
            <small>
              {item.paused
                ? t("schedules.pausedAt", {
                    frequency: frequencyLabel(item, i18n),
                  })
                : t("schedules.nextAt", {
                    time: nextLabel(item.next_run_at, item.timezone, i18n),
                  })}
            </small>
          </a>
        ))}
      </div>
    </nav>
  );
}

export function ScheduleCenter({
  id,
  template,
  go,
}: {
  id?: string;
  template?: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  return (
    <section className={styles.page} aria-label={t("schedules.title")}>
      {id ? (
        <ScheduleEditor
          key={`${id}:${template || ""}`}
          id={id}
          template={template}
          go={go}
        />
      ) : (
        <ScheduleList go={go} />
      )}
    </section>
  );
}

function ScheduleList({ go }: { go(hash: string): void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { items, ready, error, retry } = useSchedules();
  const [query, setQuery] = useState("");
  const shown = items.filter((item) =>
    item.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className={layout.content}>
      <header className={layout.header}>
        <h1 className={layout.heading}>{t("schedules.title")}</h1>
        <div className={layout.actions}>
          <label className={layout.search}>
            <Search size={16} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("customize.search")}
              aria-label={t("customize.search")}
            />
          </label>
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => go("schedules/new")}
          >
            {t("schedules.new")}
          </Button>
        </div>
      </header>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
          <Button onClick={retry}>{t("common.retry")}</Button>
        </div>
      ) : !ready ? (
        <div
          className={layout.skeleton}
          role="status"
          aria-label={t("common.loading")}
        />
      ) : items.length ? (
        <ul className={styles.list}>
          {shown.map((item) => (
            <li key={item.id}>
              <Clock3 size={16} aria-hidden />
              <a
                href={`#${item.editor_url || `schedules/${item.id}`}`}
                onClick={followLink(
                  go,
                  item.editor_url || `schedules/${item.id}`,
                )}
              >
                {item.title}
              </a>
              <span className={styles.status}>
                {item.paused
                  ? t("schedules.paused")
                  : t("schedules.nextAt", {
                      time: nextLabel(item.next_run_at, item.timezone, i18n),
                    })}
              </span>
            </li>
          ))}
          {!shown.length && (
            <li className={styles.empty}>{t("customize.empty")}</li>
          )}
        </ul>
      ) : query ? (
        <div className={styles.empty}>{t("customize.empty")}</div>
      ) : (
        <>
          <div className={styles.landing}>
            <Clock3 size={32} aria-hidden />
            <p>{t("schedules.arrange")}</p>
          </div>
          <div className={styles.suggestions}>
            {TEMPLATES.map((name) => {
              const Icon = ICONS[name];
              return (
                <button
                  key={name}
                  onClick={() => go(`schedules/new?template=${name}`)}
                >
                  <Icon size={16} aria-hidden />
                  <span>{t(`schedules.template.${name}`)}</span>
                  <ArrowUpRight size={16} aria-hidden />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ScheduleEditor({
  id,
  template,
  go,
}: {
  id: string;
  template?: string;
  go(hash: string): void;
}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { data, ready: projectsReady } = useResearchNavigation();
  const projects = data.workspaces.filter((project) => !project.archived);
  const [detail, setDetail] = useState<ScheduleDetail>();
  const [draft, setDraft] = useState<ScheduleInput | null>(() => {
    if (id !== "new") return null;
    const name = TEMPLATES.find((name) => name === template);
    return {
      title: name ? t(`schedules.template.${name}`) : "",
      prompt: name ? t(`schedules.prompt.${name}`) : "",
      workspace_id: projects[0]?.id || "",
      destination: "new",
      workflow_id: "research",
      research_id: null,
      frequency:
        name === "weekly"
          ? "weekly"
          : name === "experiments"
            ? "interval"
            : "daily",
      local_time:
        name === "night" ? "02:00" : name === "weekly" ? "17:00" : "09:00",
      weekday: 4,
      interval_hours: 4,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      paused: false,
    };
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (id === "new") return;
    let cancelled = false;
    readSchedule(id)
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
        setDraft(value);
        setError("");
      })
      .catch((reason: unknown) => !cancelled && setError(errorText(reason)));
    return () => {
      cancelled = true;
    };
  }, [id, reads]);
  useEffect(() => {
    if (id !== "new") return;
    const first = projects[0]?.id;
    if (first)
      setDraft((old) =>
        old && !old.workspace_id ? { ...old, workspace_id: first } : old,
      );
  }, [id, projects[0]?.id]);
  useEffect(() => {
    if (id === "new") return;
    let cancelled = false;
    const refresh = () => {
      if (!document.hidden)
        readSchedule(id)
          .then((value) => !cancelled && setDetail(value))
          .catch(() => {});
    };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [id]);
  const edit = <K extends keyof ScheduleInput>(
    key: K,
    value: ScheduleInput[K],
  ) => setDraft((old) => old && { ...old, [key]: value });
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (!draft) return;
      const body: ScheduleInput = {
        title: draft.title,
        prompt: draft.prompt,
        workspace_id: draft.workspace_id,
        destination: draft.destination,
        workflow_id: draft.workflow_id || "research",
        research_id: draft.research_id,
        frequency: draft.frequency,
        local_time: draft.local_time,
        weekday: draft.weekday,
        interval_hours: draft.interval_hours,
        timezone: draft.timezone,
        paused: draft.paused,
      };
      if (id === "new") {
        const value = await createSchedule(body);
        refreshSchedules();
        go(`schedules/${value.id}`);
      } else {
        const value = await updateSchedule(id, body);
        setDetail(value);
        setDraft(value);
        refreshSchedules();
      }
    });
  const workspace = projects.find(
    (project) => project.id === draft?.workspace_id,
  );
  const conversations = workspace?.researches.filter(
    (research) => !("archived_at" in research && research.archived_at),
  );
  return (
    <div className={styles.content}>
      <header className={layout.header}>
        <div className={styles.heading}>
          <h1 className={layout.heading}>
            {detail?.title ||
              t(id === "new" ? "schedules.new" : "schedules.title")}
          </h1>
          {detail && (
            <span className={styles.status}>
              {detail.paused
                ? t("schedules.paused")
                : t("schedules.nextAt", {
                    time: nextLabel(detail.next_run_at, detail.timezone, i18n),
                  })}
            </span>
          )}
        </div>
        <div className={layout.actions}>
          {detail && (
            <Menu
              label={t("reader.more.menu")}
              placement={{ side: "bottom", align: "end" }}
              items={[
                {
                  id: "run",
                  icon: Play,
                  label: t("schedules.run"),
                  disabled: busy,
                  onSelect: () =>
                    void act(async () => {
                      await runSchedule(id);
                      setDetail(await readSchedule(id));
                      refreshSchedules();
                      refreshResearchNavigation();
                    }),
                },
                {
                  id: "pause",
                  icon: detail.paused ? Play : Pause,
                  label: t(
                    detail.paused ? "schedules.resume" : "schedules.pause",
                  ),
                  disabled: busy,
                  onSelect: () =>
                    void act(async () => {
                      const value = await updateSchedule(id, {
                        paused: !detail.paused,
                      });
                      setDetail(value);
                      edit("paused", value.paused);
                      refreshSchedules();
                    }),
                },
                { kind: "separator", id: "delete-divider" },
                {
                  id: "delete",
                  icon: Trash2,
                  label: t("schedules.delete"),
                  danger: true,
                  disabled: busy,
                  onSelect: () => setDeleting(true),
                },
              ]}
              trigger={(props) => (
                <IconButton
                  {...props}
                  icon={MoreHorizontal}
                  label={t("reader.more.menu")}
                />
              )}
            />
          )}
          <Button
            type="submit"
            form="schedule-form"
            variant="primary"
            loading={busy}
            disabled={!draft || !projectsReady || !draft.workspace_id}
          >
            {t(id === "new" ? "schedules.create" : "schedules.save")}
          </Button>
        </div>
      </header>
      {error && (
        <div className={styles.error} role="alert">
          {error}
          {!draft && (
            <Button variant="ghost" onClick={() => setReads((n) => n + 1)}>
              {t("common.retry")}
            </Button>
          )}
        </div>
      )}
      {!draft && !error && (
        <div className={styles.formSkeleton} aria-label={t("common.loading")}>
          <div />
          <div />
          <div />
        </div>
      )}
      {draft && (
        <>
          <form
            id="schedule-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset className={styles.form} disabled={busy}>
              <TextField
                label={t("schedules.name")}
                value={draft.title}
                required
                maxLength={200}
                onChange={(event) => edit("title", event.target.value)}
              />
              <TextArea
                label={t("schedules.prompt")}
                value={draft.prompt}
                rows={5}
                required
                maxLength={8000}
                onChange={(event) => edit("prompt", event.target.value)}
              />
              <label className={styles.field}>
                <span>{t("schedules.project")}</span>
                <select
                  value={draft.workspace_id}
                  required
                  disabled={!projectsReady}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      workspace_id: event.target.value,
                      research_id: null,
                    })
                  }
                >
                  <option value="" disabled>
                    {t("schedules.project")}
                  </option>
                  {draft.workspace_id && !workspace && (
                    <option value={draft.workspace_id} disabled>
                      {t("schedules.unavailable")}
                    </option>
                  )}
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>{t("schedules.destination")}</span>
                <select
                  value={draft.destination}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      destination: event.target
                        .value as ScheduleInput["destination"],
                      research_id: null,
                    })
                  }
                >
                  <option value="new">{t("schedules.destination.new")}</option>
                  <option value="existing">
                    {t("schedules.destination.existing")}
                  </option>
                </select>
              </label>
              {draft.destination === "new" && (
                <div>
                  <WorkflowPicker
                    workspaceId={draft.workspace_id}
                    value={draft.workflow_id || "research"}
                    onChange={(value) => edit("workflow_id", value)}
                    disabled={busy}
                  />
                </div>
              )}
              {draft.destination === "existing" && (
                <label className={styles.field}>
                  <span>{t("schedules.conversation")}</span>
                  <select
                    value={draft.research_id || ""}
                    required
                    onChange={(event) =>
                      edit("research_id", event.target.value)
                    }
                  >
                    <option value="" disabled>
                      {t("schedules.conversation")}
                    </option>
                    {draft.research_id &&
                      !conversations?.some(
                        (research) => research.id === draft.research_id,
                      ) && (
                        <option value={draft.research_id} disabled>
                          {t("schedules.unavailable")}
                        </option>
                      )}
                    {conversations?.map((research) => (
                      <option key={research.id} value={research.id}>
                        {research.title || research.question}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className={styles.timing}>
                <label className={styles.field}>
                  <span>{t("schedules.frequency")}</span>
                  <select
                    value={draft.frequency}
                    onChange={(event) =>
                      edit(
                        "frequency",
                        event.target.value as ScheduleInput["frequency"],
                      )
                    }
                  >
                    <option value="daily">{t("schedules.daily")}</option>
                    <option value="weekly">{t("schedules.weekly")}</option>
                    <option value="interval">{t("schedules.interval")}</option>
                  </select>
                </label>
                {draft.frequency === "weekly" && (
                  <label className={styles.field}>
                    <span>{t("schedules.weekday")}</span>
                    <select
                      value={draft.weekday}
                      onChange={(event) =>
                        edit("weekday", Number(event.target.value))
                      }
                    >
                      {weekdays(locale).map((day, index) => (
                        <option key={day} value={index}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {draft.frequency === "interval" ? (
                  <TextField
                    label={t("schedules.hours")}
                    type="number"
                    min={1}
                    max={8760}
                    required
                    value={draft.interval_hours}
                    onChange={(event) =>
                      edit("interval_hours", Number(event.target.value))
                    }
                  />
                ) : (
                  <TextField
                    label={t("schedules.time")}
                    type="time"
                    required
                    value={draft.local_time}
                    onChange={(event) => edit("local_time", event.target.value)}
                  />
                )}
              </div>
              <TextField
                label={t("schedules.timezone")}
                value={draft.timezone}
                required
                maxLength={100}
                onChange={(event) => edit("timezone", event.target.value)}
              />
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={draft.paused}
                  onChange={(event) => edit("paused", event.target.checked)}
                />
                {t("schedules.paused")}
              </label>
              <div className={styles.save}>
                <Button variant="ghost" onClick={() => go("schedules")}>
                  {t("common.cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
          {detail && (
            <section
              className={styles.history}
              aria-labelledby="schedule-history"
            >
              <h2 id="schedule-history">{t("schedules.history")}</h2>
              {!detail.runs.length && (
                <span className={styles.status}>{t("schedules.noRuns")}</span>
              )}
              {detail.runs.map((run) => (
                <div key={run.id} className={styles.run}>
                  <div>
                    <time dateTime={run.started_at}>
                      {new Intl.DateTimeFormat(locale, {
                        timeZone: detail.timezone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(run.started_at))}
                    </time>
                    <span data-failed={run.status === "failed" || undefined}>
                      {t(`schedules.result.${run.status}`)}
                    </span>
                  </div>
                  {run.error && <p className={styles.error}>{run.error}</p>}
                  {run.research_id && (
                    <a
                      href={
                        run.conversation_url || `#research/${run.research_id}`
                      }
                      onClick={followLink(go, `research/${run.research_id}`)}
                    >
                      {t("schedules.openConversation")}
                      <ArrowUpRight size={13} aria-hidden />
                    </a>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      )}
      <Dialog
        open={deleting}
        title={t("schedules.deleteTitle")}
        onClose={() => !busy && setDeleting(false)}
        footer={
          <>
            <Button disabled={busy} onClick={() => setDeleting(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void act(async () => {
                  await deleteSchedule(id);
                  refreshSchedules();
                  go("schedules");
                })
              }
            >
              {t("schedules.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
