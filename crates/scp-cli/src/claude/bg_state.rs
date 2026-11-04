//! What the claude-bg policy reads and writes: `claude agents` entries, the broker's agents, launcher records, `<id>.state.json`,
//! `claude-bg-task.json` and the per-session lock. Objects stay `Json`, so a rewrite keeps their key order and any key it does not know.

use crate::fleet::json::Json;
use crate::open::node_fs_error;
use indexmap::{IndexMap, IndexSet};
use scp_core::protocol::{LIMITS, revive_record};
use scp_mcp::client::relay_dir;
use scp_mcp::ps::Env;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// the provider a stopped or removed worker is hibernated by; its waker is `swarm claude-wake`
pub const PROVIDER: &str = "claude-bg";

fn hex_lower(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn short_id(text: &str) -> bool {
    text.len() == 8 && hex_lower(text)
}

pub fn session_id(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && hex_lower(part))
}

/// a session name passed back to `claude --name`: never read as an option
pub fn safe_name(text: &str) -> bool {
    let word = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'@' | b'+' | b' ');
    let bytes = text.as_bytes();
    (1..=100).contains(&bytes.len())
        && word(bytes[0])
        && bytes[1..].iter().all(|b| word(*b) || *b == b'-')
}

pub fn wake_ticket(text: &str) -> bool {
    text.strip_prefix("kwt_")
        .is_some_and(|hex| hex.len() == 64 && hex_lower(hex))
}

/// the hibernation ref of a worker: its revive record, or the bare session id when the record would not fit a ref
pub fn revive_ref(session: &str, cwd: &str, name: Option<&str>) -> String {
    let mut argv = vec!["claude", "--bg", "--resume", session];
    if let Some(name) = name.filter(|name| safe_name(name)) {
        argv.extend(["--name", name]);
    }
    let record = Json::object(vec![
        ("via", Json::str(PROVIDER)),
        ("harness", Json::str("claude-code")),
        ("session", Json::str(session)),
        ("cwd", Json::str(cwd)),
        ("argv", Json::Arr(argv.into_iter().map(Json::str).collect())),
    ]);
    let text = record.compact();
    if text.encode_utf16().count() <= LIMITS.wake_ref_chars as usize {
        text
    } else {
        session.to_owned()
    }
}

/// the session id a `claude-bg` hibernation ref names: a revive record's session, or the bare id
pub fn ref_session(reference: &str) -> String {
    revive_record(Some(reference)).map_or_else(|| reference.to_owned(), |record| record.session)
}

/// one entry of `claude agents --json [--all]`; `raw` is what Claude Code printed
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub kind: Option<String>,
    pub session_id: Option<String>,
    pub name: Option<String>,
    pub state: Option<String>,
    pub pid: Option<f64>,
    pub status: Option<String>,
    pub raw: Json,
}

impl Entry {
    pub fn new(raw: Json) -> Entry {
        let text = |key: &str| raw.get(key).and_then(Json::as_str).map(str::to_owned);
        Entry {
            id: text("id"),
            cwd: text("cwd"),
            kind: text("kind"),
            session_id: text("sessionId"),
            name: text("name"),
            state: text("state"),
            pid: raw.get("pid").and_then(Json::as_f64),
            status: text("status"),
            raw,
        }
    }

    /// the entry as the task remembers a session it stopped
    pub fn without_pid(&self) -> Entry {
        Entry::new(without(&self.raw, &["pid"]))
    }

    pub fn background(&self) -> bool {
        self.kind.as_deref() == Some("background")
    }
}

/// the object without `keys`
pub fn without(object: &Json, keys: &[&str]) -> Json {
    match object {
        Json::Obj(entries) => Json::Obj(
            entries
                .iter()
                .filter(|(key, _)| !keys.contains(&key.as_str()))
                .cloned()
                .collect(),
        ),
        other => other.clone(),
    }
}

/// what the policy reads of one broker agent
#[derive(Debug, Clone, PartialEq)]
pub struct Agent {
    pub id: String,
    pub address: String,
    pub handle: String,
    pub harness: Option<String>,
    pub parent: Option<String>,
    pub children: f64,
    pub subagents: f64,
    pub harness_session: Option<String>,
    pub state: String,
    pub presence: String,
    pub historic: bool,
    pub worked_at: String,
    pub mail_at: Option<String>,
    pub connections: f64,
    pub hibernate: Option<String>,
    pub unread: bool,
    pub unread_at: Option<String>,
    pub handed_back: bool,
}

