import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefCallback,
} from "react";
import { Floating } from "./Floating";
import { Kbd } from "./Kbd";
import styles from "./Menu.module.css";
import { RETURNED_FOCUS, Tooltip } from "./Tooltip";
import type { Placement } from "./position";
import { ariaKeyShortcuts, currentPlatformIsMac } from "./shortcut";

/** A pause this long ends what has been typed, and the next letter starts a new search. */
const TYPEAHEAD_RESET_MS = 500;

export type MenuEntry =
  | {
      kind?: "item";
      id: string;
      label: string;
      icon?: LucideIcon;
      /** An exclusive choice; the menu exposes its selection to assistive technology. */
      checked?: boolean;
      /** Written as for `formatShortcut`; shown at the end of the row and announced. */
      shortcut?: string;
      danger?: boolean;
      /** Seen, but never current: the keyboard goes past it and a click does nothing. */
      disabled?: boolean;
      /** A word more about the item (why it is unavailable, say): a tooltip under the pointer, and its description. */
      hint?: string;
      onSelect: () => void;
    }
  | { kind: "separator"; id: string };

type MenuItem = Extract<MenuEntry, { kind?: "item" }>;

const isItem = (entry: MenuEntry): entry is MenuItem =>
  entry.kind !== "separator";

export interface MenuListProps {
  /** The accessible name of the list. */
  label: string;
  items: MenuEntry[];
  /**
   * The list is done: an item was chosen, Escape was pressed in it, or Tab left
   * it. Tab is not prevented, so the focus moves on by itself. Escape is only
   * reported when no `Floating` around the list has taken it first.
   */
  onClose: (reason: "select" | "escape" | "tab") => void;
  /** Which item gets the focus when the list appears. "none" leaves the focus where it is. */
  autoFocus?: "first" | "last" | "none";
  /** The axis the arrow keys move along. */
  orientation?: "vertical" | "horizontal";
  id?: string;
}

/** An item with a hint has it as a tooltip; one without is as it is. */
function Hinted({
  hint,
  children,
}: {
  hint: string | undefined;
  children: ReactElement;
}) {
  return hint ? <Tooltip content={hint}>{children}</Tooltip> : children;
}

/**
 * A list of actions with the keyboard of a menu: the arrows move between the
 * items and wrap round, Home and End go to the ends, letters jump to the item
 * they begin, Enter and Space choose. It has a surface of its own but no
 * position and no dismissal, so it can be put in any `Floating` (`Menu` does).
 */
