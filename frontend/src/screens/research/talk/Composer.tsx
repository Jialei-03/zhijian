import { ArrowUp, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { SlashCommand } from "../../../lib/slash";
import {
  Button,
  IconButton,
  Menu,
  Tooltip,
  useSlashCommands,
} from "../../../ui";
import { INSERT_EVENT, type InsertDetail } from "../files/files-api";
import { AddModelButton, openModelSetup } from "../../setup/ModelSetup";
import styles from "./Talk.module.css";

/**
 * The one place the researcher writes: grows with the text, Enter sends,
 * Shift+Enter breaks the line, and typing an IME candidate never sends.
 * A "/" opens its slash commands, when it has any.
 */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  label,
  sendLabel,
  busy = false,
  disabled = false,
  sendDisabled = false,
  needsModel = false,
  autoFocus = false,
  tools,
  leading,
  focusKey = 0,
  commands,
  status,
  acceptInserts = false,
  commandsOnly = false,
}: {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  placeholder: string;
  label: string;
  sendLabel: string;
  busy?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  /** The settings were read successfully and contain no models. */
  needsModel?: boolean;
  autoFocus?: boolean;
  /** Pickers beside the send button (model, compute). */
  tools?: ReactNode;
  leading?: ReactNode;
  /** Changing it puts the cursor at the end of the text (after a starter was picked). */
  focusKey?: number;
  /** What "/" offers here; a message that is one of them runs it instead of being sent. */
  commands?: SlashCommand[];
  /** A quiet note in the foot (how full the conversation's context is). */
  status?: ReactNode;
  /** Takes the "@path" the research's files panel sends ("insert into the composer"). */
  acceptInserts?: boolean;
  /** Nothing more to say here (a finished research), but its slash commands still run. */
  commandsOnly?: boolean;
}) {
  const { t } = useI18n();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = field.current;
    if (!focusKey || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);
  const slash = useSlashCommands({ value, onChange, commands });
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => {
    if (!acceptInserts) return;
    const take = (event: Event) => {
      const { text } = (event as CustomEvent<InsertDetail>).detail;
      const { value: now, onChange: set } = latest.current;
      set(now && !/\s$/.test(now) ? `${now} ${text}` : now + text);
      field.current?.focus();
    };
    window.addEventListener(INSERT_EVENT, take);
    return () => window.removeEventListener(INSERT_EVENT, take);
  }, [acceptInserts]);
  const ready =
    value.trim().length > 0 &&
    !busy &&
    !disabled &&
    (!sendDisabled || needsModel) &&
    !commandsOnly;
  // Actions that need text stay in the slash palette. These run without
  // replacing an unsent draft, and model choices already have their picker.
  const actions = (commands ?? []).filter(
    (command) => !command.takesArgument && command.group !== "model",
  );
  const send = () => {
    if (slash.submit()) return;
    if (!ready) return;
    if (needsModel) openModelSetup();
    else onSend();
  };
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {slash.menu}
      <textarea
        ref={field}
        className={styles.field}
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (slash.onKeyDown(event)) return;
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className={styles.composerFoot}>
        <div className={styles.composerStart}>
          {leading}
          {!leading && actions.length > 0 && (
            <Menu
              label={t("research.composer.actions")}
              placement={{ side: "top", align: "start" }}
              items={actions.map((command) => ({
                id: command.name,
                label: command.description,
                disabled,
                onSelect: () => void command.run(""),
              }))}
              trigger={(props) => (
                <IconButton
                  icon={Plus}
                  className={styles.plus}
                  label={t("research.composer.actions")}
                  disabled={disabled}
                  {...props}
                />
              )}
            />
          )}
          {status && <span className={styles.composerStatus}>{status}</span>}
        </div>
        <div className={styles.composerEnd}>
          {needsModel ? <AddModelButton disabled={busy || disabled} /> : tools}
          <Tooltip content={sendLabel}>
            <Button
              type="submit"
              variant={needsModel ? "secondary" : "primary"}
              icon={ArrowUp}
              className={styles.send}
              disabled={!ready}
              aria-label={sendLabel}
            />
          </Tooltip>
        </div>
      </div>
    </form>
  );
}
