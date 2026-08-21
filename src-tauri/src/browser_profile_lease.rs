use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::browser_runtime_authority::BrowserCapabilityBinding;

const WAITER_TTL: Duration = Duration::from_secs(60);
const REATTACH_TTL: Duration = Duration::from_secs(15);
const AGING_STEP: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileLeasePriority {
    Background,
    Interactive,
}

impl ProfileLeasePriority {
    fn base(self) -> u64 {
        match self {
            Self::Background => 0,
            Self::Interactive => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileLeaseAdmission {
    pub admitted: bool,
    pub lease_epoch: Option<u64>,
    pub queue_position: Option<usize>,
}

#[derive(Debug, Clone)]
struct ProfileHolder {
    request_id: String,
    binding: BrowserCapabilityBinding,
    lease_epoch: u64,
}

#[derive(Debug, Clone)]
struct ProfileWaiter {
    request_id: String,
    binding: BrowserCapabilityBinding,
    sequence: u64,
    priority: ProfileLeasePriority,
    enqueued_at: Instant,
    last_seen_at: Instant,
}

#[derive(Debug, Clone)]
struct ReattachReservation {
    product_session_id: String,
    expires_at: Instant,
}

#[derive(Debug, Default)]
struct BrowserProfileLeaseManager {
    holder: Option<ProfileHolder>,
    waiters: HashMap<String, ProfileWaiter>,
    cancelled_requests: HashMap<(String, u64), Instant>,
    retired_sources: HashSet<(String, u64)>,
    reattach: Option<ReattachReservation>,
    current_host_generation: u64,
    next_sequence: u64,
    next_epoch: u64,
}

impl BrowserProfileLeaseManager {
    fn source_identities(&self) -> HashSet<(String, u64)> {
        self.holder
            .iter()
            .map(|holder| {
                (
                    holder.binding.source_sidecar_id.clone(),
                    holder.binding.source_generation,
                )
            })
            .chain(self.waiters.values().map(|waiter| {
                (
                    waiter.binding.source_sidecar_id.clone(),
                    waiter.binding.source_generation,
                )
            }))
            .collect()
    }

    fn priority_score(waiter: &ProfileWaiter, now: Instant) -> u64 {
        let aged = now.saturating_duration_since(waiter.enqueued_at).as_secs()
            / AGING_STEP.as_secs().max(1);
        waiter.priority.base().saturating_add(aged)
    }

    fn prune(
        &mut self,
        current_host_generation: u64,
        now: Instant,
        _source_is_live: impl FnMut(&str, u64) -> bool,
    ) {
        self.current_host_generation = current_host_generation;
        self.cancelled_requests
            .retain(|(_, host_generation), expires_at| {
                *host_generation == current_host_generation && *expires_at > now
            });
        self.waiters
            .retain(|_, waiter| now.saturating_duration_since(waiter.last_seen_at) < WAITER_TTL);
        let holder_stale = self
            .holder
            .as_ref()
            .is_some_and(|holder| holder.binding.host_generation != current_host_generation);
        if holder_stale {
            if let Some(holder) = self.holder.take() {
                self.reattach = Some(ReattachReservation {
                    product_session_id: holder.binding.product_session_id,
                    expires_at: now + REATTACH_TTL,
                });
            }
        }
        if self
            .reattach
            .as_ref()
            .is_some_and(|reservation| reservation.expires_at <= now)
        {
            self.reattach = None;
        }
    }

    fn schedule(&mut self, now: Instant) {
        if self.holder.is_some() || self.waiters.is_empty() {
            return;
        }
        let reattach_session = self
            .reattach
            .as_ref()
            .filter(|reservation| reservation.expires_at > now)
            .map(|reservation| reservation.product_session_id.as_str());
        if reattach_session.is_some()
            && !self.waiters.values().any(|waiter| {
                waiter.binding.host_generation == self.current_host_generation
                    && reattach_session == Some(waiter.binding.product_session_id.as_str())
            })
        {
            return;
        }
        let next = self
            .waiters
            .values()
            .filter(|waiter| waiter.binding.host_generation == self.current_host_generation)
            .filter(|waiter| !self.source_is_retired(&waiter.binding))
            .max_by(|left, right| {
                let left_reattach =
                    reattach_session == Some(left.binding.product_session_id.as_str());
                let right_reattach =
                    reattach_session == Some(right.binding.product_session_id.as_str());
                left_reattach
                    .cmp(&right_reattach)
                    .then_with(|| {
                        Self::priority_score(left, now).cmp(&Self::priority_score(right, now))
                    })
                    .then_with(|| right.sequence.cmp(&left.sequence))
            })
            .map(|waiter| waiter.request_id.clone());
        let Some(request_id) = next else {
            return;
        };
        let waiter = self
            .waiters
            .remove(&request_id)
            .expect("waiter was present");
        self.next_epoch = self.next_epoch.saturating_add(1).max(1);
        self.holder = Some(ProfileHolder {
            request_id: waiter.request_id,
            binding: waiter.binding,
            lease_epoch: self.next_epoch,
        });
        self.reattach = None;
    }

    fn acquire(
        &mut self,
        request_id: &str,
        binding: BrowserCapabilityBinding,
        priority: ProfileLeasePriority,
        current_host_generation: u64,
        now: Instant,
        source_is_live: impl FnMut(&str, u64) -> bool,
    ) -> ProfileLeaseAdmission {
        self.prune(current_host_generation, now, source_is_live);
        if self
            .cancelled_requests
            .contains_key(&(request_id.to_string(), current_host_generation))
        {
            return ProfileLeaseAdmission {
                admitted: false,
                lease_epoch: None,
                queue_position: None,
            };
        }
        self.retired_sources
            .remove(&(binding.source_sidecar_id.clone(), binding.source_generation));
        if let Some(holder) = &self.holder {
            if holder.binding == binding {
                return admitted(holder.lease_epoch);
            }
        }
        if let Some(waiter) = self.waiters.get_mut(request_id) {
            if waiter.binding != binding && !same_runtime_owner(&waiter.binding, &binding) {
                return ProfileLeaseAdmission {
                    admitted: false,
                    lease_epoch: None,
                    queue_position: None,
                };
            }
            waiter.binding = binding.clone();
            waiter.last_seen_at = now;
            if priority == ProfileLeasePriority::Interactive {
                waiter.priority = priority;
            }
        } else {
            let carried_request_id = self
                .waiters
                .values()
                .filter(|waiter| {
                    (waiter.binding.host_generation != current_host_generation
                        && same_runtime_owner(&waiter.binding, &binding))
                        || (self.source_is_retired(&waiter.binding)
                            && same_product_owner(&waiter.binding, &binding))
                })
                .min_by_key(|waiter| waiter.sequence)
                .map(|waiter| waiter.request_id.clone());
            let carried = carried_request_id
                .as_ref()
                .and_then(|old_request_id| self.waiters.remove(old_request_id));
            let sequence = carried
                .as_ref()
                .map(|waiter| waiter.sequence)
                .unwrap_or_else(|| {
                    self.next_sequence = self.next_sequence.saturating_add(1).max(1);
                    self.next_sequence
                });
            let enqueued_at = carried
                .as_ref()
                .map(|waiter| waiter.enqueued_at)
                .unwrap_or(now);
            let priority = if carried
                .as_ref()
                .is_some_and(|waiter| waiter.priority == ProfileLeasePriority::Interactive)
            {
                ProfileLeasePriority::Interactive
            } else {
                priority
            };
            self.waiters.insert(
                request_id.to_string(),
                ProfileWaiter {
                    request_id: request_id.to_string(),
                    binding: binding.clone(),
                    sequence,
                    priority,
                    enqueued_at,
                    last_seen_at: now,
                },
            );
        }
        self.schedule(now);
        if let Some(holder) = &self.holder {
            if holder.binding == binding {
                return admitted(holder.lease_epoch);
            }
        }
        let mut ordered = self
            .waiters
            .values()
            .filter(|waiter| waiter.binding.host_generation == current_host_generation)
            .filter(|waiter| !self.source_is_retired(&waiter.binding))
            .collect::<Vec<_>>();
        ordered.sort_by(|left, right| {
            Self::priority_score(right, now)
                .cmp(&Self::priority_score(left, now))
                .then_with(|| left.sequence.cmp(&right.sequence))
        });
        ProfileLeaseAdmission {
            admitted: false,
            lease_epoch: None,
            queue_position: ordered
                .iter()
                .position(|waiter| waiter.request_id == request_id)
                .map(|index| index + 1),
        }
    }

    #[cfg(test)]
    fn cancel(
        &mut self,
        request_id: &str,
        binding: &BrowserCapabilityBinding,
        now: Instant,
    ) -> bool {
        let removed = self
            .waiters
            .get(request_id)
            .is_some_and(|waiter| waiter.binding == *binding);
        if removed {
            self.waiters.remove(request_id);
            self.schedule(now);
            return true;
        }
        let held = self
            .holder
            .as_ref()
            .is_some_and(|holder| holder.request_id == request_id && holder.binding == *binding);
        if held {
            self.holder = None;
            self.schedule(now);
        }
        held
    }

    fn cancel_owned(&mut self, request_id: &str, host_generation: u64, now: Instant) -> bool {
        if self.current_host_generation != 0 && self.current_host_generation != host_generation {
            return false;
        }
        self.current_host_generation = host_generation;
        // A loopback POST can reach this owner after its caller has already
        // observed Abort. Keep one bounded exact-request tombstone so a cancel
        // that wins the race also rejects the late acquire.
        self.cancelled_requests
            .insert((request_id.to_string(), host_generation), now + WAITER_TTL);
        let removed = self
            .waiters
            .get(request_id)
            .is_some_and(|waiter| waiter.binding.host_generation == host_generation);
        if removed {
            self.waiters.remove(request_id);
            self.schedule(now);
            return true;
        }
        let held = self.holder.as_ref().is_some_and(|holder| {
            holder.request_id == request_id && holder.binding.host_generation == host_generation
        });
        if held {
            self.holder = None;
            self.schedule(now);
        }
        held
    }

    #[cfg(test)]
    fn release(
        &mut self,
        binding: &BrowserCapabilityBinding,
        lease_epoch: u64,
        now: Instant,
    ) -> bool {
        let matches = self
            .holder
            .as_ref()
            .is_some_and(|holder| holder.binding == *binding && holder.lease_epoch == lease_epoch);
        if !matches {
            return false;
        }
        self.holder = None;
        self.schedule(now);
        true
    }

    fn release_owned(
        &mut self,
        request_id: &str,
        lease_epoch: u64,
        host_generation: u64,
        now: Instant,
    ) -> bool {
        let matches = self.holder.as_ref().is_some_and(|holder| {
            holder.request_id == request_id
                && holder.binding.host_generation == host_generation
                && holder.lease_epoch == lease_epoch
        });
        if !matches {
            return false;
        }
        self.holder = None;
        self.schedule(now);
        true
    }

    fn retire_source(
        &mut self,
        source_sidecar_id: &str,
        source_generation: u64,
        recoverable: bool,
        now: Instant,
    ) {
        self.retired_sources
            .insert((source_sidecar_id.to_string(), source_generation));
        if !recoverable {
            self.waiters.retain(|_, waiter| {
                waiter.binding.source_sidecar_id != source_sidecar_id
                    || waiter.binding.source_generation != source_generation
            });
        }
        // The Global Host may still own the real persistent Context for the
        // 15-second transport reattach window. Keep its exact holder until the
        // Context actually closes and releases the epoch; otherwise another
        // Product Session can open the same Profile before Chrome lets go.
        self.schedule(now);
    }

    fn source_is_retired(&self, binding: &BrowserCapabilityBinding) -> bool {
        self.retired_sources
            .contains(&(binding.source_sidecar_id.clone(), binding.source_generation))
    }

    fn retire_host_generation(&mut self, host_generation: u64, now: Instant) {
        self.cancelled_requests
            .retain(|(_, generation), _| *generation != host_generation);
        if self.current_host_generation == host_generation {
            self.current_host_generation = 0;
        }
        let holder_matches = self
            .holder
            .as_ref()
            .is_some_and(|holder| holder.binding.host_generation == host_generation);
        if holder_matches {
            if let Some(holder) = self.holder.take() {
                self.reattach = Some(ReattachReservation {
                    product_session_id: holder.binding.product_session_id,
                    expires_at: now + REATTACH_TTL,
                });
            }
        }
    }
}

fn same_runtime_owner(left: &BrowserCapabilityBinding, right: &BrowserCapabilityBinding) -> bool {
    left.product_session_id == right.product_session_id
        && left.workspace_path == right.workspace_path
        && left.source_sidecar_id == right.source_sidecar_id
        && left.source_generation == right.source_generation
}

fn same_product_owner(left: &BrowserCapabilityBinding, right: &BrowserCapabilityBinding) -> bool {
    left.product_session_id == right.product_session_id
        && left.workspace_path == right.workspace_path
}

fn admitted(epoch: u64) -> ProfileLeaseAdmission {
    ProfileLeaseAdmission {
        admitted: true,
        lease_epoch: Some(epoch),
        queue_position: None,
    }
}

fn manager() -> &'static Mutex<BrowserProfileLeaseManager> {
    static MANAGER: OnceLock<Mutex<BrowserProfileLeaseManager>> = OnceLock::new();
    MANAGER.get_or_init(|| Mutex::new(BrowserProfileLeaseManager::default()))
}

pub fn acquire_profile_lease(
    request_id: &str,
    binding: BrowserCapabilityBinding,
    priority: ProfileLeasePriority,
    current_host_generation: u64,
    mut source_is_live: impl FnMut(&str, u64) -> bool,
) -> ProfileLeaseAdmission {
    let mut sources = manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .source_identities();
    sources.insert((binding.source_sidecar_id.clone(), binding.source_generation));
    let liveness = sources
        .into_iter()
        .map(|source| {
            let live = source_is_live(&source.0, source.1);
            (source, live)
        })
        .collect::<HashMap<_, _>>();
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .acquire(
            request_id,
            binding,
            priority,
            current_host_generation,
            Instant::now(),
            |source_sidecar_id, source_generation| {
                liveness
                    .get(&(source_sidecar_id.to_string(), source_generation))
                    .copied()
                    .unwrap_or(false)
            },
        )
}

pub fn retire_profile_source(source_sidecar_id: &str, source_generation: u64, recoverable: bool) {
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retire_source(
            source_sidecar_id,
            source_generation,
            recoverable,
            Instant::now(),
        );
}

pub fn retire_profile_host_generation(host_generation: u64) {
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retire_host_generation(host_generation, Instant::now());
}

pub fn cancel_owned_profile_request(request_id: &str, host_generation: u64) -> bool {
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .cancel_owned(request_id, host_generation, Instant::now())
}

pub fn release_owned_profile_request(
    request_id: &str,
    lease_epoch: u64,
    host_generation: u64,
) -> bool {
    manager()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .release_owned(request_id, lease_epoch, host_generation, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(session: &str, host_generation: u64) -> BrowserCapabilityBinding {
        BrowserCapabilityBinding {
            product_session_id: session.to_string(),
            workspace_path: format!("/workspace/{session}"),
            source_sidecar_id: format!("sidecar-{session}"),
            source_generation: 1,
            host_generation,
        }
    }

    #[test]
    fn fifo_cancel_and_stale_release_are_exact() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let a = binding("a", 3);
        let b = binding("b", 3);
        let c = binding("c", 3);
        let epoch_a = manager
            .acquire(
                "a",
                a.clone(),
                ProfileLeasePriority::Interactive,
                3,
                now,
                |_, _| true,
            )
            .lease_epoch
            .unwrap();
        assert_eq!(
            manager
                .acquire(
                    "b",
                    b.clone(),
                    ProfileLeasePriority::Interactive,
                    3,
                    now,
                    |_, _| true,
                )
                .queue_position,
            Some(1)
        );
        assert_eq!(
            manager
                .acquire(
                    "c",
                    c.clone(),
                    ProfileLeasePriority::Interactive,
                    3,
                    now,
                    |_, _| true,
                )
                .queue_position,
            Some(2)
        );
        assert!(manager.cancel("b", &b, now));
        assert!(manager.release(&a, epoch_a, now));
        let epoch_c = manager.holder.as_ref().unwrap().lease_epoch;
        assert!(!manager.release(&c, epoch_a, now));
        assert_eq!(manager.holder.as_ref().unwrap().lease_epoch, epoch_c);
    }

    #[test]
    fn current_host_can_settle_by_exact_request_after_the_source_retires() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let a = binding("a", 3);
        let epoch = manager
            .acquire(
                "request-a",
                a.clone(),
                ProfileLeasePriority::Interactive,
                3,
                now,
                |_, _| true,
            )
            .lease_epoch
            .unwrap();
        manager.retire_source(&a.source_sidecar_id, a.source_generation, false, now);

        assert!(!manager.release_owned("request-a", epoch, 4, now));
        assert!(!manager.release_owned("stale-request", epoch, 3, now));
        assert!(manager.release_owned("request-a", epoch, 3, now));

        let b = binding("b", 3);
        manager.acquire(
            "request-b",
            b.clone(),
            ProfileLeasePriority::Interactive,
            3,
            now,
            |_, _| true,
        );
        assert!(!manager.cancel_owned("request-b", 4, now));
        assert!(manager.cancel_owned("request-b", 3, now));
    }

    #[test]
    fn cancel_before_acquire_rejects_the_late_exact_request() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        assert!(!manager.cancel_owned("late-request", 3, now));

        let admission = manager.acquire(
            "late-request",
            binding("a", 3),
            ProfileLeasePriority::Interactive,
            3,
            now + Duration::from_millis(1),
            |_, _| true,
        );

        assert!(!admission.admitted);
        assert!(admission.queue_position.is_none());
        assert!(manager.holder.is_none());
        assert!(manager.waiters.is_empty());
    }

