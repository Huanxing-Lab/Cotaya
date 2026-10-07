// DecisionQueue（CT-08）：Program 详情里的产品决策队列。
// 核心展示规则：pending 数量与执行状态分开（Decision 不暂停 Program，E-23）；回答携带
// version（旧 version 拒绝、重复回答幂等，E-06/E-32）；resolve 只影响未来 Cycle，
// dismiss 不授权实施（§8）。历史（resolved/dismissed）折叠加原因。
import { useState } from "react";
import {
  TID_CONTINUOUS_DECISION_DISMISS,
  TID_CONTINUOUS_DECISION_ITEM,
  TID_CONTINUOUS_DECISION_OPTION,
  TID_CONTINUOUS_DECISION_QUEUE,
  TID_CONTINUOUS_DECISION_RESOLVE,
  TID_CONTINUOUS_DECISION_TEXT,
  testId,
  type ContinuousDecisionView,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { continuousDecisionStatusLabel } from "@/settings/continuous/continuousFormat.js";

export interface DecisionQueueProps {
  decisions: ContinuousDecisionView[];
  busy: boolean;
  onResolve: (
    decision: ContinuousDecisionView,
    optionId: string | undefined,
    text: string | undefined,
  ) => void;
  onDismiss: (decision: ContinuousDecisionView) => void;
}

export function DecisionQueue({ decisions, busy, onResolve, onDismiss }: DecisionQueueProps) {
  const { intl } = useZCodeIntl();
  const pending = decisions.filter((decision) => decision.status === "pending");
  const settled = decisions.filter((decision) => decision.status !== "pending");

  return (
    <section
      data-testid={TID_CONTINUOUS_DECISION_QUEUE}
      aria-labelledby="continuous-decision-queue-title"
      className="flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3
          id="continuous-decision-queue-title"
          className="text-ui-base font-medium text-foreground"
        >
          {intl.formatMessage({ id: "continuous.decisions.title" })}
        </h3>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "continuous.decisions.pendingCount" },
            { count: String(pending.length) },
          )}
        </span>
      </div>
      <p className="text-ui-sm leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "continuous.decisions.note" })}
      </p>

      {pending.length === 0 ? (
        <div className="rounded-lg border border-card-border bg-background px-3 py-2 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "continuous.decisions.empty" })}
        </div>
      ) : (
        pending.map((decision) => (
          <DecisionRow
            key={decision.decisionId}
            decision={decision}
            busy={busy}
            onResolve={onResolve}
            onDismiss={onDismiss}
          />
        ))
      )}

      {settled.length > 0 ? (
        <details className="rounded-lg border border-card-border bg-background px-3 py-2">
          <summary className="cursor-pointer text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "continuous.decisions.history" },
              { count: String(settled.length) },
            )}
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {settled.map((decision) => (
              <li
                key={decision.decisionId}
                data-testid={testId(TID_CONTINUOUS_DECISION_ITEM, decision.decisionId)}
                className="flex flex-col gap-0.5 text-ui-sm leading-5"
              >
                <span className="font-medium text-foreground">{decision.title}</span>
                <span className="text-foreground-subtle">
                  {continuousDecisionStatusLabel(intl.formatMessage, decision.status)}
                  {decision.resolution?.optionId
                    ? ` · ${decision.resolution.optionId}`
                    : decision.resolution?.text
                      ? ` · ${decision.resolution.text}`
                      : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function DecisionRow({
  decision,
  busy,
  onResolve,
  onDismiss,
}: {
  decision: ContinuousDecisionView;
  busy: boolean;
  onResolve: (
    decision: ContinuousDecisionView,
    optionId: string | undefined,
    text: string | undefined,
  ) => void;
  onDismiss: (decision: ContinuousDecisionView) => void;
}) {
  const { intl } = useZCodeIntl();
  const [selectedOption, setSelectedOption] = useState<string | null>(
    decision.recommendation ?? null,
  );
  const [text, setText] = useState("");

  return (
    <article
      data-testid={testId(TID_CONTINUOUS_DECISION_ITEM, decision.decisionId)}
      className="flex flex-col gap-2 rounded-lg border border-card-border bg-background p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-ui-base font-medium leading-5 text-foreground">{decision.title}</h4>
        <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
          {decision.classification === "blocking"
            ? intl.formatMessage({ id: "continuous.decisions.blocking" })
            : intl.formatMessage({ id: "continuous.decisions.deferred" })}
        </span>
      </div>
      <p className="text-wrap-phrase text-ui-base leading-5 text-foreground-subtle">
        {decision.context}
      </p>
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={decision.title}>
        {decision.options.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 text-ui-base text-foreground focus-within:ring-2 focus-within:ring-input-border-focused"
          >
            <input
              type="radio"
              name={`continuous-decision-${decision.decisionId}`}
              data-testid={testId(TID_CONTINUOUS_DECISION_OPTION, option.id)}
              checked={selectedOption === option.id}
              onChange={() => setSelectedOption(option.id)}
              className="mt-1 size-4"
            />
            <span className="flex flex-col">
              <span className="font-medium">
                {option.label}
                {decision.recommendation === option.id
                  ? `（${intl.formatMessage({ id: "continuous.decisions.recommended" })}）`
                  : ""}
              </span>
              <span className="text-ui-sm text-foreground-subtle">{option.consequences}</span>
            </span>
          </label>
        ))}
      </div>
      <Input
        data-testid={testId(TID_CONTINUOUS_DECISION_TEXT, decision.decisionId)}
        aria-label={intl.formatMessage({ id: "continuous.decisions.customAnswer" })}
        className="h-8"
        value={text}
        placeholder={intl.formatMessage({ id: "continuous.decisions.customAnswerPlaceholder" })}
        onChange={(event) => setText(event.target.value)}
      />
      {decision.blockingScope ? (
        <p className="text-ui-sm leading-5 text-foreground-subtlest">
          {intl.formatMessage({ id: "continuous.decisions.scope" })}：
          {decision.blockingScope.paths.length > 0
            ? decision.blockingScope.paths.join(", ")
            : decision.blockingScope.candidateIds.length > 0
              ? intl.formatMessage({ id: "continuous.decisions.scopeCandidates" })
              : "—"}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid={testId(TID_CONTINUOUS_DECISION_RESOLVE, decision.decisionId)}
          disabled={busy || (selectedOption === null && text.trim().length === 0)}
          onClick={() => onResolve(decision, selectedOption ?? undefined, text)}
        >
          {intl.formatMessage({ id: "continuous.decisions.resolve" })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={testId(TID_CONTINUOUS_DECISION_DISMISS, decision.decisionId)}
          disabled={busy}
          onClick={() => onDismiss(decision)}
        >
          {intl.formatMessage({ id: "continuous.decisions.dismiss" })}
        </Button>
      </div>
    </article>
  );
}
