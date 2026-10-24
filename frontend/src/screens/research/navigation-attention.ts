import type { ResearchNavigation } from "./navigation-api";
import { researchStatus } from "./navigation-status";
import { teamHash, type TeamMessage } from "./team-api";

export type AttentionMessage = TeamMessage & { workspace_id: string };

/** Unread activity alone is not a request for a decision. */
export function needsYou(
  data: ResearchNavigation,
  messages: AttentionMessage[],
) {
  const active = data.workspaces.filter((workspace) => !workspace.archived);
  const workspaceIds = new Set(active.map((workspace) => workspace.id));
  return [
    ...messages
      .filter(
        (message) =>
          workspaceIds.has(message.workspace_id) && message.data.waiting,
      )
      .map((message) => ({
        id: `message:${message.workspace_id}:${message.id}`,
        title: message.text,
        at: message.created_at,
        hash: teamHash(
          message.workspace_id,
          message.channel_id,
          message.thread_id || message.id,
        ),
      })),
    ...active
      .flatMap((workspace) => workspace.researches)
      .filter(
        (research) =>
          !research.archived_at &&
          researchStatus(research) === "research.status.waiting",
      )
      .map((research) => ({
        id: `research:${research.id}`,
        title: research.title || research.question,
        at: research.updated_at || "",
        hash: teamHash(research.workspace_id, "", `research:${research.id}`),
      })),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
