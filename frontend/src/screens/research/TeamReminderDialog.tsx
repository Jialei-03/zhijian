import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog, Menu, TextField } from "../../ui";
import { remindTeamMessage, type TeamMessage } from "./team-api";
import styles from "./Team.module.css";

export type ReminderPreset = "minutes" | "hour" | "morning" | "custom";
export function reminderTime(
  preset: ReminderPreset,
  custom: string,
  now = new Date(),
) {
  if (preset === "custom") return new Date(custom);
  if (preset === "morning")
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9);
  return new Date(now.getTime() + (preset === "minutes" ? 20 : 60) * 60_000);
}
export function localReminderTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TeamReminderDialog({
  workspace,
  message,
  onClose,
}: {
  workspace: string;
  message: TeamMessage;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [preset, setPreset] = useState<ReminderPreset>("minutes");
  const [custom, setCustom] = useState(() =>
    localReminderTime(reminderTime("hour", "")),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const target = reminderTime(preset, custom);
  return (
    <Dialog
      open
      title={t("team.reminder.title")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={
              !Number.isFinite(target.getTime()) || target <= new Date()
            }
            onClick={async () => {
              setBusy(true);
              try {
                await remindTeamMessage(
                  workspace,
                  message,
                  reminderTime(preset, custom).toISOString(),
                );
                onClose();
              } catch (reason) {
                setError(String(reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("team.reminder.create")}
          </Button>
        </>
      }
    >
      <div className={styles.reminderFields}>
        <Menu
          label={t("team.reminder.time")}
          trigger={(props) => (
            <Button {...props}>{t(`team.reminder.${preset}`)}</Button>
          )}
          items={(["minutes", "hour", "morning", "custom"] as const).map(
            (value) => ({
              id: value,
              label: t(`team.reminder.${value}`),
              checked: value === preset,
              onSelect: () => setPreset(value),
            }),
          )}
        />
        {preset === "custom" && (
          <TextField
            type="datetime-local"
            label={t("team.reminder.time")}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
