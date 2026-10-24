/** Every sidebar entry belongs to one DOM scope; smoke tests visit each scope. */
export const PLACES = {
  rail: ["collapse", "research", "materials", "tasks", "customize", "settings"],
  account: ["sign-out"],
  hosted: [
    "hosted-collapse",
    "hosted-search",
    "home",
    "hosted-library",
    "hosted-discover",
    "hosted-research",
    "hosted-models",
    "hosted-settings",
  ],
  research: [
    "workspace",
    "search",
    "new-research",
    "threads",
    "activity",
    "work",
  ],
  attention: ["attention", "attention-item"],
  messages: [
    "messages",
    "create-channel",
    "conversation",
    "messages-more",
    "messages-less",
  ],
  team: ["team-settings"],
  materials: ["import", "all", "reading", "unread", "read", "discover"],
  recent: ["recent", "recent-paper", "recent-more", "recent-less"],
  customize: [
    "playbook",
    "roles",
    "workflows",
    "machines",
    "tracking",
    "models",
  ],
  tasks: ["new-task", "task"],
} as const;

export type SidebarPlace = keyof typeof PLACES;
export type SidebarEntryId = (typeof PLACES)[SidebarPlace][number];

/** Keep data-id literals checked against the registry. */
export const sidebarId = (id: SidebarEntryId) => id;
