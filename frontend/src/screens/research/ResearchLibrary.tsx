import { ArrowLeft, Folder, Pin, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { followLink } from "../../reader/route";
import {
  Button,
  Dialog,
  IconButton,
  SegmentedControl,
  Spinner,
  TextArea,
  TextField,
  toast,
} from "../../ui";
import {
  createCollection,
  organizeResearch,
  refreshResearchNavigation,
  updateCollection,
  type NavigationResearch,
  type ResearchCollection,
} from "./navigation-api";
import { researchStatus, useResearchNavigation } from "./ResearchNavigation";
import { updateChatSession, type ResearchProject } from "./research-api";
import { About } from "./projects/ProjectPage";
import { ProjectResults } from "./projects/ProjectResults";
import { ComparePanel } from "../team/compare/ComparePanel";
import { ConnectionsDialog, CreateWorkspaceDialog } from "./WorkspaceDialogs";
import { workspaceMachine } from "./workspace-machine";
import styles from "./Workspace.module.css";

function fail(reason: unknown) {
  toast.show({
    message: reason instanceof Error ? reason.message : String(reason),
    tone: "error",
  });
}

export function WorkspaceScreen({
  id,
  tab,
  go,
}: {
  id?: string;
  tab?: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const { data, connections, loading, error, reload } = useResearchNavigation();
  const [creating, setCreating] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const workspace = data.workspaces.find((item) => item.id === id);
  const machine = (location: Parameters<typeof workspaceMachine>[0]) =>
    workspaceMachine(
      location,
      connections,
      t("workspace.local"),
      t("workspace.remote"),
    );
  return (
    <main className={styles.page}>
      <header className={styles.pageHead}>
        {id && (
          <IconButton
            icon={ArrowLeft}
            label={t("workspace.workspaces")}
            onClick={() => go("workspaces")}
          />
        )}
        <div>
          <h1>{workspace?.name || t("workspace.workspaces")}</h1>
          {workspace && (
            <p
              title={`${machine(workspace.location).title} · ${workspace.location.path}`}
            >
              {machine(workspace.location).label}
            </p>
          )}
        </div>
        {workspace ? (
          <>
            <SegmentedControl
              kind="radio"
              size="sm"
              label={t("projects.view")}
              value={tab || "research"}
              onChange={(next) =>
                go(`workspaces/${id}${next === "research" ? "" : `/${next}`}`)
              }
              options={[
                { value: "research", label: t("research.view.list") },
                { value: "board", label: t("projects.view.board") },
                { value: "about", label: t("projects.view.about") },
                { value: "results", label: t("projects.view.results") },
                { value: "compare", label: t("compare.title") },
              ]}
            />
            <Button
              size="sm"
              icon={Plus}
              onClick={() => go(`new?workspace=${id}`)}
            >
              {t("projects.newResearch")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={Settings}
              onClick={() => setConnectionsOpen(true)}
            >
              {t("workspace.connections")}
            </Button>
            <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
              {t("workspace.add")}
            </Button>
          </>
        )}
      </header>
      {error && (
        <div className={styles.feedback}>
          <p role="alert">{error}</p>
          <Button onClick={reload}>{t("common.retry")}</Button>
        </div>
      )}
      {loading && !data.workspaces.length ? (
        <div className={styles.feedback}>
          <Spinner />
        </div>
      ) : workspace ? (
        tab === "compare" ? (
          <ComparePanel
            key={workspace.id}
            workspaceId={workspace.id}
            researches={workspace.researches}
            evaluation={workspace.kind === "eval"}
            onOpenResearch={(id) => go(`research/${id}`)}
          />
        ) : tab === "results" ? (
          <ProjectResults workspaceId={workspace.id} refreshKey={0} go={go} />
        ) : tab === "about" ? (
          <About
            key={workspace.id}
            workspace={workspace}
            onSaved={refreshResearchNavigation}
          />
        ) : tab === "board" ? (
          <WorkspaceBoard rows={workspace.researches} go={go} />
        ) : (
          <ResearchRows rows={workspace.researches} go={go} />
        )
      ) : id ? (
        <p className={styles.empty}>{t("workspace.notFound")}</p>
      ) : !data.workspaces.some((item) => !item.archived) ? (
        <div className={styles.emptyProjects}>
          <Folder aria-hidden />
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => setCreating(true)}
          >
            {t("workspace.add")}
          </Button>
        </div>
      ) : (
        <div className={styles.folderCards}>
          {data.workspaces
            .filter((item) => !item.archived)
            .map((item) => (
              <a
                key={item.id}
                href={`#workspaces/${item.id}`}
                onClick={followLink(go, `workspaces/${item.id}`)}
              >
                <Folder size={22} aria-hidden />
                <span>
                  <strong>{item.name}</strong>
                  <small
                    title={`${machine(item.location).title} · ${item.location.path}`}
                  >
                    {machine(item.location).label}
                  </small>
                </span>
                <span>{item.researches.length}</span>
              </a>
            ))}
        </div>
      )}
      {creating && (
        <CreateWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setCreating(false);
            go(`workspaces/${item.id}`);
          }}
        />
      )}
      {connectionsOpen && (
        <ConnectionsDialog onClose={() => setConnectionsOpen(false)} />
      )}
    </main>
  );
}

