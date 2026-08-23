use super::*;

/// Run mode for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Keep session context between executions
    SingleSession,
    /// Create new session for each execution (no memory)
    NewSession,
}

/// Task status (simplified: only Running and Stopped)
/// Stopped includes: manual stop, end conditions met, AI exit
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Task is running and will execute at intervals
    Running,
    /// Task was stopped (includes: manual stop, end conditions met, AI exit)
    Stopped,
}

/// End conditions for a cron task
///
/// `skip_serializing_if = "Option::is_none"` on the optional fields is
/// load-bearing: without it, Rust serializes `None` as JSON `null`, and the
/// renderer's modal init code (`CronTaskSettingsModal::endCondInit`) checks
/// `ec.maxExecutions !== undefined` to decide whether the task has end
/// conditions. `null !== undefined` is `true` in JS, so a "永久运行" task
/// (deadline=None, max_executions=None, ai_can_exit=false) would round-trip
/// through Rust as `{deadline: null, maxExecutions: null, aiCanExit: false}`
/// and the modal would mistakenly display "条件停止 + 执行次数 10". Skipping
/// the None fields keeps the JSON shape aligned with TS optional convention
/// (omit the property → `undefined` in the consumer).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EndConditions {
    /// Task will stop after this time (ISO timestamp)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<DateTime<Utc>>,
    /// Task will stop after this many executions
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    /// Allow AI to exit the task via ExitCronTask tool
    pub ai_can_exit: bool,
}

/// Read-only credential shape found in historical `cron_tasks.json` rows.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens_param_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_format: Option<String>,
}

/// Historical provider intent. Startup migration maps safe identity into
/// TaskStore; frozen Explicit credentials are never copied. The compatibility
/// create facade accepts Subscription as a provider identity sentinel and
/// rejects Explicit snapshots.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderIntent {
    /// Legacy default for rows created before provider identity was explicit.
    #[default]
    FollowAgent,
    /// Explicitly use Anthropic subscription. Ignores `provider_env`.
    Subscription,
    /// Historical frozen credential intent; new writes reject it.
    Explicit,
}

/// Delivery target for IM Bot cron task results
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDelivery {
    pub bot_id: String,
    pub chat_id: String,
    pub platform: String,
}

/// Optional catch-up window for interval schedules.
///
/// When an anchored recurring task misses its planned fire time, the scheduler
/// uses this window to run in the next permitted wall-clock window instead of
/// either firing immediately outside the window or skipping a full interval.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecurringWindow {
    pub timezone: String,
    pub start: String,
    pub end: String,
}

/// Flexible schedule types for cron tasks (v0.1.21)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CronSchedule {
    /// One-shot: execute at a specific time, then stop
    At { at: String },
    /// Recurring interval in minutes, with optional delayed start
    Every {
        minutes: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        catch_up_window: Option<RecurringWindow>,
    },
    /// Cron expression with optional timezone
    Cron { expr: String, tz: Option<String> },
    /// Read-only legacy Ralph Loop marker. New Task/Goal creation rejects it.
    Loop,
}

/// Read-only legacy row and compatibility response DTO for a scheduled Task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    pub status: TaskStatus,
    #[serde(default)]
    pub execution_count: u32,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_executed_at: Option<DateTime<Utc>>,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    /// Tab ID associated with this task (for frontend reference)
    #[serde(default)]
    pub tab_id: Option<String>,
    /// Exit reason (set when AI calls ExitCronTask)
    #[serde(default)]
    pub exit_reason: Option<String>,
    /// Permission mode for execution (auto, plan, fullAgency, custom)
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Model to use for execution
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider environment (API key, base URL).
    ///
    /// Historical credential payload. Deserialized for migration diagnostics,
    /// never serialized or copied into TaskStore.
    #[serde(default, skip_serializing)]
    pub provider_env: Option<TaskProviderEnv>,
    /// Provider identity carried by legacy rows or projected from TaskStore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Historical routing intent; ignored by Task execution after migration.
    #[serde(default)]
    pub provider_intent: ProviderIntent,
    /// Agent runtime snapshot for external Runtime tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Runtime-scoped config snapshot for external Runtime tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override. Snapshot from the parent Task at
    /// projection time. `None` = follow workspace MCP config; `Some([])` =
    /// explicitly no MCP; `Some([...])` = enable only these server ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker mirrored from Task Center.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    /// Last error message (if any)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Last run success flag. Task-backed compatibility rows project this
    /// from TaskStore's authoritative `lastExecution`; legacy Cron rows retain
    /// their historical denormalized value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ok: Option<bool>,
    /// Last run duration in milliseconds from the same owner as
    /// `last_run_ok`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_duration_ms: Option<u64>,
    // ===== IM Bot cron fields (v0.1.21) =====
    /// Source IM Bot ID that created this task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    /// Where to deliver execution results
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    /// Flexible schedule (overrides interval_minutes when present)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    /// Human-readable name for the task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Computed next execution time (enriched at read time, not persisted)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_execution_at: Option<String>,
    /// Internal SDK session ID where conversation data is stored.
    /// Differs from `session_id` (Sidecar session key) — this tracks the actual
    /// SDK session UUID for frontend to load conversation history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_session_id: Option<String>,
    /// Last activity timestamp — updated on create, start, stop, execute.
    /// Used by frontend to sort tasks by most recent activity.
    #[serde(default = "chrono::Utc::now")]
    pub updated_at: DateTime<Utc>,
    /// Read-only marker found on historical Task projection rows. It is used
    /// only during startup migration and is never written again.
    #[serde(default, rename = "taskId", skip_serializing)]
    pub legacy_task_id: Option<String>,
}

/// Compatibility input for creating a scheduled Task through old Cron surfaces.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskConfig {
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Old clients may still send this field; the compatibility facade rejects
    /// it so credentials cannot enter TaskStore.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<TaskProviderEnv>,
    /// Provider identity used to initialize a new execution Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Old-client compatibility. Subscription maps to `anthropic-sub`;
    /// Explicit is rejected; provider_id takes precedence for FollowAgent.
    #[serde(default)]
    pub provider_intent: ProviderIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list snapshot. Mirrors the `Task.mcp_enabled_servers`
    /// override; `None` = follow workspace MCP, `Some([])` = explicitly no MCP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker mirrored from Task Center.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    // ===== IM Bot cron fields (v0.1.21) =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Default permission_mode for new cron tasks: empty string = sentinel for
/// "user didn't pick" → resolved to runtime max at execution time
/// (see src/shared/types/runtime.ts::resolveCronPermissionMode).
///
/// Pre-v0.2.5 this returned "auto", which the cron resolver respected
/// literally as acceptEdits — silently breaking unattended runs whenever
/// WebSearch / Bash / mcp__* hit the human-approval queue. PRD 0.2.5 R3.
pub(super) fn default_permission_mode() -> String {
    String::new()
}

impl Default for RunMode {
    fn default() -> Self {
        Self::SingleSession
    }
}
