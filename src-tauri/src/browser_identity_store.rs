use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const IDENTITY_SCHEMA_VERSION: u32 = 1;
const IDENTITY_FILE_NAME: &str = "browser-identity-store.json";
const LEGACY_FILE_NAME: &str = "browser-storage-state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredIdentity {
    schema_version: u32,
    revision: u64,
    state: Value,
    key_revisions: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IdentitySnapshot {
    pub revision: u64,
    pub state: Value,
    pub recovery: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IdentityCheckpoint {
    pub revision: u64,
    pub state: Value,
    pub conflict_count: usize,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IdentityMutation {
    UpsertCookie {
        cookie: Value,
    },
    ReplaceCookie {
        previous_name: String,
        previous_domain: String,
        previous_path: String,
        cookie: Value,
    },
    DeleteCookie {
        name: String,
        domain: String,
        path: String,
    },
    DeleteOrigin {
        origin: String,
    },
}

fn empty_state() -> Value {
    json!({ "cookies": [], "origins": [] })
}

fn empty_store() -> StoredIdentity {
    StoredIdentity {
        schema_version: IDENTITY_SCHEMA_VERSION,
        revision: 0,
        state: empty_state(),
        key_revisions: BTreeMap::new(),
        recovery: None,
    }
}

fn encoded_key(kind: &str, parts: &[&str]) -> String {
    let encoded = parts
        .iter()
        .map(|part| URL_SAFE_NO_PAD.encode(part.as_bytes()))
        .collect::<Vec<_>>()
        .join(".");
    format!("{kind}:{encoded}")
}

fn required_string<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Browser identity {field} must be a non-empty string"))
}

fn object_without(object: &Map<String, Value>, field: &str) -> Value {
    Value::Object(
        object
            .iter()
            .filter(|(key, _)| key.as_str() != field)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

fn value_at_plain_key_path<'a>(value: &'a Value, key_path: &str) -> Option<&'a Value> {
    key_path
        .split('.')
        .try_fold(value, |current, part| current.as_object()?.get(part))
}

fn value_at_encoded_key_path<'a>(value: &'a Value, key_path: &str) -> Option<&'a Value> {
    key_path.split('.').try_fold(value, |current, part| {
        current
            .as_object()?
            .get("o")?
            .as_array()?
            .iter()
            .find_map(|property| {
                let property = property.as_object()?;
                (property.get("k")?.as_str()? == part)
                    .then(|| property.get("v"))
                    .flatten()
            })
    })
}

