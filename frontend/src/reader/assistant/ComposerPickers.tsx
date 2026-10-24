import { Brain, Check, ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import { Button, Menu, toast, type MenuEntry } from "../../ui";
import type { Assistant } from "./useAssistant";
import styles from "./Composer.module.css";

/**
 * The two quiet pickers under the question: the model this paper's questions go
 * to, and how hard it thinks. A choice here belongs to this paper's
 * conversation; "make default" changes the model every paper starts with.
 */
export function ComposerPickers({ assistant }: { assistant: Assistant }) {
  const { t } = useI18n();
  const { models, modelId, efforts, effortId } = assistant;
  if (models.length === 0) return null;
  const current = models.find((row) => row.id === modelId);
  const name = (row: { name: string; model: string }) => row.name || row.model;
  const effortName = (id: string) =>
    t(`reader.assistant.effort.${id}` as MessageKey);
  const modelItems: MenuEntry[] = [
    ...models.map((row) => ({
      id: row.id,
      label: row.shared
        ? `${name(row)} · ${row.badge || t("settings.models.shared")}`
        : name(row),
      icon: row.id === modelId ? Check : undefined,
      onSelect: () => assistant.chooseModel(row.id),
    })),
    { kind: "separator", id: "sep" },
    {
      id: "default",
      label: t("reader.assistant.model.default"),
      disabled: !current,
      onSelect: () =>
        void assistant.makeDefault(modelId).then((ok) =>
          toast.show(
            ok
              ? {
                  tone: "success",
                  message: t("reader.assistant.model.defaulted", {
                    name: current ? name(current) : "",
                  }),
                }
              : {
                  tone: "error",
                  message: t("reader.assistant.model.defaultError"),
                },
          ),
        ),
    },
    {
      id: "settings",
      label: t("reader.assistant.model.settings"),
      onSelect: () => {
        window.location.hash = "#customize/models";
      },
    },
  ];
  const effortItems: MenuEntry[] = efforts.map((choice) => ({
    id: choice.id,
    label: effortName(choice.id),
    icon: choice.id === effortId ? Check : undefined,
    onSelect: () => assistant.chooseEffort(choice.id),
  }));
  const shown = current ? name(current) : "";
  return (
    <div className={styles.pickers} data-composer-pickers="">
      <Menu
        label={t("reader.assistant.model.menu")}
        placement={{ side: "top", align: "start" }}
        items={modelItems}
        trigger={(props) => (
          <Button
            {...props}
            size="sm"
            variant="ghost"
            className={styles.picker}
            aria-label={t("reader.assistant.model.current", { name: shown })}
          >
            <span className={styles.pickerInner}>
              <span className={styles.pickerText}>{shown}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </span>
          </Button>
        )}
      />
      {efforts.length > 1 && (
        <Menu
          label={t("reader.assistant.effort.menu")}
          placement={{ side: "top", align: "start" }}
          items={effortItems}
          trigger={(props) => (
            <Button
              {...props}
              size="sm"
              variant="ghost"
              icon={Brain}
              className={styles.picker}
              aria-label={t("reader.assistant.effort.current", {
                name: effortName(effortId),
              })}
            >
              <span className={styles.pickerInner}>
                <span className={styles.pickerText}>
                  {effortName(effortId)}
                </span>
                <ChevronDown size={12} aria-hidden="true" />
              </span>
            </Button>
          )}
        />
      )}
    </div>
  );
}
