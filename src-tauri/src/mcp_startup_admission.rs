use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::runtime_launch_guard::{self, LaunchOutcome};

/// Application policy: concurrent local-MCP startup waves, not live MCPs.
/// A wave groups the local definitions one Runtime hands to its MCP client at
/// one generation boundary. Keeping this value here makes Rust the sole owner.
const PRODUCTION_CAPACITY: usize = 2;
const LEASE_TTL: Duration = Duration::from_secs(90);
const WAITER_TTL: Duration = Duration::from_secs(60);
const AGING_STEP: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionPriority {
    Background,
    Interactive,
}

impl AdmissionPriority {
    fn base(self) -> u64 {
        match self {
            Self::Background => 0,
            Self::Interactive => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct McpStartupRequest {
    pub request_id: String,
    pub executable_identity: String,
    pub sidecar_id: String,
    pub sidecar_generation: u64,
    pub runtime_generation: u64,
    pub config_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpStartupAdmission {
    pub admitted: bool,
    pub lease_epoch: Option<u64>,
    pub queue_position: Option<usize>,
    pub retry_after_ms: u64,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone)]
struct Waiter {
    request: McpStartupRequest,
    priority: AdmissionPriority,
    sequence: u64,
    enqueued_at: Instant,
    last_seen_at: Instant,
    circuit_retry_at: Option<Instant>,
    circuit_error: Option<String>,
}

#[derive(Debug, Clone)]
struct Lease {
    request: McpStartupRequest,
    epoch: u64,
    expires_at: Instant,
    circuit_epoch: u64,
}

#[derive(Debug)]
struct McpStartupAdmissionManager {
    capacity: usize,
    lease_ttl: Duration,
    waiter_ttl: Duration,
    aging_step: Duration,
    next_sequence: u64,
    next_epoch: u64,
    waiters: HashMap<String, Waiter>,
    leases: HashMap<String, Lease>,
    cancelled_requests: HashMap<String, (McpStartupRequest, Instant)>,
}

impl McpStartupAdmissionManager {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            lease_ttl: LEASE_TTL,
            waiter_ttl: WAITER_TTL,
            aging_step: AGING_STEP,
            next_sequence: 1,
            next_epoch: 1,
            waiters: HashMap::new(),
            leases: HashMap::new(),
            cancelled_requests: HashMap::new(),
        }
    }

    fn priority_score(&self, waiter: &Waiter, now: Instant) -> u64 {
        let aged = now.saturating_duration_since(waiter.enqueued_at).as_secs()
            / self.aging_step.as_secs().max(1);
        waiter.priority.base().saturating_add(aged)
    }

    fn prune(&mut self, now: Instant, mut source_is_live: impl FnMut(&str, u64) -> bool) {
        self.cancelled_requests
            .retain(|_, (_, expires_at)| *expires_at > now);
        self.waiters.retain(|_, waiter| {
            now.saturating_duration_since(waiter.last_seen_at) < self.waiter_ttl
                && source_is_live(
                    &waiter.request.sidecar_id,
                    waiter.request.sidecar_generation,
                )
        });

        let expired = self
            .leases
            .iter()
            .filter_map(|(request_id, lease)| {
                (lease.expires_at <= now
                    || !source_is_live(&lease.request.sidecar_id, lease.request.sidecar_generation))
                .then_some(request_id.clone())
            })
            .collect::<Vec<_>>();
        for request_id in expired {
            if let Some(lease) = self.leases.remove(&request_id) {
                runtime_launch_guard::settle_sdk_child(
                    &lease.request.executable_identity,
                    lease.circuit_epoch,
                    LaunchOutcome::Released,
                    None,
                );
            }
        }
    }

    fn schedule(&mut self, now: Instant) {
        while self.leases.len() < self.capacity && !self.waiters.is_empty() {
            let candidate = self
                .waiters
                .values()
                .filter(|waiter| {
                    waiter
                        .circuit_retry_at
                        .is_none_or(|retry_at| retry_at <= now)
                })
                .max_by(|left, right| {
                    self.priority_score(left, now)
                        .cmp(&self.priority_score(right, now))
                        .then_with(|| right.sequence.cmp(&left.sequence))
                })
                .map(|waiter| waiter.request.request_id.clone());
            let Some(request_id) = candidate else {
                break;
            };
            let Some(mut waiter) = self.waiters.remove(&request_id) else {
                continue;
            };
            let circuit =
                runtime_launch_guard::admit_sdk_child(&waiter.request.executable_identity);
            if !circuit.admitted {
                let retry = Duration::from_millis(circuit.retry_after_ms.max(1));
                waiter.circuit_retry_at = Some(now + retry);
                waiter.circuit_error = circuit.error_code;
                self.waiters.insert(request_id, waiter);
                continue;
            }
            let Some(circuit_epoch) = circuit.admission_epoch else {
                continue;
            };
            let epoch = self.next_epoch;
            self.next_epoch = self.next_epoch.saturating_add(1);
            self.leases.insert(
                request_id,
                Lease {
                    request: waiter.request,
                    epoch,
                    expires_at: now + self.lease_ttl,
                    circuit_epoch,
                },
            );
        }
    }

    fn request(
        &mut self,
        request: McpStartupRequest,
        priority: AdmissionPriority,
        now: Instant,
        source_is_live: impl FnMut(&str, u64) -> bool,
    ) -> McpStartupAdmission {
        self.prune(now, source_is_live);
        if let Some((cancelled, _)) = self.cancelled_requests.get(&request.request_id) {
            return if *cancelled == request {
                cancelled_admission()
            } else {
                invalid_identity()
            };
        }
        if let Some(lease) = self.leases.get(&request.request_id) {
            return if lease.request == request {
                admitted(lease.epoch)
            } else {
                invalid_identity()
            };
        }

        if let Some(waiter) = self.waiters.get_mut(&request.request_id) {
            if waiter.request != request {
                return invalid_identity();
            }
            waiter.last_seen_at = now;
            if priority == AdmissionPriority::Interactive {
                waiter.priority = priority;
            }
        } else {
            let sequence = self.next_sequence;
            self.next_sequence = self.next_sequence.saturating_add(1);
            self.waiters.insert(
                request.request_id.clone(),
                Waiter {
                    request: request.clone(),
                    priority,
                    sequence,
                    enqueued_at: now,
                    last_seen_at: now,
                    circuit_retry_at: None,
                    circuit_error: None,
                },
            );
        }

        self.schedule(now);
        if let Some(lease) = self.leases.get(&request.request_id) {
            return admitted(lease.epoch);
        }

        let mut ordered = self.waiters.values().collect::<Vec<_>>();
        ordered.sort_by(|left, right| {
            self.priority_score(right, now)
                .cmp(&self.priority_score(left, now))
                .then_with(|| left.sequence.cmp(&right.sequence))
        });
        let queue_position = ordered
            .iter()
            .position(|waiter| waiter.request.request_id == request.request_id)
            .map(|index| index + 1);
        let waiter = self.waiters.get(&request.request_id);
        let retry_after_ms = waiter
            .and_then(|waiter| waiter.circuit_retry_at)
            .map(|retry_at| {
                retry_at
                    .saturating_duration_since(now)
                    .as_millis()
                    .clamp(1, u64::MAX as u128) as u64
            })
            .unwrap_or(100);
        McpStartupAdmission {
            admitted: false,
            lease_epoch: None,
            queue_position,
            retry_after_ms,
            error_code: waiter.and_then(|waiter| waiter.circuit_error.clone()),
        }
    }

    fn settle(
        &mut self,
        request: &McpStartupRequest,
        lease_epoch: u64,
        outcome: LaunchOutcome,
        error_code: Option<&str>,
        now: Instant,
        source_is_live: impl FnMut(&str, u64) -> bool,
    ) -> bool {
        self.prune(now, source_is_live);
        let Some(lease) = self.leases.get(&request.request_id) else {
            return false;
        };
        if lease.request != *request || lease.epoch != lease_epoch {
            return false;
        }
        let lease = self
            .leases
            .remove(&request.request_id)
            .expect("lease was present");
        runtime_launch_guard::settle_sdk_child(
            &lease.request.executable_identity,
            lease.circuit_epoch,
            outcome,
            error_code,
        );
        self.schedule(now);
        true
    }

    fn cancel(
        &mut self,
        request: &McpStartupRequest,
        now: Instant,
        source_is_live: impl FnMut(&str, u64) -> bool,
    ) -> bool {
        self.prune(now, source_is_live);
        if self
            .waiters
            .get(&request.request_id)
            .is_some_and(|waiter| waiter.request != *request)
            || self
                .leases
                .get(&request.request_id)
                .is_some_and(|lease| lease.request != *request)
            || self
                .cancelled_requests
                .get(&request.request_id)
                .is_some_and(|(cancelled, _)| *cancelled != *request)
        {
            return false;
        }
        self.cancelled_requests.insert(
            request.request_id.clone(),
            (request.clone(), now + self.waiter_ttl),
        );
        if self
            .waiters
            .get(&request.request_id)
            .is_some_and(|waiter| waiter.request == *request)
        {
            self.waiters.remove(&request.request_id);
            self.schedule(now);
            return true;
        }
        if self
            .leases
            .get(&request.request_id)
            .is_some_and(|lease| lease.request == *request)
        {
            let lease = self
                .leases
                .remove(&request.request_id)
                .expect("matching lease was present");
            runtime_launch_guard::settle_sdk_child(
                &lease.request.executable_identity,
                lease.circuit_epoch,
                LaunchOutcome::Released,
                None,
            );
            self.schedule(now);
            return true;
        }
        false
    }
}

fn admitted(epoch: u64) -> McpStartupAdmission {
    McpStartupAdmission {
        admitted: true,
        lease_epoch: Some(epoch),
        queue_position: None,
        retry_after_ms: 0,
        error_code: None,
    }
}

fn invalid_identity() -> McpStartupAdmission {
    McpStartupAdmission {
        admitted: false,
        lease_epoch: None,
        queue_position: None,
        retry_after_ms: 0,
        error_code: Some("MCP_ADMISSION_IDENTITY_MISMATCH".to_string()),
    }
}

fn cancelled_admission() -> McpStartupAdmission {
    McpStartupAdmission {
        admitted: false,
        lease_epoch: None,
        queue_position: None,
        retry_after_ms: 0,
        error_code: Some("MCP_ADMISSION_CANCELLED".to_string()),
    }
}

fn manager() -> &'static Mutex<McpStartupAdmissionManager> {
    static MANAGER: OnceLock<Mutex<McpStartupAdmissionManager>> = OnceLock::new();
    MANAGER.get_or_init(|| Mutex::new(McpStartupAdmissionManager::new(PRODUCTION_CAPACITY)))
}

