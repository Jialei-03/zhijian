import {
  Children,
  createElement,
  isValidElement,
  type FormEvent,
  type FormHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type TextareaHTMLAttributes,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/I18nProvider";
import { createTranslator } from "../../../i18n/i18n";
import { AddModelButton } from "../../setup/ModelSetup";
import { TeamComposer } from "../TeamScreen";
import { sendTeamMessage, type Team } from "../team-api";
import { Composer } from "./Composer";

vi.mock("../team-api", async (original) => ({
  ...(await original<typeof import("../team-api")>()),
  sendTeamMessage: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderForm(
  make: () => ReactElement<FormHTMLAttributes<HTMLFormElement>>,
  locale: "zh" | "en" = "zh",
) {
  let form!: ReactElement<FormHTMLAttributes<HTMLFormElement>>;
  function Capture() {
    form = make();
    return form;
  }
  const html = renderToStaticMarkup(
    createElement(I18nProvider, { locale, children: createElement(Capture) }),
  );
  const field = Children.toArray(form.props.children).find(
    (child) => isValidElement(child) && child.type === "textarea",
  ) as ReactElement<TextareaHTMLAttributes<HTMLTextAreaElement>>;
  return {
    html,
    submit: () =>
      form.props.onSubmit!({
        preventDefault() {},
      } as FormEvent<HTMLFormElement>),
    enter: (overrides = {}) =>
      field.props.onKeyDown!({
        key: "Enter",
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault() {},
        ...overrides,
      } as KeyboardEvent<HTMLTextAreaElement>),
  };
}

function setup(hash = "#new") {
  const location = { hash };
  const fetch = vi
    .fn()
    .mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("window", { location });
  vi.stubGlobal("fetch", fetch);
  return { location, fetch };
}

const props = () => ({
  value: "保留这段草稿",
  onChange: vi.fn(),
  onSend: vi.fn(),
  placeholder: "",
  label: "Message",
  sendLabel: "Send",
});

for (const locale of ["zh", "en"] as const) {
  it(`${locale}: no-model composer replaces the picker with a primary add button and preserves the draft on submit and Enter`, () => {
    const { t } = createTranslator(locale);
    const { location, fetch } = setup(
      "#new?workspace=folder&collection=project",
    );
    const input = { ...props(), needsModel: true, sendDisabled: true };
    const view = renderForm(
      () => Composer({ ...input, tools: "Old picker" }),
      locale,
    );
    expect(view.html).toMatch(
      new RegExp(
        `class="[^"]*primary[^"]*"[^>]*><span[^>]*>${t("settings.models.add")}</span>`,
      ),
    );
    expect(view.html).not.toContain("Old picker");
    const sendButton = view.html.match(
      /<button[^>]*aria-label="Send"[^>]*>/,
    )?.[0];
    expect(sendButton).toBeDefined();
    expect(sendButton).not.toContain('disabled=""');
    for (const send of [view.submit, view.enter]) {
      location.hash = "#new?workspace=folder&collection=project";
      send();
      expect(location.hash.split("?")[0]).toBe("customize/models");
      expect(
        new URLSearchParams(location.hash.split("?")[1]).get("returnTo"),
      ).toBe("new?workspace=folder&collection=project");
      expect(input.onSend).not.toHaveBeenCalled();
      expect(input.onChange).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });
}

it("the add button opens model setup even with an empty draft", () => {
  const { location } = setup();
  function Capture() {
    const button = AddModelButton({});
    button.props.onClick();
    return button;
  }
  renderToStaticMarkup(
    createElement(I18nProvider, {
      locale: "en",
      children: createElement(Capture),
    }),
  );
  expect(location.hash).toBe("customize/models?returnTo=new");
});

it("normal sending, busy, empty, Shift+Enter and IME behavior stay intact", () => {
  const { location } = setup();
  const input = props();
  const view = renderForm(() => Composer(input));
  view.submit();
  expect(input.onSend).toHaveBeenCalledOnce();
  for (const override of [
    { value: " " },
    { busy: true },
    { disabled: true },
    { commandsOnly: true },
  ]) {
    renderForm(() =>
      Composer({ ...input, ...override, needsModel: true }),
    ).submit();
  }
  const onboarding = renderForm(() => Composer({ ...input, needsModel: true }));
  onboarding.enter({ shiftKey: true });
  onboarding.enter({ nativeEvent: { isComposing: true } });
  expect(input.onSend).toHaveBeenCalledOnce();
  expect(location.hash).toBe("#new");
});

it("team DM and thread sends open model setup before clearing or sending the stored draft", () => {
  const team: Team = {
    workspace_id: "workspace",
    members: [],
    channels: [],
    notifications: [],
  };
  for (const threadId of [undefined, "research:thread"]) {
    const hash = `#team/workspace/dm${threadId ? "?thread=research%3Athread" : ""}`;
    const { location, fetch } = setup(hash);
    const storage = {
      getItem: () => "Unsent team draft",
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", storage);
    const sent = vi.fn();
    const view = renderForm(() =>
      TeamComposer({
        team,
        channel: {
          id: "dm",
          key: "dm:advisor",
          name: "Advisor",
          member_id: threadId ? null : "advisor",
          unread: 0,
        },
        threadId,
        models: [],
        model: "stale-model",
        onModel() {},
        sent,
      }),
    );
    expect(view.html).toContain("添加模型");
    expect(view.html).toContain("Unsent team draft");
    view.submit();
    expect(
      new URLSearchParams(location.hash.split("?")[1]).get("returnTo"),
    ).toBe(hash.slice(1));
    location.hash = hash;
    view.enter();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(sendTeamMessage).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }
});

it("ordinary team channels can still post messages without a model", () => {
  const { location } = setup("#team/workspace/channel");
  vi.stubGlobal("localStorage", {
    getItem: () => "Channel message",
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  const view = renderForm(() =>
    TeamComposer({
      team: {
        workspace_id: "workspace",
        members: [],
        channels: [],
        notifications: [],
      },
      channel: {
        id: "channel",
        key: "general",
        name: "General",
        member_id: null,
        unread: 0,
      },
      models: [],
      model: "",
      onModel() {},
      sent() {},
    }),
  );
  expect(view.html).not.toContain("添加模型");
  view.submit();
  expect(sendTeamMessage).toHaveBeenCalledWith(
    "workspace",
    "channel",
    expect.objectContaining({ text: "Channel message" }),
  );
  expect(location.hash).toBe("#team/workspace/channel");
});
