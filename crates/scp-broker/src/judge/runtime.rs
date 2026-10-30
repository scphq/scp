use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::provider::{HttpJudgeClient, JudgeClient, ProviderError};
use super::verdict::{PROMPT_VERSION, Verdict, parse_verdict, prefilter, prompt, sort_categories};
use crate::core::now_ms;
use crate::proto::{Limits, RpcError};
use scp_core::protocol::ErrorCode;

pub fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub struct VerdictCache {
    entries: VecDeque<(String, Verdict, i64)>,
    max: usize,
}

impl Default for VerdictCache {
    fn default() -> Self {
        Self::new(1000)
    }
}

impl VerdictCache {
    pub fn new(max: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max,
        }
    }
    pub fn get(&mut self, key: &str, now: i64) -> Option<Verdict> {
        let i = self.entries.iter().position(|entry| entry.0 == key)?;
        let entry = self.entries.remove(i)?;
        if entry.2 <= now {
            return None;
        }
        let result = entry.1.clone();
        self.entries.push_back(entry);
        Some(result)
    }
    pub fn set(&mut self, key: String, verdict: &Verdict, now: i64) {
        let ttl = match verdict.verdict.as_str() {
            "pass" | "redact" => 86_400_000,
            "refuse" => 3_600_000,
            _ => return,
        };
        if verdict.source == "error" {
            return;
        }
        self.entries.retain(|entry| entry.0 != key);
        self.entries.push_back((key, verdict.clone(), now + ttl));
        while self.entries.len() > self.max {
            self.entries.pop_front();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Call,
    Probe,
    Open,
}

#[derive(Default)]
struct BreakerState {
    failures: VecDeque<(String, i64)>,
    until: Option<i64>,
    probing: bool,
}

#[derive(Default)]
pub struct JudgeBreaker {
    scopes: VecDeque<(String, BreakerState)>,
}

impl JudgeBreaker {
    pub fn admit(&mut self, scope: &str, now: i64) -> Admission {
        let Some((_, state)) = self.scopes.iter_mut().find(|(s, _)| s == scope) else {
            return Admission::Call;
        };
        let Some(until) = state.until else {
            return Admission::Call;
        };
        if now < until || state.probing {
            return Admission::Open;
        }
        state.probing = true;
        Admission::Probe
    }
    pub fn success(&mut self, scope: &str, admission: Admission) {
        if admission == Admission::Probe {
            self.scopes.retain(|(s, _)| s != scope);
        }
    }
    pub fn release(&mut self, scope: &str, admission: Admission) {
        if admission == Admission::Probe
            && let Some((_, state)) = self.scopes.iter_mut().find(|(s, _)| s == scope)
        {
            state.probing = false;
        }
    }
    pub fn failure(&mut self, scope: &str, admission: Admission, body_hash: String, now: i64) {
        if !self.scopes.iter().any(|(s, _)| s == scope) {
            self.scopes
                .push_back((scope.into(), BreakerState::default()));
            if self.scopes.len() > 256 {
                self.scopes.pop_front();
            }
        }
        let state = &mut self
            .scopes
            .iter_mut()
            .find(|(s, _)| s == scope)
            .expect("tracked scope")
            .1;
        if admission == Admission::Probe {
            state.probing = false;
            state.until = Some(now + 30_000);
            return;
        }
        if state.until.is_some() {
            return;
        }
        state
            .failures
            .retain(|(hash, at)| *at > now - 60_000 && *hash != body_hash);
        state.failures.push_back((body_hash, now));
        if state.failures.len() >= 3 {
            state.failures.clear();
            state.until = Some(now + 30_000);
        }
    }
}

#[derive(Default)]
pub struct JudgeGate {
    pub(crate) policy: Option<Value>,
    version: String,
    client: Option<Arc<dyn JudgeClient>>,
    injected: Option<Arc<dyn JudgeClient>>,
    rates: [Option<usize>; 4],
    cache: VerdictCache,
    breaker: JudgeBreaker,
    spent: HashMap<String, Vec<i64>>,
}

impl JudgeGate {
    pub fn new(limits: &Limits) -> Self {
        Self {
            rates: [
                "pairPerMinute",
                "pairPerHour",
                "treePerMinute",
                "treePerHour",
            ]
            .map(|key| limits.get(key).map(|n| n as usize)),
            ..Default::default()
        }
    }
    pub fn configure(&mut self, policy: Option<&Value>) {
        self.policy = policy.cloned();
        self.version = policy.map(|p| hash(&p.to_string())).unwrap_or_default();
        self.client = self.injected.clone();
        if let Some(model) = policy
            .filter(|p| p["mode"] != "off")
            .and_then(|p| p.get("model"))
            && self.injected.is_none()
            && HttpJudgeClient::key(model).is_some()
        {
            self.client = Some(Arc::new(HttpJudgeClient::new(model.clone())));
        }
    }

    pub fn set_client(&mut self, client: Arc<dyn JudgeClient>) {
        self.injected = Some(client.clone());
        self.client = Some(client);
    }

    pub(crate) fn sweep(&mut self, now: i64) {
        self.spent
            .retain(|_, times| times.last().is_some_and(|at| *at > now - 3_600_000));
    }

    pub(crate) fn spend(&mut self, from: &str, tree: &str, now: i64) -> Result<(), RpcError> {
        let policy = self.policy.as_ref().expect("judge policy");
        let minute = policy["budget"]["per_minute"].as_u64().unwrap_or(120) as usize;
        let hour = policy["budget"]["per_hour"].as_u64().unwrap_or(1200) as usize;
        let budgets = [
            (
                format!("ep:{from}"),
                self.rates[0],
                self.rates[1],
                "from this endpoint",
            ),
            (
                format!("tree:{tree}"),
                self.rates[2],
                self.rates[3],
                "from this lineage tree",
            ),
            ("*".to_owned(), Some(minute), Some(hour), "on this broker"),
        ];
        for (key, minute, hour, what) in &budgets {
            let spent = self.spent.entry(key.clone()).or_default();
            spent.retain(|at| *at > now - 3_600_000);
            for (limit, window) in [(*minute, 60_000), (*hour, 3_600_000)] {
                let Some(limit) = limit else {
                    continue;
                };
                let times: Vec<_> = spent.iter().filter(|at| **at > now - window).collect();
                if times.len() >= limit {
                    let mut error = RpcError::new(
                        ErrorCode::RateLimited,
                        format!("{limit} judged messages {what} in {} s", window / 1000),
                    );
                    error.data.as_mut().expect("error data").extra.insert(
                        "retry_after".into(),
                        json!(((times[0] + window - now + 999) / 1000).max(1)),
                    );
                    return Err(error);
                }
            }
        }
        for (key, _, _, _) in budgets {
            self.spent.entry(key).or_default().push(now);
        }
        Ok(())
    }

    pub(crate) async fn judge(
        &mut self,
        body: &str,
        from: &str,
        groups: &[(String, Vec<String>)],
    ) -> Verdict {
        let mut verdicts = Vec::new();
        for (boundary, to) in groups {
            verdicts.push(self.run(body, from, to, boundary).await);
        }
        let rank = |v: &Verdict| match v.verdict.as_str() {
            "refuse" => 3,
            "hold" => 2,
            "redact" => 1,
            _ => 0,
        };
        let mut verdict = verdicts
            .iter()
            .reduce(|a, b| if rank(b) > rank(a) { b } else { a })
            .expect("judge boundaries")
            .clone();
        verdict.categories = verdicts.iter().flat_map(|v| v.categories.clone()).collect();
        sort_categories(&mut verdict.categories);
        verdict.redactions.clear();
        for v in verdicts {
            for redaction in v.redactions {
                if !verdict
                    .redactions
                    .iter()
                    .any(|r| r.quote == redaction.quote)
                {
                    verdict.redactions.push(redaction);
                }
            }
        }
        verdict
    }

    async fn run(&mut self, body: &str, from: &str, to: &[String], boundary: &str) -> Verdict {
        let started = now_ms();
        let pre = prefilter(body);
        if pre.secret.is_some() {
            return pre.verdict("");
        }
        let key = hash(
            &json!([
                "local",
                self.version,
                PROMPT_VERSION,
                boundary,
                body,
                from,
                to
            ])
            .to_string(),
        );
        if let Some(mut cached) = self.cache.get(&key, started) {
            cached.source = "cache".into();
            cached.ms = Some(now_ms() - started);
            return cached;
        }
        let Some(client) = self.client.clone() else {
            return pre.verdict(
                if self
                    .policy
                    .as_ref()
                    .is_some_and(|p| p.get("model").is_some())
                {
                    " (judge_unavailable)"
                } else {
                    ""
                },
            );
        };
        let policy = self.policy.as_ref().expect("judge policy");
        let fail = policy["fail"].as_str().unwrap_or("open").to_owned();
        let model = policy["model"]["id"].as_str().map(str::to_owned);
        let scope = hash(&policy["model"].to_string());
        let admission = if fail == "prefilter" {
            self.breaker.admit(&scope, started)
        } else {
            Admission::Call
        };
        if admission == Admission::Open {
            return pre.verdict(" (judge_unavailable)");
        }
        let prompt = prompt(body, boundary, from, to, &pre);
        let timeout = Duration::from_secs(policy["timeout_s"].as_u64().unwrap_or(12));
        let result = tokio::time::timeout(timeout, client.judge(&prompt))
            .await
            .unwrap_or(Err(ProviderError::Outage));
        if fail == "prefilter" {
            match &result {
                Ok(_) => self.breaker.success(&scope, admission),
                Err(ProviderError::Outage) => {
                    self.breaker
                        .failure(&scope, admission, hash(body), now_ms())
                }
                _ => self.breaker.release(&scope, admission),
            }
        }
        if matches!(result, Err(ProviderError::NoKey)) && fail == "prefilter" {
            return pre.verdict(" (judge_unavailable)");
        }
        let mut verdict = match result
            .ok()
            .and_then(|answer| parse_verdict(&answer, body).ok())
        {
            Some(mut v) => {
                for r in pre.redactions {
                    if !v
                        .redactions
                        .iter()
                        .any(|existing| existing.quote == r.quote)
                    {
                        v.redactions.push(r);
                    }
                }
                if v.verdict == "pass" && !v.redactions.is_empty() {
                    v.verdict = "redact".into();
                }
                if pre.categories.iter().any(|c| c == "pii") {
                    v.categories.push("pii".into());
                    sort_categories(&mut v.categories);
                }
                v
            }
            None => Verdict {
                verdict: if fail == "open" {
                    if pre.redactions.is_empty() {
                        "pass"
                    } else {
                        "redact"
                    }
                } else {
                    "hold"
                }
                .into(),
                categories: pre.categories,
                reason: "judge_unavailable".into(),
                redactions: pre.redactions,
                source: "error".into(),
                prompt_version: PROMPT_VERSION.into(),
                model: None,
                ms: None,
            },
        };
        verdict.model = model;
        self.cache.set(key, &verdict, now_ms());
        verdict.ms = Some(now_ms() - started);
        verdict
    }
}
