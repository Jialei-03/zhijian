import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { Button, toast } from "../../ui";
import {
  editTeamMember,
  refreshTeam,
  type TeamMember,
} from "../research/team-api";

export function MemberPause({
  workspace,
  member,
}: {
  workspace: string;
  member: TeamMember;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await editTeamMember(workspace, member.id, {
            paused: !member.paused,
          });
          refreshTeam();
        } catch (reason) {
          toast.show({ message: String(reason), tone: "error" });
        } finally {
          setBusy(false);
        }
      }}
    >
      {t(member.paused ? "members.resume" : "members.pause")}
    </Button>
  );
}
