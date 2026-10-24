import { api, send } from "../../api";
import type {
  Column,
  ResearchProject,
  ResearchSummary,
  Workspace,
} from "./research-api";

export interface WorkspaceLocation {
  kind: "local" | "ssh" | "managed";
  path: string;
  connection_id: string;
}
export interface NavigationResearch extends ResearchSummary {
  title: string;
  unread?: boolean;
  archived_at?: string | null;
  session_id: string;
  workspace_id: string;
  collection_id: string | null;
  on_board: boolean;
  pinned_at: string | null;
}
export interface NavigationWorkspace extends Workspace {
  location: WorkspaceLocation;
  researches: NavigationResearch[];
}
export interface ResearchCollection {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  research_ids: string[];
}
export interface ResearchNavigation {
  workspaces: NavigationWorkspace[];
  collections: ResearchCollection[];
}
export interface SSHConnection {
  id: string;
  name: string;
  kind: "ssh";
  host: string;
  port: number;
  identity_file: string;
}
export interface FolderListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  project_error: "" | "root" | "home" | "system" | "personal" | "git";
}

export const readNavigation = () =>
  api<ResearchNavigation>("/research/navigation");
export const createPhysicalWorkspace = (
  name: string,
  location: WorkspaceLocation,
  createFolder = false,
) =>
  send("/research/workspaces", {
    name,
    location,
    ...(createFolder ? { create_folder: true } : {}),
  }) as Promise<NavigationWorkspace>;
export const createCollection = (name: string, description = "") =>
  send("/research/collections", {
    name,
    description,
  }) as Promise<ResearchCollection>;
export const updateCollection = (
  id: string,
  body: { name?: string; description?: string; archived?: boolean },
) =>
  send(
    `/research/collections/${id}`,
    body,
    "PATCH",
  ) as Promise<ResearchCollection>;
export const organizeResearch = (
  id: string,
  body: {
    collection_id?: string | null;
    on_board?: boolean;
    pinned?: boolean;
    title?: string;
  },
) =>
  send(
    `/research/projects/${id}/organization`,
    body,
    "PATCH",
  ) as Promise<ResearchProject>;
export const readResearchBoard = () =>
  api<{ columns: Column[]; cards: NavigationResearch[] }>("/research/board");
export const readConnections = () =>
  api<SSHConnection[]>("/research/connections");
export const createConnection = (body: {
  name: string;
  host: string;
  port?: number;
  identity_file?: string;
}) => send("/research/connections", body) as Promise<SSHConnection>;
export const browseFolders = (
  kind: "local" | "ssh",
  path: string,
  connectionId = "",
) => {
  const params = new URLSearchParams({ kind, path });
  if (connectionId) params.set("connection_id", connectionId);
  return api<FolderListing>(`/research/folders?${params}`);
};

export const RESEARCH_NAVIGATION_EVENT = "research-navigation-updated";
export const refreshResearchNavigation = () =>
  window.dispatchEvent(new Event(RESEARCH_NAVIGATION_EVENT));
