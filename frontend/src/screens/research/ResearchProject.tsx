import {
  ArrowLeft,
  Folder,
  Plus,
  Pencil,
  GitFork,
  Archive,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Square,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  Resizer,
  useResizableWidth,
  TextArea,
  TextField,
  toast,
} from "../../ui";
import {
  controlChat,
  approvePlan,
  decide,
  getProject,
  jobLog,
  listEvents,
  listRuns,
  restateQuestion,
  moveCompute,
  moveModel,
  pauseProject,
  reportUrl,
  readResearchSettings,
  resumeProject,
  sendMessage,
  stopProject,
  updateChatSession,
  markResearchRead,
  type Compute,
  type LogLines,
  type ProjectDetail,
  type ResearchEvent,
} from "./research-api";
import { isLive, type ResearchRun } from "./process/model";
import { LiveCard } from "./process/Process";
import { JumpToLatest } from "../../reader/JumpToLatest";
import { OPEN_FILES_EVENT } from "./files/files-api";
import type { SlashCommand } from "../../lib/slash";
import { readModels, type ModelRow } from "../setup/model-api";
import { copyCommand, modelCommands } from "../../lib/composer-commands";
import { Composer } from "./talk/Composer";
import { ModelPicker } from "./talk/Pickers";
import { RecordPanel, type RecordTab } from "./talk/RecordPanel";
import { ChangeNumbers } from "./ChangeCards";
import { useChanges } from "./use-changes";
import type { ReviewTarget } from "./ReviewChanges";
import { PANEL_DEFAULT, PANEL_MIN, panelMax } from "../../reader/PanelResizer";
import { buildThread, working } from "./talk/thread";
import { ThreadView, type ThreadActions } from "./talk/ThreadView";
import { ForkDialog, ResearchOrigin } from "./ResearchChanges";
import { AppActions } from "../../app/AppSidebar";
import { organizeResearch } from "./navigation-api";
import { FilesPanel } from "./files/FilesPanel";
import { settledKey } from "./files/files-api";
import { refreshResearchNavigation } from "./navigation-api";
import styles from "./talk/Talk.module.css";

const ACTIVE_POLL = 2500;
const IDLE_POLL = 12000;

function readRecord(key: string): { open: boolean; tab: RecordTab } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    return {
      open: saved?.open === true,
      tab: ["progress", "changes", "experiments"].includes(saved?.tab)
        ? saved.tab
        : "progress",
    };
  } catch {
    return { open: false, tab: "progress" };
  }
}

/**
 * One research project as a conversation with the advisor: the plan is talked
 * through, then the work and the decisions it needs come down the same thread.
 * The record (plan, runs, environment, answer) stays beside it.
 */