impl Agent {
    pub fn new(value: &Json) -> Agent {
        let text = |key: &str| value.get(key).and_then(Json::as_str).map(str::to_owned);
        let number = |key: &str| value.get(key).and_then(Json::as_f64).unwrap_or(0.0);
        let flag = |key: &str| matches!(value.get(key), Some(Json::Bool(true)));
        Agent {
            id: text("id").unwrap_or_default(),
            address: text("address").unwrap_or_default(),
            handle: text("handle").unwrap_or_default(),
            harness: text("harness"),
            parent: text("parent"),
            children: number("children"),
            subagents: number("subagents"),
            harness_session: text("harness_session"),
            state: text("state").unwrap_or_default(),
            presence: text("presence").unwrap_or_default(),
            historic: flag("historic"),
            worked_at: text("worked_at").unwrap_or_default(),
            mail_at: text("mail_at"),
            connections: number("connections"),
            hibernate: text("hibernate"),
            unread: flag("unread"),
            unread_at: text("unread_at"),
            handed_back: flag("handed_back"),
        }
    }
}

/// a background session `swarm claude --bg` started: its MCP config, the handle that config claims, and whether it asked for a parent
#[derive(Debug, Clone, PartialEq)]
pub struct BgRecord {
    pub file: String,
    pub handle: Option<String>,
    pub parented: bool,
}

impl BgRecord {
    pub fn parse(file: String, text: &str) -> Option<BgRecord> {
        let config = Json::parse(text.as_bytes())?;
        let vars = config
            .get("mcpServers")
            .and_then(|servers| servers.get("scp"))
            .and_then(|scp| scp.get("env"));
        let var = |key: &str| vars.and_then(|vars| vars.get(key)).and_then(Json::as_str);
        Some(BgRecord {
            file,
            handle: var("SCP_NAME")
                .filter(|handle| !handle.is_empty())
                .map(str::to_owned),
            parented: ["SCP_GRANT", "SCP_UNDER"]
                .iter()
                .any(|key| var(key).is_some_and(|value| !value.is_empty())),
        })
    }
}

pub type Records = IndexMap<String, BgRecord>;

/// what `<id>.state.json` keeps of a worker the policy stopped or removed
#[derive(Debug, Clone, PartialEq)]
pub struct BgState(pub Json);

impl BgState {
    pub fn parse(text: &str) -> Option<BgState> {
        let value = Json::parse(text.as_bytes())?;
        let valid = ["sessionId", "cwd"]
            .iter()
            .all(|key| value.get(key).and_then(Json::as_str).is_some());
        valid.then_some(BgState(value))
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Json::as_str)
    }

    pub fn session_id(&self) -> &str {
        self.text("sessionId").unwrap_or_default()
    }

    pub fn cwd(&self) -> &str {
        self.text("cwd").unwrap_or_default()
    }

    pub fn name(&self) -> Option<&str> {
        self.text("name").filter(|name| !name.is_empty())
    }

    pub fn handle(&self) -> Option<&str> {
        self.text("handle")
    }

    pub fn moved_to(&self) -> Option<&str> {
        self.text("movedTo").filter(|id| !id.is_empty())
    }

    pub fn removed(&self) -> bool {
        !matches!(
            self.0.get("removedAt"),
            None | Some(Json::Null | Json::Bool(false))
        ) && self.0.get("removedAt").and_then(Json::as_f64) != Some(0.0)
    }

    /// when `claude rm` refused and why; `at` is NaN when unreadable, as it compares in JavaScript
    pub fn rm_refused(&self) -> Option<(f64, String)> {
        let refused = self.0.get("rmRefused")?;
        if matches!(refused, Json::Null) {
            return None;
        }
        let at = refused.get("at").and_then(Json::as_f64).unwrap_or(f64::NAN);
        let reason = refused
            .get("reason")
            .and_then(Json::as_str)
            .unwrap_or("undefined");
        Some((at, reason.to_owned()))
    }
}

/// `{sessionId, cwd, name?, handle?}` over `base`'s keys, as a spread of `base` then those
pub fn state_over(
    base: Json,
    session: &str,
    cwd: &str,
    name: Option<&str>,
    handle: Option<&str>,
) -> Json {
    let mut state = base;
    state.set("sessionId", Json::str(session));
    state.set("cwd", Json::str(cwd));
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        state.set("name", Json::str(name));
    }
    if let Some(handle) = handle {
        state.set("handle", Json::str(handle));
    }
    state
}

