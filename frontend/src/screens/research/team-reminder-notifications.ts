import { teamHash, type TeamMessage } from "./team-api";

declare global {
  interface Window {
    oraDesktop?: {
      notifyReminder(value: {
        id: string;
        title: string;
        body: string;
        hash: string;
      }): void;
    };
  }
}

export function notifyTeamReminders(
  workspace: string,
  messages: TeamMessage[],
  title: string,
) {
  if (!window.oraDesktop) return;
  for (const message of messages) {
    if (message.kind !== "reminder" || message.data.read) continue;
    window.oraDesktop.notifyReminder({
      id: message.id,
      title,
      body: message.text,
      hash: teamHash(workspace, "mentions"),
    });
  }
}
