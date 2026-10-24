import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import { serviceReason } from "../../reader/service-error";
import { Button, Spinner } from "../../ui";
import styles from "./LayoutInstall.module.css";
import settingsStyles from "./Settings.module.css";

/** `GET /api/v1/latex-install`: the on-demand Tectonic install of the local build. */
export interface LatexInstallState {
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  stage: "" | "download" | "unpack" | "assets" | "finish";
  progress: number;
  error: string;
  /** Only the local build installs anything; the hosted site compiles in its own TeX image. */
  supported: boolean;
  installed: boolean;
  available: boolean;
}

const STAGES: Record<Exclude<LatexInstallState["stage"], "">, MessageKey> = {
  download: "settings.latexInstall.stage.download",
  unpack: "settings.latexInstall.stage.unpack",
  assets: "settings.latexInstall.stage.assets",
  finish: "settings.latexInstall.stage.finish",
};

const POLL = 1000;

/**
 * Settings → LaTeX translation, in the local build: downloads the Tectonic TeX
 * engine onto this computer so arXiv papers can be translated from their LaTeX
 * source and compiled again; shows how far it has got, and can stop it. Renders
 * nothing on the hosted site. When the install finishes, the reader's
 * translation settings are read again, so the translated view can use it.
 */
export function LatexInstall({
  onInstalled,
  compact = false,
}: {
  onInstalled?(): void;
  /** Inside a panel that already says what it is for: only the button, progress and errors, centred. */
  compact?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [state, setState] = useState<LatexInstallState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = state?.status === "running";
  const wasRunning = useRef(false);

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      api<LatexInstallState>("/latex-install", { signal }).then(
        (next) => {
          setState(next);
          setError("");
        },
        (reason) => {
          if (!signal?.aborted) setError(serviceReason(reason, i18n));
        },
      ),
    [i18n],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh(), POLL);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  useEffect(() => {
    if (wasRunning.current && state?.installed) {
      window.dispatchEvent(new Event("model-settings-updated"));
      onInstalled?.();
    }
    wasRunning.current = running;
  }, [running, state?.installed, onInstalled]);

  const act = (path: string) => {
    setBusy(true);
    setError("");
    api<LatexInstallState>(path, { method: "POST" })
      .then(setState, (reason) => setError(serviceReason(reason, i18n)))
      .finally(() => setBusy(false));
  };

  if (!state)
    return error ? (
      <p className={styles.error} role="alert">
        {error}
      </p>
    ) : (
      <div
        className={compact ? undefined : settingsStyles.settingDetails}
        role="status"
        aria-label={t("common.loading")}
      >
        <Spinner />
      </div>
    );
  if (!state.supported) return null;

  const Wrapper = compact ? "div" : "section";
  return (
    <Wrapper
      className={
        compact
          ? `${styles.section} ${styles.compact}`
          : `${styles.section} ${settingsStyles.settingDetails}`
      }
      aria-label={compact ? undefined : t("settings.latexInstall.title")}
    >
      {!compact && (
        <>
          <div className={styles.head}>
            <h3 className={styles.title}>{t("settings.latexInstall.title")}</h3>
            {state.installed && (
              <span className={styles.badge}>
                {t("settings.latexInstall.installed")}
              </span>
            )}
          </div>
        </>
      )}
      {running ? (
        <>
          <div className={styles.progress}>
            <p className={styles.stage} role="status">
              <span>
                {state.stage ? t(STAGES[state.stage]) : t("common.loading")}
              </span>
              <span className={styles.percent}>
                {t("settings.latexInstall.percent", {
                  percent: state.progress,
                })}
              </span>
            </p>
            <div
              className={styles.track}
              role="progressbar"
              aria-label={t("settings.latexInstall.progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={state.progress}
            >
              <span
                className={styles.fill}
                style={{ transform: `scaleX(${state.progress / 100})` }}
              />
            </div>
          </div>
          <div className={styles.actions}>
            <Button
              variant="ghost"
              loading={busy}
              onClick={() => act("/latex-install/cancel")}
            >
              {t("settings.latexInstall.cancel")}
            </Button>
          </div>
        </>
      ) : state.installed ? null : (
        <>
          {state.status === "failed" && (
            <>
              <p className={styles.error} role="alert">
                {t("settings.latexInstall.failed")}
              </p>
              {state.error && (
                <pre className={styles.details}>{state.error}</pre>
              )}
            </>
          )}
          {state.status === "cancelled" && (
            <p className={styles.note}>
              {t("settings.latexInstall.cancelled")}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => act("/latex-install")}
            >
              {state.status === "failed"
                ? t("common.retry")
                : t("settings.latexInstall.start")}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Wrapper>
  );
}
