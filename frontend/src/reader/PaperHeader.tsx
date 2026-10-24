import clsx from "clsx";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Ellipsis,
  Info,
  List,
  Search,
  Star,
  Undo2,
  ScanLine,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ApiError,
  errorStatus,
  send,
  type Paper,
  type SourceFile,
} from "../api";
import { AppActions } from "../app/AppSidebar";
import { useI18n } from "../i18n/I18nProvider";
import { PaperDetails } from "../screens/library/PaperDetails";
import { downloadFile } from "../lib/file-download";
import { paperFileName } from "../lib/paper-file-name";
import {
  Button,
  CardHeader,
  IconButton,
  Menu,
  TextField,
  Tooltip,
  ariaKeyShortcuts,
  currentPlatformIsMac,
  toast,
  type MenuEntry,
} from "../ui";
import type { PdfController } from "./engine/PdfPages";
import { DownloadDialog, type DownloadKind } from "./DownloadDialog";
import { OutlinePanel } from "./OutlinePanel";
import type { Engine } from "./modes/layout/job";
import styles from "./PaperHeader.module.css";

/**
 * Below this card width the zoom and the find button no longer fit beside the
 * title and the page: they move into the more menu.
 */
const NARROW_CARD = 560;
/** Below this the reading modes are one menu instead of the switch (the switch and its menu are about 180px). */
const TIGHT_CARD = 700;
/** Below this not even that one button fits: the modes go into the more menu. */
const TINY_CARD = 420;
/** The page number is announced to a screen reader once it has stopped changing for this long (ms). */
const ANNOUNCE_AFTER = 500;
/** The percentages the zoom menu offers. */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

/** `value`, once it has stayed the same for `delay` ms. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** Whether the card around `bar` is narrower than `limit` (`NARROW_CARD` unless given). */
function useNarrowCard(
  bar: RefObject<HTMLElement | null>,
  limit = NARROW_CARD,
): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const card = bar.current?.parentElement;
    if (!card) return;
    const measure = () => setNarrow(card.offsetWidth < limit);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [bar, limit]);
  return narrow;
}

/** The title on one line; when it is cut short, hovering it gives all of it. */
function Title({ text }: { text: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = heading.current;
    if (!element) return;
    const measure = () => setCut(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return (
    <Tooltip
      content={text}
      disabled={!cut}
      placement={{ side: "bottom", align: "start" }}
    >
      <h1 ref={heading} className={styles.title}>
        {text}
      </h1>
    </Tooltip>
  );
}

/** The page being read: a field to type a page into, how many there are, and the steps either side. */
function PageControls({
  page,
  pages,
  onNavigate,
  onDone,
}: {
  page: number;
  pages: number;
  onNavigate: (page: number) => void;
  /** The field has been used: the keyboard goes back to the paper. */
  onDone: () => void;
}) {
  const { t } = useI18n();
  const mac = currentPlatformIsMac();
  // What is being typed; null while the field just shows the page. Kept in a ref as well as in state:
  // handing the keyboard back to the paper (below) ends the field's focus at once, and the blur that
  // follows must find the draft already used or given up, not the one of the render before.
  const [draft, setShown] = useState<string | null>(null);
  const typed = useRef<string | null>(null);
  const setDraft = (value: string | null) => {
    typed.current = value;
    setShown(value);
  };

  const commit = () => {
    const value = typed.current;
    if (value === null) return;
    setDraft(null);
    const number = Number.parseInt(value, 10);
    // Past either end is the nearest page; what is not a number is let go.
    if (!Number.isNaN(number)) onNavigate(clamp(number, 1, pages));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      onDone();
    } else if (event.key === "Escape") {
      // Taken back; the card's Esc (which closes the find bar) is not for this.
      event.preventDefault();
      setDraft(null);
      onDone();
    } else if (
      event.key.length === 1 &&
      !/\d/.test(event.key) &&
      !(event.ctrlKey || event.metaKey || event.altKey)
    ) {
      // Only digits are typed here; anything else leaves the field as it is.
      event.preventDefault();
    }
  };

  const first = page <= 1;
  const last = page >= pages;
  return (
    <div className={styles.group}>
      <IconButton
        icon={ChevronUp}
        label={t("reader.page.previous")}
        shortcut="["
        aria-keyshortcuts={ariaKeyShortcuts("[", mac)}
        aria-disabled={first || undefined}
        className={clsx(first && styles.atEnd)}
        onClick={() => onNavigate(Math.max(1, page - 1))}
      />
      <div className={styles.pageField}>
        <TextField
          hideLabel
          label={t("reader.page.input")}
          value={draft ?? String(page)}
          inputMode="numeric"
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) =>
            setDraft(event.target.value.replace(/\D/g, "").slice(0, 6))
          }
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </div>
      <span className={styles.total}>{t("reader.page.total", { pages })}</span>
      <IconButton
        icon={ChevronDown}
        label={t("reader.page.next")}
        shortcut="]"
        aria-keyshortcuts={ariaKeyShortcuts("]", mac)}
        aria-disabled={last || undefined}
        className={clsx(last && styles.atEnd)}
        onClick={() => onNavigate(Math.min(pages, page + 1))}
      />
    </div>
  );
}

