import {
  Database,
  Gauge,
  KeyRound,
  RefreshCw,
  Search,
  Settings2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import { IconButton } from "../../ui";
import { AccessSection } from "./AccessSection";
import { CloudSection } from "./CloudSection";
import { DataSection } from "./DataSection";
import {
  AppearanceSection,
  KeypointsSection,
  LanguageSection,
} from "./PreferencesSection";
import { UsageSection } from "./UsageSection";
import { useLocal } from "../../app/edition";
import styles from "./SettingsWindow.module.css";

export type SettingsCategory =
  | "general"
  | "data"
  | "usage"
  | "access"
  | "cloud";

interface Entry {
  id: SettingsCategory;
  icon: LucideIcon;
}

const GROUPS: { title: MessageKey; entries: Entry[] }[] = [
  {
    title: "settings.group.app",
    entries: [
      {
        id: "general",
        icon: Settings2,
      },
    ],
  },
  {
    title: "settings.group.account",
    entries: [
      { id: "data", icon: Database },
      { id: "usage", icon: Gauge },
      {
        id: "access",
        icon: KeyRound,
      },
      { id: "cloud", icon: RefreshCw },
    ],
  },
];

export const CATEGORIES = GROUPS.flatMap((g) => g.entries.map((e) => e.id));

function Body({
  category,
  go,
}: {
  category: SettingsCategory;
  go(hash: string): void;
}): ReactNode {
  switch (category) {
    case "general":
      return (
        <>
          <AppearanceSection />
          <LanguageSection />
          <KeypointsSection />
        </>
      );
    case "data":
      return <DataSection />;
    case "usage":
      return <UsageSection />;
    case "access":
      return <AccessSection go={go} />;
    case "cloud":
      return <CloudSection />;
  }
}

/**
 * The settings as a window over whatever was open: the kinds of settings on
 * the left (found by a search too), the chosen kind on the right. Esc, the
 * close button or a click outside closes it; the page underneath stays as it was.
 */
export function SettingsWindow({
  category: asked,
  onCategory,
  onClose,
  go,
}: {
  category: SettingsCategory;
  onCategory(category: SettingsCategory): void;
  onClose(): void;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    search.current?.focus();
  }, []);

  const label = (id: SettingsCategory) =>
    t(`settings.category.${id}` as MessageKey);
  const q = query.trim().toLowerCase();
  const local = useLocal();
  const category = local !== true && asked === "cloud" ? "general" : asked;
  const groups = GROUPS.map((g) => ({
    ...g,
    entries: g.entries.filter(
      (e) =>
        // Linking to a hosted account is the local edition's.
        (e.id !== "cloud" || local === true) &&
        (!q ||
          label(e.id).toLowerCase().includes(q) ||
          t(`settings.keywords.${e.id}` as MessageKey)
            .toLowerCase()
            .includes(q)),
    ),
  })).filter((g) => g.entries.length);

  return (
    <dialog
      ref={dialog}
      className={styles.window}
      aria-label={t("settings.title")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        // A press on the backdrop (the dialog element itself) closes it.
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className={styles.frame}>
        <nav className={styles.nav} aria-label={t("settings.title")}>
          <label className={styles.search}>
            <Search size={16} aria-hidden />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder={t("settings.search")}
              aria-label={t("settings.search")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && groups[0])
                  onCategory(groups[0].entries[0].id);
              }}
            />
          </label>
          {groups.map((group) => (
            <div key={group.title} className={styles.group}>
              <p className={styles.groupTitle}>{t(group.title)}</p>
              {group.entries.map((entry) => {
                const Icon = entry.icon;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={styles.item}
                    aria-current={entry.id === category ? "page" : undefined}
                    onClick={() => onCategory(entry.id)}
                  >
                    <Icon size={16} aria-hidden />
                    {label(entry.id)}
                  </button>
                );
              })}
            </div>
          ))}
          {!groups.length && (
            <p className={styles.none}>{t("settings.searchNone")}</p>
          )}
        </nav>
        <main className={styles.main}>
          <div className={styles.close}>
            <IconButton icon={X} label={t("common.close")} onClick={onClose} />
          </div>
          <div className={styles.content} key={category}>
            <h1 className={styles.title}>{label(category)}</h1>
            <Body category={category} go={go} />
          </div>
        </main>
      </div>
    </dialog>
  );
}
