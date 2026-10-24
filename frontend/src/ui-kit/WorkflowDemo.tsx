import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../i18n/I18nProvider";
import { WorkflowView } from "../screens/team/workflow/WorkflowView";
import type {
  WorkflowNodeTarget,
  WorkflowRuntime,
} from "../screens/team/workflow/workflow-model";
import { applyTheme } from "../ui";
import "../ui/reset.css";
import {
  researchWorkflowFixture,
  researchWorkflowMembers,
  workflowChannels,
  workflowFixture,
  workflowMembers,
} from "./workflow-fixture";

function WorkflowDemo() {
  const research =
    new URLSearchParams(location.search).get("fixture") === "research";
  const [workflow, setWorkflow] = useState(() => {
    const workflow = structuredClone(
      research ? researchWorkflowFixture : workflowFixture,
    );
    const params = new URLSearchParams(location.search);
    if (params.get("layout") === "auto") {
      workflow.layout = { members: {}, channels: {} };
      for (const rule of workflow.rules) delete rule.position;
    }
    if (params.has("parallel")) {
      workflow.rules.push({
        ...structuredClone(workflow.rules[0]),
        id: "parallel",
      });
      workflow.rules.push({
        ...structuredClone(workflow.rules[0]),
        id: "wake",
        then: { action: "wake", member: "reviewer" },
      });
    }
    return workflow;
  });
  const [opened, setOpened] = useState<WorkflowNodeTarget | null>(null);
  const [runtime, setRuntime] = useState<WorkflowRuntime>({
    members: { executor: "working", reviewer: "waiting" },
    fired: [],
  });
  useEffect(() => {
    const update = (event: Event) =>
      setRuntime((event as CustomEvent<WorkflowRuntime>).detail);
    window.addEventListener("ora-workflow-runtime", update);
    return () => window.removeEventListener("ora-workflow-runtime", update);
  }, []);
  return (
    <>
      <WorkflowView
        workflow={workflow}
        members={research ? researchWorkflowMembers : workflowMembers}
        channels={workflowChannels}
        onChange={setWorkflow}
        runtime={runtime}
        onOpenNode={setOpened}
      />
      <output hidden data-testid="workflow-state">
        {JSON.stringify(workflow)}
      </output>
      <output hidden data-testid="workflow-opened">
        {JSON.stringify(opened)}
      </output>
    </>
  );
}

// This entry is served by Vite only; no product route imports it.
if (import.meta.env.DEV) {
  const params = new URLSearchParams(location.search);
  applyTheme(params.get("theme") === "dark" ? "dark" : "light");
  createRoot(document.getElementById("root")!).render(
    <I18nProvider locale={params.get("locale") === "zh" ? "zh" : "en"}>
      <WorkflowDemo />
    </I18nProvider>,
  );
}
