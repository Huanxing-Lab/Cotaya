// ImprovementQueue（CT-08）：Program 详情里的改进队列（候选）。
// 展示规则（E-23）：状态/理由/目标路径/实施 Cycle 可追踪；done 只代表通过三阶段验证的
// 事实（服务端 done 门把关，这里只呈现）；不能把 Run completed 当验收通过。
import {
  TID_CONTINUOUS_IMPROVEMENT_ITEM,
  TID_CONTINUOUS_IMPROVEMENT_QUEUE,
  testId,
  type ContinuousCandidateView,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { continuousCandidateStatusLabel } from "@/settings/continuous/continuousFormat.js";

export interface ImprovementQueueProps {
  candidates: ContinuousCandidateView[];
  /** 候选 → 实施 Cycle 行（历史审计入口）。 */
  onOpenCycleRun?: (cycleId: string) => void;
}

export function ImprovementQueue({ candidates, onOpenCycleRun }: ImprovementQueueProps) {
  const { intl } = useZCodeIntl();
  return (
    <section
      data-testid={TID_CONTINUOUS_IMPROVEMENT_QUEUE}
      aria-labelledby="continuous-improvement-queue-title"
      className="flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3
          id="continuous-improvement-queue-title"
          className="text-ui-base font-medium text-foreground"
        >
          {intl.formatMessage({ id: "continuous.improvements.title" })}
        </h3>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "continuous.improvements.count" },
            { count: String(candidates.length) },
          )}
        </span>
      </div>
      {candidates.length === 0 ? (
        <div className="rounded-lg border border-card-border bg-background px-3 py-2 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "continuous.improvements.empty" })}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <li
              key={candidate.candidateId}
              data-testid={testId(TID_CONTINUOUS_IMPROVEMENT_ITEM, candidate.candidateId)}
              className="flex flex-col gap-1 rounded-lg border border-card-border bg-background p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-ui-base font-medium leading-5 text-foreground">
                  {candidate.title}
                </span>
                {/* 状态用文字表达（E-22）；risk 另列，不与状态混同。 */}
                <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
                  {continuousCandidateStatusLabel(intl.formatMessage, candidate.status)}
                </span>
              </div>
              <p className="text-wrap-phrase text-ui-sm leading-5 text-foreground-subtle">
                {candidate.rationale}
              </p>
              <p className="font-mono text-ui-sm leading-5 text-foreground-subtlest">
                {candidate.targetPaths.join(", ")}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
                <span>
                  {intl.formatMessage({ id: "continuous.improvements.risk" })}：
                  {intl.formatMessage({ id: `continuous.risk.${candidate.risk}` })}
                </span>
                {candidate.executionCycleId ? (
                  onOpenCycleRun ? (
                    <button
                      type="button"
                      className="rounded-md px-1 underline underline-offset-2 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={() => onOpenCycleRun(candidate.executionCycleId ?? "")}
                    >
                      {intl.formatMessage({ id: "continuous.improvements.implementedIn" })}
                    </button>
                  ) : (
                    <span>
                      {intl.formatMessage({ id: "continuous.improvements.implementedIn" })}
                    </span>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
