import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, IconButton } from "../../ui";
import { memberName } from "../team/member-model";
import type { Team, TeamCatchup as Catchup } from "./team-api";
import { TeamFileCard } from "./TeamSidePanel";
import styles from "./TeamCatchup.module.css";

export function TeamCatchup({
  team,
  summary,
  onFile,
  onJump,
}: {
  team: Team;
  summary: Catchup;
  onFile(path: string): void;
  onJump(): void;
}) {
  const { t, tn, locale } = useI18n();
  const [open, setOpen] = useState(true);
  const name = (id: string | null) => {
    const member = team.members.find((member) => member.id === id);
    return member ? memberName(member, t) : t("team.system");
  };
  if (!summary.show) return null;
  return (
    <section
      className={styles.summary}
      aria-label={t("team.catchup.title")}
      data-testid="team-catchup"
    >
      <header>
        <strong>{t("team.catchup.title")}</strong>
        <IconButton
          size="sm"
          icon={open ? ChevronDown : ChevronRight}
          label={t(open ? "team.catchup.collapse" : "team.catchup.expand")}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        />
      </header>
      {open && (
        <div className={styles.events}>
          {summary.new_messages > 0 && (
            <span>{tn("team.catchup.messages", summary.new_messages)}</span>
          )}
          {summary.completed.map((item) => (
            <span key={item.member_id}>
              {tn("team.catchup.completed", item.count, {
                name: name(item.member_id),
              })}
            </span>
          ))}
          {summary.files.map((file) =>
            file.deleted ? (
              <span key={file.path}>
                {t("team.catchup.deleted", { path: file.name })}
              </span>
            ) : (
              <TeamFileCard key={file.path} file={file} onFile={onFile} />
            ),
          )}
          {summary.handoffs.map((item) => (
            <span key={item.message_id}>
              {t("team.catchup.handoff", {
                name: name(item.member_id),
                to: new Intl.ListFormat(locale, {
                  style: "short",
                  type: "conjunction",
                }).format(item.to.map(name)),
              })}
            </span>
          ))}
          {summary.waiting.map((item) => (
            <span key={item.message_id}>
              {t("team.catchup.waiting", {
                name: name(item.member_id),
                text: item.text,
              })}
            </span>
          ))}
          {summary.failed.map((item) => (
            <span key={item.message_id}>
              {t("team.catchup.failed", {
                name: name(item.member_id),
                text: item.text,
              })}
            </span>
          ))}
        </div>
      )}
      {summary.first_unread && (
        <Button variant="ghost" size="sm" onClick={onJump}>
          {t("team.catchup.jump")}
        </Button>
      )}
    </section>
  );
}

export function catchupAnchor(
  summary: Catchup | null,
  messages: { id: string }[],
) {
  if (!summary?.show || !messages.length) return null;
  return (
    messages.find(
      (message) =>
        message.id ===
        (summary.first_unread?.thread_id || summary.first_unread?.id),
    )?.id || messages[0].id
  );
}
