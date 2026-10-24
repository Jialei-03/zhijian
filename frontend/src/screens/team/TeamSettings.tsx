import { Members } from "./Members";
import { memberAvatarSeed, memberName } from "./member-model";
import { defaultChannelNames } from "../research/team-model";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/i18n";
import { Button, SegmentedControl, toast } from "../../ui";
import { ComparePanel } from "./compare/ComparePanel";
import { WorkflowView } from "./workflow/WorkflowView";
import type { Workflow, WorkflowMember } from "./workflow/workflow-model";
import { WorkflowPicker } from "../workflows/WorkflowPicker";
import { useResearchNavigation } from "../research/ResearchNavigation";
import {
  readWorkflowSnapshot,
  refreshTeam,
  saveTeamWorkflow,
  selectTeamWorkflow,
  settingsHash,
  teamHash,
  type Team,
} from "../research/team-api";
import styles from "./TeamSettings.module.css";
import { TeamBudgets } from "./TeamBudgets";

export const workflowMembers = (
  team: Team,
  name: (key: MessageKey) => string,
): WorkflowMember[] =>
  team.members.map((m) => ({
    id: m.id,
    name: memberName(m, name),
    avatar: m.avatar,
    avatar_url: m.avatar_url,
    avatar_seed: memberAvatarSeed(m),
    ...(m.enabled !== undefined
      ? { enabled: m.enabled && !m.deleted, subscriptions: m.subscriptions }
      : {}),
    kind: m.role === "human" ? "human" : "agent",
    role: m.role === "human" ? "owner" : m.role,
  }));

export function TeamSettings({
  team,
  target = "members",
  go,
}: {
  team: Team;
  target?: string;
  go(hash: string): void;
}) {
  const { t } = useI18n();
  const { data } = useResearchNavigation();
  const workspace = data.workspaces.find((w) => w.id === team.workspace_id);
  const [draft, setDraft] = useState<Workflow | undefined>(team.workflow);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const queue = useRef(Promise.resolve());
  const outstanding = useRef(0);
  const awaitingTeam = useRef<string | null>(null);
  const revision = useRef(team.workflow?.version || 1);
  const parts = target.split(":");
  const focusedRule =
    parts[0] === "rule" ? parts.slice(3).join(":") : undefined;
  const tab = focusedRule
    ? "workflow"
    : ["workflow", "compare", "budget"].includes(target)
      ? target
      : "members";
  const historical =
    !!focusedRule &&
    (parts[1] !== team.workflow?.id ||
      Number(parts[2]) !== team.workflow.version);
  useEffect(() => {
    if (saving || historical) return;
    const stamp = `${team.workflow?.id}:${team.workflow?.version}`;
    if (awaitingTeam.current && awaitingTeam.current !== stamp) return;
    awaitingTeam.current = null;
    setDraft(team.workflow);
    revision.current = team.workflow?.version || 1;
  }, [team.workflow?.id, team.workflow?.version, saving, historical]);
  useEffect(() => {
    if (!historical) return;
    let stale = false;
    readWorkflowSnapshot(team.workspace_id, parts[1], Number(parts[2])).then(
      (flow) => {
        if (!stale) {
          setDraft(flow);
          setError("");
        }
      },
      (reason: unknown) => !stale && setError(String(reason)),
    );
    return () => {
      stale = true;
    };
  }, [historical, target, team.workspace_id]);
  const change = (next: Workflow) => {
    if (historical) return;
    if (focusedRule) go(settingsHash(team.workspace_id, "workflow"));
    setDraft(next);
    setSaving(true);
    outstanding.current += 1;
    queue.current = queue.current
      .then(async () => {
        const saved = await saveTeamWorkflow(team.workspace_id, {
          ...next,
          version: revision.current,
        });
        revision.current = saved.version;
        awaitingTeam.current = `${saved.id}:${saved.version}`;
        if (outstanding.current === 1) setDraft(saved);
        setError("");
        refreshTeam();
      })
      .catch((reason: unknown) => {
        setError(String(reason));
        awaitingTeam.current = null;
        refreshTeam();
      })
      .finally(() => {
        outstanding.current -= 1;
        if (!outstanding.current) {
          setSaving(false);
          refreshTeam();
        }
      });
  };
  return (
    <section className={styles.page} aria-label={t("team.settings")}>
      <header className={styles.header}>
        <h1>{t("team.settings")}</h1>
        <SegmentedControl
          kind="radio"
          label={t("team.settings")}
          value={tab}
          onChange={(value) => go(settingsHash(team.workspace_id, value))}
          options={[
            { value: "members", label: t("team.members") },
            { value: "budget", label: t("team.budgets") },
            { value: "workflow", label: t("workflows.title") },
            { value: "compare", label: t("compare.title") },
          ]}
        />
      </header>
      {error && <p role="alert">{error}</p>}
      {tab === "budget" && <TeamBudgets key={team.workspace_id} team={team} />}
      {tab === "members" && (
        <Members
          team={team}
          selected={target.startsWith("member:") ? target.slice(7) : undefined}
          go={go}
        />
      )}
      {tab === "workflow" && (
        <>
          <div className={styles.toolbar}>
            <WorkflowPicker
              workspaceId={team.workspace_id}
              value={draft?.id || "research"}
              disabled={saving}
              onChange={async (id) => {
                try {
                  const flow = await selectTeamWorkflow(team.workspace_id, id);
                  setDraft(flow);
                  revision.current = flow.version;
                  awaitingTeam.current = `${flow.id}:${flow.version}`;
                  refreshTeam();
                  go(settingsHash(team.workspace_id, "workflow"));
                } catch (reason) {
                  toast.show({ message: String(reason), tone: "error" });
                }
              }}
            />
            {historical && (
              <Button
                variant="ghost"
                onClick={() => go(settingsHash(team.workspace_id, "workflow"))}
              >
                {t("team.currentWorkflow")}
              </Button>
            )}
          </div>
          {draft && (
            <WorkflowView
              hideTitle
              workflow={draft}
              members={workflowMembers(team, t)}
              channels={team.channels.map((c) => ({
                id: c.id,
                name:
                  defaultChannelNames[c.key] === c.name
                    ? t(`team.channel.${c.key}` as MessageKey)
                    : c.name,
                kind: c.member_id ? "dm" : "channel",
              }))}
              runtime={historical ? undefined : team.runtime}
              focusedRule={focusedRule}
              readOnly={historical}
              onChange={change}
              onOpenNode={(node) => {
                const channel =
                  node.kind === "channel"
                    ? node.id
                    : team.channels.find((c) => c.member_id === node.id)?.id;
                if (channel) go(teamHash(team.workspace_id, channel));
              }}
            />
          )}
        </>
      )}
      {tab === "compare" && (
        <ComparePanel
          workspaceId={team.workspace_id}
          researches={workspace?.researches || []}
          evaluation={workspace?.kind === "eval"}
          onOpenResearch={(id) =>
            go(
              teamHash(
                team.workspace_id,
                team.channels.find((c) => c.key === "experiments")?.id,
                `research:${id}`,
              ),
            )
          }
        />
      )}
    </section>
  );
}
