use crate::core::{Core, integer, now_ms, text};
use crate::proto::{ErrorCode, RpcError};
use crate::state::{ConnectionId, Mode};
use crate::store::{Row, SqlValue};
use crate::views::{address, opt, presence};
use rand::RngCore;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub fn valid_handle(value: &str) -> bool {
    !matches!(value, "user" | "me" | "relay") && valid_name(value, 63, b"._-")
}
pub fn valid_harness(value: &str) -> bool {
    valid_name(value, 32, b"-")
}
pub fn valid_label(value: &str) -> bool {
    valid_name(value, 32, b"._-")
}
fn valid_name(value: &str, max: usize, punct: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0]
            .is_ascii_lowercase()
            .then_some(())
            .or_else(|| value.as_bytes()[0].is_ascii_digit().then_some(()))
            .is_some()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || punct.contains(&b))
}
pub fn generic(harness: Option<&str>) -> bool {
    harness.is_none_or(|v| matches!(v, "cli" | "hook" | "mcp" | "shell"))
}
pub fn harness_fits(held: Option<&str>, claimed: &str) -> bool {
    held == Some(claimed) || generic(held)
}
pub fn same_provider(held: Option<&str>, claimed: &str) -> bool {
    held.is_some_and(|v| v.split('-').next() == claimed.split('-').next())
}
pub fn process_key(value: &str, full: bool) -> bool {
    let Some(raw) = value.strip_prefix("pid:") else {
        return false;
    };
    let (pid, start) = raw
        .split_once(':')
        .map_or((raw, None), |(p, s)| (p, Some(s)));
    !pid.is_empty()
        && pid.bytes().all(|b| b.is_ascii_digit())
        && match start {
            None => !full,
            Some(v) => {
                !v.is_empty()
                    && v.len() <= 64
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-')
            }
        }
}
pub fn same_harness(a: &str, b: &str) -> bool {
    a == b
        || (process_key(a, false) && !process_key(a, true) && b.starts_with(&format!("{a}:")))
        || (process_key(b, false) && !process_key(b, true) && a.starts_with(&format!("{b}:")))
}
pub fn harness_session(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
pub fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub fn token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}
pub fn valid_token(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn clean_text(
    value: Option<&Value>,
    field: &str,
    max: usize,
) -> Result<Option<String>, RpcError> {
    crate::session::clean_text(value, field, max as u64)
}
pub fn clean_labels(value: Option<&Value>) -> Result<Value, RpcError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(json!({}));
    };
    let labels = value
        .as_object()
        .ok_or_else(|| RpcError::invalid_params("labels must be an object of strings"))?;
    if labels.len() > 16 {
        return Err(RpcError::new(ErrorCode::TooLarge, "at most 16 labels"));
    }
    let mut out = Map::new();
    for (key, value) in labels {
        if !valid_label(key) {
            return Err(RpcError::invalid_params("label is not a valid name"));
        }
        out.insert(
            key.clone(),
            json!(clean_text(Some(value), key, 128)?.unwrap_or_default()),
        );
    }
    Ok(Value::Object(out))
}
pub fn lineage_keys(value: Option<&Value>) -> Result<Vec<String>, RpcError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| RpcError::invalid_params("lineage is a list of process keys"))?;
    if values
        .iter()
        .any(|v| v.as_str().is_none_or(|s| s.len() > 128))
    {
        return Err(RpcError::invalid_params(
            "lineage is a list of process keys",
        ));
    }
    Ok(values
        .iter()
        .take(16)
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect())
}

pub fn revivable(row: &Row) -> bool {
    text(row, "kind") == Some("agent")
        && text(row, "hibernate").is_some()
        && text(row, "revive").is_some()
}

pub fn busy_since(row: &Row, since: i64, created: bool, now: i64, grace_ms: i64) -> bool {
    let seen = integer(row, "hook_seen").unwrap_or(0);
    seen > since || (created && seen >= now - grace_ms)
}

struct Claimed {
    row: Row,
    resume: Option<String>,
    retired: Option<String>,
    created: bool,
    subagent: bool,
}

#[derive(Clone)]
struct Fields {
    model: Option<String>,
    cwd: Option<String>,
    parent: Option<String>,
    labels: Value,
    session: Option<String>,
    process: Option<String>,
    harness_session: Option<String>,
    harness_origin: Option<String>,
    harness_handoff: bool,
    under: Option<String>,
}
#[derive(Clone)]
struct Scope {
    handle: String,
    lineage: Vec<String>,
    grant: Option<String>,
    nearest: Option<String>,
    rules: Value,
    exact: bool,
    subagent: Option<Subagent>,
}
#[derive(Clone)]
struct Subagent {
    kind: Option<String>,
    root: String,
}
struct Placement {
    parent: Option<Row>,
    grant: Option<Row>,
}