export function CollectionScreen({
  id,
  go,
}: {
  id?: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const { data, loading, error, reload } = useResearchNavigation();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const collection = data.collections.find((item) => item.id === id);
  const rows = data.workspaces
    .filter((item) => !item.archived)
    .flatMap((item) => item.researches);
  const filtered = rows.filter((item) =>
    id === "unclassified" ? !item.collection_id : item.collection_id === id,
  );
  return (
    <main className={styles.page}>
      <header className={styles.pageHead}>
        {id && (
          <IconButton
            icon={ArrowLeft}
            label={t("workspace.collections")}
            onClick={() => go("collections")}
          />
        )}
        <div>
          <h1>
            {id === "unclassified"
              ? t("workspace.unclassified")
              : collection?.name || t("workspace.collections")}
          </h1>
          {collection?.description && <p>{collection.description}</p>}
        </div>
        {collection && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            {t("projects.edit")}
          </Button>
        )}
        <Button
          size="sm"
          icon={Plus}
          onClick={() =>
            id
              ? go(`new${id !== "unclassified" ? `?collection=${id}` : ""}`)
              : setCreating(true)
          }
        >
          {t(id ? "projects.newResearch" : "workspace.addCollection")}
        </Button>
      </header>
      {error && (
        <div className={styles.feedback}>
          <p role="alert">{error}</p>
          <Button onClick={reload}>{t("common.retry")}</Button>
        </div>
      )}
      {loading && !data.collections.length ? (
        <div className={styles.feedback}>
          <Spinner />
        </div>
      ) : id ? (
        <ResearchRows rows={filtered} go={go} />
      ) : (
        <div className={styles.folderCards}>
          {data.collections
            .filter((item) => !item.archived)
            .map((item) => (
              <a
                key={item.id}
                href={`#collections/${item.id}`}
                onClick={followLink(go, `collections/${item.id}`)}
              >
                <Folder size={22} aria-hidden />

                <span>
                  {
                    rows.filter(
                      (research) => research.collection_id === item.id,
                    ).length
                  }
                </span>
              </a>
            ))}
          <a
            href="#collections/unclassified"
            onClick={followLink(go, "collections/unclassified")}
          >
            <Folder size={22} aria-hidden />
            <strong>{t("workspace.unclassified")}</strong>
          </a>
        </div>
      )}
      {creating && (
        <CollectionDialog
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setCreating(false);
            go(`collections/${item.id}`);
          }}
        />
      )}
      {editing && collection && (
        <CollectionDialog
          collection={collection}
          onClose={() => setEditing(false)}
          onCreated={() => setEditing(false)}
        />
      )}
    </main>
  );
}

