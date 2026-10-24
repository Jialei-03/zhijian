import { useCallback, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog } from "../../ui";
import { ChangeNumbers, DiffDialog } from "./ChangeCards";
import {
  readTeamDiff,
  refreshTeam,
  revertTeamMessage,
  type TeamMessage,
} from "./team-api";
import styles from "./Team.module.css";

export function changeError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  try {
    const detail = JSON.parse(message);
    if (typeof detail.message === "string")
      return [
        detail.message,
        ...(Array.isArray(detail.conflicts) ? detail.conflicts : []),
      ].join(" · ");
  } catch {
    /* Plain API error. */
  }
  return message;
}

export function TeamMessageChanges({
  workspace,
  message,
}: {
  workspace: string;
  message: TeamMessage;
}) {
  const { t, tn } = useI18n();
  const [view, setView] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revertedBy, setRevertedBy] = useState("");
  const loadDiff = useCallback(
    (path: string) => readTeamDiff(workspace, message.id, path),
    [workspace, message.id],
  );
  const changes = message.data.changes;
  if (!changes?.files.length) return null;
  const reverted = message.data.reverted_by || revertedBy;
  return (
    <div
      className={styles.messageChanges}
      role="group"
      aria-label={tn("team.changes.files", changes.files.length)}
    >
      <span>{tn("team.changes.files", changes.files.length)}</span>
      <ChangeNumbers changes={changes} />
      <div className={styles.changeActions}>
        <Button variant="ghost" size="sm" onClick={() => setView(true)}>
          {t("team.changes.view")}
        </Button>
        {reverted ? (
          <span role="status">{t("team.changes.reverted")}</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError("");
              setConfirm(true);
            }}
          >
            {t("research.changes.undo")}
          </Button>
        )}
      </div>
      {view && (
        <DiffDialog
          changes={changes}
          loadDiff={loadDiff}
          onClose={() => setView(false)}
        />
      )}
      {confirm && (
        <Dialog
          open
          size="sm"
          title={t("team.changes.confirm")}
          dismissible={!busy}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const updated = await revertTeamMessage(
                      workspace,
                      message.id,
                    );
                    setRevertedBy(updated.data.reverted_by || "");
                    setConfirm(false);
                    refreshTeam();
                  } catch (reason) {
                    setError(changeError(reason));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("research.changes.undo")}
              </Button>
            </>
          }
        >
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </div>
  );
}
