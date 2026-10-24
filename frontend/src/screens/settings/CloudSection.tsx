import { useEffect, useState } from "react";
import { api, send } from "../../api";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, TextField, toast } from "../../ui";
import { failure } from "../setup/model-api";
import { Section, formatDate } from "./Section";
import styles from "./Settings.module.css";

const SITE = "https://papers.dougao.online";
const POLL = 1000;

type SyncResult = {
  downloaded: number;
  uploaded: number;
  without_pdf: number;
  errors: string[];
  finished_at: string;
};

type Link = {
  connected: boolean;
  origin?: string;
  username?: string;
  expires?: string;
  last_sync?: SyncResult | null;
  sync: {
    running?: boolean;
    phase?: "listing" | "copying" | "done";
    done?: number;
    total?: number;
    error?: string;
  };
};

/**
 * The local edition linked to an account on the hosted site: sign in once
 * (only a token is kept), then copy papers each side lacks to the other.
 */
export function CloudSection() {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const [link, setLink] = useState<Link | null>(null);
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState(SITE);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const running = !!link?.sync.running;

  useEffect(() => {
    const controller = new AbortController();
    api<Link>("/cloud-link", { signal: controller.signal }).then(
      setLink,
      (reason) => {
        if (!controller.signal.aborted)
          setError(failure(reason, i18n, "settings.loadError"));
      },
    );
    return () => controller.abort();
    // Read once per visit; a running sync is followed below.
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(
      () => api<Link>("/cloud-link").then(setLink, () => undefined),
      POLL,
    );
    return () => window.clearTimeout(timer);
  }, [running, link]);

  const act = async (work: () => Promise<Link>) => {
    setBusy(true);
    try {
      setLink(await work());
      setPassword("");
    } catch (reason) {
      toast.show({
        tone: "error",
        message: failure(reason, i18n, "settings.cloud.failed"),
      });
    } finally {
      setBusy(false);
    }
  };

  const last = link?.last_sync;
  return (
    <Section hideHeading title={t("settings.cloud.title")}>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : !link ? (
        <div
          className={styles.skeleton}
          role="status"
          aria-label={t("common.loading")}
        />
      ) : !link.connected ? (
        <form
          className={`${styles.card} ${styles.cloudForm}`}
          onSubmit={(event) => {
            event.preventDefault();
            void act(() =>
              send("/cloud-link", {
                origin: origin.trim(),
                username: username.trim(),
                password,
              }),
            );
          }}
        >
          <TextField
            label={t("settings.cloud.origin")}
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            required
          />
          <TextField
            label={t("settings.cloud.username")}
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <TextField
            label={t("settings.cloud.password")}
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <div>
            <Button type="submit" variant="primary" loading={busy}>
              {t("settings.cloud.connect")}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.card}>
          <div className={styles.settingDetails}>
            <p className={styles.muted}>
              {t("settings.cloud.connected", {
                username: link.username ?? "",
                origin: link.origin ?? "",
                date: formatDate(link.expires ?? "", locale),
              })}
            </p>
            <div className={styles.cloudActions}>
              <Button
                variant="primary"
                disabled={busy}
                loading={running}
                onClick={() =>
                  void act(() =>
                    api<Link>("/cloud-link/sync", { method: "POST" }),
                  )
                }
              >
                {running
                  ? t("settings.cloud.syncingButton")
                  : t("settings.cloud.sync")}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || running}
                onClick={() =>
                  void act(() => api<Link>("/cloud-link", { method: "DELETE" }))
                }
              >
                {t("settings.cloud.disconnect")}
              </Button>
            </div>
            {running && <SyncProgress sync={link.sync} />}
            {link.sync.error && (
              <p role="alert" className={styles.error}>
                {link.sync.error}
              </p>
            )}
            {last && !running && (
              <div aria-live="polite">
                <p className={styles.muted}>
                  {t("settings.cloud.result", {
                    date: formatDate(last.finished_at, locale),
                    downloaded: last.downloaded,
                    uploaded: last.uploaded,
                  })}
                  {last.without_pdf > 0 &&
                    " " +
                      t("settings.cloud.withoutPdf", { n: last.without_pdf })}
                </p>
                {last.errors.map((line) => (
                  <p key={line} role="alert" className={styles.error}>
                    {line}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

/** How far a running sync got: reading both libraries first, then copying. */
function SyncProgress({ sync }: { sync: Link["sync"] }) {
  const { t } = useI18n();
  const total = sync.total ?? 0;
  const done = sync.done ?? 0;
  const copying = sync.phase === "copying" && total > 0;
  return (
    <div className={styles.cloudProgress} aria-live="polite">
      <div
        className={styles.meter}
        role="progressbar"
        aria-label={t("settings.cloud.sync")}
        aria-valuemin={0}
        aria-valuemax={copying ? total : undefined}
        aria-valuenow={copying ? done : undefined}
      >
        {copying ? (
          <div
            className={styles.meterFill}
            style={{ transform: `scaleX(${done / total})` }}
          />
        ) : (
          <div className={styles.meterBusy} />
        )}
      </div>
      <p className={styles.muted}>
        {copying
          ? t("settings.cloud.syncing", { done, total })
          : t("settings.cloud.listing")}
      </p>
    </div>
  );
}
