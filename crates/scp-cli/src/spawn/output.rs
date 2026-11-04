//! What a spawn hands back: the harness's output tail, its stderr tail, the thread a codex run opened and a Claude worker's replies.

use scp_broker::session::{HANDBACK_CUT, handback_output, keep_last};
use scp_core::protocol::LIMITS;
use scp_mcp::ps::basename;
use scp_mcp::render::js_space;
use serde_json::Value;
use std::borrow::Cow;
use std::os::unix::fs::{FileExt, OpenOptionsExt};

/// the first bytes a harness wrote to stdout and to stderr
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Head {
    pub out: Vec<u8>,
    pub err: Vec<u8>,
}

/// a harness run as spawn saw it: its exit code, the tails of its output and whether they were cut, its output's start, whether it started
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HarnessRun {
    pub code: i32,
    pub tail: Vec<u8>,
    pub cut: bool,
    pub err: Vec<u8>,
    pub err_cut: bool,
    pub head: Option<Head>,
    pub started: bool,
}

/// bytes as `new TextDecoder().decode` reads them: a leading BOM dropped, bad bytes replaced
fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// the index past the UTF-8 continuation bytes at `from`
fn char_start(bytes: &[u8], mut from: usize) -> usize {
    while from < bytes.len() && bytes[from] & 0xc0 == 0x80 {
        from += 1;
    }
    from
}

/// a lowercase UUID at the start of `text`, and the rest
fn uuid_prefix(text: &str) -> Option<(&str, &str)> {
    let id = text.get(..36)?;
    let ok = id.bytes().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => b == b'-',
        _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
    });
    ok.then(|| (id, &text[36..]))
}

