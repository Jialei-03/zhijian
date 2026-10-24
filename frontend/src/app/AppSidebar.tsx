import {
  Compass,
  FlaskConical,
  SquarePen,
  House,
  Library,
  LogOut,
  Search,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Clock3,
  Plus,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Paper } from "../api";
import { useI18n } from "../i18n/I18nProvider";
import { followLink } from "../reader/route";
import {
  ariaKeyShortcuts,
  currentPlatformIsMac,
  formatShortcut,
  Kbd,
  Sidebar,
  SidebarItem,
  SidebarSection,
  useSidebarWidth,
  IconButton,
  Resizer,
  Tooltip,
  matchesShortcut,
  useResizableWidth,
} from "../ui";
import {
  TeamNavigation,
  TeamSwitcher,
} from "../screens/research/TeamNavigation";
import { parseAppRoute, type AppScreen } from "./routes";
import {
  localSection,
  readSectionAddresses,
  validSectionAddress,
} from "./local-sections";
import { RecentReading, SectionNavigation } from "./SectionNavigation";
import { sidebarId, type SidebarEntryId } from "./sidebar-entries";
import { ScheduleNavigation } from "../screens/schedules/ScheduleCenter";
import styles from "./AppSidebar.module.css";
import { useLocal } from "./edition";
import { useResearchNavigation } from "../screens/research/ResearchNavigation";

/** Opens quick open, from anywhere in the app. */
export const QUICK_OPEN_SHORTCUT = "mod+k";

/**
 * What the app around a screen offers its sidebar: quick open and signing out.
 * A screen drawn outside the app (a test, the kit) has neither, and the sidebar
 * then leaves those items out.
 */
export const AppActions = createContext<{
  /** The person signed in. */
  owner?: string;
  quickOpen?: () => void;
  signOut?: () => void;
}>({});

export interface AppSidebarProps {
  /**
   * The window is too narrow for the sidebar beside the cards: it is a rail of
   * icons whatever was chosen on a wide window, and opened it floats over the
   * cards (closing again when something else is done).
   */
  floating: boolean;
  /** The screen that is showing; for the reader, `paperId` says which paper. */
  screen: AppScreen;
  /** The paper being read, when `screen` is the reader. */
  paperId?: string;
  researchId?: string;
  contextHash?: string;
  papers: Paper[];
  /** The paper being read, once it has loaded (named from itself until the list has caught up with it). */
  current?: Paper | null;
  /** When each paper was last opened on this device, by id. */
  visits: Record<string, number>;
  /** Takes an address without its `#`. */
  go: (hash: string) => void;
}

/**
 * The app's navigation, the same on every screen and in the reader: home, the
 * library, the papers read last (the one being read marked), and the settings.
 */
