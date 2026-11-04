//! `swarm daemon`: the broker in the foreground, or `stop` and `restart`, read as the TypeScript CLI reads them and run natively.

use crate::{Call, Done, Run, Verb, usage};
use scp_core::protocol::CLI_NAME;

pub const VERBS: &[Verb] = &[Verb {
    name: "daemon",
    run: Run::Parsed(daemon),
}];

fn daemon(call: &Call) -> Done {
    let parsed = &call.parsed;
    let idle = parsed.text("idle");
    let policy = parsed.text("policy");
    let mut words = Vec::new();
    if let Some(action) = parsed.positionals.first() {
        if parsed.positionals.len() != 1
            || (action != "stop" && action != "restart")
            || parsed.has("idle")
            || parsed.has("policy")
        {
            return Err(usage(format!(
                "{CLI_NAME} daemon takes stop or restart, or --idle and --policy to run in the foreground"
            )));
        }
        words.push(action.clone());
    } else {
        if let Some(idle) = idle {
            words.extend(["--idle".to_owned(), idle.to_owned()]);
        }
        if let Some(policy) = policy.filter(|p| !p.is_empty()) {
            let cwd = scp_mcp::identity::safe_cwd();
            let absolute = scp_mcp::client::normalize(&std::path::Path::new(&cwd).join(policy));
            words.extend([
                "--policy".to_owned(),
                absolute.to_string_lossy().into_owned(),
            ]);
        }
    }
    Ok((call.host.daemon)(&words))
}
