// Continuous（长期自主改进）相关的测试 id（CT-08）。
// E2E 用 accessibility 与稳定 test id 定位，不靠翻译文本或像素坐标（docs/testing/
// continuous.md §9）。沿用 test-ids.ts / test-ids-workflow.ts 的拆分先例：
// 每族一个文件、仍从 @zcode/shared 桶文件导出，消费方 import 路径不变。
// 动态元素用 testId(base, suffix) 组合（如卡片后缀 programId）。

// 顶级页签（AutomationsPageTitleSwitch 的第三个 tab；值 = "continuous"）
export const TID_CONTINUOUS_PAGE_TAB = "automations-page-tab";
export const TID_CONTINUOUS_PAGE_TAB_VALUE = "continuous";

// Continuous 主区
export const TID_CONTINUOUS_SECTION = "continuous-section";
export const TID_CONTINUOUS_UNSUPPORTED = "continuous-unsupported";
export const TID_CONTINUOUS_PROGRAM_LIST = "continuous-program-list";
export const TID_CONTINUOUS_PROGRAM_CARD = "continuous-program-card";
export const TID_CONTINUOUS_CREATE_OPEN = "continuous-create-open";
export const TID_CONTINUOUS_CREATE_FORM = "continuous-create-form";
export const TID_CONTINUOUS_FORM_GOAL = "continuous-form-goal";
export const TID_CONTINUOUS_FORM_SCOPE_PATHS = "continuous-form-scope-paths";
export const TID_CONTINUOUS_FORM_DAILY_BUDGET = "continuous-form-daily-budget";
export const TID_CONTINUOUS_FORM_DAILY_UNLIMITED = "continuous-form-daily-unlimited";
export const TID_CONTINUOUS_FORM_CYCLE_BUDGET = "continuous-form-cycle-budget";
export const TID_CONTINUOUS_FORM_TOKENS = "continuous-form-tokens";
export const TID_CONTINUOUS_FORM_CONCURRENCY = "continuous-form-concurrency";
export const TID_CONTINUOUS_FORM_ACTIVE_HOURS = "continuous-form-active-hours";
export const TID_CONTINUOUS_FORM_CADENCE_KIND = "continuous-form-cadence-kind";
export const TID_CONTINUOUS_FORM_SUBMIT = "continuous-form-submit";
export const TID_CONTINUOUS_FORM_BACK = "continuous-form-back";

// Program 详情
export const TID_CONTINUOUS_DETAIL = "continuous-detail";
export const TID_CONTINUOUS_DETAIL_STATUS = "continuous-detail-status";
export const TID_CONTINUOUS_DETAIL_BACK = "continuous-detail-back";
export const TID_CONTINUOUS_RUN_NOW = "continuous-run-now";
export const TID_CONTINUOUS_PAUSE = "continuous-pause";
export const TID_CONTINUOUS_RESUME = "continuous-resume";
export const TID_CONTINUOUS_STOP_CURRENT = "continuous-stop-current";
export const TID_CONTINUOUS_CYCLE_ROW = "continuous-cycle-row";
export const TID_CONTINUOUS_OPEN_RUN = "continuous-open-run";

// Decision Queue（回答/驳回都带 version；E-04/E-06/E-07 的落点）
export const TID_CONTINUOUS_DECISION_QUEUE = "continuous-decision-queue";
export const TID_CONTINUOUS_DECISION_ITEM = "continuous-decision-item";
export const TID_CONTINUOUS_DECISION_OPTION = "continuous-decision-option";
export const TID_CONTINUOUS_DECISION_TEXT = "continuous-decision-text";
export const TID_CONTINUOUS_DECISION_RESOLVE = "continuous-decision-resolve";
export const TID_CONTINUOUS_DECISION_DISMISS = "continuous-decision-dismiss";

// Improvement Queue（E-23 历史可追踪）
export const TID_CONTINUOUS_IMPROVEMENT_QUEUE = "continuous-improvement-queue";
export const TID_CONTINUOUS_IMPROVEMENT_ITEM = "continuous-improvement-item";

// 资源继续确认（AskUserQuestion 形态；E-08/E-30/E-32 的落点）
export const TID_CONTINUOUS_CONTINUATION_DIALOG = "continuous-continuation-dialog";
export const TID_CONTINUOUS_CONTINUATION_FACTS = "continuous-continuation-facts";
export const TID_CONTINUOUS_CONTINUATION_GRANT = "continuous-continuation-grant";
export const TID_CONTINUOUS_CONTINUATION_ADJUST = "continuous-continuation-adjust";
export const TID_CONTINUOUS_CONTINUATION_STAY = "continuous-continuation-stay";
export const TID_CONTINUOUS_CONTINUATION_END = "continuous-continuation-end";
