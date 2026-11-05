//! `swarm login` (`login.ts`): a token checked against the hub's whoami, else the device flow, which shows a code to approve in the
//! browser and polls until the hub hands over a token. The token is stored for the active relay and never printed.

use super::cloud::machine_name;
use super::relay::{active_relay, save_credential};
use crate::fleet::json::Json;
use crate::fleet::thrown;
use crate::fleet::view::text;
use crate::term::{note, out};
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::ps::Env;
use scp_mcp::tools::js_trim;
use std::time::{Duration, Instant};

const WHOAMI_FIELDS: [&str; 8] = [
    "kind",
    "org",
    "email",
    "role",
    "label",
    "ambient",
    "endpoint_labels",
    "expires_at",
];
const METADATA: [&str; 4] = ["kind", "org", "email", "label"];
const REQUEST_MS: f64 = 30_000.0;

/// the flags login takes
pub struct Values<'a> {
    pub token: Option<&'a str>,
    pub label: Option<&'a str>,
    pub no_browser: bool,
    pub json: bool,
}

/// opens `url` in the browser: `$BROWSER` (none for none), else `open` on macOS and `xdg-open` on Linux; never over SSH or on a Linux
/// without a display. True once the command was started, whether or not it then runs
pub fn open_browser(url: &str, env: &Env) -> bool {
    let set = |key: &str| env.get(key).is_some_and(|v| !v.is_empty());
    let web = url.starts_with("http://") || url.starts_with("https://");
    let headless = cfg!(target_os = "linux") && !set("DISPLAY") && !set("WAYLAND_DISPLAY");
    if !web || set("SSH_CONNECTION") || set("SSH_TTY") || headless {
        return false;
    }
    let command = match env.get("BROWSER") {
        Some(browser) => (!browser.is_empty() && browser != "none").then_some(browser.as_str()),
        None if cfg!(target_os = "macos") => Some("open"),
        None if cfg!(target_os = "linux") => Some("xdg-open"),
        None => None,
    };
    let Some(command) = command else {
        return false;
    };
    let mut child = std::process::Command::new(command);
    child
        .arg(url)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches no memory of this process
        unsafe {
            child.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    match child.spawn() {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::InvalidInput,
    }
}

/// what one request got back: its status and body, None for what fetch rejects (no connection, a timeout, a redirect)
struct Got {
    status: u16,
    body: Option<Vec<u8>>,
}

async fn fetch(request: reqwest::RequestBuilder, timeout_ms: f64) -> Option<Got> {
    let response = request
        .timeout(Duration::from_millis(timeout_ms.max(1.0) as u64))
        .send()
        .await
        .ok()?;
    let status = response.status().as_u16();
    if matches!(status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let body = response.bytes().await.ok().map(|b| b.to_vec());
    Some(Got { status, body })
}

/// the reply as a JSON object, None when it is not one
fn object(got: &Got) -> Option<Json> {
    match Json::parse(got.body.as_deref()?) {
        Some(object @ Json::Obj(_)) => Some(object),
        _ => None,
    }
}

fn invalid() -> Fail {
    thrown("the relay returned an invalid login response".into())
}

fn metadata(who: &Json) -> Vec<(&'static str, Json)> {
    METADATA
        .iter()
        .filter_map(|key| match who.get(key) {
            Some(value @ Json::Str(_)) => Some((*key, value.clone())),
            _ => None,
        })
        .collect()
}

fn done(url: &str, who: &Json, json: bool) -> Done {
    if json {
        let public = WHOAMI_FIELDS
            .iter()
            .filter_map(|key| who.get(key).map(|value| (*key, value.clone())))
            .collect();
        out(&Json::object(public).compact());
    } else {
        let or_unknown = |key: &str| match who.get(key) {
            None | Some(Json::Null) => "?".to_owned(),
            value => text(value),
        };
        out(&format!(
            "logged in to {url} as {} in {}",
            or_unknown("email"),
            or_unknown("org")
        ));
    }
    Ok(0)
}

fn http() -> Result<reqwest::Client, Fail> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| thrown(error.to_string()))
}

