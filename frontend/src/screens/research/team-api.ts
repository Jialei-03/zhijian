import type {
  Workflow,
  WorkflowRuntime,
} from "../team/workflow/workflow-model";
import { api, send } from "../../api";
import type { ResearchRun } from "./process/model";

export interface MemberPermissions {
  papers: boolean;
  files: boolean;
  commands: boolean;
  machines: string[];
  readonly: boolean;
  file_readonly?: boolean;
}
export interface MemberConfig {
  name: string;
  description?: string;
  tools?: string[] | null;
  wake_minutes?: number;
  avatar_color: string;
  avatar?: string;
  role_description: string;
  model_config_id: string;
  permissions: MemberPermissions;
  wake_turns: number;
  wake_tokens: number;
}
export interface AgentDocument {
  source: string;
  config: MemberConfig & { channels?: string[] };
  warnings: string[];
}
export interface AgentFile {
  source?: string;
  revision?: string;
  file_path?: string;
  file_error?: string;
}
export interface AvatarUpload {
  extension: "png" | "jpg" | "jpeg" | "webp" | "svg";
  content: string;
}
export interface LibraryMember extends AgentFile {
  id: string;
  version: number;
  config: MemberConfig;
  teams: string[];
}
export interface TeamMember extends Partial<MemberConfig>, AgentFile {
  avatar_url?: string | null;
  avatar_seed?: string;
  library_id?: string | null;
  builtin?: boolean;
  builtin_update_available?: boolean;
  enabled?: boolean;
  paused?: boolean;
  deleted?: boolean;
  subscriptions?: string[];
  overrides?: string[];
  tokens?: number;
  max_tokens?: number;
  id: string;
  role: string;
  name: string;
  status: "idle" | "working" | "queued" | "waiting";
  active_run_id: string | null;
  current_step?: import("./process/model").RunStep | null;
  status_text?: string;
  elapsed_seconds?: number;
  queue_ahead?: number;
  active_model?: string;
  effective_model_config_id?: string;
}
export interface TeamChannel {
  id: string;
  key: string;
  name: string;
  member_id: string | null;
  unread: number;
  pinned_count?: number;
  last_message?: {
    author_id: string | null;
    author_name: string;
    text: string;
    created_at: string;
  } | null;
  last_at?: string;
  working_member_ids?: string[];
}
export type TeamPaperLink =
  | string
  | {
      title?: string;
      name?: string;
      url?: string;
      href?: string;
    };
export interface TeamChanges {
  commit: string;
  files: { path: string; added: number; removed: number; status: string }[];
  added: number;
  removed: number;
}
export interface TeamFileDiff {
  path: string;
  diff: string;
  truncated: boolean;
}
export type ReactionEmoji = "👍" | "👎" | "✅";
export interface TeamReaction {
  emoji: ReactionEmoji;
  count: number;
  mine: boolean;
}
export interface TeamMessageReference {
  message_id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string | null;
  author_name: string;
  created_at: string;
  text: string;
}
export interface TeamMessage {
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string | null;
  text: string;
  kind: string;
  pinned?: boolean;
  mentions: string[];
  reactions?: TeamReaction[];
  data: {
    done_when?: string;
    mode?: "queue" | "immediate" | "record";
    decision?: {
      status: "accepted" | "changes_requested";
      feedback: string;
      event_id: string;
      created_at: string;
    };
    forward?: TeamMessageReference;
    quote?: TeamMessageReference;
    to?: string[];
    woken_by?: string;
    paper?: TeamPaperLink;
    papers?: TeamPaperLink[];
    citation?: TeamPaperLink;
    citations?: TeamPaperLink[];
    rule?: string;
    workflow?: string;
    workflow_version?: number;
    waiting?: boolean;
    research_id?: string;
    event_id?: string;
    sprint_id?: string;
    title?: string;
    research_forwarded?: boolean;
    attachments?: { id: string; name: string; url: string }[];
    files?: { path: string; name: string }[];
    commit?: string;
    changes?: TeamChanges;
    reverted_by?: string;
    links?: { channel_id: string; thread_id: string; name: string }[];
    file_error?: string;
    reason?: string;
    limit?: number;
    read?: boolean;
    also_channel?: boolean;
    thread_origin?: { thread_id: string; message_id: string };
    paused_member?: string;
    reminder?: {
      message_id: string;
      channel_id: string;
      thread_id: string | null;
    };
  };
  created_at: string;
  last_message_at?: string;
  channel?: Pick<TeamChannel, "id" | "key" | "name" | "member_id">;
  participant_ids?: string[];
  unread?: number;
  preview?: string;
  replies: number;
  reply_authors?: string[];
  run?: Omit<ResearchRun, "role"> & {
    model_config_id?: string;
    model?: string;
  };
}
export type ActivityType =
  | "mention"
  | "reply"
  | "completed"
  | "waiting"
  | "budget"
  | "limit"
  | "paused"
  | "reminder";
