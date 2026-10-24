import { MemberAvatar } from "../team/MemberEditor";
import { TeamMemberCard, colleagueStatus } from "./TeamMemberCard";
import { followLink } from "../../reader/route";
import { memberName } from "../team/member-model";
import {
  Bell,
  ClipboardList,
  Hash,
  MessageSquare,
  Plus,
  Settings,
} from "lucide-react";
import { useCallback, useContext, useEffect, useState } from "react";
import { parseAppRoute } from "../../app/routes";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import {
  Button,
  Dialog,
  IconButton,
  SidebarItem,
  SidebarSection,
  TextField,
} from "../../ui";
import {
  createChannel,
  getTeam,
  refreshTeam,
  TEAM_EVENT,
  teamHash,
  type Team,
  type TeamMember,
} from "./team-api";
import { ResearchAttention, useResearchNavigation } from "./ResearchNavigation";
import { AppActions } from "../../app/AppSidebar";
import { sidebarId } from "../../app/sidebar-entries";
import {
  MESSAGE_FIRST,
  pageRows,
  sidebarPageKey,
  SidebarPagination,
  useSidebarPage,
} from "../../app/sidebar-pagination";
import { WorkspacePicker } from "./WorkspaceDialogs";
import styles from "./Team.module.css";
import { defaultChannelNames, threadDate } from "./team-model";
import nav from "./TeamNavigation.module.css";

export function useTeam(id: string) {
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    setTeam(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let stale = false;
    getTeam(id).then(
      (value) => {
        if (!stale) {
          setTeam(value);
          setError("");
        }
      },
      (reason: unknown) => {
        if (!stale) setError(String(reason));
      },
    );
    return () => {
      stale = true;
    };
  }, [id, revision]);
  useEffect(() => {
    const timer = window.setInterval(reload, 1000);
    window.addEventListener(TEAM_EVENT, reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener(TEAM_EVENT, reload);
    };
  }, [reload]);
  return { team, error, reload };
}

export function useTeamWorkspace(hash: string) {
  const { data } = useResearchNavigation();
  const route = parseAppRoute(hash);
  if (route.screen === "team") return route.workspaceId;
  if (route.screen === "research")
    return (
      data.workspaces.find((w) =>
        w.researches.some((r) => r.id === route.projectId),
      )?.id || ""
    );
  if (
    (route.screen === "new-research" ||
      route.screen === "workspaces" ||
      route.screen === "projects") &&
    route.workspaceId
  )
    return route.workspaceId;
  return data.workspaces.find((w) => !w.archived)?.id || "";
}

