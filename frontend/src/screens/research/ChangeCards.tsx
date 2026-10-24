import { FileDiff } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog, Spinner } from "../../ui";
import type { CheckpointChanges } from "./research-api";
import { useChanges } from "./use-changes";
import styles from "./talk/Talk.module.css";

export function ChangeNumbers({
  changes,
}: {
  changes: Pick<CheckpointChanges, "added" | "removed">;
}) {
  return (
    <span className={styles.changeNumbers}>
      <span>+{changes.added}</span>
      <span>−{changes.removed}</span>
    </span>
  );
}

export function DiffDialog({
  changes,
  onClose,
  loadDiff,
}: {
  changes: {
    files: (Pick<
      CheckpointChanges["files"][number],
      "path" | "added" | "removed"
    > & {
      diff?: string;
      truncated?: boolean;
    })[];
  };
  onClose(): void;
  loadDiff?(path: string): Promise<{ diff: string; truncated?: boolean }>;
}) {
  const { t } = useI18n();
  return (
    <Dialog open title={t("research.changes.view")} onClose={onClose} size="lg">
      <div className={styles.diffFiles}>
        {changes.files.map((file, index) => (
          <DiffFile
            key={file.path}
            file={file}
            loadDiff={loadDiff}
            initialOpen={!loadDiff || index === 0}
          />
        ))}
      </div>
    </Dialog>
  );
}

function DiffFile({
  file,
  loadDiff,
  initialOpen,
}: {
  file: {
    path: string;
    added: number;
    removed: number;
    diff?: string;
    truncated?: boolean;
  };
  loadDiff?: (path: string) => Promise<{ diff: string; truncated?: boolean }>;
  initialOpen: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initialOpen);
  const [patch, setPatch] = useState<{ diff: string; truncated?: boolean }>();
  const [error, setError] = useState("");
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!open || !loadDiff || patch) return;
    let stale = false;
    setError("");
    loadDiff(file.path).then(
      (value) => !stale && setPatch(value),
      (reason: unknown) =>
        !stale &&
        setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      stale = true;
    };
  }, [open, file.path, loadDiff, patch, reads]);
  const value = loadDiff ? patch : file;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <code>{file.path}</code>
        <ChangeNumbers changes={file} />
      </summary>
      {open && (
        <>
          {error ? (
            <p role="alert">
              {error}{" "}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setReads((n) => n + 1)}
              >
                {t("common.retry")}
              </Button>
            </p>
          ) : (
            !value && <Spinner />
          )}
          {value?.truncated && <p>{t("research.changes.truncated")}</p>}
          {value && <pre>{value.diff}</pre>}
        </>
      )}
    </details>
  );
}

export function FilePath({ path }: { path: string }) {
  const split = path.lastIndexOf("/") + 1;
  return (
    <span className={styles.filePath} title={path}>
      <span>{path.slice(0, split)}</span>
      <span>{path.slice(split)}</span>
    </span>
  );
}

export function RoundChangesCard({
  changes,
  onReview,
}: {
  changes: CheckpointChanges;
  onReview(path?: string): void;
}) {
  const { t, tn } = useI18n();
  if (!changes.files.length) return null;
  const files = (rows: CheckpointChanges["files"]) =>
    rows.map((file) => (
      <button
        key={file.path}
        type="button"
        className={styles.changedFile}
        onClick={() => onReview(file.path)}
      >
        <FilePath path={file.path} />
        <ChangeNumbers changes={file} />
      </button>
    ));
  return (
    <article
      className={styles.checkpointCard}
      aria-label={tn("research.review.files", changes.files.length)}
    >
      <header className={styles.checkpointHead}>
        <FileDiff size={16} aria-hidden />
        <strong>{tn("research.review.files", changes.files.length)}</strong>
        <ChangeNumbers changes={changes} />
        <Button variant="secondary" size="sm" onClick={() => onReview()}>
          {t("research.review.action")}
        </Button>
      </header>
      {files(changes.files.slice(0, 3))}
      {changes.files.length > 3 && (
        <details className={styles.moreFiles}>
          <summary>
            {tn("research.review.moreFiles", changes.files.length - 3)}
          </summary>
          {files(changes.files.slice(3))}
        </details>
      )}
    </article>
  );
}

export function CheckpointCard({
  id,
  sprintId,
  refreshKey,
  onReview,
}: {
  id: string;
  sprintId: string;
  refreshKey: string;
  onReview(path?: string): void;
}) {
  const { changes } = useChanges(id, refreshKey, sprintId);
  return changes && <RoundChangesCard changes={changes} onReview={onReview} />;
}
