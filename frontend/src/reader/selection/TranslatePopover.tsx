import { Copy, MessageSquare, NotebookPen, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Floating, Spinner, toast, type Rect } from "../../ui";
import type { AskRequest } from "../types";
import styles from "./SelectionMenu.module.css";
import { useSelectionTranslation } from "./useSelectionTranslation";

export interface TranslatePopoverProps {
  request: AskRequest;
  anchor: Rect;
  onClose(): void;
  /** The translation, with what was selected, to keep in the paper's note. */
  onNote(translation: string): void;
  onAsk(): void;
}

/**
 * The translation of a selection, beside it: it grows as the model writes it,
 * and once it is there it can be copied, kept in the note, or taken to the
 * assistant. It goes with Escape or a press outside it; a translation still
 * being written then is stopped.
 */
export function TranslatePopover({
  request,
  anchor,
  onClose,
  onNote,
  onAsk,
}: TranslatePopoverProps) {
  const { t } = useI18n();
  const { translation, retry } = useSelectionTranslation(request);
  const text = translation.status === "noModel" ? "" : translation.text;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ message: t("reader.translate.copied"), tone: "success" });
    } catch {
      toast.show({ message: t("reader.translate.copyFailed"), tone: "error" });
    }
  };

  return (
    <Floating
      open
      anchor={anchor}
      placement={{ side: "bottom", align: "center" }}
      onDismiss={onClose}
      className={styles.popover}
    >
      <div
        role="dialog"
        aria-label={t("reader.translate.region")}
        aria-busy={translation.status === "working"}
        className={styles.translation}
      >
        {translation.status === "noModel" ? (
          <p className={styles.status}>
            {t("reader.translate.noModel")}{" "}
            <a className={styles.link} href="#customize/models">
              {t("reader.translate.settings")}
            </a>
          </p>
        ) : (
          <>
            {text && <p className={styles.text}>{text}</p>}
            {translation.status === "working" && (
              <p className={styles.status} role="status">
                <Spinner size={14} />
                {!text && t("reader.translate.working")}
              </p>
            )}
            {translation.status === "failed" && (
              <div className={styles.failure}>
                <p className={styles.error} role="alert">
                  {translation.error ||
                    t(
                      translation.stopped
                        ? "reader.translate.stopped"
                        : "reader.translate.failed",
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
                  {t("reader.translate.copy")}
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
                <Button
                  size="sm"
                  variant="ghost"
                  icon={RefreshCw}
                  onClick={retry}
                >
                  {t("reader.translate.again")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Floating>
  );
}
