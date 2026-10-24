import clsx from "clsx";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useI18n } from "../i18n/I18nProvider";
import { IconButton } from "./IconButton";
import type { Placement } from "./position";
import {
  ariaKeyShortcuts,
  currentPlatformIsMac,
  matchesShortcut,
} from "./shortcut";
import { Resizer, useResizableWidth, type ResizableWidth } from "./Resizer";
import { Tooltip } from "./Tooltip";
import styles from "./Sidebar.module.css";

/** Collapses and expands the sidebar. */
const TOGGLE_SHORTCUT = "mod+\\";

/** A collapsed item has no room for its label, so the tooltip goes to the right of it. */
const beside: Placement = { side: "right", align: "center" };

/** The open sidebar's width: where it starts, and the least and most it can be. */
export const SIDEBAR_DEFAULT = 220;
export const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 360;

/** The most it can be in a window this wide: the cards keep at least two thirds. */
export const sidebarMax = (windowWidth: number) =>
  Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(windowWidth / 3)));

/**
 * The open sidebar's width, kept per person on this device (`owner` says
 * whose), for `Sidebar`'s `resizable`.
 */
export function useSidebarWidth(owner = ""): ResizableWidth {
  return useResizableWidth({
    key: `paper-sidebar-width:${owner}`,
    fallback: SIDEBAR_DEFAULT,
    min: SIDEBAR_MIN,
    maxFor: sidebarMax,
  });
}

const SidebarContext = createContext<{
  collapsed: boolean;
  /** An item was chosen: a sidebar that floats closes. `undefined` when it has nothing to close. */
  choose?: () => void;
}>({ collapsed: false });

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether keys typed at this target are text: a shortcut of the page stays out of the way. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement)
    return true;
  return (
    target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type)
  );
}

export interface SidebarProps {
  "data-sidebar-place"?: string;
  collapseId?: string;
  /** The accessible name of the navigation. */
  label: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /**
   * For a window too narrow to give the sidebar its 220px beside the cards: it
   * keeps only the 56px of its rail in the shell, and opened it floats over the
   * cards instead of pushing them. Esc, a click anywhere else, the keyboard
   * leaving it and choosing an item close it (`onCollapsedChange(true)`).
   */
  overlay?: boolean;
  /**
   * The width the person has chosen (`useSidebarWidth`): with it the open
   * sidebar has a handle on its right edge. A collapsed sidebar and one that
   * floats (`overlay`) keep their own widths and have no handle.
   */
  resizable?: ResizableWidth;
  /** A mark or a name above the items. Hidden while the sidebar is collapsed. */
  header?: ReactNode;
  /** Items kept at the bottom, out of the scrolling list. */
  footer?: ReactNode;
  /** `SidebarSection`s and `SidebarItem`s. */
  children: ReactNode;
}

/**
 * The navigation down the left of the window. It has no surface of its own: it
 * sits on the shell, and its items are lit only when the pointer is on them or
 * they are current. 220px wide (or as wide as the person drags it, 180 to
 * 360px), 56px once collapsed, when only the icons are
 * left (the change is at once; the text that returns fades in). Ctrl+\ (Command+\ on a Mac) collapses and expands it, from anywhere but
 * a text field. With `overlay` the opened sidebar floats over the cards rather
 * than pushing them.
 */
