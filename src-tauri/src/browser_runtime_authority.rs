use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CAPABILITY_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_CAPABILITIES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserCapabilityBinding {
    pub product_session_id: String,
    pub workspace_path: String,
    pub source_sidecar_id: String,
    pub source_generation: u64,
    pub host_generation: u64,
}

#[derive(Debug, Clone)]
struct StoredCapability {
    binding: BrowserCapabilityBinding,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct ProjectedProductSession {
    product_session_id: String,
    expires_at: Instant,
}

#[derive(Debug, Default)]
struct BrowserRuntimeAuthority {
    capabilities: HashMap<String, StoredCapability>,
    projected_product_sessions: HashMap<(String, u64), ProjectedProductSession>,
}

impl BrowserRuntimeAuthority {
    fn prune_expired(&mut self, now: Instant) {
        self.capabilities
            .retain(|_, capability| capability.expires_at > now);
        self.projected_product_sessions
            .retain(|_, projection| projection.expires_at > now);
        if self.capabilities.len() <= MAX_CAPABILITIES {
            return;
        }
        let mut by_expiry = self
            .capabilities
            .iter()
            .map(|(token, capability)| (token.clone(), capability.expires_at))
            .collect::<Vec<_>>();
        by_expiry.sort_by_key(|(_, expires_at)| *expires_at);
        for (token, _) in by_expiry
            .into_iter()
            .take(self.capabilities.len().saturating_sub(MAX_CAPABILITIES))
        {
            self.capabilities.remove(&token);
        }
    }

    fn issue(&mut self, mut binding: BrowserCapabilityBinding, now: Instant) -> String {
        self.prune_expired(now);
        let source = (binding.source_sidecar_id.clone(), binding.source_generation);
        if let Some(projection) = self.projected_product_sessions.get(&source) {
            if binding.product_session_id.starts_with("pending-")
                || binding.product_session_id == projection.product_session_id
            {
                binding.product_session_id = projection.product_session_id.clone();
            } else {
                self.projected_product_sessions.remove(&source);
            }
        }
        if let Some((token, capability)) = self
            .capabilities
            .iter_mut()
            .find(|(_, capability)| capability.binding == binding && capability.expires_at > now)
        {
            capability.expires_at = now + CAPABILITY_TTL;
            return token.clone();
        }

        let token = uuid::Uuid::new_v4().simple().to_string();
        self.capabilities.insert(
            token.clone(),
            StoredCapability {
                binding,
                expires_at: now + CAPABILITY_TTL,
            },
        );
        token
    }

    fn project_product_session(
        &mut self,
        source_sidecar_id: &str,
        source_generation: u64,
        current_session_id: &str,
        product_session_id: &str,
        now: Instant,
    ) -> bool {
        self.prune_expired(now);
        if current_session_id == product_session_id {
            return true;
        }
        if !current_session_id.starts_with("pending-") {
            return false;
        }
        let source = (source_sidecar_id.to_string(), source_generation);
        if let Some(existing) = self.projected_product_sessions.get(&source) {
            return existing.product_session_id == product_session_id;
        }
        self.projected_product_sessions.insert(
            source,
            ProjectedProductSession {
                product_session_id: product_session_id.to_string(),
                expires_at: now + CAPABILITY_TTL,
            },
        );
        for capability in self.capabilities.values_mut().filter(|capability| {
            capability.binding.source_sidecar_id == source_sidecar_id
                && capability.binding.source_generation == source_generation
        }) {
            capability.binding.product_session_id = product_session_id.to_string();
            capability.expires_at = now + CAPABILITY_TTL;
        }
        true
    }

    fn verify(
        &mut self,
        token: &str,
        current_host_generation: u64,
        now: Instant,
        resolve_source: impl FnOnce(&str, u64) -> Option<(String, String)>,
    ) -> Option<BrowserCapabilityBinding> {
        self.prune_expired(now);
        let capability = self.capabilities.get(token)?;
        if capability.binding.host_generation != current_host_generation {
            self.capabilities.remove(token);
            return None;
        }
        let (current_session_id, workspace_path) = resolve_source(
            &capability.binding.source_sidecar_id,
            capability.binding.source_generation,
        )?;
        let source = (
            capability.binding.source_sidecar_id.clone(),
            capability.binding.source_generation,
        );
        let product_session_id = match self.projected_product_sessions.get_mut(&source) {
            Some(projection)
                if current_session_id.starts_with("pending-")
                    || current_session_id == projection.product_session_id =>
            {
                projection.expires_at = now + CAPABILITY_TTL;
                projection.product_session_id.clone()
            }
            Some(_) => {
                self.projected_product_sessions.remove(&source);
                current_session_id
            }
            None => current_session_id,
        };
        if let Some(capability) = self.capabilities.get_mut(token) {
            capability.binding.product_session_id = product_session_id;
            capability.binding.workspace_path = workspace_path;
            // The credential is scoped to two live process generations. Keep
            // an actively used connection valid; the TTL only bounds unused
            // capabilities that never establish or already lost a client.
            capability.expires_at = now + CAPABILITY_TTL;
        }
        self.capabilities
            .get(token)
            .map(|capability| capability.binding.clone())
    }

}

fn authority() -> &'static Mutex<BrowserRuntimeAuthority> {
    static AUTHORITY: OnceLock<Mutex<BrowserRuntimeAuthority>> = OnceLock::new();
    AUTHORITY.get_or_init(|| Mutex::new(BrowserRuntimeAuthority::default()))
}

