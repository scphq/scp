//! Self-hosted SCP relay authentication and transport foundation.
pub mod admin;
pub mod http;
pub mod hub;

use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// Current Unix time in milliseconds, saturated to the timestamp range.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
/// SHA-256 digest of a credential or device code.
pub fn hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}
/// Generate a cryptographically random opaque identifier or credential.
pub fn random(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}{}", hex::encode(bytes))
}
/// Validate account handles and machine-shaped device labels.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && c == b'-'))
}
/// Normalize a human-entered device user code.
pub fn normalize_code(raw: &str) -> String {
    raw.chars()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub(crate) fn iso(ms: i64) -> String {
    let Ok(t) = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000) else {
        return String::new();
    };
    let year = t.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn wire_timestamps() {
        assert_eq!(super::iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::iso(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(super::iso(1767225600000), "2026-01-01T00:00:00.000Z");
        assert_eq!(super::iso(1767225600123), "2026-01-01T00:00:00.123Z");
    }
}
