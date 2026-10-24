import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import { Button, Spinner } from "../../../ui";
import type { Parallel, ParallelParagraph } from "./useParallelTranslation";
import styles from "./ParallelPage.module.css";

/** A sentence of the page under the pointer, for the reader to mark on the page. */
export type HoverQuote = { page: number; quote: string };

export interface ParallelPageProps {
  parallel: Parallel;
  /** The page, from 1. */
  page: number;
  /** The pointer came onto a sentence of the translation (its original), or left it (`null`). */
  onHoverQuote(quote: HoverQuote | null): void;
}

/**
 * The translation of one page, beside it: its sentences from the top of the
 * page down, the headings stronger and the captions quieter, as they come while
 * the page is translated. A line on top says how it stands; a page that failed
 * says why, and can be translated again. Under the pointer, a sentence asks for
 * its original to be marked on the page.
 */
export const ParallelPage = memo(function ParallelPage({
  parallel,
  page,
  onHoverQuote,
}: ParallelPageProps) {
  const { t } = useI18n();
  const view = parallel.page(page);
  const paragraphs =
    view.status === "working" ||
    view.status === "done" ||
    view.status === "failed"
      ? (view.paragraphs ?? []).filter(
          (paragraph) => paragraph.kind !== "page_number",
        )
      : [];
  const [hovered, setHovered] = useState(-1);
  const hoverNow = useRef(onHoverQuote);
  hoverNow.current = onHoverQuote;
  const hoveredNow = useRef(hovered);
  hoveredNow.current = hovered;

  // What is under the pointer is let go when the sentences change under it or the column goes.
  const original = paragraphs[hovered]?.original;
  useEffect(() => {
    if (hoveredNow.current >= 0 && original === undefined) {
      setHovered(-1);
      hoverNow.current(null);
    }
  }, [original]);
  useEffect(
    () => () => {
      if (hoveredNow.current >= 0) hoverNow.current(null);
    },
    [],
  );

  const enter = (index: number) => {
    setHovered(index);
    hoverNow.current({ page, quote: paragraphs[index].original });
  };
  const leave = (index: number) => {
    if (hoveredNow.current !== index) return;
    setHovered(-1);
    hoverNow.current(null);
  };

  const sentence = (paragraph: ParallelParagraph, index: number) => (
    <p
      key={index}
      className={styles.paragraph}
      data-kind={paragraph.kind ?? "text"}
      data-hovered={hovered === index || undefined}
      onPointerEnter={(event) => {
        // Not while text is being selected (a button held), nor for a touch.
        if (event.pointerType === "mouse" && !event.buttons) enter(index);
      }}
      onPointerLeave={() => leave(index)}
    >
      {paragraph.translation}
    </p>
  );

  // The text inside a figure (its labels, a sample dialogue) is folded away, a group at a time.
  const body: ReactNode[] = [];
  for (let index = 0; index < paragraphs.length; index++) {
    if (paragraphs[index].kind !== "figure_text") {
      body.push(sentence(paragraphs[index], index));
      continue;
    }
    const first = index;
    const group: ReactNode[] = [];
    while (paragraphs[index]?.kind === "figure_text") {
      group.push(sentence(paragraphs[index], index));
      index++;
    }
    index--;
    body.push(
      <details key={`figure-${first}`} className={styles.figure}>
        <summary className={styles.summary}>
          {t("reader.parallel.figure")}
        </summary>
        {group}
      </details>,
    );
  }

  let status: ReactNode = null;
  if (parallel.noModel)
    status = (
      <p className={styles.note}>
        {t("reader.parallel.noModel")}{" "}
        <a className={styles.link} href="#customize/models">
          {t("reader.parallel.settings")}
        </a>
      </p>
    );
  else if (parallel.loading)
    status = (
      <p className={styles.status} role="status">
        {t("reader.parallel.loading")}
      </p>
    );
  else if (view.status === "waiting")
    status = (
      <p className={styles.status} role="status">
        {t("reader.parallel.waiting")}
      </p>
    );
  else if (view.status === "working")
    status = (
      <p className={styles.status} role="status">
        <Spinner size={14} />
        {t("reader.parallel.working")}
      </p>
    );
  else if (view.status === "done")
    status = (
      <p className={styles.status} role="status">
        {t("reader.parallel.done")}
      </p>
    );
  else
    status = (
      <div className={styles.failure}>
        <p className={styles.status} role="status">
          {t("reader.parallel.failed")}
        </p>
        <p className={styles.error} role="alert">
          {view.error || t("reader.parallel.failedReason")}
        </p>
        <Button size="sm" onClick={() => parallel.retry(page)}>
          {t("common.retry")}
        </Button>
      </div>
    );

  return (
    <div
      role="group"
      aria-label={t("reader.parallel.region", { page })}
      aria-busy={view.status === "working" || undefined}
      className={styles.column}
      data-status={parallel.noModel ? "no-model" : view.status}
    >
      {status}
      {!parallel.noModel && body}
    </div>
  );
});