impl Core {
    pub async fn lineage_rows(
        &self,
        keys: &[String],
        exclude: &[&str],
    ) -> Result<Vec<Row>, RpcError> {
        if self
            .policy
            .as_ref()
            .and_then(|v| v.pointer("/defaults/verifyLineage"))
            == Some(&Value::Bool(true))
        {
            return Ok(Vec::new());
        }
        for key in keys.iter().filter(|v| process_key(v, true)) {
            let rows=self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND process = ? AND substr(handle,1,5) != 'gone:' ORDER BY COALESCE(depth,0),created_at,id", &[opt(Some(key))]).await?;
            let mut out = Vec::new();
            for row in rows {
                if exclude.contains(&text(&row, "id").unwrap_or("")) {
                    continue;
                }
                if self
                    .ancestors(&row)
                    .await?
                    .iter()
                    .any(|id| exclude.contains(&id.as_str()))
                {
                    continue;
                }
                out.push(row);
            }
            if !out.is_empty() {
                return Ok(out);
            }
        }
        Ok(Vec::new())
    }
    pub async fn place_lineage(
        &self,
        value: Option<&Value>,
        handle: Option<&str>,
        session: Option<&str>,
    ) -> Result<Option<String>, RpcError> {
        let rows = self.lineage_rows(&lineage_keys(value)?, &[]).await?;
        let found = if let Some(handle) = handle {
            rows.iter().find(|r| text(r, "handle") == Some(handle))
        } else if let Some(session) = session {
            rows.iter()
                .find(|r| text(r, "harness_session") == Some(session))
                .or_else(|| rows.iter().find(|r| text(r, "harness_session").is_none()))
        } else {
            rows.first()
        };
        Ok(found.and_then(|r| text(r, "id")).map(str::to_owned))
    }
    pub async fn grant_binds(&self, value: &Value, id: Option<&str>) -> Result<bool, RpcError> {
        let raw = value
            .as_str()
            .filter(|s| valid_token(s, "krt_"))
            .ok_or_else(|| RpcError::invalid_params("grant is a krt_ token"))?;
        let grant=self.store.all("SELECT * FROM grants WHERE token_hash = ? AND used_by IS NOT NULL AND revoked_at IS NULL", &[opt(Some(&hash(raw)))]).await?.into_iter().next();
        let Some(spender) = grant.as_ref().and_then(|r| text(r, "used_by")) else {
            return Ok(false);
        };
        let Some(id) = id else {
            return Ok(false);
        };
        if id == spender {
            return Ok(true);
        }
        Ok(self
            .ancestors(&self.must_endpoint(id).await?)
            .await?
            .iter()
            .any(|v| v == spender))
    }
    pub async fn end_exited(&self) -> Result<(), RpcError> {
        let rows=self.store.all("SELECT id,process FROM endpoints WHERE kind = 'agent' AND connections = 0 AND hook_seen IS NOT NULL AND process IS NOT NULL",&[]).await?;
        for row in rows {
            if let Some(key) = text(&row, "process")
                && let Some(pid) = key
                    .strip_prefix("pid:")
                    .and_then(|key| key.split(':').next())
                    .filter(|pid| {
                        !pid.is_empty()
                            && pid.bytes().all(|byte| byte.is_ascii_digit())
                            && *pid != "0"
                    })
                && !self.procs.alive(&format!("pid:{pid}")).await
            {
                self.store.all("UPDATE endpoints SET hook_seen = NULL, hook_ended = ?, session = NULL WHERE id = ? AND connections = 0", &[SqlValue::Int(now_ms()),opt(text(&row,"id"))]).await?;
            }
        }
        Ok(())
    }
    pub async fn released(&self, row: &Row) -> bool {
        text(row, "kind") == Some("agent")
            && integer(row, "connections").unwrap_or(0) == 0
            && (presence(row, now_ms()) == "offline"
                || match text(row, "process") {
                    Some(key) => !self.procs.alive(key).await,
                    None => false,
                })
    }
    async fn placement(&self, scope: &Scope, exclude: &[&str]) -> Result<Placement, RpcError> {
        if let Some(sub) = &scope.subagent {
            return Ok(Placement {
                parent: self.by_id(&sub.root).await?,
                grant: None,
            });
        }
        let lineage = self
            .lineage_rows(&scope.lineage, exclude)
            .await?
            .into_iter()
            .next();
        let Some(grant_hash) = &scope.grant else {
            return Ok(Placement {
                parent: lineage,
                grant: None,
            });
        };
        let grant = self
            .store
            .all(
                "SELECT * FROM grants WHERE token_hash = ?",
                &[opt(Some(grant_hash))],
            )
            .await?
            .into_iter()
            .next();
        if let Some(grant) = &grant
            && let Some(spender) = text(grant, "used_by")
            && let Some(parent) = &lineage
            && (text(parent, "id") == Some(spender)
                || self.ancestors(parent).await?.iter().any(|id| id == spender))
        {
            return Ok(Placement {
                parent: lineage,
                grant: None,
            });
        }
        let valid = grant.as_ref().is_some_and(|g| {
            integer(g, "expires_at").unwrap_or(0) > now_ms() && integer(g, "revoked_at").is_none()
        });
        let reason = if !valid {
            Some("grant invalid")
        } else if grant.as_ref().and_then(|g| text(g, "used_by")).is_some() {
            Some("grant used")
        } else {
            None
        };
        if let Some(reason) = reason {
            if lineage.is_some() {
                return Ok(Placement {
                    parent: lineage,
                    grant: None,
                });
            }
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                format!("grant refused: {reason}"),
            ));
        }
        let grant = grant.ok_or_else(RpcError::internal)?;
        if text(&grant, "name").is_some_and(|name| name != scope.handle) {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "grant for another name",
            ));
        }
        let under = self
            .must_endpoint(text(&grant, "under").unwrap_or(""))
            .await?;
        if exclude.contains(&text(&under, "id").unwrap_or(""))
            || self
                .ancestors(&under)
                .await?
                .iter()
                .any(|id| exclude.contains(&id.as_str()))
        {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "grant under the claimed endpoint",
            ));
        }
        if let Some(lineage) = &lineage
            && text(&under, "id") != text(lineage, "id")
            && !self
                .ancestors(&under)
                .await?
                .iter()
                .any(|id| Some(id.as_str()) == text(lineage, "id"))
        {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "grant above lineage",
            ));
        }
        Ok(Placement {
            parent: Some(under),
            grant: Some(grant),
        })
    }
    fn restarts(&self, row: &Row, parent: Option<&Row>, process: Option<&str>) -> bool {
        if parent.and_then(|r| text(r, "id")) == text(row, "id") {
            return process
                .zip(text(row, "process"))
                .is_some_and(|(a, b)| same_harness(a, b));
        }
        parent.and_then(|r| text(r, "id")) == text(row, "parent_ep")
            || (parent.is_none() && integer(row, "linked").is_some())
    }
    async fn returns(
        &self,
        row: &Row,
        parent: Option<&Row>,
        scope: &Scope,
        fields: &Fields,
        harness: &str,
    ) -> Result<bool, RpcError> {
        if self.restarts(row, parent, fields.process.as_deref()) {
            return Ok(true);
        }
        if let Some(grant_hash) = &scope.grant {
            let grant=self.store.all("SELECT * FROM grants WHERE token_hash = ? AND used_by = ? AND revoked_at IS NULL",&[opt(Some(grant_hash)),opt(text(row,"id"))]).await?.into_iter().next();
            if let Some(grant) = grant {
                let lineage = self
                    .lineage_rows(&scope.lineage, &[])
                    .await?
                    .into_iter()
                    .next();
                if let Some(lineage) = lineage {
                    if self.restarts(row, Some(&lineage), fields.process.as_deref())
                        || self
                            .ancestors(row)
                            .await?
                            .iter()
                            .any(|id| Some(id.as_str()) == text(&lineage, "id"))
                    {
                        return Ok(true);
                    }
                } else if harness_fits(text(row, "harness"), harness)
                    && text(&grant, "spent_cwd").is_some()
                    && text(&grant, "spent_cwd") == fields.cwd.as_deref()
                {
                    return Ok(true);
                }
            }
        }
        Ok(parent.is_none()
            && scope.grant.is_none()
            && fields.harness_session.is_some()
            && text(row, "harness_session") == fields.harness_session.as_deref())
    }
    async fn resumable(
        &self,
        harness: &str,
        session: &str,
        scope: &Scope,
        fields: &Fields,
        instead: Option<&Row>,
    ) -> Result<Option<Row>, RpcError> {
        let rows=self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND harness_session = ? AND connections = 0 AND (session IS NULL OR substr(session,1,4) != 'sub:') AND substr(handle,1,5) != 'gone:' ORDER BY named IS NULL,COALESCE(last_seen,created_at) DESC",&[opt(Some(session))]).await?;
        if rows.is_empty() {
            return Ok(None);
        }
        let parent = if let Some(row) = instead {
            match text(row, "parent_ep") {
                Some(id) => self.by_id(id).await?,
                None => None,
            }
        } else {
            self.placement(scope, &[]).await?.parent
        };
        let spender = if let Some(grant) = &scope.grant {
            Some(
                self.store
                    .all(
                        "SELECT used_by FROM grants WHERE token_hash = ? AND used_by IS NOT NULL AND revoked_at IS NULL",
                        &[opt(Some(grant))],
                    )
                    .await?
                    .first()
                    .and_then(|row| text(row, "used_by"))
                    .unwrap_or("")
                    .to_owned(),
            )
        } else {
            None
        };
        for row in rows {
            if spender
                .as_deref()
                .is_some_and(|id| Some(id) != text(&row, "id"))
            {
                continue;
            }
            if instead.is_some_and(|r| text(r, "id") == text(&row, "id")) {
                continue;
            }
            if !harness_fits(text(&row, "harness"), harness)
                && !same_provider(text(&row, "harness"), harness)
            {
                continue;
            }
            if self.released(&row).await
                && self
                    .returns(
                        &row,
                        parent.as_ref(),
                        scope,
                        &Fields {
                            harness_session: Some(session.into()),
                            ..fields.clone()
                        },
                        harness,
                    )
                    .await?
            {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }
    async fn place_claim(&self, row: &Row, scope: &Scope, fields: &Fields) -> Result<(), RpcError> {
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        let place = self.placement(scope, &[id]).await?;
        let depth = place
            .parent
            .as_ref()
            .and_then(|r| integer(r, "depth"))
            .unwrap_or(-1)
            + 1;
        if depth > 32 {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "claim is deeper than depthMax",
            ));
        }
        let mut caps = json!({"caps":[],"allow":{}});
        if let Some(grant) = &place.grant {
            self.spend_claim(grant, id, fields).await?;
            let entries: Vec<Value> = text(grant, "caps")
                .and_then(|v| serde_json::from_str::<Vec<Value>>(v).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|mut v| {
                    v["id"] = json!(token("cap"));
                    v["by"] = json!(text(grant, "issuer"));
                    v
                })
                .collect();
            caps["caps"] = json!(entries);
        }
        self.store.all("UPDATE endpoints SET tree = ?,parent_ep = ?,parent_addr = NULL,depth = ?,rules = ?,caps = ? WHERE id = ?",&[opt(place.parent.as_ref().and_then(|r|text(r,"tree").or_else(||text(r,"id")))),opt(place.parent.as_ref().and_then(|r|text(r,"id"))),SqlValue::Int(depth),if scope.rules == json!({}) { SqlValue::Null } else { opt(Some(&scope.rules.to_string())) },if caps["caps"]==json!([]){SqlValue::Null}else{opt(Some(&caps.to_string()))},opt(Some(id))]).await?;
        if let Some(parent) = place.parent {
            self.audit("scope_place",Some(id),None,json!({"by":match place.grant.as_ref().and_then(|r|text(r,"issuer")){Some(id)=>self.address_of(id).await?,None=>address(row)},"target":address(row),"parent":address(&parent)})).await?;
        }
        Ok(())
    }
    async fn spend_claim(&self, grant: &Row, id: &str, fields: &Fields) -> Result<(), RpcError> {
        self.store.all("UPDATE grants SET used_by = ?,spent_cwd = ?,prompt = NULL WHERE token_hash = ? AND used_by IS NULL",&[opt(Some(id)),opt(fields.cwd.as_deref()),opt(text(grant,"token_hash"))]).await?;
        let mut labels = text(grant, "labels")
            .and_then(|v| serde_json::from_str::<Value>(v).ok())
            .unwrap_or(json!({}));
        if let (Some(dst), Some(src)) = (labels.as_object_mut(), fields.labels.as_object()) {
            dst.extend(src.clone());
        }
        self.store.all("UPDATE endpoints SET labels = ?,title = CASE WHEN title IS NULL OR title IS title_auto THEN COALESCE(?,title) ELSE title END WHERE id = ?",&[opt(Some(&labels.to_string())),opt(text(grant,"title")),opt(Some(id))]).await?;
        Ok(())
    }
    async fn claim_row(
        &mut self,
        harness: &str,
        fields: &Fields,
        scope: &Scope,
        transient: bool,
    ) -> Result<Claimed, RpcError> {
        self.end_exited().await?;
        let mut row = if let Some(session) = &fields.session {
            self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND (harness = ? OR harness IN ('cli','hook','mcp','shell')) AND session = ? AND substr(handle,1,5) != 'gone:' ORDER BY COALESCE(last_seen,created_at) DESC LIMIT 1",&[opt(Some(harness)),opt(Some(session))]).await?.into_iter().next()
        } else {
            None
        };
        let open = row
            .as_ref()
            .is_none_or(|r| presence(r, now_ms()) == "offline");
        let mut session = fields.session.clone();
        if let Some(held) = &row {
            if presence(held, now_ms()) == "offline" {
                self.store
                    .all(
                        "UPDATE endpoints SET session = NULL WHERE id = ?",
                        &[opt(text(held, "id"))],
                    )
                    .await?;
                row = None;
            } else if !transient {
                let same = fields
                    .process
                    .as_deref()
                    .zip(text(held, "process"))
                    .is_some_and(|(a, b)| {
                        (integer(held, "connections").unwrap_or(0) == 0
                            && if text(held, "token_hash").is_none() {
                                same_harness(a, b)
                            } else {
                                a == b && process_key(a, true)
                            })
                            || (text(held, "handle") == Some(scope.handle.as_str())
                                && integer(held, "connections").unwrap_or(0) > 0
                                && a == b
                                && process_key(a, true))
                    });
                if !same {
                    row = None;
                    session = None;
                }
            } else {
                session = text(held, "session").map(str::to_owned);
            }
        }
        let mut moved_hooks = None;
        if !transient
            && let Some(hooks) = row.clone()
            && text(&hooks, "token_hash").is_none()
            && integer(&hooks, "named").is_none()
            && text(&hooks, "handle") != Some(scope.handle.as_str())
            && !text(&hooks, "handle").unwrap_or("").starts_with(&format!(
                "{}-",
                scope.handle.chars().take(58).collect::<String>()
            ))
        {
            for n in 1..if scope.exact { 2 } else { 1000 } {
                let handle = suffixed(&scope.handle, n);
                let held = self.by_handle(&handle).await?;
                if let Some(held) = held {
                    if self.released(&held).await
                        && harness_fits(text(&held, "harness"), harness)
                        && self
                            .returns(
                                &held,
                                self.placement(scope, &[text(&hooks, "id").unwrap_or("")])
                                    .await?
                                    .parent
                                    .as_ref(),
                                scope,
                                fields,
                                harness,
                            )
                            .await?
                    {
                        moved_hooks = Some(hooks.clone());
                        row = Some(held);
                        break;
                    }
                } else {
                    self.store
                        .all(
                            "UPDATE endpoints SET handle = ? WHERE id = ?",
                            &[opt(Some(&handle)), opt(text(&hooks, "id"))],
                        )
                        .await?;
                    row = self.by_id(text(&hooks, "id").unwrap_or("")).await?;
                    break;
                }
            }
        }
        let exact = scope.exact;
        let mut resumed = false;
        if row.is_none() && open && !exact && scope.subagent.is_none() {
            for reported in [&fields.harness_session, &fields.harness_origin]
                .into_iter()
                .flatten()
            {
                if let Some(found) = self
                    .resumable(harness, reported, scope, fields, None)
                    .await?
                {
                    row = Some(found);
                    session = fields.session.clone();
                    resumed = true;
                    break;
                }
            }
        }
        let mut joined = row.is_some() && !resumed;
        let mut created = false;
        let mut live = false;
        let mut own = false;
        if row.is_none() {
            for n in 1..if exact { 2 } else { 1000 } {
                let handle = suffixed(&scope.handle, n);
                let Some(held) = self.by_handle(&handle).await? else {
                    let id = token("ep");
                    self.store.all("INSERT INTO endpoints (id,handle,kind,harness,labels,created_at) VALUES (?,?,'agent',?,'{}',?)",&[opt(Some(&id)),opt(Some(&handle)),opt(Some(harness)),SqlValue::Int(now_ms())]).await?;
                    row = self.by_id(&id).await?;
                    created = true;
                    break;
                };
                let other_session = text(&held, "harness_session").is_some()
                    && fields.harness_session.is_some()
                    && text(&held, "harness_session") != fields.harness_session.as_deref()
                    && fields
                        .process
                        .as_deref()
                        .zip(text(&held, "process"))
                        .is_some_and(|(a, b)| same_harness(a, b));
                let outlived = integer(&held, "connections").unwrap_or(0) > 0
                    && match text(&held, "process") {
                        Some(key) => {
                            !self
                                .procs
                                .alive(
                                    key.splitn(3, ':')
                                        .take(2)
                                        .collect::<Vec<_>>()
                                        .join(":")
                                        .as_str(),
                                )
                                .await
                        }
                        None => false,
                    };
                let foreign_sub = scope.subagent.as_ref().is_some_and(|sub| {
                    text(&held, "id") == Some(sub.root.as_str())
                        || text(&held, "session").is_some_and(|v| {
                            v.starts_with("sub:") && Some(v) != fields.session.as_deref()
                        })
                });
                if text(&held, "kind") == Some("agent")
                    && (self.released(&held).await || (!transient && outlived))
                    && harness_fits(text(&held, "harness"), harness)
                    && !other_session
                    && !foreign_sub
                {
                    own = transient
                        && fields
                            .process
                            .as_deref()
                            .zip(text(&held, "process"))
                            .is_some_and(|(a, b)| same_harness(a, b));
                    let ended = integer(&held, "hook_ended").is_some()
                        || integer(&held, "last_seen")
                            .or_else(|| integer(&held, "created_at"))
                            .unwrap_or(0)
                            < now_ms() - 60_000
                        || match text(&held, "process") {
                            Some(key) => !self.procs.alive(key).await,
                            None => false,
                        };
                    if (!transient || own || ended)
                        && self
                            .returns(
                                &held,
                                self.placement(scope, &[]).await?.parent.as_ref(),
                                scope,
                                fields,
                                harness,
                            )
                            .await?
                    {
                        row = Some(held);
                        break;
                    }
                } else if exact
                    && text(&held, "kind") == Some("agent")
                    && text(&held, "process").is_none()
                    && text(&held, "session").is_none()
                    && harness_fits(text(&held, "harness"), harness)
                    && self.restarts(
                        &held,
                        self.placement(scope, &[]).await?.parent.as_ref(),
                        None,
                    )
                {
                    live = presence(&held, now_ms()) != "offline";
                    row = Some(held);
                    joined = true;
                    break;
                }
            }
        }
        let row = row.ok_or_else(|| {
            RpcError::new(
                if exact {
                    ErrorCode::Unauthorized
                } else {
                    ErrorCode::InvalidParams
                },
                format!("no available endpoint for {}", scope.handle),
            )
        })?;
        let id = text(&row, "id").ok_or_else(RpcError::internal)?;
        if let Some(hooks) = moved_hooks {
            self.store
                .all(
                    "UPDATE deliveries SET endpoint = ? WHERE endpoint = ? AND acked_at IS NULL",
                    &[opt(Some(id)), opt(text(&hooks, "id"))],
                )
                .await?;
            self.store
                .all(
                    "UPDATE endpoints SET session = NULL,hook_seen = NULL WHERE id = ?",
                    &[opt(text(&hooks, "id"))],
                )
                .await?;
        }
        let by_session = joined && text(&row, "token_hash").is_none();
        let fresh = if created || joined || resumed {
            None
        } else {
            let spent = if let Some(grant) = &scope.grant {
                self.store
                    .all(
                        "SELECT used_by FROM grants WHERE token_hash = ? AND revoked_at IS NULL",
                        &[opt(Some(grant))],
                    )
                    .await?
                    .into_iter()
                    .next()
            } else {
                None
            };
            if spent.as_ref().and_then(|r| text(r, "used_by")) == Some(id)
                || fields
                    .process
                    .as_deref()
                    .zip(text(&row, "process"))
                    .is_some_and(|(a, b)| same_harness(a, b))
            {
                None
            } else if scope.grant.is_some() && self.placement(scope, &[id]).await?.grant.is_some() {
                Some("grant")
            } else {
                let parent = if let Some(pid) = text(&row, "parent_ep") {
                    self.by_id(pid).await?
                } else {
                    None
                };
                let nearest = if text(&row, "process").is_some() {
                    text(&row, "process")
                } else {
                    parent.as_ref().and_then(|r| text(r, "process"))
                };
                if nearest.is_some() && nearest == scope.nearest.as_deref() {
                    None
                } else {
                    Some("process")
                }
            }
        };
        let resume = if transient || live {
            None
        } else {
            Some(token("kre"))
        };
        let keep = (transient && (joined || own)) || live;
        let kept_harness = if generic(Some(harness)) && !generic(text(&row, "harness")) {
            text(&row, "harness").unwrap_or(harness)
        } else {
            harness
        };
        let field = |column: &str| {
            if transient {
                format!("COALESCE(?,{column})")
            } else {
                "?".into()
            }
        };
        if let Some(session) = &session {
            self.store.all("UPDATE endpoints SET session = NULL WHERE session = ? AND harness = ? AND id != ?",&[opt(Some(session)),opt(Some(harness)),opt(Some(id))]).await?;
        }
        let labels = fields.labels.to_string();
        let query = format!(
            "UPDATE endpoints SET harness = ?,model = {},cwd = {},parent = {},labels = {},session = ?,harness_origin = {},process = {},token_hash = {},connections = connections + ?,last_seen = ?,hook_seen = CASE WHEN ? IS NOT NULL AND (hook_ended IS NULL OR hook_ended < ?) THEN ? ELSE hook_seen END WHERE id = ?",
            field("model"),
            field("cwd"),
            field("parent"),
            field("labels"),
            field("harness_origin"),
            if keep { "COALESCE(process, ?)" } else { "?" },
            if keep { "token_hash" } else { "?" }
        );
        let mut args = vec![
            opt(Some(kept_harness)),
            opt(fields.model.as_deref()),
            opt(fields.cwd.as_deref()),
            opt(fields.parent.as_deref()),
            if transient && labels == "{}" {
                SqlValue::Null
            } else {
                opt(Some(&labels))
            },
            opt(session.as_deref()),
            opt(fields.harness_origin.as_deref()),
            opt(fields.process.as_deref()),
        ];
        if !keep {
            args.push(opt(resume.as_ref().map(|s| hash(s)).as_deref()));
        }
        args.extend([
            SqlValue::Int(if transient { 0 } else { 1 }),
            SqlValue::Int(now_ms()),
            if transient {
                SqlValue::Int(now_ms())
            } else {
                SqlValue::Null
            },
            SqlValue::Int(now_ms() - 30_000),
            SqlValue::Int(now_ms()),
            opt(Some(id)),
        ]);
        self.store.all(&query, &args).await?;
        if !transient && fields.cwd.is_some() {
            self.store
                .all(
                    "UPDATE grants SET spent_cwd = ? WHERE used_by = ?",
                    &[opt(fields.cwd.as_deref()), opt(Some(id))],
                )
                .await?;
        }
        if !(transient && joined) {
            let mut detail = json!({"handle":text(&row,"handle"),"harness":harness,"joined":joined,"resumed":resumed,"transient":transient});
            if let Some(sub) = &scope.subagent {
                detail["subagent"] = json!(sub.kind.as_deref().unwrap_or("agent"));
                detail["parent"] = json!(self.address_of(&sub.root).await?);
            }
            self.audit("claim", Some(id), None, detail).await?;
        }
        if let Some(kind) = fresh {
            self.reset_claim(&row, scope, kind).await?;
        }
        if created || fresh == Some("grant") {
            self.place_claim(&self.must_endpoint(id).await?, scope, fields)
                .await?;
        } else if scope.grant.is_some() {
            let spent = self
                .store
                .all(
                    "SELECT used_by FROM grants WHERE token_hash = ? AND revoked_at IS NULL",
                    &[opt(scope.grant.as_deref())],
                )
                .await?
                .into_iter()
                .next();
            if spent.as_ref().and_then(|r| text(r, "used_by")) != Some(id) {
                let placement = self.placement(scope, &[id]).await?;
                if placement.grant.is_some() {
                    if by_session
                        && text(&row, "parent_ep").is_none()
                        && integer(&row, "named").is_none()
                    {
                        self.place_claim(&self.must_endpoint(id).await?, scope, fields)
                            .await?;
                    } else if let Some(grant) = placement.grant {
                        self.spend_claim(&grant, id, fields).await?;
                    }
                }
            }
        }
        let mut result = self.must_endpoint(id).await?;
        let mut rehomed = false;
        if transient
            && !exact
            && let Some(session) = &fields.harness_session
            && text(&result, "harness_session") != Some(session)
            && integer(&result, "named").is_none()
            && fields
                .process
                .as_deref()
                .zip(text(&result, "process"))
                .is_some_and(|(a, b)| same_harness(a, b))
        {
            for reported in [&fields.harness_session, &fields.harness_origin]
                .into_iter()
                .flatten()
            {
                if let Some(held) = self
                    .resumable(harness, reported, scope, fields, Some(&result))
                    .await?
                {
                    if text(&result, "parent_ep").is_none()
                        || self.default_of("rename") == Some("self")
                    {
                        self.store.all("UPDATE endpoints SET harness_session = ?,harness_transcript = ? WHERE id = ?",&[opt(Some(session)),if text(&held,"harness_session")==Some(session){opt(text(&held,"harness_transcript"))}else{SqlValue::Null},opt(Some(id))]).await?;
                        self.retake(&result, &held, false).await?;
                        result = self.must_endpoint(id).await?;
                        rehomed = true;
                    }
                    break;
                }
            }
        }
        let retired = if !rehomed && !exact && fields.harness_handoff {
            self.hand_off(&result, harness, fields, created).await?
        } else {
            None
        };
        if retired.is_some() {
            result = self.must_endpoint(id).await?;
        }
        self.state.addresses.insert(id.into(), address(&result));
        Ok(Claimed {
            row: result,
            resume,
            retired,
            created,
            subagent: scope.subagent.is_some(),
        })
    }
    async fn hand_off(
        &mut self,
        row: &Row,
        harness: &str,
        fields: &Fields,
        created: bool,
    ) -> Result<Option<String>, RpcError> {
        let (Some(origin), Some(session)) = (&fields.harness_origin, &fields.harness_session)
        else {
            return Ok(None);
        };
        if session == origin
            || text(row, "kind") != Some("agent")
            || integer(row, "named").is_some()
            || text(row, "harness_origin") != Some(origin)
            || text(row, "session").is_some_and(|s| s.starts_with("sub:"))
        {
            return Ok(None);
        }
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        let since = integer(row, "created_at").unwrap_or(0);
        let held = self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND harness_session = ? AND id != ? AND created_at < ? AND (session IS NULL OR substr(session,1,4) != 'sub:') AND substr(handle,1,5) != 'gone:' AND substr(handle,1,6) != '_gone_' ORDER BY named IS NULL, COALESCE(last_seen,created_at) DESC", &[opt(Some(origin)),opt(Some(id)),SqlValue::Int(since)]).await?
            .into_iter().find(|held| !revivable(held) && (harness_fits(text(held,"harness"),harness) || same_provider(text(held,"harness"),harness)));
        let Some(held) = held else {
            return Ok(None);
        };
        if busy_since(
            &held,
            since,
            created,
            now_ms(),
            self.limits.get("restartGraceS").unwrap_or(60) as i64 * 1000,
        ) {
            return Ok(None);
        }
        if let Some(under) = &fields.under
            && let Ok(parent) = self.lookup(under).await
            && (text(&parent, "id") == text(&held, "id")
                || self
                    .ancestors(&parent)
                    .await?
                    .iter()
                    .any(|id| Some(id.as_str()) == text(&held, "id")))
        {
            self.audit(
                "handoff_refused",
                Some(id),
                None,
                json!({"from":text(row,"handle"),"to":text(&held,"handle"),"code":"scope_refused"}),
            )
            .await?;
            return Ok(None);
        }
        self.store.all("SAVEPOINT handoff", &[]).await?;
        let result = async {
            self.store
                .all(
                    "UPDATE endpoints SET harness_session = ? WHERE id = ?",
                    &[opt(Some(session)), opt(Some(id))],
                )
                .await?;
            self.retake(&self.must_endpoint(id).await?, &held, false)
                .await
        }
        .await;
        if result.is_err() {
            self.store.all("ROLLBACK TO handoff", &[]).await?;
        }
        self.store.all("RELEASE handoff", &[]).await?;
        let retired = match result {
            Ok(retired) => retired,
            Err(error) => {
                let Some(data) = error.data else {
                    return Err(error);
                };
                self.audit(
                    "handoff_refused",
                    Some(id),
                    None,
                    json!({"from":text(row,"handle"),"to":text(&held,"handle"),"code":data.code}),
                )
                .await?;
                return Ok(None);
            }
        };
        self.audit(
            "handoff",
            Some(id),
            None,
            json!({"from":text(row,"handle"),"to":text(&held,"handle"),"retired":retired}),
        )
        .await?;
        Ok(Some(retired))
    }
    async fn reset_claim(&self, row: &Row, scope: &Scope, kind: &str) -> Result<(), RpcError> {
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        self.store
            .all(
                "DELETE FROM group_members WHERE endpoint = ?",
                &[opt(Some(id))],
            )
            .await?;
        self.store
            .all(
                "UPDATE admins SET revoked_at = ? WHERE subject = ? AND revoked_at IS NULL",
                &[SqlValue::Int(now_ms()), opt(Some(id))],
            )
            .await?;
        self.store.all("UPDATE grants SET revoked_at = COALESCE(revoked_at,?) WHERE used_by = ? AND token_hash IS NOT ?",&[SqlValue::Int(now_ms()),opt(Some(id)),opt(scope.grant.as_deref())]).await?;
        self.store.all("UPDATE endpoints SET reset_at = ?,peek = NULL,wake = NULL,hold_ref = NULL WHERE id = ?",&[SqlValue::Int(now_ms()),opt(Some(id))]).await?;
        if kind == "grant" {
            self.store.all("UPDATE endpoints SET rules = NULL,caps = NULL,status_state = NULL,status_note = NULL,title = NULL,harness_session = NULL,spawned_at = ? WHERE id = ?",&[SqlValue::Int(now_ms()),opt(Some(id))]).await?;
        }
        self.audit("scope_reset",Some(id),None,json!({"by":address(row),"target":address(row),"reason":if kind=="grant"{"a new spawn took over the endpoint"}else{"another process took over the endpoint"},"groups":[]})).await
    }
    async fn subagent_root(
        &mut self,
        scope: &Scope,
        harness: &str,
        fields: &Fields,
        transient: bool,
    ) -> Result<Row, RpcError> {
        let held = match &fields.session {
            Some(session) => self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND harness = ? AND session = ? AND substr(handle,1,5) != 'gone:'",&[opt(Some(harness)),opt(Some(session))]).await?.into_iter().next(),
            None => None,
        };
        let root = match held {
            Some(row) => Some(row),
            None => self
                .lineage_rows(&scope.lineage, &[])
                .await?
                .into_iter()
                .next(),
        };
        if let Some(root) = &root
            && transient
            && text(root, "harness") == Some(harness)
            && fields
                .process
                .as_deref()
                .zip(text(root, "process"))
                .is_some_and(|(a, b)| same_harness(b, a))
        {
            return Ok(root.clone());
        }
        self.state.deferred = Some((
            root.as_ref().and_then(|r| text(r, "id")).map(str::to_owned),
            json!({"target":scope.handle,"reason":"subagent claim from another process"}),
        ));
        Err(RpcError::new(
            ErrorCode::Unauthorized,
            "a subagent claim comes only from a hook of the harness process that holds its lineage endpoint",
        ))
    }
    async fn claim_subagent(
        &mut self,
        harness: &str,
        mut fields: Fields,
        mut scope: Scope,
        transient: bool,
        (id, kind, stop): (String, Option<String>, bool),
    ) -> Result<Claimed, RpcError> {
        let root = self
            .subagent_root(&scope, harness, &fields, transient)
            .await?;
        let root_id = text(&root, "id").ok_or_else(RpcError::internal)?.to_owned();
        scope.handle = subagent_handle(text(&root, "handle").unwrap_or(""), &id, kind.as_deref());
        scope.grant = None;
        let session = format!("sub:{id}:{}", fields.session.as_deref().unwrap_or(&root_id));
        fields.session = Some(session.chars().take(128).collect());
        fields.under = None;
        fields.harness_handoff = false;
        let had = self.store.all("SELECT id FROM endpoints WHERE kind = 'agent' AND harness = ? AND (session = ? OR (handle = ? AND parent_ep = ?)) LIMIT 1",&[opt(Some(harness)),opt(fields.session.as_deref()),opt(Some(&scope.handle)),opt(Some(&root_id))]).await?;
        if stop && had.is_empty() {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                "that subagent has no endpoint: it never ran a tool",
            ));
        }
        scope.subagent = Some(Subagent {
            kind,
            root: root_id.clone(),
        });
        let claimed = self.claim_row(harness, &fields, &scope, true).await?;
        let endpoint = text(&claimed.row, "id")
            .ok_or_else(RpcError::internal)?
            .to_owned();
        let titled = self.take_subagent_title(&root_id, &id, &endpoint).await?;
        let resumed = !stop
            && !self.store.all("UPDATE endpoints SET status_state = 'working' WHERE id = ? AND status_state = 'done' RETURNING id",&[opt(Some(&endpoint))]).await?.is_empty();
        if !titled && !resumed {
            return Ok(claimed);
        }
        Ok(Claimed {
            row: self.must_endpoint(&endpoint).await?,
            ..claimed
        })
    }
    async fn take_subagent_title(
        &mut self,
        root: &str,
        id: &str,
        endpoint: &str,
    ) -> Result<bool, RpcError> {
        let key = format!("{root} {id}");
        let Some(at) = self
            .state
            .subagent_titles
            .iter()
            .position(|(k, _)| *k == key)
        else {
            return Ok(false);
        };
        let (_, title) = self
            .state
            .subagent_titles
            .remove(at)
            .ok_or_else(RpcError::internal)?;
        self.fill_title(endpoint, &title).await
    }
    pub async fn fill_title(&self, endpoint: &str, title: &str) -> Result<bool, RpcError> {
        Ok(!self.store.all("UPDATE endpoints SET title = ?,title_auto = ?,title_turn = NULL WHERE id = ? AND (title IS NULL OR title = title_auto) AND title IS NOT ? RETURNING id",&[opt(Some(title)),opt(Some(title)),opt(Some(endpoint)),opt(Some(title))]).await?.is_empty())
    }
    /// whether a hook connection's process holds `row`; a dead holder's process passes to it
    pub async fn holds(
        &self,
        row: &Row,
        transient: bool,
        process: Option<&str>,
    ) -> Result<bool, RpcError> {
        let Some(held) = text(row, "process").filter(|_| transient) else {
            return Ok(true);
        };
        let Some(process) = process else {
            return Ok(false);
        };
        if same_harness(held, process) {
            return Ok(true);
        }
        let pid = held
            .strip_prefix("pid:")
            .and_then(|v| v.split(':').next())
            .filter(|v| !v.is_empty() && v != &"0" && v.bytes().all(|b| b.is_ascii_digit()));
        let Some(pid) = pid else {
            return Ok(false);
        };
        if self.procs.alive(&format!("pid:{pid}")).await {
            return Ok(false);
        }
        self.store
            .all(
                "UPDATE endpoints SET process = ? WHERE id = ? AND process = ?",
                &[opt(Some(process)), opt(text(row, "id")), opt(Some(held))],
            )
            .await?;
        Ok(true)
    }
    /// a title for the caller's in-process subagent `id`; the subagent's endpoint id when it changed one, else kept until its first claim
    pub async fn subagent_title(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| subagent_of(Some(&json!({"id": id}))).is_ok())
            .ok_or_else(|| RpcError::invalid_params("id is the subagent's id"))?;
        let title = params
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("title must be a string"))?;
        let c = self.connection(conn)?;
        let row = self.actor_row(conn).await?;
        let title = crate::session::hook_title(title);
        let Some(title) = title.filter(|_| text(&row, "kind") == Some("agent")) else {
            return Ok(json!({"changed": false}));
        };
        if !self
            .holds(&row, c.mode == Mode::Transient, c.process.as_deref())
            .await?
        {
            return Ok(json!({"changed": false}));
        }
        let root = text(&row, "id").ok_or_else(RpcError::internal)?.to_owned();
        let prefix = format!("sub:{id}:");
        let sub = self.store.all("SELECT id FROM endpoints WHERE kind = 'agent' AND parent_ep = ? AND substr(session,1,?) = ? ORDER BY COALESCE(last_seen,created_at) DESC LIMIT 1",&[opt(Some(&root)),SqlValue::Int(prefix.len() as i64),opt(Some(&prefix))]).await?.into_iter().next();
        if let Some(sub) = sub {
            let changed = self
                .fill_title(text(&sub, "id").unwrap_or(""), &title)
                .await?;
            return Ok(json!({"changed": changed}));
        }
        let key = format!("{root} {id}");
        self.state.subagent_titles.retain(|(k, _)| *k != key);
        self.state.subagent_titles.push_back((key, title));
        while self.state.subagent_titles.len() > 256 {
            self.state.subagent_titles.pop_front();
        }
        Ok(json!({"changed": false}))
    }
    async fn claim_agent(
        &mut self,
        claim: &Map<String, Value>,
        transient: bool,
        self_keys: Option<&Value>,
    ) -> Result<Claimed, RpcError> {
        let subagent = subagent_of(claim.get("subagent"))?;
        let harness =
            clean_text(claim.get("harness"), "harness", 32)?.unwrap_or_else(|| "cli".into());
        if !valid_harness(&harness) {
            return Err(RpcError::invalid_params("harness is not a valid name"));
        }
        let wanted =
            clean_text(claim.get("handle"), "handle", 63)?.unwrap_or_else(|| harness.clone());
        if !valid_handle(&wanted) {
            return Err(RpcError::invalid_params(
                "handle is not valid: lowercase letters, digits, . _ -",
            ));
        }
        let fields = Fields {
            model: clean_text(claim.get("model"), "model", 128)?,
            cwd: clean_text(claim.get("cwd"), "cwd", 1024)?,
            parent: clean_text(claim.get("parent"), "parent", 128)?,
            labels: clean_labels(claim.get("labels"))?,
            session: clean_text(claim.get("session"), "session", 128)?,
            process: clean_text(claim.get("process"), "process", 128)?,
            harness_session: clean_text(claim.get("harness_session"), "harness_session", 128)?,
            harness_origin: clean_text(claim.get("harness_origin"), "harness_origin", 128)?,
            harness_handoff: claim.get("harness_handoff") == Some(&Value::Bool(true)),
            under: clean_text(claim.get("under"), "under", 128)?.filter(|v| !v.is_empty()),
        };
        if fields
            .process
            .as_ref()
            .is_some_and(|v| !process_key(v, false))
        {
            return Err(RpcError::invalid_params(
                "process is a key pid:<pid>[:<start time>]",
            ));
        }
        if [&fields.harness_session, &fields.harness_origin]
            .into_iter()
            .flatten()
            .any(|v| !harness_session(v))
        {
            return Err(RpcError::invalid_params(
                "harness session is not a valid id",
            ));
        }
        for value in [
            Some(wanted.as_str()),
            fields.model.as_deref(),
            fields.cwd.as_deref(),
            fields.parent.as_deref(),
            fields.session.as_deref(),
            fields.harness_session.as_deref(),
            fields.harness_origin.as_deref(),
            Some(fields.labels.to_string().as_str()),
        ]
        .into_iter()
        .flatten()
        {
            if crate::scrub::find_secret(value).is_some() {
                return Err(RpcError::new(
                    ErrorCode::SecretRefused,
                    "the claim carries a credential",
                ));
            }
        }
        if claim
            .get("harness_handoff")
            .is_some_and(|v| !v.is_boolean())
        {
            return Err(RpcError::invalid_params("harness_handoff is true or false"));
        }
        let lineage = lineage_keys(claim.get("lineage"))?;
        let keys = lineage_keys(self_keys)?;
        let nearest = keys
            .last()
            .filter(|v| process_key(v, true) && lineage.starts_with(&keys))
            .cloned();
        let grant = match claim.get("grant") {
            Some(v) => Some(hash(
                v.as_str()
                    .filter(|v| valid_token(v, "krt_"))
                    .ok_or_else(|| RpcError::invalid_params("grant is a krt_ token"))?,
            )),
            None => None,
        };
        let mut rules = json!({});
        for dir in ["in", "out"] {
            if let Some(v) = claim.get(dir).or_else(|| claim.get("allow")) {
                rules[dir] = v.clone();
            }
        }
        let exact = claim.get("exact") == Some(&Value::Bool(true)) && subagent.is_none();
        let mut scope = Scope {
            handle: wanted,
            lineage,
            grant,
            nearest,
            rules,
            exact,
            subagent: None,
        };
        if let Some((id, kind, stop)) = subagent {
            return self
                .claim_subagent(&harness, fields, scope, transient, (id, kind, stop))
                .await;
        }
        if scope.grant.is_none()
            && !exact
            && let Some(process) = &fields.process
        {
            let bound=self.store.all("SELECT * FROM grants WHERE bound_process = ? AND used_by IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",&[opt(Some(process)),SqlValue::Int(now_ms())]).await?.into_iter().next();
            if let Some(bound) = bound {
                scope.grant = text(&bound, "token_hash").map(str::to_owned);
                if let Some(name) = text(&bound, "name") {
                    scope.handle = name.into();
                }
            }
        }
        let claimed = self.claim_row(&harness, &fields, &scope, transient).await?;
        let row = &claimed.row;
        if let Some(under) = clean_text(claim.get("under"), "under", 128)?.filter(|v| !v.is_empty())
            && text(row, "parent_ep").is_none()
        {
            match self.lookup(&under).await {
                Ok(parent) => {
                    self.link_endpoint(row, &parent, "session").await?;
                }
                Err(error) => {
                    self.audit("claim_under_refused",text(row,"id"),None,json!({"target":address(row),"under":under,"code":error.data.map(|v|v.code)})).await?;
                }
            }
        }
        Ok(Claimed {
            row: self.must_endpoint(text(row, "id").unwrap_or("")).await?,
            ..claimed
        })
    }
}
fn subagent_of(value: Option<&Value>) -> Result<Option<(String, Option<String>, bool)>, RpcError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| {
            (1..=64).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && id.bytes().any(|b| b.is_ascii_alphanumeric())
        })
        .ok_or_else(|| {
            RpcError::invalid_params("subagent is {id, type}: id letters, digits, _ and -")
        })?;
    let kind = match value.get("type") {
        None => None,
        Some(Value::String(kind)) if kind.encode_utf16().count() <= 64 => {
            Some(kind.clone()).filter(|v| !v.is_empty())
        }
        Some(_) => {
            return Err(RpcError::invalid_params(
                "subagent type is a name of at most 64 characters",
            ));
        }
    };
    let stop = match value.get("stop") {
        None => false,
        Some(Value::Bool(stop)) => *stop,
        Some(_) => return Err(RpcError::invalid_params("subagent stop is true or false")),
    };
    Ok(Some((id.into(), kind, stop)))
}