pub fn issue_browser_capability(binding: BrowserCapabilityBinding) -> String {
    authority()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .issue(binding, Instant::now())
}

pub fn project_browser_product_session(
    source_sidecar_id: &str,
    source_generation: u64,
    current_session_id: &str,
    product_session_id: &str,
) -> bool {
    authority()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .project_product_session(
            source_sidecar_id,
            source_generation,
            current_session_id,
            product_session_id,
            Instant::now(),
        )
}

pub fn verify_browser_capability(
    token: &str,
    current_host_generation: u64,
    resolve_source: impl FnOnce(&str, u64) -> Option<(String, String)>,
) -> Option<BrowserCapabilityBinding> {
    authority()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .verify(
            token,
            current_host_generation,
            Instant::now(),
            resolve_source,
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(source_generation: u64, host_generation: u64) -> BrowserCapabilityBinding {
        BrowserCapabilityBinding {
            product_session_id: "session-a".to_string(),
            workspace_path: "/workspace/a".to_string(),
            source_sidecar_id: "birth-a".to_string(),
            source_generation,
            host_generation,
        }
    }

    fn live_source(session: &str) -> Option<(String, String)> {
        Some((session.to_string(), "/workspace/a".to_string()))
    }

    #[test]
    fn coalesces_same_binding_and_fences_host_replacement() {
        let start = Instant::now();
        let mut authority = BrowserRuntimeAuthority::default();
        let first = authority.issue(binding(3, 9), start);
        let duplicate = authority.issue(binding(3, 9), start + Duration::from_secs(1));
        assert_eq!(first, duplicate);
        assert!(authority
            .verify(&first, 10, start + Duration::from_secs(2), |_, _| {
                live_source("session-a")
            })
            .is_none());
        assert!(authority
            .verify(&first, 9, start + Duration::from_secs(3), |_, _| {
                live_source("session-a")
            })
            .is_none());
    }

    #[test]
    fn rejects_expired_or_replaced_source_sidecar() {
        let start = Instant::now();
        let mut authority = BrowserRuntimeAuthority::default();
        let token = authority.issue(binding(3, 9), start);
        assert!(authority
            .verify(
                &token,
                9,
                start + Duration::from_secs(1),
                |_, generation| (generation == 3).then(|| live_source("session-a").unwrap())
            )
            .is_some());
        assert!(authority
            .verify(&token, 9, start + Duration::from_secs(2), |_, _| None)
            .is_none());

        let expired = authority.issue(binding(4, 9), start);
        assert!(authority
            .verify(&expired, 9, start + CAPABILITY_TTL, |_, _| live_source(
                "session-a"
            ))
            .is_none());
    }

    #[test]
    fn live_use_renews_the_capability_without_crossing_generation_fences() {
        let start = Instant::now();
        let mut authority = BrowserRuntimeAuthority::default();
        let token = authority.issue(binding(3, 9), start);
        assert!(authority
            .verify(
                &token,
                9,
                start + CAPABILITY_TTL - Duration::from_secs(1),
                |_, _| live_source("session-a"),
            )
            .is_some());
        assert!(authority
            .verify(
                &token,
                9,
                start + CAPABILITY_TTL + Duration::from_secs(1),
                |_, _| live_source("session-a"),
            )
            .is_some());
    }

    #[test]
    fn refreshes_pending_product_identity_from_the_rust_sidecar_owner() {
        let start = Instant::now();
        let mut authority = BrowserRuntimeAuthority::default();
        let token = authority.issue(binding(3, 9), start);
        let rebound = authority
            .verify(&token, 9, start + Duration::from_secs(1), |_, _| {
                live_source("session-real")
            })
            .expect("live source");
        assert_eq!(rebound.product_session_id, "session-real");
    }

    #[test]
    fn projects_future_runtime_identity_without_rekeying_the_pending_owner() {
        let start = Instant::now();
        let mut authority = BrowserRuntimeAuthority::default();
        assert!(authority.project_product_session(
            "birth-a",
            3,
            "pending-tab-a",
            "session-real",
            start,
        ));
        let token = authority.issue(
            BrowserCapabilityBinding {
                product_session_id: "pending-tab-a".to_string(),
                ..binding(3, 9)
            },
            start,
        );
        let before_materialization = authority
            .verify(&token, 9, start, |_, _| {
                Some(("pending-tab-a".to_string(), "/workspace/a".to_string()))
            })
            .expect("pending source remains live");
        assert_eq!(before_materialization.product_session_id, "session-real");

        let after_materialization = authority
            .verify(&token, 9, start, |_, _| live_source("session-real"))
            .expect("materialized source remains live");
        assert_eq!(after_materialization.product_session_id, "session-real");
    }

    #[test]
    fn rejects_competing_future_runtime_identities_for_one_process_birth() {
        let start = Instant::now();
        let mut authority = BrowserRuntimeAuthority::default();
        assert!(authority.project_product_session(
            "birth-a",
            3,
            "pending-tab-a",
            "session-real",
            start,
        ));
        assert!(!authority.project_product_session(
            "birth-a",
            3,
            "pending-tab-a",
            "session-other",
            start,
        ));
    }
}
