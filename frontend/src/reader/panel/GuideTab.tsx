import clsx from "clsx";
import { FilePlus2 } from "lucide-react";
import { Fragment, useMemo, type ReactNode } from "react";
import type { Paper, SourceFile } from "../../api";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Spinner } from "../../ui";
import type { GuideContent, GuideSection } from "./guide";
import { useSmoothText } from "../stream";
import styles from "./GuideTab.module.css";
import { useGuide } from "./useGuide";
import { KeypointsSection, type Keypoint, type Keypoints } from "../keypoints";
import {
  CiteChip,
  CiteProvider,
  copyWithCitations,
  markKey,
  numbering,
  splitMarks,
  stripMarks,
} from "../cite";
import type { ReaderRoute } from "../route";

export interface GuideTabProps {
  paper: Paper;
  file: SourceFile;
  /** A page chip was pressed: the paper goes to that page. */
  onJumpToPage(page: number): void;
  /** The paper's key sentences, listed after the guide; none to list when not given. */
  keypoints?: Keypoints;
  /** A key sentence was pressed: the paper goes to it. */
  onJumpKeypoint?(item: Keypoint): void;
  /** A citation after a sentence was pressed: the paper goes to that sentence. */
  onCite?(route: ReaderRoute): void;
  /** A section is kept in the note (its text, citations included). */
  onKeep?(markdown: string): void;
}

/** What draws the citations of a guide: their numbers, and whether any are drawn (not while it is written). */
type Cites = { numbers: ReadonlyMap<string, number> } | null;

/** `**bold**` and `` `code` `` in a line of the guide; the rest is text as written. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((part, index) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
      return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

/** Text of the guide that is still being written comes in at an even pace, not a sentence at a time. */
function Flowing({
  text,
  streaming,
  children,
}: {
  text: string;
  streaming: boolean;
  children(shown: string): ReactNode;
}) {
  const { text: shown } = useSmoothText(text, { done: !streaming });
  return <>{children(shown)}</>;
}

/**
 * A line of the guide with its citations: each marker is a numbered chip after
 * its sentence. Without `cites` (the guide is being written, or is an older one)
 * the markers are left out and the sentences stand alone.
 */
function cited(text: string, cites: Cites): ReactNode[] {
  if (!cites) return inline(stripMarks(text));
  return splitMarks(text).flatMap((piece, index): ReactNode[] => {
    if (piece.kind === "text")
      return [<Fragment key={index}>{inline(piece.text)}</Fragment>];
    const n = cites.numbers.get(markKey(piece.mark));
    return n ? [<CiteChip key={index} n={n} mark={piece.mark} />] : [];
  });
}

function Paragraphs({ text, cites }: { text: string; cites: Cites }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter((paragraph) => paragraph.trim() !== "")
        .map((paragraph, index) => (
          <p key={index} className={styles.paragraph}>
            {cited(paragraph.trim(), cites)}
          </p>
        ))}
    </>
  );
}

