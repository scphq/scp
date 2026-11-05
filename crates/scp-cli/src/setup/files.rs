//! What setup reads and writes: JSON and TOML config files, symlinks followed, a backup beside each file, and atomic replacement.

use super::hooks_install::{
    LONE_SURROGATE, lone_surrogate, parse_json, resolved, stamp, utf8_text,
};
use crate::fleet::json::Json;
use crate::fleet::mounts::from_toml;
use crate::open::node_fs_error;
use scp_mcp::ps::{basename, dirname, join};
use scp_mcp::render::js_space;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::rc::Rc;

pub fn exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

pub fn fs_error(syscall: &str, path: &str) -> impl Fn(std::io::Error) -> String {
    let (syscall, path) = (syscall.to_owned(), path.to_owned());
    move |error| node_fs_error(&error, &syscall, &path)
}

fn read_bytes(file: &str) -> Result<Vec<u8>, String> {
    std::fs::read(file).map_err(|error| match error.raw_os_error() {
        Some(libc::EISDIR) => "EISDIR: illegal operation on a directory, read".to_owned(),
        _ => node_fs_error(&error, "open", file),
    })
}

/// a config file's text, refused when it is no UTF-8: a value read with its bytes replaced must never reach a harness CLI or a rewrite
pub fn read_text(file: &str) -> Result<String, String> {
    utf8_text(read_bytes(file)?).map_err(|error| error.message().to_owned())
}

/// the text of a JSON file about to be rewritten, refused when a value in it would not survive that
pub fn rewritable_text(file: &str) -> Result<String, String> {
    let text = read_text(file)?;
    if lone_surrogate(&text) {
        return Err(LONE_SURROGATE.to_owned());
    }
    Ok(text)
}

/// the JSON object in `text`: {} when it is blank
fn json_object(text: &str) -> Result<Json, String> {
    if text.trim_matches(js_space).is_empty() {
        return Ok(Json::Obj(Vec::new()));
    }
    match parse_json(text)? {
        object @ Json::Obj(_) => Ok(object),
        _ => Err("not a JSON object".into()),
    }
}

/// a JSON object file: None when missing, {} when empty
pub fn read_json(file: &str) -> Result<Option<Json>, String> {
    if !exists(file) {
        return Ok(None);
    }
    json_object(&read_text(file)?).map(Some)
}

/// [`read_json`] for a file written back whole
pub fn read_rewritable_json(file: &str) -> Result<Option<Json>, String> {
    if !exists(file) {
        return Ok(None);
    }
    json_object(&rewritable_text(file)?).map(Some)
}

/// whether every integer in `value` is one a JavaScript number holds exactly, as `smol-toml` requires
fn safe_integers(value: &toml::Value) -> bool {
    match value {
        toml::Value::Integer(n) => n.unsigned_abs() < 1 << 53,
        toml::Value::Array(items) => items.iter().all(safe_integers),
        toml::Value::Table(table) => table.values().all(safe_integers),
        _ => true,
    }
}

pub fn read_toml(file: &str) -> Result<Option<Json>, String> {
    if !exists(file) {
        return Ok(None);
    }
    let text = read_text(file)?;
    let table: toml::Table = text
        .parse()
        .map_err(|error: toml::de::Error| error.message().replace('\n', ": "))?;
    let value = toml::Value::Table(table);
    if !safe_integers(&value) {
        return Err("an integer is out of the safe range".into());
    }
    Ok(Some(from_toml(&value)))
}

/// Why `file` cannot be written, if it cannot: a symlink whose target is missing is written through when the target's directory
/// exists, and refused when a harness CLI does the write, since the CLI would put a plain file where the link was.
pub fn link_problem(file: &str, by_cli: bool) -> Option<String> {
    let target = match resolved(file) {
        Ok(target) => target,
        Err(error) => return Some(error),
    };
    if target == file || exists(&target) {
        return None;
    }
    if by_cli {
        return Some(format!(
            "{file} is a symlink to {target}, which does not exist, and the harness CLI would replace the link; create {target} or remove the link"
        ));
    }
    if !exists(&dirname(&target)) {
        return Some(format!(
            "{file} is a symlink to {target}, whose directory does not exist; create it or remove the link"
        ));
    }
    None
}

pub fn file_mode(file: &str) -> Result<u32, String> {
    Ok(std::fs::metadata(file)
        .map_err(fs_error("stat", file))?
        .permissions()
        .mode()
        & 0o7777)
}

fn set_mode(file: &str, mode: u32) -> Result<(), String> {
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(mode))
        .map_err(fs_error("chmod", file))
}

/// a copy of `file` next to it as `<file>.bak-<time>`, with its mode
pub fn backup(file: &str, now_s: i64) -> Result<String, String> {
    let stamped = format!("{file}.bak-{}", stamp(now_s));
    let mut path = stamped.clone();
    let mut n = 2;
    while exists(&path) {
        path = format!("{stamped}-{n}");
        n += 1;
    }
    std::fs::copy(file, &path).map_err(fs_error("copyfile", file))?;
    set_mode(&path, file_mode(file)?)?;
    Ok(path)
}

/// how [`write_file`] treats what it replaces
#[derive(Debug, Clone, Copy)]
pub struct WriteOptions {
    /// back the file up first
    pub keep: bool,
    /// the mode of a new file
    pub mode: u32,
}

impl Default for WriteOptions {
    fn default() -> Self {
        WriteOptions {
            keep: true,
            mode: 0o600,
        }
    }
}

