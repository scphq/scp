use crate::claims::{
    Fields, Scope, clean_labels, clean_text, harness_fits, hash, process_key, same_harness, token,
    valid_handle, valid_token,
};
use crate::core::{Core, integer, now_ms, text, timestamp};
use crate::proto::{ErrorCode, RpcError};
use crate::state::ConnectionId;
use crate::store::{Row, SqlValue};
use crate::views::{address, not_found, opt};
use rand::RngCore;
use serde_json::{Map, Value, json};

const STORE_CHARS: usize = 2000;
const GRANT_TTL_S: i64 = 604_800;

pub fn json_column(row: &Row, key: &str, fallback: Value) -> Value {
    text(row, key)
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or(fallback)
}

fn steer_key() -> String {
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| char::from_digit(u32::from(b % 36), 36).unwrap_or('0'))
        .collect()
}

fn prompt_digest(raw: &str) -> Option<String> {
    let cut: String = raw.chars().take(256 * 1024).collect();
    let clean = crate::scrub::redact_secrets(&crate::scrub::strip_control(&cut));
    let mut kept: String = clean.chars().take(STORE_CHARS).collect();
    if kept.len() < clean.len() {
        if let Some(space) = kept.rfind(char::is_whitespace) {
            kept.truncate(space);
        }
        kept = format!("{}...", kept.trim_end());
    }
    (!kept.trim().is_empty()).then_some(kept)
}

impl Core {
    /// a `krt_` grant placing a claim under the actor or its descendant with the actor's caps and groups; stored hashed
    pub async fn grant(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        self.need_terminal(conn).await?;
        let me = self.actor_row(conn).await?;
        let agent = text(&me, "kind") == Some("agent");
        let named_under = params.get("under").filter(|v| !v.is_null());
        if !agent && named_under.is_none() {
            return Err(RpcError::invalid_params(
                "the human names the endpoint to grant under",
            ));
        }
        let under = match named_under {
            Some(value) => {
                let value = value
                    .as_str()
                    .ok_or_else(|| RpcError::invalid_params("under is an address"))?;
                self.lookup(value).await?
            }
            None => me.clone(),
        };
        if text(&under, "kind") != Some("agent")
            || (agent
                && text(&me, "id") != text(&under, "id")
                && !self
                    .ancestors(&under)
                    .await?
                    .iter()
                    .any(|id| text(&me, "id") == Some(id.as_str())))
        {
            return Err(not_found(
                named_under.and_then(Value::as_str).unwrap_or("endpoint"),
            ));
        }
        let name = clean_text(params.get("name"), "name", 63)?;
        if name.as_ref().is_some_and(|v| !valid_handle(v)) {
            return Err(RpcError::invalid_params("name is not a valid handle"));
        }
        let labels = clean_labels(params.get("labels"))?;
        if let Some(found) = crate::scrub::find_secret(&labels.to_string()) {
            return Err(RpcError::new(
                ErrorCode::SecretRefused,
                format!("the labels look like they carry a credential ({found})"),
            ));
        }
        let title =
            crate::session::one_line(params.get("title"), "title", 64)?.filter(|v| !v.is_empty());
        if title
            .as_ref()
            .is_some_and(|v| crate::scrub::find_secret(v).is_some())
        {
            return Err(RpcError::new(
                ErrorCode::SecretRefused,
                "the title looks like it carries a credential",
            ));
        }
        let ttl = params
            .get("ttl_s")
            .map(|v| {
                v.as_i64()
                    .filter(|v| (1..=GRANT_TTL_S).contains(v))
                    .ok_or_else(|| {
                        RpcError::invalid_params(format!("ttl_s must be 1 to {GRANT_TTL_S}"))
                    })
            })
            .transpose()?
            .unwrap_or(GRANT_TTL_S);
        let bound = match params.get("bind_process").filter(|v| !v.is_null()) {
            None => None,
            Some(v) => Some(
                v.as_str()
                    .filter(|v| process_key(v, true))
                    .ok_or_else(|| {
                        RpcError::invalid_params("bind_process is a key pid:<pid>:<start time>")
                    })?
                    .to_owned(),
            ),
        };
        let peek = match params.get("peek") {
            None => None,
            Some(Value::String(v)) if v == "local" => Some("local"),
            Some(_) => return Err(RpcError::invalid_params("peek is local")),
        };
        let flag = |key: &str| match params.get(key) {
            None => Ok(false),
            Some(Value::Bool(v)) => Ok(*v),
            Some(_) => Err(RpcError::invalid_params(format!("{key} is true or false"))),
        };
        let spawn = flag("spawn")?;
        let no_push = flag("no_push")?;
        let prompt = match params.get("prompt") {
            None => None,
            Some(Value::String(v)) => Some(v.as_str()),
            Some(_) => return Err(RpcError::invalid_params("prompt is a string")),
        };
        let prompt = prompt.filter(|_| peek.is_some()).and_then(prompt_digest);
        let actor = self.actor_of(conn)?;
        let (caps, groups) = self.grant_scope(&actor, &me, params).await?;
        let caps = caps.as_array().cloned().unwrap_or_default();
        let groups = groups.as_array().cloned().unwrap_or_default();
        let value = token("krt");
        let steer = spawn.then(steer_key);
        let now = now_ms();
        let expires = now + ttl * 1000;
        self.store.all("INSERT INTO grants (token_hash,issuer,under,name,labels,title,caps,groups,created_at,expires_at,bound_process,peek,spawn,no_push,prompt,steer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",&[opt(Some(&hash(&value))),opt(text(&me,"id")),opt(text(&under,"id")),opt(name.as_deref()),opt(Some(&labels.to_string())),opt(title.as_deref()),opt(Some(&json!(caps).to_string())),opt(Some(&json!(groups).to_string())),SqlValue::Int(now),SqlValue::Int(expires),opt(bound.as_deref()),opt(peek),if spawn {SqlValue::Int(1)} else {SqlValue::Null},if no_push {SqlValue::Int(1)} else {SqlValue::Null},opt(prompt.as_deref()),opt(steer.as_deref())]).await?;
        let mut detail = json!({
            "by": address(&me),
            "auth": actor.auth(),
            "target": address(&under),
            "caps": caps.iter().map(|c| json!({"dir": c["dir"], "sels": c["sels"].as_array().into_iter().flatten().map(|e| e["sel"].clone()).collect::<Vec<_>>()})).collect::<Vec<_>>(),
            "groups": groups.iter().map(|g| g["name"].clone()).collect::<Vec<_>>(),
            "expires_at": timestamp(expires),
        });
        for (key, on, value) in [
            ("name", name.is_some(), json!(name)),
            ("bound", bound.is_some(), json!(true)),
            ("peek", peek.is_some(), json!(peek)),
            ("spawn", spawn, json!(true)),
            ("no_push", no_push, json!(true)),
            ("prompt", prompt.is_some(), json!(true)),
        ] {
            if on {
                detail[key] = value;
            }
        }
        self.audit("scope_grant", text(&under, "id"), None, detail)
            .await?;
        let mut env = json!({"SCP_GRANT": value});
        if let Some(name) = name {
            env["SCP_NAME"] = json!(name);
        }
        let mut result = json!({"token": value, "env": env});
        if let Some(key) = steer {
            result["steer"] = json!({"key": key, "parent": address(&me)});
        }
        Ok(result)
    }

