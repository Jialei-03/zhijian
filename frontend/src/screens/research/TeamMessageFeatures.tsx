import { Forward, SmilePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog, IconButton, Menu, TextArea, toast } from "../../ui";
import {
  refreshTeam,
  sendTeamMessage,
  setTeamReaction,
  teamHash,
  type ReactionEmoji,
  type Team,
  type TeamMessage,
  type TeamMessageReference,
} from "./team-api";
import { conversationName, memberLabel } from "./team-model";
import styles from "./TeamMessageFeatures.module.css";

const emojis: ReactionEmoji[] = ["👍", "👎", "✅"];

export function ReactionPicker({
  message,
  team,
}: {
  message: TeamMessage;
  team: Team;
}) {
  const { t } = useI18n();
  return (
    <Menu
      label={t("team.react")}
      trigger={(props) => (
        <IconButton
          {...props}
          size="sm"
          icon={SmilePlus}
          label={t("team.react")}
        />
      )}
      items={emojis.map((emoji) => ({
        id: emoji,
        label: emoji,
        onSelect: () => void toggleReaction(team, message, emoji),
      }))}
    />
  );
}

async function toggleReaction(
  team: Team,
  message: TeamMessage,
  emoji: ReactionEmoji,
) {
  try {
    await setTeamReaction(
      team.workspace_id,
      message.id,
      emoji,
      !!message.reactions?.find((reaction) => reaction.emoji === emoji)?.mine,
    );
    refreshTeam();
  } catch (reason) {
    toast.show({ message: String(reason), tone: "error" });
  }
}

export function MessageReactions({
  message,
  team,
}: {
  message: TeamMessage;
  team: Team;
}) {
  const { tn } = useI18n();
  if (!message.reactions?.length) return null;
  return (
    <div className={styles.reactions}>
      {message.reactions.map((reaction) => (
        <Button
          key={reaction.emoji}
          variant="ghost"
          size="sm"
          aria-pressed={reaction.mine}
          aria-label={`${reaction.emoji} ${tn("team.reactionCount", reaction.count)}`}
          onClick={() => void toggleReaction(team, message, reaction.emoji)}
        >
          {reaction.emoji} {reaction.count}
        </Button>
      ))}
    </div>
  );
}

export function MessageReference({
  reference,
  team,
  kind,
  onLocate,
}: {
  onLocate?(reference: TeamMessageReference): void;
  reference: TeamMessageReference;
  team: Team;
  kind: "forward" | "quote";
}) {
  const { t, locale } = useI18n();
  const author = team.members.find(
    (member) => member.id === reference.author_id,
  );
  return (
    <a
      className={styles.reference}
      data-testid={`team-${kind}`}
      href={`#${teamHash(team.workspace_id, reference.channel_id, reference.thread_id || reference.message_id)}`}
      aria-label={t("team.viewOriginal")}
      onClick={
        onLocate
          ? (event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onLocate(reference);
            }
          : undefined
      }
    >
      <span className={styles.referenceHeader}>
        <span>{t(`team.${kind}`)}</span>
        <strong>
          {memberLabel(author, t) || reference.author_name || t("team.system")}
        </strong>
        <time dateTime={reference.created_at}>
          {new Date(reference.created_at).toLocaleString(locale)}
        </time>
      </span>
      <span className={styles.excerpt}>{reference.text}</span>
    </a>
  );
}

export function QuoteSelection({
  children,
  onQuote,
}: {
  children: ReactNode;
  onQuote?(text: string): void;
}) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    if (!onQuote) return;
    const read = () => {
      const selection = window.getSelection();
      setSelected(
        selection &&
          !selection.isCollapsed &&
          content.current?.contains(selection.anchorNode) &&
          content.current?.contains(selection.focusNode)
          ? selection.toString().trim()
          : "",
      );
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [onQuote]);
  return (
    <>
      <div ref={content} data-message-text>
        {children}
      </div>
      {selected && onQuote && (
        <Button
          size="sm"
          variant="ghost"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onQuote(selected);
            window.getSelection()?.removeAllRanges();
            setSelected("");
          }}
        >
          {t("team.quote")}
        </Button>
      )}
    </>
  );
}

export function QuoteDraft({
  quote,
  onClear,
}: {
  quote: TeamMessageReference;
  onClear(): void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.quoteDraft} data-testid="team-quote-draft">
      <span>{quote.author_name}</span>
      <span className={styles.excerpt}>{quote.text}</span>
      <IconButton
        size="sm"
        icon={X}
        label={t("team.removeQuote")}
        onClick={onClear}
      />
    </div>
  );
}

export function ForwardMessageDialog({
  team,
  message,
  onClose,
}: {
  team: Team;
  message: TeamMessage;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const client = useRef(crypto.randomUUID());
  const channels = team.channels.filter((channel) => {
    if (!channel.member_id) return true;
    const member = team.members.find(
      (member) => member.id === channel.member_id,
    );
    return member && member.enabled !== false && !member.deleted;
  });
  return (
    <Dialog
      open
      title={t("team.forward")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            icon={Forward}
            disabled={!target || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await sendTeamMessage(team.workspace_id, target, {
                  text: note,
                  forward_message_id: message.id,
                  mode: "queue",
                  client_id: client.current,
                });
                refreshTeam();
                onClose();
              } catch (reason) {
                toast.show({ message: String(reason), tone: "error" });
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("team.forward")}
          </Button>
        </>
      }
    >
      <div className={styles.forwardForm}>
        <Menu
          label={t("team.forwardTo")}
          trigger={(props) => (
            <Button {...props} disabled={busy}>
              {target
                ? conversationName(
                    channels.find((channel) => channel.id === target),
                    team.members,
                    t,
                  )
                : t("team.forwardTo")}
            </Button>
          )}
          items={channels.map((channel) => ({
            id: channel.id,
            label: conversationName(channel, team.members, t),
            checked: target === channel.id,
            onSelect: () => {
              setTarget(channel.id);
              client.current = crypto.randomUUID();
            },
          }))}
        />
        <TextArea
          label={t("team.forwardNote")}
          value={note}
          maxLength={12000}
          disabled={busy}
          onChange={(event) => {
            setNote(event.target.value);
            client.current = crypto.randomUUID();
          }}
        />
      </div>
    </Dialog>
  );
}