/// what one claude-bg task run hands the next
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskState {
    /// the short ids of the background sessions in the last listing, by session id
    pub sessions: IndexMap<String, String>,
    /// the records the last listing covered
    pub seen: IndexSet<String>,
    /// the sessions with a record the last listing showed stopped, by short id
    pub stopped: IndexMap<String, Entry>,
    pub listed: bool,
}

impl TaskState {
    pub fn parse(text: &str) -> TaskState {
        let Some(raw) = Json::parse(text.as_bytes()) else {
            return TaskState::default();
        };
        let pairs = |key: &str| -> Vec<(String, Json)> {
            raw.get(key)
                .map(Json::items)
                .unwrap_or_default()
                .iter()
                .filter_map(|pair| match pair {
                    Json::Arr(items) if items.len() == 2 => {
                        Some((items[0].as_str()?.to_owned(), items[1].clone()))
                    }
                    _ => None,
                })
                .collect()
        };
        TaskState {
            sessions: pairs("sessions")
                .into_iter()
                .filter_map(|(key, value)| Some((key, value.as_str()?.to_owned())))
                .collect(),
            seen: raw
                .get("seen")
                .map(Json::items)
                .unwrap_or_default()
                .iter()
                .filter_map(|one| one.as_str().map(str::to_owned))
                .collect(),
            stopped: pairs("stopped")
                .into_iter()
                .filter(|(_, value)| matches!(value, Json::Obj(_)))
                .map(|(key, value)| (key, Entry::new(value)))
                .collect(),
            listed: matches!(raw.get("listed"), Some(Json::Bool(true))),
        }
    }

    pub fn to_json(&self) -> Json {
        let strings = |key: &str, value: &str| Json::Arr(vec![Json::str(key), Json::str(value)]);
        Json::object(vec![
            (
                "sessions",
                Json::Arr(self.sessions.iter().map(|(k, v)| strings(k, v)).collect()),
            ),
            ("seen", Json::Arr(self.seen.iter().map(Json::str).collect())),
            (
                "stopped",
                Json::Arr(
                    self.stopped
                        .iter()
                        .map(|(id, entry)| Json::Arr(vec![Json::str(id), entry.raw.clone()]))
                        .collect(),
                ),
            ),
            ("listed", Json::Bool(self.listed)),
        ])
    }
}

pub fn bg_dir(env: &Env) -> PathBuf {
    relay_dir(env).join("claude-bg")
}

fn state_path(env: &Env, id: &str) -> PathBuf {
    bg_dir(env).join(format!("{id}.state.json"))
}

fn task_path(env: &Env) -> PathBuf {
    relay_dir(env).join("claude-bg-task.json")
}

fn file_text(path: &Path) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn fs_fail(error: &std::io::Error, syscall: &str, path: &Path) -> String {
    node_fs_error(error, syscall, &path.to_string_lossy())
}

/// `path` as a private directory: made if missing, refused unless a directory this user owns, then set to 0700
pub fn private_dir(path: &Path) -> Result<(), String> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|error| fs_fail(&error, "mkdir", path))?;
    let meta = std::fs::symlink_metadata(path).map_err(|error| fs_fail(&error, "lstat", path))?;
    // SAFETY: getuid cannot fail
    if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
        return Err(format!(
            "{} is not a directory this user owns",
            path.display()
        ));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| fs_fail(&error, "chmod", path))
}

/// this process's id and 64 random bits: a temporary name no other writer has
fn unique() -> String {
    let random = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    format!("{}.{random:016x}", std::process::id())
}

fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// `text` at `path`, mode 0600, by rename from a temporary file of this writer alone, so two writers never share one
pub fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let temp = beside(path, &format!(".{}.tmp", unique()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|error| fs_fail(&error, "open", &temp))?;
    let written = file
        .write_all(text.as_bytes())
        .map_err(|error| fs_fail(&error, "write", &temp))
        .and_then(|()| {
            std::fs::rename(&temp, path).map_err(|error| fs_fail(&error, "rename", &temp))
        });
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// the sessions `swarm claude --bg` started, by short id
pub fn read_records(env: &Env) -> Records {
    let dir = bg_dir(env);
    let mut records = Records::new();
    let Ok(names) = std::fs::read_dir(&dir) else {
        return records;
    };
    for name in names.flatten() {
        let name = name.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json").filter(|id| short_id(id)) else {
            continue;
        };
        let Ok(file) = std::fs::canonicalize(dir.join(&name)) else {
            continue;
        };
        let record = file_text(&file)
            .and_then(|text| BgRecord::parse(file.to_string_lossy().into_owned(), &text));
        if let Some(record) = record {
            records.insert(id.to_owned(), record);
        }
    }
    records
}

