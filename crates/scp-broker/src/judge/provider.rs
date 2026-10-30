use async_trait::async_trait;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderError {
    Outage,
    Rejected,
    NoKey,
}

#[async_trait]
pub trait JudgeClient: Send + Sync {
    async fn judge(&self, prompt: &str) -> Result<String, ProviderError>;
}

pub(crate) struct Model<'a> {
    name: &'a str,
    url: &'static str,
    blocks: bool,
    completion_cap: bool,
}

pub(crate) fn model(id: &str) -> Result<Model<'_>, ProviderError> {
    let (provider, name) = id.split_once('/').ok_or(ProviderError::Rejected)?;
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
    {
        return Err(ProviderError::Rejected);
    }
    let (url, blocks, completion_cap) = if provider == concat!("open", "ai") {
        (
            concat!("https://api.open", "ai.com/v1/chat/completions"),
            false,
            true,
        )
    } else if provider == concat!("open", "router") {
        (
            concat!("https://open", "router.ai/api/v1/chat/completions"),
            false,
            false,
        )
    } else if provider == concat!("anth", "ropic") {
        (
            concat!("https://api.anth", "ropic.com/v1/messages"),
            true,
            false,
        )
    } else {
        return Err(ProviderError::Rejected);
    };
    Ok(Model {
        name,
        url,
        blocks,
        completion_cap,
    })
}

pub struct HttpJudgeClient {
    config: Value,
    http: reqwest::Client,
}

impl HttpJudgeClient {
    pub fn new(config: Value) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
        }
    }

    pub(crate) fn key(config: &Value) -> Option<String> {
        if let Some(env) = config["key_env"].as_str() {
            std::env::var(env).ok().filter(|s| !s.is_empty())
        } else {
            std::fs::read_to_string(config["key_file"].as_str()?)
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        }
    }
}

#[async_trait]
impl JudgeClient for HttpJudgeClient {
    async fn judge(&self, prompt: &str) -> Result<String, ProviderError> {
        let key = Self::key(&self.config).ok_or(ProviderError::NoKey)?;
        let m = model(self.config["id"].as_str().ok_or(ProviderError::Rejected)?)?;
        let effort = self.config["effort"].as_str().unwrap_or("medium");
        let mut body = json!({"model":m.name,"messages":[{"role":"user","content":prompt}]});
        let mut request = self.http.post(m.url);
        if m.blocks {
            body["max_tokens"] = json!(4096);
            body["output_config"] = json!({"effort":effort});
            request = request
                .header("x-api-key", key)
                .header(concat!("anth", "ropic-version"), "2023-06-01");
        } else {
            body[if m.completion_cap {
                "max_completion_tokens"
            } else {
                "max_tokens"
            }] = json!(4096);
            body["reasoning_effort"] = json!(effort);
            request = request.bearer_auth(key);
        }
        let mut response = request
            .json(&body)
            .send()
            .await
            .map_err(|_| ProviderError::Outage)?;
        if !response.status().is_success() {
            return Err(if matches!(response.status().as_u16(), 400 | 413 | 422) {
                ProviderError::Rejected
            } else {
                ProviderError::Outage
            });
        }
        let mut raw = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ProviderError::Outage)? {
            if raw.len() + chunk.len() > 256 * 1024 {
                return Err(ProviderError::Rejected);
            }
            raw.extend_from_slice(&chunk);
        }
        let parsed: Value = serde_json::from_slice(&raw).map_err(|_| ProviderError::Rejected)?;
        let content = if m.blocks {
            &parsed["content"]
        } else {
            &parsed["choices"][0]["message"]["content"]
        };
        let text = if let Some(s) = content.as_str() {
            s.to_owned()
        } else {
            content
                .as_array()
                .ok_or(ProviderError::Rejected)?
                .iter()
                .filter(|v| v["type"] == "text")
                .filter_map(|v| v["text"].as_str())
                .collect::<String>()
        };
        if text.is_empty() {
            Err(ProviderError::Rejected)
        } else {
            Ok(text)
        }
    }
}