fn subagent_kind(kind: Option<&str>) -> String {
    let kind = kind.unwrap_or("");
    if kind.eq_ignore_ascii_case("general-purpose") {
        return "gp".into();
    }
    let mut word = String::new();
    let mut prev: Option<char> = None;
    for c in kind.chars() {
        if !c.is_ascii_alphanumeric() {
            if !word.is_empty() {
                break;
            }
        } else if c.is_ascii_uppercase()
            && prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
            && !word.is_empty()
        {
            break;
        } else {
            word.push(c);
        }
        prev = Some(c);
    }
    if word.is_empty() {
        "agent".into()
    } else {
        word.to_ascii_lowercase().chars().take(16).collect()
    }
}

/// `<root handle>-<short type>-<first 4 alphanumerics of id>`, the root's part clipped to leave room for a `-<n>` suffix
pub fn subagent_handle(root: &str, id: &str, kind: Option<&str>) -> String {
    let short: String = id
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(4)
        .collect();
    let tail = format!("-{}-{short}", subagent_kind(kind));
    let head: String = root
        .chars()
        .take(58usize.saturating_sub(tail.len()))
        .collect();
    format!("{}{tail}", head.trim_end_matches(['-', '.']))
}

fn suffixed(handle: &str, n: usize) -> String {
    if n == 1 {
        handle.into()
    } else {
        format!("{}-{n}", handle.chars().take(58).collect::<String>())
    }
}

