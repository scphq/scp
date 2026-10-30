use std::sync::OnceLock;

use regex::Regex;

use super::verdict::Redaction;

pub fn find_pii(body: &str) -> Vec<Redaction> {
    static PATTERNS: OnceLock<Vec<(&str, Regex)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| [
        ("path", r"(?:~?[\w.-]*/)*(?:id_(?:rsa|ed25519|ecdsa|dsa)|[\w-][\w.-]*\.pem|\.env(?:\.[\w-]+)*|\.ssh/[\w./-]*|\.a[w]s/credentials)|(?:~?[\w.-]*/)+[\w-][\w.-]*\.key"),
        ("email", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"),
        ("iban", r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b"),
        ("card", r"(?:\d[ -]?){12,18}\d"),
        ("phone", r"\+\d{8,15}|(?:\+\d{1,3}[ -]?)?(?:\(\d{1,4}\)[ -]?)?\d{2,5}(?:[ -]\d{2,5}){1,5}"),
    ].into_iter().map(|(kind,p)|(kind,Regex::new(p).expect("PII pattern"))).collect());
    let mut hits: Vec<(usize, usize, &str)> = Vec::new();
    for (kind, pattern) in patterns {
        for hit in pattern.find_iter(body) {
            let before = body[..hit.start()].chars().next_back();
            let after = body[hit.end()..].chars().next();
            let invalid = match *kind {
                "email" => {
                    before.is_some_and(|c| c.is_alphanumeric() || "_.%+-".contains(c))
                        || after.is_some_and(|c| c.is_alphanumeric() || "_-".contains(c))
                }
                "path" => {
                    before.is_some_and(|c| !c.is_whitespace() && !"\"'`(<[=:,".contains(c))
                        || after.is_some_and(|c| c.is_alphanumeric() || "_.".contains(c))
                }
                "card" => {
                    before.is_some_and(|c| c.is_ascii_digit() || c == '+')
                        || after.is_some_and(|c| c.is_ascii_digit())
                        || !card_valid(hit.as_str())
                }
                "iban" => !iban_valid(hit.as_str()),
                "phone" => {
                    before.is_some_and(|c| c.is_alphanumeric() || "_+./-".contains(c))
                        || after.is_some_and(|c| c.is_alphanumeric() || "_/:-".contains(c))
                        || !phone_valid(hit.as_str())
                }
                _ => false,
            };
            if invalid
                || hits
                    .iter()
                    .any(|(start, end, _)| hit.start() < *end && *start < hit.end())
            {
                continue;
            }
            hits.push((hit.start(), hit.end(), kind));
        }
    }
    hits.sort_by_key(|h| h.0);
    hits.into_iter()
        .map(|(start, end, kind)| Redaction {
            quote: body[start..end].into(),
            kind: kind.into(),
        })
        .collect()
}

fn card_valid(raw: &str) -> bool {
    let digits: Vec<_> = raw
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|c| u32::from(c - b'0'))
        .collect();
    (13..=19).contains(&digits.len())
        && (2..=6).contains(&digits[0])
        && digits
            .iter()
            .rev()
            .enumerate()
            .map(|(i, d)| {
                if i % 2 == 1 {
                    if *d * 2 > 9 { *d * 2 - 9 } else { *d * 2 }
                } else {
                    *d
                }
            })
            .sum::<u32>()
            % 10
            == 0
}

fn iban_valid(raw: &str) -> bool {
    let compact = raw.replace(' ', "");
    if !(15..=34).contains(&compact.len()) {
        return false;
    }
    let mut rest = 0u32;
    for c in compact[4..].bytes().chain(compact[..4].bytes()) {
        if c.is_ascii_uppercase() {
            rest = (rest * 100 + u32::from(c - b'A') + 10) % 97;
        } else if c.is_ascii_digit() {
            rest = (rest * 10 + u32::from(c - b'0')) % 97;
        } else {
            return false;
        }
    }
    rest == 1
}

fn phone_valid(raw: &str) -> bool {
    let count = raw.bytes().filter(u8::is_ascii_digit).count();
    let date = raw.len() >= 10
        && raw.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && raw.as_bytes()[4] == b'-'
        && raw.as_bytes()[7] == b'-';
    (9..=15).contains(&count) && !date
}
