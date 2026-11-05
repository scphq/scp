//! The hub's WebSocket as a relay connection (`CloudRelayClient`): one JSON-RPC message per text frame each way, the token in a bearer
//! header, and the hub's close as the error every pending and later request fails with.

use futures_util::{SinkExt, StreamExt};
use scp_mcp::client::{CallError, Client, Feed};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// `<origin>/v1/relay/ws`, ws for http and wss for https
pub fn socket_url(origin: &str) -> String {
    match reqwest::Url::parse(origin).and_then(|base| base.join("/v1/relay/ws")) {
        Ok(mut url) => {
            let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
            let _ = url.set_scheme(scheme);
            url.to_string()
        }
        Err(_) => format!("{origin}/v1/relay/ws"),
    }
}

/// how the hub ended the connection, as the CLI words it: 1008 is a refused login
pub fn closed_error(code: u16, reason: &str) -> String {
    let reason = if reason.is_empty() {
        String::new()
    } else {
        format!(": {reason}")
    };
    if code == 1008 {
        format!("the relay closed the connection{reason}")
    } else {
        format!("the relay closed the connection ({code}{reason})")
    }
}

/// a connection to the hub at `origin` with `token`; needs a tokio LocalSet, which runs the socket
pub async fn connect(origin: &str, token: &str) -> Result<Client, CallError> {
    let url = socket_url(origin);
    let refused = || {
        CallError::relay(
            "unavailable",
            format!("could not connect to the relay at {url} (check SCP_RELAY and your login)"),
        )
    };
    let mut request = url.as_str().into_client_request().map_err(|_| refused())?;
    let bearer = format!("Bearer {token}").parse().map_err(|_| refused())?;
    request.headers_mut().insert("Authorization", bearer);
    let (stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|_| refused())?;
    let (client, outgoing, feed) = Client::framed();
    tokio::task::spawn_local(pump(stream, outgoing, feed));
    Ok(client)
}

/// how long the acknowledgment of a close the hub sent may take to go out
const ACK_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

async fn pump<S>(stream: S, mut outgoing: UnboundedReceiver<Vec<u8>>, feed: Feed)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message>
        + Unpin,
{
    let (mut sink, mut source) = stream.split();
    let mut open = true;
    loop {
        tokio::select! {
            line = outgoing.recv(), if open => match line {
                Some(mut line) => {
                    if line.last() == Some(&b'\n') {
                        line.pop();
                    }
                    let text = String::from_utf8_lossy(&line).into_owned();
                    let _ = sink.send(Message::text(text)).await;
                }
                None => {
                    open = false;
                    feed.fail("the connection is closed");
                    let done = CloseFrame { code: CloseCode::Normal, reason: "done".into() };
                    let _ = sink.send(Message::Close(Some(done))).await;
                }
            },
            message = source.next() => match message {
                Some(Ok(Message::Text(text))) => feed.message(text.as_bytes()),
                Some(Ok(Message::Binary(bytes))) => feed.message(&bytes),
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map_or((1005, String::new()), |frame| {
                        (u16::from(frame.code), frame.reason.to_string())
                    });
                    feed.fail(&closed_error(code, &reason));
                    let _ = tokio::time::timeout(ACK_WAIT, sink.flush()).await;
                    return;
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => {
                    feed.fail(&closed_error(1006, ""));
                    return;
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_sits_at_v1_relay_ws_of_the_origin() {
        assert_eq!(
            socket_url("https://app.scp.dev"),
            "wss://app.scp.dev/v1/relay/ws"
        );
        assert_eq!(
            socket_url("http://127.0.0.1:4100"),
            "ws://127.0.0.1:4100/v1/relay/ws"
        );
    }

    #[test]
    fn a_policy_close_reads_as_a_refusal_and_others_carry_their_code() {
        assert_eq!(
            closed_error(1008, "bad token"),
            "the relay closed the connection: bad token"
        );
        assert_eq!(
            closed_error(1006, ""),
            "the relay closed the connection (1006)"
        );
        assert_eq!(
            closed_error(1011, "boom"),
            "the relay closed the connection (1011: boom)"
        );
    }
}
