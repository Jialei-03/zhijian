import { useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import { Button, Dialog, TextArea, TextField } from "../../ui";
import { newAvatarSeed, pixelAvatarSvg } from "../../ui/pixel-avatar";
import {
  convertAgentDocument,
  importAgentDocument,
} from "../research/team-api";
import type {
  LibraryMember,
  MemberConfig,
  MemberPermissions,
  Team,
  TeamMember,
  AvatarUpload,
} from "../research/team-api";
import type { ModelRow } from "../setup/model-api";
import {
  memberAvatarSeed,
  memberDraft,
  memberName,
  permissionChange,
  validMember,
  documentDraft,
  withMemberPermissions,
} from "./member-model";
import styles from "./Members.module.css";

export function MemberAvatar({
  member,
  seed,
  url = member?.avatar_url,
  size,
}: {
  member?: Partial<TeamMember>;
  seed?: string;
  url?: string | null;
  size?: "sm" | "lg";
}) {
  const [failed, setFailed] = useState<string>();
  const image = !member?.avatar?.startsWith("pixel:") && url && url !== failed;
  const avatarSeed = member?.avatar?.startsWith("pixel:")
    ? member.avatar.slice(6)
    : (seed ?? memberAvatarSeed(member ?? {}));
  const svg = useMemo(() => pixelAvatarSvg(avatarSeed), [avatarSeed]);
  return (
    <span className={styles.avatar} data-size={size} aria-hidden="true">
      {image ? (
        <img src={url} alt="" onError={() => setFailed(url)} />
      ) : (
        <span dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </span>
  );
}
export function PermissionFields({
  value,
  machines,
  onChange,
}: {
  value: MemberPermissions;
  machines: { id: string; name: string }[];
  onChange(p: MemberPermissions): void;
}) {
  const { t } = useI18n();
  return (
    <>
      <fieldset className={styles.checks}>
        <legend>{t("members.permissions")}</legend>
        {(["readonly", "file_readonly"] as const).map((key) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={value[key] ?? false}
              onChange={(e) =>
                onChange(permissionChange(value, key, e.target.checked))
              }
            />
            {t(`members.permission.${key}`)}
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.checks}>
        <legend>{t("members.machines")}</legend>
        {machines.map((m) => (
          <label key={m.id}>
            <input
              type="checkbox"
              checked={value.machines.includes(m.id)}
              onChange={(e) =>
                onChange({
                  ...value,
                  machines: e.target.checked
                    ? [...value.machines, m.id]
                    : value.machines.filter((id) => id !== m.id),
                })
              }
            />
            {m.name}
          </label>
        ))}
      </fieldset>
    </>
  );
}
export function MemberFields({
  draft,
  identityLocked,
  models,
  machines,
  body = true,
  avatarSeed,
  avatarUrl,
  onUpload,
  onChange,
}: {
  draft: MemberConfig;
  identityLocked: boolean;
  body?: boolean;
  avatarSeed?: string;
  avatarUrl?: string;
  onUpload?(file: File): void;
  models: ModelRow[];
  machines: { id: string; name: string }[];
  onChange(d: MemberConfig): void;
}) {
  const { t } = useI18n();
  const modelId = useId();
  const uploadId = useId();
  const upload = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<MemberConfig>) =>
    onChange({ ...draft, ...patch });
  return (
    <>
      <div className={styles.identity}>
        <TextField
          required
          maxLength={100}
          label={t("members.name")}
          value={draft.name}
          disabled={identityLocked}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <fieldset className={styles.field}>
        <legend>{t("members.avatar")}</legend>
        <div className={styles.avatarEditor}>
          <MemberAvatar
            member={draft}
            seed={avatarSeed}
            url={avatarUrl}
            size="lg"
          />
          <Button
            disabled={identityLocked}
            onClick={() => set({ avatar: `pixel:${newAvatarSeed()}` })}
          >
            {t("members.anotherAvatar")}
          </Button>
          {onUpload && (
            <>
              <Button
                disabled={identityLocked}
                onClick={() => upload.current?.click()}
              >
                {t("members.uploadAvatar")}
              </Button>
              <input
                ref={upload}
                id={uploadId}
                hidden
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.svg"
                aria-label={t("members.uploadAvatar")}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUpload(file);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>
      </fieldset>
      <TextField
        label={t("members.summary")}
        value={draft.description ?? ""}
        maxLength={5000}
        onChange={(e) => set({ description: e.target.value })}
      />
      {body && (
        <TextArea
          label={t("members.description")}
          rows={6}
          maxLength={50000}
          value={draft.role_description}
          disabled={identityLocked}
          onChange={(e) => set({ role_description: e.target.value })}
        />
      )}
      <div className={styles.field}>
        <label htmlFor={modelId}>{t("commands.model")}</label>
        <select
          id={modelId}
          value={draft.model_config_id}
          onChange={(e) => set({ model_config_id: e.target.value })}
        >
          <option value="">{t("members.teamModel")}</option>
          {draft.model_config_id &&
            !models.some((m) => m.id === draft.model_config_id) && (
              <option value={draft.model_config_id}>
                {draft.model_config_id}
              </option>
            )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.model}
            </option>
          ))}
        </select>
      </div>
      <fieldset className={styles.checks}>
        <legend>{t("members.tools")}</legend>
        {["literature", "files", "shell", "experiments", "web", "project"].map(
          (tool) => (
            <label key={tool}>
              <input
                type="checkbox"
                disabled={
                  draft.permissions.readonly &&
                  ["shell", "experiments"].includes(tool)
                }
                checked={
                  draft.tools?.includes(tool) ??
                  {
                    literature: draft.permissions.papers,
                    files: draft.permissions.files,
                    shell: draft.permissions.commands,
                    experiments: draft.permissions.commands,
                    web: true,
                    project: true,
                  }[tool] ??
                  false
                }
                onChange={(e) => {
                  const current =
                    withMemberPermissions(draft, draft.permissions).tools ?? [];
                  const tools = e.target.checked
                    ? [...current, tool]
                    : current.filter((v) => v !== tool);
                  set({
                    tools,
                    permissions: {
                      ...draft.permissions,
                      papers: tools.includes("literature"),
                      files: tools.includes("files"),
                      commands:
                        tools.includes("shell") ||
                        tools.includes("experiments"),
                    },
                  });
                }}
              />
              {t(`members.tool.${tool}` as MessageKey)}
            </label>
          ),
        )}
      </fieldset>
      <PermissionFields
        value={draft.permissions}
        machines={machines}
        onChange={(permissions) =>
          onChange(withMemberPermissions(draft, permissions))
        }
      />
    </>
  );
}
export function MemberEditor({
  initial,
  initialSource = "",
  initialError = "",
  initialSubscriptions = [],
  initialAvatarSeed,
  initialAvatarUrl,
  allowUpload = true,
  role = "custom",
  creating = false,
  team,
  library,
  models,
  machines,
  onSave,
  onClose,
}: {
  initial?: MemberConfig;
  initialSource?: string;
  initialError?: string;
  initialSubscriptions?: string[];
  initialAvatarSeed?: string;
  initialAvatarUrl?: string;
  allowUpload?: boolean;
  role?: string;
  builtin?: boolean;
  creating?: boolean;
  team: Team;
  library: LibraryMember[];
  models: ModelRow[];
  machines: { id: string; name: string }[];
  onSave(
    config: MemberConfig,
    subscriptions: string[],
    source: string,
    document?: string,
    upload?: AvatarUpload,
  ): Promise<void>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const form = useId();
  const sourceId = useId();
  const [draft, setDraft] = useState(() => memberDraft(initial));
  const [subscriptions, setSubscriptions] = useState(initialSubscriptions);
  const [source, setSource] = useState("");
  const [document, setDocument] = useState(initialSource);
  const [mode, setMode] = useState<"form" | "source">(
    initialError ? "source" : "form",
  );
  const [importing, setImporting] = useState(false);
  const [paste, setPaste] = useState("");
  const [format, setFormat] = useState("agent.md");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(initialError);
  const [upload, setUpload] = useState<AvatarUpload>();
  const [preview, setPreview] = useState<string>();
  const [uploadPath, setUploadPath] = useState<string>();
  const activeUpload = draft.avatar === uploadPath ? upload : undefined;
  const uploadAvatar = (file: File) => {
    const reader = new FileReader();
    setSaving(true);
    reader.onload = () => {
      const url = String(reader.result);
      const extension = file.name
        .split(".")
        .pop()
        ?.toLowerCase() as AvatarUpload["extension"];
      setUpload({ extension, content: url.slice(url.indexOf(",") + 1) });
      setPreview(url);
      const avatar = `.ora/avatars/${draft.name}.${extension}`;
      setUploadPath(avatar);
      setDraft((value) => ({ ...value, avatar }));
      setSaving(false);
    };
    reader.onerror = () => {
      setError(String(reader.error));
      setSaving(false);
    };
    reader.readAsDataURL(file);
  };
  const librarySource = source.startsWith("l:");
  const adopt = (value: Awaited<ReturnType<typeof convertAgentDocument>>) => {
    const next = documentDraft(value, team.channels);
    setDraft(next.draft);
    setDocument(next.source);
    setSubscriptions(next.subscriptions);
    setWarnings(value.warnings);
    setError("");
    return next;
  };
  const convert = () =>
    convertAgentDocument(
      team.workspace_id,
      document,
      mode === "form" ? draft : undefined,
      mode === "form"
        ? team.channels
            .filter((c) => subscriptions.includes(c.id))
            .map((c) => `#${c.name}`)
        : undefined,
      role,
    );
  const changeMode = async (next: "form" | "source") => {
    if (next === mode) return;
    if (next === "source" && !document && !draft.name.trim()) {
      setDocument('---\nname: ""\n---\n\n' + draft.role_description);
      setMode("source");
      return;
    }
    setSaving(true);
    try {
      adopt(await convert());
      setMode(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const importText = async (content: string, filename: string) => {
    setSaving(true);
    try {
      adopt(await importAgentDocument(team.workspace_id, content, filename));
      setSource("");
      setImporting(false);
      setMode("form");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      size="lg"
      title={t(creating ? "members.add" : "members.edit")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            form={form}
            type="submit"
            disabled={mode === "form" && !validMember(draft)}
            loading={saving}
          >
            {t("projects.save")}
          </Button>
        </>
      }
    >
      <form
        id={form}
        className={styles.form}
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            if (librarySource) await onSave(draft, subscriptions, source);
            else {
              const value = await convert();
              const next = adopt(value);
              await onSave(
                next.draft,
                next.subscriptions,
                source,
                value.source,
                next.draft.avatar === uploadPath ? upload : undefined,
              );
            }
          } catch (reason) {
            setError(String(reason));
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className={styles.toolbar}>
          <Button
            disabled={saving || librarySource}
            aria-pressed={mode === "form"}
            onClick={() => void changeMode("form")}
          >
            {t("members.form")}
          </Button>
          <Button
            disabled={saving || librarySource}
            aria-pressed={mode === "source"}
            onClick={() => void changeMode("source")}
          >
            {t("members.sourceFile")}
          </Button>
          <Button onClick={() => setImporting(!importing)}>
            {t("members.import")}
          </Button>
        </div>
        {importing && (
          <div className={styles.form}>
            <input
              type="file"
              accept=".md,.toml"
              aria-label={t("members.importFile")}
              onChange={(e) => {
                const selected = e.target.files?.[0];
                if (selected)
                  void selected
                    .text()
                    .then((text) => importText(text, selected.name));
              }}
            />
            <div className={styles.field}>
              <label htmlFor={`${sourceId}-format`}>
                {t("members.format")}
              </label>
              <select
                id={`${sourceId}-format`}
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="agent.md">Claude Code</option>
                <option value="agent.toml">Codex</option>
              </select>
            </div>
            <TextArea
              label={t("members.paste")}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={6}
            />
            <Button
              disabled={!paste || saving}
              onClick={() => void importText(paste, format)}
            >
              {t("members.import")}
            </Button>
          </div>
        )}
        {creating && (
          <div className={styles.field}>
            <label htmlFor={sourceId}>{t("members.source")}</label>
            <select
              id={sourceId}
              value={source}
              onChange={(e) => {
                const value = e.target.value;
                setSource(value);
                setUpload(undefined);
                setPreview(undefined);
                const chosen = value.startsWith("l:")
                  ? library.find((m) => m.id === value.slice(2))
                  : team.members.find((m) => m.id === value.slice(2));
                setDraft(
                  memberDraft(
                    chosen && "config" in chosen
                      ? chosen.config
                      : (chosen as Partial<MemberConfig>),
                  ),
                );
                setDocument(chosen?.source ?? "");
              }}
            >
              <option value="">{t("members.new")}</option>
              <optgroup label={t("members.copy")}>
                {team.members
                  .filter((m) => m.role !== "human" && !m.deleted)
                  .map((m) => (
                    <option key={m.id} value={`m:${m.id}`}>
                      {memberName(m, t)}
                    </option>
                  ))}
              </optgroup>
              <optgroup label={t("members.library")}>
                {library.map((m) => (
                  <option key={m.id} value={`l:${m.id}`}>
                    {m.config.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        )}
        {mode === "source" ? (
          <TextArea
            label={t("members.sourceFile")}
            className={styles.sourceEditor}
            rows={24}
            value={document}
            onChange={(e) => setDocument(e.target.value)}
          />
        ) : (
          <div className={styles.editorColumns}>
            <div className={styles.fields}>
              <fieldset disabled={librarySource} className={styles.fields}>
                <MemberFields
                  draft={draft}
                  identityLocked={false}
                  body={false}
                  models={models}
                  machines={machines}
                  onChange={setDraft}
                  avatarSeed={initialAvatarSeed}
                  avatarUrl={
                    activeUpload
                      ? preview
                      : draft.avatar === initial?.avatar
                        ? initialAvatarUrl
                        : undefined
                  }
                  onUpload={allowUpload ? uploadAvatar : undefined}
                />
              </fieldset>
              <fieldset className={styles.checks}>
                <legend>{t("members.subscriptions")}</legend>
                {team.channels
                  .filter((c) => !c.member_id)
                  .map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={subscriptions.includes(c.id)}
                        onChange={(e) =>
                          setSubscriptions(
                            e.target.checked
                              ? [...subscriptions, c.id]
                              : subscriptions.filter((id) => id !== c.id),
                          )
                        }
                      />
                      #{c.name}
                    </label>
                  ))}
              </fieldset>
            </div>
            <TextArea
              label={t("members.description")}
              className={styles.bodyEditor}
              rows={24}
              maxLength={50000}
              value={draft.role_description}
              disabled={librarySource}
              onChange={(e) =>
                setDraft({ ...draft, role_description: e.target.value })
              }
            />
          </div>
        )}
        {warnings.map((warning) => (
          <p role="status" key={warning}>
            {warning}
          </p>
        ))}
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
