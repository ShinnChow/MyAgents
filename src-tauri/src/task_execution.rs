use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::cron_task::CronDelivery;
use crate::sidecar::{
    execute_cron_task, release_session_sidecar, CronExecutePayload, ManagedSidecarManager,
    SessionLifecycleGuard, SidecarOwner,
};
use crate::task::{Task, TaskExecutionMode, TaskRunMode, TaskStatus};
use crate::{ulog_error, ulog_warn};

#[derive(Debug)]
pub struct TaskExecutionOutcome {
    pub success: bool,
    pub turn_dispatched: bool,
    pub termination_unconfirmed: bool,
    pub error: Option<String>,
    pub failure_retryable: bool,
    pub ai_exit_reason: Option<String>,
    pub output_text: Option<String>,
    pub session_id: Option<String>,
    pub duration_ms: u64,
}

/// Structured failure for errors that happen before SessionEngine can return
/// a terminal response. Scheduler policy consumes `retryable` directly and
/// never classifies localized error strings.
#[derive(Debug, Clone)]
pub struct TaskExecutionFailure {
    pub message: String,
    pub retryable: bool,
}

impl TaskExecutionFailure {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

fn run_mode(task: &Task) -> TaskRunMode {
    task.run_mode.unwrap_or(TaskRunMode::NewSession)
}

pub(crate) fn select_execution_session(task: &Task) -> String {
    if run_mode(task) == TaskRunMode::SingleSession {
        if let Some(session_id) = task
            .preselected_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return session_id.to_string();
        }
        if let Some(session_id) = task.session_ids.first() {
            return session_id.clone();
        }
    }
    Uuid::new_v4().to_string()
}

pub(crate) fn uses_session_engine(task: &Task) -> bool {
    task.managed_kind.as_deref() != Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH)
}

fn schedule_kind(task: &Task) -> Option<String> {
    match task.execution_mode {
        TaskExecutionMode::Once | TaskExecutionMode::Scheduled => Some("at".to_string()),
        TaskExecutionMode::Recurring if task.cron_expression.is_some() => Some("cron".to_string()),
        TaskExecutionMode::Recurring => Some("every".to_string()),
        TaskExecutionMode::Loop => None,
    }
}

fn response_failure_retryable(success: bool, code: Option<&str>, status: Option<u16>) -> bool {
    success
        || (!matches!(
            code,
            Some("configuration_failed" | "scenario_failed" | "session_bind_failed")
        ) && status.is_none_or(|status| {
            status == 408 || status == 409 || status == 425 || status == 429 || status >= 500
        }))
}

pub(crate) fn retain_owner_between_runs(task: &Task, session_materialized: bool) -> bool {
    session_materialized
        && run_mode(task) == TaskRunMode::SingleSession
        && task.status == TaskStatus::Running
}

async fn release_task_owner(sidecar: &ManagedSidecarManager, task_id: &str, session_id: &str) {
    if let Err(error) = release_session_sidecar(
        sidecar,
        session_id,
        &SidecarOwner::Task(task_id.to_string()),
    )
    .await
    {
        ulog_warn!(
            "[task] failed to release Task owner task={} session={}: {}",
            task_id,
            session_id,
            error
        );
    }
}

fn proactive_memory_evolution_agent_by_id<'a>(
    agents: &'a [crate::im::AgentConfigRust],
    agent_id: &str,
) -> Option<&'a crate::im::AgentConfigRust> {
    agents.iter().find(|agent| {
        agent.id == agent_id
            && agent.enabled
            && agent
                .memory_evolution
                .as_ref()
                .is_some_and(|config| config.enabled)
    })
}

