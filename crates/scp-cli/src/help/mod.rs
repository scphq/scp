//! Help and version, with the TypeScript CLI's text byte for byte: `bun scripts/help-text.ts` writes the `.txt` files beside this one.

use crate::term::{out, print};
use crate::{Call, Done, Run, Verb, usage};
use scp_core::protocol::CLI_NAME;

const BRIEF: &str = include_str!("brief.txt");
const FULL: &str = include_str!("full.txt");
pub const SPAWN: &str = include_str!("spawn.txt");
pub const CLAUDE: &str = include_str!("claude.txt");
pub const CODEX: &str = include_str!("codex.txt");
pub const MUSE: &str = include_str!("muse.txt");
pub const PI: &str = include_str!("pi.txt");
pub const T3CODE: &str = include_str!("t3code.txt");
pub const OPENCODE: &str = include_str!("opencode.txt");
pub const AGY: &str = include_str!("agy.txt");
pub const GROK: &str = include_str!("grok.txt");
pub const SETUP: &str = include_str!("setup.txt");
pub const CLAUDE_DESKTOP: &str = include_str!("claude-desktop.txt");

pub const VERBS: &[Verb] = &[
    Verb {
        name: "help",
        run: Run::Words(help),
    },
    Verb {
        name: "--help",
        run: Run::Words(help),
    },
    Verb {
        name: "-h",
        run: Run::Words(help),
    },
    Verb {
        name: "version",
        run: Run::Words(version),
    },
    Verb {
        name: "--version",
        run: Run::Words(version),
    },
];

fn help(call: &Call, words: &[String]) -> Done {
    let named = (call.verb == "help")
        .then(|| words.iter().find(|word| !word.starts_with('-')))
        .flatten();
    if words.iter().any(|word| word == "--all") {
        out(FULL);
    } else if let Some(named) = named {
        let text = verb_help(named).ok_or_else(|| unknown(named))?;
        out(&text);
    } else {
        out(BRIEF);
    }
    Ok(0)
}

fn version(_: &Call, _: &[String]) -> Done {
    out(crate::VERSION);
    Ok(0)
}

/// the usage error for a word that is no verb
pub fn unknown(word: &str) -> crate::Fail {
    usage(format!("unknown command \"{word}\""))
}

/// `verb --help` for a verb that parses its flags: its help, or with `--all` the full reference
pub fn show(verb: &str, all: bool) -> Done {
    if all {
        out(FULL);
    } else {
        out(&verb_help(verb).unwrap_or_default());
    }
    Ok(0)
}

/// `spawn --help`
pub fn show_spawn(all: bool) -> Done {
    out(if all { FULL } else { SPAWN });
    Ok(0)
}

/// a launcher's `--help`: `text` and a newline
pub fn show_text(text: &str) -> Done {
    out(text);
    Ok(0)
}

/// `swarm claude --help`, whose text ends its own last line
pub fn show_claude() -> Done {
    print(CLAUDE);
    Ok(0)
}

#[derive(Default)]
struct Item<'a> {
    verb: Option<&'a str>,
    heading: Option<&'a str>,
    lines: Vec<&'a str>,
}

/// the verb a line of the reference starts: `  swarm <verb>`
fn entry(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("  ")?.strip_prefix(CLI_NAME)?;
    let word = rest.strip_prefix(' ')?.split(char::is_whitespace).next()?;
    (!word.is_empty()).then_some(word)
}

fn indented(line: &str) -> bool {
    line.starts_with("  ") && line[2..].chars().next().is_some_and(|c| !c.is_whitespace())
}

fn heading(line: &str) -> bool {
    line != "usage:"
        && line.ends_with(':')
        && line.chars().next().is_some_and(|c| !c.is_whitespace())
}

/// the placeholder a definition line gives: `  A <id> is ...` or `  An <id> is ...`
fn defined(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("  ")?;
    let rest = rest
        .strip_prefix("An ")
        .or_else(|| rest.strip_prefix("A "))?;
    let end = rest.find('>')?;
    (rest.starts_with('<') && end > 1 && rest[end + 1..].starts_with(" is ")).then(|| &rest[..=end])
}

fn items() -> Vec<Item<'static>> {
    let mut items: Vec<Item> = Vec::new();
    let mut under = None;
    for line in FULL.split('\n') {
        if let Some(verb) = entry(line) {
            items.push(Item {
                verb: Some(verb),
                heading: under,
                lines: vec![line],
            });
        } else if line.starts_with("   ") && !items.is_empty() {
            if let Some(last) = items.last_mut() {
                last.lines.push(line);
            }
        } else if indented(line) {
            match items.last_mut() {
                Some(last) if last.verb.is_none() => last.lines.push(line),
                _ => items.push(Item {
                    lines: vec![line],
                    ..Item::default()
                }),
            }
        } else {
            under = heading(line).then_some(line);
            items.push(Item::default());
        }
    }
    items
}

/// `verb`'s entries of the full reference, with the notes after them and the placeholders they use; None for a word it does not list
pub fn verb_help(verb: &str) -> Option<String> {
    if verb == "spawn" {
        return Some(SPAWN.to_owned());
    }
    let items = items();
    let mut text: Vec<&str> = Vec::new();
    let mut shown = None;
    for (at, item) in items.iter().enumerate() {
        if item.verb != Some(verb) {
            continue;
        }
        if let Some(heading) = item.heading.filter(|heading| Some(*heading) != shown) {
            text.push(heading);
        }
        shown = item.heading;
        text.extend(&item.lines);
        for note in items[at + 1..]
            .iter()
            .take_while(|next| next.verb.is_none() && !next.lines.is_empty())
        {
            text.extend(&note.lines);
        }
    }
    if text.is_empty() {
        return None;
    }
    let used = text.join("\n");
    for item in &items {
        let Some(first) = item.lines.first() else {
            continue;
        };
        if item.verb.is_none()
            && defined(first).is_some_and(|placeholder| used.contains(placeholder))
            && !used.contains(first)
        {
            text.extend(&item.lines);
        }
    }
    let footer = format!("Every command takes --json. Full reference: {CLI_NAME} help --all.");
    text.extend(["", footer.as_str()]);
    Some(text.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verb_shows_its_entries_and_the_footer() {
        let send = verb_help("send").unwrap();
        assert!(send.starts_with(&format!("  {CLI_NAME} send ")), "{send}");
        assert!(
            send.ends_with("Full reference: swarm help --all."),
            "{send}"
        );
        assert!(verb_help("frobnicate").is_none());
        assert_eq!(verb_help("spawn").as_deref(), Some(SPAWN));
    }

    #[test]
    fn a_definition_names_its_placeholder() {
        assert_eq!(defined("  An <id> is a message id"), Some("<id>"));
        assert_eq!(defined("  A <to> is an address"), Some("<to>"));
        assert_eq!(defined("  A <> is empty"), None);
        assert_eq!(defined("  An id is plain"), None);
        assert_eq!(defined("   An <id> is too deep"), None);
    }

    #[test]
    fn an_entry_is_the_word_after_the_cli_name() {
        assert_eq!(entry("  swarm send <to>"), Some("send"));
        assert_eq!(entry("  swarm "), None);
        assert_eq!(entry("   swarm send"), None);
        assert_eq!(entry("  swarmy send"), None);
    }
}
