//! Keeping one panic from taking the gateway down.
//!
//! The release build unwinds on a panic (it used to abort the whole process). Three places turn a panic
//! into a refused request instead of a dead gateway:
//!
//! - the management API answers `500` to the request that panicked and keeps serving the others
//!   ([`layer`]);
//! - a JSON-RPC message that panics while it is checked gets an error reply, never a forwarded call
//!   ([`deny_on_panic`]);
//! - a blocking task that panics reaches its caller as a `JoinError`, which every caller already treats
//!   as a refusal.
//!
//! The reply never carries the panic message: it can quote the request.

use axum::{
    body::Body,
    http::{header, Response, StatusCode},
};
use futures::FutureExt;
use std::{any::Any, future::Future, panic::AssertUnwindSafe};
use tower_http::catch_panic::CatchPanicLayer;

/// JSON-RPC "internal error": the message was not processed and nothing was forwarded.
pub const INTERNAL_ERROR_CODE: i32 = -32603;
const INTERNAL_ERROR_TEXT: &str = "Internal error: the request was refused";

type PanicResponder = fn(Box<dyn Any + Send>) -> Response<Body>;

fn refuse_request(_panic: Box<dyn Any + Send>) -> Response<Body> {
    tracing::error!(
        "a request handler panicked: the request was refused and the gateway keeps running"
    );
    let mut response = Response::new(Body::from(r#"{"error":"internal error"}"#));
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    response
}

/// A layer that turns a panic in a handler or in a layer below it into a `500` for that request.
pub fn layer() -> CatchPanicLayer<PanicResponder> {
    CatchPanicLayer::custom(refuse_request as PanicResponder)
}

/// The JSON-RPC error reply for a message whose handling panicked, with the request's id when it has one.
pub fn panic_reply(line: &str) -> String {
    let id = serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .filter(|id| id.is_string() || id.is_number());
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": INTERNAL_ERROR_CODE, "message": INTERNAL_ERROR_TEXT }
    })
    .to_string()
}

/// Run the handling of one JSON-RPC message. A panic becomes an error reply: the call is not forwarded and
/// the connection or session that sent it stays up.
pub async fn deny_on_panic<F>(line: &str, handling: F) -> anyhow::Result<Option<String>>
where
    F: Future<Output = anyhow::Result<Option<String>>>,
{
    match AssertUnwindSafe(handling).catch_unwind().await {
        Ok(result) => result,
        Err(_) => {
            tracing::error!("a message panicked while it was checked: it was refused");
            Ok(Some(panic_reply(line)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_panicking_message_gets_an_error_reply_with_its_id() {
        let line = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call"}"#;
        let out = deny_on_panic(line, async { panic!("boom") })
            .await
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["error"]["code"], INTERNAL_ERROR_CODE);
        assert!(v.get("result").is_none());
        assert!(!out.contains("boom"), "the panic text must not be echoed");
    }

    #[tokio::test]
    async fn a_message_that_does_not_panic_passes_through() {
        let ok = deny_on_panic("{}", async { Ok(Some("fine".to_string())) })
            .await
            .unwrap();
        assert_eq!(ok.as_deref(), Some("fine"));
        let err = deny_on_panic("{}", async { Err(anyhow::anyhow!("plain")) }).await;
        assert!(err.is_err());
    }

    #[test]
    fn the_reply_to_unparseable_input_has_a_null_id() {
        let v: serde_json::Value = serde_json::from_str(&panic_reply("not json")).unwrap();
        assert!(v["id"].is_null());
        let v: serde_json::Value = serde_json::from_str(&panic_reply(r#"{"id":{"x":1}}"#)).unwrap();
        assert!(v["id"].is_null(), "a structured id is not echoed");
    }
}
