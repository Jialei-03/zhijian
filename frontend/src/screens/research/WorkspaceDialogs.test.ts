import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { send } from "../../api";
import { I18nProvider } from "../../i18n/I18nProvider";
import { createTranslator } from "../../i18n/i18n";
import { CreateWorkspaceDialog } from "./WorkspaceDialogs";
import { WorkspaceScreen } from "./ResearchLibrary";
import { TeamNavigation } from "./TeamNavigation";
import { createPhysicalWorkspace } from "./navigation-api";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  send: vi.fn().mockResolvedValue({ id: "created" }),
}));

afterEach(() => vi.clearAllMocks());

describe("project creation", () => {
  for (const locale of ["zh", "en"] as const) {
    const { t } = createTranslator(locale);
    const render = (children: React.ReactNode) =>
      renderToStaticMarkup(createElement(I18nProvider, { locale, children }));

    it(`${locale} starts with a required, editable project name and new folder mode`, () => {
      const html = render(
        createElement(CreateWorkspaceDialog, {
          onClose() {},
          onCreated() {},
        }),
      );
      expect(html).toContain(`value="${t("workspace.untitled")}"`);
      expect(html).toMatch(/<input[^>]*required=""/);
      expect(html).toMatch(
        new RegExp(
          `role="radio" aria-checked="true"[^>]*><span[^>]*>${t("workspace.newFolder")}</span>`,
        ),
      );
      expect(html).toContain(t("workspace.existingFolder"));
      expect(html).not.toContain(`aria-label="${t("workspace.browse")}"`);
      expect(html).not.toContain("/Users/");
      // The default parent has not loaded during SSR, so submission is disabled.
      expect(html).toMatch(
        new RegExp(
          `<button[^>]*disabled=""[^>]*><span[^>]*>${t("workspace.add")}</span></button>`,
        ),
      );
    });

    it(`${locale} gives an empty project list an icon and a creation button`, () => {
      const html = render(createElement(WorkspaceScreen, { go() {} }));
      const empty = html.slice(html.indexOf("emptyProjects"));
      expect(empty).toContain("<svg");
      expect(empty).toContain(t("workspace.add"));
      expect(empty).not.toMatch(/<p[ >]/);
      expect(html).not.toContain(t("workspace.noWorkspaces"));
    });

    it(`${locale} keeps the empty sidebar entries fixed and unavailable until a project exists`, () => {
      const html = render(createElement(TeamNavigation, { hash: "", go() {} }));
      for (const id of [
        "threads",
        "activity",
        "team-settings",
        "create-channel",
      ])
        expect(html).toMatch(
          new RegExp(`<button[^>]*data-id="${id}"[^>]*disabled=""`),
        );
      expect(html).not.toContain(t("workspace.add"));
      expect(html).not.toContain("#workspaces");
      expect(t("team.switch")).toBe(
        locale === "zh" ? "切换项目" : "Switch project",
      );
      expect(t("team.settings")).toBe(
        locale === "zh" ? "团队设置" : "Team settings",
      );
    });
  }

  it("sends a new-folder request explicitly and keeps existing-folder binding compatible", async () => {
    const location = {
      kind: "local" as const,
      path: "/home/test/ORA",
      connection_id: "",
    };
    await createPhysicalWorkspace("My project", location, true);
    expect(send).toHaveBeenLastCalledWith("/research/workspaces", {
      name: "My project",
      location,
      create_folder: true,
    });
    await createPhysicalWorkspace("Existing project", location);
    expect(send).toHaveBeenLastCalledWith("/research/workspaces", {
      name: "Existing project",
      location,
    });
  });
});
