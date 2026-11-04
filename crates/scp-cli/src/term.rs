//! All output of the native verbs: lines to stdout and stderr as the TypeScript CLI writes them, JSON as `JSON.stringify(v, null, 2)`.
//! A reader that went away (`swarm status | head -1`) ends the command quietly with 0.

use scp_core::protocol::CLI_NAME;
use serde_json::Value;

/// exit code for swarm's own failures, kept apart from a spawned harness's codes
pub const FAILED: i32 = 125;

fn write_all(fd: i32, mut bytes: &[u8]) -> std::io::Result<()> {
    while !bytes.is_empty() {
        // SAFETY: writes from a live slice of its own length
        let wrote = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if wrote >= 0 {
            bytes = &bytes[wrote as usize..];
            continue;
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => {}
            Some(code) if code == libc::EAGAIN || code == libc::EWOULDBLOCK => {
                let mut poll = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: one pollfd it owns
                unsafe { libc::poll(&mut poll, 1, -1) };
            }
            _ => return Err(error),
        }
    }
    Ok(())
}

/// `text` on stdout as is
pub fn print(text: &str) {
    print_bytes(text.as_bytes());
}

/// `bytes` on stdout as is
pub fn print_bytes(bytes: &[u8]) {
    match write_all(1, bytes) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::EPIPE) => std::process::exit(0),
        Err(error) => {
            eprint_raw(&format!("{CLI_NAME}: stdout: {error}\n"));
            std::process::exit(1);
        }
    }
}

/// one line on stdout
pub fn out(line: &str) {
    print(&format!("{line}\n"));
}

fn eprint_raw(text: &str) {
    let _ = write_all(2, text.as_bytes());
}

/// `bytes` on stderr as is
pub fn eprint_bytes(bytes: &[u8]) {
    let _ = write_all(2, bytes);
}

/// one line on stderr, as is
pub fn err(line: &str) {
    eprint_raw(&format!("{line}\n"));
}

/// one line on stderr, prefixed `swarm: ` unless it starts with `swarm `
pub fn note(message: &str) {
    let prefix = if message.starts_with(&format!("{CLI_NAME} ")) {
        String::new()
    } else {
        format!("{CLI_NAME}: ")
    };
    err(&format!("{prefix}{message}"));
}

/// `value` as `JSON.stringify(value, null, 2)` on stdout
pub fn json(value: &Value) {
    out(&pretty(value));
}

/// `entries` as an object, in their order, as `JSON.stringify(object, null, 2)`
pub fn json_entries(entries: &[(&str, &Value)]) {
    out(&pretty_entries(entries));
}

pub fn pretty(value: &Value) -> String {
    let mut text = String::new();
    write_value(&mut text, value, 0);
    text
}

pub fn pretty_entries(entries: &[(&str, &Value)]) -> String {
    let mut text = String::new();
    write_object(&mut text, entries.iter().copied(), entries.is_empty(), 0);
    text
}

fn indent(text: &mut String, depth: usize) {
    text.push('\n');
    for _ in 0..depth {
        text.push_str("  ");
    }
}

fn write_object<'a>(
    text: &mut String,
    entries: impl Iterator<Item = (&'a str, &'a Value)>,
    empty: bool,
    depth: usize,
) {
    if empty {
        text.push_str("{}");
        return;
    }
    text.push('{');
    for (at, (key, value)) in entries.enumerate() {
        if at > 0 {
            text.push(',');
        }
        indent(text, depth + 1);
        text.push_str(&crate::args::js_string(key));
        text.push_str(": ");
        write_value(text, value, depth + 1);
    }
    indent(text, depth);
    text.push('}');
}

fn write_value(text: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Null => text.push_str("null"),
        Value::Bool(on) => text.push_str(if *on { "true" } else { "false" }),
        Value::Number(_) => text.push_str(&scp_mcp::tools::js(Some(value))),
        Value::String(s) => text.push_str(&crate::args::js_string(s)),
        Value::Array(items) => {
            if items.is_empty() {
                text.push_str("[]");
                return;
            }
            text.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    text.push(',');
                }
                indent(text, depth + 1);
                write_value(text, item, depth + 1);
            }
            indent(text, depth);
            text.push(']');
        }
        Value::Object(map) => write_object(
            text,
            map.iter().map(|(k, v)| (k.as_str(), v)),
            map.is_empty(),
            depth,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_reads_as_javascript_writes_it() {
        assert_eq!(pretty(&json!({})), "{}");
        assert_eq!(pretty(&json!([])), "[]");
        assert_eq!(
            pretty(&json!({"a": [1, 2.5, {"b": null}], "c": "q\"\n\u{1}", "d": 2.0})),
            "{\n  \"a\": [\n    1,\n    2.5,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": \"q\\\"\\n\\u0001\",\n  \"d\": 2\n}"
        );
        let z = json!(false);
        assert_eq!(
            pretty_entries(&[("z", &z), ("a", &json!([]))]),
            "{\n  \"z\": false,\n  \"a\": []\n}"
        );
    }

    #[test]
    fn a_closed_reader_is_an_epipe() {
        let mut fds = [0; 2];
        // SAFETY: a fresh pipe, both ends closed below
        unsafe {
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            libc::close(fds[0]);
        }
        let error = write_all(fds[1], b"x").unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EPIPE));
        // SAFETY: the write end opened above
        unsafe { libc::close(fds[1]) };
    }
}