fn line_break(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `^session id: (UUID)\r?$` with the m flag: the first line that is the header
fn session_line(text: &str) -> Option<String> {
    let starts = std::iter::once(0).chain(
        text.char_indices()
            .filter(|(_, c)| line_break(*c))
            .map(|(i, c)| i + c.len_utf8()),
    );
    for start in starts {
        let Some(rest) = text[start..].strip_prefix("session id: ") else {
            continue;
        };
        if let Some((id, after)) = uuid_prefix(rest)
            && after.chars().next().is_none_or(line_break)
        {
            return Some(id.to_owned());
        }
    }
    None
}

/// `^\{"type":"thread\.started","thread_id":"(UUID)"\}\r?$` on one line
fn thread_event(line: &str) -> Option<String> {
    let rest = line.strip_prefix(r#"{"type":"thread.started","thread_id":""#)?;
    let (id, after) = uuid_prefix(rest)?;
    matches!(after, "\"}" | "\"}\r").then(|| id.to_owned())
}

/// the thread a codex exec run opened, as its output starts: the `session id:` header on stderr, else --json's first event on stdout
pub fn codex_thread(run: &HarnessRun) -> Option<String> {
    let head = run.head.as_ref()?;
    session_line(&decode(&head.err)).or_else(|| {
        let out = decode(&head.out);
        thread_event(out.split('\n').next().unwrap_or(""))
    })
}

/// Decode from a whole UTF-8 character, then clean, redact and cap the output tail.
pub fn harness_output(run: &HarnessRun, bytes: Option<i64>) -> String {
    let start = if run.cut { char_start(&run.tail, 0) } else { 0 };
    handback_output(
        &decode(&run.tail[start..]),
        run.cut,
        bytes.unwrap_or(LIMITS.handback_bytes as i64),
    )
}

const EARLIER_STDERR: &str = "[earlier stderr cut]";

/// Keep the cleaned stderr tail from a line or character boundary, marking earlier output that was cut.
pub fn stderr_output(run: &HarnessRun, bytes: Option<i64>) -> String {
    let bytes = bytes.unwrap_or(LIMITS.stderr_bytes as i64);
    let start = if run.err_cut {
        char_start(&run.err, 0)
    } else {
        0
    };
    let text = decode(&run.err[start..]);
    let kept = match text.find('\n') {
        Some(nl) if run.err_cut => &text[nl + 1..],
        _ => &text,
    };
    let clean = handback_output(kept, false, i64::MAX);
    let encoded = clean.as_bytes();
    let n = encoded.len() as i64;
    if n <= bytes {
        return if run.err_cut && !clean.is_empty() {
            format!("{EARLIER_STDERR}\n{clean}")
        } else {
            clean
        };
    }
    let mut from = n - bytes;
    let search = (from - 1).max(0) as usize;
    let line = encoded
        .get(search..)
        .and_then(|rest| rest.iter().position(|b| *b == b'\n'))
        .map(|p| search + p);
    match line {
        Some(line) if line + 1 < encoded.len() => from = line as i64 + 1,
        _ => from = char_start(encoded, from.max(0) as usize) as i64,
    }
    let from = (from as usize).min(encoded.len());
    format!("{EARLIER_STDERR}\n{}", decode(&encoded[from..]))
}

/// how much of a transcript's end spawn reads
pub const TRANSCRIPT_BYTES: u64 = 4 * 1024 * 1024;
/// what follows a reply the model's output limit cut off
const LIMIT_CUT: &str = "[reply cut at the model's output limit]";

/// JSON text with each lone surrogate escape as U+FFFD, which is what the string `JSON.parse` keeps encodes to; serde_json refuses them
pub fn well_formed(json: &str) -> Cow<'_, str> {
    let unit = |at: usize| {
        let digits = json.get(at + 2..at + 6)?;
        (json.get(at..at + 2)? == "\\u")
            .then(|| u16::from_str_radix(digits, 16).ok())
            .flatten()
    };
    let bytes = json.as_bytes();
    let mut out = String::new();
    let (mut copied, mut i) = (0, 0);
    while i + 1 < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        match unit(i) {
            Some(0xd800..=0xdbff) if matches!(unit(i + 6), Some(0xdc00..=0xdfff)) => i += 12,
            Some(0xd800..=0xdfff) => {
                out.push_str(&json[copied..i]);
                out.push_str("\\ufffd");
                i += 6;
                copied = i;
            }
            Some(_) => i += 6,
            None => i += 2,
        }
    }
    if copied == 0 {
        return Cow::Borrowed(json);
    }
    out.push_str(&json[copied..]);
    Cow::Owned(out)
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

/// a block's text: itself when a string, a text block's text, else none
fn block_text(block: &Value) -> Option<&Value> {
    match block {
        Value::String(_) => Some(block),
        _ if field(block, "type").and_then(Value::as_str) == Some("text") => field(block, "text"),
        _ => None,
    }
}

fn blocks(content: Option<&Value>) -> Vec<Option<&Value>> {
    match content {
        Some(Value::Array(items)) => items.iter().map(Some).collect(),
        other => vec![other],
    }
}

/// whether a transcript's user entry is a prompt: text from the user, not a tool result, hook feedback or a compaction summary
fn prompted(entry: &Value, content: Option<&Value>) -> bool {
    if field(entry, "isMeta") == Some(&Value::Bool(true))
        || field(entry, "isCompactSummary") == Some(&Value::Bool(true))
        || field(entry, "toolUseResult").is_some()
    {
        return false;
    }
    let blocks = blocks(content);
    if blocks
        .iter()
        .any(|b| b.and_then(|b| field(b, "type")).and_then(Value::as_str) == Some("tool_result"))
    {
        return false;
    }
    blocks.iter().any(|b| {
        b.and_then(block_text)
            .and_then(Value::as_str)
            .is_some_and(|t| !js_trim(t).is_empty() && !t.starts_with("Stop hook feedback"))
    })
}

/// the last `bytes` of the regular file at `path`, opened without following a link or blocking, and where they start
fn read_end(path: &str, bytes: u64) -> Option<(String, u64)> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let stat = file.metadata().ok()?;
    if !stat.is_file() {
        return None;
    }
    let start = stat.len().saturating_sub(bytes);
    let mut buffer = vec![0u8; (stat.len() - start) as usize];
    let read = if buffer.is_empty() {
        0
    } else {
        file.read_at(&mut buffer, start).ok()?
    };
    Some((String::from_utf8_lossy(&buffer[..read]).into_owned(), start))
}

