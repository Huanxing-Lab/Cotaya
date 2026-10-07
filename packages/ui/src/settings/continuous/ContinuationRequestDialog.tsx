// ContinuationRequestDialog（CT-08）：资源继续确认的 AskUserQuestion 形态（§6.1）。
// 与产品 Decision Queue 分开：资源确认暂停所属 Cycle，不进决策队列。事实区显示
// 额度/增量/最近探活/等待原因/有效与墙钟时长（§12）；四选项与 §6.1 一一对应：
//   1) 增加本轮额度/时间并继续（grant 是增量，不重置已消耗量）；
//   2) 调整长期默认配置并继续（只动预算/时长，不改变 Scope）；
//   3) 保持暂停（无默认超时同意）；
//   4) 结束本轮（明确用户取消后结算 cancelled，保留已验证提交）。
import { useMemo, useState } from "react";
import {
  TID_CONTINUOUS_CONTINUATION_ADJUST,
  TID_CONTINUOUS_CONTINUATION_DIALOG,
  TID_CONTINUOUS_CONTINUATION_END,
  TID_CONTINUOUS_CONTINUATION_FACTS,
  TID_CONTINUOUS_CONTINUATION_GRANT,
  TID_CONTINUOUS_CONTINUATION_STAY,
  type ContinuousContinuationAnswer,
  type ContinuousContinuationView,
  type ContinuousCycleView,
  type ContinuousProgramDetailResult,
} from "@zcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  continuousContinuationReasonLabel,
  continuousHealthLabel,
  continuousLimitKindLabel,
  formatContinuousDuration,
  formatContinuousUsdMicros,
  inputToPositiveInt,
  inputToUsdMicros,
  usdMicrosToInput,
} from "@/settings/continuous/continuousFormat.js";

export interface ContinuationRequestDialogProps {
  open: boolean;
  request: ContinuousContinuationView;
  currentCycle: ContinuousCycleView | null;
  detail: ContinuousProgramDetailResult;
  busy: boolean;
  onAnswer: (answer: ContinuousContinuationAnswer) => void;
}

/** 推荐增量（表单初值）：受影响上限 + 一份保守增量；用户可改（不强制）。 */
function recommendedGrantDefaults(
  request: ContinuousContinuationView,
  detail: ContinuousProgramDetailResult,
): { cost: string; tokens: string; hours: string } {
  const budget = detail.program.budget;
  const kind = request.limitKind;
  return {
    cost: kind === "cost" ? usdMicrosToInput(budget.perCycleCostUsdMicros) : "",
    tokens: kind === "token" ? String(budget.perCycleTokens) : "",
    hours: kind === "time" ? String(budget.activeExecutionLimitMs / 3_600_000) : "",
  };
}

