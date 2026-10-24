import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey, Translator } from "../../i18n/i18n";
import { Button, Floating } from "../../ui";
import { MemberAvatar } from "../team/MemberEditor";
import { memberName } from "../team/member-model";
import { readModels, type ModelRow } from "../setup/model-api";
import { shortDuration, target, type RunStep } from "./process/model";
import {
  readMember,
  settingsHash,
  teamHash,
  type MemberDetail,
  type Team,
  type TeamMember,
} from "./team-api";
import { TeamFileCard } from "./TeamSidePanel";
import { TeamFilePreview } from "./TeamFilePreview";
import styles from "./TeamColleagues.module.css";

export function colleagueStatus(
  member: TeamMember,
  { t, tn }: Pick<Translator, "t" | "tn">,
) {
  if (member.enabled === false) return t("members.disabled");
  if (member.status === "queued")
    return tn("team.colleague.ahead", member.queue_ahead ?? 0);
  if (member.status !== "working") return t(`team.status.${member.status}`);
  return t("team.colleague.working", {
    task: member.status_text || colleagueTask(member.current_step, t),
    elapsed: shortDuration(member.elapsed_seconds ?? 0, t),
  });
}

export function colleagueTask(
  step: RunStep | null | undefined,
  t: Translator["t"],
) {
  const labels: Record<string, MessageKey> = {
    bash: "team.colleague.run",
    read: "team.colleague.read",
    write: "team.colleague.write",
    edit: "team.colleague.edit",
    grep: "team.colleague.search",
    find: "team.colleague.search",
    ls: "team.colleague.read",
    web_read: "team.colleague.read",
    read_paper: "team.colleague.read",
    run_job: "team.colleague.run",
    team_send_message: "team.colleague.message",
    team_wait_for_owner: "team.colleague.decide",
  };
  return step
    ? [
        labels[step.name] ? t(labels[step.name]) : stepLabel(step, t),
        target(step),
      ]
        .filter(Boolean)
        .join(" ")
    : t("team.colleague.thinking");
}

function stepLabel(step: RunStep, t: Translator["t"]) {
  const key = `research.tool.${step.name}` as MessageKey;
  return t(key) || step.name;
}

export function ColleagueStatus({ member }: { member: TeamMember }) {
  const i18n = useI18n();
  return (
    <span className={styles.status} title={colleagueStatus(member, i18n)}>
      {colleagueStatus(member, i18n)}
    </span>
  );
}

export function TeamMemberCard({
  team,
  member,
  children,
  className,
  onFile,
  heading = false,
}: {
  team: Team;
  member: TeamMember;
  children: ReactNode;
  className?: string;
  onFile?(path: string): void;
  heading?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [error, setError] = useState("");
  const [file, setFile] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clicked = useRef(false);
  const id = useId();
  const name = memberName(member, t);
  const close = (focus = false) => {
    clearTimeout(timer.current);
    setOpen(false);
    clicked.current = false;
    if (focus) anchor.current?.focus();
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    readMember(team.workspace_id, member.id).then(
      (value) => {
        if (!stale) {
          setDetail(value);
          setError("");
        }
      },
      (reason: unknown) => {
        if (!stale) setError(String(reason));
      },
    );
    readModels().then(
      (value) => {
        if (!stale) {
          setModels(value.models);
          setDefaultModel(value.active_id || value.models[0]?.id || "");
        }
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [open, team.workspace_id, member.id]);
  const modelId =
    member.effective_model_config_id || member.model_config_id || defaultModel;
  const model =
    member.active_model ||
    models.find((item) => item.id === modelId)?.model ||
    modelId;
  const dm = team.channels.find((channel) => channel.member_id === member.id);
  const leave = () => {
    if (!clicked.current) timer.current = setTimeout(() => close(), 150);
  };
  const trigger = (
    <button
      ref={anchor}
      type="button"
      className={`${styles.trigger} ${className || ""}`}
      aria-label={t("team.colleague.card", { name })}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onMouseEnter={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setOpen(true), 300);
      }}
      onMouseLeave={leave}
      onClick={() => {
        clearTimeout(timer.current);
        clicked.current = true;
        setOpen(true);
        requestAnimationFrame(() =>
          layer.current?.querySelector<HTMLButtonElement>("button")?.focus(),
        );
      }}
    >
      {children}
    </button>
  );
  return (
    <>
      {heading ? <h1 aria-label={name}>{trigger}</h1> : trigger}
      <Floating
        open={open}
        anchor={anchor.current}
        ignore={anchor.current}
        id={id}
        ref={layer}
        onDismiss={(reason) => close(reason === "escape")}
        className={styles.card}
      >
        <div
          role="dialog"
          onMouseEnter={() => clearTimeout(timer.current)}
          onMouseLeave={leave}
          aria-label={name}
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              !anchor.current?.contains(event.relatedTarget)
            )
              close();
          }}
        >
          <header>
            <MemberAvatar member={member} size="lg" />
            <strong>{name}</strong>
          </header>
          {member.description && <p>{member.description}</p>}
          {model && <p>{model}</p>}
          <div className={styles.tools}>
            {member.tools?.map((tool) => (
              <span key={tool}>
                {t(`members.tool.${tool}` as MessageKey) || tool}
              </span>
            ))}
          </div>
          <ColleagueStatus member={member} />
          {!!detail?.recent_files?.length && (
            <section aria-label={t("team.colleague.recentFiles")}>
              <h3>{t("team.colleague.recentFiles")}</h3>
              {detail.recent_files.map((item) => (
                <TeamFileCard
                  key={item.path}
                  file={item}
                  onFile={(path) => {
                    close();
                    onFile ? onFile(path) : setFile(path);
                  }}
                />
              ))}
            </section>
          )}
          {error && <p role="alert">{error}</p>}
          <footer>
            {dm && (
              <Button
                variant="secondary"
                onClick={() => {
                  close();
                  window.location.hash = teamHash(team.workspace_id, dm.id);
                }}
              >
                {t("team.colleague.send")}
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                close();
                window.location.hash = settingsHash(
                  team.workspace_id,
                  `member:${member.id}`,
                );
              }}
            >
              {t("team.colleague.details")}
            </Button>
          </footer>
        </div>
      </Floating>
      {file && (
        <Floating
          open
          anchor={anchor.current}
          onDismiss={() => setFile("")}
          className={styles.preview}
        >
          <TeamFilePreview
            workspace={team.workspace_id}
            path={file}
            onClose={() => setFile("")}
          />
        </Floating>
      )}
    </>
  );
}
