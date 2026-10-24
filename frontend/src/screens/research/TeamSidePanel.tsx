import { ArrowUpRight, FileText, Inbox, Link, Pin, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { IconButton } from "../../ui";
import { MemberAvatar } from "../team/MemberEditor";
import { memberName } from "../team/member-model";
import type { Delivery, Team, TeamMessage } from "./team-api";
import styles from "./TeamSidePanel.module.css";

type ChatFile = { name: string; path?: string; url?: string };

export function TeamFileCard({
  file,
  onFile,
}: {
  file: ChatFile;
  onFile(path: string): void;
}) {
  const { t } = useI18n();
  const content = (
    <>
      <FileText aria-hidden />
      <span>{file.name}</span>
      <span className={styles.open}>{t("team.open")}</span>
    </>
  );
  return file.path ? (
    <button
      type="button"
      className={styles.file}
      aria-label={file.name}
      onClick={() => onFile(file.path!)}
    >
      {content}
    </button>
  ) : (
    <a
      className={styles.file}
      aria-label={file.name}
      href={file.url}
      target="_blank"
      rel="noreferrer"
    >
      {content}
    </a>
  );
}

export function conversationOutputs(messages: TeamMessage[]) {
  const files = new Map<string, ChatFile>();
  const sources = new Map<string, { url: string; title: string }>();
  for (const { data } of messages) {
    for (const file of data.files || []) files.set(file.path, file);
    for (const file of data.attachments || []) files.set(file.url, file);
    for (const link of [
      data.paper,
      data.citation,
      ...(data.papers || []),
      ...(data.citations || []),
    ]) {
      if (!link) continue;
      const url = typeof link === "string" ? link : link.url || link.href;
      if (!url || !/^(https?:\/\/|#|\/(?!\/))/i.test(url)) continue;
      sources.set(url, {
        url,
        title:
          (typeof link === "string" ? undefined : link.title || link.name) ||
          sources.get(url)?.title ||
          url,
      });
    }
  }
  return { files: [...files.values()], sources: [...sources.values()] };
}

export function conversationProgress(
  team: Team,
  messages: TeamMessage[],
  deliveries: Delivery[],
) {
  const progress = new Map<
    string,
    {
      member: Team["members"][number];
      messageId: string;
      status: "working" | "queued";
    }
  >();
  for (const message of messages) {
    if (!message.run || !["running", "queued"].includes(message.run.status))
      continue;
    const member = team.members.find((m) => m.id === message.author_id);
    if (
      member &&
      (message.run.status === "running" ||
        progress.get(member.id)?.status !== "working")
    )
      progress.set(member.id, {
        member,
        messageId: message.id,
        status: message.run.status === "running" ? "working" : "queued",
      });
  }
  const messageIds = new Set(messages.map((message) => message.id));
  for (const delivery of deliveries) {
    if (
      !["queued", "steering"].includes(delivery.status) ||
      progress.has(delivery.member_id) ||
      !messageIds.has(delivery.message_id)
    )
      continue;
    const member = team.members.find((m) => m.id === delivery.member_id);
    if (member)
      progress.set(member.id, {
        member,
        messageId: delivery.message_id,
        status: delivery.status === "steering" ? "working" : "queued",
      });
  }
  return [...progress.values()];
}

export function TeamSidePanel({
  team,
  messages,
  deliveries,
  onFile,
  onLocate,
  onClose,
  fileRequest,
}: {
  team: Team;
  messages: TeamMessage[];
  deliveries: Delivery[];
  onFile(path: string): void;
  onLocate(messageId: string): void;
  onClose(): void;
  fileRequest: number;
}) {
  const { t } = useI18n();
  const filesSection = useRef<HTMLElement>(null);
  const { files, sources } = conversationOutputs(messages);
  const progress = conversationProgress(team, messages, deliveries);
  const pins = [
    ...new Map(
      messages
        .filter((message) => message.pinned)
        .map((message) => [message.id, message]),
    ).values(),
  ];
  const empty =
    !progress.length && !files.length && !sources.length && !pins.length;
  useEffect(() => {
    if (fileRequest) {
      filesSection.current?.scrollIntoView({ block: "nearest" });
      filesSection.current?.focus();
    }
  }, [fileRequest]);
  return (
    <aside
      className={styles.panel}
      aria-label={t("team.sidePanel")}
      data-testid="team-side-panel"
    >
      <header className={styles.header}>
        <h2>{t("team.sidePanel")}</h2>
        <IconButton icon={X} label={t("team.hidePanel")} onClick={onClose} />
      </header>
      <div className={empty ? styles.empty : styles.sections}>
        {!!pins.length && (
          <section aria-label={t("team.pinned")}>
            <h3>{t("team.pinned")}</h3>
            {pins.map((message) => (
              <button
                key={message.id}
                type="button"
                className={styles.pin}
                aria-label={
                  message.preview || message.text || t("team.message")
                }
                data-pin-id={message.id}
                onClick={() => onLocate(message.id)}
              >
                <Pin aria-hidden />
                <span>
                  {message.text && (
                    <span>{message.preview || message.text}</span>
                  )}
                  {conversationOutputs([message]).files.map((file) => (
                    <span key={file.path || file.url}>
                      <FileText aria-hidden />
                      {file.name}
                    </span>
                  ))}
                </span>
                <ArrowUpRight aria-hidden />
              </button>
            ))}
          </section>
        )}
        {progress.length > 0 && (
          <section aria-label={t("team.progress")}>
            <h3>{t("team.progress")}</h3>
            {progress.map(({ member, messageId, status }) => (
              <button
                key={member.id}
                type="button"
                className={styles.progress}
                onClick={() => onLocate(messageId)}
              >
                <MemberAvatar member={member} size="sm" />
                <span>{memberName(member, t)}</span>
                <span className={styles.state}>
                  {t(`team.status.${status}`)}
                </span>
                <ArrowUpRight aria-hidden />
              </button>
            ))}
          </section>
        )}
        {!!files.length && (
          <section
            ref={filesSection}
            tabIndex={-1}
            aria-label={t("team.deliverables")}
          >
            <h3>{t("team.deliverables")}</h3>
            {files.map((file) => (
              <TeamFileCard
                key={file.path || file.url}
                file={file}
                onFile={onFile}
              />
            ))}
          </section>
        )}
        {!!sources.length && (
          <section aria-label={t("team.sources")}>
            <h3>{t("team.sources")}</h3>
            {sources.map((source) => (
              <a
                key={source.url}
                className={styles.source}
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                <Link aria-hidden />
                <span>{source.title}</span>
              </a>
            ))}
          </section>
        )}
        {empty && <Inbox role="img" aria-label={t("team.noOutputs")} />}
      </div>
    </aside>
  );
}
