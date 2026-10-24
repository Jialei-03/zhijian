import { useId, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import { Button, Dialog, TextArea, TextField } from "../../../ui";
import {
  MESSAGE_KINDS,
  RULE_ACTIONS,
  RULE_EVENTS,
  validateRule,
  type WorkflowChannel,
  type WorkflowMember,
  type WorkflowRule,
} from "./workflow-model";
import styles from "./Workflow.module.css";

export interface RuleEditorProps {
  rule: WorkflowRule;
  readOnly?: boolean;
  members: WorkflowMember[];
  channels: WorkflowChannel[];
  onSave(rule: WorkflowRule): void;
  onClose(): void;
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
}) {
  // Named by its label alone: wrapped, the chosen option would join the name.
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

export function RuleEditor({
  rule,
  readOnly = false,
  members,
  channels,
  onSave,
  onClose,
}: RuleEditorProps) {
  const { t } = useI18n();
  const formId = useId();
  const [draft, setDraft] = useState(() => structuredClone(rule));
  const [invalid, setInvalid] = useState(false);
  const when = (patch: Partial<WorkflowRule["when"]>) =>
    setDraft((value) => ({ ...value, when: { ...value.when, ...patch } }));
  const then = (patch: Partial<WorkflowRule["then"]>) =>
    setDraft((value) => ({ ...value, then: { ...value.then, ...patch } }));
  const roles = [...new Set(members.map((member) => member.role))];
  const referenceOptions = (selected: string) => (
    <>
      <option value="">{t("teamWorkflow.choose")}</option>
      {selected &&
        selected !== "subscribers" &&
        selected !== "m:$author" &&
        !members.some((member) => `m:${member.id}` === selected) &&
        !roles.some((role) => `r:${role}` === selected) && (
          <option value={selected}>{selected.slice(2)}</option>
        )}
      <optgroup label={t("teamWorkflow.members")}>
        {members.map((member) => (
          <option key={member.id} value={`m:${member.id}`}>
            {member.name}
          </option>
        ))}
      </optgroup>
      <optgroup label={t("teamWorkflow.role")}>
        {roles.map((role) => (
          <option key={role} value={`r:${role}`}>
            {members
              .filter((member) => member.role === role)
              .map((member) => member.name)
              .join(" / ")}
          </option>
        ))}
      </optgroup>
    </>
  );
  const reference = (member?: string, role?: string) =>
    member ? `m:${member}` : role ? `r:${role}` : "";
  const channelOptions = (selected?: string, any = false) => (
    <>
      <option value="">
        {t(any ? "teamWorkflow.anyChannel" : "teamWorkflow.choose")}
      </option>
      {selected && !channels.some((channel) => channel.id === selected) && (
        <option value={selected}>{selected}</option>
      )}
      {channels.map((channel) => (
        <option key={channel.id} value={channel.id}>
          {channel.kind === "channel" ? "#" : ""}
          {channel.name}
        </option>
      ))}
    </>
  );
  const author = reference(draft.when.from_member, draft.when.from_role);
  const recipient = draft.then.subscribers
    ? "subscribers"
    : reference(draft.then.member, draft.then.role);
  const returnTo = draft.then.on_fail
    ? reference(
        members.some((member) => member.id === draft.then.on_fail)
          ? draft.then.on_fail
          : undefined,
        draft.then.on_fail,
      )
    : "";
  return (
    <Dialog
      open
      title={t("teamWorkflow.edit")}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            disabled={readOnly}
            variant="primary"
            type="submit"
            form={formId}
          >
            {t("details.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!validateRule(draft)) {
            setInvalid(true);
            return;
          }
          onSave(draft);
        }}
      >
        <fieldset disabled={readOnly} className={styles.readonlyFields}>
          {invalid && (
            <p role="alert" className={styles.error}>
              {t("teamWorkflow.invalid")}
            </p>
          )}
          <SelectField
            label={t("teamWorkflow.event")}
            value={draft.when.event}
            onChange={(value) =>
              when({
                event: value as WorkflowRule["when"]["event"],
                cron:
                  value === "schedule"
                    ? (draft.when.cron ?? "0 9 * * *")
                    : undefined,
                timezone:
                  value === "schedule"
                    ? (draft.when.timezone ?? "UTC")
                    : undefined,
              })
            }
          >
            {RULE_EVENTS.map((event) => (
              <option key={event} value={event}>
                {t(`teamWorkflow.event.${event}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("teamWorkflow.channel")}
            value={draft.when.channel ?? ""}
            onChange={(channel) => when({ channel: channel || undefined })}
          >
            {channelOptions(draft.when.channel, true)}
          </SelectField>
          <SelectField
            label={t("teamWorkflow.fromMember")}
            value={author}
            onChange={(value) =>
              when({
                from_member: value.startsWith("m:")
                  ? value.slice(2)
                  : undefined,
                from_role: value.startsWith("r:") ? value.slice(2) : undefined,
              })
            }
          >
            {referenceOptions(author)}
          </SelectField>
          <SelectField
            label={t("teamWorkflow.messageKind")}
            value={draft.when.kind ?? ""}
            onChange={(value) =>
              when({
                kind: (value || undefined) as WorkflowRule["when"]["kind"],
              })
            }
          >
            <option value="">{t("teamWorkflow.anyKind")}</option>
            {MESSAGE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`teamWorkflow.kind.${kind}`)}
              </option>
            ))}
          </SelectField>
          {draft.when.event === "schedule" && (
            <>
              <TextField
                label={t("teamWorkflow.cron")}
                value={draft.when.cron ?? ""}
                required
                onChange={(event) => when({ cron: event.target.value })}
              />
              <TextField
                label={t("teamWorkflow.timezone")}
                value={draft.when.timezone ?? ""}
                required
                onChange={(event) => when({ timezone: event.target.value })}
              />
            </>
          )}
          <SelectField
            label={t("teamWorkflow.action")}
            value={draft.then.action}
            onChange={(value) => {
              const action = value as WorkflowRule["then"]["action"];
              setDraft((current) => ({
                ...current,
                then: {
                  action,
                  instruction: current.then.instruction,
                  ...(action === "wake" || action === "review"
                    ? { member: current.then.member, role: current.then.role }
                    : {}),
                  ...(action === "review"
                    ? {
                        on_fail:
                          current.then.on_fail ??
                          current.when.from_member ??
                          current.when.from_role,
                        max_rounds: current.then.max_rounds,
                      }
                    : {}),
                  ...(action === "post"
                    ? { channel: current.then.channel, text: current.then.text }
                    : {}),
                },
              }));
            }}
          >
            {RULE_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {t(`teamWorkflow.action.${action}`)}
              </option>
            ))}
          </SelectField>
          {(draft.then.action === "wake" || draft.then.action === "review") && (
            <SelectField
              label={t("teamWorkflow.member")}
              value={recipient}
              onChange={(value) =>
                then({
                  subscribers: value === "subscribers",
                  member: value.startsWith("m:") ? value.slice(2) : undefined,
                  role: value.startsWith("r:") ? value.slice(2) : undefined,
                })
              }
            >
              {["accepted", "changes_requested"].includes(draft.when.event) && (
                <option value="m:$author">
                  {t("teamWorkflow.originalAuthor")}
                </option>
              )}
              {draft.then.action === "wake" &&
                draft.when.event === "message" && (
                  <option value="subscribers">
                    {t("members.subscribers")}
                  </option>
                )}
              {referenceOptions(recipient)}
            </SelectField>
          )}
          {draft.then.action === "review" && (
            <>
              <SelectField
                label={t("teamWorkflow.onFail")}
                value={returnTo}
                onChange={(value) =>
                  then({ on_fail: value.slice(2) || undefined })
                }
              >
                {referenceOptions(returnTo)}
              </SelectField>
              <TextField
                type="number"
                min={0}
                step={1}
                label={t("teamWorkflow.rounds")}
                placeholder={t("team.unlimited")}
                value={draft.then.max_rounds || ""}
                onChange={(event) =>
                  then({ max_rounds: Number(event.target.value) })
                }
              />
            </>
          )}
          {draft.then.action === "post" && (
            <>
              <SelectField
                label={t("teamWorkflow.channel")}
                value={draft.then.channel ?? ""}
                onChange={(channel) => then({ channel: channel || undefined })}
              >
                {channelOptions(draft.then.channel)}
              </SelectField>
              <TextArea
                label={t("teamWorkflow.text")}
                value={draft.then.text ?? ""}
                required
                rows={2}
                onChange={(event) => then({ text: event.target.value })}
              />
            </>
          )}
          <TextArea
            label={t("teamWorkflow.instruction")}
            value={draft.then.instruction ?? ""}
            rows={2}
            onChange={(event) => then({ instruction: event.target.value })}
          />
          <TextField
            type="number"
            min={0}
            step={1}
            label={t("teamWorkflow.limit")}
            placeholder={t("team.unlimited")}
            value={draft.limit?.per_thread || ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                limit: { per_thread: Number(event.target.value) },
              })
            }
          />
        </fieldset>
      </form>
    </Dialog>
  );
}