export interface PaperHeaderProps {
  /** `null` until it has loaded. */
  paper: Paper | null;
  /** The paper's PDF, once it is known. */
  file: SourceFile | null;
  /** The full translation, once a job has completed: it can be downloaded. */
  /** The completed full translations, one per method: the download offers each. */
  translations?: { engine: Engine; file: SourceFile }[];
  /** The open PDF, once it has loaded. */
  doc: PDFDocumentProxy | null;
  /** The page being read. */
  page: number;
  /** How many pages the PDF has; 0 while there is none. */
  pages: number;
  controller: PdfController | null;
  /** A page was asked for (typed, stepped to, chosen from the contents). */
  onNavigate: (page: number) => void;
  findOpen: boolean;
  /** The find button (or a key) asks for the find bar to open or close. */
  onFind: () => void;
  outlineOpen: boolean;
  /** The outline button asks for the panel to open or close. */
  onOutline: () => void;
  /** The paper changed here (favorited): the new state of it. */
  onPaperChange: (paper: Paper) => void;
  /** Back to where the reading was before a link inside the paper was followed; only while there is such a place. */
  onBack?: () => void;
  /** The button that opens the side panel, in a window too narrow to show it beside the paper. */
  panelToggle?: ReactNode;
  /**
   * The controls for how the paper is read (the reading modes and the translation settings), made for a
   * strip with room for them or, with `compact`, one that has less.
   */
  modes?: (compact: boolean) => ReactNode;
  /** The same as menu entries, for the more menu of a strip with no room for `modes` at all. */
  modeItems?: MenuEntry[];
  /** Tools for working on the page (the region box), beside the contents button while there are pages. */
  tools?: ReactNode;
}

/**
 * The strip on top of the paper's card: its title; the page and the steps
 * either side; the zoom; find; the contents; and the actions that are not
 * needed all the time. In a narrow card the zoom and find go into the more menu.
 */
