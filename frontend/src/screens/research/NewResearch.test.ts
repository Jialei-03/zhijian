import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { parseAppRoute } from "../../app/routes";
import { NewResearch } from "./NewResearch";
import { getTeam } from "./team-api";
import { startProject } from "./research-api";
import { refreshResearchNavigation } from "./navigation-api";
import { toast } from "../../ui";
import type { TeamChannel } from "./team-api";

const fixture = vi.hoisted(() => ({
  workspace: "11111111-1111-4111-8111-111111111111",
  research: "22222222-2222-4222-8222-222222222222",
  channel: "33333333-3333-4333-8333-333333333333",
  send: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("./ResearchNavigation", () => ({
  useResearchNavigation: () => ({
    data: {
      workspaces: [{ id: fixture.workspace, archived: false }],
      collections: [],
    },
    ready: true,
    loading: false,
    error: "",
  }),
}));
vi.mock("./WorkspaceDialogs", () => ({ WorkspacePicker: () => null }));
vi.mock("../workflows/WorkflowPicker", () => ({ WorkflowPicker: () => null }));
vi.mock("./talk/Composer", () => ({
  Composer: ({ onSend }: { onSend: () => Promise<void> }) => {
    fixture.send = onSend;
    return null;
  },
}));
vi.mock("./team-api", async (original) => ({
  ...(await original<typeof import("./team-api")>()),
  getTeam: vi.fn(),
}));
vi.mock("./research-api", async (original) => ({
  ...(await original<typeof import("./research-api")>()),
  startProject: vi.fn(),
  resumeProject: vi.fn(),
}));
vi.mock("./navigation-api", async (original) => ({
  ...(await original<typeof import("./navigation-api")>()),
  refreshResearchNavigation: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("first research message", () => {
  for (const hasExperiments of [true, false]) {
    it(`opens the created research with experiments channel ${hasExperiments ? "present" : "absent"}`, async () => {
      vi.stubGlobal("localStorage", {
        getItem: (key: string) =>
          key.endsWith(":model") ? "model-one" : "Research question",
        setItem: vi.fn(),
        removeItem: vi.fn(),
      });
      const channels: TeamChannel[] = hasExperiments
        ? [
            {
              id: fixture.channel,
              key: "experiments",
              name: "Experiments",
              member_id: null,
              unread: 0,
            },
          ]
        : [];
      vi.mocked(getTeam).mockResolvedValue({
        workspace_id: fixture.workspace,
        members: [],
        channels,
        notifications: [],
      });
      vi.mocked(startProject).mockResolvedValue({
        id: fixture.research,
      } as Awaited<ReturnType<typeof startProject>>);
      const notify = vi.spyOn(toast, "show");
      const go = vi.fn();
      renderToStaticMarkup(
        createElement(I18nProvider, {
          locale: "zh",
          children: createElement(NewResearch, {
            workspaceId: fixture.workspace,
            go,
          }),
        }),
      );
      await fixture.send!();
      expect(startProject).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Research question",
          workspace_id: fixture.workspace,
          model_config_id: "model-one",
        }),
      );
      expect(go).toHaveBeenCalledWith(
        hasExperiments
          ? `team/${fixture.workspace}/${fixture.channel}?thread=research%3A${fixture.research}`
          : `research/${fixture.research}`,
      );
      expect(parseAppRoute(go.mock.calls[0][0]).redirect).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(refreshResearchNavigation).toHaveBeenCalled();
    });
  }
});
