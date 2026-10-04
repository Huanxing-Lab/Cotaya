import { useCallback, type KeyboardEvent } from "react";
import { TID_AUTOMATIONS_PAGE_TAB, TID_CONTINUOUS_PAGE_TAB_VALUE, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 自动化页的顶级标签：自动化 / 工作流 / Continuous（第三个，CT-08）。 */
export type AutomationsPageTab = "automation" | "workflow" | "continuous";

const BASE_AUTOMATIONS_PAGE_TABS: readonly AutomationsPageTab[] = ["automation", "workflow"];

/**
 * 自动化页的标题。动态工作流灰度未命中时
 * 页面只有「自动化」一件事，标题就退回引入「工作流」标签之前的那个平铺 h1——不留一个只有
 * 一项的 tablist，也不把方向键切换留在原地。
 */
export function AutomationsPageTitle({
  workflowTabEnabled,
  continuousTabEnabled = false,
  value,
  onValueChange,
}: {
  workflowTabEnabled: boolean;
  /** Continuous 服务在场才长出第三个标题词（服务缺席 = 功能默认关闭，tab 整体隐藏）。 */
  continuousTabEnabled?: boolean;
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!workflowTabEnabled && !continuousTabEnabled) {
    // 字号与切换态同源：30/34 页面标题层级，切换在不在场不该改变标题的视觉层级。
    return (
      <h1 className="text-[30px] font-medium leading-[34px] tracking-[0.114px] text-foreground">
        {intl.formatMessage({ id: "settings.automations.title" })}
      </h1>
    );
  }
  return (
    <AutomationsPageTitleSwitch
      workflowTabEnabled={workflowTabEnabled}
      continuousTabEnabled={continuousTabEnabled}
      value={value}
      onValueChange={onValueChange}
    />
  );
}

/**
 * 页标题本身就是切换：「自动化 / 工作流 / Continuous」几个 30px 标题词并排，未选中的用次级色。
 * 不在标题下再长一排标签——定时任务 / 闲时任务的胶囊行留在「自动化」内部，两级各用一种视觉。
 * 字号沿用 AutomationsSection 原 h1 的标题层级。
 */
export function AutomationsPageTitleSwitch({
  workflowTabEnabled = true,
  continuousTabEnabled = false,
  value,
  onValueChange,
}: {
  workflowTabEnabled?: boolean;
  continuousTabEnabled?: boolean;
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  const tabs: readonly AutomationsPageTab[] = [
    ...BASE_AUTOMATIONS_PAGE_TABS.filter((tab) => tab !== "workflow" || workflowTabEnabled),
    ...(continuousTabEnabled ? [TID_CONTINUOUS_PAGE_TAB_VALUE as AutomationsPageTab] : []),
  ];
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = tabs.indexOf(value);
      const next =
        tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      if (next !== undefined) onValueChange(next);
    },
    [onValueChange, tabs, value],
  );

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "automations.pageTab.ariaLabel" })}
      className="flex items-baseline gap-5"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-testid={testId(TID_AUTOMATIONS_PAGE_TAB, tab)}
            onClick={() => onValueChange(tab)}
            className={cn(
              "rounded-md text-[30px] font-medium leading-[34px] tracking-[0.114px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              active ? "text-foreground" : "text-foreground-subtle hover:text-foreground",
            )}
          >
            {intl.formatMessage({ id: `automations.pageTab.${tab}` })}
          </button>
        );
      })}
    </div>
  );
}