export function AppSidebar({
  floating,
  screen,
  paperId = "",
  researchId,
  contextHash,
  papers,
  current = null,
  visits,
  go,
}: AppSidebarProps) {
  const { t } = useI18n();
  const local = useLocal();
  const { data: researchNavigation } = useResearchNavigation();
  const route = parseAppRoute(contextHash ?? window.location.hash.slice(1));
  const currentResearchId =
    researchId ||
    (route.screen === "team" && route.threadId?.startsWith("research:")
      ? route.threadId.slice(9)
      : "");
  const currentResearch = currentResearchId
    ? researchNavigation.workspaces
        .flatMap((workspace) => workspace.researches)
        .find((research) => research.id === currentResearchId)
    : undefined;
  const workspaceId =
    currentResearch?.workspace_id ||
    (route.screen === "workspaces" ||
    route.screen === "team" ||
    route.screen === "new-research"
      ? route.workspaceId
      : undefined);
  const collectionId =
    currentResearch?.collection_id ||
    (route.screen === "research-collections" || route.screen === "new-research"
      ? route.collectionId
      : undefined);
  const newContext = new URLSearchParams();
  if (workspaceId) newContext.set("workspace", workspaceId);
  if (collectionId && collectionId !== "unclassified")
    newContext.set("collection", collectionId);
  const newResearchHash = `new${newContext.size ? `?${newContext}` : ""}`;
  const { owner, quickOpen, signOut } = useContext(AppActions);
  const sizing = useSidebarWidth(owner);
  // Two answers, one for each kind of window: what was chosen on a wide one is not lost on a narrow one.
  const [collapsed, setCollapsed] = useState(false);
  const [opened, setOpened] = useState(false);
  // Whichever way the window has changed, the sidebar floats shut (a wide one keeps what was chosen).
  useEffect(() => setOpened(false), [floating]);

  const reading = useMemo(() => {
    const titles = new Map(papers.map((paper) => [paper.id, paper.title]));
    if (current) titles.set(current.id, current.title);
    const ids = Object.entries(visits)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    // Remembered once it has loaded; until then it is still the one being read.
    if (paperId && titles.has(paperId) && !ids.includes(paperId))
      ids.unshift(paperId);
    return ids
      .filter((id) => titles.has(id))
      .map((id) => ({ id, title: titles.get(id) || t("reader.untitled") }));
  }, [papers, current, visits, paperId, t]);

  const materials = ["library", "discover", "reader", "open"].includes(screen);
  // Only the icons are left of a rail: the search is then an item like the others.
  const rail = floating ? !opened : collapsed;
  if (local === true)
    return (
      <AppResearchSidebar
        floating={floating}
        collapsed={rail}
        onCollapsedChange={(shut) =>
          floating ? setOpened(!shut) : setCollapsed(shut)
        }
        screen={screen}
        researchId={researchId}
        newResearchHash={newResearchHash}
        reading={reading}
        contextHash={contextHash ?? window.location.hash.slice(1)}
        go={go}
      />
    );
  return (
    <Sidebar
      data-sidebar-place="hosted"
      collapseId={sidebarId("hosted-collapse")}
      label={t("reader.region.sidebar")}
      collapsed={floating ? !opened : collapsed}
      onCollapsedChange={(shut) =>
        floating ? setOpened(!shut) : setCollapsed(shut)
      }
      overlay={floating}
      resizable={sizing}
      footer={
        <>
          <SidebarItem
            data-id={sidebarId("hosted-models")}
            icon={SlidersHorizontal}
            label={t("customize.models")}
            href="#customize/models"
            active={screen === "customize"}
            onClick={followLink(go, "customize/models")}
          />
          <SidebarItem
            data-id={sidebarId("hosted-settings")}
            icon={Settings}
            label={t("reader.sidebar.settings")}
            href="#settings"
            active={screen === "settings"}
            onClick={followLink(go, "settings")}
          />
          {signOut && (
            <div data-sidebar-place="account">
              <SidebarItem
                data-id={sidebarId("sign-out")}
                icon={LogOut}
                label={t("app.signOut")}
                onClick={signOut}
              />
            </div>
          )}
        </>
      }
    >
      <SidebarSection>
        {quickOpen &&
          (rail ? (
            <SidebarItem
              data-id={sidebarId("hosted-search")}
              icon={Search}
              label={t(local ? "app.quickOpen.all" : "app.quickOpen")}
              meta={formatShortcut(QUICK_OPEN_SHORTCUT, currentPlatformIsMac())}
              onClick={quickOpen}
            />
          ) : (
            <button
              type="button"
              className={styles.search}
              data-id={sidebarId("hosted-search")}
              aria-label={t(local ? "app.quickOpen.all" : "app.quickOpen")}
              aria-keyshortcuts={ariaKeyShortcuts(
                QUICK_OPEN_SHORTCUT,
                currentPlatformIsMac(),
              )}
              onClick={() => {
                quickOpen();
                if (floating) setOpened(false);
              }}
            >
              <Search size={16} aria-hidden="true" />
              <span className={styles.placeholder}>
                {t(local ? "app.quickOpen.short" : "app.quickOpen")}
              </span>
              <Kbd shortcut={QUICK_OPEN_SHORTCUT} />
            </button>
          ))}
        {materials ? (
          <SectionNavigation
            section="materials"
            home={!local}
            route={route}
            hash={contextHash ?? window.location.hash.slice(1)}
            reading={reading}
            go={go}
          />
        ) : (
          <>
            <SidebarItem
              data-id={sidebarId("home")}
              icon={House}
              label={t("app.home")}
              href="#home"
              active={screen === "home"}
              onClick={followLink(go, "home")}
            />
            <SidebarItem
              data-id={sidebarId("hosted-library")}
              icon={Library}
              label={t("reader.sidebar.library")}
              href="#library"
              active={screen === "library"}
              onClick={followLink(go, "library")}
            />
            <SidebarItem
              data-id={sidebarId("hosted-discover")}
              icon={Compass}
              label={t("app.discover")}
              href="#discover"
              active={screen === "discover"}
              onClick={followLink(go, "discover")}
            />
          </>
        )}
        {local === false && (
          <SidebarItem
            data-id={sidebarId("hosted-research")}
            icon={FlaskConical}
            label={t("app.research")}
            href="#new"
            active={screen === "new-research"}
            onClick={followLink(go, "new")}
          />
        )}
      </SidebarSection>
      {!materials && (
        <RecentReading
          reading={reading}
          route={route}
          hash={contextHash ?? window.location.hash.slice(1)}
          go={go}
        />
      )}
    </Sidebar>
  );
}

