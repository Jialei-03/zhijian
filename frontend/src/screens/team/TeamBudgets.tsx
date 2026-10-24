import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, TextField } from "../../ui";
import { refreshTeam, saveTeamBudget, type Team } from "../research/team-api";
import styles from "./TeamSettings.module.css";

export function TeamBudgets({ team }: { team: Team }) {
  const { t, locale } = useI18n();
  const [budget, setBudget] = useState(
    team.budget || {
      max_tokens: 0,
      period_hours: 24,
      max_concurrent: 0,
    },
  );
  const [unlimited, setUnlimited] = useState({
    max_tokens: !budget.max_tokens,
    max_concurrent: !budget.max_concurrent,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className={styles.budgets}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await saveTeamBudget(team.workspace_id, budget);
          refreshTeam();
        } catch (reason) {
          setError(String(reason));
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={saving}>
        <legend>{t("team.budgets")}</legend>
        {(
          [
            ["max_tokens", "team.tokenLimit"],
            ["period_hours", "team.periodHours"],
            ["max_concurrent", "team.concurrent"],
          ] as const
        )
          .filter(([key]) => key !== "period_hours" || !unlimited.max_tokens)
          .map(([key, label]) => (
            <div className={styles.budgetField} key={key}>
              {key !== "period_hours" && unlimited[key] ? (
                <span className={styles.budgetLabel}>{t(label)}</span>
              ) : (
                <TextField
                  label={t(label)}
                  type="number"
                  required
                  min={1}
                  max={key === "period_hours" ? 8760 : undefined}
                  step={1}
                  value={budget[key]}
                  onChange={(event) =>
                    setBudget({ ...budget, [key]: Number(event.target.value) })
                  }
                />
              )}
              {key !== "period_hours" && (
                <label className={styles.unlimited}>
                  <input
                    type="checkbox"
                    aria-label={`${t(label)} ${t("team.unlimited")}`}
                    checked={unlimited[key]}
                    onChange={(event) => {
                      setUnlimited({
                        ...unlimited,
                        [key]: event.target.checked,
                      });
                      setBudget({
                        ...budget,
                        [key]: event.target.checked
                          ? 0
                          : {
                              max_tokens: 12000000,
                              max_concurrent: 1,
                            }[key],
                      });
                    }}
                  />
                  {t("team.unlimited")}
                </label>
              )}
            </div>
          ))}
        <p>
          {t("team.tokensUsed", {
            n: (team.tokens ?? 0).toLocaleString(locale),
          })}
        </p>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" variant="primary" disabled={saving}>
        {t("projects.save")}
      </Button>
    </form>
  );
}
