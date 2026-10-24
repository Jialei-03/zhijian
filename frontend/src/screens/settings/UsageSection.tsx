import { useEffect, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n/I18nProvider";
import { failure } from "../setup/model-api";
import { Section, formatCount } from "./Section";
import styles from "./Settings.module.css";

type Usage = {
  requests: number;
  total_tokens: number;
  unknown_requests: number;
  budgets?: {
    scope: "shared" | "private";
    limit_tokens: number;
    charged_tokens: number;
  }[];
};

/** Today's requests to the models and the tokens they used. */
export function UsageSection() {
  const i18n = useI18n();
  const { t, tn, locale } = i18n;
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    api<Usage>("/model-usage", { signal: controller.signal }).then(
      setUsage,
      (reason) => {
        if (!controller.signal.aborted)
          setError(failure(reason, i18n, "settings.usage.error"));
      },
    );
    return () => controller.abort();
    // Read once per visit.
  }, []);

  const count = (value: number) => formatCount(value, locale);
  return (
    <Section hideHeading title={t("settings.usage.title")}>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : !usage ? (
        <div
          className={styles.skeleton}
          role="status"
          aria-label={t("common.loading")}
        />
      ) : (
        <div className={styles.card}>
          <div className={styles.settingDetails}>
            <dl className={styles.figures}>
              <div className={styles.figure}>
                <dt>{t("settings.usage.requests")}</dt>
                <dd>{count(usage.requests)}</dd>
              </div>
              <div className={styles.figure}>
                <dt>{t("settings.usage.tokens")}</dt>
                <dd>{count(usage.total_tokens)}</dd>
              </div>
              {usage.budgets
                ?.filter((budget) => budget.limit_tokens > 0)
                .map((budget) => (
                  <div key={budget.scope} className={styles.figure}>
                    <dt>
                      {t(
                        budget.scope === "shared"
                          ? "settings.usage.budgetShared"
                          : "settings.usage.budgetPrivate",
                      )}
                    </dt>
                    <dd>
                      {count(budget.charged_tokens)} /{" "}
                      {count(budget.limit_tokens)}
                    </dd>
                  </div>
                ))}
            </dl>
            {usage.unknown_requests > 0 && (
              <p className={styles.muted}>
                {tn("settings.usage.unknown", usage.unknown_requests)}
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
