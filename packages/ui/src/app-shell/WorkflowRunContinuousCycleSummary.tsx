// Continuous Cycle 摘要（CT-08；规格 §3「复用 Run 展示，新增 Cycle 摘要」）。
// WorkflowRunSidePane.tsx / WorkflowRunSidePaneSections.tsx 都在 oxlint max-lines 门上，
// 这块新增展示放独立文件：managed cycle 的 run 不在会话内发起（toolCallId 为空串），
// 没有轮尾卡可回看——冻结摘要让详情页顶部保留 Cycle 事实（序号/状态/目标）。
// 状态用文字表达，不靠颜色（E-22）。
import { memo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ContinuousCycleSummary } from "@/lib/workspaceSidePane.js";

export const WorkflowRunContinuousCycleSummary = memo(function WorkflowRunContinuousCycleSummary({
  summary,
}: {
  summary: ContinuousCycleSummary;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section
      data-continuous-cycle-summary={summary.cycleId}
      aria-label={intl.formatMessage({ id: "workflowRun.continuousCycle.ariaLabel" })}
      className="mx-4 mt-3 flex flex-col gap-1 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-sm leading-5"
    >
      <span className="font-medium text-foreground">
        {intl.formatMessage(
          { id: "workflowRun.continuousCycle.title" },
          { sequence: String(summary.sequence) },
        )}
      </span>
      <span className="text-foreground-subtle">
        {intl.formatMessage({ id: "workflowRun.continuousCycle.status" })}：{summary.status}
      </span>
      <span className="text-wrap-phrase text-foreground-subtle">
        {intl.formatMessage({ id: "workflowRun.continuousCycle.programGoal" })}：
        {summary.programGoal}
      </span>
    </section>
  );
});