pub fn request_mcp_startup(
    request: McpStartupRequest,
    priority: AdmissionPriority,
    source_is_live: impl FnMut(&str, u64) -> bool,
) -> McpStartupAdmission {
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .request(request, priority, Instant::now(), source_is_live)
}

pub fn settle_mcp_startup(
    request: &McpStartupRequest,
    lease_epoch: u64,
    outcome: LaunchOutcome,
    error_code: Option<&str>,
    source_is_live: impl FnMut(&str, u64) -> bool,
) -> bool {
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .settle(
            request,
            lease_epoch,
            outcome,
            error_code,
            Instant::now(),
            source_is_live,
        )
}

pub fn cancel_mcp_startup(
    request: &McpStartupRequest,
    source_is_live: impl FnMut(&str, u64) -> bool,
) -> bool {
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .cancel(request, Instant::now(), source_is_live)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, executable: &str) -> McpStartupRequest {
        McpStartupRequest {
            request_id: id.to_string(),
            executable_identity: executable.to_string(),
            sidecar_id: format!("sidecar-{id}"),
            sidecar_generation: 1,
            runtime_generation: 1,
            config_generation: 1,
        }
    }

    fn manager(capacity: usize) -> McpStartupAdmissionManager {
        McpStartupAdmissionManager::new(capacity)
    }

    #[test]
    fn capacity_one_is_fifo_and_stale_settlement_cannot_release_new_epoch() {
        let now = Instant::now();
        let mut manager = manager(1);
        let first = request("a", "exe-a");
        let second = request("b", "exe-b");
        let first_lease = manager
            .request(first.clone(), AdmissionPriority::Background, now, |_, _| {
                true
            })
            .lease_epoch
            .unwrap();
        let queued = manager.request(
            second.clone(),
            AdmissionPriority::Background,
            now + Duration::from_millis(1),
            |_, _| true,
        );
        assert_eq!(queued.queue_position, Some(1));
        assert!(manager.settle(
            &first,
            first_lease,
            LaunchOutcome::Ready,
            None,
            now + Duration::from_secs(1),
            |_, _| true,
        ));
        let second_lease = manager
            .request(
                second.clone(),
                AdmissionPriority::Background,
                now + Duration::from_secs(1),
                |_, _| true,
            )
            .lease_epoch
            .unwrap();
        assert!(!manager.settle(
            &second,
            first_lease,
            LaunchOutcome::Ready,
            None,
            now + Duration::from_secs(2),
            |_, _| true,
        ));
        assert!(manager
            .leases
            .get("b")
            .is_some_and(|lease| lease.epoch == second_lease));
    }

    #[test]
    fn interactive_priority_and_aging_both_make_progress() {
        let now = Instant::now();
        let mut manager = manager(1);
        let holder = request("holder", "exe-holder");
        let holder_epoch = manager
            .request(
                holder.clone(),
                AdmissionPriority::Background,
                now,
                |_, _| true,
            )
            .lease_epoch
            .unwrap();
        let background = request("background", "exe-background");
        let interactive = request("interactive", "exe-interactive");
        manager.request(
            background.clone(),
            AdmissionPriority::Background,
            now,
            |_, _| true,
        );
        manager.request(
            interactive.clone(),
            AdmissionPriority::Interactive,
            now + Duration::from_secs(1),
            |_, _| true,
        );
        manager.settle(
            &holder,
            holder_epoch,
            LaunchOutcome::Ready,
            None,
            now + Duration::from_secs(2),
            |_, _| true,
        );
        assert!(manager.leases.contains_key("interactive"));

        let interactive_epoch = manager.leases["interactive"].epoch;
        manager.settle(
            &interactive,
            interactive_epoch,
            LaunchOutcome::Ready,
            None,
            now + Duration::from_secs(31),
            |_, _| true,
        );
        assert!(manager.leases.contains_key("background"));
    }

    #[test]
    fn crash_and_expiry_reclaim_capacity() {
        let now = Instant::now();
        let mut manager = manager(1);
        manager.lease_ttl = Duration::from_secs(2);
        let first = request("first", "exe-first");
        manager.request(first, AdmissionPriority::Background, now, |_, _| true);
        let second = request("second", "exe-second");
        manager.request(
            second.clone(),
            AdmissionPriority::Background,
            now,
            |_, _| true,
        );
        let result = manager.request(
            second,
            AdmissionPriority::Background,
            now + Duration::from_secs(3),
            |sidecar, _| sidecar != "sidecar-first",
        );
        assert!(result.admitted);
    }

    #[test]
    fn cancellation_removes_waiter_and_reclaims_raced_lease() {
        let now = Instant::now();
        let mut manager = manager(1);
        let first = request("first", "exe-first");
        let second = request("second", "exe-second");
        let third = request("third", "exe-third");
        manager.request(first.clone(), AdmissionPriority::Background, now, |_, _| {
            true
        });
        manager.request(
            second.clone(),
            AdmissionPriority::Background,
            now,
            |_, _| true,
        );
        assert!(manager.cancel(&second, now, |_, _| true));
        assert!(!manager.waiters.contains_key("second"));

        manager.request(third.clone(), AdmissionPriority::Background, now, |_, _| {
            true
        });
        assert!(manager.cancel(&first, now, |_, _| true));
        assert!(manager.leases.contains_key("third"));
        assert!(!manager.cancel(&first, now, |_, _| true));
    }

    #[test]
    fn cancel_before_request_rejects_the_late_exact_demand() {
        let now = Instant::now();
        let mut manager = manager(1);
        let late = request("late", "exe-late");
        assert!(!manager.cancel(&late, now, |_, _| true));

        let admission = manager.request(
            late.clone(),
            AdmissionPriority::Interactive,
            now + Duration::from_millis(1),
            |_, _| true,
        );

        assert!(!admission.admitted);
        assert_eq!(
            admission.error_code.as_deref(),
            Some("MCP_ADMISSION_CANCELLED")
        );
        assert!(!manager.waiters.contains_key(&late.request_id));
        assert!(!manager.leases.contains_key(&late.request_id));
    }
}
