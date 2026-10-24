import {
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  Laptop,
  Plus,
  Server,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  Button,
  Dialog,
  Floating,
  IconButton,
  SegmentedControl,
  Spinner,
  TextField,
} from "../../ui";
import {
  browseFolders,
  createConnection,
  createPhysicalWorkspace,
  readConnections,
  refreshResearchNavigation,
  type FolderListing,
  type NavigationWorkspace,
  type SSHConnection,
  type WorkspaceLocation,
} from "./navigation-api";
import { useResearchNavigation } from "./ResearchNavigation";
import { workspaceMachine } from "./workspace-machine";
import styles from "./Workspace.module.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function WorkspacePicker({
  value,
  onChange,
  prominent = false,
  label,
  "data-id": dataId,
}: {
  "data-id"?: string;
  value: string;
  onChange(id: string): void;
  prominent?: boolean;
  label?: string;
}) {
  const { t } = useI18n();
  const { data, connections } = useResearchNavigation();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) searchField.current?.focus();
  }, [open]);
  const current = data.workspaces.find((workspace) => workspace.id === value);
  const machine = (location: WorkspaceLocation) =>
    workspaceMachine(
      location,
      connections,
      t("workspace.local"),
      t("workspace.remote"),
    );
  const workspaces = data.workspaces.filter(
    (workspace) =>
      !workspace.archived &&
      `${workspace.name} ${workspace.location.path} ${machine(workspace.location).title}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const close = () => {
    setOpen(false);
    anchor.current?.focus();
  };
  const toggle = () => {
    setSearch("");
    if (prominent && !data.workspaces.some((workspace) => !workspace.archived))
      setCreating(true);
    else setOpen((old) => !old);
  };
  return (
    <>
      {prominent ? (
        <Button
          ref={anchor}
          data-id={dataId}
          variant="primary"
          icon={Folder}
          aria-label={t("workspace.chooseFolder")}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          {t("workspace.chooseFolder")}
        </Button>
      ) : (
        <button
          type="button"
          ref={anchor}
          data-id={dataId}
          className={styles.chip}
          aria-label={label || t("workspace.choose")}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          <Folder size={16} aria-hidden />
          <span>{current?.name || t("workspace.choose")}</span>
          <ChevronDown size={16} aria-hidden />
        </button>
      )}
      <Floating
        open={open}
        anchor={anchor.current}
        ignore={anchor.current}
        placement={{ side: "top", align: "start" }}
        onDismiss={close}
        className={styles.picker}
      >
        {open && (
          <div role="dialog" aria-label={t("workspace.choose")}>
            <TextField
              ref={searchField}
              label={t("workspace.search")}
              hideLabel
              type="search"
              autoFocus
              placeholder={t("workspace.search")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget
                    .closest("[role=dialog]")
                    ?.querySelector<HTMLButtonElement>("[role=option]")
                    ?.focus();
                }
              }}
            />
            <div
              className={styles.pickerRows}
              role="listbox"
              aria-label={t("workspace.workspaces")}
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                )
                  return;
                const rows = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "[role=option]",
                  ),
                ];
                const currentIndex = rows.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? rows.length - 1
                      : (currentIndex +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          rows.length) %
                        rows.length;
                event.preventDefault();
                rows[next]?.focus();
              }}
            >
              {workspaces.map((workspace) => (
                <button
                  type="button"
                  key={workspace.id}
                  role="option"
                  aria-selected={workspace.id === value}
                  className={styles.pickerRow}
                  onClick={() => {
                    onChange(workspace.id);
                    close();
                  }}
                >
                  <Folder size={16} aria-hidden />
                  <span>
                    {workspace.name}
                    <small title={machine(workspace.location).title}>
                      {machine(workspace.location).label} ·{" "}
                      {workspace.location.path}
                    </small>
                  </span>
                  {workspace.id === value && <Check size={14} aria-hidden />}
                </button>
              ))}
              {!workspaces.length && (
                <p className={styles.muted}>{t("workspace.noMatches")}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={Plus}
              onClick={() => {
                close();
                setCreating(true);
              }}
            >
              {t("workspace.add")}
            </Button>
          </div>
        )}
      </Floating>
      {creating && (
        <CreateWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreated={(workspace) => {
            onChange(workspace.id);
            setCreating(false);
          }}
        />
      )}
    </>
  );
}

export function CreateWorkspaceDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(workspace: NavigationWorkspace): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(() => t("workspace.untitled"));
  const nameField = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [kind, setKind] = useState<"local" | "ssh">("local");
  const [connectionId, setConnectionId] = useState("");
  const [connections, setConnections] = useState<SSHConnection[]>([]);
  const [path, setPath] = useState("");
  const [folderError, setFolderError] =
    useState<FolderListing["project_error"]>("");
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    readConnections().then(setConnections, (reason: unknown) =>
      setError(message(reason)),
    );
  }, []);
  useEffect(() => {
    nameField.current?.select();
  }, []);
  useEffect(() => {
    if (mode !== "new" || (kind === "ssh" && !connectionId)) return;
    let stale = false;
    browseFolders(kind, "", connectionId).then(
      (listing) => {
        if (!stale) setPath(listing.path);
      },
      (reason: unknown) => {
        if (!stale) setError(message(reason));
      },
    );
    return () => {
      stale = true;
    };
  }, [kind, connectionId, mode]);
  const currentConnection = connections.find(
    (connection) => connection.id === connectionId,
  );
  const invalidName =
    mode === "new" &&
    ([".", ".."].includes(name.trim()) || /[/\\\0\n\r]/.test(name.trim()));
  const canCreate =
    !!path &&
    !!name.trim() &&
    !invalidName &&
    (mode === "new" || !folderError) &&
    (kind !== "ssh" || !!connectionId);
  const targetPath =
    mode === "new" ? `${path.replace(/\/$/, "")}/${name.trim()}` : path;
  const machineName =
    kind === "local"
      ? t("workspace.local")
      : currentConnection?.name || t("workspace.remote");
  const chooseDevice = (next: "local" | "ssh", id = "") => {
    setKind(next);
    setConnectionId(id);
    setPath("");
    setFolderError("");
    setError("");
  };
  const create = async () => {
    if (!canCreate || busy) return;
    setBusy(true);
    setError("");
    try {
      const workspace = await createPhysicalWorkspace(
        name.trim(),
        {
          kind,
          path,
          connection_id: kind === "ssh" ? connectionId : "",
        },
        mode === "new",
      );
      refreshResearchNavigation();
      onCreated(workspace);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={t("workspace.add")}
      onClose={onClose}
      dismissible={!busy}
      size="md"
      initialFocus={nameField}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!canCreate}
            onClick={create}
          >
            {t(
              mode === "new" ? "workspace.add" : "workspace.useSelectedFolder",
            )}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <fieldset className={styles.machineChooser} disabled={busy}>
          <SegmentedControl
            kind="radio"
            label={t("workspace.folderHeading")}
            value={mode}
            onChange={(next) => {
              if (busy) return;
              setMode(next);
              setPath("");
              setFolderError("");
              setError("");
            }}
            options={[
              { value: "new", label: t("workspace.newFolder") },
              { value: "existing", label: t("workspace.existingFolder") },
            ]}
          />
        </fieldset>
        <TextField
          ref={nameField}
          label={t("workspace.name")}
          value={name}
          required
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className={styles.machineChooser} disabled={busy}>
          <legend>{t("workspace.machineHeading")}</legend>
          <div className={styles.machineChoices}>
            <button
              type="button"
              className={styles.machineOption}
              aria-pressed={kind === "local"}
              onClick={() => kind !== "local" && chooseDevice("local")}
            >
              <Laptop size={18} aria-hidden />
              <span>{t("workspace.local")}</span>
              {kind === "local" && <Check size={15} aria-hidden />}
            </button>
            {connections.map((connection) => (
              <button
                type="button"
                key={connection.id}
                className={styles.machineOption}
                aria-pressed={kind === "ssh" && connectionId === connection.id}
                onClick={() => {
                  if (kind !== "ssh" || connectionId !== connection.id)
                    chooseDevice("ssh", connection.id);
                }}
              >
                <Server size={18} aria-hidden />
                <span>
                  <strong>{connection.name}</strong>
                  <small>{connection.host}</small>
                </span>
                {kind === "ssh" && connectionId === connection.id && (
                  <Check size={15} aria-hidden />
                )}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            disabled={busy}
            onClick={() => setManaging(true)}
          >
            {t("workspace.addMachine")}
          </Button>
        </fieldset>
        {mode === "existing" && (
          <div className={styles.folderStep}>
            <h3>{t("workspace.folderHeading")}</h3>
            <FolderBrowser
              key={`${kind}:${connectionId}`}
              kind={kind}
              connectionId={connectionId}
              disabled={busy}
              onFolder={(listing) => {
                setPath(listing?.path || "");
                setFolderError(listing?.project_error || "");
              }}
            />
          </div>
        )}
        {path && (
          <section
            className={styles.folderSelection}
            aria-label={t("workspace.selectedFolder")}
          >
            <Check size={16} aria-hidden />
            <span>
              <strong>{machineName}</strong>
              <code>{targetPath}</code>
            </span>
          </section>
        )}
        {mode === "existing" && folderError && (
          <p role="status" className={styles.error}>
            {t(`workspace.folderError.${folderError}`)}
          </p>
        )}
        {invalidName && (
          <p role="status" className={styles.error}>
            {t("workspace.invalidFolderName")}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
      {managing && (
        <ConnectionsDialog
          onClose={() => setManaging(false)}
          onAdded={(connection) => {
            setConnections((old) => [
              ...old.filter((row) => row.id !== connection.id),
              connection,
            ]);
            chooseDevice("ssh", connection.id);
            setManaging(false);
          }}
        />
      )}
    </Dialog>
  );
}

function FolderBrowser({
  kind,
  connectionId,
  disabled,
  onFolder,
}: {
  kind: "local" | "ssh";
  connectionId: string;
  disabled: boolean;
  onFolder(listing: FolderListing | null): void;
}) {
  const { t } = useI18n();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const latest = useRef(onFolder);
  latest.current = onFolder;
  const request = useRef(0);
  const read = async (path: string) => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    latest.current(null);
    try {
      const result = await browseFolders(kind, path, connectionId);
      if (id === request.current) {
        setListing(result);
        setAddress(result.path);
        latest.current(result);
      }
    } catch (reason) {
      if (id === request.current) {
        setError(message(reason));
        setListing(null);
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (kind !== "ssh" || connectionId) void read("");
    return () => {
      request.current++;
    };
  }, [kind, connectionId]);
  if (kind === "ssh" && !connectionId)
    return <p className={styles.muted}>{t("workspace.noConnection")}</p>;
  const entries = listing?.entries.filter(
    (entry) => showHidden || !entry.name.startsWith("."),
  );
  return (
    <section
      className={styles.folderBrowser}
      aria-label={t("workspace.browse")}
    >
      <div className={styles.folderAddress}>
        <IconButton
          icon={ArrowUp}
          label={t("workspace.parent")}
          size="sm"
          disabled={disabled || busy || !listing?.parent}
          onClick={() => listing?.parent && read(listing.parent)}
        />
        <TextField
          label={t("workspace.path")}
          hideLabel
          value={address}
          disabled={disabled}
          onChange={(event) => {
            setAddress(event.target.value);
            request.current++;
            setBusy(false);
            latest.current(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void read(address);
            }
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || busy}
          onClick={() => read(address)}
        >
          {t("workspace.open")}
        </Button>
      </div>
      <div className={styles.folderBrowserOptions}>
        <label className={styles.hiddenToggle}>
          <input
            type="checkbox"
            checked={showHidden}
            disabled={disabled}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          {t("workspace.showHiddenFolders")}
        </label>
      </div>
      <div className={styles.folders}>
        {busy && <Spinner size={16} />}
        {listing &&
          !busy &&
          entries?.map((entry) => (
            <button
              key={entry.path}
              disabled={disabled}
              onClick={() => read(entry.path)}
            >
              <Folder size={16} aria-hidden />
              <span>{entry.name}</span>
            </button>
          ))}
        {listing && !busy && !entries?.length && (
          <p className={styles.muted}>
            {t(
              listing.entries.length
                ? "workspace.onlyHiddenFolders"
                : "workspace.emptyFolder",
            )}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export function ConnectionsDialog({
  onClose,
  onAdded,
}: {
  onClose(): void;
  onAdded?(connection: SSHConnection): void;
}) {
  const { t } = useI18n();
  const [connections, setConnections] = useState<SSHConnection[]>([]);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [identity, setIdentity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    readConnections().then(setConnections, (reason: unknown) =>
      setError(message(reason)),
    );
  }, []);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const connection = await createConnection({
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 22,
        identity_file: identity.trim(),
      });
      setConnections((old) => [...old, connection]);
      setName("");
      setHost("");
      setIdentity("");
      onAdded?.(connection);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={t("workspace.connections")}
      onClose={onClose}
      dismissible={!busy}
      size="md"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={
              !name.trim() ||
              !host.trim() ||
              !Number.isInteger(Number(port)) ||
              Number(port) < 1 ||
              Number(port) > 65535
            }
            onClick={save}
          >
            {t("workspace.saveConnection")}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        {connections.length > 0 && (
          <ul className={styles.connectionList}>
            {connections.map((connection) => (
              <li key={connection.id}>
                <Server size={15} aria-hidden />
                <span>
                  {connection.name}
                  <small>
                    {connection.host}:{connection.port}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
        <TextField
          label={t("workspace.connectionName")}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={t("workspace.host")}
          placeholder="user@host"
          value={host}
          disabled={busy}
          onChange={(event) => setHost(event.target.value)}
        />
        <TextField
          label={t("workspace.port")}
          type="number"
          min={1}
          max={65535}
          value={port}
          disabled={busy}
          onChange={(event) => setPort(event.target.value)}
        />
        <TextField
          label={t("workspace.identity")}
          value={identity}
          disabled={busy}
          onChange={(event) => setIdentity(event.target.value)}
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

export function locationLabel(location: WorkspaceLocation, localLabel: string) {
  return location.kind === "ssh" ? location.connection_id : localLabel;
}
