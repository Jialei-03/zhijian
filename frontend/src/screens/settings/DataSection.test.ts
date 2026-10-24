import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { Button, type ButtonProps } from "../../ui";
import { LogFolder } from "./DataSection";

afterEach(() => vi.unstubAllGlobals());

function folder(desktop: boolean, locale: "en" | "zh" = "zh") {
  const assign = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("document", {
    documentElement: { dataset: desktop ? { desktop: "darwin" } : {} },
  });
  vi.stubGlobal("window", { location: { assign } });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  let action: ButtonProps | undefined;
  function Capture() {
    const view = LogFolder({ path: "/tmp/ora data/logs" });
    const row = Children.toArray(view.props.children)[0];
    if (isValidElement<{ children: React.ReactNode }>(row))
      for (const child of Children.toArray(row.props.children))
        if (isValidElement<ButtonProps>(child) && child.type === Button)
          action = child.props;
    return view;
  }
  const html = renderToStaticMarkup(
    createElement(I18nProvider, { locale, children: createElement(Capture) }),
  );
  return { html, action: action!, assign, writeText };
}

it("shows a copyable log path in the local browser", () => {
  const view = folder(false);
  expect(view.html).toContain("/tmp/ora data/logs");
  expect(view.html).toContain("复制路径");
  view.action.onClick!({} as never);
  expect(view.writeText).toHaveBeenCalledWith("/tmp/ora data/logs");
  expect(view.assign).not.toHaveBeenCalled();
});

it("opens the existing desktop folder action with a short localized label", () => {
  for (const locale of ["en", "zh"] as const) {
    const view = folder(true, locale);
    expect(view.html).toContain(
      locale === "zh" ? "打开日志文件夹" : "Open log folder",
    );
    expect(view.html).not.toContain("/tmp/ora data/logs");
    view.action.onClick!({} as never);
    expect(view.assign).toHaveBeenCalledWith("ora:logs");
    expect(view.writeText).not.toHaveBeenCalled();
  }
});
