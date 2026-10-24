import { api } from "../../api";
import type { RunStep } from "./process/model";

export type WorkGroup = "waiting" | "review" | "working" | "queued" | "done";
export const workGroups: WorkGroup[] = [
  "waiting",
  "review",
  "working",
  "queued",
  "done",
];
export interface AttentionMetrics {
  asks: number;
  pending: number;
  median_wait_seconds: number | null;
  waiting_seconds: number;
  total_seconds: number;
  waiting_share: number | null;
  partial: boolean;
}
export interface WorkItem {
  id: string;
  channel_id: string;
  thread_id: string | null;
  research_id: string | null;
  title: string;
  group: WorkGroup;
  member_ids: string[];
  status: WorkGroup | "failed" | "paused";
  current_step: RunStep | null;
  elapsed_seconds: number;
  stuck: ("failed" | "reviewer_absent" | "owner_wait")[];
}
export interface TeamWork {
  generated_at: string;
  items: WorkItem[];
  counts: Record<WorkGroup, number>;
  attention: {
    total: AttentionMetrics;
    researches: (AttentionMetrics & { research_id: string; title: string })[];
    members: Record<string, AttentionMetrics>;
  };
}
export const getTeamWork = (id: string) =>
  api<TeamWork>(`/research/workspaces/${id}/team/work`);
