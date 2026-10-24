import {
  parseReaderRoute,
  readerHash,
  type ReaderRoute,
} from "../reader/route";

/**
 * Where the signed-in app is: one of its screens, or a paper in the reader.
 * `redirect` is set when the address was not this one's own (an old address,
 * or one that names nothing): the app replaces it with `redirect` so the back
 * button does not lead to it again.
 */
export type AppRoute =
  | { screen: "home"; redirect?: string }
  | { screen: "library"; redirect?: string }
  | { screen: "discover"; redirect?: string }
  | { screen: "settings"; category?: string; redirect?: string }
  | { screen: "research"; projectId?: string; redirect?: string }
  | {
      screen: "team";
      workspaceId: string;
      channelId?: string;
      threadId?: string;
      full?: boolean;
      redirect?: string;
    }
  | {
      screen: "new-research";
      workspaceId?: string;
      collectionId?: string;
      redirect?: string;
    }
  | { screen: "research-board"; redirect?: string }
  | {
      screen: "schedules";
      scheduleId?: string;
      template?: string;
      redirect?: string;
    }
  | {
      screen: "customize";
      section:
        | "playbook"
        | "roles"
        | "machines"
        | "tracking"
        | "models"
        | "workflows";
      redirect?: string;
    }
  | {
      screen: "workspaces";
      workspaceId?: string;
      tab?: string;
      redirect?: string;
    }
  | { screen: "research-collections"; collectionId?: string; redirect?: string }
  | {
      screen: "projects";
      workspaceId?: string;
      tab?: string;
      /** One thing in the tab: a conversation. */
      item?: string;
      redirect?: string;
    }
  | { screen: "open"; url: string; redirect?: string }
  | { screen: "reader"; reader: ReaderRoute; redirect?: string };

/** The screens the shell draws itself; the reader draws its own. */
export type AppScreen = AppRoute["screen"];

const HOME: AppRoute = { screen: "home" };

/**
 * Reads the hash, without its `#`. `#paper/<id>` is the old reader's address:
 * it opens the new reader, with the same `file`, `page`, `quote`, `prefix` and
 * `rect`, and is rewritten to `#read/<id>…`. Anything else that is not one of
 * the screens (the addresses of what has been taken out: knowledge,
 * directions, collections, tokens…) goes home.
 */