fn record_identity(store: &Map<String, Value>, record: &Value) -> Result<String, String> {
    let record_object = record
        .as_object()
        .ok_or_else(|| "Browser identity IndexedDB record must be an object".to_string())?;
    if let Some(key) = record_object
        .get("key")
        .or_else(|| record_object.get("keyEncoded"))
    {
        return serde_json::to_string(key)
            .map_err(|_| "Cannot serialize Browser identity IndexedDB key".to_string());
    }

    let key_paths = store
        .get("keyPathArray")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .map(|path| {
                    path.as_str()
                        .filter(|path| !path.is_empty())
                        .ok_or_else(|| {
                            "Browser identity IndexedDB keyPathArray must contain strings"
                                .to_string()
                        })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .or_else(|| {
            store
                .get("keyPath")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .map(|path| vec![path])
        })
        .ok_or_else(|| "Browser identity IndexedDB record is missing its key".to_string())?;
    let keys = if let Some(value) = record_object.get("value") {
        key_paths
            .iter()
            .map(|path| {
                value_at_plain_key_path(value, path)
                    .cloned()
                    .ok_or_else(|| "Browser identity IndexedDB inline key is missing".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    } else if let Some(value) = record_object.get("valueEncoded") {
        key_paths
            .iter()
            .map(|path| {
                value_at_encoded_key_path(value, path)
                    .cloned()
                    .ok_or_else(|| {
                        "Browser identity IndexedDB encoded inline key is missing".to_string()
                    })
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        return Err("Browser identity IndexedDB record is missing its value".to_string());
    };
    let identity = if keys.len() == 1 {
        keys.into_iter().next().expect("one inline IndexedDB key")
    } else {
        Value::Array(keys)
    };
    serde_json::to_string(&identity)
        .map_err(|_| "Cannot serialize Browser identity IndexedDB key".to_string())
}

/// Flatten Playwright storage state into conflict-addressable entities. Cookie
/// and localStorage keys are exact; IndexedDB records use database/store/key
/// identity while schema metadata remains separately versioned.
fn flatten_state(state: &Value) -> Result<BTreeMap<String, Value>, String> {
    let root = state
        .as_object()
        .ok_or_else(|| "Browser identity state must be an object".to_string())?;
    let cookies = root
        .get("cookies")
        .and_then(Value::as_array)
        .ok_or_else(|| "Browser identity cookies must be an array".to_string())?;
    let origins = root
        .get("origins")
        .and_then(Value::as_array)
        .ok_or_else(|| "Browser identity origins must be an array".to_string())?;
    let mut entities = BTreeMap::new();

    for cookie in cookies {
        let object = cookie
            .as_object()
            .ok_or_else(|| "Browser identity cookie must be an object".to_string())?;
        let name = required_string(object, "name")?;
        let domain = required_string(object, "domain")?;
        let path = required_string(object, "path")?;
        entities.insert(encoded_key("cookie", &[name, domain, path]), cookie.clone());
    }

    for origin_value in origins {
        let origin_object = origin_value
            .as_object()
            .ok_or_else(|| "Browser identity origin must be an object".to_string())?;
        let origin = required_string(origin_object, "origin")?;
        let local_storage = origin_object
            .get("localStorage")
            .and_then(Value::as_array)
            .ok_or_else(|| "Browser identity localStorage must be an array".to_string())?;
        for item in local_storage {
            let item_object = item.as_object().ok_or_else(|| {
                "Browser identity localStorage item must be an object".to_string()
            })?;
            let name = required_string(item_object, "name")?;
            if !item_object.get("value").is_some_and(Value::is_string) {
                return Err("Browser identity localStorage value must be a string".to_string());
            }
            entities.insert(
                encoded_key("local", &[origin, name]),
                json!({ "origin": origin, "item": item }),
            );
        }

        let indexed_db = origin_object
            .get("indexedDB")
            .map(|value| {
                value
                    .as_array()
                    .ok_or_else(|| "Browser identity indexedDB must be an array".to_string())
            })
            .transpose()?
            .cloned()
            .unwrap_or_default();
        for database in indexed_db {
            let database_object = database.as_object().ok_or_else(|| {
                "Browser identity IndexedDB database must be an object".to_string()
            })?;
            let database_name = required_string(database_object, "name")?;
            let stores = database_object
                .get("stores")
                .and_then(Value::as_array)
                .ok_or_else(|| "Browser identity IndexedDB stores must be an array".to_string())?;
            entities.insert(
                encoded_key("idb-db", &[origin, database_name]),
                json!({
                    "origin": origin,
                    "database": object_without(database_object, "stores"),
                }),
            );
            for store in stores {
                let store_object = store.as_object().ok_or_else(|| {
                    "Browser identity IndexedDB store must be an object".to_string()
                })?;
                let store_name = required_string(store_object, "name")?;
                let records = store_object
                    .get("records")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        "Browser identity IndexedDB records must be an array".to_string()
                    })?;
                entities.insert(
                    encoded_key("idb-store", &[origin, database_name, store_name]),
                    json!({
                        "origin": origin,
                        "databaseName": database_name,
                        "store": object_without(store_object, "records"),
                    }),
                );
                for record in records {
                    let identity = record_identity(store_object, record)?;
                    entities.insert(
                        encoded_key(
                            "idb-record",
                            &[origin, database_name, store_name, &identity],
                        ),
                        json!({
                            "origin": origin,
                            "databaseName": database_name,
                            "storeName": store_name,
                            "record": record,
                        }),
                    );
                }
            }
        }
    }
    Ok(entities)
}

fn wrapped_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .as_object()
        .and_then(|object| object.get(field))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Browser identity entity is missing {field}"))
}

fn wrapped_value<'a>(value: &'a Value, field: &str) -> Result<&'a Value, String> {
    value
        .as_object()
        .and_then(|object| object.get(field))
        .ok_or_else(|| format!("Browser identity entity is missing {field}"))
}

fn origin_delete_key(origin: &str) -> String {
    encoded_key("origin-delete", &[origin])
}

fn entity_origin(value: &Value) -> Option<&str> {
    value
        .as_object()
        .and_then(|object| object.get("origin"))
        .and_then(Value::as_str)
}

fn rebuild_state(entities: &BTreeMap<String, Value>) -> Result<Value, String> {
    let mut cookies = Vec::new();
    let mut local_by_origin: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut db_meta: BTreeMap<(String, String), Value> = BTreeMap::new();
    let mut store_meta: BTreeMap<(String, String, String), Value> = BTreeMap::new();
    let mut records: BTreeMap<(String, String, String), Vec<Value>> = BTreeMap::new();

    for (key, value) in entities {
        if key.starts_with("cookie:") {
            cookies.push(value.clone());
        } else if key.starts_with("local:") {
            local_by_origin
                .entry(wrapped_string(value, "origin")?.to_string())
                .or_default()
                .push(wrapped_value(value, "item")?.clone());
        } else if key.starts_with("idb-db:") {
            let origin = wrapped_string(value, "origin")?.to_string();
            let database = wrapped_value(value, "database")?.clone();
            let name = database
                .as_object()
                .ok_or_else(|| "Browser identity database metadata must be an object".to_string())
                .and_then(|object| required_string(object, "name").map(str::to_string))?;
            db_meta.insert((origin, name), database);
        } else if key.starts_with("idb-store:") {
            let origin = wrapped_string(value, "origin")?.to_string();
            let database_name = wrapped_string(value, "databaseName")?.to_string();
            let store = wrapped_value(value, "store")?.clone();
            let store_name = store
                .as_object()
                .ok_or_else(|| "Browser identity store metadata must be an object".to_string())
                .and_then(|object| required_string(object, "name").map(str::to_string))?;
            store_meta.insert((origin, database_name, store_name), store);
        } else if key.starts_with("idb-record:") {
            records
                .entry((
                    wrapped_string(value, "origin")?.to_string(),
                    wrapped_string(value, "databaseName")?.to_string(),
                    wrapped_string(value, "storeName")?.to_string(),
                ))
                .or_default()
                .push(wrapped_value(value, "record")?.clone());
        }
    }

    let mut origin_names = BTreeSet::new();
    origin_names.extend(local_by_origin.keys().cloned());
    origin_names.extend(db_meta.keys().map(|(origin, _)| origin.clone()));
    let mut origins = Vec::new();
    for origin in origin_names {
        let mut databases = Vec::new();
        for ((db_origin, db_name), db_value) in &db_meta {
            if db_origin != &origin {
                continue;
            }
            let mut database = db_value.as_object().cloned().ok_or_else(|| {
                "Browser identity database metadata must be an object".to_string()
            })?;
            let mut stores = Vec::new();
            for ((store_origin, store_db_name, store_name), store_value) in &store_meta {
                if store_origin != &origin || store_db_name != db_name {
                    continue;
                }
                let mut store = store_value.as_object().cloned().ok_or_else(|| {
                    "Browser identity store metadata must be an object".to_string()
                })?;
                store.insert(
                    "records".to_string(),
                    Value::Array(
                        records
                            .get(&(origin.clone(), db_name.clone(), store_name.clone()))
                            .cloned()
                            .unwrap_or_default(),
                    ),
                );
                stores.push(Value::Object(store));
            }
            database.insert("stores".to_string(), Value::Array(stores));
            databases.push(Value::Object(database));
        }
        origins.push(json!({
            "origin": origin,
            "localStorage": local_by_origin.remove(&origin).unwrap_or_default(),
            "indexedDB": databases,
        }));
    }
    Ok(json!({ "cookies": cookies, "origins": origins }))
}

fn identity_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine user home".to_string())?;
    let root = home.join(".myagents");
    fs::create_dir_all(&root)
        .map_err(|_| "Cannot create Browser Identity Store root".to_string())?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|_| "Cannot inspect Browser Identity Store root".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Browser Identity Store root is not a trusted directory".to_string());
    }
    let canonical_home =
        fs::canonicalize(home).map_err(|_| "Cannot resolve user home".to_string())?;
    let canonical_root = fs::canonicalize(&root)
        .map_err(|_| "Cannot resolve Browser Identity Store root".to_string())?;
    if !canonical_root.starts_with(canonical_home) {
        return Err("Browser Identity Store root escapes the user home".to_string());
    }
    Ok(root)
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("Browser Identity Store target is not a regular file".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot inspect Browser Identity Store target".to_string()),
    }
}