/// Read the last transcript bytes from a regular, unlinked session file under root. Keep assistant replies since its last prompt.
pub fn transcript_replies(path: &str, session: &str, root: &str, bytes: u64) -> Vec<String> {
    if !path.starts_with('/') || basename(path) != format!("{session}.jsonl") {
        return Vec::new();
    }
    let (Ok(real), Ok(real_root)) = (std::fs::canonicalize(path), std::fs::canonicalize(root))
    else {
        return Vec::new();
    };
    if !real
        .to_string_lossy()
        .starts_with(&format!("{}/", real_root.to_string_lossy()))
    {
        return Vec::new();
    }
    let Some((text, start)) = read_end(path, bytes) else {
        return Vec::new();
    };
    let mut replies: Vec<String> = if start > 0 {
        vec![HANDBACK_CUT.to_owned()]
    } else {
        Vec::new()
    };
    for line in text.split('\n').skip(usize::from(start > 0)) {
        let Ok(entry) = serde_json::from_str::<Value>(&well_formed(line)) else {
            continue;
        };
        if !entry.is_object()
            || field(&entry, "isSidechain") == Some(&Value::Bool(true))
            || field(&entry, "sessionId").and_then(Value::as_str) != Some(session)
        {
            continue;
        }
        let message = field(&entry, "message");
        let content = message
            .filter(|m| m.is_object())
            .and_then(|m| field(m, "content"));
        let kind = field(&entry, "type").and_then(Value::as_str);
        if kind == Some("user") && prompted(&entry, content) {
            replies.clear();
        }
        if kind != Some("assistant") {
            continue;
        }
        let before = replies.len();
        for block in blocks(content) {
            if let Some(reply) = block.and_then(block_text).and_then(Value::as_str)
                && !js_trim(reply).is_empty()
            {
                replies.push(reply.to_owned());
            }
        }
        let limit = message
            .and_then(|m| field(m, "stop_reason"))
            .and_then(Value::as_str)
            == Some("max_tokens");
        if replies.len() > before
            && limit
            && let Some(last) = replies.pop()
        {
            replies.push(format!("{last}\n{LIMIT_CUT}"));
        }
    }
    replies
}

fn lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(js_trim)
        .filter(|l| !l.is_empty())
        .collect()
}

/// Drop restated reports, keep the newest whole replies within the byte cap, and return empty for marker-only output.
pub fn replies_output(replies: &[String], bytes: Option<i64>) -> String {
    let bytes = bytes.unwrap_or(LIMITS.handback_bytes as i64);
    let all: Vec<String> = replies
        .iter()
        .map(|reply| {
            let unix = reply.replace("\r\n", "\n").replace('\r', "\n");
            handback_output(&unix, false, i64::MAX)
        })
        .filter(|text| !text.is_empty())
        .collect();
    let restated = |text: &str, later: &str| {
        let mine = lines(text);
        let theirs = lines(later);
        mine.len() >= 2 && mine.iter().all(|l| theirs.contains(l))
    };
    let clean: Vec<&String> = all
        .iter()
        .enumerate()
        .filter(|(i, text)| {
            *text == HANDBACK_CUT || !all[*i + 1..].iter().any(|later| restated(text, later))
        })
        .map(|(_, text)| text)
        .collect();
    if clean.iter().all(|text| *text == HANDBACK_CUT) {
        return String::new();
    }
    let framed = |from: usize| {
        let text = clean[from..]
            .iter()
            .map(|t| t.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        if from > 0 {
            format!("{HANDBACK_CUT}\n\n{text}")
        } else {
            text
        }
    };
    let mut fit = None;
    for from in (0..clean.len()).rev() {
        let text = framed(from);
        if text.len() as i64 > bytes {
            break;
        }
        fit = Some(text);
    }
    if let Some(fit) = fit {
        return fit;
    }
    keep_last(clean[clean.len() - 1], bytes, clean.len() > 1)
}
