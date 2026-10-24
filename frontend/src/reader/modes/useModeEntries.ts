import { Check, Plus, RotateCw } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MenuEntry } from "../../ui";
import type { ReadingMode, TranslationLanguage } from "./mode";
import { resolveModel, useTranslationSettings } from "./useTranslationSettings";

export interface ModeEntriesArgs {
  language: TranslationLanguage;
  onLanguage(language: TranslationLanguage): void;
  /** The model asked for; `null` is the one the settings have chosen. */
  modelId: string | null;
  onModel(id: string): void;
  /** Only given where there is a page to translate again (the side-by-side view). */
  onRetranslatePage?(): void;
  /** Where the menu carries the reading modes too (a strip too narrow for the switch): the chosen one, and the way to change it. */
  modes?: { mode: ReadingMode; onChange(mode: ReadingMode): void };
}

const MODES: ReadingMode[] = ["original", "parallel", "translated"];

/**
 * The entries of the translation menu: the reading modes (where asked for),
 * the language to translate into, the model to translate with, and (side by
 * side) translating the page again. The more menu of a strip with no room even
 * for the one button holds them as well.
 */
export function useModeEntries({
  language,
  onLanguage,
  modelId,
  onModel,
  onRetranslatePage,
  modes,
}: ModeEntriesArgs): MenuEntry[] {
  const { t } = useI18n();
  const settings = useTranslationSettings();
  const current = resolveModel(settings, modelId);

  return [
    ...(modes
      ? ([
          ...MODES.map(
            (mode): MenuEntry => ({
              id: `mode-${mode}`,
              label: t(`reader.mode.${mode}`),
              icon: mode === modes.mode ? Check : undefined,
              checked: mode === modes.mode,
              onSelect: () => modes.onChange(mode),
            }),
          ),
          { kind: "separator", id: "modes" },
        ] satisfies MenuEntry[])
      : []),
    {
      id: "language-zh",
      label: t("reader.translation.toChinese"),
      icon: language === "zh" ? Check : undefined,
      checked: language === "zh",
      onSelect: () => onLanguage("zh"),
    },
    {
      id: "language-en",
      label: t("reader.translation.toEnglish"),
      icon: language === "en" ? Check : undefined,
      checked: language === "en",
      onSelect: () => onLanguage("en"),
    },
    { kind: "separator", id: "models" },
    ...(settings.models.length
      ? settings.models.map(
          (model): MenuEntry => ({
            id: `model-${model.id}`,
            label: model.name || model.model,
            icon: model.id === current ? Check : undefined,
            checked: model.id === current,
            onSelect: () => onModel(model.id),
          }),
        )
      : // Nothing to choose from yet (or not heard yet): the way to add one.
        settings.loaded
        ? [
            {
              id: "add-model",
              label: t("reader.translation.addModel"),
              icon: Plus,
              onSelect: () => {
                window.location.hash = "customize/models";
              },
            } satisfies MenuEntry,
          ]
        : []),
    ...(onRetranslatePage
      ? ([
          { kind: "separator", id: "page" },
          {
            id: "retranslate",
            label: t("reader.translation.retranslate"),
            icon: RotateCw,
            onSelect: onRetranslatePage,
          },
        ] satisfies MenuEntry[])
      : []),
  ];
}
