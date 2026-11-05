//! `spawn-env`: a grant for a harness started by hand, as `KEY=value` lines for `env $(swarm spawn-env ...) cmd`.

use crate::fleet::ask;
use crate::fleet::json::Json;
use crate::fleet::view::text;
use crate::open::Opened;
use crate::spawn::grant::grant_params;
use crate::term::out;
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::client::CallError;

/// the grant's environment as `KEY=value` lines, unquoted, in the order the broker wrote it
pub fn env_lines(env: Option<&Json>) -> Result<Vec<String>, Fail> {
    match env {
        None | Some(Json::Null) => Err(Fail::Call(CallError::Io(
            "Cannot convert undefined or null to object".into(),
        ))),
        Some(env) => Ok(env
            .entries()
            .into_iter()
            .map(|(key, value)| format!("{key}={}", text(Some(value))))
            .collect()),
    }
}

pub fn spawn_env<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        if !call.parsed.positionals.is_empty() {
            return Err(usage(format!("{CLI_NAME} spawn-env takes only flags")));
        }
        let params = grant_params(&call.parsed)?;
        let params = params
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        let reply = ask(opened, "grant", params).await?;
        for line in env_lines(reply.get("env"))? {
            out(&line);
        }
        Ok(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_lines_keep_the_broker_order_and_the_bytes() {
        let env = Json::parse(
            "{\"SCP_NAME\":\"kid\",\"SCP_TITLE\":\"a b\\n$x \\\"q\\\" ünï\",\"2\":1,\"A\":null}"
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            env_lines(Some(&env)).unwrap(),
            [
                "2=1",
                "SCP_NAME=kid",
                "SCP_TITLE=a b\n$x \"q\" ünï",
                "A=null"
            ]
        );
        assert!(env_lines(None).is_err());
    }
}
