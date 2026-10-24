import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { pixelAvatarSvg } from "../../ui/pixel-avatar";
import { MemberAvatar, MemberFields } from "./MemberEditor";
import { memberAvatarSeed, memberDraft } from "./member-model";
import { workflowMembers } from "./TeamSettings";
import { workflowToFlow } from "./workflow/workflow-model";
import { MessageRow } from "../research/TeamScreen";
import type { TeamMember } from "../research/team-api";

const member: TeamMember = {
  id: "ada-id",
  name: "Ada",
  role: "custom_ada",
  file_path: ".ora/agents/Ada.md",
  status: "idle",
  active_run_id: null,
};

describe("member avatars", () => {
  it("shows the researcher's own research message without an avatar", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        locale: "en",
        children: createElement(MessageRow, {
          team: {
            workspace_id: "w",
            members: [{ ...member, role: "human", avatar_seed: "user-id" }],
            channels: [],
            notifications: [],
          },
          message: {
            id: "research",
            channel_id: "c",
            thread_id: null,
            author_id: null,
            kind: "research",
            text: "Question",
            mentions: [],
            data: {},
            created_at: "2026-10-24",
            replies: 0,
          },
          onFile: () => {},
          openThread: () => {},
          fork: () => {},
        }),
      }),
    );
    // The researcher's own messages sit on the right without an avatar.
    expect(html).toContain('data-author="human"');
    expect(html).not.toContain(pixelAvatarSvg("user-id"));
  });
  it("uses the filename, built-in role and user id independently of display names", () => {
    expect(memberAvatarSeed({ ...member, name: "New name" })).toBe("Ada");
    expect(memberAvatarSeed({ ...member, role: "advisor" })).toBe("advisor");
    expect(
      memberAvatarSeed({ ...member, role: "human", avatar_seed: "user-id" }),
    ).toBe("user-id");
    expect(memberAvatarSeed({ ...member, avatar: "pixel:chosen" })).toBe(
      "chosen",
    );
    expect(
      renderToStaticMarkup(createElement(MemberAvatar, { member })),
    ).toContain(pixelAvatarSvg("Ada"));
    expect(
      renderToStaticMarkup(
        createElement(MemberAvatar, {
          member: { ...member, avatar: "pixel:chosen", avatar_url: "/old.png" },
        }),
      ),
    ).toContain(pixelAvatarSvg("chosen"));
  });

  it("renders custom images and falls back when the backend cannot supply an image URL", () => {
    const custom = { ...member, avatar: ".ora/avatars/Ada.png" };
    expect(
      renderToStaticMarkup(
        createElement(MemberAvatar, {
          member: { ...custom, avatar_url: "/avatar?v=1" },
        }),
      ),
    ).toContain('<img src="/avatar?v=1" alt=""');
    expect(
      renderToStaticMarkup(createElement(MemberAvatar, { member: custom })),
    ).toContain(pixelAvatarSvg("Ada"));
  });

  it("carries the same avatar into workflow nodes", () => {
    const members = workflowMembers(
      {
        workspace_id: "w",
        members: [{ ...member, avatar: "pixel:chosen" }],
        channels: [],
        notifications: [],
      },
      () => "Ada",
    );
    const flow = workflowToFlow(
      {
        id: "wf",
        name: "wf",
        builtin: false,
        version: 1,
        rules: [],
        layout: { members: { "ada-id": { x: 0, y: 0 } }, channels: {} },
      },
      members,
      [],
    );
    expect(flow.nodes[0].data.member).toMatchObject({
      avatar: "pixel:chosen",
      avatar_seed: "chosen",
    });
  });

  for (const locale of ["zh", "en"] as const) {
    it(`renders the avatar editor in ${locale} without the color selector`, () => {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          locale,
          children: createElement(MemberFields, {
            draft: memberDraft({ name: "Ada" }),
            identityLocked: false,
            models: [],
            machines: [],
            onChange: () => {},
            onUpload: () => {},
          }),
        }),
      );
      expect(html).toContain(locale === "zh" ? "换一个" : "Another one");
      expect(html).toContain(locale === "zh" ? "上传图片" : "Upload image");
      expect(html).toContain('data-size="lg"');
      expect(html).not.toContain(locale === "zh" ? "头像颜色" : "Avatar color");
    });
  }
});