fn synced_atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    reject_symlink(path)?;
    let temp = path.with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4().simple()));
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|_| "Cannot create Browser Identity Store temp file".to_string())?
    };
    #[cfg(not(unix))]
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|_| "Cannot create Browser Identity Store temp file".to_string())?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Cannot persist Browser Identity Store: {error}"));
    }
    drop(file);
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Cannot commit Browser Identity Store: {error}"));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "Cannot sync Browser Identity Store directory".to_string())?;
    }
    Ok(())
}

fn quarantine(path: &Path) {
    let quarantine =
        path.with_extension(format!("json.quarantine-{}", uuid::Uuid::new_v4().simple()));
    let _ = fs::rename(path, quarantine);
}

fn load_store() -> Result<(PathBuf, StoredIdentity), String> {
    let root = identity_root()?;
    let path = root.join(IDENTITY_FILE_NAME);
    let mut current_corrupt = false;
    reject_symlink(&path)?;
    if path.exists() {
        let bytes =
            fs::read(&path).map_err(|_| "Cannot read Browser Identity Store".to_string())?;
        let stored = serde_json::from_slice::<StoredIdentity>(&bytes)
            .ok()
            .filter(|stored| stored.schema_version == IDENTITY_SCHEMA_VERSION)
            .filter(|stored| flatten_state(&stored.state).is_ok());
        if let Some(stored) = stored {
            return Ok((path, stored));
        }
        quarantine(&path);
        current_corrupt = true;
    }

    let legacy_path = root.join(LEGACY_FILE_NAME);
    let mut stored = empty_store();
    if current_corrupt {
        stored.recovery = Some("corrupt-current".to_string());
    }
    let mut migrated_legacy_backup = None;
    if legacy_path.exists() {
        reject_symlink(&legacy_path)?;
        let imported = fs::read(&legacy_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|state| flatten_state(state).is_ok());
        if let Some(state) = imported {
            stored.revision = 1;
            stored.state = state;
            stored.key_revisions = flatten_state(&stored.state)?
                .into_keys()
                .map(|key| (key, 1))
                .collect();
            let backup = root.join("browser-storage-state.migrated-0.4.10.json");
            if !backup.exists() {
                migrated_legacy_backup = Some(backup);
            }
        } else {
            quarantine(&legacy_path);
            if stored.recovery.is_none() {
                stored.recovery = Some("corrupt-legacy".to_string());
            }
        }
    }
    persist_store(&path, &stored)?;
    // Publish and sync the new authority before retiring its only valid
    // source. A crash or disk failure before this point leaves the legacy file
    // available for the next startup to retry.
    if let Some(backup) = migrated_legacy_backup {
        let _ = fs::rename(&legacy_path, backup);
    }
    Ok((path, stored))
}

