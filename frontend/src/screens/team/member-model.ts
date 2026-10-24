import { zh } from "../../i18n/messages/zh";
import { en } from "../../i18n/messages/en";
import type {
  MemberConfig,
  MemberPermissions,
  TeamMember,
} from "../research/team-api";
import type { Translator, MessageKey } from "../../i18n/i18n";

export const avatarColors = [
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "slate",
] as const;
export const defaultPermissions: MemberPermissions = {
  papers: true,
  files: true,
  commands: false,
  machines: ["host", "local"],
  readonly: false,
};
export const memberName = (m: TeamMember, t: Translator["t"]) => {
  const key = `team.member.${m.role}` as MessageKey;
  if (m.role === "human") return t(key);
  return m.builtin === false ||
    m.role.startsWith("custom_") ||
    ![zh[key], en[key]].includes(m.name)
    ? m.name
    : t(key);
};
export function memberDraft(m?: Partial<MemberConfig>): MemberConfig {
  return {
    name: m?.name ?? "",
    description: m?.description ?? "",
    tools: m?.tools ? [...m.tools] : null,
    wake_minutes: m?.wake_minutes ?? 0,
    avatar_color: m?.avatar_color ?? "blue",
    avatar: m?.avatar ?? "",
    role_description: m?.role_description ?? "",
    model_config_id: m?.model_config_id ?? "",
    permissions: structuredClone(m?.permissions ?? defaultPermissions),
    wake_turns: m?.wake_turns ?? 0,
    wake_tokens: m?.wake_tokens ?? 0,
  };
}
export function permissionChange(
  p: MemberPermissions,
  key: "papers" | "files" | "commands" | "readonly" | "file_readonly",
  checked: boolean,
): MemberPermissions {
  return {
    ...p,
    [key]: checked,
    ...(key === "readonly" && checked ? { commands: false } : {}),
  };
}
export function withMemberPermissions(
  draft: MemberConfig,
  permissions: MemberPermissions,
): MemberConfig {
  const tools = new Set(
    draft.tools ?? [
      ...(draft.permissions.papers ? ["literature"] : []),
      ...(draft.permissions.files ? ["files"] : []),
      "web",
      "project",
      ...(draft.permissions.commands ? ["shell", "experiments"] : []),
    ],
  );
  for (const [flag, groups] of [
    ["papers", ["literature"]],
    ["files", ["files"]],
    ["commands", ["shell", "experiments"]],
  ] as const) {
    if (permissions[flag] !== draft.permissions[flag]) {
      for (const group of groups) {
        if (permissions[flag]) tools.add(group);
        else tools.delete(group);
      }
    }
  }
  return { ...draft, permissions, tools: [...tools] };
}
export function validMember(draft: MemberConfig) {
  return (
    !!draft.name.trim() &&
    draft.name.length <= 100 &&
    avatarColors.includes(
      draft.avatar_color as (typeof avatarColors)[number],
    ) &&
    draft.role_description.length <= 50000 &&
    Number.isInteger(draft.wake_turns) &&
    draft.wake_turns >= 0 &&
    draft.wake_turns <= 256 &&
    Number.isInteger(draft.wake_tokens) &&
    draft.wake_tokens >= 0 &&
    draft.wake_tokens <= 2000000 &&
    Number.isInteger(draft.wake_minutes ?? 0) &&
    (draft.wake_minutes ?? 0) >= 0 &&
    (draft.wake_minutes ?? 0) <= 1440
  );
}
export const initials = (name: string) =>
  Array.from(name.trim()).slice(0, 2).join("").toLocaleUpperCase();

export function memberAvatarSeed(m: Partial<TeamMember>) {
  if (m.avatar?.startsWith("pixel:")) return m.avatar.slice(6);
  return (
    m.avatar_seed ??
    (m.role === "human"
      ? m.id
      : m.role && !m.role.startsWith("custom")
        ? m.role
        : (m.file_path?.split("/").pop()?.replace(/\.md$/, "") ?? m.name)) ??
    ""
  );
}

export function documentDraft(
  document: { source: string; config: MemberConfig & { channels?: string[] } },
  channels: { id: string; name: string }[],
) {
  return {
    source: document.source,
    draft: memberDraft(document.config),
    subscriptions: channels
      .filter((c) =>
        document.config.channels?.some(
          (name) => name === `#${c.name}` || name === c.id,
        ),
      )
      .map((c) => c.id),
  };
}
