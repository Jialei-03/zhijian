import { useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "../ui";
import { sidebarId } from "./sidebar-entries";
import styles from "./AppSidebar.module.css";

export const MESSAGE_FIRST = 8;
export const READING_FIRST = 5;
export const PAGE_MORE = 20;

/** Preserve source order, including important rows beyond the page boundary. */
export function pageRows<T>(
  items: readonly T[],
  limit: number,
  keep: (item: T) => boolean,
) {
  const rows = items.filter((item, index) => index < limit || keep(item));
  return { rows, hidden: items.length - rows.length };
}

export function sidebarPageKey(owner: string, project: string, list: string) {
  return `sidebar-page:${JSON.stringify([owner, project, list])}`;
}

export function readSidebarPage(key: string, first: number) {
  try {
    const limit = Number(localStorage.getItem(key));
    if (Number.isSafeInteger(limit) && limit >= first) return limit;
  } catch {
    /* Pagination also works without storage. */
  }
  return first;
}

export function useSidebarPage(key: string, first: number) {
  const [page, setPage] = useState(() => ({
    key,
    limit: readSidebarPage(key, first),
  }));
  // A project switch must never borrow the previous project's page limit.
  const limit = page.key === key ? page.limit : readSidebarPage(key, first);
  const choose = (next: number) => {
    setPage({ key, limit: next });
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* Keep the in-memory choice. */
    }
  };
  return [limit, choose] as const;
}

export function SidebarPagination({
  list,
  first,
  limit,
  hidden,
  choose,
}: {
  list: "messages" | "recent";
  first: number;
  limit: number;
  hidden: number;
  choose(limit: number): void;
}) {
  const { t, tn } = useI18n();
  if (!hidden && limit <= first) return null;
  return (
    <div className={styles.pagination}>
      {hidden > 0 && (
        <Button
          size="sm"
          variant="ghost"
          data-id={sidebarId(`${list}-more`)}
          onClick={() => choose(limit + PAGE_MORE)}
        >
          {tn("sidebar.more", Math.min(hidden, PAGE_MORE))}
        </Button>
      )}
      {limit > first && (
        <Button
          size="sm"
          variant="ghost"
          data-id={sidebarId(`${list}-less`)}
          onClick={() => choose(first)}
        >
          {t("sidebar.less")}
        </Button>
      )}
    </div>
  );
}
