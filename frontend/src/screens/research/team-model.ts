import { zh } from "../../i18n/messages/zh";
import { createTranslator } from "../../i18n/i18n";
import type {
  Team,
  TeamActivity,
  TeamChannel,
  TeamMember,
  TeamMessage,
} from "./team-api";
import { memberName } from "../team/member-model";

export const memberLabel = (
  member: TeamMember | undefined,
  t: Parameters<typeof memberName>[1],
) => (member ? memberName(member, t) : "");

export function directChannels(team: Pick<Team, "channels" | "members">) {
  return team.channels.flatMap((channel) => {
    const member = team.members.find((m) => m.id === channel.member_id);
    return member && !member.deleted ? [{ channel, member }] : [];
  });
}

export const normalizedText = (text: string) => text.replaceAll("\\n", "\n");
export function mentionQuery(text: string, caret: number) {
  const match = text.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/u);
  return match
    ? {
        query: match[1].toLocaleLowerCase(),
        start: caret - match[1].length - 1,
        end: caret,
      }
    : null;
}
export function mentionMatches(
  members: TeamMember[],
  query: string,
  name: (member: TeamMember) => string,
) {
  return members.filter(
    (m) =>
      m.enabled !== false &&
      !m.deleted &&
      `${m.name} ${m.role} ${name(m)}`.toLocaleLowerCase().includes(query),
  );
}
export const sendMode = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  event.metaKey || event.ctrlKey ? ("immediate" as const) : ("queue" as const);
export function mentionedAgents(
  text: string,
  members: TeamMember[],
  name: (member: TeamMember) => string,
) {
  return members.filter(
    (member) =>
      member.role !== "human" &&
      member.enabled !== false &&
      !member.deleted &&
      [member.id, member.name, member.role, name(member)].some((alias) =>
        new RegExp(
          `@${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`,
          "iu",
        ).test(text),
      ),
  );
}
export function orderedMessages(messages: TeamMessage[]) {
  return [
    ...new Map(
      messages.map((m) => [m.id, { ...m, text: normalizedText(m.text) }]),
    ).values(),
  ].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

export const threadActivity = (message: TeamMessage) =>
  message.last_message_at || message.created_at;

export function recentThreads(messages: TeamMessage[]) {
  return orderedMessages(messages).sort(
    (a, b) =>
      Date.parse(threadActivity(b)) - Date.parse(threadActivity(a)) ||
      b.id.localeCompare(a.id),
  );
}

export function activityMessages(
  events: TeamActivity[],
  filter: "all" | "mention" | "reply",
) {
  return [...new Map(events.map((event) => [event.id, event])).values()]
    .filter(
      (event) => filter === "all" || event.activity_types.includes(filter),
    )
    .sort(
      (a, b) =>
        Date.parse(b.created_at) - Date.parse(a.created_at) ||
        b.id.localeCompare(a.id),
    );
}

export function activityTarget(
  event: Pick<TeamMessage, "id" | "channel_id" | "thread_id" | "data">,
) {
  const reminder = event.data.reminder;
  return reminder
    ? {
        id: reminder.message_id,
        channel_id: reminder.channel_id,
        thread_id: reminder.thread_id,
      }
    : event;
}

export function conversationName(
  channel: Pick<TeamChannel, "key" | "name" | "member_id"> | undefined,
  members: TeamMember[],
  t: Parameters<typeof memberName>[1],
) {
  if (!channel) return "";
  const member = members.find((member) => member.id === channel.member_id);
  if (member) return memberName(member, t);
  if (channel.member_id) return channel.name;
  return `#${
    defaultChannelNames[channel.key] === channel.name
      ? t(`team.channel.${channel.key}` as Parameters<typeof t>[0])
      : channel.name
  }`;
}

export function threadDate(
  stamp: string,
  locale: string,
  now = new Date(),
  format: "thread" | "conversation" | "relative" = "thread",
) {
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) return "—";
  if (format === "relative") {
    const seconds = Math.min(0, (date.getTime() - now.getTime()) / 1000);
    const [value, unit] =
      Math.abs(seconds) < 60
        ? ([0, "second"] as const)
        : Math.abs(seconds) < 3600
          ? ([Math.ceil(seconds / 60), "minute"] as const)
          : Math.abs(seconds) < 86400
            ? ([Math.ceil(seconds / 3600), "hour"] as const)
            : ([Math.ceil(seconds / 86400), "day"] as const);
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      value,
      unit,
    );
  }
  const today = date.toDateString() === now.toDateString();
  if (format === "conversation" && !today) {
    const yesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
    );
    if (date.toDateString() === yesterday.toDateString())
      return createTranslator(locale.startsWith("zh") ? "zh" : "en").t(
        "team.yesterday",
      );
    const monday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - ((now.getDay() + 6) % 7),
    );
    if (date >= monday && date < now)
      return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    ...(today
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : {
          ...(format === "thread" && date.getFullYear() !== now.getFullYear()
            ? { year: "numeric" }
            : {}),
          month: "short",
          day: "numeric",
        }),
  }).format(date);
}

export const defaultChannelNames: Record<string, string> = {
  review: zh["team.channel.review"],
  experiments: zh["team.channel.experiments"],
  writing: zh["team.channel.writing"],
  general: zh["team.channel.general"],
};