export function TeamSwitcher({
  hash,
  go,
}: {
  hash: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const id = useTeamWorkspace(hash);
  return (
    <div className={styles.switcher}>
      <WorkspacePicker
        value={id}
        data-id={sidebarId("workspace")}
        label={t("team.switch")}
        onChange={(next) => go(teamHash(next))}
      />
    </div>
  );
}

export function MemberStatus({
  status,
  enabled,
  paused,
}: Pick<TeamMember, "status" | "enabled" | "paused">) {
  const { t } = useI18n();
  const state = enabled === false ? "disabled" : paused ? "paused" : status;
  return (
    <span
      className={styles.status}
      data-status={state}
      role="img"
      aria-label={t(
        state === "disabled" ? "members.disabled" : `team.status.${state}`,
      )}
    />
  );
}

export function TeamNavigation({
  hash,
  go,
}: {
  hash: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const id = useTeamWorkspace(hash);
  const { team, error, reload } = useTeam(id);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <>
      <TeamConversationList
        team={team}
        id={id}
        hash={hash}
        go={go}
        onCreate={() => {
          setCreating(true);
          setName("");
          setFailure("");
        }}
      />
      {error && (
        <Button variant="ghost" onClick={reload}>
          {t("common.retry")}
        </Button>
      )}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t("team.addChannel")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!name.trim()}
              onClick={async () => {
                setSaving(true);
                try {
                  await createChannel(id, name);
                  setCreating(false);
                  refreshTeam();
                } catch (e) {
                  setFailure(String(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              {t("projects.save")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("team.channelName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {failure && <p role="alert">{failure}</p>}
      </Dialog>
    </>
  );
}

function UnreadBadge({ count }: { count: number }) {
  const { t } = useI18n();
  return count > 0 ? (
    <span className={nav.badge} aria-label={t("team.unreadCount", { count })}>
      {count}
    </span>
  ) : null;
}

export function TeamConversationList({
  team,
  id,
  hash,
  go,
  onCreate,
}: {
  team: Team | null;
  id: string;
  hash: string;
  go(hash: string): void;
  onCreate(): void;
}) {
  const { t, tn, locale } = useI18n();
  const { owner = "" } = useContext(AppActions);
  const [limit, choose] = useSidebarPage(
    sidebarPageKey(owner, id, "messages"),
    MESSAGE_FIRST,
  );
  const route = parseAppRoute(hash);
  const members = new Map(team?.members.map((member) => [member.id, member]));
  const channels = (team?.channels || [])
    .filter(
      (channel) =>
        !channel.member_id ||
        (members.has(channel.member_id) &&
          !members.get(channel.member_id)!.deleted),
    )
    .sort(
      (a, b) =>
        (Date.parse(b.last_at ?? "") || 0) -
          (Date.parse(a.last_at ?? "") || 0) || a.id.localeCompare(b.id),
    );
  const selectedChannel =
    route.screen === "team"
      ? team?.channels.find(
          (channel) =>
            channel.id === route.channelId ||
            channel.key === (route.channelId || "experiments"),
        )
      : undefined;
  const current = (channel: string) =>
    route.screen === "team" &&
    (route.channelId === channel || selectedChannel?.id === channel);
  const { rows, hidden } = pageRows(
    channels,
    limit,
    (channel) =>
      current(channel.id) ||
      !!channel.working_member_ids?.length ||
      channel.unread > 0,
  );
  const avatar = (member: TeamMember) => (
    <span className={nav.memberAvatar}>
      <MemberAvatar member={member} />
      <MemberStatus
        status={member.status}
        enabled={member.enabled}
        paused={member.paused}
      />
    </span>
  );
  return (
    <div className={nav.navigation}>
      <SidebarSection>
        {(
          [
            ["threads", MessageSquare, team?.threads_unread || 0],
            [
              "mentions",
              Bell,
              team?.activity_unread ?? team?.mentions_unread ?? 0,
            ],
          ] as const
        ).map(([key, icon, count]) => (
          <div key={key} className={nav.shortcut}>
            <SidebarItem
              data-id={sidebarId(key === "mentions" ? "activity" : "threads")}
              icon={icon}
              label={t(key === "mentions" ? "team.activity" : "team.threads")}
              href={id ? `#${teamHash(id, key)}` : undefined}
              disabled={!id}
              active={current(key)}
              onClick={followLink(go, teamHash(id, key))}
            />
            <UnreadBadge count={count} />
          </div>
        ))}
      </SidebarSection>
      <SidebarItem
        data-id={sidebarId("work")}
        icon={ClipboardList}
        label={t("team.work.title")}
        href={id ? `#${teamHash(id, "work")}` : undefined}
        disabled={!id}
        active={current("work")}
        onClick={followLink(go, teamHash(id, "work"))}
      />
      <ResearchAttention go={go} />
      <div className={nav.heading} data-sidebar-place="messages">
        <span id="team-conversations">{t("team.messages")}</span>
        <IconButton
          data-id={sidebarId("create-channel")}
          disabled={!id}
          icon={Plus}
          label={t("team.addChannel")}
          onClick={onCreate}
        />
      </div>
      <div
        className={nav.conversations}
        data-sidebar-place="messages"
        data-id={sidebarId("messages")}
        role="group"
        aria-labelledby="team-conversations"
      >
        {rows.map((channel) => {
          const member = channel.member_id
            ? members.get(channel.member_id)
            : undefined;
          const name = member
            ? memberName(member, t)
            : defaultChannelNames[channel.key] === channel.name
              ? t(`team.channel.${channel.key}` as MessageKey)
              : channel.name;
          // Empty messages (a run that said nothing) leave no preview.
          const last = channel.last_message?.text?.trim()
            ? channel.last_message
            : undefined;
          const author = last?.author_id
            ? members.get(last.author_id)
            : undefined;
          const authorName = author ? memberName(author, t) : last?.author_name;
          const activeMember =
            member && ["working", "queued"].includes(member.status)
              ? member
              : channel.working_member_ids
                  ?.map((id) => members.get(id))
                  .find(
                    (item) =>
                      item && ["working", "queued"].includes(item.status),
                  );
          // A run can be active while the member reads "waiting" or "idle"; the preview still says it is working.
          const working =
            !!activeMember || !!channel.working_member_ids?.length;
          const target = teamHash(id, channel.id);
          return (
            <div key={channel.id} className={nav.conversationRow}>
              <a
                className={nav.conversation}
                data-id={sidebarId("conversation")}
                href={`#${target}`}
                aria-label={name}
                aria-current={current(channel.id) ? "page" : undefined}
                onClick={followLink(go, target)}
              >
                {member ? (
                  <span className={nav.memberAvatar} aria-hidden />
                ) : (
                  <span className={nav.channelAvatar}>
                    <Hash size={16} aria-hidden="true" />
                  </span>
                )}
                <span className={nav.content}>
                  <span className={nav.line}>
                    <span className={nav.name}>{name}</span>
                    {channel.last_at && (
                      <time dateTime={channel.last_at}>
                        {threadDate(
                          channel.last_at,
                          locale,
                          new Date(),
                          "conversation",
                        )}
                      </time>
                    )}
                  </span>
                  <span className={nav.line}>
                    <span
                      className={nav.preview}
                      data-working={working || undefined}
                    >
                      {member?.paused
                        ? t("team.status.paused")
                        : activeMember
                          ? colleagueStatus(activeMember, { t, tn })
                          : working
                            ? t("team.workingPreview")
                            : last
                              ? authorName
                                ? t("team.preview", {
                                    author: authorName,
                                    text: last.text,
                                  })
                                : last.text
                              : ""}
                    </span>
                    <UnreadBadge count={channel.unread} />
                  </span>
                </span>
              </a>
              {member && team && (
                <TeamMemberCard
                  team={team}
                  member={member}
                  className={nav.profileTrigger}
                >
                  {avatar(member)}
                </TeamMemberCard>
              )}
            </div>
          );
        })}
        <SidebarPagination
          list="messages"
          first={MESSAGE_FIRST}
          limit={limit}
          hidden={hidden}
          choose={choose}
        />
      </div>
      <div className={nav.settings} data-sidebar-place="team">
        <SidebarItem
          data-id={sidebarId("team-settings")}
          icon={Settings}
          label={t("team.settings")}
          href={id ? `#${teamHash(id, "settings")}` : undefined}
          disabled={!id}
          active={current("settings")}
          onClick={followLink(go, teamHash(id, "settings"))}
        />
      </div>
    </div>
  );
}
