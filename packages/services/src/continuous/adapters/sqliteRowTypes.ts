// Continuous sqlite 行类型（CT-01）：列名与 continuous-schema.ts 一一对应。
// 独立成文件让 codecs 保持在仓库 lint 的 max-lines 上限内；仅类型，无运行时逻辑。

export interface ProgramRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  remote_session_id: string | null;
  revision: number;
  status: string;
  status_reason: string | null;
  config_json: string;
  authorization_json: string;
  template_id: string;
  template_version: string;
  template_hash: string;
  execution_path: string | null;
  branch_name: string | null;
  next_cycle_at: number | null;
  last_cycle_at: number | null;
  consecutive_failures: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CycleRow {
  id: string;
  program_id: string;
  sequence: number;
  trigger_key: string;
  trigger_json: string;
  status: string;
  config_snapshot_json: string;
  script_text: string;
  script_hash: string;
  execution_session_id: string;
  workflow_run_id: string;
  trace_id: string;
  lease_epoch: number;
  resume_attempts: number;
  active_duration_ms: number;
  normal_blocked_duration_ms: number;
  health_state: string;
  last_progress_at: number | null;
  last_probe_at: number | null;
  pending_continuation_request_id: string | null;
  report_cursor: number;
  base_commit: string | null;
  result_json: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CandidateRow {
  id: string;
  program_id: string;
  source_cycle_id: string;
  fingerprint: string;
  status: string;
  body_json: string;
  execution_cycle_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DecisionRow {
  id: string;
  program_id: string;
  source_cycle_id: string;
  fingerprint: string;
  version: number;
  status: string;
  body_json: string;
  resolution_json: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  id: number;
  program_id: string;
  cycle_id: string | null;
  event_key: string;
  type: string;
  payload_json: string;
  created_at: number;
}

export interface LeaseRow {
  workspace_key: string;
  cycle_id: string | null;
  owner_id: string | null;
  epoch: number;
  expires_at: number | null;
  updated_at: number;
}

export interface UsageRow {
  id: string;
  cycle_id: string;
  request_key: string;
  state: string;
  provider: string;
  model: string;
  pricing_version: string;
  usage_json: string | null;
  reserved_cost_micros: number;
  estimated_cost_micros: number | null;
  reserved_tokens: number;
  actual_tokens: number | null;
  occurred_at: number;
  updated_at: number;
}
