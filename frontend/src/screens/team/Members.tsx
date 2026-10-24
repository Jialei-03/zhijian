import { useEffect, useState } from "react";
import { ArrowLeft, MessageSquare, MoreHorizontal, Plus } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog, IconButton, Menu, TextField } from "../../ui";
import {
  addTeamMember,
  deleteTeamMember,
  editTeamMember,
  readMember,
  readMemberLibrary,
  refreshTeam,
  saveLibraryMember,
  settingsHash,
  teamHash,
  type LibraryMember,
  type MemberConfig,
  type MemberDetail,
  type Team,
  type TeamMember,
} from "../research/team-api";
import { readModels, type ModelRow } from "../setup/model-api";
import { readResearchSettings } from "../research/research-api";
import { useResearchNavigation } from "../research/ResearchNavigation";
import { MemberStatus } from "../research/TeamNavigation";
import { Prose } from "../research/talk/ThreadView";
import { MemberAvatar, MemberEditor } from "./MemberEditor";
import { MemberPause } from "./MemberPause";
import { memberAvatarSeed, memberDraft, memberName } from "./member-model";
import { threadDate } from "../research/team-model";
import { AttentionLine } from "../research/TeamWork";
import teamStyles from "../research/Team.module.css";
import styles from "./Members.module.css";

