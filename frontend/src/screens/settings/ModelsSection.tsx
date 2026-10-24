import {
  FileUp,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, Dialog, IconButton, Menu, TextField, toast } from "../../ui";
import { ModelForm } from "../setup/ModelForm";
import {
  allowsLocal,
  announceModels,
  failure,
  readModels,
  removeModel,
  renameModel,
  selectModel,
  testModel,
  type ModelRow,
  type ModelSettings,
} from "../setup/model-api";
import { ImportModels } from "./ImportModels";
import { hostOf } from "./providers";
import { ConfirmDialog } from "./Section";
import { CustomizeHeader } from "../customize/CustomizeHeader";
import styles from "../customize/CustomizeScreen.module.css";

const displayName = (row: ModelRow) => row.name || row.model;

/** The models: the current one, the others (use, test, remove), and adding one with the setup's form. */
export function ModelsSection() {
  const i18n = useI18n();
  const { t, tn } = i18n;
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [returnTo] = useState(() =>
    new URLSearchParams(window.location.hash.split("?")[1]).get("returnTo"),
  );
  const [adding, setAdding] = useState(!!returnTo);
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<ModelRow | null>(null);
  const [newName, setNewName] = useState("");
  const [removing, setRemoving] = useState<ModelRow | null>(null);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");

  const load = (signal?: AbortSignal) =>
    readModels(signal).then(
      (value) => {
        setSettings(value);
        setLoadError("");
      },
      (reason) => {
        if (!signal?.aborted)
          setLoadError(failure(reason, i18n, "settings.loadError"));
      },
    );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // Read once; later changes come back from the requests themselves.
  }, []);

  /** Runs one action on a model; the row shows it as busy until it is done. */
  async function act(
    row: ModelRow,
    work: () => Promise<ModelSettings | void>,
    done: string,
    fallback: Parameters<typeof failure>[2],
  ) {
    setBusy(row.id);
    try {
      const value = await work();
      if (value) {
        setSettings(value);
        announceModels();
      }
      toast.show({ tone: "success", message: done });
      return true;
    } catch (reason) {
      toast.show({ tone: "error", message: failure(reason, i18n, fallback) });
      return false;
    } finally {
      setBusy("");
    }
  }

  const q = query.trim().toLowerCase();
  const models = (settings?.models ?? []).filter((row) =>
    `${displayName(row)} ${row.model} ${hostOf(row.base_url)}`
      .toLowerCase()
      .includes(q),
  );
  return (
    <>
      <CustomizeHeader
        title={t("customize.models")}
        query={query}
        onQuery={setQuery}
        action={
          <>
            <Menu
              label={t("reader.more.menu")}
              items={[
                {
                  id: "import",
                  icon: FileUp,
                  label: t("settings.models.import"),
                  onSelect: () => setImporting(true),
                },
              ]}
              trigger={(props) => (
                <IconButton
                  {...props}
                  icon={MoreHorizontal}
                  label={t("reader.more.menu")}
                />
              )}
            />
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => setAdding(true)}
            >
              {t("settings.models.add")}
            </Button>
          </>
        }
      />
      {loadError ? (
        <div role="alert">
          <p>{loadError}</p>
          <Button onClick={() => void load()}>{t("common.retry")}</Button>
        </div>
      ) : !settings ? (
        <div
          className={styles.skeleton}
          role="status"
          aria-label={t("common.loading")}
        />
      ) : (
        <ul className={styles.list} aria-label={t("customize.models")}>
          {models.map((row) => {
            const current = row.id === settings.active_id;
            const name = displayName(row);
            return (
              <li key={row.id} className={styles.row}>
                <Sparkles className={styles.icon} size={22} aria-hidden />
                <div className={styles.rowText}>
                  <span className={styles.name}>{name}</span>
                  <span className={styles.status}>
                    {[
                      t(
                        current
                          ? "settings.models.current"
                          : row.shared
                            ? "settings.models.shared"
                            : "customize.available",
                      ),
                      hostOf(row.base_url),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Menu
                  label={t("customize.more", { name })}
                  placement={{ side: "bottom", align: "end" }}
                  items={[
                    ...(!current
                      ? [
                          {
                            id: "use",
                            label: t("settings.models.use"),
                            disabled: !!busy,
                            onSelect: () => {
                              void act(
                                row,
                                () => selectModel(row.id),
                                t("settings.models.selected", { name }),
                                "settings.models.selectError",
                              );
                            },
                          },
                        ]
                      : []),
                    ...(!row.shared
                      ? [
                          {
                            id: "test",
                            icon: Plug,
                            label: t("settings.models.test"),
                            disabled: !!busy,
                            onSelect: () => {
                              void act(
                                row,
                                async () => {
                                  await testModel(row.id);
                                },
                                t("settings.models.testOk", { name }),
                                "model.error.test",
                              );
                            },
                          },
                          {
                            id: "rename",
                            icon: Pencil,
                            label: t("settings.models.renameTitle"),
                            disabled: !!busy,
                            onSelect: () => {
                              setNewName(name);
                              setRenaming(row);
                            },
                          },
                          {
                            id: "remove",
                            icon: Trash2,
                            label: t("settings.models.removeConfirm"),
                            danger: true,
                            disabled: !!busy,
                            onSelect: () => setRemoving(row),
                          },
                        ]
                      : []),
                  ]}
                  trigger={(props) => (
                    <IconButton
                      {...props}
                      icon={MoreHorizontal}
                      disabled={!!busy}
                      label={t("customize.more", { name })}
                    />
                  )}
                />
              </li>
            );
          })}
          {!models.length && (
            <li className={styles.empty}>{t("customize.empty")}</li>
          )}
        </ul>
      )}
      <ImportModels
        open={importing}
        onClose={() => setImporting(false)}
        settings={settings}
        local={allowsLocal(settings)}
        onImported={(next, count) => {
          setSettings(next);
          announceModels();
          toast.show({
            tone: "success",
            message: tn("settings.import.done", count),
          });
          if (returnTo && next.models.length) window.location.hash = returnTo;
        }}
      />
      <Dialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={t("settings.models.renameTitle")}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={() => setRenaming(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!newName.trim() || !!busy}
              type="submit"
              form="rename-model-form"
            >
              {t("settings.models.renameSave")}
            </Button>
          </>
        }
      >
        <form
          id="rename-model-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!renaming || !newName.trim() || busy) return;
            const row = renaming;
            const name = newName.trim();
            if (
              await act(
                row,
                () => renameModel(row, name),
                t("settings.models.renamed", { name }),
                "settings.models.renameError",
              )
            )
              setRenaming(null);
          }}
        >
          <TextField
            label={t("settings.models.renameLabel")}
            value={newName}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setNewName(event.target.value)}
          />
        </form>
      </Dialog>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t("settings.models.dialog")}
      >
        {adding && (
          <ModelForm
            compact
            onCancel={() => setAdding(false)}
            local={allowsLocal(settings)}
            onConnected={({ settings: next, model }) => {
              setSettings(next);
              setAdding(false);
              toast.show({
                tone: "success",
                message: t("settings.models.added", { name: model }),
              });
              if (returnTo) window.location.hash = returnTo;
            }}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        title={t("settings.models.removeTitle")}
        confirm={t("settings.models.removeConfirm")}
        busy={!!removing && busy === removing.id}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const row = removing;
          const ok = await act(
            row,
            () => removeModel(row.id),
            t("settings.models.removed", { name: displayName(row) }),
            "settings.models.removeError",
          );
          if (ok) setRemoving(null);
        }}
      />
    </>
  );
}
