use tauri::{AppHandle, Manager};

use super::{get_session_goal_manager, GoalContinuationRequest, GoalStatus};
use crate::sidecar::{
    ensure_goal_sidecar_owner, execute_goal_turn, release_session_sidecar, GoalExecutePayload,
    GoalExecuteResponse, ManagedSidecarManager, SidecarOwner,
};
use crate::{ulog_info, ulog_warn};

pub(super) async fn execute(
    handle: &AppHandle,
    request: &GoalContinuationRequest,
) -> Result<GoalExecuteResponse, String> {
    let goal = &request.goal;
    let _wake_lock = crate::wake_lock::WakeLock::acquire(&format!("Goal {}", goal.id))
        .map_err(|error| {
            ulog_warn!(
                "[Goal] Wake-lock acquire failed for {}: {}; continuing",
                goal.id,
                error
            );
            error
        })
        .ok();
    let sidecars = handle
        .try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;
    let port = ensure_goal_sidecar_owner(
        handle,
        sidecars.inner(),
        &goal.workspace_path,
        &goal.session_id,
        &goal.id,
    )
    .await?;

    // Sidecar boot may take seconds. Re-read the durable control epoch before
    // handing this queue item to the Runtime.
    let latest = get_session_goal_manager()
        .get(&goal.id)
        .await
        .map_err(|error| error.to_string())?;
    let still_current = latest.as_ref().is_some_and(|current| {
        current.status == GoalStatus::Active
            && current.control_revision == request.expected_control_revision
            && current.current_turn.is_none()
            && current.delivery_outbox.is_empty()
    });
    if !still_current {
        if latest
            .as_ref()
            .is_none_or(|current| current.status != GoalStatus::Active)
        {
            let _ = release_session_sidecar(
                sidecars.inner(),
                &goal.session_id,
                &SidecarOwner::Goal(goal.id.clone()),
            )
            .await;
        }
        return Err("Goal changed while its Sidecar was starting".to_string());
    }

    let payload = GoalExecutePayload {
        goal_id: goal.id.clone(),
        objective: goal.objective.clone(),
        session_id: goal.session_id.clone(),
        turn_number: request.turn_number,
        ai_can_exit: goal.end_conditions.ai_can_exit,
        permission_mode: goal.permission_mode.clone(),
        queue_id: request.queue_id.clone(),
        expected_control_revision: request.expected_control_revision,
    };
    ulog_info!(
        "[Goal] Dispatching continuation {} turn {} for Session {}",
        goal.id,
        request.turn_number,
        goal.session_id
    );
    execute_goal_turn(
        handle,
        sidecars.inner(),
        &goal.workspace_path,
        port,
        payload,
    )
    .await
}