export function parseAppRoute(hash: string): AppRoute {
  const path = hash.split("?")[0];
  if (path === "") return { screen: "new-research" };
  if (path === "home") return HOME;
  if (path === "scheduled")
    return { screen: "schedules", redirect: "schedules" };
  if (path === "library") return { screen: "library" };
  if (path === "discover") return { screen: "discover" };
  if (path === "settings") return { screen: "settings" };
  if (path.startsWith("settings/")) {
    const category = path.slice("settings/".length);
    const moved = {
      models: "models",
      environments: "machines",
      tracking: "tracking",
      playbook: "playbook",
    } as const;
    if (Object.hasOwn(moved, category)) {
      const section = moved[category as keyof typeof moved];
      return { screen: "customize", section, redirect: `customize/${section}` };
    }
    return /^[a-z]{1,20}$/.test(category)
      ? { screen: "settings", category }
      : { screen: "settings", redirect: "settings" };
  }
  const uuid = (value = "") => /^[0-9a-f-]{36}$/.test(value);
  if (path === "tasks" || path.startsWith("tasks/"))
    return { screen: "schedules", redirect: "schedules" };
  if (path === "schedules") return { screen: "schedules" };
  if (path.startsWith("schedules/")) {
    const scheduleId = path.slice("schedules/".length);
    if (scheduleId === "new") {
      const template = new URLSearchParams(hash.split("?")[1] || "").get(
        "template",
      );
      return {
        screen: "schedules",
        scheduleId,
        ...(["papers", "weekly", "experiments", "night"].includes(
          template || "",
        )
          ? { template: template! }
          : {}),
      };
    }
    return uuid(scheduleId)
      ? { screen: "schedules", scheduleId }
      : { screen: "schedules", redirect: "schedules" };
  }
  if (path === "customize" || path.startsWith("customize/")) {
    const section = path.slice("customize/".length);
    return section === "models" ||
      section === "playbook" ||
      section === "roles" ||
      section === "workflows" ||
      section === "machines" ||
      section === "tracking"
      ? { screen: "customize", section }
      : {
          screen: "customize",
          section: "playbook",
          redirect: "customize/playbook",
        };
  }
  if (path.startsWith("team/")) {
    const [workspaceId, channelId] = path.slice(5).split("/");
    const params = new URLSearchParams(hash.split("?")[1] || "");
    return uuid(workspaceId) &&
      (!channelId ||
        uuid(channelId) ||
        ["threads", "mentions", "work", "settings"].includes(channelId))
      ? {
          screen: "team",
          workspaceId,
          channelId,
          threadId: params.get("thread") || undefined,
          full: params.get("full") === "1",
        }
      : { screen: "new-research", redirect: "new" };
  }
  if (path === "new") {
    const params = new URLSearchParams(hash.split("?")[1] || "");
    const workspaceId = params.get("workspace") || "";
    const collectionId = params.get("collection") || "";
    return {
      screen: "new-research",
      ...(uuid(workspaceId) ? { workspaceId } : {}),
      ...(uuid(collectionId) ? { collectionId } : {}),
    };
  }
  if (path === "board") return { screen: "workspaces", redirect: "workspaces" };
  if (path === "workspaces") return { screen: "workspaces" };
  if (path.startsWith("workspaces/")) {
    const [workspaceId, tab] = path.slice("workspaces/".length).split("/");
    return uuid(workspaceId)
      ? {
          screen: "workspaces",
          workspaceId,
          ...(["results", "board", "about", "compare"].includes(tab)
            ? { tab }
            : {}),
        }
      : { screen: "workspaces", redirect: "workspaces" };
  }
  if (path === "collections" || path === "projects")
    return {
      screen: "research-collections",
      ...(path === "projects" ? { redirect: "collections" } : {}),
    };
  if (path.startsWith("collections/")) {
    const collectionId = path.slice("collections/".length);
    return uuid(collectionId) || collectionId === "unclassified"
      ? { screen: "research-collections", collectionId }
      : { ...HOME, redirect: "home" };
  }
  if (path.startsWith("projects/")) {
    const [workspaceId, tab, item] = path.slice("projects/".length).split("/");
    if (!uuid(workspaceId))
      return { screen: "research-collections", redirect: "collections" };
    // Older ordinary chats remain readable by their saved address.
    if (tab === "chats" && uuid(item))
      return { screen: "projects", workspaceId, tab, item };
    if (tab === "board")
      return {
        screen: "workspaces",
        workspaceId,
        tab,
        redirect: `workspaces/${workspaceId}/board`,
      };
    return {
      screen: "workspaces",
      workspaceId,
      ...(tab === "results" ? { tab } : {}),
      redirect: `workspaces/${workspaceId}${tab === "results" ? "/results" : ""}`,
    };
  }
  if (path === "research") return { screen: "new-research", redirect: "new" };
  if (path.startsWith("research/")) {
    const projectId = path.slice("research/".length);
    return uuid(projectId)
      ? { screen: "research", projectId }
      : { screen: "new-research", redirect: "new" };
  }
  if (path === "open") {
    // From the browser extension: the address of a paper to import, then read.
    const url = new URLSearchParams(hash.split("?")[1] ?? "").get("url") ?? "";
    return /^https?:\/\/\S+$/i.test(url.trim())
      ? { screen: "open", url: url.trim() }
      : { ...HOME, redirect: "home" };
  }
  if (path.startsWith("read/")) {
    const reader = parseReaderRoute(hash);
    return reader
      ? { screen: "reader", reader }
      : { ...HOME, redirect: "home" };
  }
  if (path.startsWith("paper/")) {
    const reader = parseReaderRoute("read/" + hash.slice("paper/".length));
    if (!reader) return { ...HOME, redirect: "home" };
    // Only what the reader reads is carried over (an old `note=` or `line=` is not).
    return {
      screen: "reader",
      reader,
      redirect: readerHash(reader).slice(1),
    };
  }
  return { ...HOME, redirect: "home" };
}