pub(crate) async fn execute_managed_task(
    handle: &AppHandle,
    task: &Task,
    queue_id: &str,
) -> Result<TaskExecutionOutcome, TaskExecutionFailure> {
    let started = Instant::now();
    if task.managed_kind.as_deref() != Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH) {
        return Err(TaskExecutionFailure::permanent(format!(
            "task {} requires a reserved execution Session",
            task.id
        )));
    }
    let batch = crate::memory_auto_update::run_managed_task_batch(handle, task, queue_id)
        .await
        .map_err(TaskExecutionFailure::retryable)?;
    Ok(TaskExecutionOutcome {
        success: batch.success,
        turn_dispatched: true,
        termination_unconfirmed: batch.termination_unconfirmed,
        error: batch
            .termination_unconfirmed
            .then(|| "Memory update turn termination was not confirmed".to_string()),
        failure_retryable: !batch.termination_unconfirmed,
        ai_exit_reason: None,
        output_text: Some(batch.output_text),
        session_id: None,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

pub(crate) async fn execute_task(
    handle: &AppHandle,
    task: &Task,
    queue_id: &str,
    session_id: String,
    initialize_session: bool,
    session_lifecycle: Arc<SessionLifecycleGuard>,
    activation: Option<crate::task_trigger::TaskActivationPayload>,
) -> Result<TaskExecutionOutcome, TaskExecutionFailure> {
    let started = Instant::now();

    let is_memory_evolution = matches!(
        task.managed_kind.as_deref(),
        Some(crate::task::MANAGED_KIND_MEMORY_GARDENER)
            | Some(crate::task::MANAGED_KIND_MEMORY_MOLT)
    );
    if is_memory_evolution {
        let agents = crate::im::read_agent_configs_from_disk();
        let target_agent_id = crate::im::agent_id_for_project(&task.workspace_id).or_else(|| {
            agents
                .iter()
                .any(|agent| agent.id == task.workspace_id)
                .then(|| task.workspace_id.clone())
        });
        let effective = target_agent_id
            .as_deref()
            .and_then(|agent_id| proactive_memory_evolution_agent_by_id(&agents, agent_id))
            .is_some_and(|agent| !crate::im::is_agent_workspace_archived(agent));
        if !effective {
            return Ok(TaskExecutionOutcome {
                success: true,
                turn_dispatched: false,
                termination_unconfirmed: false,
                error: None,
                failure_retryable: false,
                ai_exit_reason: Some("proactive-agent-disabled".to_string()),
                output_text: Some(
                    "Memory evolution skipped because Proactive Agent is disabled or archived."
                        .to_string(),
                ),
                session_id: None,
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }
        crate::workspace_files::memory_rules::ensure_memory_rule_substrate_for_workspace(
            &task.workspace_path,
        )
        .map_err(|error| {
            TaskExecutionFailure::permanent(format!("ensure memory rule substrate: {error}"))
        })?;
    }

    let sidecar = handle
        .try_state::<ManagedSidecarManager>()
        .ok_or_else(|| TaskExecutionFailure::permanent("SidecarManager state not available"))?;
    let prompt = crate::task::build_dispatch_prompt(&task.id)
        .await
        .ok_or_else(|| {
            TaskExecutionFailure::permanent(format!("task {} disappeared before dispatch", task.id))
        })?
        .map_err(TaskExecutionFailure::permanent)?;
    let effective_run_mode = run_mode(task);
    let payload = CronExecutePayload {
        task_id: task.id.clone(),
        queue_id: queue_id.to_string(),
        prompt,
        managed_kind: task.managed_kind.clone(),
        initialize_session,
        session_id: Some(session_id.clone()),
        ai_can_exit: Some(
            task.end_conditions
                .as_ref()
                .is_some_and(|conditions| conditions.ai_can_exit),
        ),
        permission_mode: Some(task.permission_mode.clone().unwrap_or_default()),
        model: initialize_session.then(|| task.model.clone()).flatten(),
        provider_id: initialize_session
            .then(|| task.provider_id.clone())
            .flatten(),
        runtime: initialize_session.then(|| task.runtime.clone()).flatten(),
        runtime_config: initialize_session
            .then(|| task.runtime_config.clone())
            .flatten(),
        mcp_enabled_servers: initialize_session
            .then(|| task.mcp_enabled_servers.clone())
            .flatten(),
        run_mode: Some(match effective_run_mode {
            TaskRunMode::SingleSession => "single_session".to_string(),
            TaskRunMode::NewSession => "new_session".to_string(),
        }),
        interval_minutes: task.interval_minutes,
        execution_number: Some(task.execution_count.saturating_add(1)),
        schedule_kind: schedule_kind(task),
        activation_event: activation,
    };

    let result = execute_cron_task(
        handle,
        &sidecar,
        &task.workspace_path,
        payload,
        session_lifecycle,
    )
    .await;
    let response = result.map_err(|error| {
        ulog_error!(
            "[task] execution transport failed task={}: {}",
            task.id,
            error
        );
        TaskExecutionFailure::retryable(error)
    })?;
    let failure_retryable =
        response_failure_retryable(response.success, response.code.as_deref(), response.status);
    Ok(TaskExecutionOutcome {
        success: response.success,
        turn_dispatched: response.turn_dispatched,
        termination_unconfirmed: response.termination_unconfirmed,
        error: response.error,
        failure_retryable,
        ai_exit_reason: response
            .ai_requested_exit
            .unwrap_or(false)
            .then_some(response.exit_reason)
            .flatten(),
        output_text: response.output_text,
        session_id: response.session_id.or(Some(session_id)),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

pub async fn deliver_task_result(handle: &AppHandle, task: &Task, outcome: &TaskExecutionOutcome) {
    let content = outcome.output_text.clone().unwrap_or_else(|| {
        if outcome.success {
            format!("Task '{}' completed successfully.", task.name)
        } else {
            format!(
                "Task '{}' failed: {}",
                task.name,
                outcome.error.as_deref().unwrap_or("unknown error")
            )
        }
    });

    if let Some(notification) = task.notification.as_ref() {
        if let Some(bot_id) = notification
            .bot_channel_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            let delivery = CronDelivery {
                bot_id: bot_id.to_string(),
                chat_id: notification
                    .bot_thread
                    .clone()
                    .unwrap_or_else(|| "_auto_".to_string()),
                platform: "task-center".to_string(),
            };
            crate::cron_task::deliver_cron_result_to_bot(
                handle,
                &delivery,
                &task.id,
                &content,
                outcome.session_id.as_deref(),
            )
            .await;
        }
    }

    if should_deliver_desktop_notification(task) {
        let title = if outcome.success {
            "定时任务执行完成"
        } else {
            "定时任务执行失败"
        };
        let session_id = outcome.session_id.clone().unwrap_or_default();
        let navigation = crate::notification::NotificationNavigation::for_session(
            None,
            session_id.clone(),
            task.workspace_path.clone(),
        );
        let badge = crate::notification_badge::NotificationBadgeIncrement {
            id: format!(
                "task:{}:{}",
                task.id,
                task.execution_count.saturating_add(1)
            ),
            source: "task".to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
            target: crate::notification_badge::NotificationBadgeTarget::Session {
                session_id,
                workspace_path: task.workspace_path.clone(),
            },
        };
        crate::notification::show_with_navigation_target_and_badge(
            handle,
            title,
            &content,
            navigation,
            Some(badge),
        );
    }
}

fn should_deliver_desktop_notification(task: &Task) -> bool {
    if matches!(
        task.managed_kind.as_deref(),
        Some(crate::task::MANAGED_KIND_MEMORY_GARDENER | crate::task::MANAGED_KIND_MEMORY_MOLT)
    ) {
        return false;
    }
    task.notification
        .as_ref()
        .map(|notification| notification.desktop)
        .unwrap_or(true)
}

pub async fn release_task_sessions(
    handle: &AppHandle,
    task: &Task,
    active_session_id: Option<&str>,
) {
    let Some(sidecar) = handle.try_state::<ManagedSidecarManager>() else {
        return;
    };
    let retained_session = (run_mode(task) == TaskRunMode::SingleSession)
        .then(|| {
            task.preselected_session_id
                .as_deref()
                .or_else(|| task.session_ids.first().map(String::as_str))
        })
        .flatten();
    let mut sessions = Vec::new();
    for session_id in [active_session_id, retained_session].into_iter().flatten() {
        if sessions.iter().all(|existing| *existing != session_id) {
            sessions.push(session_id);
        }
    }
    for session_id in sessions {
        release_task_owner(&sidecar, &task.id, session_id).await;
    }
}

pub async fn stop_task_turn(
    handle: &AppHandle,
    task: &Task,
    active_session_id: Option<&str>,
    queue_id: &str,
) -> Result<(), String> {
    let Some(session_id) = active_session_id else {
        return Ok(());
    };
    let Some(sidecar) = handle.try_state::<ManagedSidecarManager>() else {
        return Err("SidecarManager state not available".to_string());
    };
    let client = crate::local_http::builder()
        .timeout(std::time::Duration::from_secs(65))
        .build()
        .map_err(|error| format!("build Task stop client: {error}"))?;
    let port = sidecar
        .lock()
        .map_err(|error| format!("Sidecar lock poisoned: {error}"))?
        .get_session_port(session_id);
    let Some(port) = port else {
        return Ok(());
    };
    let response = client
        .post(format!("http://127.0.0.1:{port}/task/stop"))
        .json(&serde_json::json!({ "taskId": task.id, "queueId": queue_id }))
        .send()
        .await
        .map_err(|error| format!("request /task/stop: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("read /task/stop response: {error}"))?;
    validate_task_stop_confirmation(status, &body)
}

fn validate_task_stop_confirmation(status: reqwest::StatusCode, body: &str) -> Result<(), String> {
    let payload: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("parse /task/stop response: {error}"))?;
    if status.is_success()
        && payload.get("success").and_then(serde_json::Value::as_bool) == Some(true)
    {
        return Ok(());
    }
    Err(payload
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("SessionEngine did not confirm the Task-scoped stop")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_session_task(session_id: &str) -> Task {
        serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "test",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "single-session",
            "preselectedSessionId": session_id,
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap()
    }

    fn memory_evolution_agent(
        master_enabled: bool,
        child_enabled: bool,
    ) -> crate::im::AgentConfigRust {
        let mut agent: crate::im::AgentConfigRust = serde_json::from_value(serde_json::json!({
            "id": "agent-1",
            "name": "Agent",
            "enabled": master_enabled,
            "permissionMode": "auto",
            "memoryEvolution": { "enabled": child_enabled },
            "channels": []
        }))
        .unwrap();
        agent.resolved_workspace_path = "/tmp/workspace".to_string();
        agent
    }

    #[test]
    fn memory_evolution_requires_both_master_and_child_switches() {
        assert!(proactive_memory_evolution_agent_by_id(
            &[memory_evolution_agent(true, true)],
            "agent-1",
        )
        .is_some());
        assert!(proactive_memory_evolution_agent_by_id(
            &[memory_evolution_agent(false, true)],
            "agent-1",
        )
        .is_none());
        assert!(proactive_memory_evolution_agent_by_id(
            &[memory_evolution_agent(true, false)],
            "agent-1",
        )
        .is_none());
        assert!(proactive_memory_evolution_agent_by_id(
            &[memory_evolution_agent(true, true)],
            "agent-2",
        )
        .is_none());
    }

    #[test]
    fn single_session_execution_reuses_its_preselected_session() {
        let session_id = select_execution_session(&single_session_task("session-1"));
        assert_eq!(session_id, "session-1");
    }

    #[test]
    fn new_session_execution_never_reuses_a_previous_run_session() {
        let mut task = single_session_task("unused");
        task.run_mode = Some(TaskRunMode::NewSession);
        task.preselected_session_id = None;
        task.session_ids = vec!["run-1".to_string(), "run-2".to_string()];

        let selected = select_execution_session(&task);

        assert_ne!(selected, "run-1");
        assert_ne!(selected, "run-2");
        assert!(Uuid::parse_str(&selected).is_ok());
    }

    #[test]
    fn managed_batch_does_not_use_the_session_engine() {
        let mut task = single_session_task("unused");
        task.managed_kind = Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH.to_string());

        assert!(!uses_session_engine(&task));

        task.managed_kind = None;
        assert!(uses_session_engine(&task));
    }

    #[test]
    fn structured_response_classifies_retryable_and_permanent_failures() {
        for (code, status) in [
            (None, Some(408)),
            (None, Some(409)),
            (None, Some(425)),
            (None, Some(429)),
            (None, Some(500)),
        ] {
            assert!(response_failure_retryable(false, code, status));
        }
        for (code, status) in [
            (Some("configuration_failed"), Some(503)),
            (Some("scenario_failed"), Some(500)),
            (Some("session_bind_failed"), Some(409)),
            (None, Some(400)),
            (None, Some(401)),
            (None, Some(403)),
            (None, Some(404)),
        ] {
            assert!(!response_failure_retryable(false, code, status));
        }
        assert!(response_failure_retryable(true, None, Some(200)));
    }

    #[test]
    fn memory_evolution_tasks_never_deliver_desktop_notifications() {
        let mut task = single_session_task("unused");
        task.managed_kind = Some(crate::task::MANAGED_KIND_MEMORY_GARDENER.to_string());
        assert!(!should_deliver_desktop_notification(&task));

        task.managed_kind = Some(crate::task::MANAGED_KIND_MEMORY_MOLT.to_string());
        assert!(!should_deliver_desktop_notification(&task));

        task.managed_kind = None;
        assert!(should_deliver_desktop_notification(&task));

        task.notification = Some(crate::task::NotificationConfig {
            desktop: false,
            ..Default::default()
        });
        assert!(!should_deliver_desktop_notification(&task));
    }

    #[test]
    fn stopped_single_session_run_does_not_retain_task_owner() {
        let mut task = single_session_task("session-1");
        task.status = TaskStatus::Stopped;
        assert!(!retain_owner_between_runs(&task, true));

        task.status = TaskStatus::Running;
        assert!(retain_owner_between_runs(&task, true));
        assert!(
            !retain_owner_between_runs(&task, false),
            "an unmaterialized creator must release its owner so the next Task can retry birth"
        );
    }

    #[test]
    fn task_stop_requires_session_engine_confirmation() {
        assert!(validate_task_stop_confirmation(
            reqwest::StatusCode::OK,
            r#"{"success":true,"alreadyStopped":true}"#,
        )
        .is_ok());
        assert_eq!(
            validate_task_stop_confirmation(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"success":false,"error":"runtime refused to stop"}"#,
            )
            .unwrap_err(),
            "runtime refused to stop"
        );
    }
}
