use std::collections::HashSet;

use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

pub const MAX_SESSION_USER_TAGS: usize = 5;
pub const MAX_SESSION_USER_TAG_CODE_POINTS: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedSessionUserTag {
    pub name: String,
    pub identity: String,
}

pub fn normalize_session_user_tag(input: &str) -> Option<NormalizedSessionUserTag> {
    let name: String = input.trim().nfc().collect();
    if name.is_empty()
        || name.chars().count() > MAX_SESSION_USER_TAG_CODE_POINTS
        || name.chars().any(char::is_control)
    {
        return None;
    }
    let identity = name.to_lowercase();
    Some(NormalizedSessionUserTag { name, identity })
}

pub fn sanitize_session_user_tags(value: Option<&Value>) -> Vec<String> {
    let Some(values) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut tags = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let Some(tag) = value.as_str().and_then(normalize_session_user_tag) else {
            continue;
        };
        if !seen.insert(tag.identity) {
            continue;
        }
        tags.push(tag.name);
        if tags.len() == MAX_SESSION_USER_TAGS {
            break;
        }
    }
    tags
}

pub fn project_sanitized_session_user_tags(session: &mut Map<String, Value>) {
    let tags = sanitize_session_user_tags(session.get("userTags"));
    if tags.is_empty() {
        session.remove("userTags");
    } else {
        session.insert(
            "userTags".to_string(),
            Value::Array(tags.into_iter().map(Value::String).collect()),
        );
    }
}

pub fn session_has_user_tag(session: &Value, requested_name: &str) -> bool {
    let Some(requested) = normalize_session_user_tag(requested_name) else {
        return false;
    };
    sanitize_session_user_tags(session.get("userTags"))
        .iter()
        .any(|name| name.to_lowercase() == requested.identity)
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_session_user_tag, project_sanitized_session_user_tags,
        sanitize_session_user_tags, session_has_user_tag, MAX_SESSION_USER_TAG_CODE_POINTS,
    };
    use serde_json::{json, Value};

    #[test]
    fn normalization_matches_the_shared_contract() {
        assert_eq!(
            normalize_session_user_tag("  Cafe\u{301}  ").map(|tag| (tag.name, tag.identity)),
            Some(("Café".to_string(), "café".to_string()))
        );
        assert!(
            normalize_session_user_tag(&"😀".repeat(MAX_SESSION_USER_TAG_CODE_POINTS)).is_some()
        );
        assert!(
            normalize_session_user_tag(&"😀".repeat(MAX_SESSION_USER_TAG_CODE_POINTS + 1))
                .is_none()
        );
        assert!(normalize_session_user_tag("line\nbreak").is_none());
    }

    #[test]
    fn malformed_metadata_is_sanitized_without_hiding_the_session() {
        let mut session = json!({
            "id": "session-1",
            "userTags": [" Alpha ", "alpha", 42, "", "Beta", "Gamma", "Delta", "Epsilon", "Sixth"]
        });
        let tags = sanitize_session_user_tags(session.get("userTags"));
        assert_eq!(tags, vec!["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]);
        project_sanitized_session_user_tags(session.as_object_mut().unwrap());
        assert_eq!(
            session.get("userTags"),
            Some(&json!(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]))
        );
        assert!(session_has_user_tag(&session, " alpha "));

        let mut empty = json!({ "id": "session-2", "userTags": "bad" });
        project_sanitized_session_user_tags(empty.as_object_mut().unwrap());
        assert_eq!(empty.get("userTags"), None::<&Value>);
    }
}