export function MenuList({
  label,
  items,
  onClose,
  autoFocus = "first",
  orientation = "vertical",
  id,
}: MenuListProps) {
  const list = useRef<HTMLDivElement>(null);
  const elements = useRef<(HTMLDivElement | null)[]>([]);
  const typing = useRef({ text: "", timer: 0 });
  const mac = currentPlatformIsMac();

  // The items that can be current, as positions in `items`.
  const enabled = items.flatMap((entry, index) =>
    isItem(entry) && !entry.disabled ? [index] : [],
  );
  const focusAt = (index: number | undefined) => {
    if (index !== undefined) elements.current[index]?.focus();
  };

  // Once, as the list appears. It runs after the layer around it is shown: a hidden element cannot take the focus.
  const startWith = useRef(autoFocus);
  useEffect(() => {
    if (startWith.current === "none") return;
    const first = startWith.current === "first";
    const target = first ? enabled[0] : enabled.at(-1);
    if (target === undefined) list.current?.focus();
    else focusAt(target);
  }, []);
  useEffect(() => () => window.clearTimeout(typing.current.timer), []);

  const choose = (index: number) => {
    const entry = items[index];
    if (!entry || !isItem(entry) || entry.disabled) return;
    entry.onSelect();
    onClose("select");
  };

  /** Jump to the next item whose label begins with what has just been typed. */
  const typeahead = (character: string, current: number) => {
    const state = typing.current;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.text = "";
    }, TYPEAHEAD_RESET_MS);
    state.text += character.toLocaleLowerCase();
    // One letter, however often it is repeated, steps through the items that begin with it,
    // from the one after the current. A longer prefix narrows down, so the current one may still fit.
    const repeated = [...state.text].every((c) => c === state.text[0]);
    const query = repeated ? state.text[0] : state.text;
    const position = enabled.indexOf(current);
    const start = repeated ? position + 1 : Math.max(position, 0);
    for (let step = 0; step < enabled.length; step++) {
      const index = enabled[(start + step) % enabled.length];
      const entry = items[index];
      if (isItem(entry) && entry.label.toLocaleLowerCase().startsWith(query)) {
        focusAt(index);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A shortcut of the browser or the page (Cmd+R) is not for the list.
    if (event.nativeEvent.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const current = elements.current.findIndex(
      (element) => element !== null && element === document.activeElement,
    );
    const position = enabled.indexOf(current);
    const [forward, backward] =
      orientation === "vertical"
        ? ["ArrowDown", "ArrowUp"]
        : ["ArrowRight", "ArrowLeft"];
    const count = enabled.length;

    if (event.key === "Tab") {
      // Not handled: the focus moves on as the browser would have it.
      onClose("tab");
      return;
    }
    if (event.key === forward) {
      focusAt(enabled[position < 0 ? 0 : (position + 1) % count]);
    } else if (event.key === backward) {
      focusAt(
        enabled[position < 0 ? count - 1 : (position - 1 + count) % count],
      );
    } else if (event.key === "Home") {
      focusAt(enabled[0]);
    } else if (event.key === "End") {
      focusAt(enabled.at(-1));
    } else if (event.key === "Enter") {
      choose(current);
    } else if (event.key === " " && !typing.current.text) {
      choose(current);
    } else if (event.key === "Escape") {
      onClose("escape");
    } else if (event.key.length === 1) {
      // A letter, or a space in the middle of a word being typed.
      typeahead(event.key, current);
    } else {
      return;
    }
    // Handled here: not a scroll, not a press of a button, not something the page also does with the key.
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={list}
      id={id}
      role="menu"
      aria-label={label}
      aria-orientation={orientation}
      // So that a press on the padding keeps the focus in the list, and an empty list can hear Escape.
      tabIndex={-1}
      className={clsx(
        styles.list,
        orientation === "horizontal" && styles.horizontal,
      )}
      onKeyDown={onKeyDown}
    >
      {items.map((entry, index) =>
        isItem(entry) ? (
          <Hinted key={entry.id} hint={entry.hint}>
            <div
              ref={(element) => {
                elements.current[index] = element;
              }}
              role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={entry.checked}
              tabIndex={-1}
              aria-disabled={entry.disabled ? true : undefined}
              aria-description={entry.hint}
              aria-keyshortcuts={
                entry.shortcut
                  ? ariaKeyShortcuts(entry.shortcut, mac)
                  : undefined
              }
              className={clsx(styles.item, entry.danger && styles.danger)}
              onClick={() => choose(index)}
              // The pointer makes an item current just as the arrows do, so only one is ever lit.
              onPointerMove={(event) => {
                if (
                  !entry.disabled &&
                  document.activeElement !== event.currentTarget
                )
                  event.currentTarget.focus();
              }}
              // A press on an unavailable item must not take the focus from the current one.
              onMouseDown={(event) => {
                if (entry.disabled) event.preventDefault();
              }}
            >
              {entry.icon && <entry.icon size={16} aria-hidden="true" />}
              <span className={styles.label}>{entry.label}</span>
              {entry.shortcut && <Kbd shortcut={entry.shortcut} />}
            </div>
          </Hinted>
        ) : (
          <div
            key={entry.id}
            role="separator"
            aria-orientation={
              orientation === "horizontal" ? "vertical" : undefined
            }
            className={styles.separator}
          />
        ),
      )}
    </div>
  );
}

/** What the trigger must put on the control that opens the menu. */
export interface MenuTriggerProps {
  ref: RefCallback<HTMLElement>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface MenuProps {
  /** The accessible name of the menu. */
  label: string;
  items: MenuEntry[];
  placement?: Placement;
  /** The control that opens it: spread the props onto a `Button`. */
  trigger: (props: MenuTriggerProps) => ReactNode;
}

const defaultPlacement: Placement = { side: "bottom", align: "start" };

/**
 * A button and the list of actions it opens beside itself. The button toggles
 * it, and the arrow keys open it onto the first or the last item. Choosing an
 * item or pressing Escape closes it and returns the focus to the button; a
 * press outside it closes it and leaves the focus where the press put it.
 */
export function Menu({
  label,
  items,
  placement = defaultPlacement,
  trigger,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState<"first" | "last">("first");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const listId = useId();

  const show = (at: "first" | "last") => {
    setStartAt(at);
    setOpen(true);
  };
  const close = (returnFocus: boolean) => {
    // Before the list goes: the focus is then never on something that is leaving. After Tab, the
    // browser moves on from the button, to whatever follows it.
    if (returnFocus && anchor) {
      anchor.setAttribute(RETURNED_FOCUS, "");
      anchor.focus();
      anchor.removeAttribute(RETURNED_FOCUS);
    }
    setOpen(false);
  };

  return (
    <>
      {trigger({
        ref: setAnchor,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": listId,
        onClick: () => (open ? close(true) : show("first")),
        onKeyDown: (event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) show(event.key === "ArrowUp" ? "last" : "first");
          } else if (event.key === "Enter" || event.key === " ") {
            // Taken here, not left to become a click: a held key would otherwise flick it open and shut.
            event.preventDefault();
            if (event.repeat) return;
            if (open) close(true);
            else show("first");
          }
        },
      })}
      <Floating
        open={open}
        anchor={anchor}
        placement={placement}
        // The button is part of the menu for outside presses: its own click toggles.
        ignore={anchor}
        onDismiss={(reason) => close(reason === "escape")}
      >
        <MenuList
          id={listId}
          label={label}
          items={items}
          autoFocus={startAt}
          onClose={() => close(true)}
        />
      </Floating>
    </>
  );
}