fn persist_store(path: &Path, stored: &StoredIdentity) -> Result<(), String> {
    let bytes = serde_json::to_vec(stored)
        .map_err(|_| "Cannot serialize Browser Identity Store".to_string())?;
    synced_atomic_write(path, &bytes)
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn read_identity() -> Result<IdentitySnapshot, String> {
    let _guard = store_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_, stored) = load_store()?;
    Ok(IdentitySnapshot {
        revision: stored.revision,
        state: stored.state,
        recovery: stored.recovery,
    })
}

fn merge_checkpoint(
    mut stored: StoredIdentity,
    base_revision: u64,
    base_state: &Value,
    observed_base_state: &Value,
    proposed_state: &Value,
) -> Result<(StoredIdentity, usize, bool), String> {
    if base_revision > stored.revision {
        return Err("Browser identity base revision is from the future".to_string());
    }
    let base = flatten_state(base_state)?;
    let observed_base = flatten_state(observed_base_state)?;
    let proposed = flatten_state(proposed_state)?;
    let mut current = flatten_state(&stored.state)?;
    if base_revision == stored.revision && base != current {
        return Err("Browser identity base does not match its revision".to_string());
    }

    let changed_keys = observed_base
        .keys()
        .chain(proposed.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| observed_base.get(*key) != proposed.get(*key))
        .cloned()
        .collect::<Vec<_>>();
    if changed_keys.is_empty() {
        return Ok((stored, 0, false));
    }

    let next_revision = stored.revision.saturating_add(1);
    let mut conflict_count = 0;
    let mut applied = false;
    for key in changed_keys {
        let direct_conflict = stored
            .key_revisions
            .get(&key)
            .is_some_and(|revision| *revision > base_revision);
        let origin_conflict = proposed
            .get(&key)
            .or_else(|| observed_base.get(&key))
            .and_then(entity_origin)
            .and_then(|origin| stored.key_revisions.get(&origin_delete_key(origin)))
            .is_some_and(|revision| *revision > base_revision);
        if direct_conflict || origin_conflict {
            conflict_count += 1;
            continue;
        }
        if let Some(value) = proposed.get(&key) {
            current.insert(key.clone(), value.clone());
        } else {
            current.remove(&key);
        }
        stored.key_revisions.insert(key, next_revision);
        applied = true;
    }
    if applied {
        stored.revision = next_revision;
        stored.state = rebuild_state(&current)?;
    }
    Ok((stored, conflict_count, applied))
}