    /// the grant a spawner bound to a process on the claim's lineage: unspent and issued by the lineage parent (the human when none), or spent by the claimant's own process
    pub(crate) async fn bound_grant(
        &self,
        scope: &Scope,
        process: Option<&str>,
    ) -> Result<Option<Row>, RpcError> {
        if self
            .policy
            .as_ref()
            .and_then(|v| v.pointer("/defaults/verify_lineage"))
            == Some(&Value::Bool(true))
        {
            return Ok(None);
        }
        let parent = self
            .lineage_rows(&scope.lineage, &[])
            .await?
            .into_iter()
            .next();
        for key in scope.lineage.iter().filter(|v| process_key(v, true)) {
            let rows = self.store.all("SELECT * FROM grants WHERE bound_process = ? AND revoked_at IS NULL AND (used_by IS NOT NULL OR expires_at > ?) ORDER BY created_at DESC, rowid DESC",&[opt(Some(key)),SqlValue::Int(now_ms())]).await?;
            if rows.is_empty() {
                continue;
            }
            for grant in rows {
                let fits = if let Some(spender) = text(&grant, "used_by") {
                    let spender = self.by_id(spender).await?;
                    process
                        .zip(spender.as_ref().and_then(|r| text(r, "process")))
                        .is_some_and(|(a, b)| same_harness(b, a))
                } else {
                    let issued_here = match &parent {
                        Some(parent) => text(&grant, "issuer") == text(parent, "id"),
                        None => self
                            .by_id(text(&grant, "issuer").unwrap_or(""))
                            .await?
                            .is_some_and(|r| text(&r, "kind") == Some("human")),
                    };
                    issued_here && {
                        let mut probe = scope.clone();
                        probe.grant = text(&grant, "token_hash").map(str::to_owned);
                        if let Some(name) = text(&grant, "name") {
                            probe.handle = name.into();
                        }
                        self.placement(&probe, None, None).await?.refused.is_none()
                    }
                };
                if fits {
                    return Ok(Some(grant));
                }
            }
            return Ok(None);
        }
        Ok(None)
    }