const researchSidebarMax = (width: number) =>
  Math.max(240, Math.min(360, Math.floor(width / 3)));

/** The local research surface keeps app destinations in a separate, quiet rail. */
function AppResearchSidebar({
  floating,
  collapsed,
  onCollapsedChange,
  screen,
  newResearchHash,
  reading,
  contextHash,
  go,
}: {
  floating: boolean;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  screen: AppScreen;
  researchId?: string;
  newResearchHash: string;
  reading: { id: string; title: string }[];
  contextHash: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const { owner, quickOpen, signOut } = useContext(AppActions);
  const route = parseAppRoute(contextHash);
  const section = localSection(route);
  const remembered = useRef(readSectionAddresses(owner || ""));
  useEffect(() => {
    if (!validSectionAddress(section, contextHash)) return;
    remembered.current[section] = contextHash;
    try {
      localStorage.setItem(
        `app-sections:${owner || ""}`,
        JSON.stringify(remembered.current),
      );
    } catch {
      /* Navigation still works when preferences cannot be saved. */
    }
  }, [owner, section, contextHash]);
  const destination = (key: typeof section) =>
    remembered.current[key] ||
    {
      research: newResearchHash,
      materials: "library",
      tasks: "schedules",
      customize: "customize/playbook",
    }[key];
  const title = section === "research" ? "ORA" : t(`app.section.${section}`);
  const nav = useRef<HTMLElement>(null);
  const sizing = useResizableWidth({
    key: `research-sidebar-width:${owner || ""}`,
    fallback: 264,
    min: 240,
    maxFor: researchSidebarMax,
  });
  const choose = (hash: string) => {
    go(hash);
    if (floating) onCollapsedChange(true);
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, [contenteditable='true']")
      )
        return;
      if (matchesShortcut(event, "mod+\\", currentPlatformIsMac())) {
        event.preventDefault();
        onCollapsedChange(!collapsed);
      } else if (floating && !collapsed && event.key === "Escape") {
        event.preventDefault();
        onCollapsedChange(true);
      }
    };
    const outside = (event: Event) => {
      if (
        floating &&
        !collapsed &&
        event.target instanceof Element &&
        !nav.current?.contains(event.target) &&
        !event.target.closest('[role="menu"]')
      )
        onCollapsedChange(true);
    };
    window.addEventListener("keydown", keyboard);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      window.removeEventListener("keydown", keyboard);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [collapsed, floating, onCollapsedChange]);
  const railLink = (
    id: SidebarEntryId,
    Icon: LucideIcon,
    label: string,
    hash: string,
    active: boolean,
  ) => (
    <Tooltip content={label} placement={{ side: "right", align: "center" }}>
      <a
        className={styles.railItem}
        data-id={sidebarId(id)}
        href={`#${hash}`}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        onClick={followLink(choose, hash)}
      >
        <Icon size={18} aria-hidden />
      </a>
    </Tooltip>
  );
  return (
    <nav
      ref={nav}
      aria-label={t("reader.region.sidebar")}
      className={styles.researchSidebar}
      data-floating={floating || undefined}
      data-collapsed={collapsed || undefined}
    >
      <div className={styles.researchRail} data-sidebar-place="rail">
        <IconButton
          className={styles.railToggle}
          data-id={sidebarId("collapse")}
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          label={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}
          shortcut="mod+\\"
          aria-expanded={!collapsed}
          aria-keyshortcuts={ariaKeyShortcuts("mod+\\", currentPlatformIsMac())}
          onClick={() => onCollapsedChange(!collapsed)}
        />
        <div className={styles.railDestinations}>
          {railLink(
            "research",
            House,
            t("app.section.research"),
            destination("research"),
            section === "research",
          )}
          {railLink(
            "materials",
            Library,
            t("app.section.materials"),
            destination("materials"),
            section === "materials",
          )}
          {railLink(
            "tasks",
            Clock3,
            t("app.section.tasks"),
            destination("tasks"),
            section === "tasks",
          )}
          {railLink(
            "customize",
            SlidersHorizontal,
            t("app.section.customize"),
            destination("customize"),
            section === "customize",
          )}
        </div>
        <div className={styles.railFooter}>
          {railLink(
            "settings",
            Settings,
            t("reader.sidebar.settings"),
            "settings",
            screen === "settings",
          )}
          {signOut && (
            <div data-sidebar-place="account">
              <IconButton
                data-id={sidebarId("sign-out")}
                className={styles.railItem}
                icon={LogOut}
                label={t("app.signOut")}
                onClick={signOut}
              />
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <>
          <div
            className={styles.researchPane}
            style={
              {
                "--research-sidebar-width": `${sizing.width}px`,
              } as CSSProperties
            }
          >
            <div
              className={styles.researchBrandRow}
              data-sidebar-place={
                section === "research" ? "research" : undefined
              }
            >
              {section === "research" ? (
                <TeamSwitcher hash={contextHash} go={choose} />
              ) : (
                <h2 className={styles.sectionTitle}>{title}</h2>
              )}
              {quickOpen && (
                <IconButton
                  className={styles.researchSearch}
                  data-id={sidebarId("search")}
                  icon={Search}
                  label={t("app.quickOpen.all")}
                  shortcut={QUICK_OPEN_SHORTCUT}
                  onClick={() => {
                    quickOpen();
                    if (floating) onCollapsedChange(true);
                  }}
                />
              )}
            </div>
            {section === "tasks" ? (
              <div className={styles.taskNavigation} data-sidebar-place="tasks">
                <div className={styles.taskNew}>
                  <SidebarItem
                    data-id={sidebarId("new-task")}
                    icon={Plus}
                    label={t("schedules.new")}
                    active={
                      route.screen === "schedules" && route.scheduleId === "new"
                    }
                    href="#schedules/new"
                    onClick={followLink(choose, "schedules/new")}
                  />
                </div>
                <ScheduleNavigation
                  currentId={
                    route.screen === "schedules" ? route.scheduleId : undefined
                  }
                  go={choose}
                />
              </div>
            ) : (
              <div
                className={styles.researchScroll}
                data-sidebar-place={section}
              >
                {section === "research" ? (
                  <>
                    <div className={styles.researchActions}>
                      <SidebarItem
                        data-id={sidebarId("new-research")}
                        icon={SquarePen}
                        label={t("projects.newResearch")}
                        href={`#${newResearchHash}`}
                        active={screen === "new-research"}
                        onClick={followLink(choose, newResearchHash)}
                      />
                    </div>
                    <TeamNavigation hash={contextHash} go={choose} />
                  </>
                ) : (
                  <SectionNavigation
                    section={section}
                    route={route}
                    hash={contextHash}
                    reading={reading}
                    go={choose}
                  />
                )}
              </div>
            )}
          </div>
          {!floating && (
            <Resizer
              sizes="previous"
              width={sizing.width}
              min={240}
              max={sizing.max}
              fallback={264}
              maxNow={() => researchSidebarMax(window.innerWidth)}
              property="--research-sidebar-width"
              label={t("sidebar.resize")}
              onChange={sizing.choose}
            />
          )}
        </>
      )}
    </nav>
  );
}