pub fn checkpoint_identity(
    base_revision: u64,
    base_state: &Value,
    observed_base_state: &Value,
    proposed_state: &Value,
) -> Result<IdentityCheckpoint, String> {
    let _guard = store_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (path, stored) = load_store()?;
    let (stored, conflict_count, applied) = merge_checkpoint(
        stored,
        base_revision,
        base_state,
        observed_base_state,
        proposed_state,
    )?;
    if applied {
        persist_store(&path, &stored)?;
    }
    Ok(IdentityCheckpoint {
        revision: stored.revision,
        state: stored.state,
        conflict_count,
    })
}

fn apply_mutation(
    mut stored: StoredIdentity,
    mutation: IdentityMutation,
) -> Result<(StoredIdentity, bool), String> {
    let mut entities = flatten_state(&stored.state)?;
    let next_revision = stored.revision.saturating_add(1);
    let mut changed_keys = Vec::new();

    match mutation {
        IdentityMutation::UpsertCookie { cookie } => {
            let cookie_object = cookie
                .as_object()
                .ok_or_else(|| "Browser identity cookie must be an object".to_string())?;
            let key = encoded_key(
                "cookie",
                &[
                    required_string(cookie_object, "name")?,
                    required_string(cookie_object, "domain")?,
                    required_string(cookie_object, "path")?,
                ],
            );
            if entities.get(&key) != Some(&cookie) {
                entities.insert(key.clone(), cookie);
                changed_keys.push(key);
            }
        }
        IdentityMutation::ReplaceCookie {
            previous_name,
            previous_domain,
            previous_path,
            cookie,
        } => {
            let cookie_object = cookie
                .as_object()
                .ok_or_else(|| "Browser identity cookie must be an object".to_string())?;
            let next_key = encoded_key(
                "cookie",
                &[
                    required_string(cookie_object, "name")?,
                    required_string(cookie_object, "domain")?,
                    required_string(cookie_object, "path")?,
                ],
            );
            let previous_key = encoded_key(
                "cookie",
                &[&previous_name, &previous_domain, &previous_path],
            );
            if previous_key != next_key {
                entities.remove(&previous_key);
                changed_keys.push(previous_key);
            }
            if entities.get(&next_key) != Some(&cookie) {
                entities.insert(next_key.clone(), cookie);
                changed_keys.push(next_key);
            }
        }
        IdentityMutation::DeleteCookie { name, domain, path } => {
            let key = encoded_key("cookie", &[&name, &domain, &path]);
            entities.remove(&key);
            // Always write a tombstone. A Context created before a cookie
            // existed must not resurrect it after the user explicitly deletes
            // that exact cookie from Settings.
            changed_keys.push(key);
        }
        IdentityMutation::DeleteOrigin { origin } => {
            let keys = entities
                .iter()
                .filter_map(|(key, value)| {
                    if key.starts_with("local:")
                        || key.starts_with("idb-db:")
                        || key.starts_with("idb-store:")
                        || key.starts_with("idb-record:")
                    {
                        (wrapped_string(value, "origin").ok() == Some(origin.as_str()))
                            .then(|| key.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            for key in keys {
                entities.remove(&key);
                changed_keys.push(key);
            }
            // Blocks stale Contexts whose base predates every key at this
            // origin from re-introducing localStorage/IndexedDB state.
            changed_keys.push(origin_delete_key(&origin));
        }
    }

    if changed_keys.is_empty() {
        return Ok((stored, false));
    }
    stored.revision = next_revision;
    for key in changed_keys {
        stored.key_revisions.insert(key, next_revision);
    }
    stored.state = rebuild_state(&entities)?;
    Ok((stored, true))
}

pub fn mutate_identity(
    base_revision: u64,
    mutation: IdentityMutation,
) -> Result<IdentitySnapshot, String> {
    let _guard = store_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (path, stored) = load_store()?;
    if stored.revision != base_revision {
        return Err("BROWSER_IDENTITY_REVISION_CONFLICT".to_string());
    }
    let (stored, changed) = apply_mutation(stored, mutation)?;
    if changed {
        persist_store(&path, &stored)?;
    }
    Ok(IdentitySnapshot {
        revision: stored.revision,
        state: stored.state,
        recovery: stored.recovery,
    })
}

pub fn identity_settings_projection(snapshot: &IdentitySnapshot) -> Value {
    let cookies = snapshot
        .state
        .get("cookies")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|cookie| {
            json!({
                "name": cookie.get("name").and_then(Value::as_str).unwrap_or_default(),
                "domain": cookie.get("domain").and_then(Value::as_str).unwrap_or_default(),
                "path": cookie.get("path").and_then(Value::as_str).unwrap_or("/"),
                "secure": cookie.get("secure").and_then(Value::as_bool).unwrap_or(false),
                "httpOnly": cookie.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
                "expires": cookie.get("expires").and_then(Value::as_f64).unwrap_or(-1.0),
                "sameSite": cookie.get("sameSite").and_then(Value::as_str).unwrap_or("Lax"),
            })
        })
        .collect::<Vec<_>>();
    let domains = cookies
        .iter()
        .filter_map(|cookie| cookie.get("domain").and_then(Value::as_str))
        .map(|domain| domain.trim_start_matches('.').to_string())
        .filter(|domain| !domain.is_empty())
        .collect::<BTreeSet<_>>();
    let origins = snapshot
        .state
        .get("origins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|origin| origin.get("origin").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    json!({
        "revision": snapshot.revision,
        "exists": snapshot.revision > 0,
        "cookieCount": cookies.len(),
        "domains": domains,
        "cookies": cookies,
        "origins": origins,
        "recovery": snapshot.recovery,
    })
}

#[tauri::command]
pub fn cmd_browser_identity_read() -> Result<Value, String> {
    read_identity().map(|snapshot| identity_settings_projection(&snapshot))
}

#[tauri::command]
pub fn cmd_browser_identity_mutate(
    base_revision: u64,
    mutation: IdentityMutation,
) -> Result<Value, String> {
    mutate_identity(base_revision, mutation).map(|snapshot| identity_settings_projection(&snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(cookie: Option<&str>, local: Option<(&str, &str)>) -> Value {
        json!({
            "cookies": cookie.map(|value| vec![json!({
                "name": "sid", "value": value, "domain": ".example.com", "path": "/",
                "expires": -1, "httpOnly": true, "secure": true, "sameSite": "Lax"
            })]).unwrap_or_default(),
            "origins": local.map(|(name, value)| vec![json!({
                "origin": "https://example.org",
                "localStorage": [{ "name": name, "value": value }],
                "indexedDB": []
            })]).unwrap_or_default()
        })
    }

    #[test]
    fn entity_merge_preserves_unrelated_session_changes() {
        let base = state(None, None);
        let cookie = state(Some("a"), None);
        let local = state(None, Some(("token", "b")));
        let mut current = flatten_state(&base).unwrap();
        for (key, value) in flatten_state(&cookie).unwrap() {
            current.insert(key, value);
        }
        for (key, value) in flatten_state(&local).unwrap() {
            current.insert(key, value);
        }
        let rebuilt = rebuild_state(&current).unwrap();
        assert_eq!(flatten_state(&rebuilt).unwrap(), current);
    }

    #[test]
    fn indexed_db_records_have_independent_keys() {
        let state = json!({
            "cookies": [],
            "origins": [{
                "origin": "https://idb.example",
                "localStorage": [],
                "indexedDB": [{
                    "name": "auth", "version": 1,
                    "stores": [{
                        "name": "tokens", "keyPath": "id", "autoIncrement": false, "indexes": [],
                        "records": [
                            { "value": { "id": "a", "token": "one" } },
                            { "value": { "id": "b", "token": "two" } }
                        ]
                    }]
                }]
            }]
        });
        let flat = flatten_state(&state).unwrap();
        assert_eq!(
            flat.keys()
                .filter(|key| key.starts_with("idb-record:"))
                .count(),
            2
        );
        assert_eq!(flatten_state(&rebuild_state(&flat).unwrap()).unwrap(), flat);
    }

    #[test]
    fn indexed_db_compound_and_encoded_inline_keys_ignore_non_key_updates() {
        let compound_store = json!({
            "keyPathArray": ["tenant", "identity.id"]
        });
        let compound_store = compound_store.as_object().unwrap();
        let before = json!({
            "value": { "tenant": "a", "identity": { "id": 7 }, "token": "old" }
        });
        let after = json!({
            "value": { "tenant": "a", "identity": { "id": 7 }, "token": "new" }
        });
        assert_eq!(
            record_identity(compound_store, &before).unwrap(),
            record_identity(compound_store, &after).unwrap(),
        );

        let encoded_store = json!({ "keyPath": "id" });
        let encoded_store = encoded_store.as_object().unwrap();
        let encoded_before = json!({
            "valueEncoded": { "o": [
                { "k": "id", "v": { "d": "2026-08-22T00:00:00.000Z" } },
                { "k": "token", "v": "old" }
            ], "id": 1 }
        });
        let encoded_after = json!({
            "valueEncoded": { "o": [
                { "k": "id", "v": { "d": "2026-08-22T00:00:00.000Z" } },
                { "k": "token", "v": "new" }
            ], "id": 1 }
        });
        assert_eq!(
            record_identity(encoded_store, &encoded_before).unwrap(),
            record_identity(encoded_store, &encoded_after).unwrap(),
        );
    }

    #[test]
    fn settings_projection_excludes_cookie_and_site_storage_values() {
        let snapshot = IdentitySnapshot {
            revision: 4,
            state: state(
                Some("secret-cookie-value"),
                Some(("token", "secret-local-value")),
            ),
            recovery: Some("corrupt-current".to_string()),
        };
        let projection = identity_settings_projection(&snapshot);
        let encoded = serde_json::to_string(&projection).unwrap();
        assert!(!encoded.contains("secret-cookie-value"));
        assert!(!encoded.contains("secret-local-value"));
        assert_eq!(projection["cookieCount"], 1);
        assert_eq!(projection["recovery"], "corrupt-current");
    }

    #[test]
    fn newer_key_revision_blocks_stale_delete() {
        let base_state = state(Some("old"), None);
        let newer_state = state(Some("new"), None);
        let key = flatten_state(&base_state)
            .unwrap()
            .into_keys()
            .next()
            .unwrap();
        let stored = StoredIdentity {
            schema_version: 1,
            revision: 3,
            state: newer_state.clone(),
            key_revisions: BTreeMap::from([(key, 3)]),
            recovery: None,
        };
        let (merged, conflicts, applied) =
            merge_checkpoint(stored, 1, &base_state, &base_state, &state(None, None)).unwrap();
        assert_eq!(conflicts, 1);
        assert!(!applied);
        assert_eq!(merged.state, newer_state);
    }

    #[test]
    fn rejected_context_value_is_not_replayed_when_the_context_is_unchanged() {
        let original = state(Some("original"), None);
        let stale_context = state(Some("stale"), None);
        let winning_store = state(Some("winner"), None);
        let key = flatten_state(&winning_store)
            .unwrap()
            .into_keys()
            .next()
            .unwrap();
        let stored = StoredIdentity {
            schema_version: 1,
            revision: 2,
            state: winning_store.clone(),
            key_revisions: BTreeMap::from([(key, 2)]),
            recovery: None,
        };

        let (after_conflict, conflicts, applied) =
            merge_checkpoint(stored, 1, &original, &original, &stale_context).unwrap();
        assert_eq!(conflicts, 1);
        assert!(!applied);

        let (after_unchanged, conflicts, applied) = merge_checkpoint(
            after_conflict,
            2,
            &winning_store,
            &stale_context,
            &stale_context,
        )
        .unwrap();
        assert_eq!(conflicts, 0);
        assert!(!applied);
        assert_eq!(after_unchanged.state, winning_store);
    }

    #[test]
    fn stale_sessions_merge_different_entities() {
        let base_state = state(None, None);
        let first = state(Some("cookie"), None);
        let initial = StoredIdentity {
            schema_version: 1,
            revision: 0,
            state: base_state.clone(),
            key_revisions: BTreeMap::new(),
            recovery: None,
        };
        let (after_first, conflicts, applied) =
            merge_checkpoint(initial, 0, &base_state, &base_state, &first).unwrap();
        assert_eq!(conflicts, 0);
        assert!(applied);

        let second = state(None, Some(("token", "local")));
        let (after_second, conflicts, applied) =
            merge_checkpoint(after_first, 0, &base_state, &base_state, &second).unwrap();
        assert_eq!(conflicts, 0);
        assert!(applied);
        let entities = flatten_state(&after_second.state).unwrap();
        assert_eq!(
            entities
                .keys()
                .filter(|key| key.starts_with("cookie:"))
                .count(),
            1
        );
        assert_eq!(
            entities
                .keys()
                .filter(|key| key.starts_with("local:"))
                .count(),
            1
        );
    }

    #[test]
    fn replacing_a_cookie_key_tombstones_the_previous_identity() {
        let base_state = state(Some("old"), None);
        let old_key = flatten_state(&base_state)
            .unwrap()
            .into_keys()
            .next()
            .unwrap();
        let stored = StoredIdentity {
            schema_version: 1,
            revision: 1,
            state: base_state.clone(),
            key_revisions: BTreeMap::from([(old_key.clone(), 1)]),
            recovery: None,
        };
        let replacement = json!({
            "name": "renamed", "value": "new", "domain": ".example.com", "path": "/",
            "expires": -1, "httpOnly": true, "secure": true, "sameSite": "Lax"
        });
        let (replaced, changed) = apply_mutation(
            stored,
            IdentityMutation::ReplaceCookie {
                previous_name: "sid".to_string(),
                previous_domain: ".example.com".to_string(),
                previous_path: "/".to_string(),
                cookie: replacement,
            },
        )
        .unwrap();
        assert!(changed);
        assert_eq!(replaced.revision, 2);
        assert_eq!(replaced.key_revisions.get(&old_key), Some(&2));

        let stale_base = state(None, None);
        let (merged, conflicts, applied) =
            merge_checkpoint(replaced.clone(), 0, &stale_base, &stale_base, &base_state).unwrap();
        assert_eq!(conflicts, 1);
        assert!(!applied);
        assert_eq!(merged.state, replaced.state);
        let cookies = replaced.state["cookies"].as_array().unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0]["name"], "renamed");
    }
}
