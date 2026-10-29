use std::sync::OnceLock;

use regex::Regex;

pub const DEFAULT_IMPLEMENTATION_PREFIXES: &[&str] = &["scp", "kre", "kwt"];

pub struct SecretScanner {
    patterns: Vec<(&'static str, Regex)>,
}

impl SecretScanner {
    pub fn new(prefixes: &[&str]) -> Result<Self, String> {
        let mut patterns = Vec::new();
        let mut names = Vec::new();
        for prefix in prefixes {
            let name = prefix.strip_suffix('_').unwrap_or(prefix);
            if name.is_empty()
                || name.len() > 32
                || !name.bytes().all(|c| c.is_ascii_alphanumeric())
            {
                return Err(format!("invalid token prefix: {name}"));
            }
            names.push(name);
        }
        if !names.is_empty() {
            patterns.push((
                "implementation token",
                format!(r"(?-u:\b)(?:{})_[A-Za-z0-9_-]{{16,}}", names.join("|")),
            ));
        }
        for (name, pattern) in [
            ("relay grant", r"(?-u:\b)krt_[0-9a-f]{64}(?-u:\b)"),
            (
                concat!("anth", "ropic key"),
                r"(?-u:\b)sk-ant-[A-Za-z0-9_-]{20,}",
            ),
            ("api key", r"(?-u:\b)sk-(?:proj-)?[A-Za-z0-9_-]{32,}"),
            (
                concat!("git", "hub token"),
                concat!(
                    r"(?-u:\b)(?:gh[pousr]_[A-Za-z0-9]{30,}|git",
                    r"hub_pat_[A-Za-z0-9_]{40,})"
                ),
            ),
            (
                concat!("aw", "s key"),
                r"(?-u:\b)(?:AKIA|ASIA)[A-Z0-9]{16}(?-u:\b)",
            ),
            (
                "private key",
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\z)",
            ),
            (
                "jwt",
                r"(?-u:\b)eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}",
            ),
            (
                concat!("sla", "ck token"),
                r"(?-u:\b)xox[abprs]-[A-Za-z0-9-]{20,}",
            ),
            (
                "bearer token",
                r"(?i)(?-u:\b)bearer\s+[A-Za-z0-9._~+/=-]{16,}",
            ),
            (
                concat!("aw", "s secret"),
                r#"(?i)aw[s][_-]?secret[_-]?(?:access[_-]?)?key["']?\s*[:=]\s*["']?[A-Za-z0-9+/]{40}"#,
            ),
            (
                "assigned secret",
                r#"(?i)(?:api[_-]?key|token|secret|password|passwd|credentials?)["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9+/._~-]{19,})"#,
            ),
        ] {
            patterns.push((name, pattern.to_owned()));
        }
        Ok(Self {
            patterns: patterns
                .into_iter()
                .map(|(name, source)| {
                    Regex::new(&source)
                        .map(|pattern| (name, pattern))
                        .map_err(|error| error.to_string())
                })
                .collect::<Result<_, _>>()?,
        })
    }

    fn accepted(kind: &str, text: &str, captures: &regex::Captures<'_>) -> bool {
        if kind != "assigned secret" {
            return true;
        }
        let Some(found) = captures.get(0) else {
            return false;
        };
        let Some(value) = captures.get(1) else {
            return false;
        };
        !text[..found.start()]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && value.as_str().bytes().any(|c| c.is_ascii_digit())
            && value.as_str().bytes().any(|c| c.is_ascii_alphabetic())
    }

    pub fn find_secret(&self, text: &str) -> Option<&'static str> {
        self.patterns.iter().find_map(|(kind, pattern)| {
            pattern
                .captures_iter(text)
                .any(|hit| Self::accepted(kind, text, &hit))
                .then_some(*kind)
        })
    }

    pub fn redact_secrets(&self, text: &str) -> String {
        let mut output = text.to_owned();
        for (kind, pattern) in &self.patterns {
            output = pattern
                .replace_all(&output, |hit: &regex::Captures<'_>| {
                    if Self::accepted(kind, &output, hit) {
                        format!("[redacted {kind}]")
                    } else {
                        hit[0].to_owned()
                    }
                })
                .into_owned();
        }
        output
    }
}

fn scanner() -> &'static SecretScanner {
    static SCANNER: OnceLock<SecretScanner> = OnceLock::new();
    SCANNER.get_or_init(|| {
        SecretScanner::new(DEFAULT_IMPLEMENTATION_PREFIXES).expect("constant secret patterns")
    })
}

pub fn find_secret(text: &str) -> Option<&'static str> {
    scanner().find_secret(text)
}

pub fn redact_secrets(text: &str) -> String {
    scanner().redact_secrets(text)
}

pub fn after_cut_key(text: &str) -> Option<&str> {
    static END: OnceLock<Regex> = OnceLock::new();
    let pattern = END.get_or_init(|| {
        Regex::new(r"-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[^\n]*\n?")
            .expect("constant key pattern")
    });
    let end = pattern.find(text)?;
    (!text[..end.start()].contains("-----BEGIN ")).then_some(&text[end.end()..])
}

pub fn strip_control(text: &str) -> String {
    text.chars().filter(|&c| !matches!(c as u32, 0..=8 | 11..=12 | 14..=31 | 127..=159 | 173 | 1564 | 6158 | 8203 | 8206..=8207 | 8234..=8238 | 8288..=8292 | 8294..=8303 | 65279 | 65529..=65531 | 917505 | 917536..=917631)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_detected_and_redacted() {
        for text in [
            "scp_abcdefghijklmnop",
            "kre_abcdefghijklmnop",
            "kwt_abcdefghijklmnop",
            "sk-abcdefghijklmnopqrstuvwxyz012345",
            "Bearer abcdefghijklmnop",
            "password=abcdefghij0123456789",
        ] {
            assert!(find_secret(text).is_some(), "{text}");
            assert!(redact_secrets(text).starts_with("[redacted "));
        }
        assert_eq!(find_secret("password=abcdefghijklmnopqrst"), None);
        assert_eq!(find_secret("mytoken=abcdefghij0123456789"), None);
    }

    #[test]
    fn prefixes_and_private_keys() {
        let scanner = SecretScanner::new(&["custom_"]).expect("scanner");
        assert!(scanner.find_secret("custom_abcdefghijklmnop").is_some());
        assert!(scanner.find_secret("scp_abcdefghijklmnop").is_none());
        assert!(SecretScanner::new(&["invalid-"]).is_err());
        assert_eq!(
            redact_secrets("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"),
            "[redacted private key]"
        );
        assert_eq!(
            after_cut_key("cut\n-----END PRIVATE KEY-----\nrest"),
            Some("rest")
        );
        assert_eq!(strip_control("a\u{202e}b\n\tc"), "ab\n\tc");
    }
}