    /// the claim's grant, when an endpoint spent it
    pub(crate) async fn spent_grant(&self, scope: &Scope) -> Result<Option<Row>, RpcError> {
        let Some(grant) = &scope.grant else {
            return Ok(None);
        };
        Ok(self.store.all("SELECT * FROM grants WHERE token_hash = ? AND used_by IS NOT NULL AND revoked_at IS NULL",&[opt(Some(grant))]).await?.into_iter().next())
    }

    /// a refused grant fails the claim; its audit row is written after the rollback
    pub(crate) fn grant_refused(&mut self, scope: &Scope, reason: &str) -> RpcError {
        self.state.deferred = Some((None, json!({"target": scope.handle, "reason": reason})));
        RpcError::new(ErrorCode::Unauthorized, format!("grant refused: {reason}"))
    }

    /// whether a claim that took `row` over starts a new incarnation of it: a new spawn by grant, or another process
    pub(crate) async fn incarnates(
        &self,
        row: &Row,
        scope: &Scope,
        process: Option<&str>,
    ) -> Result<Option<&'static str>, RpcError> {
        let id = text(row, "id");
        if self
            .spent_grant(scope)
            .await?
            .is_some_and(|g| text(&g, "used_by") == id)
        {
            return Ok(None);
        }
        if process
            .zip(text(row, "process"))
            .is_some_and(|(a, b)| same_harness(b, a))
        {
            return Ok(None);
        }
        if scope.grant.is_some()
            && self
                .placement(scope, Some(row), None)
                .await?
                .grant
                .is_some()
        {
            return Ok(Some("grant"));
        }
        let Some(nearest) = scope.nearest.as_deref() else {
            return Ok(Some("process"));
        };
        let runs_under = match text(row, "process") {
            Some(own) => own == nearest,
            None => match text(row, "parent_ep") {
                Some(parent) => self
                    .by_id(parent)
                    .await?
                    .is_some_and(|p| text(&p, "process") == Some(nearest)),
                None => false,
            },
        };
        Ok((!runs_under).then_some("process"))
    }

    /// whether the claim re-claims `row` with the grant `row` spent: from its process or an ancestor's, or with no lineage from its harness and cwd
    pub(crate) async fn redeems(
        &self,
        row: &Row,
        scope: &Scope,
        fields: &Fields,
        harness: &str,
        hooks: Option<&Row>,
    ) -> Result<bool, RpcError> {
        let Some(spent) = self.spent_grant(scope).await? else {
            return Ok(false);
        };
        if text(&spent, "used_by") != text(row, "id") {
            return Ok(false);
        }
        let out: Vec<&str> = hooks.and_then(|r| text(r, "id")).into_iter().collect();
        let Some(lineage) = self
            .lineage_rows(&scope.lineage, &out)
            .await?
            .into_iter()
            .next()
        else {
            return Ok(harness_fits(text(row, "harness"), harness)
                && text(&spent, "spent_cwd").is_some()
                && text(&spent, "spent_cwd") == fields.cwd.as_deref());
        };
        Ok(
            self.restarts(row, Some(&lineage), fields.process.as_deref())
                || self
                    .ancestors(row)
                    .await?
                    .iter()
                    .any(|id| Some(id.as_str()) == text(&lineage, "id")),
        )
    }

    /// a claim that joined or took over `row` spends a grant that would have placed it, adding its caps, title and groups
    pub(crate) async fn redeem(
        &mut self,
        row: &Row,
        scope: &Scope,
        fields: &Fields,
        by_session: bool,
    ) -> Result<(), RpcError> {
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        if self
            .spent_grant(scope)
            .await?
            .is_some_and(|g| text(&g, "used_by") == Some(id))
        {
            return Ok(());
        }
        let place = self.placement(scope, Some(row), None).await?;
        if let Some(reason) = place.refused {
            return Err(self.grant_refused(scope, reason));
        }
        if let Some(reason) = place.ignored {
            self.audit(
                "scope_grant_ignored",
                Some(id),
                None,
                json!({"target": address(row), "reason": reason}),
            )
            .await?;
        }
        let Some(grant) = place.grant else {
            return Ok(());
        };
        if by_session && self.unplaced(row).await? {
            return self.place(row, scope, fields).await;
        }
        self.spend(&grant, id, fields.cwd.as_deref()).await?;
        let mut caps = json_column(row, "caps", json!({"caps": [], "allow": {}}));
        let base = |cap: &Value| {
            let mut sels: Vec<String> = cap["sels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|e| e.get("via").is_none())
                .map(|e| {
                    json!([e["sel"], e.get("group").cloned().unwrap_or(Value::Null)]).to_string()
                })
                .collect();
            sels.sort();
            json!([cap["dir"], cap["by"], sels]).to_string()
        };
        let had: Vec<String> = caps["caps"]
            .as_array()
            .into_iter()
            .flatten()
            .map(base)
            .collect();
        let added: Vec<Value> = crate::groups::grant_caps(&grant)
            .into_iter()
            .filter_map(|cap| serde_json::to_value(cap).ok())
            .filter(|cap| !had.contains(&base(cap)))
            .collect();
        if !added.is_empty() {
            if !caps["caps"].is_array() {
                caps["caps"] = json!([]);
            }
            if let Some(list) = caps["caps"].as_array_mut() {
                list.extend(added);
            }
            if caps.get("allow").is_none() {
                caps["allow"] = json!({});
            }
            self.store
                .all(
                    "UPDATE endpoints SET caps = ? WHERE id = ?",
                    &[opt(Some(&caps.to_string())), opt(Some(id))],
                )
                .await?;
        }
        if let Some(title) = text(&grant, "title") {
            self.store
                .all(
                    "UPDATE endpoints SET title = COALESCE(title, ?) WHERE id = ?",
                    &[opt(Some(title)), opt(Some(id))],
                )
                .await?;
        }
        self.join_grant(&grant, id).await
    }

    /// a local root never named, linked or redeeming a grant, with no parent and no children, not a subagent's
    pub(crate) async fn unplaced(&self, row: &Row) -> Result<bool, RpcError> {
        let id = text(row, "id").unwrap_or("");
        Ok(text(row, "kind") == Some("agent")
            && text(row, "parent_ep").is_none()
            && text(row, "parent_addr").is_none()
            && integer(row, "linked").is_none()
            && integer(row, "named").is_none()
            && !text(row, "session").is_some_and(|v| v.starts_with("sub:"))
            && self
                .store
                .all(
                    "SELECT 1 AS x FROM endpoints WHERE parent_ep = ? LIMIT 1",
                    &[opt(Some(id))],
                )
                .await?
                .is_empty()
            && self
                .store
                .all(
                    "SELECT 1 AS x FROM grants WHERE used_by = ? LIMIT 1",
                    &[opt(Some(id))],
                )
                .await?
                .is_empty())
    }

    pub(crate) async fn spend(
        &self,
        grant: &Row,
        endpoint: &str,
        cwd: Option<&str>,
    ) -> Result<(), RpcError> {
        self.store.all("UPDATE grants SET used_by = ?,spent_cwd = ?,prompt = NULL WHERE token_hash = ? AND used_by IS NULL",&[opt(Some(endpoint)),opt(cwd),opt(text(grant,"token_hash"))]).await?;
        Ok(())
    }

    /// a new incarnation drops groups, widened entries and admin rows; a grant one is a new spawn and also drops caps but the human's, rules, status, title and old mail
    pub(crate) async fn reset(
        &self,
        row: &Row,
        scope: &Scope,
        kind: &str,
        moved: &[i64],
    ) -> Result<(), RpcError> {
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        let now = now_ms();
        let groups: Vec<Value> = self
            .store
            .all(
                "SELECT name FROM group_members WHERE endpoint = ? ORDER BY name",
                &[opt(Some(id))],
            )
            .await?
            .iter()
            .filter_map(|r| text(r, "name").map(|v| json!(v)))
            .collect();
        for name in groups.iter().filter_map(Value::as_str) {
            self.leave_group(name, id).await?;
        }
        let admins = self
            .store
            .all(
                "UPDATE admins SET revoked_at = ? WHERE subject = ? AND revoked_at IS NULL RETURNING subject",
                &[SqlValue::Int(now), opt(Some(id))],
            )
            .await?
            .len();
        let current = self.must_endpoint(id).await?;
        let caps: Vec<Value> = json_column(&current, "caps", json!({}))["caps"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|cap| kind == "process" || cap["by"] == json!("human"))
            .map(|mut cap| {
                let by = cap["by"].clone();
                let sels: Vec<Value> = cap["sels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|e| e.get("via").is_none_or(|via| *via == by))
                    .cloned()
                    .collect();
                cap["sels"] = json!(sels);
                cap
            })
            .collect();
        let stored = (!caps.is_empty()).then(|| json!({"caps": caps, "allow": {}}).to_string());
        if kind == "process" {
            self.store.all("UPDATE endpoints SET caps = ?,reset_at = ?,peek = NULL,wake = NULL,hold_ref = NULL WHERE id = ?",&[opt(stored.as_deref()),SqlValue::Int(now),opt(Some(id))]).await?;
        } else {
            self.store.all("UPDATE endpoints SET rules = NULL,caps = ?,status_state = NULL,status_note = NULL,title = NULL,reset_at = ?,spawned_at = ?,peek = NULL,harness_session = NULL,wake = NULL,hold_ref = NULL WHERE id = ?",&[opt(stored.as_deref()),SqlValue::Int(now),SqlValue::Int(now),opt(Some(id))]).await?;
        }
        self.store
            .all(
                "DELETE FROM peek_turns WHERE endpoint = ?",
                &[opt(Some(id))],
            )
            .await?;
        let grant = match (kind, &scope.grant) {
            ("grant", Some(hash)) => self
                .store
                .all(
                    "SELECT issuer,created_at FROM grants WHERE token_hash = ?",
                    &[opt(Some(hash))],
                )
                .await?
                .into_iter()
                .next(),
            _ => None,
        };
        let mut dropped = 0;
        if kind == "grant" {
            let deliveries = self.store.all("SELECT d.seq AS seq,d.acked_at AS acked_at,m.from_ep AS from_ep,m.created_at AS created_at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ?",&[opt(Some(id))]).await?;
            for delivery in deliveries {
                let seq = integer(&delivery, "seq").unwrap_or(0);
                if moved.contains(&seq) {
                    continue;
                }
                let unread = integer(&delivery, "acked_at").is_none();
                if unread
                    && let Some(grant) = &grant
                    && text(&delivery, "from_ep") == text(grant, "issuer")
                    && integer(&delivery, "created_at") >= integer(grant, "created_at")
                {
                    continue;
                }
                self.store
                    .all(
                        "DELETE FROM deliveries WHERE seq = ?",
                        &[SqlValue::Int(seq)],
                    )
                    .await?;
                if unread {
                    dropped += 1;
                }
            }
        }
        self.store.all("UPDATE grants SET revoked_at = COALESCE(revoked_at,?) WHERE used_by = ? AND token_hash IS NOT ?",&[SqlValue::Int(now),opt(Some(id)),opt(scope.grant.as_deref())]).await?;
        let owned: Vec<Value> = self
            .store
            .all(
                "SELECT name FROM groups WHERE owner = ? ORDER BY name",
                &[opt(Some(id))],
            )
            .await?
            .iter()
            .filter_map(|r| text(r, "name").map(|v| json!(v)))
            .collect();
        let issuer = grant.as_ref().and_then(|g| text(g, "issuer"));
        let stewards = match issuer {
            Some(issuer) => {
                self.by_id(issuer)
                    .await?
                    .is_some_and(|r| text(&r, "kind") == Some("human"))
                    || self.ancestors(row).await?.iter().any(|v| v == issuer)
            }
            None => false,
        };
        let steward = match issuer {
            Some(issuer) if stewards => issuer.to_owned(),
            _ => self
                .by_handle("_human")
                .await?
                .and_then(|r| text(&r, "id").map(str::to_owned))
                .unwrap_or_default(),
        };
        if !owned.is_empty() {
            self.store
                .all(
                    "UPDATE groups SET owner = ? WHERE owner = ?",
                    &[opt(Some(&steward)), opt(Some(id))],
                )
                .await?;
        }
        let mut detail = json!({
            "by": match issuer { Some(issuer) => self.address_of(issuer).await?, None => address(row) },
            "target": address(row),
            "reason": if kind == "grant" { "a new spawn took over the endpoint" } else { "another process took over the endpoint" },
            "groups": groups,
            "before": {
                "caps": json_column(row, "caps", json!({"caps": [], "allow": {}})),
                "rules": json_column(row, "rules", json!({})),
                "status": text(row, "status_state"),
                "note": text(row, "status_note"),
            },
        });
        if admins > 0 {
            detail["admins"] = json!(admins);
        }
        if dropped > 0 {
            detail["dropped"] = json!(dropped);
        }
        if !owned.is_empty() {
            detail["owned"] = json!(owned);
            detail["owner"] = json!(self.address_of(&steward).await?);
        }
        self.audit("scope_reset", Some(id), None, detail).await
    }

    /// whether a shell carrying the spawn-env grant may act as `id`: the endpoint that spent it, or one below it
    pub async fn grant_binds(&self, value: &Value, id: Option<&str>) -> Result<bool, RpcError> {
        let raw = value
            .as_str()
            .filter(|s| valid_token(s, "krt_"))
            .ok_or_else(|| RpcError::invalid_params("grant is a krt_ token"))?;
        let grant=self.store.all("SELECT * FROM grants WHERE token_hash = ? AND used_by IS NOT NULL AND revoked_at IS NULL", &[opt(Some(&hash(raw)))]).await?.into_iter().next();
        let (Some(spender), Some(id)) = (grant.as_ref().and_then(|r| text(r, "used_by")), id)
        else {
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
}

impl Core {
    /// the grant `token` and the endpoint that spent it, for its issuer or an ancestor of that endpoint
    async fn spawn_grant(&self, me: &Row, token: &str) -> Result<(Row, Option<Row>), RpcError> {
        let grant = self
            .store
            .all(
                "SELECT * FROM grants WHERE token_hash = ?",
                &[opt(Some(&hash(token)))],
            )
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "no such grant"))?;
        let spender = match text(&grant, "used_by") {
            Some(id) => self.by_id(id).await?,
            None => None,
        };
        let below = match &spender {
            Some(row) => self
                .ancestors(row)
                .await?
                .iter()
                .any(|id| Some(id.as_str()) == text(me, "id")),
            None => false,
        };
        if text(&grant, "issuer") != text(me, "id") && !below {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only the grant's issuer ends its spawn",
            ));
        }
        if spender.is_some() && integer(&grant, "revoked_at").is_some() {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "the grant was revoked: a new spawn holds its endpoint",
            ));
        }
        Ok((grant, spender))
    }

    /// the spawned worker's harness session, transcript and the issuer's unread steers to it; `take` marks them read for a resume
    pub async fn spawn_steers(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let token = params
            .get("grant")
            .and_then(Value::as_str)
            .filter(|v| valid_token(v, "krt_"))
            .ok_or_else(|| RpcError::invalid_params("grant is a krt_ token"))?;
        let take = params.get("take") == Some(&Value::Bool(true));
        let me = self.actor_row(conn).await?;
        crate::store::transaction(self.store.clone(), async {
            let (grant, spender) = self.spawn_grant(&me, token).await?;
            let Some(spender) = spender else {
                return Ok(json!({"session": null, "steers": [], "transcript": null, "joined": false}));
            };
            let id = text(&spender, "id").ok_or_else(RpcError::internal)?;
            let now = now_ms();
            let page = self.limits.get("inboxPage").unwrap_or(100) as i64;
            let rows = self.store.all("SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND m.from_ep = ? AND d.expires_at > ? AND m.created_at >= ? AND d.acked_at IS NULL ORDER BY d.seq LIMIT ?",&[opt(Some(id)),opt(text(&grant,"issuer")),SqlValue::Int(now),SqlValue::Int(integer(&grant,"created_at").unwrap_or(0)),SqlValue::Int(page)]).await?;
            let mut steers = Vec::new();
            for row in &rows {
                steers.push(self.message_envelope(row, id).await?);
            }
            let session = text(&spender, "harness_session");
            if take && session.is_some() && !rows.is_empty() {
                self.store
                    .all(
                        "UPDATE endpoints SET hook_seen = NULL WHERE id = ?",
                        &[opt(Some(id))],
                    )
                    .await?;
                for row in &rows {
                    self.store
                        .all(
                            "UPDATE deliveries SET acked_at = ? WHERE seq = ? AND acked_at IS NULL",
                            &[SqlValue::Int(now), SqlValue::Int(integer(row, "seq").unwrap_or(0))],
                        )
                        .await?;
                }
                self.audit(
                    "ack",
                    Some(id),
                    None,
                    json!({"count": rows.len(), "by": address(&me)}),
                )
                .await?;
            }
            Ok(json!({
                "session": session,
                "steers": steers,
                "transcript": session.and(text(&spender, "harness_transcript")),
                "joined": true,
            }))
        })
        .await
    }
}