pub async fn hello_claim(
    core: &mut Core,
    conn: ConnectionId,
    params: &Map<String, Value>,
) -> Result<Value, RpcError> {
    let transient = params.get("transient") == Some(&Value::Bool(true));
    if transient
        && (params.get("human") == Some(&Value::Bool(true))
            || params.get("observe") == Some(&Value::Bool(true))
            || params.contains_key("resume"))
    {
        return Err(RpcError::invalid_params(
            "transient does not go with human, observe or resume",
        ));
    }
    let session = params.get("harness_session").and_then(Value::as_str);
    if !transient && params.get("observe") == Some(&Value::Bool(true)) {
        let own = core
            .place_lineage(params.get("self"), None, session)
            .await?;
        if let Some(grant) = params.get("grant")
            && !core.grant_binds(grant, own.as_deref()).await?
        {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "grant does not bind this endpoint",
            ));
        }
        if let Some(id) = own {
            bind_lineage(core, conn, &id, params, true)?;
            let mut result =
                core.hello_result(core.view(&core.must_endpoint(&id).await?).await?, None);
            if params.contains_key("grant") {
                result["grant_bound"] = json!(true);
            }
            return Ok(result);
        }
        let lineage = core
            .place_lineage(params.get("lineage"), None, session)
            .await?;
        core.state.bind(conn, None, Mode::Observer);
        if let Some(c) = core.state.connections.get_mut(&conn) {
            c.lineage = lineage;
            c.self_keys = lineage_keys(params.get("self"))?;
            c.lineage_keys = lineage_keys(params.get("lineage"))?;
            c.harness_session = session.map(str::to_owned);
        }
        return Ok(core.hello_result(Value::Null, None));
    }
    if !transient && !params.contains_key("resume") {
        if params.get("human") == Some(&Value::Bool(true)) {
            if let Some(id) = core
                .place_lineage(params.get("lineage"), None, session)
                .await?
            {
                bind_lineage(core, conn, &id, params, false)?;
                return Ok(
                    core.hello_result(core.view(&core.must_endpoint(&id).await?).await?, None)
                );
            }
        } else if let Some(claim) = params.get("claim").and_then(Value::as_object)
            && !claim.contains_key("process")
            && let Some(handle) = claim.get("handle").and_then(Value::as_str)
            && let Some(id) = core
                .place_lineage(claim.get("lineage"), Some(handle), None)
                .await?
            && (claim.get("grant").is_none()
                || core
                    .grant_binds(claim.get("grant").unwrap_or(&Value::Null), Some(&id))
                    .await?)
        {
            let own = core
                .place_lineage(params.get("self"), Some(handle), None)
                .await?
                == Some(id.clone());
            bind_lineage(core, conn, &id, params, own)?;
            return Ok(core.hello_result(core.view(&core.must_endpoint(&id).await?).await?, None));
        }
    }
    core.state.deferred = None;
    let claimed = match crate::store::transaction(
        core.store.clone(),
        hello_transaction(core, conn, params, transient),
    )
    .await
    {
        Ok(claimed) => claimed,
        Err(error) => {
            if let Some((endpoint, detail)) = core.state.deferred.take() {
                core.audit("scope_refused", endpoint.as_deref(), None, detail)
                    .await?;
            }
            return Err(error);
        }
    };
    let row = claimed.row;
    let id = text(&row, "id").ok_or_else(RpcError::internal)?.to_owned();
    let mode = if transient {
        Mode::Transient
    } else if text(&row, "kind") == Some("human") {
        Mode::Human {
            tty: params.get("tty") == Some(&Value::Bool(true)),
        }
    } else {
        Mode::Agent
    };
    core.state.bind(conn, Some(id.clone()), mode);
    if let Some(retired) = claimed.retired {
        core.state.close_endpoint(&retired, conn);
    }
    core.state.addresses.insert(id, address(&row));
    if let Some(c) = core.state.connections.get_mut(&conn) {
        c.brief = params.get("brief") == Some(&Value::Bool(true));
        c.cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .or_else(|| text(&row, "cwd"))
            .map(str::to_owned);
        c.process = params
            .get("claim")
            .and_then(|v| v.get("process"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    let mut result = core.hello_result(core.view(&row).await?, claimed.resume);
    if claimed.subagent {
        result["subagent"] = json!(true);
        if claimed.created {
            result["created"] = json!(true);
        }
    }
    Ok(result)
}

fn bind_lineage(
    core: &mut Core,
    conn: ConnectionId,
    id: &str,
    params: &Map<String, Value>,
    own: bool,
) -> Result<(), RpcError> {
    if let Some(c) = core.state.connections.get_mut(&conn) {
        c.endpoint = Some(id.into());
        c.lineage = Some(id.into());
        c.mode = Mode::Agent;
        c.own = own;
        c.brief = true;
        c.cwd = params.get("cwd").and_then(Value::as_str).map(str::to_owned);
        c.terminal = params.get("tty") == Some(&Value::Bool(true));
    }
    Ok(())
}
async fn hello_transaction(
    core: &mut Core,
    _conn: ConnectionId,
    params: &Map<String, Value>,
    transient: bool,
) -> Result<Claimed, RpcError> {
    if !transient {
        if let Some(resume) = params.get("resume").and_then(Value::as_str) {
            let row=core.store.all("SELECT * FROM endpoints WHERE token_hash = ? AND substr(handle,1,5) != 'gone:'",&[opt(Some(&hash(resume)))]).await?.into_iter().next().ok_or_else(||RpcError::new(ErrorCode::Unauthorized,"unknown resume token"))?;
            let id = text(&row, "id").ok_or_else(RpcError::internal)?;
            core.store
                .all(
                    "UPDATE endpoints SET connections = connections + 1,last_seen = ? WHERE id = ?",
                    &[SqlValue::Int(now_ms()), opt(Some(id))],
                )
                .await?;
            core.audit("resume", Some(id), None, json!({})).await?;
            return Ok(Claimed {
                row: core.must_endpoint(id).await?,
                resume: None,
                retired: None,
                created: false,
                subagent: false,
            });
        }
        if params.get("human") == Some(&Value::Bool(true)) {
            let row=core.store.all("UPDATE endpoints SET connections = connections + 1,last_seen = ? WHERE handle = '_human' RETURNING *",&[SqlValue::Int(now_ms())]).await?.into_iter().next().ok_or_else(RpcError::internal)?;
            core.audit("claim",text(&row,"id"),None,json!({"handle":"","harness":"human","tty":params.get("tty")==Some(&Value::Bool(true))})).await?;
            return Ok(Claimed {
                row,
                resume: None,
                retired: None,
                created: false,
                subagent: false,
            });
        }
    }
    let empty = Map::new();
    let claim = params
        .get("claim")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    if transient && let Some(join) = params.get("join") {
        let join = join
            .as_object()
            .ok_or_else(|| RpcError::invalid_params("join is {handle?, under?}"))?;
        let claimed = core.claim_agent(claim, true, None).await?;
        let row = &claimed.row;
        if let Some(handle) = join
            .get("handle")
            .filter(|v| !v.is_null() && v.as_str() != Some(""))
        {
            core.rename_row(row, handle, false, false).await?;
        }
        let row = core.must_endpoint(text(row, "id").unwrap_or("")).await?;
        if let Some(under) = join.get("under").and_then(Value::as_str) {
            let parent = core.lookup(under).await?;
            core.link_endpoint(&row, &parent, "session").await?;
        }
        return Ok(Claimed {
            row: core.must_endpoint(text(&row, "id").unwrap_or("")).await?,
            resume: None,
            retired: claimed.retired,
            created: claimed.created,
            subagent: false,
        });
    }
    core.claim_agent(claim, transient, params.get("self")).await
}