function Section({
  section,
  className,
  streaming,
  cites,
  onJumpToPage,
  onKeep,
}: {
  section: GuideSection;
  className?: string;
  streaming: boolean;
  cites: Cites;
  onJumpToPage(page: number): void;
  onKeep?(markdown: string): void;
}) {
  const { t } = useI18n();
  // With a citation after each sentence the pages are named by the citations; a
  // section none of them reached (or an older guide) keeps its page chips.
  const sentenceSources =
    cites !== null && splitMarks(section.body).some((p) => p.kind === "cite");
  return (
    <section className={clsx(styles.section, className)}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>{section.title}</h2>
        {cites && onKeep && (
          <button
            type="button"
            className={styles.keep}
            aria-label={t("reader.cite.keep")}
            title={t("reader.cite.keep")}
            onClick={() => onKeep(`**${section.title}**\n\n${section.body}`)}
          >
            <FilePlus2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className={styles.body}>
        <Flowing text={section.body} streaming={streaming}>
          {(shown) => <Paragraphs text={shown} cites={cites} />}
        </Flowing>
      </div>
      {!sentenceSources && section.pages.length > 0 && (
        <ul className={styles.pages} aria-label={t("reader.guide.pages")}>
          {section.pages.map((page) => (
            <li key={page}>
              <button
                type="button"
                className={styles.page}
                onClick={() => onJumpToPage(page)}
              >
                {t("reader.guide.page", { page })}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The guide, or as much of it as has been written. What is new comes in; what was there stays. */
function Content({
  content,
  streaming,
  onJumpToPage,
  onKeep,
}: {
  content: GuideContent;
  streaming: boolean;
  onJumpToPage(page: number): void;
  onKeep?(markdown: string): void;
}) {
  const { t } = useI18n();
  const arrive = streaming ? styles.arrive : undefined;
  // Citations are drawn in a finished guide whose markers the service has checked.
  const cites: Cites = useMemo(
    () =>
      content.cited && !streaming
        ? {
            numbers: numbering([
              ...content.summary,
              ...content.sections.map((section) => section.body),
            ]),
          }
        : null,
    [content, streaming],
  );
  return (
    <>
      {content.keywords.length > 0 && (
        <ul className={styles.keywords} aria-label={t("reader.guide.keywords")}>
          {content.keywords.map((keyword, index) => (
            <li
              key={`${index}:${keyword}`}
              className={clsx(styles.keyword, arrive)}
            >
              {keyword}
            </li>
          ))}
        </ul>
      )}
      {content.summary.length > 0 && (
        <div className={clsx(styles.block, arrive)}>
          <h2 className={styles.label}>{t("reader.guide.summary")}</h2>
          <ol className={styles.summary}>
            {content.summary.map((line, index) => (
              <li key={index}>
                <Flowing text={line} streaming={streaming}>
                  {(shown) => cited(shown, cites)}
                </Flowing>
              </li>
            ))}
          </ol>
        </div>
      )}
      {content.sections.map((section, index) => (
        <Section
          key={index}
          section={section}
          className={arrive}
          streaming={streaming}
          cites={cites}
          onJumpToPage={onJumpToPage}
          onKeep={onKeep}
        />
      ))}
    </>
  );
}

/**
 * The right panel's guide to the paper: its keywords, a summary in three lines
 * and four sections (question, method, results, limits), each with the pages it
 * rests on. It is made by the paper's automatic preparation when the paper is
 * opened, or by a press of the button; what has been written shows as it comes.
 */
export function GuideTab({
  paper,
  file,
  onJumpToPage,
  keypoints,
  onJumpKeypoint,
  onCite,
  onKeep,
}: GuideTabProps) {
  const { t } = useI18n();
  const guide = useGuide(paper.id, file.id);
  const { view } = guide;

  switch (view.kind) {
    case "loading":
      return (
        <p className={styles.status} role="status">
          <Spinner size={14} />
          {t("reader.guide.loading")}
        </p>
      );
    case "noModel":
      return (
        <div className={styles.message}>
          <p className={styles.note}>{t("reader.guide.noModel")}</p>
          <a className={styles.link} href="#customize/models">
            {t("reader.guide.openSettings")}
          </a>
        </div>
      );
    case "working":
    case "ready":
      return (
        <div className={styles.guide} onCopy={copyWithCitations}>
          {view.kind === "working" && (
            <p className={styles.status} role="status">
              <Spinner size={14} />
              {t("reader.guide.working")}
            </p>
          )}
          {view.kind === "ready" && view.failed !== undefined && (
            <div className={styles.message}>
              <p className={styles.error} role="alert">
                {guide.error || view.failed || t("reader.guide.failed")}
              </p>
              <div>
                <Button size="sm" loading={guide.busy} onClick={guide.retry}>
                  {t("common.retry")}
                </Button>
              </div>
            </div>
          )}
          <CiteProvider
            target={
              onCite ? { paperId: paper.id, fileId: file.id, onCite } : null
            }
          >
            <Content
              content={view.content}
              streaming={view.kind === "working"}
              onJumpToPage={onJumpToPage}
              onKeep={onKeep}
            />
          </CiteProvider>
          {view.kind === "ready" && !view.content.cited && (
            <button
              type="button"
              className={styles.regenerate}
              disabled={guide.busy}
              onClick={() => guide.generate(true)}
            >
              {t("reader.cite.regenerate")}
            </button>
          )}
          {view.kind === "ready" && keypoints && onJumpKeypoint && (
            <KeypointsSection keypoints={keypoints} onJump={onJumpKeypoint} />
          )}
        </div>
      );
    case "failed":
      return (
        <div className={styles.message}>
          <p className={styles.error} role="alert">
            {guide.error || view.message || t("reader.guide.failed")}
          </p>
          <div>
            <Button size="sm" loading={guide.busy} onClick={guide.retry}>
              {t("common.retry")}
            </Button>
          </div>
        </div>
      );
    case "idle":
      return (
        <div className={styles.message}>
          <p className={styles.note}>
            {view.note ||
              t(view.stopped ? "reader.guide.stopped" : "reader.guide.idle")}
          </p>
          {guide.error && (
            <p className={styles.error} role="alert">
              {guide.error}
            </p>
          )}
          <div>
            <Button
              size="sm"
              variant="primary"
              loading={guide.busy}
              onClick={() => guide.generate(view.stopped)}
            >
              {t("reader.guide.generate")}
            </Button>
          </div>
        </div>
      );
  }
}