export function Sidebar({
  "data-sidebar-place": place,
  collapseId,
  label,
  collapsed,
  onCollapsedChange,
  overlay = false,
  resizable,
  header,
  footer,
  children,
}: SidebarProps) {
  const { t } = useI18n();
  const mac = currentPlatformIsMac();
  const nav = useRef<HTMLElement>(null);

  // The text that comes back when the sidebar opens fades in; what is there at load does not.
  useEffect(() => {
    nav.current?.setAttribute("data-settled", "");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Not a held key, not an input method's, not text being typed, not taken already.
      if (event.repeat || event.isComposing || event.defaultPrevented) return;
      if (isTextEntry(event.target)) return;
      if (!matchesShortcut(event, TOGGLE_SHORTCUT, mac)) return;
      event.preventDefault();
      onCollapsedChange(!collapsed);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collapsed, onCollapsedChange, mac]);

  // Open and floating: over the cards, and closed by whatever the person does elsewhere.
  const floating = overlay && !collapsed;
  // Only the open sidebar that sits in the shell is sized by hand.
  const sized = resizable !== undefined && !overlay && !collapsed;
  const close = useCallback(() => onCollapsedChange(true), [onCollapsedChange]);
  useEffect(() => {
    if (!floating) return;
    const onEscape = (event: KeyboardEvent) => {
      // Not an input method's, and not one that something nearer (a menu, a field) has taken.
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented)
        return;
      event.preventDefault();
      close();
    };
    const outside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      if (!nav.current?.contains(event.target)) close();
    };
    document.addEventListener("keydown", onEscape);
    // In the capture phase: a page that stops the click from travelling still closes it.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [floating, close]);

  return (
    <SidebarContext.Provider
      value={{ collapsed, choose: floating ? close : undefined }}
    >
      <div className={clsx(styles.slot, overlay && styles.reserved)}>
        <nav
          ref={nav}
          data-sidebar-place={place}
          aria-label={label}
          style={
            sized
              ? ({ "--sidebar-width": `${resizable.width}px` } as CSSProperties)
              : undefined
          }
          className={clsx(
            styles.sidebar,
            collapsed && styles.collapsed,
            floating && styles.floating,
          )}
        >
          <div className={styles.top}>
            {header && <div className={styles.header}>{header}</div>}
            <IconButton
              data-id={collapseId}
              icon={collapsed ? PanelLeftOpen : PanelLeftClose}
              label={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}
              shortcut={TOGGLE_SHORTCUT}
              aria-expanded={!collapsed}
              aria-keyshortcuts={ariaKeyShortcuts(TOGGLE_SHORTCUT, mac)}
              onClick={() => onCollapsedChange(!collapsed)}
            />
          </div>
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </nav>
        {sized && (
          <Resizer
            sizes="previous"
            width={resizable.width}
            min={SIDEBAR_MIN}
            max={resizable.max}
            fallback={SIDEBAR_DEFAULT}
            maxNow={() => sidebarMax(window.innerWidth)}
            property="--sidebar-width"
            label={t("sidebar.resize")}
            onChange={resizable.choose}
          />
        )}
      </div>
    </SidebarContext.Provider>
  );
}

/** A group of items under a small title. Collapsed, the title goes and the gap stays. */
export function SidebarSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <div
      role="group"
      aria-labelledby={title ? titleId : undefined}
      className={styles.section}
    >
      {title && (
        <div id={titleId} className={styles.sectionTitle}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

/** Whether the text of an element is cut short, kept current as the element is resized. */
function useTruncated(element: RefObject<HTMLElement | null>, text: string) {
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const measure = () => setTruncated(target.scrollWidth > target.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, text]);
  return truncated;
}

export interface SidebarItemProps {
  "data-id"?: string;
  disabled?: boolean;
  icon: LucideIcon;
  iconContent?: ReactNode;
  /** One line: a longer label is cut with an ellipsis, and shown whole in a tooltip. */
  label: string;
  /** A small note at the end of the row (a count, say). */
  meta?: string;
  /** The page this item stands for: it is lit, and marked as the current page. */
  active?: boolean;
  /** The paper being read right now: a dot with a soft ring. */
  dot?: boolean;
  /** Gets the click, so that a link can take it over (and leave a click with a modifier key to the browser). */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** With an address the item is a link; without, a button. */
  href?: string;
}

export function SidebarItem({
  "data-id": dataId,
  disabled,
  icon: Icon,
  iconContent,
  label,
  meta,
  active = false,
  dot = false,
  onClick,
  href,
}: SidebarItemProps) {
  const { collapsed, choose } = useContext(SidebarContext);
  const text = useRef<HTMLSpanElement>(null);
  const truncated = useTruncated(text, label);

  const content = (
    <>
      {iconContent ?? <Icon size={16} aria-hidden="true" />}
      <span ref={text} className={styles.label}>
        {label}
      </span>
      {meta && <span className={styles.meta}>{meta}</span>}
      {dot && <span aria-hidden="true" className={styles.dot} />}
    </>
  );
  const props = {
    "data-id": dataId,
    className: clsx(styles.item, active && styles.active),
    "aria-current": active ? ("page" as const) : undefined,
    // The label is not drawn while collapsed, so the name is given outright; it is the one the content makes.
    "aria-label": collapsed ? (meta ? `${label} ${meta}` : label) : undefined,
    // The item's own answer comes first (a link takes the click over); then a floating sidebar is done with.
    onClick: (event: MouseEvent<HTMLElement>) => {
      onClick?.(event);
      choose?.();
    },
  };

  return (
    <Tooltip
      content={label}
      placement={beside}
      disabled={!collapsed && !truncated}
    >
      {href ? (
        <a {...props} href={href}>
          {content}
        </a>
      ) : (
        <button {...props} type="button" disabled={disabled}>
          {content}
        </button>
      )}
    </Tooltip>
  );
}
