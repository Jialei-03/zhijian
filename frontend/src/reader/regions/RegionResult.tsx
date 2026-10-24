import { Copy, MessageSquare, NotebookPen } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { api } from "../../api";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Floating, Spinner, toast, type Rect } from "../../ui";
import { chosenModel, type ModelSettings } from "../useModel";
import type { AskRequest } from "../types";
import { useSelectionTranslation } from "../selection/useSelectionTranslation";
import { bareLatex, type RegionKind } from "./geometry";
import styles from "./RegionTool.module.css";

/** Formulas in what a model writes: no trust, and no runaway macros. */
const MATH = {
  trust: false,
  throwOnError: false,
  maxExpand: 1000,
  maxSize: 20,
};

export interface RegionResultProps {
  request: AskRequest;
  kind: RegionKind;
  anchor: Rect;
  onClose(): void;
  /** What was made of the region (the explanation, or the LaTeX), to keep in the note with its picture. */
  onNote(text: string): void;
  onAsk(): void;
}

/**
 * Whether the chosen model takes pictures (`null` until the settings are read).
 * A model that cannot is said so: it explains from the text alone.
 */
function useSees(): boolean | null {
  const [sees, setSees] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<
      Omit<ModelSettings, "models"> & {
        models?: { id: string; vision?: boolean }[];
      }
    >("/translation-settings", { signal: controller.signal }).then(
      (settings) => {
        const id = chosenModel(settings as ModelSettings);
        const row = settings.models?.find((model) => model.id === id);
        setSees(row ? !!row.vision : null);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, []);
  return sees;
}

/**
 * What a model makes of a boxed region, beside it: it grows as the model writes,
 * and once it is there it can be copied, kept in the note with the picture, or
 * taken on with the assistant. It goes with Escape or a press outside it; a run
 * still going then is stopped.
 */
export function RegionResult({
  request,
  kind,
  anchor,
  onClose,
  onNote,
  onAsk,
}: RegionResultProps) {
  const { t } = useI18n();
  const { translation, retry } = useSelectionTranslation(request, {
    prompt: t(`reader.region.prompt.${kind}`),
    failed: "reader.region.failed",
  });
  const sees = useSees();
  const latex = kind === "latex";
  const raw = translation.status === "noModel" ? "" : translation.text;
  const text = latex && translation.status === "done" ? bareLatex(raw) : raw;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ message: t("reader.region.copied"), tone: "success" });
    } catch {
      toast.show({ message: t("reader.region.copyFailed"), tone: "error" });
    }
  };

  return (
    <Floating
      open
      anchor={anchor}
      placement={{ side: "bottom", align: "start" }}
      onDismiss={onClose}
      className={styles.popover}
    >
      <div
        role="dialog"
        aria-label={t("reader.region.result")}
        aria-busy={translation.status === "working"}
        className={styles.result}
      >
        {translation.status === "noModel" ? (
          <p className={styles.status}>
            {t("reader.region.noModel")}{" "}
            <a className={styles.link} href="#customize/models">
              {t("reader.translate.settings")}
            </a>
          </p>
        ) : (
          <>
            {sees === false && !latex && (
              <p className={styles.hint}>{t("reader.region.noVision")}</p>
            )}
            {text &&
              (latex && translation.status === "done" ? (
                <>
                  <div className={styles.preview}>
                    <ReactMarkdown
                      remarkPlugins={[remarkMath]}
                      rehypePlugins={[[rehypeKatex, MATH]]}
                      skipHtml
                    >
                      {`$$\n${text}\n$$`}
                    </ReactMarkdown>
                  </div>
                  <pre className={styles.latex} aria-label="LaTeX">
                    {text}
                  </pre>
                </>
              ) : (
                <div className={styles.body}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[[rehypeKatex, MATH]]}
                    skipHtml
                  >
                    {text}
                  </ReactMarkdown>
                </div>
              ))}
            {translation.status === "working" && (
              <p className={styles.status} role="status">
                <Spinner size={14} />
                {!text && t(`reader.region.working.${kind}`)}
              </p>
            )}
            {translation.status === "failed" && (
              <div className={styles.failure}>
                <p className={styles.error} role="alert">
                  {translation.error ||
                    t(
                      translation.stopped
                        ? "reader.region.stopped"
                        : "reader.region.failed",
                    )}
                </p>
                <Button size="sm" onClick={retry}>
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {translation.status === "done" && (
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Copy}
                  onClick={() => void copy()}
                >
                  {t(
                    latex ? "reader.region.copyLatex" : "reader.translate.copy",
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={NotebookPen}
                  onClick={() => onNote(text)}
                >
                  {t("reader.selection.note")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={MessageSquare}
                  onClick={onAsk}
                >
                  {t("reader.selection.ask")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Floating>
  );
}