export function ContinuationRequestDialog({
  open,
  request,
  currentCycle,
  detail,
  busy,
  onAnswer,
}: ContinuationRequestDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const defaults = useMemo(() => recommendedGrantDefaults(request, detail), [detail, request]);
  const [grantCost, setGrantCost] = useState(defaults.cost);
  const [grantTokens, setGrantTokens] = useState(defaults.tokens);
  const [grantHours, setGrantHours] = useState(defaults.hours);
  const [adjustDaily, setAdjustDaily] = useState<string>(
    detail.program.budget.dailyCostUsdMicros === null
      ? ""
      : usdMicrosToInput(detail.program.budget.dailyCostUsdMicros),
  );
  const [adjustCycle, setAdjustCycle] = useState(
    usdMicrosToInput(detail.program.budget.perCycleCostUsdMicros),
  );
  const [adjustActiveHours, setAdjustActiveHours] = useState(
    String(detail.program.budget.activeExecutionLimitMs / 3_600_000),
  );

  const usage = detail.cycleUsage;
  const wallClockMs =
    currentCycle?.startedAt !== undefined && currentCycle.startedAt !== null
      ? Math.max(0, (currentCycle.completedAt ?? Date.now()) - currentCycle.startedAt)
      : null;

  const buildGrant = ():
    | { ok: true; costMicros?: number; tokens?: number; activeDurationMs?: number }
    | { ok: false } => {
    const cost = grantCost.trim().length === 0 ? undefined : inputToUsdMicros(grantCost);
    const tokens = grantTokens.trim().length === 0 ? undefined : inputToPositiveInt(grantTokens);
    const hours = grantHours.trim().length === 0 ? undefined : inputToPositiveInt(grantHours);
    if (cost === null || tokens === null || hours === null) return { ok: false };
    return {
      ok: true,
      ...(cost === undefined ? {} : { costMicros: cost }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(hours === undefined ? {} : { activeDurationMs: hours * 3_600_000 }),
    };
  };

  const handleGrant = () => {
    const grant = buildGrant();
    if (
      !grant.ok ||
      (grant.costMicros === undefined &&
        grant.tokens === undefined &&
        grant.activeDurationMs === undefined)
    ) {
      return;
    }
    onAnswer({ kind: "continue_with_grant", grant });
  };

  const handleAdjust = () => {
    const grant = buildGrant();
    if (!grant.ok) return;
    const cycleMicros = inputToUsdMicros(adjustCycle);
    const dailyMicros = adjustDaily.trim().length === 0 ? null : inputToUsdMicros(adjustDaily);
    const activeHours = inputToPositiveInt(adjustActiveHours);
    if (cycleMicros === null || dailyMicros === null || activeHours === null) return;
    onAnswer({
      kind: "adjust_config_and_continue",
      grant,
      configAdjustment: {
        perCycleCostUsdMicros: cycleMicros,
        ...(dailyMicros === null ? {} : { dailyCostUsdMicros: dailyMicros }),
        activeExecutionLimitMs: activeHours * 3_600_000,
      },
    });
  };

  return (
    <Dialog open={open}>
      <DialogContent
        data-testid={TID_CONTINUOUS_CONTINUATION_DIALOG}
        aria-describedby="continuous-continuation-description"
        className="max-h-[85vh] w-[min(560px,calc(100vw-32px))] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "continuous.continuation.title" })}</DialogTitle>
          <DialogDescription id="continuous-continuation-description">
            {intl.formatMessage({ id: "continuous.continuation.description" })}
          </DialogDescription>
        </DialogHeader>

        {/* 事实区：额度/增量/最近探活/等待原因/有效与墙钟时长（§12）。数值全部来自服务快照。 */}
        <dl
          data-testid={TID_CONTINUOUS_CONTINUATION_FACTS}
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-sm leading-5"
        >
          <dt className="text-foreground-subtle">
            {intl.formatMessage({ id: "continuous.continuation.reasons" })}
          </dt>
          <dd className="text-foreground">
            {request.reasons
              .map((reason) => continuousContinuationReasonLabel(intl.formatMessage, reason))
              .join("、")}
          </dd>
          <dt className="text-foreground-subtle">
            {intl.formatMessage({ id: "continuous.continuation.limitKind" })}
          </dt>
          <dd className="text-foreground">
            {continuousLimitKindLabel(intl.formatMessage, request.limitKind)}
          </dd>
          {usage ? (
            <>
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "continuous.continuation.cycleUsage" })}
              </dt>
              <dd className="text-foreground">
                {formatContinuousUsdMicros(usage.settledCostMicros, locale)}（
                {intl.formatMessage({ id: "continuous.usage.settled" })}） ·{" "}
                {formatContinuousUsdMicros(usage.unsettledCostMicros, locale)}（
                {intl.formatMessage({ id: "continuous.usage.unsettled" })}）
              </dd>
            </>
          ) : null}
          <dt className="text-foreground-subtle">
            {intl.formatMessage({ id: "continuous.continuation.currentLimit" })}
          </dt>
          <dd className="text-foreground">{describeObserved(request.currentLimit, locale)}</dd>
          <dt className="text-foreground-subtle">
            {intl.formatMessage({ id: "continuous.continuation.recommendedExtension" })}
          </dt>
          <dd className="text-foreground">
            {describeObserved(request.recommendedExtension, locale)}
          </dd>
          {currentCycle ? (
            <>
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "continuous.continuation.lastProbe" })}
              </dt>
              <dd className="text-foreground">
                {currentCycle.lastProbeAt === null
                  ? "—"
                  : new Date(currentCycle.lastProbeAt).toLocaleString(locale)}
              </dd>
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "continuous.continuation.waitReason" })}
              </dt>
              <dd className="text-foreground">
                {continuousHealthLabel(intl.formatMessage, currentCycle.healthState)}
              </dd>
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "continuous.continuation.durations" })}
              </dt>
              <dd className="text-foreground">
                {intl.formatMessage(
                  { id: "continuous.continuation.activeVsWall" },
                  {
                    active: formatContinuousDuration(currentCycle.activeDurationMs),
                    wall: wallClockMs === null ? "—" : formatContinuousDuration(wallClockMs),
                    blocked: formatContinuousDuration(currentCycle.normalBlockedDurationMs),
                  },
                )}
              </dd>
            </>
          ) : null}
        </dl>

        <div className="flex flex-col gap-3">
          <section className="flex flex-col gap-2 rounded-lg border border-card-border px-3 py-2">
            <Label>{intl.formatMessage({ id: "continuous.continuation.grant" })}</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                aria-label={intl.formatMessage({ id: "continuous.continuation.grantCost" })}
                className="h-8"
                type="number"
                min="1"
                placeholder="USD"
                value={grantCost}
                onChange={(event) => setGrantCost(event.target.value)}
              />
              <Input
                aria-label={intl.formatMessage({ id: "continuous.continuation.grantTokens" })}
                className="h-8"
                type="number"
                min="1"
                placeholder="tokens"
                value={grantTokens}
                onChange={(event) => setGrantTokens(event.target.value)}
              />
              <Input
                aria-label={intl.formatMessage({ id: "continuous.continuation.grantHours" })}
                className="h-8"
                type="number"
                min="1"
                placeholder="h"
                value={grantHours}
                onChange={(event) => setGrantHours(event.target.value)}
              />
            </div>
            <Button
              type="button"
              size="sm"
              data-testid={TID_CONTINUOUS_CONTINUATION_GRANT}
              disabled={busy}
              onClick={handleGrant}
            >
              {intl.formatMessage({ id: "continuous.continuation.grantSubmit" })}
            </Button>
          </section>

          <details className="flex flex-col gap-2 rounded-lg border border-card-border px-3 py-2">
            <summary className="cursor-pointer text-ui-base text-foreground">
              {intl.formatMessage({ id: "continuous.continuation.adjust" })}
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                aria-label={intl.formatMessage({ id: "continuous.form.dailyBudget" })}
                className="h-8"
                type="number"
                min="1"
                placeholder="USD / day"
                value={adjustDaily}
                onChange={(event) => setAdjustDaily(event.target.value)}
              />
              <Input
                aria-label={intl.formatMessage({ id: "continuous.form.cycleBudget" })}
                className="h-8"
                type="number"
                min="1"
                placeholder="USD / cycle"
                value={adjustCycle}
                onChange={(event) => setAdjustCycle(event.target.value)}
              />
              <Input
                aria-label={intl.formatMessage({ id: "continuous.form.activeHours" })}
                className="h-8"
                type="number"
                min="1"
                placeholder="h"
                value={adjustActiveHours}
                onChange={(event) => setAdjustActiveHours(event.target.value)}
              />
            </div>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "continuous.continuation.adjustNote" })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid={TID_CONTINUOUS_CONTINUATION_ADJUST}
              disabled={busy}
              onClick={handleAdjust}
            >
              {intl.formatMessage({ id: "continuous.continuation.adjustSubmit" })}
            </Button>
          </details>

          <DialogFooter className="sm:justify-start">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={TID_CONTINUOUS_CONTINUATION_STAY}
              disabled={busy}
              onClick={() => onAnswer({ kind: "stay_paused" })}
            >
              {intl.formatMessage({ id: "continuous.continuation.stay" })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              data-testid={TID_CONTINUOUS_CONTINUATION_END}
              disabled={busy}
              onClick={() => onAnswer({ kind: "end_cycle" })}
            >
              {intl.formatMessage({ id: "continuous.continuation.end" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** observedUsage/currentLimit/recommendedExtension 是服务端的 JSON 快照（§5）：
 * 已知形状给可读格式，未知形状序列化展示，不编造语义。 */
function describeObserved(value: unknown, locale: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString(locale) : value.toString();
  }
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === "number" || typeof item === "string") parts.push(`${key}=${item}`);
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  return JSON.stringify(value);
}
