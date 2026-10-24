import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import { serviceReason } from "../../reader/service-error";
import { Button, Spinner } from "../../ui";
import styles from "./LayoutInstall.module.css";
import settingsStyles from "./Settings.module.css";

/** `GET /api/v1/layout-install`: the on-demand BabelDOC install of the local build. */
export interface LayoutInstallState {
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  stage: "" | "environment" | "engine" | "assets" | "finish";
  progress: number;
  error: string;
  /** Only the local build installs anything; the hosted site has it built in. */
  supported: boolean;
  installed: boolean;
  available: boolean;
}

const STAGES: Record<Exclude<LayoutInstallState["stage"], "">, MessageKey> = {
  environment: "settings.layoutInstall.stage.environment",
  engine: "settings.layoutInstall.stage.engine",
  assets: "settings.layoutInstall.stage.assets",
  finish: "settings.layoutInstall.stage.finish",
};

const POLL = 1000;

/**
 * Settings → layout translation, in the local build: installs BabelDOC into its
 * own environment on this computer, shows how far it has got, and can stop it.
 * Renders nothing where nothing needs installing (the hosted site). When the
 * install finishes, the reader's translation settings are read again, so the
 * translated view can start right away.
 */
export function LayoutInstall({
  onInstalled,
  compact = false,
}: {
  onInstalled?(): void;
  /** Inside a panel that already says what layout translation is: only the button, progress and errors, centred. */
  compact?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [state, setState] = useState<LayoutInstallState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = state?.status === "running";
  const wasRunning = useRef(false);

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      api<LayoutInstallState>("/layout-install", { signal }).then(
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
    api<LayoutInstallState>(path, { method: "POST" })
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
      aria-label={compact ? undefined : t("settings.layoutInstall.title")}
    >
      {!compact && (
        <>
          <div className={styles.head}>
            <h3 className={styles.title}>
              {t("settings.layoutInstall.title")}
            </h3>
            {state.installed && (
              <span className={styles.badge}>
                {t("settings.layoutInstall.installed")}
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
                {t("settings.layoutInstall.percent", {
                  percent: state.progress,
                })}
              </span>
            </p>
            <div
              className={styles.track}
              role="progressbar"
              aria-label={t("settings.layoutInstall.progress")}
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
              onClick={() => act("/layout-install/cancel")}
            >
              {t("settings.layoutInstall.cancel")}
            </Button>
          </div>
        </>
      ) : state.installed ? null : (
        <>
          {state.status === "failed" && (
            <>
              <p className={styles.error} role="alert">
                {t("settings.layoutInstall.failed")}
              </p>
              {state.error && (
                <pre className={styles.details}>{state.error}</pre>
              )}
            </>
          )}
          {state.status === "cancelled" && (
            <p className={styles.note}>
              {t("settings.layoutInstall.cancelled")}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => act("/layout-install")}
            >
              {state.status === "failed"
                ? t("common.retry")
                : t("settings.layoutInstall.start")}
            </Button>
            {state.status !== "failed" && (
              <span className={styles.note}>
                {t("settings.layoutInstall.size")}
              </span>
            )}
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
