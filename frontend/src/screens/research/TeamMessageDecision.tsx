import { useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog, TextField, toast } from "../../ui";
import { decideTeamMessage, refreshTeam, type TeamMessage } from "./team-api";
import styles from "./Team.module.css";

export function canDecideMessage(message: TeamMessage) {
  return (
    ![
      "plan",
      "conclusion",
      "thread_broadcast",
      "event_reference",
      "sprint_reference",
    ].includes(message.kind) &&
    !["queued", "running"].includes(message.run?.status || "") &&
    (["result", "draft", "review"].includes(message.kind) ||
      !!message.data.files?.length ||
      !!message.data.attachments?.length ||
      !!message.data.changes?.files.length)
  );
}

export function TeamMessageDecision({
  workspace,
  message,
}: {
  workspace: string;
  message: TeamMessage;
}) {
  const { t } = useI18n();
  const form = useId();
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<TeamMessage["data"]["decision"]>();
  useEffect(() => setSaved(undefined), [message.data.decision?.event_id]);
  const decision = saved || message.data.decision;
  const decide = async (status: "accepted" | "changes_requested") => {
    if (busy || (status === "changes_requested" && !feedback.trim())) return;
    setBusy(true);
    try {
      const result = await decideTeamMessage(
        workspace,
        message.id,
        status,
        status === "changes_requested" ? feedback.trim() : "",
      );
      setSaved(result.data.decision);
      setEditing(false);
      setFeedback("");
      refreshTeam();
    } catch (error) {
      toast.show({ message: String(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  if (!canDecideMessage(message)) return null;
  return (
    <div className={styles.messageChanges}>
      {decision && (
        <span role="status">
          {t(
            decision.status === "accepted"
              ? "team.accepted"
              : "team.changesRequested",
          )}
          {decision.feedback ? ` · ${decision.feedback}` : ""}
        </span>
      )}
      <div className={styles.changeActions}>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || decision?.status === "accepted"}
          onClick={() => void decide("accepted")}
        >
          {t("team.accept")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          {t("team.requestChanges")}
        </Button>
      </div>
      {editing && (
        <Dialog
          open
          size="sm"
          title={t("team.requestChanges")}
          dismissible={!busy}
          onClose={() => setEditing(false)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                type="submit"
                form={form}
                disabled={busy || !feedback.trim()}
              >
                {t("team.requestChanges")}
              </Button>
            </>
          }
        >
          <form
            id={form}
            onSubmit={(event) => {
              event.preventDefault();
              void decide("changes_requested");
            }}
          >
            <TextField
              label={t("team.revisionFeedback")}
              value={feedback}
              required
              autoFocus
              disabled={busy}
              onChange={(event) => setFeedback(event.target.value)}
            />
          </form>
        </Dialog>
      )}
    </div>
  );
}