export function CollectionDialog({
  collection,
  onClose,
  onCreated,
}: {
  collection?: ResearchCollection;
  onClose(): void;
  onCreated(item: ResearchCollection): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(collection?.name || "");
  const [description, setDescription] = useState(collection?.description || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      title={t(
        collection ? "workspace.editCollection" : "workspace.addCollection",
      )}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const item = collection
                  ? await updateCollection(collection.id, {
                      name: name.trim(),
                      description,
                    })
                  : await createCollection(name.trim(), description);
                refreshResearchNavigation();
                onCreated(item);
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("projects.save")}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <TextField
          label={t("projects.name")}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <TextArea
          label={t("projects.about")}
          value={description}
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
        />

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function ResearchRows({
  rows,
  go,
}: {
  rows: NavigationResearch[];
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const filtered = rows
    .filter((item) => !!item.archived_at === archived)
    .filter((item) =>
      `${item.title} ${item.question}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(!!b.pinned_at) - Number(!!a.pinned_at) ||
        (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
    );
  return (
    <div className={styles.researchList}>
      <div className={styles.researchToolbar}>
        <TextField
          type="search"
          label={t("workspace.searchResearch")}
          hideLabel
          placeholder={t("workspace.searchResearch")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <SegmentedControl
          kind="radio"
          size="sm"
          label={t("research.archiveFilter")}
          value={archived ? "archived" : "unarchived"}
          onChange={(value) => setArchived(value === "archived")}
          options={[
            { value: "unarchived", label: t("research.unarchived") },
            { value: "archived", label: t("projects.sessions.archived") },
          ]}
        />
      </div>
      {filtered.map((item) => (
        <a
          key={item.id}
          href={`#research/${item.id}`}
          onClick={followLink(go, `research/${item.id}`)}
        >
          <span className={styles.rowTitle}>
            {item.pinned_at && <Pin size={12} aria-hidden />}
            <span className={styles.rowName}>
              {item.title || item.question}
            </span>
          </span>
          <span className={styles.rowStatus}>{t(researchStatus(item))}</span>
          {archived && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async (event) => {
                event.preventDefault();
                try {
                  await updateChatSession(item.session_id, { archived: false });
                  refreshResearchNavigation();
                } catch (error) {
                  fail(error);
                }
              }}
            >
              {t("projects.sessions.restore")}
            </Button>
          )}
          {item.title && item.title !== item.question && (
            <p className={styles.rowQuestion}>{item.question}</p>
          )}
          {item.progress && (
            <p className={styles.rowProgress}>{item.progress}</p>
          )}
          {(item.merged?.memory || item.merged?.code) && (
            <small>{t("research.merge.applied")}</small>
          )}
          {item.forked_from?.research_id && (
            <small>
              ↳ {item.forked_from.question} ·{" "}
              {t("research.sprint", { number: item.forked_from.number })}
            </small>
          )}
        </a>
      ))}
      {!filtered.length && (
        <p className={styles.empty}>{t("projects.noResearch")}</p>
      )}
    </div>
  );
}

function WorkspaceBoard({
  rows,
  go,
}: {
  rows: NavigationResearch[];
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const columns = [
    "ready",
    "running",
    "waiting",
    "paused",
    "finished",
  ] as const;
  return (
    <div className={styles.board}>
      {columns.map((status) => (
        <section key={status}>
          <h2>
            {t(`research.status.${status}`)}{" "}
            <span>
              {
                rows.filter(
                  (r) =>
                    !r.archived_at &&
                    researchStatus(r) === `research.status.${status}`,
                ).length
              }
            </span>
          </h2>
          {rows
            .filter(
              (r) =>
                !r.archived_at &&
                (researchStatus(r) === `research.status.${status}` ||
                  (status === "finished" && r.status === "finished")),
            )
            .map((r) => (
              <article key={r.id}>
                <a
                  href={`#research/${r.id}`}
                  onClick={followLink(go, `research/${r.id}`)}
                >
                  <strong>{r.title || r.question}</strong>
                  {r.progress && <p>{r.progress}</p>}
                </a>
              </article>
            ))}
        </section>
      ))}
    </div>
  );
}
