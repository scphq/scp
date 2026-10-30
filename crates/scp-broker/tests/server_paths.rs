use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use scp_broker::paths::{relay_dir, socket_path, uid};
use scp_broker::server::{LineReader, MAX_LINE, parse_request};
use serde_json::json;
use sha2::{Digest, Sha256};

#[test]
fn relay_directory_precedence() {
    let mut env = BTreeMap::from([("HOME".into(), "/home/test".into())]);
    assert_eq!(
        relay_dir(&env).expect("home"),
        Path::new("/home/test/.local/state/scp")
    );
    env.insert("XDG_STATE_HOME".into(), "/state".into());
    assert_eq!(relay_dir(&env).expect("state"), Path::new("/state/scp"));
    env.insert("SCP_DIR".into(), "/relay".into());
    assert_eq!(relay_dir(&env).expect("explicit"), Path::new("/relay"));
    env.insert("SCP_DIR".into(), "".into());
    assert_eq!(relay_dir(&env).expect("empty"), Path::new("/state/scp"));
}

#[test]
fn socket_path_uses_byte_length_and_hashes_directory() {
    let dir = PathBuf::from(format!("/{}", "x".repeat(88)));
    assert_eq!(dir.join("relay.sock").as_os_str().len(), 100);
    assert_eq!(socket_path(&dir), dir.join("relay.sock"));
    let dir = PathBuf::from(format!("/{}", "é".repeat(45)));
    assert_eq!(dir.join("relay.sock").as_os_str().len(), 102);
    let hash = hex::encode(Sha256::digest(dir.as_os_str().as_encoded_bytes()));
    assert_eq!(
        socket_path(&dir),
        Path::new("/tmp")
            .join(format!("scp-{}-{}", uid(), &hash[..12]))
            .join("relay.sock")
    );
}

#[test]
fn line_reader_preserves_split_utf8_and_ignores_blanks() {
    let mut reader = LineReader::default();
    assert_eq!(reader.push(&[b' ', b'\n', b'"', 0xc3]), (vec![], false));
    assert_eq!(
        reader.push(&[0xa9, b'"', b'\n']),
        (vec!["\"é\"".into()], false)
    );
    assert_eq!(reader.buffered(), 0);
}

#[test]
fn line_reader_accepts_exact_cap_and_returns_prior_lines_before_overflow() {
    let mut reader = LineReader::default();
    let cap = vec![b'x'; MAX_LINE];
    assert_eq!(reader.push(&cap), (vec![], false));
    let (lines, too_large) = reader.push(b"\n");
    assert_eq!(lines[0].len(), MAX_LINE);
    assert!(!too_large);
    let input = [
        b"first\n".as_slice(),
        cap.as_slice(),
        b"x\nignored\n".as_slice(),
    ]
    .concat();
    assert_eq!(reader.push(&input), (vec!["first".into()], true));
    assert!(reader.buffered() <= MAX_LINE);
}

