import {
  BookCheck,
  BookOpen,
  Circle,
  Compass,
  FileText,
  FileUp,
  History,
  Library,
  Settings2,
  Sparkles,
  Users,
  Monitor,
  LineChart,
} from "lucide-react";
import { useContext } from "react";
import { AppActions } from "./AppSidebar";
import { sidebarId, type SidebarEntryId } from "./sidebar-entries";
import {
  pageRows,
  READING_FIRST,
  sidebarPageKey,
  SidebarPagination,
  useSidebarPage,
} from "./sidebar-pagination";
import { readSectionAddresses } from "./local-sections";
import { useTeamWorkspace } from "../screens/research/TeamNavigation";
import { useI18n } from "../i18n/I18nProvider";
import { followLink, readerHash } from "../reader/route";
import { SidebarItem, SidebarSection } from "../ui";
import type { AppRoute } from "./routes";
import type { LocalSection } from "./local-sections";
import styles from "./AppSidebar.module.css";

/** Each app section owns its secondary navigation. */
export function SectionNavigation({
  section,
  route,
  hash,
  reading,
  go,
  home = false,
}: {
  /** The hosted site has no research: its landing page stays in the list. */
  home?: boolean;
  section: LocalSection;
  route: AppRoute;
  hash: string;
  reading: { id: string; title: string }[];
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const view =
    new URLSearchParams(hash.split("?")[1] || "").get("view") || "all";
  const importParams = new URLSearchParams(
    route.screen === "library" ? hash.split("?")[1] || "" : "",
  );
  importParams.set("import", "1");
  // Switching between the library's lists keeps what was typed in its search.
  const query =
    route.screen === "library"
      ? new URLSearchParams(hash.split("?")[1] || "").get("q") || ""
      : "";
  const listPath = (view?: string) => {
    const params = new URLSearchParams();
    if (view) params.set("view", view);
    if (query) params.set("q", query);
    const text = params.toString();
    return text ? `library?${text}` : "library";
  };
  const item = (
    id: SidebarEntryId,
    Icon: typeof Library,
    label: string,
    path: string,
    active = false,
  ) => (
    <SidebarItem
      key={path}
      data-id={sidebarId(id)}
      icon={Icon}
      label={label}
      href={`#${path}`}
      active={active}
      onClick={followLink(go, path)}
    />
  );
  if (section === "materials")
    return (
      <>
        <div className={styles.researchActions}>
          {item(
            "import",
            FileUp,
            t("library.import"),
            `library?${importParams}`,
          )}
        </div>
        <div className={styles.sectionLinks}>
          {item(
            "all",
            Library,
            t("library.filter.all"),
            listPath(),
            route.screen === "library" && view === "all",
          )}
          {item(
            "reading",
            BookOpen,
            t("library.status.reading"),
            listPath("reading"),
            route.screen === "library" && view === "reading",
          )}
          {item(
            "unread",
            Circle,
            t("library.status.unread"),
            listPath("unread"),
            route.screen === "library" && view === "unread",
          )}
          {item(
            "read",
            BookCheck,
            t("library.status.read"),
            listPath("read"),
            route.screen === "library" && view === "read",
          )}
          {item(
            "discover",
            Compass,
            t("app.discover"),
            "discover",
            route.screen === "discover",
          )}
          {home && (
            <SidebarItem
              data-id={sidebarId("home")}
              icon={History}
              label={t("app.home")}
              href="#home"
              active={route.screen === "home"}
              onClick={followLink(go, "home")}
            />
          )}
        </div>
        <RecentReading reading={reading} route={route} hash={hash} go={go} />
      </>
    );
  if (section === "customize")
    return (
      <div
        className={styles.sectionLinks}
        aria-label={t("customize.navigation")}
      >
        <SidebarSection title={t("customize.skills")}>
          {item(
            "playbook",
            Settings2,
            t("customize.playbook"),
            "customize/playbook",
            route.screen === "customize" && route.section === "playbook",
          )}
          {item(
            "roles",
            Users,
            t("customize.roles"),
            "customize/roles",
            route.screen === "customize" && route.section === "roles",
          )}
          {item(
            "workflows",
            Settings2,
            t("workflows.title"),
            "customize/workflows",
            route.screen === "customize" && route.section === "workflows",
          )}
        </SidebarSection>
        <SidebarSection title={t("customize.connections")}>
          {item(
            "machines",
            Monitor,
            t("customize.machines"),
            "customize/machines",
            route.screen === "customize" && route.section === "machines",
          )}
          {item(
            "tracking",
            LineChart,
            t("customize.tracking"),
            "customize/tracking",
            route.screen === "customize" && route.section === "tracking",
          )}
          {item(
            "models",
            Sparkles,
            t("customize.models"),
            "customize/models",
            route.screen === "customize" && route.section === "models",
          )}
        </SidebarSection>
      </div>
    );
  return null;
}

export function RecentReading({
  reading,
  route,
  hash,
  go,
}: {
  reading: { id: string; title: string }[];
  route: AppRoute;
  hash: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const { owner = "" } = useContext(AppActions);
  const project = useTeamWorkspace(
    readSectionAddresses(owner).research || hash,
  );
  const [limit, choose] = useSidebarPage(
    sidebarPageKey(owner, project, "recent"),
    READING_FIRST,
  );
  const { rows, hidden } = pageRows(
    reading,
    limit,
    (paper) => route.screen === "reader" && route.reader.paperId === paper.id,
  );
  if (!reading.length) return null;
  return (
    <div
      className={styles.sectionGroup}
      data-sidebar-place="recent"
      data-id={sidebarId("recent")}
    >
      <SidebarSection title={t("app.section.recent")}>
        {rows.map(({ id, title }) => {
          const path = readerHash({ paperId: id }).slice(1);
          return (
            <SidebarItem
              key={id}
              data-id={sidebarId("recent-paper")}
              icon={FileText}
              label={title}
              href={`#${path}`}
              active={route.screen === "reader" && route.reader.paperId === id}
              onClick={followLink(go, path)}
            />
          );
        })}
        <SidebarPagination
          list="recent"
          first={READING_FIRST}
          limit={limit}
          hidden={hidden}
          choose={choose}
        />
      </SidebarSection>
    </div>
  );
}
