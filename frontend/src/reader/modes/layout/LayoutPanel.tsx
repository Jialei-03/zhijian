import { useI18n } from "../../../i18n/I18nProvider";
import { LatexInstall } from "../../../screens/settings/LatexInstall";
import { LayoutInstall } from "../../../screens/settings/LayoutInstall";
import { Button, Spinner } from "../../../ui";
import { ENGINES, percentOf, type Engine } from "./job";
import styles from "./LayoutPanel.module.css";
import type { EngineView, Layout } from "./useLayoutTranslation";

/** How far a running translation has got: the service's words for the stage, and a bar. */
function Progress({ view, name }: { view: EngineView; name: string }) {
  const { t } = useI18n();
  const { job } = view;
  if (!job) return null;
  const percent = percentOf(job);
  const queued = job.status === "queued";
  return (
    <div className={styles.progress}>
      <p className={styles.stage} role="status">
        <span>{job.stage || (queued ? t("reader.layout.queued") : "")}</span>
        {percent !== null && (
          <span className={styles.percent}>
            {t("reader.layout.percent", { percent })}
          </span>
        )}
      </p>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={t("reader.engine.progress", { name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className={styles.fill}
          style={{ transform: `scaleX(${(percent ?? 0) / 100})` }}
        />
      </div>
    </div>
  );
}

/** What a method needs that is missing, said plainly; the local build offers to install it. */
function Missing({ layout, engine }: { layout: Layout; engine: Engine }) {
  const { t } = useI18n();
  if (engine === "latex")
    return (
      <>
        <p className={styles.note}>{t("reader.layout.latexMissingNote")}</p>
        {layout.latexInstallable && <LatexInstall compact />}
      </>
    );
  return (
    <>
      <p className={styles.note}>{t("reader.layout.disabledNote")}</p>
      {/* The local build installs it on demand; elsewhere this shows nothing. */}
      <LayoutInstall compact />
    </>
  );
}

function Method({ layout, engine }: { layout: Layout; engine: Engine }) {
  const { t } = useI18n();
  const view = layout.engines[engine];
  const name = t(`reader.engine.${engine}.name`);
  const selected = layout.selected === engine;
  const ready = view.supported && view.available;

  let body;
  if (!view.supported)
    body = (
      <p className={styles.note}>{t("reader.engine.latex.unsupported")}</p>
    );
  else if (view.state === "running")
    body = (
      <>
        <Progress view={view} name={name} />
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            loading={layout.busy}
            onClick={() => layout.cancel(engine)}
          >
            {t("reader.layout.cancel")}
          </Button>
        </div>
      </>
    );
  else if (view.state === "done")
    body = (
      <div className={styles.actions}>
        <Button
          variant={selected ? "ghost" : "secondary"}
          size="sm"
          disabled={selected}
          onClick={() => layout.select(engine)}
        >
          {t(selected ? "reader.engine.showing" : "reader.engine.show")}
        </Button>
      </div>
    );
  else if (view.state === "failed" && view.noSource)
    body = <p className={styles.reason}>{t("reader.layout.noSource")}</p>;
  else if (!ready) body = <Missing layout={layout} engine={engine} />;
  else
    body = (
      <>
        {view.state === "failed" && (
          <p className={styles.reason}>
            {view.job?.error || t("reader.layout.failed")}
          </p>
        )}
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="sm"
            loading={layout.busy}
            disabled={!layout.hasModel}
            onClick={() => layout.start(engine)}
          >
            {t(
              view.state === "failed"
                ? "common.retry"
                : `reader.engine.${engine}.start`,
            )}
          </Button>
        </div>
      </>
    );

  const status =
    view.state === "running"
      ? t("reader.engine.state.running")
      : view.state === "done"
        ? t("reader.engine.state.done")
        : view.state === "failed"
          ? t("reader.engine.state.failed")
          : view.supported
            ? t("reader.engine.state.idle")
            : "";

  return (
    <section
      className={styles.method}
      aria-label={name}
      data-engine={engine}
      data-state={view.state}
      data-selected={selected ? "" : undefined}
    >
      <header className={styles.methodHead}>
        <h3 className={styles.methodName}>{name}</h3>
        {status && <span className={styles.status}>{status}</span>}
      </header>
      {body}
    </section>
  );
}

/**
 * What the paper area shows in the translated view while the chosen method has
 * no translated PDF: the two ways to translate the whole paper side by side,
 * each with what it does, how it is going (not started, running with progress,
 * done, failed with the reason and a retry), and a button the person presses.
 * Nothing starts by itself — a run costs model calls.
 */
export function LayoutPanel({ layout }: { layout: Layout }) {
  const { t } = useI18n();

  if (layout.loading)
    return (
      <div
        className={styles.panel}
        role="status"
        aria-label={t("reader.layout.checking")}
      >
        <Spinner />
      </div>
    );

  return (
    <section className={styles.panel} aria-label={t("reader.layout.region")}>
      <div className={styles.inner}>
        <h2 className={styles.title}>{t("reader.engine.title")}</h2>

        {!layout.hasModel && (
          <p className={styles.note}>
            {t("reader.layout.noModel")}{" "}
            <a className={styles.link} href="#customize/models">
              {t("reader.layout.toSettings")}
            </a>
          </p>
        )}
        <div className={styles.methods}>
          {ENGINES.map((engine) => (
            <Method key={engine} layout={layout} engine={engine} />
          ))}
        </div>
        {layout.error && (
          <p className={styles.error} role="alert">
            {layout.error}
          </p>
        )}
      </div>
    </section>
  );
}