export function Members({
  team,
  selected,
  go,
}: {
  team: Team;
  selected?: string;
  go(hash: string): void;
}) {
  const { t, locale } = useI18n();
  const { connections } = useResearchNavigation();
  const [library, setLibrary] = useState<LibraryMember[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [machines, setMachines] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{
    member?: TeamMember;
    library?: LibraryMember;
  } | null>(null);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{
    member: TeamMember;
    action: "delete" | "disable" | "restore";
  } | null>(null);
  const [pending, setPending] = useState<{
    config: MemberConfig;
    source?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let stale = false;
    Promise.all([
      readMemberLibrary(team.workspace_id),
      readModels(),
      readResearchSettings(),
    ]).then(
      ([l, m, s]) => {
        if (!stale) {
          setLibrary(l);
          setModels(m.models);
          setMachines(s.computes);
        }
      },
      (reason) => !stale && setError(String(reason)),
    );
    return () => {
      stale = true;
    };
  }, [team.workspace_id, editing]);
  const listed = team.members.find((m) => m.id === selected && !m.deleted);
  const member = detail?.id === selected ? detail : listed;
  useEffect(() => {
    setDetail(null);
    if (!selected) return;
    let stale = false;
    let request = 0;
    const load = () => {
      const current = ++request;
      readMember(team.workspace_id, selected).then(
        (value) => !stale && current === request && setDetail(value),
        (reason) => !stale && current === request && setError(String(reason)),
      );
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [
    selected,
    team.workspace_id,
    listed?.status,
    listed?.tokens,
    listed?.revision,
    listed?.paused,
  ]);
  const availableMachines = [
    ...new Map([...machines, ...connections].map((m) => [m.id, m])).values(),
  ];
  const action = async (work: () => Promise<unknown>) => {
    try {
      await work();
      refreshTeam();
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  };
  const saveLibrary = async (sync: boolean) => {
    if (!pending || !editing?.library) return;
    setSaving(true);
    try {
      await saveLibraryMember(
        team.workspace_id,
        editing.library,
        pending.config,
        sync,
        pending.source,
      );
      setPending(null);
      setEditing(null);
      refreshTeam();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={styles.page}>
      {error && <p role="alert">{error}</p>}
      {member ? (
        <>
          {member.file_error && <p role="alert">{member.file_error}</p>}
          <div className={styles.detailHeader}>
            <IconButton
              icon={ArrowLeft}
              label={t("common.back")}
              onClick={() => go(settingsHash(team.workspace_id, "members"))}
            />
            <div className={styles.identity}>
              <MemberAvatar member={member} />
              <h2>{memberName(member, t)}</h2>
              <span>
                {t(
                  member.enabled === false
                    ? "members.disabled"
                    : member.paused
                      ? "team.status.paused"
                      : `team.status.${member.status}`,
                )}
              </span>
            </div>
            <div className={styles.toolbar}>
              <Button
                onClick={() => {
                  const dm = team.channels.find(
                    (c) => c.member_id === member.id,
                  );
                  if (dm) go(teamHash(team.workspace_id, dm.id));
                }}
                disabled={member.role === "human"}
              >
                {t("members.message")}
              </Button>
              {member.role !== "human" && (
                <MemberPause workspace={team.workspace_id} member={member} />
              )}
              {member.role !== "human" && (
                <Button onClick={() => setEditing({ member })}>
                  {t("members.edit")}
                </Button>
              )}
            </div>
          </div>
          <dl className={styles.stats}>
            <dt>{t("members.spent")}</dt>
            <dd>{(member.tokens ?? 0).toLocaleString()} token</dd>
          </dl>
          {detail && detail.id === selected && detail.attention && (
            <AttentionLine value={detail.attention} />
          )}
          {detail?.activity && (
            <>
              <h3>{t("members.activity")}</h3>
              <Prose text={detail.activity} />
            </>
          )}
          <h3>{t("members.description")}</h3>
          <div className={styles.roleDescription}>
            <Prose text={member.role_description ?? ""} />
          </div>
          {member.builtin && member.role !== "human" && (
            <Button onClick={() => setConfirm({ member, action: "restore" })}>
              {t(
                member.builtin_update_available
                  ? "members.updateBuiltin"
                  : "members.restoreBuiltin",
              )}
            </Button>
          )}
          {member.library_id && (
            <div className={styles.toolbar}>
              <Button
                onClick={() => {
                  const row = library.find((l) => l.id === member.library_id);
                  if (row) setEditing({ member, library: row });
                }}
              >
                {t("members.editLibrary")}
              </Button>
              {!!member.overrides?.length && (
                <Button
                  onClick={() =>
                    void action(() =>
                      editTeamMember(team.workspace_id, member.id, {
                        reset_overrides: true,
                      }),
                    )
                  }
                >
                  {t("members.reset")}
                </Button>
              )}
            </div>
          )}
          <h3>{t("members.subscriptions")}</h3>
          <div className={styles.checks}>
            {team.channels
              .filter((c) => !c.member_id)
              .map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={member.subscriptions?.includes(c.id) ?? false}
                    disabled={member.role === "human"}
                    onChange={(e) =>
                      void action(() =>
                        editTeamMember(team.workspace_id, member.id, {
                          subscriptions: e.target.checked
                            ? [...(member.subscriptions ?? []), c.id]
                            : member.subscriptions?.filter((id) => id !== c.id),
                        }),
                      )
                    }
                  />
                  #{c.name}
                </label>
              ))}
          </div>
          <h3>{t("members.threads")}</h3>
          <ul className={styles.list} aria-label={t("members.threads")}>
            {detail?.threads.map((thread) => (
              <li key={`${thread.channel_id}:${thread.id}`}>
                <button
                  type="button"
                  className={teamStyles.threadRow}
                  onClick={() =>
                    go(
                      teamHash(team.workspace_id, thread.channel_id, thread.id),
                    )
                  }
                >
                  <MessageSquare aria-hidden />
                  <span>{thread.text || thread.id}</span>
                  <time dateTime={thread.last_message_at}>
                    {threadDate(thread.last_message_at, locale)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className={styles.toolbar}>
            <div className={styles.search}>
              <TextField
                label={t("members.search")}
                hideLabel
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => setEditing({})}
            >
              {t("members.add")}
            </Button>
          </div>
          <ul className={`${styles.list} ${styles.roster}`}>
            {team.members
              .filter(
                (m) =>
                  !m.deleted &&
                  memberName(m, t)
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase()),
              )
              .map((m) => (
                <li key={m.id}>
                  <MemberAvatar member={m} />
                  <Button
                    variant="ghost"
                    onClick={() =>
                      go(settingsHash(team.workspace_id, `member:${m.id}`))
                    }
                  >
                    {memberName(m, t)}
                  </Button>
                  <span className={styles.summary}>{m.description ?? ""}</span>
                  <span className={styles.meta}>
                    <MemberStatus
                      status={m.status}
                      enabled={m.enabled}
                      paused={m.paused}
                    />
                    {t(
                      m.enabled === false
                        ? "members.disabled"
                        : m.paused
                          ? "team.status.paused"
                          : `team.status.${m.status}`,
                    )}
                  </span>
                  {m.role !== "human" && (
                    <Menu
                      label={t("members.actions")}
                      trigger={(props) => (
                        <IconButton
                          {...props}
                          icon={MoreHorizontal}
                          label={t("members.actions")}
                        />
                      )}
                      items={[
                        {
                          id: "edit",
                          label: t("members.edit"),
                          onSelect: () => setEditing({ member: m }),
                        },
                        {
                          id: "copy",
                          label: t("members.copy"),
                          onSelect: () =>
                            void action(() =>
                              addTeamMember(team.workspace_id, {
                                copy_from: m.id,
                              }),
                            ),
                        },
                        {
                          id: "enabled",
                          label: t(
                            m.enabled === false
                              ? "members.enable"
                              : "members.disable",
                          ),
                          onSelect: () =>
                            m.enabled === false
                              ? void action(() =>
                                  editTeamMember(team.workspace_id, m.id, {
                                    enabled: true,
                                  }),
                                )
                              : setConfirm({ member: m, action: "disable" }),
                        },
                        ...(!m.builtin
                          ? [
                              {
                                id: "delete",
                                label: t("members.delete"),
                                danger: true,
                                onSelect: () =>
                                  setConfirm({ member: m, action: "delete" }),
                              },
                            ]
                          : []),
                      ]}
                    />
                  )}
                </li>
              ))}
          </ul>
        </>
      )}
      {editing && (
        <MemberEditor
          key={editing.library?.id || editing.member?.id || "new"}
          initial={
            editing.library?.config ??
            (editing.member ? memberDraft(editing.member) : undefined)
          }
          initialError={
            editing.library?.file_error ?? editing.member?.file_error
          }
          initialSource={editing.library?.source ?? editing.member?.source}
          initialSubscriptions={editing.member?.subscriptions}
          initialAvatarSeed={
            editing.member ? memberAvatarSeed(editing.member) : undefined
          }
          initialAvatarUrl={editing.member?.avatar_url ?? undefined}
          allowUpload={!editing.library}
          role={editing.library ? "custom" : editing.member?.role}
          builtin={!!editing.member?.builtin && !editing.library}
          creating={!editing.member}
          team={team}
          library={library}
          models={models}
          machines={availableMachines}
          onClose={() => setEditing(null)}
          onSave={async (config, subscriptions, source, document, upload) => {
            if (editing.library) {
              setPending({ config, source: document });
              return;
            }
            if (editing.member)
              await editTeamMember(team.workspace_id, editing.member.id, {
                config,
                source: document,
                subscriptions,
                revision: editing.member.revision,
                avatar_upload: upload,
              });
            else
              await addTeamMember(
                team.workspace_id,
                source.startsWith("l:")
                  ? { library_id: source.slice(2), subscriptions }
                  : {
                      config,
                      source: document,
                      subscriptions,
                      avatar_upload: upload,
                      ...(source.startsWith("m:")
                        ? { copy_from: source.slice(2) }
                        : {}),
                    },
              );
            setEditing(null);
            refreshTeam();
          }}
        />
      )}
      <Dialog
        open={!!confirm}
        title={t(
          confirm?.action === "restore"
            ? "members.confirmRestoreBuiltin"
            : confirm?.action === "delete"
              ? "members.confirmDelete"
              : "members.confirmDisable",
        )}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirm)
                  void action(async () => {
                    if (confirm.action === "delete")
                      await deleteTeamMember(
                        team.workspace_id,
                        confirm.member.id,
                      );
                    else
                      await editTeamMember(
                        team.workspace_id,
                        confirm.member.id,
                        confirm.action === "restore"
                          ? {
                              restore_builtin: true,
                              revision: confirm.member.revision,
                            }
                          : { enabled: false },
                      );
                    setConfirm(null);
                  });
              }}
            >
              {t(
                confirm?.action === "restore"
                  ? confirm.member.builtin_update_available
                    ? "members.updateBuiltin"
                    : "members.restoreBuiltin"
                  : confirm?.action === "delete"
                    ? "members.delete"
                    : "members.disable",
              )}
            </Button>
          </>
        }
      />
      <Dialog
        open={!!pending}
        title={t("members.confirmSync")}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={saving} onClick={() => void saveLibrary(false)}>
              {t("members.libraryOnly")}
            </Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => void saveLibrary(true)}
            >
              {t("members.sync")}
            </Button>
          </>
        }
      />
    </div>
  );
}
