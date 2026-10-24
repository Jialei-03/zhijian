import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import {
  memberDraft,
  memberName,
  permissionChange,
  validMember,
  initials,
} from "./member-model";
import { MemberFields, PermissionFields } from "./MemberEditor";
import { Members } from "./Members";
import { MemberStatus } from "../research/TeamNavigation";
import { workflowMembers } from "./TeamSettings";
import { mentionMatches } from "../research/team-model";
import { en } from "../../i18n/messages/en";
import { validateRule } from "./workflow/workflow-model";
import type { TeamMember } from "../research/team-api";

const ada: TeamMember = {
  id: "ada",
  name: "Ada",
  role: "custom_ada",
  builtin: false,
  enabled: true,
  status: "idle",
  active_run_id: null,
};

for (const locale of ["zh", "en"] as const) {
  it(`labels built-in updates and restores in ${locale}`, () => {
    for (const available of [false, true]) {
      const member: TeamMember = {
        ...ada,
        role: "librarian",
        builtin: true,
        builtin_update_available: available,
      };
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(Members, {
            team: {
              workspace_id: "w",
              members: [member],
              channels: [],
              notifications: [],
            },
            selected: member.id,
            go() {},
          }),
        }),
      );
      const label =
        locale === "zh"
          ? available
            ? "更新到内置新版"
            : "恢复内置文件"
          : available
            ? "Update to latest built-in"
            : "Restore built-in file";
      expect(html).toContain(`>${label}</span></button>`);
    }
  });
}

describe("member status", () => {
  for (const locale of ["zh", "en"] as const) {
    it(`labels each state and gives disabled members precedence in ${locale}`, () => {
      const labels =
        locale === "zh"
          ? ["空闲", "工作中", "排队中", "等你", "已停用"]
          : ["Idle", "Working", "Queued", "Waiting for you", "Disabled"];
      for (const [index, state] of (
        ["idle", "working", "queued", "waiting", "disabled"] as const
      ).entries()) {
        const html = renderToStaticMarkup(
          createElement(I18nProvider, {
            locale,
            children: createElement(MemberStatus, {
              status: state === "disabled" ? "working" : state,
              enabled: state !== "disabled",
            }),
          }),
        );
        expect(html).toContain(`data-status="${state}"`);
        expect(html).toContain('role="img"');
        expect(html).toContain(`aria-label="${labels[index]}"`);
      }
    });
  }
});

describe("custom members", () => {
  it("validates the actual form and isolates permission drafts", () => {
    const form = memberDraft({ name: "Ada" });
    expect(validMember(form)).toBe(true);
    for (const patch of [
      { name: " " },
      { wake_turns: -1 },
      { wake_tokens: -1 },
      { wake_turns: 1.5 },
      { wake_tokens: 2000001 },
      { avatar_color: "pink" },
    ])
      expect(validMember({ ...form, ...patch })).toBe(false);
    expect(memberDraft(form).permissions).not.toBe(form.permissions);
    expect(initials(" Ada ")).toBe("AD");
  });
  it("turns off command access when read-only is selected", () => {
    const form = memberDraft();
    const commands = permissionChange(form.permissions, "commands", true);
    expect(commands.commands).toBe(true);
    expect(permissionChange(commands, "readonly", true)).toMatchObject({
      readonly: true,
      commands: false,
    });
    expect(form.permissions.commands).toBe(false);
  });
  it("uses real names and excludes disabled members from mentions", () => {
    expect(memberName(ada, (key) => en[key])).toBe("Ada");
    expect(
      mentionMatches(
        [ada, { ...ada, id: "off", enabled: false }],
        "ada",
        (m) => m.name,
      ),
    ).toEqual([ada]);
    const mapped = workflowMembers(
      { workspace_id: "w", channels: [], notifications: [], members: [ada] },
      (key) => en[key],
    );
    expect(mapped[0]).toMatchObject({
      id: "ada",
      name: "Ada",
      role: "custom_ada",
      enabled: true,
    });
  });
  it("accepts subscriber wake rules only on new messages", () => {
    const rule = {
      id: "s",
      enabled: true,
      when: { event: "message" as const },
      then: { action: "wake" as const, subscribers: true },
      limit: { per_thread: 1 },
    };
    expect(validateRule(rule)).toBe(true);
    expect(validateRule({ ...rule, when: { event: "mention" } })).toBe(false);
  });
  for (const locale of ["zh", "en"] as const)
    it(`${locale} renders labeled fields, locked built-in identity and effective permissions`, () => {
      const draft = memberDraft({
        name: "Ada",
        permissions: {
          papers: true,
          files: true,
          commands: false,
          machines: ["host"],
          readonly: true,
        },
      });
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(MemberFields, {
            draft,
            identityLocked: true,
            models: [],
            machines: [{ id: "host", name: "Host" }],
            onChange: () => {},
          }),
        }),
      );
      expect(html).toContain('value="Ada"');
      expect(html).toContain('disabled=""');
      expect(html).toContain(locale === "zh" ? "角色说明" : "Role description");
      expect(html).toContain('type="checkbox"');
      const permissions = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(PermissionFields, {
            value: draft.permissions,
            machines: [{ id: "host", name: "Host" }],
            onChange: () => {},
          }),
        }),
      );
      expect(permissions).toContain("Host");
    });
});

