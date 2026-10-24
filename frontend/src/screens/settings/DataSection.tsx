import { Copy, Download, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n/I18nProvider";
import { Button } from "../../ui";
import { failure } from "../setup/model-api";
import { LatexInstall } from "./LatexInstall";
import { LayoutInstall } from "./LayoutInstall";
import { Section, formatBytes } from "./Section";
import styles from "./Settings.module.css";

type Storage = {
  used_bytes: number;
  limit_bytes: number;
  categories: Record<string, number>;
  logs_path?: string | null;
};

/** Reading-material storage and export; research directories have their own lifecycle. */
export function DataSection() {
  const i18n = useI18n();
  const { t } = i18n;
  const [storage, setStorage] = useState<Storage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    api<Storage>("/storage-usage", { signal: controller.signal }).then(
      setStorage,
      (reason) => {
        if (!controller.signal.aborted)
          setError(failure(reason, i18n, "settings.data.error"));
      },
    );
    return () => controller.abort();
    // Read once per visit.
  }, []);

  const part = (key: string) => formatBytes(storage?.categories[key] ?? 0);
  const share = storage?.limit_bytes
    ? Math.min(1, storage.used_bytes / storage.limit_bytes)
    : 0;

  return (
    <Section hideHeading title={t("settings.data.title")}>
      <div className={styles.card}>
        {error ? (
          <p
            role="alert"
            className={`${styles.error} ${styles.settingDetails}`}
          >
            {error}
          </p>
        ) : !storage ? (
          <div
            className={`${styles.skeleton} ${styles.settingDetails}`}
            role="status"
            aria-label={t("common.loading")}
          />
        ) : (
          <div>
            <div className={styles.setting}>
              <span className={styles.settingLabel}>
                {t("settings.data.used", {
                  used: formatBytes(storage.used_bytes),
                  limit: formatBytes(storage.limit_bytes),
                })}
              </span>
            </div>
            <div className={styles.storageDetails}>
              <div
                className={styles.meter}
                role="meter"
                aria-label={t("settings.data.meter")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(share * 100)}
              >
                <div
                  className={styles.meterFill}
                  style={{ transform: `scaleX(${share})` }}
                />
              </div>
              <dl className={styles.figures}>
                <div className={styles.figure}>
                  <dt>{t("settings.data.papers")}</dt>
                  <dd>{part("papers")}</dd>
                </div>
                <div className={styles.figure}>
                  <dt>{t("settings.data.noteImages")}</dt>
                  <dd>{part("note_images")}</dd>
                </div>
                <div className={styles.figure}>
                  <dt>{t("settings.data.chat")}</dt>
                  <dd>{part("chat_attachments")}</dd>
                </div>
                <div className={styles.figure}>
                  <dt>{t("settings.data.annotations")}</dt>
                  <dd>
                    {formatBytes(
                      (storage.categories.handwriting ?? 0) +
                        (storage.categories.text_annotations ?? 0),
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}
        <div className={styles.setting}>
          <div className={styles.rowText}>
            <span className={styles.settingLabel}>
              {t("settings.data.export")}
            </span>
          </div>
          <Button
            size="sm"
            icon={Download}
            onClick={() => window.location.assign("/api/v1/export")}
          >
            {t("settings.data.exportAction")}
          </Button>
        </div>
        {storage?.logs_path && <LogFolder path={storage.logs_path} />}
        <LayoutInstall />
        <LatexInstall />
      </div>
    </Section>
  );
}

export function LogFolder({ path }: { path: string }) {
  const { t } = useI18n();
  const desktop = !!document.documentElement.dataset.desktop;
  const [error, setError] = useState("");
  return (
    <>
      <div className={styles.setting}>
        <div className={styles.rowText}>
          <span className={styles.settingLabel}>{t("settings.data.logs")}</span>
          {!desktop && <code className={styles.logPath}>{path}</code>}
        </div>
        <Button
          size="sm"
          icon={desktop ? FolderOpen : Copy}
          onClick={() => {
            if (desktop) window.location.assign("ora:logs");
            else
              void navigator.clipboard.writeText(path).then(
                () => setError(""),
                () => setError(t("settings.data.copyLogsFailed")),
              );
          }}
        >
          {t(desktop ? "settings.data.openLogs" : "settings.data.copyLogs")}
        </Button>
      </div>
      {error && (
        <p role="alert" className={`${styles.error} ${styles.settingDetails}`}>
          {error}
        </p>
      )}
    </>
  );
}
