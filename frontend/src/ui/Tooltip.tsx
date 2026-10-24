import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Floating } from "./Floating";
import { Kbd } from "./Kbd";
import type { Placement } from "./position";
import styles from "./Tooltip.module.css";

/** How long the pointer rests on the control before its tooltip shows. */
const HOVER_DELAY_MS = 400;

const defaultPlacement: Placement = { side: "bottom", align: "center" };

export interface TooltipProps {
  /** What the control is called. The control keeps its own accessible name: the tooltip is hidden from assistive technology. */
  content: string;
  /** The shortcut that does the same, written as for `formatShortcut`. */
  shortcut?: string;
  placement?: Placement;
  /** Off: nothing is shown. For a name that is worth a tooltip only some of the time (a label that is cut short). */
  disabled?: boolean;
  /**
   * Shown while true and gone while false, whatever the pointer and the focus do
   * (Esc still puts it away until it is next opened). For a hint about something
   * the pointer rests on without it being the element under the pointer, such as
   * a mark drawn beneath a page's text: its owner tells when, delay and all.
   */
  open?: boolean;
  /** One element, which the tooltip is placed against. It must name itself (an `aria-label`, say). */
  children: ReactElement;
}

/**
 * A short name for a control, shown beside it when the pointer rests on it, or
 * at once when it gets keyboard focus. Hovering needs no wrapper element of its
 * own in the layout (it is `display: contents`); the events of the child bubble
 * up to it.
 */
/** Set on an element for the moment a closing menu gives it the focus back. */
export const RETURNED_FOCUS = "data-returned-focus";

export function Tooltip({
  content,
  shortcut,
  placement = defaultPlacement,
  disabled = false,
  open,
  children,
}: TooltipProps) {
  const controlled = open !== undefined;
  const wrapper = useRef<HTMLSpanElement>(null);
  const timer = useRef(0);
  // Set by a press: the pointer is still over the control, but it has been used,
  // and hovering it must not bring the tooltip back until it leaves and returns.
  const pressed = useRef(false);
  // The control the tooltip is against while it is shown; null while it is not.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const anchorOf = () => {
    const child = wrapper.current?.firstElementChild;
    return child instanceof HTMLElement ? child : null;
  };
  const inside = (node: EventTarget | null) =>
    node instanceof Node && !!anchorOf()?.contains(node);
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = 0;
  };
  const show = () => {
    cancel();
    if (!disabled) setAnchor(anchorOf());
  };
  const hide = () => {
    cancel();
    setAnchor(null);
  };
  useEffect(() => cancel, []);
  // Turned off while it is up (or about to be): it goes.
  useEffect(() => {
    if (disabled) hide();
  }, [disabled]);
  // Told to show or to go: the child is there to be placed against once it is laid out.
  useLayoutEffect(() => {
    if (controlled) setAnchor(open && !disabled ? anchorOf() : null);
  }, [controlled, open, disabled]);

  return (
    <span
      ref={wrapper}
      className={styles.root}
      onPointerOver={(event) => {
        // A finger has no hover; and moving between parts of the control is not arriving.
        if (
          controlled ||
          event.pointerType === "touch" ||
          timer.current ||
          pressed.current
        )
          return;
        if (!inside(event.target) || inside(event.relatedTarget)) return;
        timer.current = window.setTimeout(show, HOVER_DELAY_MS);
      }}
      onPointerDown={(event) => {
        // Pressed before the delay is over, or after: either way the tooltip is done,
        // or it would open late over whatever the press opened (a menu, say).
        if (controlled || !inside(event.target)) return;
        pressed.current = true;
        hide();
      }}
      onPointerOut={(event) => {
        if (controlled || !inside(event.target) || inside(event.relatedTarget))
          return;
        pressed.current = false;
        hide();
      }}
      onFocus={(event) => {
        // Only focus that came by keyboard: a click focuses too, and must not pop one up. Nor does
        // focus a menu hands back as it closes: the next Escape belongs to what is around it.
        if (
          !controlled &&
          event.target.matches(":focus-visible") &&
          !event.target.hasAttribute(RETURNED_FOCUS)
        )
          show();
      }}
      onBlur={() => {
        if (!controlled) hide();
      }}
    >
      {children}
      {anchor && (
        <Floating
          open
          anchor={anchor}
          placement={placement}
          role="tooltip"
          aria-hidden
          className={styles.tip}
          onDismiss={hide}
        >
          {content}
          {shortcut && <Kbd shortcut={shortcut} />}
        </Floating>
      )}
    </span>
  );
}
