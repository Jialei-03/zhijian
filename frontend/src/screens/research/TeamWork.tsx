import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { followLink } from "../../reader/route";
import { MemberAvatar } from "../team/MemberEditor";
import { memberName } from "../team/member-model";
import { colleagueTask } from "./TeamMemberCard";
import { shortDuration } from "./process/model";
import { TEAM_EVENT, teamHash, type Team } from "./team-api";
import {
  getTeamWork,
  workGroups,
  type AttentionMetrics,
  type TeamWork,
  type WorkItem,
} from "./team-work-api";
import styles from "./TeamWork.module.css";

export function AttentionLine({ value }: { value: AttentionMetrics }) {
  const { t, tn, locale } = useI18n();
  return (
    <div className={styles.attention} aria-label={t("team.work.attention")}>
      <span>{tn("team.work.asks", value.asks)}</span>
      <span>
        {t("team.work.median", {
          value:
            value.median_wait_seconds === null
              ? "—"
              : shortDuration(value.median_wait_seconds, t),
        })}
      </span>
      <span>
        {t("team.work.share", {
          value:
            value.waiting_share === null
              ? "—"
              : new Intl.NumberFormat(locale, {
                  style: "percent",
                  maximumFractionDigits: 1,
                }).format(value.waiting_share),
        })}
      </span>
      {value.partial && <span>{t("team.work.partial")}</span>}
    </div>
  );
}

export function TeamWorkView({
  team,
  work,
  go,
}: {
  team: Team;
  work: TeamWork;
  go(hash: string): void;
}) {
  const { t, tn } = useI18n();
  const members = new Map(team.members.map((m) => [m.id, m]));
  const row = (item: WorkItem) => {
    const status =
      item.status === "working"
        ? colleagueTask(item.current_step, t)
        : t(`team.work.${item.status}`);
    return (
      <li key={item.id}>
        <a
          className={styles.row}
          href={`#${teamHash(team.workspace_id, item.channel_id, item.thread_id || "")}`}
          onClick={followLink(
            go,
            teamHash(team.workspace_id, item.channel_id, item.thread_id || ""),
          )}
        >
          <span className={styles.avatars}>
            {item.member_ids.slice(0, 3).map((id) => {
              const assignee = members.get(id);
              return assignee ? (
                <span key={id} title={memberName(assignee, t)}>
                  <MemberAvatar member={assignee} size="sm" />
                </span>
              ) : null;
            })}
          </span>
          <span className={styles.content}>
            <span className={styles.title}>{item.title}</span>
            <span className={styles.status}>{status}</span>
          </span>
          {!!item.stuck.length && (
            <span className={styles.stuck}>{t("team.work.stuck")}</span>
          )}
          <span className={styles.elapsed}>
            {shortDuration(item.elapsed_seconds, t)}
          </span>
        </a>
      </li>
    );
  };
  return (
    <div className={styles.page} data-testid="team-work">
      <div className={styles.body}>
        <h2>
          {work.counts.waiting
            ? tn("team.work.headline", work.counts.waiting)
            : t("team.work.clear")}
        </h2>
        <AttentionLine value={work.attention.total} />
        {!!work.attention.researches.length && (
          <details className={styles.researches}>
            <summary>{t("team.work.researches")}</summary>
            {work.attention.researches.map((value) => (
              <section key={value.research_id}>
                <h3>{value.title}</h3>
                <AttentionLine value={value} />
              </section>
            ))}
          </details>
        )}
        {workGroups.map((group) => {
          const items = work.items.filter((item) => item.group === group);
          if (!items.length) return null;
          const label = tn(`team.work.group.${group}`, items.length);
          return group === "done" ? (
            <details className={styles.group} key={group}>
              <summary>{label}</summary>
              <ul>{items.map(row)}</ul>
            </details>
          ) : (
            <section className={styles.group} key={group} aria-label={label}>
              <h2>{label}</h2>
              <ul>{items.map(row)}</ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function TeamWorkScreen({
  team,
  go,
}: {
  team: Team;
  go(hash: string): void;
}) {
  const [work, setWork] = useState<TeamWork | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false;
    let request = 0;
    setWork(null);
    setError("");
    const load = () => {
      const current = ++request;
      getTeamWork(team.workspace_id).then(
        (value) => {
          if (!stale && current === request) {
            setWork(value);
            setError("");
          }
        },
        (reason: unknown) => {
          if (!stale && current === request) setError(String(reason));
        },
      );
    };
    load();
    const timer = window.setInterval(load, 5000);
    window.addEventListener(TEAM_EVENT, load);
    return () => {
      stale = true;
      window.clearInterval(timer);
      window.removeEventListener(TEAM_EVENT, load);
    };
  }, [team.workspace_id]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {work ? (
        <TeamWorkView team={team} work={work} go={go} />
      ) : (
        <div className={styles.loading} aria-busy="true" />
      )}
    </>
  );
}
