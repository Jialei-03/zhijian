import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { MenuList, type MenuEntry } from "../../ui";
import { useModeEntries } from "./useModeEntries";
import type { TranslationSettings } from "./useTranslationSettings";

const { settings } = vi.hoisted(() => ({
  settings: {
    models: [
      { id: "one", name: "First model", model: "first" },
      { id: "two", name: "Second model", model: "second" },
    ],
    activeId: "one",
    layoutEnabled: false,
    latexAvailable: false,
    latexInstallable: false,
    loaded: true,
  } satisfies TranslationSettings,
}));
vi.mock("./useTranslationSettings", async (original) => ({
  ...(await original<typeof import("./useTranslationSettings")>()),
  useTranslationSettings: () => settings,
}));

describe("translation menu", () => {
  for (const locale of ["zh", "en"] as const) {
    it(`${locale} uses radio state and icons while preserving action labels`, () => {
      const { t } = createTranslator(locale);
      let entries: MenuEntry[] = [];
      const onLanguage = vi.fn();
      const onModel = vi.fn();
      const onMode = vi.fn();
      const onRetranslatePage = vi.fn();
      function Probe() {
        entries = useModeEntries({
          language: "en",
          onLanguage,
          modelId: "two",
          onModel,
          modes: { mode: "parallel", onChange: onMode },
          onRetranslatePage,
        });
        return createElement(MenuList, {
          label: t("reader.translation.menu"),
          items: entries,
          onClose() {},
        });
      }
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(Probe),
        }),
      );
      expect(html.match(/role="menuitemradio"/g)).toHaveLength(7);
      expect(html.match(/aria-checked="true"/g)).toHaveLength(3);
      expect(html).not.toMatch(/[✓ ]/u);
      expect(html).toContain(`>${t("reader.translation.toEnglish")}</span>`);
      const item = (id: string) => {
        const entry = entries.find((entry) => entry.id === id)!;
        if (entry.kind === "separator") throw new Error("Expected an item");
        return entry;
      };
      for (const id of ["mode-parallel", "language-en", "model-two"]) {
        expect(item(id).checked).toBe(true);
        expect(item(id).icon).toBeDefined();
      }
      item("language-zh").onSelect();
      item("model-one").onSelect();
      item("mode-original").onSelect();
      item("retranslate").onSelect();
      expect(onLanguage).toHaveBeenCalledWith("zh");
      expect(onModel).toHaveBeenCalledWith("one");
      expect(onMode).toHaveBeenCalledWith("original");
      expect(onRetranslatePage).toHaveBeenCalledOnce();
    });
  }

  it("opens the model page when no model is available", () => {
    const saved = settings.models;
    settings.models = [];
    vi.stubGlobal("window", { location: { hash: "" } });
    try {
      function Probe() {
        const entry = useModeEntries({
          language: "zh",
          onLanguage() {},
          modelId: null,
          onModel() {},
        }).find((entry) => entry.id === "add-model");
        if (entry?.kind !== "separator") entry?.onSelect();
        return null;
      }
      renderToStaticMarkup(
        createElement(I18nProvider, {
          locale: "en",
          children: createElement(Probe),
        }),
      );
      expect(window.location.hash).toBe("customize/models");
    } finally {
      settings.models = saved;
      vi.unstubAllGlobals();
    }
  });
});