/// logs in to the active relay as `values` say: a token checked and stored, else the device flow
pub async fn sign_in(env: &Env, values: &Values<'_>) -> Done {
    let (url, _) = active_relay(env)?;
    let token = match values.token {
        Some(token) => Some(js_trim(token)),
        None => env.get("SCP_TOKEN").map(|t| js_trim(t)),
    };
    if values.token.is_some() && token.is_none_or(str::is_empty) {
        return Err(usage("--token needs a nonempty token"));
    }
    let http = http()?;
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        let request = http.get(format!("{url}/v1/whoami")).bearer_auth(token);
        let got = fetch(request, REQUEST_MS)
            .await
            .ok_or_else(|| thrown(format!("could not check the token at {url}")))?;
        if got.status == 401 {
            return Err(thrown(format!("that token is not valid for {url}")));
        }
        if got.status != 200 {
            return Err(thrown(format!(
                "could not check the token at {url} (HTTP {})",
                got.status
            )));
        }
        let who = object(&got).ok_or_else(invalid)?;
        let mut credential = vec![("token", Json::str(token))];
        credential.extend(metadata(&who));
        save_credential(env, &url, credential)?;
        return done(&url, &who, values.json);
    }
    let label = machine_name(values.label, env)?;
    let body = Json::object(vec![("label", Json::str(label.clone()))]).compact();
    let request = http
        .post(format!("{url}/v1/device/code"))
        .header("Content-Type", "application/json")
        .body(body);
    let got = fetch(request, REQUEST_MS)
        .await
        .ok_or_else(|| thrown(format!("could not start login at {url}")))?;
    let start = object(&got).ok_or_else(invalid)?;
    if !(200..300).contains(&got.status) {
        return Err(thrown(match start.get("error_description") {
            Some(Json::Str(description)) => description.clone(),
            _ => format!("could not start login at {url} (HTTP {})", got.status),
        }));
    }
    let string = |key: &str| start.get(key).and_then(Json::as_str);
    let number = |key: &str| match start.get(key) {
        Some(Json::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    };
    let (
        Some(device_code),
        Some(user_code),
        Some(_),
        Some(complete),
        Some(expires_in),
        Some(interval),
    ) = (
        string("device_code"),
        string("user_code"),
        string("verification_uri"),
        string("verification_uri_complete"),
        number("expires_in").filter(|n| *n > 0.0),
        number("interval").filter(|n| *n >= 0.0),
    )
    else {
        return Err(thrown("the relay returned an invalid device code".into()));
    };
    let began = Instant::now();
    let now = || began.elapsed().as_secs_f64() * 1000.0;
    let expires = expires_in * 1000.0;
    let mut interval = interval * 1000.0;
    note(&format!("to sign in, open {complete}"));
    note(&format!("and check that it shows the code {user_code}"));
    let opened = !values.no_browser && open_browser(complete, env);
    note(if opened {
        "opened it in your browser; waiting for approval"
    } else {
        "waiting for approval"
    });
    let poll = Json::object(vec![("device_code", Json::str(device_code))]).compact();
    while now() < expires {
        let wait = interval.min((expires - now()).max(0.0));
        tokio::time::sleep(Duration::from_secs_f64(wait / 1000.0)).await;
        if now() >= expires {
            break;
        }
        let request = http
            .post(format!("{url}/v1/device/token"))
            .header("Content-Type", "application/json")
            .body(poll.clone());
        let Some(got) = fetch(request, REQUEST_MS.min(expires - now())).await else {
            continue;
        };
        if got.status >= 500 {
            continue;
        }
        let Some(mut body) = object(&got) else {
            continue;
        };
        let ok = (200..300).contains(&got.status);
        if let (true, Some(Json::Str(access))) = (ok, body.get("access_token"))
            && !access.is_empty()
        {
            let mut credential = Json::object(vec![("token", Json::str(access.clone()))]);
            for (key, value) in metadata(&body) {
                credential.set(key, value);
            }
            credential.set("kind", Json::str("device"));
            let given = match body.get("label") {
                Some(Json::Str(given)) => given.clone(),
                _ => label.clone(),
            };
            credential.set("label", Json::str(given));
            let Json::Obj(credential) = credential else {
                unreachable!("an object");
            };
            save_credential(
                env,
                &url,
                credential
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.clone()))
                    .collect(),
            )?;
            body.set("kind", Json::str("device"));
            return done(&url, &body, values.json);
        }
        match body.get("error") {
            Some(Json::Str(error)) if error == "authorization_pending" => continue,
            Some(Json::Str(error)) if error == "slow_down" => {
                interval += 5000.0;
                continue;
            }
            _ => {}
        }
        return Err(thrown(
            match (body.get("error_description"), body.get("error")) {
                (Some(Json::Str(description)), _) => description.clone(),
                (_, Some(Json::Str(error))) => format!("login failed: {error}"),
                _ => format!("login failed: HTTP {}", got.status),
            },
        ));
    }
    Err(thrown(format!(
        "the device code expired: run {CLI_NAME} login again"
    )))
}

/// `swarm login [--token T] [--label L] [--no-browser]`, then a running broker links again with the new login
pub fn login(call: &Call) -> Done {
    let flags = &call.parsed;
    if !flags.positionals.is_empty() {
        return Err(usage(format!("{CLI_NAME} login takes only flags")));
    }
    let values = Values {
        token: flags.text("token"),
        label: flags.text("label"),
        no_browser: flags.on("no-browser"),
        json: flags.on("json"),
    };
    let code = crate::open::block_on(sign_in(call.env, &values))??;
    #[cfg(unix)]
    if code == 0 {
        super::cloud::relink_running(call.env);
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_browser_opens_over_ssh_for_a_non_web_url_or_with_browser_none() {
        let env = |pairs: &[(&str, &str)]| -> Env {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .chain([("DISPLAY".to_owned(), ":0".to_owned())])
                .collect()
        };
        assert!(!open_browser("ftp://x", &env(&[("BROWSER", "true")])));
        assert!(!open_browser("https://x", &env(&[("BROWSER", "none")])));
        assert!(!open_browser("https://x", &env(&[("BROWSER", "")])));
        assert!(!open_browser(
            "https://x",
            &env(&[("BROWSER", "true"), ("SSH_TTY", "/dev/pts/1")])
        ));
    }

    #[test]
    fn the_public_whoami_keeps_its_fields_in_order() {
        let who = Json::parse(
            br#"{"token":"secret","email":"a@b","kind":"token","ambient":{},"role":null}"#,
        )
        .unwrap();
        let public: Vec<(&str, Json)> = WHOAMI_FIELDS
            .iter()
            .filter_map(|key| who.get(key).map(|value| (*key, value.clone())))
            .collect();
        assert_eq!(
            Json::object(public).compact(),
            r#"{"kind":"token","email":"a@b","role":null,"ambient":{}}"#
        );
        let saved: Vec<&str> = metadata(&who).iter().map(|(k, _)| *k).collect();
        assert_eq!(saved, ["kind", "email"]);
    }
}
