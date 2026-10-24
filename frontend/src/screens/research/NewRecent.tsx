import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { followLink } from "../../reader/route";
import { Spinner } from "../../ui";
import { recentResearches, type RecentResearch } from "./research-api";
import { statusOf } from "./status";
import { threadDate } from "./team-model";
import styles from "./NewRecent.module.css";

const COUNT = 5;

/**
 * The researches touched last, under the first message as Claude lists recent
 * tasks: what each asks, its project and when, and where it stands.
 */
export function NewRecent({ go }: { go(hash: string): void }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<RecentResearch[]>([]);
  useEffect(() => {
    let stale = false;
    recentResearches(COUNT).then(
      (value) => {
        if (!stale) setRows(value);
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, []);
  if (!rows.length) return null;
  return (
    <section className={styles.recent} aria-labelledby="new-recent">
      <div className={styles.head}>
        <h2 id="new-recent" className={styles.title}>
          {t("new.recent")}
        </h2>
        <a
          className={styles.all}
          href="#projects"
          onClick={followLink(go, "projects")}
        >
          {t("home.research.all")}
        </a>
      </div>
      <ul className={styles.list}>
        {rows.map((r) => {
          const { key, tone } = statusOf(r);
          const hash = `research/${r.id}`;
          return (
            <li key={r.id}>
              <a
                className={styles.row}
                href={`#${hash}`}
                onClick={followLink(go, hash)}
              >
                <span className={styles.text}>
                  <span className={styles.question}>
                    {r.title || r.question}
                  </span>
                  <span className={styles.meta}>
                    {r.workspace} ·{" "}
                    {threadDate(r.updated_at, locale, new Date(), "relative")}
                  </span>
                </span>
                <span className={styles.status} data-tone={tone}>
                  {(tone === "running" || tone === "todo") && (
                    <Spinner size={14} />
                  )}
                  {t(key)}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