export interface TeamActivity extends Omit<TeamMessage, "unread"> {
  activity_type: ActivityType;
  activity_types: ActivityType[];
  actor_id: string | null;
  unread: boolean;
}
export interface SavedTeamMessage extends TeamMessage {
  completed: boolean;
  saved_at: string;
}
export interface Team {
  workspace_id: string;
  members: TeamMember[];
  channels: TeamChannel[];
  notifications: TeamMessage[];
  threads_unread?: number;
  mentions_unread?: number;
  activity_unread?: number;
  workflow?: Workflow;
  runtime?: WorkflowRuntime;
  budget?: TeamBudget;
  tokens?: number;
}
export interface TeamBudget {
  max_tokens: number;
  period_hours: number;
  max_concurrent: number;
}
export interface Delivery {
  id: string;
  member_id: string;
  message_id: string;
  channel_id: string;
  thread_id: string | null;
  text: string;
  mode: "queue" | "immediate";
  status: string;
  error: string;
  editable: boolean;
}
const base = (id: string) => `/research/workspaces/${id}/team`;
export const readTeamDiff = (id: string, message: string, path: string) =>
  api<TeamFileDiff>(
    `${base(id)}/messages/${encodeURIComponent(message)}/diff?path=${encodeURIComponent(path)}`,
  );
export const revertTeamMessage = (id: string, message: string) =>
  send(
    `${base(id)}/messages/${encodeURIComponent(message)}/revert`,
    {},
  ) as Promise<TeamMessage>;
export const getTeam = (id: string) => api<Team>(base(id));
export const saveTeamBudget = (id: string, budget: TeamBudget) =>
  send(`${base(id)}/budget`, budget, "PUT");
export const getMessages = (id: string, channel: string, thread?: string) =>
  api<{
    messages: TeamMessage[];
    activity?: TeamMessage[];
    root: TeamMessage | null;
    research_id: string | null;
    read_through?: string;
  }>(
    `${base(id)}/channels/${channel}/messages${thread ? `?thread_id=${encodeURIComponent(thread)}` : ""}`,
  );
export const sendTeamMessage = (
  id: string,
  channel: string,
  body: {
    text: string;
    thread_id?: string;
    mode: "queue" | "immediate" | "record";
    done_when?: string;
    model_config_id?: string;
    client_id: string;
    attachment_ids?: string[];
    forward_message_id?: string;
    quote?: Pick<TeamMessageReference, "message_id" | "text">;
    also_channel?: boolean;
  },
) =>
  send(
    `${base(id)}/channels/${channel}/messages`,
    body,
  ) as Promise<TeamMessage>;
export const setTeamReaction = (
  id: string,
  message: string,
  emoji: ReactionEmoji,
  remove: boolean,
) =>
  send(
    `${base(id)}/messages/${encodeURIComponent(message)}/reactions/${encodeURIComponent(emoji)}`,
    {},
    remove ? "DELETE" : "PUT",
  ) as Promise<TeamReaction[]>;
export const decideTeamMessage = (
  id: string,
  message: string,
  status: "accepted" | "changes_requested",
  feedback = "",
) =>
  send(`${base(id)}/messages/${encodeURIComponent(message)}/decision`, {
    status,
    feedback,
  }) as Promise<TeamMessage>;
export const getDeliveries = (id: string) =>
  api<Delivery[]>(`${base(id)}/deliveries`);
export const continueTeamMessage = (id: string, message: string) =>
  send(`${base(id)}/messages/${message}/continue`, {});
export const editDelivery = (
  id: string,
  delivery: string,
  body: { text?: string; mode?: "queue" | "immediate"; cancel?: boolean },
) => send(`${base(id)}/deliveries/${delivery}`, body, "PATCH");
export const createChannel = (id: string, name: string) =>
  send(`${base(id)}/channels`, { name });
export const renameChannel = (id: string, channel: string, name: string) =>
  send(`${base(id)}/channels/${channel}`, { name }, "PATCH");
export const deleteChannel = (id: string, channel: string) =>
  send(`${base(id)}/channels/${channel}`, {}, "DELETE");
export const readChannel = (
  id: string,
  channel: string,
  through: string,
  thread_id?: string,
) =>
  send(`${base(id)}/channels/${channel}/read`, {
    through,
    ...(thread_id ? { thread_id } : {}),
  });
export interface ColleagueFile {
  path: string;
  name: string;
  deleted?: boolean;
  member_id?: string | null;
}
export interface CatchupEvent {
  message_id: string;
  member_id: string | null;
  text: string;
}
export interface TeamCatchup {
  since: string;
  through: string;
  show: boolean;
  new_messages: number;
  first_unread: { id: string; thread_id: string | null } | null;
  completed: { member_id: string; count: number }[];
  files: ColleagueFile[];
  handoffs: { message_id: string; member_id: string | null; to: string[] }[];
  waiting: CatchupEvent[];
  failed: CatchupEvent[];
}
export const getTeamCatchup = (id: string, channel: string) =>
  api<TeamCatchup>(`${base(id)}/channels/${channel}/summary`);