#[test]
fn requests_preserve_ids_and_optional_fields() {
    let request = parse_request(r#"{"id":null,"method":"hello","params":null}"#).expect("request");
    assert_eq!(request.id, Some(json!(null)));
    assert!(request.params.is_empty());
    assert!(
        parse_request(r#"{"method":"hello"}"#)
            .expect("notification")
            .id
            .is_none()
    );
    let request = parse_request(r#"{"id":"string","method":"hello"}"#).expect("string id");
    assert_eq!(request.id, Some(json!("string")));
}

#[test]
fn framing_errors_keep_the_reference_integer_codes() {
    for (input, id, code, data) in [
        ("{", json!(null), -32700, json!(null)),
        ("[1]", json!(null), -32600, json!("invalid_params")),
        (
            r#"{"id":{},"method":"hello"}"#,
            json!(null),
            -32600,
            json!("invalid_params"),
        ),
        (
            r#"{"id":7,"method":5}"#,
            json!(7),
            -32600,
            json!("invalid_params"),
        ),
        (
            r#"{"id":8,"method":"hello","params":[]}"#,
            json!(8),
            -32600,
            json!("invalid_params"),
        ),
    ] {
        let frame = parse_request(input).err().expect("invalid request");
        assert_eq!(frame["id"], id);
        assert_eq!(frame["error"]["code"], code);
        assert_eq!(frame["error"]["data"]["code"], data);
    }
}

#[test]
fn paths_normalize_dot_segments_before_applying_socket_limit() {
    assert_eq!(
        socket_path(Path::new("/tmp/a/../b//.")),
        Path::new("/tmp/b/relay.sock")
    );
    assert_eq!(
        socket_path(Path::new("a/../../b")),
        Path::new("../b/relay.sock")
    );
    let env = BTreeMap::from([("XDG_STATE_HOME".into(), "/tmp/a/../b/".into())]);
    assert_eq!(
        relay_dir(&env).expect("normalized state"),
        Path::new("/tmp/b/scp")
    );
}

#[test]
fn rates_are_strict_and_null_caps_are_uncapped() {
    use scp_broker::proto::{Limits, RpcError};
    use scp_core::protocol::ErrorCode;
    let mut limits = Limits::default();
    limits
        .apply_rates(
            &json!({"userPerDay": 4, "treePauseS": 10, "hopMax": 0}),
            "test",
        )
        .expect("rate overrides");
    assert_eq!(limits.get("userPerDay"), Some(4));
    assert_eq!(limits.get("treePauseS"), Some(10));
    assert_eq!(limits.get("hopMax"), None);
    limits
        .apply_rates(
            &json!({"userPerDay": null, "treePauseS": null, "pairBurst": 2.0}),
            "test",
        )
        .expect("uncapped");
    assert_eq!(limits.get("userPerDay"), None);
    assert_eq!(limits.get("treePauseS"), Some(10));
    assert_eq!(limits.get("pairBurst"), Some(2));
    for raw in [
        json!([]),
        json!({"unknown": 3}),
        json!({"bodyBytes": 3}),
        json!({"userPerDay": -1}),
        json!({"hopMax": 0.5}),
        json!({"hopMax": "3"}),
    ] {
        assert!(limits.apply_rates(&raw, "test").is_err());
    }
    assert_eq!(
        serde_json::to_value(&limits).expect("wire limits")["userPerDay"],
        json!(null)
    );
    for (code, integer) in [
        (ErrorCode::MethodNotFound, -32601),
        (ErrorCode::InvalidParams, -32602),
        (ErrorCode::NotFound, -32000),
        (ErrorCode::Unauthorized, -32000),
    ] {
        assert_eq!(RpcError::new(code, "error").code, integer);
    }
}

#[tokio::test]
async fn limits_merge_config_legacy_and_environment_in_order() {
    use scp_broker::proto::Limits;
    let home = std::env::temp_dir().join(format!("scp-limits-{:016x}", rand::random::<u64>()));
    tokio::fs::create_dir_all(home.join("scp"))
        .await
        .expect("config directory");
    tokio::fs::write(
        home.join("scp/config.json"),
        r#"{"limits":{"userPerDay":1,"pairBurst":2,"treePauseS":12}}"#,
    )
    .await
    .expect("config");
    let mut env = BTreeMap::from([
        (
            "XDG_CONFIG_HOME".into(),
            home.to_string_lossy().into_owned(),
        ),
        ("SCP_DAILY_CAP".into(), "3".into()),
        (
            "SCP_LIMITS".into(),
            r#"{"userPerDay":4,"pairBurst":null,"treePauseS":0}"#.into(),
        ),
    ]);
    let limits = Limits::from_env(&env).await.expect("merged limits");
    assert_eq!(limits.get("userPerDay"), Some(4));
    assert_eq!(limits.get("pairBurst"), None);
    assert_eq!(limits.get("treePauseS"), Some(12));
    env.remove("SCP_LIMITS");
    assert_eq!(
        Limits::from_env(&env)
            .await
            .expect("legacy override")
            .get("userPerDay"),
        Some(3)
    );
    env.insert("SCP_LIMITS".into(), "false".into());
    assert!(Limits::from_env(&env).await.is_err());
    tokio::fs::remove_dir_all(home)
        .await
        .expect("remove config");
}