export function PaperHeader({
  paper,
  file,
  translations = [],
  doc,
  page,
  pages,
  controller,
  onNavigate,
  findOpen,
  onFind,
  outlineOpen,
  onOutline,
  onPaperChange,
  onBack,
  panelToggle,
  modes,
  modeItems,
  tools,
}: PaperHeaderProps) {
  const { t } = useI18n();
  const bar = useRef<HTMLDivElement>(null);
  const narrow = useNarrowCard(bar);
  const tight = useNarrowCard(bar, TIGHT_CARD);
  const tiny = useNarrowCard(bar, TINY_CARD);
  const [outlineButton, setOutlineButton] = useState<HTMLElement | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [favoriting, setFavoriting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { owner = "" } = useContext(AppActions);
  const announced = useSettled(page, ANNOUNCE_AFTER);

  const title = paper ? paper.title || t("reader.untitled") : "";
  const reading = doc !== null && pages > 0;
  const percent = Math.round(controller?.percent ?? 100);

  const toPaper = () => controller?.root?.focus({ preventScroll: true });

  const fail = (message: string) => toast.show({ tone: "error", message });
  /** What the service said is in the person's language already; a network failure has no words of its own. */
  const reason = (error: unknown, fallback: string) =>
    error instanceof Error && !(error instanceof TypeError) && error.message
      ? error.message
      : fallback;

  const save = async (source: SourceFile, path: string, name: string) => {
    try {
      await downloadFile(`/api/v1/files/${source.id}/${path}`, name);
    } catch (error) {
      fail(reason(error, t("reader.toast.downloadFailed")));
    }
  };

  const download = (kind: DownloadKind) => {
    const base = (paper?.title || file!.name).replace(/\.pdf$/i, "");
    if (kind.startsWith("translated:")) {
      const done = translations.find(
        (row) => `translated:${row.engine}` === kind,
      );
      if (done)
        return save(
          done.file,
          "content?download=true",
          paperFileName(
            base,
            t("reader.download.translatedSuffix") +
              (translations.length > 1
                ? "-" + t(`reader.engine.${done.engine}.name`)
                : ""),
          ),
        );
    }
    if (kind === "annotated")
      return save(
        file!,
        "annotated-pdf",
        paperFileName(base, t("reader.download.annotatedSuffix")),
      );
    return save(file!, "content?download=true", paperFileName(base));
  };

  const toggleFavorite = async () => {
    if (!paper || favoriting) return;
    const favorite = !paper.favorite;
    setFavoriting(true);
    try {
      const updated: Paper = await send(
        `/papers/${encodeURIComponent(paper.id)}`,
        { favorite },
        "PATCH",
        paper.revision,
      );
      onPaperChange(updated);
      toast.show({
        message: t(
          favorite ? "reader.toast.favorited" : "reader.toast.unfavorited",
        ),
      });
    } catch (error) {
      const status = errorStatus(error);
      fail(
        status === 409 || status === 412
          ? t("reader.toast.conflict")
          : reason(error, t("reader.toast.favoriteFailed")),
      );
    } finally {
      setFavoriting(false);
    }
  };

  const fit: MenuEntry = {
    id: "zoom-fit",
    label: t("reader.zoom.fit"),
    icon: ScanLine,
    shortcut: "mod+0",
    onSelect: () => controller?.setZoom("fit"),
  };
  const zoomIn: MenuEntry = {
    id: "zoom-in",
    label: t("reader.zoom.in"),
    icon: ZoomIn,
    shortcut: "mod+=",
    onSelect: () => controller?.zoomIn(),
  };
  const zoomOut: MenuEntry = {
    id: "zoom-out",
    label: t("reader.zoom.out"),
    icon: ZoomOut,
    shortcut: "mod+-",
    onSelect: () => controller?.zoomOut(),
  };
  const zoomItems: MenuEntry[] = [
    fit,
    {
      id: "zoom-actual",
      label: t("reader.zoom.actual"),
      onSelect: () => controller?.setZoom(1),
    },
    zoomIn,
    zoomOut,
    { kind: "separator", id: "zoom-steps" },
    ...ZOOM_STEPS.map(
      (step): MenuEntry => ({
        id: `zoom-${step}`,
        label: t("reader.zoom.percent", { percent: Math.round(step * 100) }),
        onSelect: () => controller?.setZoom(step),
      }),
    ),
  ];

  const moreItems: MenuEntry[] = [
    // The reading modes, where the strip has no room for even their one button.
    ...(tiny && file && modeItems?.length
      ? ([
          ...modeItems,
          { kind: "separator", id: "modes-end" },
        ] satisfies MenuEntry[])
      : []),
    // What no longer fits beside the title.
    ...(narrow && reading
      ? ([
          {
            id: "find",
            label: t("reader.find.open"),
            icon: Search,
            shortcut: "mod+f",
            // Opens it; with the bar already open there is nothing more to ask for.
            onSelect: () => {
              if (!findOpen) onFind();
            },
          },
          { kind: "separator", id: "find-end" },
          fit,
          zoomIn,
          zoomOut,
          { kind: "separator", id: "zoom-end" },
        ] satisfies MenuEntry[])
      : []),
    {
      id: "details",
      label: t("reader.more.details"),
      icon: Info,
      disabled: !paper,
      onSelect: () => setDetailsOpen(true),
    },
    {
      id: "download",
      label: t("reader.more.download"),
      icon: Download,
      disabled: !file,
      onSelect: () => setDownloadOpen(true),
    },
    { kind: "separator", id: "favorite-start" },
    {
      id: "favorite",
      label: t(
        paper?.favorite ? "reader.more.unfavorite" : "reader.more.favorite",
      ),
      icon: Star,
      disabled: !paper,
      onSelect: () => void toggleFavorite(),
    },
  ];

  return (
    <CardHeader>
      <div ref={bar} className={styles.bar}>
        {paper ? <Title text={title} /> : <span className={styles.title} />}
        {/* Read out once the page has stopped changing, not at every turn of the wheel. */}
        {reading && (
          <span className={styles.announcement} aria-live="polite">
            {t("reader.page.status", { page: announced, pages })}
          </span>
        )}
        {reading && onBack && (
          <IconButton
            icon={Undo2}
            label={t("reader.link.back")}
            className={styles.back}
            onClick={onBack}
          />
        )}
        {reading && (
          <PageControls
            page={page}
            pages={pages}
            onNavigate={onNavigate}
            onDone={toPaper}
          />
        )}
        {file && modes && !tiny && (
          <div className={styles.group}>{modes(tight)}</div>
        )}
        <div className={styles.group}>
          {reading && !narrow && (
            <>
              <Menu
                label={t("reader.zoom.menu")}
                placement={{ side: "bottom", align: "end" }}
                items={zoomItems}
                trigger={(props) => (
                  <Tooltip content={t("reader.zoom.menu")}>
                    <Button
                      {...props}
                      variant="ghost"
                      className={styles.zoom}
                      aria-label={t("reader.zoom.current", { percent })}
                    >
                      {t("reader.zoom.percent", { percent })}
                    </Button>
                  </Tooltip>
                )}
              />
              <IconButton
                icon={Search}
                label={t("reader.find.open")}
                shortcut="mod+f"
                aria-keyshortcuts={ariaKeyShortcuts(
                  "mod+f",
                  currentPlatformIsMac(),
                )}
                aria-pressed={findOpen}
                onClick={onFind}
              />
            </>
          )}
          {reading && tools}
          {reading && doc && (
            <>
              <IconButton
                ref={setOutlineButton}
                icon={List}
                label={t("reader.outline.open")}
                aria-haspopup="dialog"
                aria-expanded={outlineOpen}
                onClick={onOutline}
              />
              <OutlinePanel
                open={outlineOpen}
                anchor={outlineButton}
                doc={doc}
                page={page}
                onNavigate={(target) => {
                  onOutline();
                  onNavigate(target);
                  toPaper();
                }}
                onDismiss={(reason) => {
                  onOutline();
                  if (reason === "escape") outlineButton?.focus();
                }}
              />
            </>
          )}
          {paper && (
            <Menu
              label={t("reader.more.menu")}
              placement={{ side: "bottom", align: "end" }}
              items={moreItems}
              trigger={(props) => (
                <IconButton
                  {...props}
                  icon={Ellipsis}
                  label={t("reader.more.menu")}
                />
              )}
            />
          )}
          <DownloadDialog
            open={downloadOpen && file !== null}
            onClose={() => setDownloadOpen(false)}
            translated={translations.map((row) => row.engine)}
            onDownload={download}
          />
          <PaperDetails
            paper={detailsOpen ? paper : null}
            owner={owner}
            go={(hash) => {
              location.hash = hash;
            }}
            onClose={() => setDetailsOpen(false)}
            onChanged={onPaperChange}
          />
        </div>
        {panelToggle}
      </div>
    </CardHeader>
  );
}
