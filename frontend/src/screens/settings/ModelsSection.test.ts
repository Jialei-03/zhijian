import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { Dialog, toast, type DialogProps } from "../../ui";
import { ModelForm, type ModelFormProps } from "../setup/ModelForm";
import { ModelsSection } from "./ModelsSection";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSettings(hash: string) {
  const location = { hash };
  const fetch = vi
    .fn()
    .mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("window", { location });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(toast, "show").mockReturnValue("model-added");
  let form: ModelFormProps | undefined;
  function Capture() {
    const section = ModelsSection();
    for (const child of Children.toArray(section.props.children)) {
      if (!isValidElement<DialogProps>(child) || child.type !== Dialog)
        continue;
      const content = child.props.children;
      if (isValidElement<ModelFormProps>(content) && content.type === ModelForm)
        form = content.props;
    }
    return section;
  }
  renderToStaticMarkup(
    createElement(I18nProvider, {
      locale: "en",
      children: createElement(Capture),
    }),
  );
  return { location, fetch, form };
}

it("ordinary model settings do not automatically open the add form", () => {
  const view = renderSettings("#customize/models");
  expect(view.form).toBeUndefined();
  expect(view.location.hash).toBe("#customize/models");
  expect(view.fetch).not.toHaveBeenCalled();
});

it("onboarding opens the existing add form and returns to the exact conversation only after connection", () => {
  const returnTo = "new?workspace=folder&collection=project";
  const hash = `#customize/models?${new URLSearchParams({ returnTo })}`;
  const view = renderSettings(hash);
  expect(view.form).toBeDefined();
  expect(view.location.hash).toBe(hash);
  view.form!.onConnected({
    id: "first-model",
    model: "First model",
    settings: { models: [], active_id: "first-model", configured: true },
  });
  expect(view.location.hash).toBe(returnTo);
  expect(view.fetch).not.toHaveBeenCalled();
});
