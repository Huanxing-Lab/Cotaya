// 0004 Continuous 长期状态表（规格 docs/specs/continuous.md §5）。
// 与既有 DWF journal（另一数据库）解耦：workflow_run_id 只是受控软引用，不声明跨库 FK。
// 发布后本声明保持冻结：checksum 进入 tasks_schema_migration 账本，后续变更新增 migration。
export const CONTINUOUS_SCHEMA = `
      CREATE TABLE IF NOT EXISTS continuous_program (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        remote_session_id TEXT,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','sleeping','paused','failed','completed')),
        status_reason TEXT,
        config_json TEXT NOT NULL,
        authorization_json TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_version TEXT NOT NULL,
        template_hash TEXT NOT NULL,
        execution_path TEXT,
        branch_name TEXT,
        next_cycle_at INTEGER,
        last_cycle_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS continuous_cycle (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL REFERENCES continuous_program(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL,
        trigger_key TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'preparing','running','settling','interrupted','suspended','completed','failed','cancelled'
        )),
        config_snapshot_json TEXT NOT NULL,
        script_text TEXT NOT NULL,
        script_hash TEXT NOT NULL,
        execution_session_id TEXT NOT NULL,
        workflow_run_id TEXT NOT NULL UNIQUE,
        trace_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        resume_attempts INTEGER NOT NULL DEFAULT 0,
        active_duration_ms INTEGER NOT NULL DEFAULT 0,
        normal_blocked_duration_ms INTEGER NOT NULL DEFAULT 0,
        health_state TEXT NOT NULL DEFAULT 'progressing'
          CHECK (health_state IN ('progressing','normal_wait','suspected_hang','unreachable')),
        last_progress_at INTEGER,
        last_probe_at INTEGER,
        pending_continuation_request_id TEXT,
        report_cursor INTEGER NOT NULL DEFAULT 0,
        base_commit TEXT,
        result_json TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (program_id, sequence),
        UNIQUE (program_id, trigger_key),
        UNIQUE (program_id, id)
      );

      CREATE TABLE IF NOT EXISTS continuous_candidate (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL REFERENCES continuous_program(id) ON DELETE RESTRICT,
        source_cycle_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'candidate','queued','implementing','done','rejected','deferred'
        )),
        body_json TEXT NOT NULL,
        execution_cycle_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (program_id, fingerprint),
        UNIQUE (program_id, id),
        FOREIGN KEY (program_id, source_cycle_id)
          REFERENCES continuous_cycle (program_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (program_id, execution_cycle_id)
          REFERENCES continuous_cycle (program_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS continuous_decision (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL REFERENCES continuous_program(id) ON DELETE RESTRICT,
        source_cycle_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','resolved','dismissed')),
        body_json TEXT NOT NULL,
        resolution_json TEXT,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (program_id, fingerprint),
        UNIQUE (program_id, id),
        FOREIGN KEY (program_id, source_cycle_id)
          REFERENCES continuous_cycle (program_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS continuous_candidate_decision (
        program_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        PRIMARY KEY (candidate_id, decision_id),
        FOREIGN KEY (program_id, candidate_id)
          REFERENCES continuous_candidate (program_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (program_id, decision_id)
          REFERENCES continuous_decision (program_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS continuous_usage (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES continuous_cycle(id) ON DELETE RESTRICT,
        request_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('reserved','settled','unknown')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        usage_json TEXT,
        reserved_cost_micros INTEGER NOT NULL,
        estimated_cost_micros INTEGER,
        reserved_tokens INTEGER NOT NULL,
        actual_tokens INTEGER,
        occurred_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS continuous_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id TEXT NOT NULL REFERENCES continuous_program(id) ON DELETE RESTRICT,
        cycle_id TEXT REFERENCES continuous_cycle(id) ON DELETE RESTRICT,
        event_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS continuous_workspace_lease (
        workspace_key TEXT PRIMARY KEY,
        cycle_id TEXT UNIQUE REFERENCES continuous_cycle(id) ON DELETE RESTRICT,
        owner_id TEXT,
        epoch INTEGER NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK (
          (cycle_id IS NULL AND owner_id IS NULL AND expires_at IS NULL)
          OR (cycle_id IS NOT NULL AND owner_id IS NOT NULL AND expires_at IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS continuous_continuation_request (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','resolved')),
        request_json TEXT NOT NULL,
        resolution_json TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (program_id, cycle_id)
          REFERENCES continuous_cycle (program_id, id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS continuous_one_open_cycle
      ON continuous_cycle (program_id)
      WHERE status IN ('preparing', 'running', 'settling', 'interrupted', 'suspended');

      CREATE INDEX IF NOT EXISTS continuous_due_program
      ON continuous_program (status, next_cycle_at)
      WHERE archived_at IS NULL;

      CREATE INDEX IF NOT EXISTS continuous_candidate_queue
      ON continuous_candidate (program_id, status);

      CREATE INDEX IF NOT EXISTS continuous_decision_queue
      ON continuous_decision (program_id, status);

      CREATE INDEX IF NOT EXISTS continuous_usage_period
      ON continuous_usage (occurred_at, cycle_id);

      CREATE INDEX IF NOT EXISTS continuous_event_history
      ON continuous_event (program_id, id);

      CREATE UNIQUE INDEX IF NOT EXISTS continuous_one_pending_continuation
      ON continuous_continuation_request (cycle_id)
      WHERE status = 'pending';
    `;
