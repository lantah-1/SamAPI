import { useState } from "react";
import { normalizeDownstreamModelRules, validateModelRuleTargets } from "../../../shared/model-rules";
import { DownstreamModelRulesEditor } from "../DownstreamModelRulesEditor";
import { SettingsFormDialog } from "./SettingsDialog";
import type { SettingsPageProps } from "./types";

export function ModelMappingSettingsDialog(props: SettingsPageProps) {
  const [rules, setRules] = useState(() => structuredClone(props.snapshot.settings.downstreamModelRules || []));
  return (
    <SettingsFormDialog
      title="下游模型映射"
      description="先选供应商，再选可用模型。按客户端或项目自上而下匹配，第一条命中的规则生效。"
      wide busy={props.busy} onClose={props.onClose} saveLabel="保存映射"
      onSubmit={async () => {
        const downstreamModelRules = normalizeDownstreamModelRules(rules);
        validateModelRuleTargets(downstreamModelRules, props.snapshot);
        await props.onSave({ downstreamModelRules });
      }}
    >
      <DownstreamModelRulesEditor
        embedded rules={rules} routes={props.snapshot.routes} sites={props.snapshot.sites}
        providerApiKeyGroups={props.snapshot.providerApiKeyGroups} temporaryAccountGroups={props.snapshot.temporaryAccountGroups} headerTemplates={props.snapshot.headerTemplates} disabled={props.busy}
        error="" onChange={setRules}
      />
    </SettingsFormDialog>
  );
}
