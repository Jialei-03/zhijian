import { Check, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog, IconButton, Menu, Spinner, toast } from "../../ui";
import { ChangeNumbers, FilePath } from "./ChangeCards";
import { initiallyExpanded, unifiedLines } from "./change-diff";
import {
  undoRound,
  type CheckpointChanges,
  type ProjectDetail,
} from "./research-api";
import { MergeDialog } from "./ResearchChanges";
import { useChanges } from "./use-changes";
import styles from "./ReviewChanges.module.css";

export interface ReviewTarget {
  sprintId: string;
  path?: string;
  request: number;
}

export function ReviewChanges({
  detail,
  total,
  target,
  refreshKey,
  onReview,
  onOpen,
  onChanged,
}: {
  detail: ProjectDetail;
  total: ReturnType<typeof useChanges>;
  target: ReviewTarget;
  refreshKey: string;
  onReview(sprintId: string): void;
  onOpen(path: string): void;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const [merging, setMerging] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const round = useChanges(
    target.sprintId ? detail.project.id : "",
    refreshKey,
    target.sprintId,
  );
  const { changes, error, retry } = target.sprintId ? round : total;
  const list = useRef<HTMLDivElement>(null);
  const applied = useRef(-1);
  const rounds = detail.sprints.filter(
    (s) => s.commit_sha && s.status !== "running",
  );
  const selected = rounds.find((s) => s.id === target.sprintId);
  const label = selected
    ? t("research.review.checkpoint", { number: selected.number })
    : t("research.review.unmerged");

  useLayoutEffect(() => {
    const root = list.current;
    if (!root || !changes || applied.current === target.request) return;
    applied.current = target.request;
    root.scrollTop = 0;
    const file =
      target.path &&
      [...root.querySelectorAll<HTMLDetailsElement>("details[data-path]")].find(
        (el) => el.dataset.path === target.path,
      );
    if (file) {
      file.open = true;
      file.scrollIntoView({ block: "nearest" });
      file.querySelector("summary")?.focus({ preventScroll: true });
    } else if (target.request) root.focus({ preventScroll: true });
  }, [changes, target.request, target.path]);

  const discard = async () => {
    if (!changes?.can_undo || !changes.commit_sha || !selected) return;
    setBusy(true);
    try {
      await undoRound(detail.project.id, selected.id, changes.commit_sha);
      setDiscarding(false);
      retry();
      total.retry();
      onChanged();
    } catch (error) {
      toast.show({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.review}>
      <div className={styles.toolbar}>
        <Menu
          label={t("research.review.base")}
          items={[
            {
              id: "unmerged",
              label: t("research.review.unmerged"),
              icon: !target.sprintId ? Check : undefined,
              onSelect: () => onReview(""),
            },
            ...rounds.map((s) => ({
              id: s.id,
              label: t("research.review.checkpoint", { number: s.number }),
              icon: selected?.id === s.id ? Check : undefined,
              onSelect: () => onReview(s.id),
            })),
          ]}
          trigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="sm"
              className={styles.scope}
              aria-label={t("research.review.base")}
            >
              <span>{label}</span>
              <ChevronDown size={14} aria-hidden />
            </Button>
          )}
        />
        <div className={styles.actions}>
          {changes?.can_undo && selected && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDiscarding(true)}
            >
              {t("research.review.discard")}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => setMerging(true)}>
            {t("research.merge.action")}
          </Button>
        </div>
      </div>
      <div
        ref={list}
        className={styles.list}
        tabIndex={-1}
        aria-label={label}
        data-review-round={target.sprintId}
      >
        {error ? (
          <p className={styles.error} role="alert">
            {error}
            <Button variant="ghost" size="sm" onClick={retry}>
              {t("common.retry")}
            </Button>
          </p>
        ) : !changes ? (
          <Spinner />
        ) : changes.files.length ? (
          changes.files.map((file) => (
            <ReviewFile
              key={`${target.sprintId}:${file.path}`}
              file={file}
              onOpen={onOpen}
            />
          ))
        ) : (
          <p className={styles.empty}>{t("research.merge.noChanges")}</p>
        )}
      </div>
      {merging && (
        <MergeDialog
          project={detail.project}
          onClose={() => setMerging(false)}
          onChanged={() => {
            total.retry();
            round.retry();
            onChanged();
          }}
        />
      )}
      <Dialog
        open={discarding}
        title={t("research.review.discardConfirm")}
        onClose={() => setDiscarding(false)}
        dismissible={!busy}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setDiscarding(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button variant="danger" loading={busy} onClick={discard}>
              {t("research.review.discard")}
            </Button>
          </>
        }
      />
    </div>
  );
}

export function UnifiedDiff({ diff }: { diff: string }) {
  const lines = useMemo(() => unifiedLines(diff), [diff]);
  return (
    <pre className={styles.patch}>
      {lines.map((line, index) => (
        <span key={index} className={styles.line} data-kind={line.kind}>
          <span className={styles.gutter} aria-hidden>
            {line.old}
          </span>
          <span className={styles.gutter} aria-hidden>
            {line.next}
          </span>
          <code>{line.text}</code>
        </span>
      ))}
    </pre>
  );
}

export function ReviewFile({
  file,
  onOpen,
}: {
  file: CheckpointChanges["files"][number];
  onOpen(path: string): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => initiallyExpanded(file));
  return (
    <details
      className={styles.file}
      data-path={file.path}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={styles.fileHead}>
        <ChevronRight size={14} className={styles.chevron} aria-hidden />
        <FilePath path={file.path} />
        <ChangeNumbers changes={file} />
        <IconButton
          icon={ExternalLink}
          size="sm"
          label={t("research.review.openFile")}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(file.path);
          }}
        />
      </summary>
      {open && (
        <div className={styles.diff}>
          {file.binary ? (
            <p className={styles.empty}>{t("research.merge.binary")}</p>
          ) : (
            <UnifiedDiff diff={file.diff} />
          )}
          {file.truncated && (
            <p className={styles.empty}>{t("research.changes.truncated")}</p>
          )}
        </div>
      )}
    </details>
  );
}