pub fn read_state(env: &Env, id: &str) -> Option<BgState> {
    BgState::parse(&file_text(&state_path(env, id))?)
}

pub fn write_state(env: &Env, id: &str, state: &Json) -> Result<(), String> {
    private_dir(&bg_dir(env))?;
    write_private(&state_path(env, id), &format!("{}\n", state.pretty()))
}

pub fn remove_state(env: &Env, id: &str) -> Result<(), String> {
    let path = state_path(env, id);
    std::fs::remove_file(&path).map_err(|error| fs_fail(&error, "unlink", &path))
}

/// the states of `ids`, leaving out those with no readable file
pub fn read_states<'a>(env: &Env, ids: impl Iterator<Item = &'a str>) -> HashMap<String, BgState> {
    ids.filter_map(|id| read_state(env, id).map(|state| (id.to_owned(), state)))
        .collect()
}

pub fn read_task_state(env: &Env) -> TaskState {
    file_text(&task_path(env)).map_or_else(TaskState::default, |text| TaskState::parse(&text))
}

pub fn write_task_state(env: &Env, state: &TaskState) -> Result<(), String> {
    write_private(&task_path(env), &format!("{}\n", state.to_json().compact()))
}

/// the lock of one session, which a claude-bg run holds while it acts on that session; dropping it lets go
#[derive(Debug)]
pub struct SessionLock(PathBuf);