export function ResearchProject({
  id,
  go,
  backHash,
  embedded = false,
  locateId,
}: {
  id: string;
  go(hash: string): void;
  backHash?: string;
  embedded?: boolean;
  locateId?: string;
}) {
  const { t, locale } = useI18n();
  const { owner } = useContext(AppActions);
  const draftKey = `ora-research-draft:${owner || "local"}:${id}`;
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsKnown, setModelsKnown] = useState(false);
  useEffect(() => {
    readModels().then(
      (s) => {
        setModels(s.models);
        setModelsKnown(true);
      },
      () => setModels([]),
    );
  }, []);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [computes, setComputes] = useState<Compute[]>([]);
  const [failed, setFailed] = useState("");
  const [reads, setReads] = useState(0);
  const [rounds, setRounds] = useState(0);
  const [text, setText] = useState("");
  useEffect(() => {
    try {
      setText(localStorage.getItem(draftKey) || "");
    } catch {
      setText("");
    }
  }, [draftKey]);
  const changeText = (value: string) => {
    setText(value);
    try {
      value
        ? localStorage.setItem(draftKey, value)
        : localStorage.removeItem(draftKey);
    } catch {
      /* Private browsing can disable storage. */
    }
  };
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState("");
  const recordKey = `ora-research-record:${owner || "local"}:${id}`;
  const [recordState, setRecordState] = useState(() => readRecord(recordKey));
  const record = recordState.open;
  const recordTab = recordState.tab;
  const updateRecord = (open: boolean, tab = recordTab) => {
    const value = { open, tab };
    setRecordState(value);
    try {
      localStorage.setItem(recordKey, JSON.stringify(value));
    } catch {
      /* Storage can be disabled. */
    }
  };
  useEffect(() => setRecordState(readRecord(recordKey)), [recordKey]);
  const sizing = useResizableWidth({
    key: `ora-research-record-width:${owner || "local"}:${id}`,
    fallback: PANEL_DEFAULT,
    min: PANEL_MIN,
    maxFor: panelMax,
  });
  const [review, setReview] = useState<ReviewTarget>({
    sprintId: "",
    request: 0,
  });
  const refreshKey = `${detail?.project.updated_at}:${detail?.project.status}:${reads}`;
  const changes = useChanges(detail?.project.id || "", refreshKey);
  const [outputFile, setOutputFile] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [forking, setForking] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState("");
  const [run, setRun] = useState("");
  const [log, setLog] = useState<{ jobId: string; lines: LogLines } | null>(
    null,
  );
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [editing, setEditing] = useState<{
    question: string;
    note: string;
  } | null>(null);
  const runsBySprint = useMemo(
    () =>
      new Map(runs.filter((r) => r.sprint_id).map((r) => [r.sprint_id!, r])),
    [runs],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const located = useRef("");

  useEffect(() => {
    setReview({ sprintId: "", request: 0 });
    setOutputFile("");
    setFilesOpen(false);
    setRun("");
  }, [id]);

  // The /files command, or anything else, asks for the files panel.
  useEffect(() => {
    const show = () => {
      setFilesOpen(true);
    };
    window.addEventListener(OPEN_FILES_EVENT, show);
    return () => window.removeEventListener(OPEN_FILES_EVENT, show);
  }, []);

  useEffect(() => {
    readResearchSettings().then(
      (s) => setComputes(s.computes),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getProject(id, controller.signal),
      listEvents(id),
      listRuns(id),
    ]).then(
      ([value, rows, recent]) => {
        if (controller.signal.aborted) return;
        setDetail(value);
        setEvents(rows);
        setRuns(recent);
        setFailed("");
        if (!document.hidden && rows.length)
          void markResearchRead(id, rows[rows.length - 1].id).then(
            refreshResearchNavigation,
            () => undefined,
          );
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailed(error instanceof Error ? error.message : String(error));
      },
    );
    return () => controller.abort();
  }, [id, reads]);

  const active =
    !!detail &&
    (detail.project.status === "active" || !!working(detail.sprints));
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        document.hidden ? setRounds((n) => n + 1) : setReads((n) => n + 1),
      active ? ACTIVE_POLL : IDLE_POLL,
    );
    return () => window.clearTimeout(timer);
  }, [active, reads, rounds]);

  const items = useMemo(
    () =>
      detail
        ? buildThread(
            events,
            detail.sprints,
            detail.jobs,
            detail.nodes,
            detail.project.stage,
            detail.project.plan,
          )
        : [],
    [events, detail],
  );

  // Follow the conversation down, unless the reader scrolled up to look back.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items.length, pending, detail?.sprints, runs]);

  const locatedItem = items.some((item) => item.id === locateId)
    ? locateId
    : events.find((event) => event.id === locateId)?.sprint_id;
  useLayoutEffect(() => {
    if (!locatedItem || located.current === locatedItem) return;
    const row = [
      ...(scroller.current?.querySelectorAll<HTMLElement>(
        "[data-research-item]",
      ) || []),
    ].find((element) => element.dataset.researchItem === locatedItem);
    if (!row) return;
    pinned.current = false;
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
    located.current = locatedItem;
  }, [locatedItem, items]);

  const fail = (error: unknown) =>
    toast.show({
      message: error instanceof Error ? error.message : String(error),
      tone: "error",
    });

  const refresh = () => setReads((n) => n + 1);

  const say = async () => {
    const words = text.trim();
    if (!words) return;
    setPending(words);
    changeText("");
    pinned.current = true;
    try {
      if (modelId && modelId !== detail?.project.model_config_id)
        await moveModel(id, modelId);
      await sendMessage(id, words);
      refreshResearchNavigation();
      refresh();
    } catch (error) {
      changeText(words);
      fail(error);
    } finally {
      setPending("");
    }
  };

  const openReview = (sprintId = "", path?: string) => {
    setReview((old) => ({ sprintId, path, request: old.request + 1 }));
    setOutputFile("");
    updateRecord(true, "changes");
  };
  const actions: ThreadActions = {
    review: openReview,
    busy,
    openOutput: (path) => {
      setOutputFile(path);
      updateRecord(true);
    },
    fork: (sprintId) => {
      setRerunning(false);
      setForking(sprintId || "");
    },
    changed: refresh,
    approvePlan: async (version) => {
      setBusy(true);
      try {
        await approvePlan(id, version);
        refresh();
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
    },
    decide: async (requestId, approve, note) => {
      setBusy(true);
      try {
        await decide(id, requestId, approve, note);
        refresh();
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
    },
    openLog: async (jobId) => {
      try {
        setLog({ jobId, lines: await jobLog(id, jobId) });
      } catch (error) {
        fail(error);
      }
    },
    moveCompute: async (computeId) => {
      try {
        await moveCompute(id, computeId);
        refresh();
      } catch (error) {
        fail(error);
      }
    },
    openRun: (jobId) => {
      setRun(jobId);
      updateRecord(true, "experiments");
    },
  };

  const move = useCallback(
    async (action: typeof pauseProject) => {
      try {
        await action(id);
        refresh();
      } catch (error) {
        fail(error);
      }
    },
    [id],
  );
  const chooseModel = async (modelId: string) => {
    try {
      await moveModel(id, modelId);
      refresh();
    } catch (error) {
      fail(error);
    }
  };

  if (!detail)
    return (
      <div className={styles.page}>
        <div className={styles.head}>
          <IconButton
            icon={ArrowLeft}
            label={t("research.back")}
            size="sm"
            onClick={() => go(backHash || "new")}
          />
        </div>
        <div className={styles.thread}>
          {failed ? (
            <p className={styles.empty} role="alert">
              {failed}
            </p>
          ) : (
            <div
              className={styles.threadSkeleton}
              role="status"
              aria-label={t("common.loading")}
            >
              <div />
              <div />
              <div />
              <div />
            </div>
          )}
        </div>
      </div>
    );

  const pinnedItems = embedded
    ? [
        ...items.filter((item) => item.kind === "plan").slice(-1),
        ...items
          .filter(
            (item) =>
              item.kind === "decision" &&
              item.event.detail.kind === "conclusion",
          )
          .slice(-1),
      ]
    : [];
  const pinnedIds = new Set(pinnedItems.map((item) => item.id));
  const p = detail.project;
  const busyNow = working(detail.sprints);
  const candidateRun = busyNow ? runsBySprint.get(busyNow.id) : undefined;
  const liveRun =
    candidateRun && isLive(candidateRun) ? candidateRun : undefined;
  const waitingData = detail.datasets.some((d) => d.status === "pending");
  // How far the download has got, as the worker last wrote it down.
  const fetchNote =
    detail.datasets.find((d) => d.status === "pending" && d.note)?.note ?? "";
  const finished = p.status === "finished" && p.stage === "done";
  const modelId =
    models.find((model) => model.id === p.model_config_id)?.id ||
    models[0]?.id ||
    "";
  // What "/" offers on a research: how it runs, its report, its model.
  const commands: SlashCommand[] = [
    ...(p.status === "paused"
      ? [
          {
            name: "resume",
            description: t("research.resume"),
            run: () => move(resumeProject),
          },
        ]
      : p.status === "active"
        ? [
            {
              name: "pause",
              description: t("research.pause"),
              run: () => move(pauseProject),
            },
          ]
        : []),
    ...(p.status !== "finished"
      ? [
          {
            name: "stop",
            description: t("research.stop"),
            run: () => move(stopProject),
          },
        ]
      : []),
    {
      name: "files",
      description: t("commands.files"),
      run: () => {
        setFilesOpen(true);
      },
    },
    ...(p.status !== "finished"
      ? [
          {
            name: "question",
            description: t("commands.question"),
            takesArgument: true,
            run: (words: string) =>
              setEditing({ question: words || p.question, note: "" }),
          },
        ]
      : []),
    {
      name: "report",
      description: t("commands.report"),
      run: () => void window.open(reportUrl(id, locale === "zh" ? "zh" : "en")),
    },
    copyCommand(t, () => {
      const said = [...events]
        .reverse()
        .find((e) => e.actor === "advisor" && e.action === "message");
      return typeof said?.detail.text === "string" ? said.detail.text : "";
    }),
    // A finished research has no next round to change the model of.
    ...(finished ? [] : modelCommands(t, models, modelId, chooseModel)),
  ];
  const pendingPlan = items.find(
    (item) =>
      item.kind === "plan" &&
      item.current &&
      !item.plan.approved_at &&
      !item.plan.inherited,
  );
  const pendingDecision = items.find(
    (item) => item.kind === "decision" && item.open,
  );
  const attention =
    !liveRun && p.status !== "finished"
      ? pendingPlan
        ? { kind: "plan" as const, id: pendingPlan.id }
        : pendingDecision
          ? { kind: "decision" as const, id: pendingDecision.id }
          : null
      : null;
  const viewAttention = () => {
    if (!attention) return;
    const card = document.getElementById(
      `research-${attention.kind}-${attention.id}`,
    );
    if (!card || !scroller.current?.contains(card)) return;
    // Keep the reader at the selected card when the next poll arrives.
    pinned.current = false;
    card.scrollIntoView({
      block: "start",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    card.focus({ preventScroll: true });
  };
  return (
    <div className={styles.layout}>
      <div className={styles.page} data-testid="research-conversation">
        <header className={styles.head}>
          <Folder size={17} aria-hidden />
          <div className={styles.headHeading}>
            <h1 className={styles.headTitle}>
              <span title={p.question}>{p.title || p.question}</span>
            </h1>
            {!!changes.changes?.files.length && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.headStats}
                aria-label={t("research.review.action")}
                onClick={() => openReview()}
              >
                <ChangeNumbers changes={changes.changes} />
              </Button>
            )}
          </div>
          <div className={styles.headTools}>
            <Menu
              label={t("research.actions")}
              items={[
                {
                  id: "rename",
                  label: t("projects.sessions.rename"),
                  icon: Pencil,
                  onSelect: () => {
                    setTitle(p.title || p.question);
                    setNaming(true);
                  },
                },
                {
                  id: "fork",
                  label: t("research.fork.action"),
                  icon: GitFork,
                  onSelect: () => {
                    setRerunning(false);
                    setForking("");
                  },
                },
                {
                  id: "rerun",
                  label: t("compare.rerun"),
                  icon: GitFork,
                  onSelect: () => {
                    setRerunning(true);
                    setForking("");
                  },
                },
                {
                  id: "compare",
                  label: t("compare.title"),
                  icon: GitFork,
                  disabled: !p.workspace_id,
                  onSelect: () => go(`workspaces/${p.workspace_id}/compare`),
                },
                p.status === "paused"
                  ? {
                      id: "resume",
                      label: t("research.resume"),
                      icon: Play,
                      onSelect: () => move(resumeProject),
                    }
                  : {
                      id: "pause",
                      label: t("research.pause"),
                      icon: Pause,
                      onSelect: () => move(pauseProject),
                      disabled: p.status !== "active",
                    },
                {
                  id: "stop",
                  label: t("research.stop"),
                  icon: Square,
                  onSelect: () =>
                    liveRun &&
                    ["scoping", "discussion"].includes(busyNow?.role || "")
                      ? void controlChat(
                          p.session_id,
                          liveRun.id,
                          "abort",
                        ).then(refresh, fail)
                      : move(stopProject),
                  disabled: p.status === "finished" && !liveRun,
                },
                {
                  id: "archive",
                  label: t("projects.sessions.archive"),
                  icon: Archive,
                  disabled: p.status !== "finished" || !!busyNow,
                  onSelect: async () => {
                    try {
                      await updateChatSession(p.session_id, { archived: true });
                      refreshResearchNavigation();
                      go(`workspaces/${p.workspace_id}`);
                    } catch (error) {
                      fail(error);
                    }
                  },
                },
              ]}
              trigger={(props) => (
                <IconButton
                  icon={MoreHorizontal}
                  label={t("research.actions")}
                  size="sm"
                  {...props}
                />
              )}
            />
            <IconButton
              icon={record ? PanelRightClose : PanelRightOpen}
              label={t(
                record ? "research.record.hide" : "research.record.show",
              )}
              size="sm"
              onClick={() => {
                updateRecord(!record);
              }}
            />
          </div>
        </header>
        <div className={styles.body}>
          <div className={styles.talk}>
            <div className={styles.scrollArea}>
              <div
                className={styles.scroll}
                ref={scroller}
                onScroll={(event) => {
                  const el = event.currentTarget;
                  pinned.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
              >
                <div className={styles.thread}>
                  <ResearchOrigin
                    detail={detail}
                    go={go}
                    onResume={() => move(resumeProject)}
                  />
                  {!!pinnedItems.length && (
                    <ThreadView
                      items={pinnedItems}
                      project={p}
                      computes={computes}
                      actions={actions}
                      runs={runsBySprint}
                      locateId={locatedItem || undefined}
                    />
                  )}
                  <ThreadView
                    items={items.filter((item) => !pinnedIds.has(item.id))}
                    project={p}
                    computes={computes}
                    actions={actions}
                    runs={runsBySprint}
                    locateId={locatedItem || undefined}
                  />
                  {pending && <div className={styles.mine}>{pending}</div>}
                  {waitingData && p.stage === "experiments" && (
                    <p className={styles.systemLine}>
                      {t("research.thread.fetching")}
                      {fetchNote && ` ${fetchNote}`}
                    </p>
                  )}
                  {p.status === "paused" && (
                    <p className={styles.systemLine}>
                      {t("research.thread.paused")}
                    </p>
                  )}
                </div>
              </div>
              <JumpToLatest scroller={scroller} streaming={!!busyNow} />
            </div>
            {!embedded && (
              <div className={styles.dock}>
                {attention && (
                  <CardJump
                    key={`${id}-${attention.kind}-${attention.id}`}
                    cardId={`research-${attention.kind}-${attention.id}`}
                    scroller={scroller}
                    onClick={viewAttention}
                    label={t(
                      attention.kind === "plan"
                        ? "research.attention.viewPlan"
                        : "research.attention.viewDecision",
                    )}
                  />
                )}
                {liveRun && busyNow && (
                  <LiveCard
                    run={liveRun}
                    role={busyNow.role}
                    name={t(
                      `research.role.${["scoping", "discussion"].includes(busyNow.role) ? "discussion" : busyNow.role}` as MessageKey,
                    )}
                  />
                )}
                <Composer
                  value={text}
                  onChange={changeText}
                  onSend={say}
                  busy={!!pending}
                  needsModel={modelsKnown && models.length === 0}
                  label={t("research.composer.label")}
                  placeholder={t("research.composer.continue")}
                  leading={
                    <>
                      <IconButton
                        icon={Plus}
                        label={t("research.attach")}
                        size="sm"
                        onClick={() => setFilesOpen(true)}
                      />
                    </>
                  }
                  sendLabel={t("research.home.send")}
                  commands={commands}
                  acceptInserts
                  tools={
                    models.length > 0 &&
                    !finished && (
                      <ModelPicker
                        models={models}
                        value={modelId}
                        onChange={(modelId) => void chooseModel(modelId)}
                        label={t("commands.model")}
                      />
                    )
                  }
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {record && (
        <>
          <Resizer
            sizes="next"
            width={sizing.width}
            min={PANEL_MIN}
            max={sizing.max}
            fallback={PANEL_DEFAULT}
            maxNow={() => panelMax(window.innerWidth)}
            property="--panel-width"
            label={t("research.record.resize")}
            onChange={sizing.choose}
          />
          <RecordPanel
            key={id}
            outputFile={outputFile}
            onOutputFile={setOutputFile}
            detail={detail}
            computes={computes}
            run={run}
            onRun={setRun}
            actions={actions}
            go={go}
            tab={recordTab}
            onTab={(tab) => updateRecord(true, tab)}
            onClose={() => updateRecord(false)}
            width={sizing.width}
            changes={changes}
            review={review}
            refreshKey={refreshKey}
          />
        </>
      )}
      {forking !== null && (
        <ForkDialog
          project={p}
          initialSprintId={forking || undefined}
          rerun={rerunning}
          go={go}
          onClose={() => setForking(null)}
        />
      )}
      <Dialog
        open={filesOpen}
        title={t("research.panel.sources")}
        onClose={() => {
          setFilesOpen(false);
          refresh();
        }}
        size="lg"
      >
        <FilesPanel
          projectId={id}
          settled={settledKey(detail.sprints, detail.jobs)}
        />
      </Dialog>
      <Dialog
        open={naming}
        title={t("projects.sessions.rename")}
        onClose={() => setNaming(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNaming(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!title.trim()}
              onClick={async () => {
                try {
                  await organizeResearch(id, { title: title.trim() });
                  setNaming(false);
                  refreshResearchNavigation();
                  refresh();
                } catch (error) {
                  fail(error);
                }
              }}
            >
              {t("projects.save")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("workspace.researchTitle")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Dialog>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t("research.question.edit")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!editing?.question.trim()}
              onClick={async () => {
                if (!editing) return;
                try {
                  await restateQuestion(
                    id,
                    editing.question.trim(),
                    editing.note.trim(),
                  );
                  setEditing(null);
                  refresh();
                } catch (error) {
                  fail(error);
                }
              }}
            >
              {t("research.question.save")}
            </Button>
          </>
        }
      >
        {editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <TextArea
              label={t("research.question.label")}
              rows={4}
              value={editing.question}
              onChange={(e) =>
                setEditing({ ...editing, question: e.target.value })
              }
            />
            <TextField
              label={t("research.question.note")}
              value={editing.note}
              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
            />
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!log}
        onClose={() => setLog(null)}
        title={t("research.run.logTitle")}
        size="lg"
      >
        {log && (
          <pre className={styles.logBox}>
            {log.lines.lines
              .map((line) => `${String(line.n).padStart(4)}  ${line.text}`)
              .join("\n")}
          </pre>
        )}
      </Dialog>
    </div>
  );
}

/** A shortcut is useful only while its card is outside the conversation viewport. */
function CardJump({
  cardId,
  scroller,
  onClick,
  label,
}: {
  cardId: string;
  scroller: RefObject<HTMLDivElement | null>;
  onClick(): void;
  label: string;
}) {
  const [outside, setOutside] = useState(false);
  useEffect(() => {
    const card = document.getElementById(cardId);
    if (!card || !scroller.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setOutside(!entry.isIntersecting),
      { root: scroller.current },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [cardId, scroller]);
  return outside ? (
    <div className={styles.attention}>
      <Button size="sm" variant="secondary" onClick={onClick}>
        {label}
      </Button>
    </div>
  ) : null;
}
