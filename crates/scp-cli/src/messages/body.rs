//! A message body from stdin, and numbers read as JavaScript's `Number()` reads a string.

use crate::args::Parsed;
use crate::{Fail, usage};
use scp_mcp::tools::js_trim;

/// whether `verb` takes its body from stdin: a send, ask or reply with no text or `-`
pub fn body_from_stdin(verb: &str, parsed: &Parsed) -> bool {
    matches!(verb, "send" | "ask" | "reply")
        && matches!(
            parsed.positionals.get(1).map(String::as_str),
            None | Some("-")
        )
}

/// stdin's bytes as the body: decoded as `TextDecoder` does (a leading BOM dropped, bad bytes replaced), one trailing newline off
pub fn body_text(bytes: &[u8]) -> Result<String, Fail> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if js_trim(text).is_empty() {
        return Err(usage("no message text: pass it as an argument or on stdin"));
    }
    Ok(text.strip_suffix('\n').unwrap_or(text).to_owned())
}

/// digits in a power-of-two radix as the double nearest their value, ties to even, as JavaScript rounds them
fn radix_value(digits: &str, radix: u32) -> f64 {
    let width = radix.trailing_zeros() as usize;
    let mut bits = String::new();
    for c in digits.chars() {
        let digit = c.to_digit(radix).unwrap_or(0);
        bits.push_str(&format!("{digit:0width$b}"));
    }
    let bits = bits.trim_start_matches('0');
    if bits.len() <= 64 {
        return u64::from_str_radix(bits, 2).map_or(0.0, |n| n as f64);
    }
    let top = u64::from_str_radix(&bits[..64], 2).unwrap_or(0);
    let sticky = u64::from(bits[64..].contains('1'));
    (top | sticky) as f64 * 2f64.powi((bits.len() - 64) as i32)
}

/// `Number(text)`, None for NaN
pub fn js_number(text: &str) -> Option<f64> {
    let text = js_trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    let radix = match text.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &text[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        return Some(radix_value(digits, radix));
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return Some(if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    if !unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_from_stdin_loses_one_trailing_newline_and_a_bom() {
        assert_eq!(body_text(b"hi\n\n").unwrap(), "hi\n");
        assert_eq!(body_text(b"hi\r\n").unwrap(), "hi\r");
        assert_eq!(body_text(b"\xef\xbb\xbfhi").unwrap(), "hi");
        assert_eq!(body_text(b"a\xffb\xe2\x82").unwrap(), "a\u{fffd}b\u{fffd}");
        for blank in [&b""[..], b" \n\t", b"\xef\xbb\xbf\n", "\u{3000}".as_bytes()] {
            assert_eq!(
                body_text(blank),
                Err(usage("no message text: pass it as an argument or on stdin"))
            );
        }
    }

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        assert_eq!(
            js_number("0x1000000000000081"),
            Some(1_152_921_504_606_847_232.0)
        );
        assert_eq!(
            js_number("0x1000000000000080"),
            Some(1_152_921_504_606_846_976.0)
        );
        assert_eq!(
            js_number("0x10000000000000801"),
            Some(18_446_744_073_709_555_712.0)
        );
        assert_eq!(
            js_number(&format!("0x1{}", "0".repeat(300))),
            Some(f64::INFINITY)
        );
        let cases: [(&str, Option<f64>); 16] = [
            ("", Some(0.0)),
            (" 12\n", Some(12.0)),
            ("1.5", Some(1.5)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("1e2", Some(100.0)),
            ("-3", Some(-3.0)),
            ("0x1f", Some(31.0)),
            ("0b101", Some(5.0)),
            ("0o17", Some(15.0)),
            ("-0x1", None),
            ("1_0", None),
            ("inf", None),
            ("nan", None),
            ("abc", None),
            ("-Infinity", Some(f64::NEG_INFINITY)),
        ];
        for (text, number) in cases {
            assert_eq!(js_number(text), number, "{text:?}");
        }
    }

    #[test]
    fn only_a_missing_text_or_a_dash_reads_stdin() {
        let parsed = |words: &[&str]| Parsed {
            positionals: words.iter().map(|w| w.to_string()).collect(),
            ..Parsed::default()
        };
        assert!(body_from_stdin("send", &parsed(&["a"])));
        assert!(body_from_stdin("reply", &parsed(&["a", "-"])));
        assert!(!body_from_stdin("ask", &parsed(&["a", "text"])));
        assert!(!body_from_stdin("inbox", &parsed(&[])));
    }
}