describe("agent file editor", () => {
  it("maps source-mode definitions back into form fields and channel selections", async () => {
    const { documentDraft } = await import("./member-model");
    const document = {
      source: "---\nname: Ada\nfuture: [keep]\n---\n\n# Source body",
      config: {
        ...memberDraft({
          name: "Ada",
          description: "From source",
          role_description: "# Source body",
          tools: ["files", "UnknownTool"],
          wake_minutes: 8,
        }),
        channels: ["#综述", "raw-id"],
      },
    };
    const next = documentDraft(document, [
      { id: "review", name: "综述" },
      { id: "raw-id", name: "闲聊" },
    ]);
    expect(next.source).toBe(document.source);
    expect(next.draft).toMatchObject({
      name: "Ada",
      description: "From source",
      role_description: "# Source body",
      tools: ["files", "UnknownTool"],
      wake_minutes: 8,
    });
    expect(next.subscriptions).toEqual(["review", "raw-id"]);
    expect(next.draft.tools).not.toBe(document.config.tools);
  });
  for (const locale of ["zh", "en"] as const) {
    it(`${locale} renders form/body columns and the full source editor`, async () => {
      const { MemberEditor } = await import("./MemberEditor");
      const props = {
        initial: memberDraft({ name: "Ada", description: "Checks citations" }),
        initialSource: "---\nname: Ada\nfuture: yes\n---\n\n# Body",
        team: {
          workspace_id: "w",
          channels: [],
          notifications: [],
          members: [],
        },
        library: [],
        models: [],
        machines: [],
        onClose: () => {},
        onSave: async () => {},
      };
      const form = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(MemberEditor, props),
        }),
      );
      expect(form).toContain(locale === "zh" ? "简介" : "Description");
      expect(form).toContain('value="Ada"');
      expect(form).toContain(locale === "zh" ? "源文件" : "Source file");
      const source = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(MemberEditor, {
            ...props,
            initialError: "Line 3",
          }),
        }),
      );
      expect(source).toContain("future: yes");
      expect(source).toContain("# Body");
      expect(source).toContain("Line 3");
      expect(source).not.toContain('value="Ada"');
    });
  }
});

it("keeps permission checkboxes and explicit tool groups in sync before saving", async () => {
  const { withMemberPermissions } = await import("./member-model");
  const draft = memberDraft({
    name: "Ada",
    tools: ["files", "literature", "web", "FutureTool", "shell"],
    permissions: { ...memberDraft().permissions, commands: true },
  });
  const changed = withMemberPermissions(draft, {
    ...draft.permissions,
    files: false,
    commands: false,
  });
  expect(changed.tools).toEqual(["literature", "web", "FutureTool"]);
  expect(changed.permissions.files).toBe(false);
  const fresh = withMemberPermissions(memberDraft(), {
    ...memberDraft().permissions,
    files: false,
  });
  expect(fresh.tools).not.toContain("files");
  expect(draft.tools).toContain("files");
});
