import { useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import type { MessageKey } from "../../../i18n/i18n";
import { followLink } from "../../../reader/route";
import { Button } from "../../../ui";
import { shortDuration } from "../../research/process/model";
import {
  differs,
  type Comparison,
  type ComparisonThread,
  type EvaluationResults,
} from "./compare-api";
import styles from "./Compare.module.css";

export interface CompareViewProps {
  comparison: Comparison;
  onOpenResearch?(id: string): void;
}

const roleKeys: Record<string, MessageKey> = {
  advisor: "research.role.advisor",
  executor: "research.role.executor",
  distiller: "research.role.distiller",
  scoping: "research.role.scoping",
  discussion: "research.role.discussion",
  workflow: "research.role.workflow",
  review: "research.role.review",
  human: "research.fork.researcher",
};
const statusKeys: Record<string, MessageKey> = {
  active: "research.status.running",
  waiting: "research.status.waiting",
  paused: "research.status.paused",
  finished: "research.status.finished",
};

export function CompareView({ comparison, onOpenResearch }: CompareViewProps) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(0);
  const start = Math.min(
    page,
    Math.max(0, Math.ceil(comparison.threads.length / 3) - 1),
  );
  const visible = comparison.threads.slice(start * 3, start * 3 + 3);
  const format = (value: number | string) =>
    typeof value === "number"
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(
          value,
        )
      : value;
  const number = (
    value: number,
    key: "tokens" | "job_seconds" | "elapsed_seconds" | "rounds",
  ) => (
    <strong
      className={styles.number}
      data-different={
        differs(comparison.threads.map((thread) => thread[key])) || undefined
      }
    >
      {key.endsWith("seconds") ? shortDuration(value, t) : format(value)}
    </strong>
  );
  const row = (
    label: string,
    render: (thread: ComparisonThread) => ReactNode,
  ) => (
    <tr>
      <th scope="row">{label}</th>
      {visible.map((thread) => (
        <td key={thread.id}>{render(thread)}</td>
      ))}
    </tr>
  );
  if (!comparison.threads.length)
    return <p className={styles.empty}>{t("compare.empty")}</p>;
  const names = [
    ...new Set(
      comparison.threads.flatMap((thread) =>
        thread.numbers.map((metric) => metric.name),
      ),
    ),
  ];
  return (
    <section className={styles.stack} aria-label={t("compare.title")}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>{t("compare.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("compare.research")}</th>
            {visible.map((thread) => {
              const hash = `research/${thread.id}`;
              return (
                <th scope="col" key={thread.id}>
                  <a
                    href={`#${hash}`}
                    onClick={
                      onOpenResearch
                        ? followLink(() => onOpenResearch(thread.id), hash)
                        : undefined
                    }
                  >
                    {thread.title}
                  </a>
                  <span className={styles.meta}>{thread.workflow}</span>
                  <span className={styles.meta}>
                    {statusKeys[thread.status]
                      ? t(statusKeys[thread.status])
                      : thread.status}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {row(t("compare.conclusion"), (thread) => thread.conclusion || "—")}
          {row(t("compare.numbers"), (thread) =>
            names.length ? (
              <dl className={styles.metrics}>
                {names.map((name) => {
                  const value = thread.numbers.find(
                    (metric) => metric.name === name,
                  )?.value;
                  return (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd
                        className={styles.number}
                        data-different={
                          (value !== undefined &&
                            differs(
                              comparison.threads.map(
                                (item) =>
                                  item.numbers.find(
                                    (metric) => metric.name === name,
                                  )?.value,
                              ),
                            )) ||
                          undefined
                        }
                      >
                        {value === undefined ? "—" : format(value)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              "—"
            ),
          )}
          {row(t("compare.cost"), (thread) => (
            <dl className={styles.metrics}>
              <div>
                <dt>{t("compare.tokens")}</dt>
                <dd>{number(thread.tokens, "tokens")}</dd>
              </div>
              <div>
                <dt>{t("compare.jobTime")}</dt>
                <dd>{number(thread.job_seconds, "job_seconds")}</dd>
              </div>
            </dl>
          ))}
          {row(t("compare.elapsed"), (thread) =>
            number(thread.elapsed_seconds, "elapsed_seconds"),
          )}
          {row(t("compare.rounds"), (thread) =>
            number(thread.rounds, "rounds"),
          )}
          {row(t("compare.members"), (thread) =>
            thread.members.length ? (
              <ul className={styles.members}>
                {thread.members.map((member) => (
                  <li key={member.id}>
                    <span>
                      {member.id === member.name && roleKeys[member.id]
                        ? t(roleKeys[member.id])
                        : member.name}
                    </span>
                    <span
                      className={styles.meta}
                      data-different={
                        differs(
                          comparison.threads.map(
                            (item) =>
                              item.members.find(
                                (value) => value.id === member.id,
                              )?.messages,
                          ),
                        ) ||
                        differs(
                          comparison.threads.map(
                            (item) =>
                              item.members.find(
                                (value) => value.id === member.id,
                              )?.tokens,
                          ),
                        ) ||
                        undefined
                      }
                    >
                      {t("compare.messageCount", {
                        n: format(member.messages),
                      })}{" "}
                      · {t("compare.tokenCount", { n: format(member.tokens) })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              "—"
            ),
          )}
        </tbody>
      </table>
      {comparison.threads.length > 3 && (
        <nav className={styles.actions} aria-label={t("compare.title")}>
          <Button
            variant="ghost"
            disabled={start === 0}
            onClick={() => setPage(start - 1)}
          >
            {t("compare.previous")}
          </Button>
          <Button
            variant="ghost"
            disabled={(start + 1) * 3 >= comparison.threads.length}
            onClick={() => setPage(start + 1)}
          >
            {t("compare.next")}
          </Button>
        </nav>
      )}
    </section>
  );
}

export function BatchResultsTable({
  results,
  onOpenResearch,
}: {
  results: EvaluationResults;
  onOpenResearch?(id: string): void;
}) {
  const { t, locale } = useI18n();
  const format = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  return (
    <table className={styles.table}>
      <caption>{results.name}</caption>
      <thead>
        <tr>
          <th scope="col">{t("compare.question")}</th>
          {results.workflows.map((workflow) => (
            <th scope="col" key={workflow.id}>
              {workflow.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {results.questions.map((question, index) => {
          const threads = results.workflows.map((workflow) =>
            results.threads.find(
              (thread) =>
                thread.id ===
                results.cells.find(
                  (cell) =>
                    cell.question === index && cell.workflow_id === workflow.id,
                )?.research_id,
            ),
          );
          return (
            <tr key={index}>
              <th scope="row">{question}</th>
              {threads.map((thread, column) => (
                <td key={results.workflows[column].id}>
                  {thread ? (
                    <>
                      <a
                        href={`#research/${thread.id}`}
                        onClick={
                          onOpenResearch
                            ? followLink(
                                () => onOpenResearch(thread.id),
                                `research/${thread.id}`,
                              )
                            : undefined
                        }
                      >
                        {statusKeys[thread.status]
                          ? t(statusKeys[thread.status])
                          : thread.status}
                      </a>
                      <p>{thread.conclusion || "—"}</p>
                      {thread.numbers.map((metric) => (
                        <span
                          key={metric.name}
                          className={styles.meta}
                          data-different={
                            differs(
                              threads.map(
                                (item) =>
                                  item?.numbers.find(
                                    (value) => value.name === metric.name,
                                  )?.value,
                              ),
                            ) || undefined
                          }
                        >
                          {metric.name} ·{" "}
                          {typeof metric.value === "number"
                            ? format(metric.value)
                            : metric.value}
                        </span>
                      ))}
                      <span
                        className={styles.meta}
                        data-different={
                          differs(threads.map((item) => item?.tokens)) ||
                          undefined
                        }
                      >
                        {t("compare.tokenCount", { n: format(thread.tokens) })}
                      </span>
                      <span className={styles.meta}>
                        {shortDuration(thread.elapsed_seconds, t)}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