impl Drop for SessionLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists
    pid > 0
        && (unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

#[derive(Debug, PartialEq)]
enum Holder {
    Gone,
    Stale,
    Held,
}

/// what `ps -o <field>= -p <pid>` prints of process `pid` in the C locale and UTC, trimmed; None when `ps` cannot tell. A `ps` on PATH
/// never decides it
fn ps_field(pid: i32, field: &str) -> Option<String> {
    let ps = if Path::new("/bin/ps").exists() {
        "/bin/ps"
    } else {
        "ps"
    };
    let run = std::process::Command::new(ps)
        .args(["-o", &format!("{field}="), "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&run.stdout).trim().to_owned();
    (run.status.success() && !text.is_empty()).then_some(text)
}

/// when process `pid` started, as `ps` prints it; None when `ps` cannot tell
fn started_at(pid: i32) -> Option<String> {
    ps_field(pid, "lstart")
}

/// whether process `pid` is a zombie: it exited, and only its parent has not reaped it
fn zombie(pid: i32) -> bool {
    ps_field(pid, "stat").is_some_and(|stat| stat.starts_with('Z'))
}

/// this process's holder record: its pid and, when `ps` can tell, when it started, so a later process with the same pid is told apart
fn own_holder() -> String {
    static STARTED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    let pid = std::process::id();
    let started = STARTED.get_or_init(|| i32::try_from(pid).ok().and_then(started_at));
    let mut record = vec![("pid", Json::Num(f64::from(pid)))];
    if let Some(started) = started {
        record.push(("started", Json::str(started.clone())));
    }
    format!("{}\n", Json::object(record).compact())
}

/// whether a holder that names `pid` and the `started` it wrote is stale: its process is verifiably gone, no such pid, a zombie, or one
/// that started at another time; age never makes it so, and one that cannot be told is held
fn stale_holder(
    pid: Option<f64>,
    started: Option<&str>,
    now: impl Fn(i32) -> Option<String>,
) -> bool {
    let Some(pid) = pid
        .filter(|pid| pid.fract() == 0.0 && *pid > 0.0 && *pid <= f64::from(i32::MAX))
        .map(|pid| pid as i32)
    else {
        return false;
    };
    if !alive(pid) || zombie(pid) {
        return true;
    }
    started.is_some_and(|started| now(pid).is_some_and(|now| now != started))
}

/// what the holder file `name` in `dir` says: its record, else the pid its name gives
fn holder(dir: &Path, name: &str, prefix: &str) -> Holder {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join(name));
    let mut file = match file {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Holder::Gone,
        Err(_) => return Holder::Held,
    };
    let mut text = String::new();
    let _ = std::io::Read::read_to_string(&mut file, &mut text);
    let record = Json::parse(text.as_bytes());
    let named = name[prefix.len()..]
        .split('.')
        .next()
        .and_then(|pid| pid.parse::<f64>().ok());
    let pid = record
        .as_ref()
        .and_then(|record| record.get("pid").and_then(Json::as_f64))
        .or(named);
    let started = record
        .as_ref()
        .and_then(|record| record.get("started").and_then(Json::as_str));
    if stale_holder(pid, started, started_at) {
        Holder::Stale
    } else {
        Holder::Held
    }
}

/// the lock of session `id`, None while another run holds it. Each run publishes a holder file of its own, `<id>.lock.<pid>.<random>`,
/// then holds the session only when no other live holder file is there; one published before its listing is always seen, so two runs
/// never both hold it, and both may back off. A run deletes its own file and the files of holders whose process is verifiably gone,
/// never another live one
pub fn lock_session(env: &Env, id: &str) -> Result<Option<SessionLock>, String> {
    let dir = bg_dir(env);
    private_dir(&dir)?;
    let prefix = format!("{id}.lock.");
    let name = format!("{prefix}{}", unique());
    let path = dir.join(&name);
    let temp = dir.join(format!(".{name}.tmp"));
    let published = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .and_then(|mut file| file.write_all(own_holder().as_bytes()))
        .and_then(|()| std::fs::rename(&temp, &path));
    if let Err(error) = published {
        let _ = std::fs::remove_file(&temp);
        return Err(fs_fail(&error, "open", &path));
    }
    let lock = SessionLock(path);
    let others = std::fs::read_dir(&dir).map_err(|error| fs_fail(&error, "scandir", &dir))?;
    let mut held = true;
    for other in others {
        let other = other.map_err(|error| fs_fail(&error, "scandir", &dir))?;
        let other = other.file_name().to_string_lossy().into_owned();
        if other == name || !other.starts_with(&prefix) {
            continue;
        }
        match holder(&dir, &other, &prefix) {
            Holder::Held => held = false,
            Holder::Stale => {
                let _ = std::fs::remove_file(dir.join(&other));
            }
            Holder::Gone => {}
        }
    }
    Ok(held.then_some(lock))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scp-bg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env_of(dir: &Path) -> Env {
        Env::from([("SCP_DIR".to_owned(), dir.display().to_string())])
    }

    #[test]
    fn concurrent_writers_never_leave_a_torn_file_or_a_temporary_one() {
        let dir = scratch("writers");
        let path = dir.join("state.json");
        let writers: Vec<_> = (0..4)
            .map(|one| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let text = format!("{}\n", one.to_string().repeat(4096));
                    for _ in 0..100 {
                        write_private(&path, &text).unwrap();
                    }
                })
            })
            .collect();
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(&path) {
                assert_eq!(text.len(), 4097);
                assert!(text.trim_end().chars().all(|c| text.starts_with(c)));
            }
        }
        for writer in writers {
            writer.join().unwrap();
        }
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(names.len(), 1);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_session_lock_excludes_until_dropped_and_a_dead_holder_is_taken_over() {
        let dir = scratch("lock");
        let env = env_of(&dir);
        let lock = lock_session(&env, "1a2b3c4d").unwrap().unwrap();
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_none());
        assert!(lock_session(&env, "2b3c4d5e").unwrap().is_some());
        drop(lock);
        let bg = dir.join("claude-bg");
        let held = |bg: &Path| {
            std::fs::read_dir(bg)
                .unwrap()
                .flatten()
                .filter(|one| {
                    one.file_name()
                        .to_string_lossy()
                        .starts_with("1a2b3c4d.lock.")
                })
                .count()
        };
        assert_eq!(held(&bg), 0);
        std::fs::write(bg.join("1a2b3c4d.lock.dead"), "{\"pid\":2147483646}\n").unwrap();
        let taken = lock_session(&env, "1a2b3c4d").unwrap();
        assert!(taken.is_some());
        assert_eq!(held(&bg), 1);
        drop(taken);
        std::fs::write(
            bg.join(format!("1a2b3c4d.lock.{}.torn", std::process::id())),
            "{\"pid\":",
        )
        .unwrap();
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn racing_runs_over_a_stale_holder_never_hold_one_session_together() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = scratch("race");
        let env = env_of(&dir);
        let bg = dir.join("claude-bg");
        private_dir(&bg).unwrap();
        let inside = Arc::new(AtomicUsize::new(0));
        let runs: Vec<_> = (0..8)
            .map(|_| {
                let (env, bg) = (env.clone(), bg.clone());
                let inside = inside.clone();
                std::thread::spawn(move || {
                    for round in 0..150 {
                        if round % 10 == 0 {
                            let dead = bg.join(format!("1a2b3c4d.lock.dead{round}"));
                            let _ = std::fs::write(dead, "{\"pid\":2147483646}\n");
                        }
                        let Some(lock) = lock_session(&env, "1a2b3c4d").unwrap() else {
                            continue;
                        };
                        assert_eq!(inside.fetch_add(1, Ordering::SeqCst), 0, "two holders");
                        std::thread::yield_now();
                        inside.fetch_sub(1, Ordering::SeqCst);
                        drop(lock);
                    }
                })
            })
            .collect();
        for run in runs {
            run.join().unwrap();
        }
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// a process that has exited and that its parent, which this test started, never reaps; the parent goes when dropped
    struct Zombie {
        parent: std::process::Child,
        pid: i32,
    }

    impl Zombie {
        fn new() -> Zombie {
            let mut parent = std::process::Command::new("/bin/sh")
                .args(["-c", "sleep 0.2 & echo $!; exec sleep 30"])
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut line = String::new();
            std::io::BufRead::read_line(
                &mut std::io::BufReader::new(parent.stdout.take().unwrap()),
                &mut line,
            )
            .unwrap();
            let held = Zombie {
                pid: line.trim().parse().unwrap_or(0),
                parent,
            };
            for _ in 0..100 {
                if zombie(held.pid) {
                    return held;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            panic!("{} never became a zombie", held.pid);
        }
    }

    impl Drop for Zombie {
        fn drop(&mut self) {
            let _ = self.parent.kill();
            let _ = self.parent.wait();
        }
    }

    #[test]
    fn a_holder_that_exited_unreaped_frees_its_session() {
        let zombie = Zombie::new();
        assert!(alive(zombie.pid));
        let dir = scratch("zombie");
        let env = env_of(&dir);
        let bg = dir.join("claude-bg");
        private_dir(&bg).unwrap();
        let held = bg.join(format!("1a2b3c4d.lock.{}.held", zombie.pid));
        std::fs::write(&held, format!("{{\"pid\":{}}}\n", zombie.pid)).unwrap();
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_some());
        assert!(!held.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_holder_is_stale_only_once_its_process_is_verifiably_gone() {
        let own = std::process::id();
        let started = started_at(own as i32);
        assert!(started.is_some());
        let pid = Some(f64::from(own));
        let same = |_: i32| started.clone();
        assert!(!stale_holder(pid, started.as_deref(), same));
        assert!(stale_holder(pid, Some("Thu Jan  1 00:00:00 1970"), same));
        assert!(!stale_holder(pid, Some("Thu Jan  1 00:00:00 1970"), |_| {
            None
        }));
        assert!(!stale_holder(pid, None, same));
        assert!(stale_holder(Some(2_147_483_646.0), None, same));
        assert!(!stale_holder(None, None, same));
        assert!(!stale_holder(Some(1.5), None, same));
    }

    #[test]
    fn a_live_holder_however_old_keeps_the_session_and_a_reused_pid_does_not() {
        let dir = scratch("old");
        let env = env_of(&dir);
        let bg = dir.join("claude-bg");
        private_dir(&bg).unwrap();
        let live = bg.join("1a2b3c4d.lock.1.live");
        std::fs::write(&live, own_holder()).unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&live)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_none());
        assert!(live.exists());
        let reused = format!(
            "{{\"pid\":{},\"started\":\"Thu Jan  1 00:00:00 1970\"}}\n",
            std::process::id()
        );
        std::fs::write(&live, reused).unwrap();
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_some());
        assert!(!live.exists());
        std::fs::write(
            bg.join(format!("1a2b3c4d.lock.{}.torn", std::process::id())),
            "{",
        )
        .unwrap();
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_none());
        std::fs::write(bg.join("1a2b3c4d.lock.2147483646.torn"), "{").unwrap();
        std::fs::remove_file(bg.join(format!("1a2b3c4d.lock.{}.torn", std::process::id())))
            .unwrap();
        assert!(lock_session(&env, "1a2b3c4d").unwrap().is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
