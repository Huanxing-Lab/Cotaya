// ContinuousProgramForm（CT-08）：创建 Program 的授权整页。
// 默认值 = 规格产品常量（并发 10、tokens 10 亿、单轮 USD100、每日 USD1,000、有效执行
// 1 小时；§2）——表单不自带第二套默认值，从 @zcode/shared 常量取（E-34：未来模板不得
// 恢复旧默认值）。授权即绑定：Goal/Scope/Budget/Cadence/模板 hash 首次落库后，改前四者
// 需要重新授权（§6）；表单只做本地校验，权威校验在服务端。
import { useMemo, useState, type ReactNode } from "react";
import {
  CONTINUOUS_DEFAULT_BUDGET,
  CONTINUOUS_DEFAULT_CADENCE,
  TID_CONTINUOUS_FORM_ACTIVE_HOURS,
  TID_CONTINUOUS_FORM_BACK,
  TID_CONTINUOUS_FORM_CADENCE_KIND,
  TID_CONTINUOUS_FORM_CONCURRENCY,
  TID_CONTINUOUS_FORM_SUBMIT,
  TID_CONTINUOUS_CREATE_FORM,
  TID_CONTINUOUS_FORM_CYCLE_BUDGET,
  TID_CONTINUOUS_FORM_DAILY_BUDGET,
  TID_CONTINUOUS_FORM_DAILY_UNLIMITED,
  TID_CONTINUOUS_FORM_GOAL,
  TID_CONTINUOUS_FORM_SCOPE_PATHS,
  TID_CONTINUOUS_FORM_TOKENS,
  type ContinuousTemplateRef,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  describeContinuousCadence,
  inputToPositiveInt,
  inputToUsdMicros,
  usdMicrosToInput,
} from "@/settings/continuous/continuousFormat.js";
import type { ContinuousCommandFailure, ContinuousProgramDraft } from "@/hooks/useContinuous.js";

interface ContinuousProgramFormProps {
  templates: ContinuousTemplateRef[];
  busy: boolean;
  failure: ContinuousCommandFailure | null;
  onBack: () => void;
  onSubmit: (draft: ContinuousProgramDraft) => void;
}

interface FormState {
  goal: string;
  allowedPaths: string;
  forbiddenPaths: string;
  dailyBudget: string;
  dailyUnlimited: boolean;
  cycleBudget: string;
  tokens: string;
  concurrency: string;
  activeHours: string;
  cadenceKind: "interval" | "daily";
  intervalHours: string;
  dailyTime: string;
}

/** 表单初值：USD 字段以美元显示（存储/传输用微美元整数）；整数字段直显。 */
const initialFormState = (): FormState => ({
  goal: "",
  allowedPaths: "packages/ui/src",
  forbiddenPaths: "",
  dailyBudget: usdMicrosToInput(CONTINUOUS_DEFAULT_BUDGET.dailyCostUsdMicros ?? 0),
  dailyUnlimited: false,
  cycleBudget: usdMicrosToInput(CONTINUOUS_DEFAULT_BUDGET.perCycleCostUsdMicros),
  tokens: String(CONTINUOUS_DEFAULT_BUDGET.perCycleTokens),
  concurrency: String(CONTINUOUS_DEFAULT_BUDGET.maxConcurrentActors),
  activeHours: String(CONTINUOUS_DEFAULT_BUDGET.activeExecutionLimitMs / 3_600_000),
  cadenceKind: "interval",
  intervalHours: String(
    CONTINUOUS_DEFAULT_CADENCE.kind === "interval"
      ? CONTINUOUS_DEFAULT_CADENCE.hoursAfterCycleEnd
      : 6,
  ),
  dailyTime: "09:00",
});

function parseLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 数值字段的标准形态（label + input + 可选尾随控件）；减少五处同构 JSX 的重复。 */
function NumberField({
  label,
  testId,
  value,
  onChange,
  disabled = false,
  extra = null,
}: {
  label: string;
  testId?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const input = (
    <Input
      className="h-8"
      type="number"
      min="1"
      step="1"
      inputMode="decimal"
      {...(testId === undefined ? {} : { "data-testid": testId })}
      aria-label={label}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {extra === null ? (
        input
      ) : (
        <div className="flex items-center gap-2">
          {input}
          {extra}
        </div>
      )}
    </div>
  );
}

export function ContinuousProgramForm({
  templates,
  busy,
  failure,
  onBack,
  onSubmit,
}: ContinuousProgramFormProps) {
  const { intl } = useZCodeIntl();
  const [form, setForm] = useState<FormState>(initialFormState);
  const [validationError, setValidationError] = useState<string | null>(null);
  const template = templates[0];

  const cadencePreview = useMemo(() => {
    if (form.cadenceKind === "daily") {
      return describeContinuousCadence(intl.formatMessage, {
        kind: "daily",
        localTime: form.dailyTime,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    }
    const hours = inputToPositiveInt(form.intervalHours);
    return hours
      ? describeContinuousCadence(intl.formatMessage, {
          kind: "interval",
          hoursAfterCycleEnd: hours,
        })
      : intl.formatMessage({ id: "continuous.form.cadenceInvalid" });
  }, [form.cadenceKind, form.dailyTime, form.intervalHours, intl]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const handleSubmit = () => {
    if (!template) {
      setValidationError(intl.formatMessage({ id: "continuous.form.templateUnavailable" }));
      return;
    }
    const goal = form.goal.trim();
    if (goal.length === 0) {
      setValidationError(intl.formatMessage({ id: "continuous.form.goalRequired" }));
      return;
    }
    const allowedPaths = parseLines(form.allowedPaths);
    if (allowedPaths.length === 0) {
      setValidationError(intl.formatMessage({ id: "continuous.form.scopeRequired" }));
      return;
    }
    // Unlimited 只取消每日额度；单轮费用必须是正的有限值（§2）。
    const dailyCostUsdMicros = form.dailyUnlimited ? null : inputToUsdMicros(form.dailyBudget);
    const perCycleCostUsdMicros = inputToUsdMicros(form.cycleBudget);
    const perCycleTokens = inputToPositiveInt(form.tokens);
    const maxConcurrentActors = inputToPositiveInt(form.concurrency);
    const activeHours = inputToPositiveInt(form.activeHours);
    if (
      (!form.dailyUnlimited && dailyCostUsdMicros === null) ||
      perCycleCostUsdMicros === null ||
      perCycleTokens === null ||
      maxConcurrentActors === null ||
      activeHours === null
    ) {
      setValidationError(intl.formatMessage({ id: "continuous.form.invalidNumbers" }));
      return;
    }
    let cadence: ContinuousProgramDraft["cadence"];
    if (form.cadenceKind === "daily") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.dailyTime)) {
        setValidationError(intl.formatMessage({ id: "continuous.form.cadenceInvalid" }));
        return;
      }
      cadence = {
        kind: "daily",
        localTime: form.dailyTime,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    } else {
      const hours = inputToPositiveInt(form.intervalHours);
      if (hours === null) {
        setValidationError(intl.formatMessage({ id: "continuous.form.cadenceInvalid" }));
        return;
      }
      cadence = { kind: "interval", hoursAfterCycleEnd: hours };
    }
    setValidationError(null);
    onSubmit({
      goal,
      allowedPaths,
      forbiddenPaths: parseLines(form.forbiddenPaths),
      dailyCostUsdMicros,
      budget: {
        ...CONTINUOUS_DEFAULT_BUDGET,
        ...(dailyCostUsdMicros === null ? {} : { dailyCostUsdMicros }),
        perCycleCostUsdMicros,
        perCycleTokens,
        maxConcurrentActors,
        activeExecutionLimitMs: activeHours * 3_600_000,
      },
      cadence,
      template,
    });
  };

  return (
    <div data-testid={TID_CONTINUOUS_CREATE_FORM} className="flex flex-col">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={TID_CONTINUOUS_FORM_BACK}
          onClick={onBack}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <h1 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "continuous.form.title" })}
        </h1>
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <Label htmlFor="continuous-form-goal">
            {intl.formatMessage({ id: "continuous.form.goal" })}
          </Label>
          <textarea
            id="continuous-form-goal"
            data-testid={TID_CONTINUOUS_FORM_GOAL}
            className="min-h-[72px] w-full resize-y rounded-md border border-input-border bg-background px-2 py-1.5 text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            value={form.goal}
            aria-required="true"
            onChange={(event) => setField("goal", event.target.value)}
            placeholder={intl.formatMessage({ id: "continuous.form.goalPlaceholder" })}
          />
        </section>

        <section className="flex flex-col gap-2">
          <Label htmlFor="continuous-form-scope">
            {intl.formatMessage({ id: "continuous.form.scope" })}
          </Label>
          <textarea
            id="continuous-form-scope"
            data-testid={TID_CONTINUOUS_FORM_SCOPE_PATHS}
            className="min-h-[56px] w-full resize-y rounded-md border border-input-border bg-background px-2 py-1.5 font-mono text-ui-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            value={form.allowedPaths}
            aria-describedby="continuous-form-scope-hint"
            onChange={(event) => setField("allowedPaths", event.target.value)}
          />
          <p id="continuous-form-scope-hint" className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "continuous.form.scopeHint" })}
          </p>
          <Label htmlFor="continuous-form-forbidden">
            {intl.formatMessage({ id: "continuous.form.forbidden" })}
          </Label>
          <textarea
            id="continuous-form-forbidden"
            className="min-h-[40px] w-full resize-y rounded-md border border-input-border bg-background px-2 py-1.5 font-mono text-ui-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            value={form.forbiddenPaths}
            onChange={(event) => setField("forbiddenPaths", event.target.value)}
          />
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "continuous.form.forbiddenCapabilities" })}
          </p>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label={intl.formatMessage({ id: "continuous.form.dailyBudget" })}
            testId={TID_CONTINUOUS_FORM_DAILY_BUDGET}
            value={form.dailyUnlimited ? "" : form.dailyBudget}
            disabled={form.dailyUnlimited}
            onChange={(value) => setField("dailyBudget", value)}
            extra={
              <label className="flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
                <input
                  type="checkbox"
                  data-testid={TID_CONTINUOUS_FORM_DAILY_UNLIMITED}
                  checked={form.dailyUnlimited}
                  onChange={(event) => setField("dailyUnlimited", event.target.checked)}
                  className="size-4"
                />
                {intl.formatMessage({ id: "continuous.form.dailyUnlimited" })}
              </label>
            }
          />
          <NumberField
            label={intl.formatMessage({ id: "continuous.form.cycleBudget" })}
            testId={TID_CONTINUOUS_FORM_CYCLE_BUDGET}
            value={form.cycleBudget}
            onChange={(value) => setField("cycleBudget", value)}
          />
          <NumberField
            label={intl.formatMessage({ id: "continuous.form.tokens" })}
            testId={TID_CONTINUOUS_FORM_TOKENS}
            value={form.tokens}
            onChange={(value) => setField("tokens", value)}
          />
          <NumberField
            label={intl.formatMessage({ id: "continuous.form.concurrency" })}
            testId={TID_CONTINUOUS_FORM_CONCURRENCY}
            value={form.concurrency}
            onChange={(value) => setField("concurrency", value)}
          />
          <NumberField
            label={intl.formatMessage({ id: "continuous.form.activeHours" })}
            testId={TID_CONTINUOUS_FORM_ACTIVE_HOURS}
            value={form.activeHours}
            onChange={(value) => setField("activeHours", value)}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="continuous-form-cadence-kind">
              {intl.formatMessage({ id: "continuous.form.cadence" })}
            </Label>
            <select
              id="continuous-form-cadence-kind"
              data-testid={TID_CONTINUOUS_FORM_CADENCE_KIND}
              className="h-8 rounded-md border border-input-border bg-background px-2 text-ui-base text-foreground"
              value={form.cadenceKind}
              onChange={(event) =>
                setField("cadenceKind", event.target.value === "daily" ? "daily" : "interval")
              }
            >
              <option value="interval">
                {intl.formatMessage({ id: "continuous.form.cadence.interval" })}
              </option>
              <option value="daily">
                {intl.formatMessage({ id: "continuous.form.cadence.daily" })}
              </option>
            </select>
            {form.cadenceKind === "interval" ? (
              <Input
                aria-label={intl.formatMessage({ id: "continuous.form.cadence.intervalHours" })}
                className="h-8"
                type="number"
                min="1"
                step="1"
                value={form.intervalHours}
                onChange={(event) => setField("intervalHours", event.target.value)}
              />
            ) : (
              <Input
                aria-label={intl.formatMessage({ id: "continuous.form.cadence.dailyTime" })}
                className="h-8"
                type="time"
                value={form.dailyTime}
                onChange={(event) => setField("dailyTime", event.target.value)}
              />
            )}
            <p className="text-ui-sm text-foreground-subtle">{cadencePreview}</p>
          </div>
        </section>

        <section className="flex flex-col gap-1 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-sm leading-5 text-foreground-subtle">
          <p>
            {intl.formatMessage({ id: "continuous.form.template" })}：
            {template ? `${template.templateId}@${template.templateVersion}` : "—"}
          </p>
          <p>{intl.formatMessage({ id: "continuous.form.authorizationNote" })}</p>
        </section>

        {validationError ? (
          <p role="alert" className="text-ui-base text-destructive">
            {validationError}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-ui-base text-destructive">
            {intl.formatMessage({ id: "continuous.command.failed" })}（{failure.code}）：
            {failure.message}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            data-testid={TID_CONTINUOUS_FORM_SUBMIT}
            disabled={busy || !template}
            onClick={handleSubmit}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            {intl.formatMessage({ id: "continuous.form.submit" })}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