export const teamThreads = (id: string, mentions = false) =>
  api<TeamMessage[]>(`${base(id)}/threads?mentions=${mentions}`);
export const teamActivity = (id: string) =>
  api<TeamActivity[]>(`${base(id)}/activity`);
export const savedTeamMessages = (id: string) =>
  api<SavedTeamMessage[]>(`${base(id)}/saved`);
export const markTeamMessage = (
  id: string,
  message: Pick<TeamMessage, "id" | "channel_id">,
  kind: "pin" | "later",
  remove = false,
  completed?: boolean,
) =>
  send(
    `${base(id)}/messages/${encodeURIComponent(message.id)}/marks/${kind}`,
    {
      channel_id: message.channel_id,
      ...(completed === undefined ? {} : { completed }),
    },
    remove ? "DELETE" : "PUT",
  );
export const readTeamActivity = (
  id: string,
  through: string,
  message_id?: string,
) =>
  send(`${base(id)}/activity/read`, {
    through,
    ...(message_id ? { message_id } : {}),
  });
export const teamHash = (id: string, channel = "", thread = "", full = false) =>
  `team/${id}${channel ? `/${channel}` : ""}${thread ? `?thread=${encodeURIComponent(thread)}${full ? "&full=1" : ""}` : ""}`;
export const TEAM_EVENT = "research-team-updated";
export const refreshTeam = () => window.dispatchEvent(new Event(TEAM_EVENT));

export const saveTeamWorkflow = (id: string, workflow: Workflow) =>
  send(`${base(id)}/workflow`, workflow, "PUT") as Promise<Workflow>;
export const selectTeamWorkflow = (id: string, workflow_id: string) =>
  send(`${base(id)}/workflow`, { workflow_id }) as Promise<Workflow>;
export const settingsHash = (id: string, target = "members") =>
  teamHash(id, "settings", target);
export const ruleHash = (
  id: string,
  workflow: string,
  version: number,
  rule: string,
) => settingsHash(id, `rule:${workflow}:${version}:${rule}`);
export const readWorkflowSnapshot = (
  id: string,
  workflow: string,
  version: number,
) =>
  api<Workflow>(
    `${base(id)}/workflows/${encodeURIComponent(workflow)}/${version}`,
  );

export const readMemberLibrary = (id: string) =>
  api<LibraryMember[]>(`${base(id)}/library`);
export const saveLibraryMember = (
  id: string,
  member: LibraryMember,
  config: MemberConfig,
  sync: boolean,
  source?: string,
) =>
  send(
    `${base(id)}/library/${member.id}`,
    {
      config,
      version: member.version,
      sync,
      ...(source ? { source } : {}),
      revision: member.revision,
    },
    "PATCH",
  );
export const addTeamMember = (
  id: string,
  body: {
    source?: string;
    config?: MemberConfig;
    library_id?: string;
    copy_from?: string;
    subscriptions?: string[];
    avatar_upload?: AvatarUpload;
  },
) => saveMember(`${base(id)}/members`, body, "POST");
export const editTeamMember = (
  id: string,
  member: string,
  body: {
    source?: string;
    config?: MemberConfig;
    enabled?: boolean;
    paused?: boolean;
    subscriptions?: string[];
    reset_overrides?: boolean;
    restore_builtin?: boolean;
    revision?: string;
    avatar_upload?: AvatarUpload;
  },
) => saveMember(`${base(id)}/members/${member}`, body, "PATCH");
const saveMember = (
  path: string,
  body: { avatar_upload?: AvatarUpload },
  method: string,
) =>
  api(path, {
    method,
    body: JSON.stringify(body),
    headers: body.avatar_upload ? { "X-Avatar-Upload": "1" } : undefined,
  });
export const deleteTeamMember = (id: string, member: string) =>
  send(`${base(id)}/members/${member}`, {}, "DELETE");
export interface MemberDetail extends TeamMember {
  attention?: import("./team-work-api").AttentionMetrics | null;
  activity: string;
  recent_files?: ColleagueFile[];
  threads: {
    id: string;
    channel_id: string;
    text: string;
    last_message_at: string;
  }[];
}
export const readMember = (id: string, member: string) =>
  api<MemberDetail>(`${base(id)}/members/${member}`);

export const convertAgentDocument = (
  id: string,
  source: string,
  config?: MemberConfig,
  channels?: string[],
  role?: string,
) =>
  send(`${base(id)}/agent-document`, {
    source,
    config,
    channels,
    role,
  }) as Promise<AgentDocument>;
export const importAgentDocument = (
  id: string,
  source: string,
  filename: string,
) =>
  send(`${base(id)}/import-agent`, {
    source,
    filename,
  }) as Promise<AgentDocument>;

export const remindTeamMessage = (
  id: string,
  message: TeamMessage,
  remind_at: string,
) =>
  send(
    `${base(id)}/channels/${encodeURIComponent(message.channel_id)}/messages/${encodeURIComponent(message.id)}/reminders`,
    { remind_at },
  );