    #[test]
    fn host_replacement_reserves_bounded_reattach_for_same_product_session() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let old_a = binding("a", 1);
        manager.acquire(
            "a-old",
            old_a,
            ProfileLeasePriority::Interactive,
            1,
            now,
            |_, _| true,
        );
        let b = binding("b", 2);
        manager.acquire(
            "b",
            b,
            ProfileLeasePriority::Interactive,
            2,
            now + Duration::from_secs(1),
            |_, _| true,
        );
        let new_a = binding("a", 2);
        let acquired = manager.acquire(
            "a-new",
            new_a,
            ProfileLeasePriority::Interactive,
            2,
            now + Duration::from_secs(2),
            |_, _| true,
        );
        assert!(acquired.admitted);
    }

    #[test]
    fn host_replacement_preserves_waiter_order_when_sessions_reconnect() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let old_a = binding("a", 1);
        manager.acquire(
            "a-old",
            old_a,
            ProfileLeasePriority::Interactive,
            1,
            now,
            |_, _| true,
        );
        let old_b = binding("b", 1);
        manager.acquire(
            "b-old",
            old_b,
            ProfileLeasePriority::Interactive,
            1,
            now + Duration::from_secs(1),
            |_, _| true,
        );

        let fresh_c = binding("c", 2);
        assert_eq!(
            manager
                .acquire(
                    "c-new",
                    fresh_c,
                    ProfileLeasePriority::Interactive,
                    2,
                    now + Duration::from_secs(2),
                    |_, _| true,
                )
                .queue_position,
            Some(1)
        );
        let new_b = binding("b", 2);
        assert_eq!(
            manager
                .acquire(
                    "b-new",
                    new_b.clone(),
                    ProfileLeasePriority::Interactive,
                    2,
                    now + Duration::from_secs(3),
                    |_, _| true,
                )
                .queue_position,
            Some(1)
        );

        let acquired = manager.acquire(
            "b-new",
            new_b.clone(),
            ProfileLeasePriority::Interactive,
            2,
            now + REATTACH_TTL + Duration::from_secs(3),
            |_, _| true,
        );
        assert!(acquired.admitted);
        assert_eq!(manager.holder.as_ref().unwrap().binding, new_b);
    }

    #[test]
    fn recoverable_source_retirement_keeps_holder_until_the_real_context_releases() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let a = binding("a", 3);
        manager.acquire(
            "a",
            a.clone(),
            ProfileLeasePriority::Interactive,
            3,
            now,
            |_, _| true,
        );
        manager.retire_source(&a.source_sidecar_id, a.source_generation, true, now);

        assert_eq!(manager.holder.as_ref().unwrap().binding, a);
        assert!(manager.reattach.is_none());
    }

    #[test]
    fn recoverable_waiter_keeps_order_when_the_session_source_restarts() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let a = binding("a", 3);
        let epoch_a = manager
            .acquire(
                "a",
                a.clone(),
                ProfileLeasePriority::Interactive,
                3,
                now,
                |_, _| true,
            )
            .lease_epoch
            .unwrap();
        let old_b = binding("b", 3);
        manager.acquire(
            "b-old",
            old_b.clone(),
            ProfileLeasePriority::Interactive,
            3,
            now + Duration::from_secs(1),
            |_, _| true,
        );
        manager.retire_source(
            &old_b.source_sidecar_id,
            old_b.source_generation,
            true,
            now + Duration::from_secs(2),
        );

        let mut new_b = old_b.clone();
        new_b.source_generation = 2;
        assert_eq!(
            manager
                .acquire(
                    "b-new",
                    new_b.clone(),
                    ProfileLeasePriority::Interactive,
                    3,
                    now + Duration::from_secs(3),
                    |_, _| true,
                )
                .queue_position,
            Some(1),
        );
        assert!(manager.release(&a, epoch_a, now + Duration::from_secs(4)));
        assert_eq!(manager.holder.as_ref().unwrap().binding, new_b);
    }

    #[test]
    fn terminal_source_keeps_holder_until_the_real_context_releases() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let a = binding("a", 3);
        let epoch_a = manager
            .acquire(
                "a",
                a.clone(),
                ProfileLeasePriority::Interactive,
                3,
                now,
                |_, _| true,
            )
            .lease_epoch
            .unwrap();
        manager.retire_source(&a.source_sidecar_id, a.source_generation, false, now);
        let b = binding("b", 3);
        assert_eq!(
            manager
                .acquire(
                    "b",
                    b.clone(),
                    ProfileLeasePriority::Interactive,
                    3,
                    now + Duration::from_secs(1),
                    |_, _| true,
                )
                .queue_position,
            Some(1),
        );
        assert_eq!(manager.holder.as_ref().unwrap().binding, a);
        assert!(manager.release(&a, epoch_a, now + Duration::from_secs(2)));
        assert_eq!(manager.holder.as_ref().unwrap().binding, b);
    }

    #[test]
    fn interactive_waiter_wins_then_aging_prevents_background_starvation() {
        let now = Instant::now();
        let mut manager = BrowserProfileLeaseManager::default();
        let holder = binding("holder", 3);
        let holder_epoch = manager
            .acquire(
                "holder",
                holder.clone(),
                ProfileLeasePriority::Interactive,
                3,
                now,
                |_, _| true,
            )
            .lease_epoch
            .unwrap();
        let background = binding("background", 3);
        manager.acquire(
            "background",
            background.clone(),
            ProfileLeasePriority::Background,
            3,
            now,
            |_, _| true,
        );
        let interactive = binding("interactive", 3);
        manager.acquire(
            "interactive",
            interactive.clone(),
            ProfileLeasePriority::Interactive,
            3,
            now + Duration::from_secs(1),
            |_, _| true,
        );
        assert!(manager.release(&holder, holder_epoch, now + Duration::from_secs(2)));
        assert_eq!(manager.holder.as_ref().unwrap().binding, interactive);

        let interactive_epoch = manager.holder.as_ref().unwrap().lease_epoch;
        let fresh_interactive = binding("fresh-interactive", 3);
        manager.acquire(
            "fresh-interactive",
            fresh_interactive,
            ProfileLeasePriority::Interactive,
            3,
            now + Duration::from_secs(31),
            |_, _| true,
        );
        assert!(manager.release(
            &interactive,
            interactive_epoch,
            now + Duration::from_secs(31),
        ));
        assert_eq!(manager.holder.as_ref().unwrap().binding, background);
    }
}