/// `content` over `target` (through its symlinks) via a temp file and rename, after a backup unless told otherwise, keeping its mode
pub fn write_file(
    target: &str,
    content: &str,
    now_s: i64,
    options: WriteOptions,
) -> Result<Option<String>, String> {
    let file = resolved(target)?;
    let mut saved = None;
    let mut mode = options.mode;
    let dir = dirname(&file);
    if exists(&file) {
        mode = file_mode(&file)?;
        if options.keep {
            saved = Some(backup(&file, now_s)?);
        }
    } else if file != target && !exists(&dir) {
        return Err(format!(
            "{target} is a symlink to {file}, whose directory does not exist"
        ));
    } else {
        std::fs::create_dir_all(&dir).map_err(fs_error("mkdir", &dir))?;
    }
    let temp = join(&[
        &dir,
        &format!(".{}.tmp-{}", basename(&file), std::process::id()),
    ]);
    let written = (|| {
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&temp)
            .map_err(fs_error("open", &temp))?;
        out.write_all(content.as_bytes())
            .map_err(fs_error("write", &temp))?;
        drop(out);
        set_mode(&temp, mode)?;
        std::fs::rename(&temp, &file).map_err(fs_error("rename", &temp))
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(saved)
}

/// the file's own indent: `/\n([ \t]+)["}\]]/`, else two spaces
fn indent_of(text: &str) -> String {
    let bytes = text.as_bytes();
    let found = bytes.iter().enumerate().find_map(|(at, byte)| {
        if *byte != b'\n' {
            return None;
        }
        let rest = &bytes[at + 1..];
        let width = rest
            .iter()
            .take_while(|b| matches!(b, b' ' | b'\t'))
            .count();
        (width > 0 && matches!(rest.get(width), Some(b'"' | b'}' | b']')))
            .then(|| text[at + 1..at + 1 + width].to_owned())
    });
    found.unwrap_or_else(|| "  ".to_owned())
}

/// `value` written as the file it replaces was, `JSON.stringify` taking at most ten characters of indent
fn json_text(original: Option<&str>, value: &Json) -> String {
    let gap = original
        .filter(|text| !text.is_empty())
        .map_or_else(|| "  ".to_owned(), indent_of);
    let gap: String = gap.chars().take(10).collect();
    format!("{}\n", value.indented(&gap))
}

/// a change to a JSON object: its new value, None when it leaves the file alone
pub type Edit = Rc<dyn Fn(&Json) -> Result<Option<Json>, String>>;

/// what a step does when it is applied: the backup it made, if any
pub type Apply = Box<dyn Fn() -> Result<Option<String>, String>>;

/// the new text of a JSON file after `edit`, or None when it would not change
fn edited_json(file: &str, edit: &Edit) -> Result<Option<String>, String> {
    let target = resolved(file)?;
    let original = if exists(&target) {
        Some(rewritable_text(&target)?)
    } else {
        None
    };
    let config = original
        .as_deref()
        .map_or_else(|| Ok(Json::Obj(Vec::new())), json_object)?;
    let Some(next) = edit(&config)? else {
        return Ok(None);
    };
    let content = json_text(original.as_deref(), &next);
    Ok((original.as_deref() != Some(content.as_str())).then_some(content))
}

/// a planned JSON edit; applying it reads the file again, so a write made since the plan is kept
pub fn json_edit(file: &str, edit: Edit, now_s: i64) -> Result<Option<Apply>, String> {
    if edited_json(file, &edit)?.is_none() {
        return Ok(None);
    }
    let file = file.to_owned();
    Ok(Some(Box::new(move || match edited_json(&file, &edit)? {
        Some(content) => write_file(&file, &content, now_s, WriteOptions::default()),
        None => Ok(None),
    })))
}

/// a fresh directory `<prefix>XXXXXX`, as `mkdtempSync` makes it
pub fn make_temp_dir(prefix: &str) -> Result<String, String> {
    let template = std::ffi::CString::new(format!("{prefix}XXXXXX"))
        .map_err(|_| format!("{prefix}: a path holds a NUL"))?;
    let raw = template.into_raw();
    // SAFETY: mkdtemp rewrites the NUL-terminated buffer in place, and from_raw takes it back
    let made = unsafe { !libc::mkdtemp(raw).is_null() };
    let path = unsafe { std::ffi::CString::from_raw(raw) };
    let path = path.to_string_lossy().into_owned();
    if made {
        Ok(path)
    } else {
        Err(fs_error("mkdtemp", &path)(std::io::Error::last_os_error()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_files_own_indent_is_the_first_one_before_a_key_or_a_close() {
        assert_eq!(indent_of("{\n    \"a\": 1\n}\n"), "    ");
        assert_eq!(indent_of("{\n\t\"a\": 1\n}\n"), "\t");
        assert_eq!(indent_of("{\r\n \"a\": 1\r\n}"), " ");
        assert_eq!(indent_of("{\"a\":1}"), "  ");
        assert_eq!(indent_of("[\n  1\n]"), "  ");
        assert_eq!(indent_of("[\n   1,\n ]"), " ");
    }

    #[test]
    fn a_rewrite_keeps_the_indent_and_ends_in_one_newline() {
        let value = Json::object(vec![("a", Json::Arr(vec![Json::Num(1.0)]))]);
        assert_eq!(
            json_text(Some("{\n\t\"a\": 0\n}"), &value),
            "{\n\t\"a\": [\n\t\t1\n\t]\n}\n"
        );
        assert_eq!(
            json_text(Some(""), &value),
            "{\n  \"a\": [\n    1\n  ]\n}\n"
        );
        assert_eq!(json_text(None, &value), "{\n  \"a\": [\n    1\n  ]\n}\n");
        let wide = format!("{{\n{}\"a\": 0\n}}", " ".repeat(14));
        assert!(json_text(Some(&wide), &value).contains(&format!("\n{}\"a\"", " ".repeat(10))));
    }
}
