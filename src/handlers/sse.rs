//! Server-Sent Events (SSE) Handler
//!
//! Provides real-time streaming of audit events to connected clients.

use axum::{
    extract::State,
    response::sse::{Event, Sse},
    Extension,
};
use futures::stream::Stream;
use std::convert::Infallible;
use tokio::sync::broadcast;

use crate::audit::AuditEntry;
use crate::tenants::{TenantContext, TenantRole};

/// SSE handler state
#[derive(Clone)]
pub struct SseState {
    pub tx: broadcast::Sender<AuditEntry>,
}

/// SSE endpoint for real-time audit log streaming
pub async fn events(
    State(state): State<SseState>,
    Extension(tenant): Extension<TenantContext>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.tx.subscribe();
    let tenant_namespace = tenant.namespace.clone();
    let is_super_admin = tenant.role == TenantRole::SuperAdmin;

    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(entry) => {
                    // Filter by namespace unless SuperAdmin
                    if is_super_admin || entry.namespace.as_ref() == Some(&tenant_namespace) {
                        if let Ok(json) = serde_json::to_string(&entry) {
                            yield Ok(Event::default().data(json));
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Skip lagged messages
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;
    use futures::StreamExt;
    use std::time::Duration;

    fn tenant(namespace: &str, role: TenantRole) -> TenantContext {
        TenantContext {
            id: format!("sse-{namespace}"),
            name: "SSE Test Tenant".to_string(),
            namespace: namespace.to_string(),
            role,
        }
    }

    fn entry(id: &str, namespace: Option<&str>) -> AuditEntry {
        let mut e = AuditEntry::new("TOOL_CALL", "example_tool", "ALLOWED");
        e.id = id.to_string();
        e.namespace = namespace.map(|n| n.to_string());
        e
    }

    /// Open the endpoint and return the response body as a stream of chunks.
    async fn open(
        tx: &broadcast::Sender<AuditEntry>,
        tenant: TenantContext,
    ) -> axum::body::BodyDataStream {
        let sse = events(State(SseState { tx: tx.clone() }), Extension(tenant)).await;
        let response = sse.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/event-stream"
        );
        response.into_body().into_data_stream()
    }

    async fn next_chunk(body: &mut axum::body::BodyDataStream) -> Option<String> {
        let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("timed out waiting for an event")?;
        Some(String::from_utf8(chunk.expect("body error").to_vec()).expect("utf-8"))
    }

    /// Parse the JSON carried by one `data: <json>` event.
    fn parse(chunk: &str) -> serde_json::Value {
        let data = chunk
            .strip_prefix("data: ")
            .unwrap_or_else(|| panic!("not an SSE data event: {chunk:?}"))
            .trim_end();
        serde_json::from_str(data).expect("event data is JSON")
    }

    fn id_of(chunk: &str) -> String {
        parse(chunk)["id"].as_str().expect("id").to_string()
    }

    #[tokio::test]
    async fn delivers_events_of_the_tenant_namespace_as_sse_data() {
        let (tx, _rx) = broadcast::channel(16);
        let mut body = open(&tx, tenant("ns-a", TenantRole::User)).await;

        tx.send(entry("evt-1", Some("ns-a"))).unwrap();

        let chunk = next_chunk(&mut body).await.expect("an event");
        assert!(chunk.ends_with("\n\n"), "events end with a blank line");
        let value = parse(&chunk);
        assert_eq!(value["id"], "evt-1");
        assert_eq!(value["tool_name"], "example_tool");
        assert_eq!(value["status"], "ALLOWED");
    }

    #[tokio::test]
    async fn filters_out_other_namespaces_and_entries_without_one() {
        let (tx, _rx) = broadcast::channel(16);
        let mut body = open(&tx, tenant("ns-a", TenantRole::User)).await;

        tx.send(entry("other", Some("ns-b"))).unwrap();
        tx.send(entry("no-namespace", None)).unwrap();
        tx.send(entry("mine", Some("ns-a"))).unwrap();

        // The first event the tenant sees is its own; the others were skipped.
        let chunk = next_chunk(&mut body).await.expect("an event");
        assert_eq!(id_of(&chunk), "mine");
    }

    #[tokio::test]
    async fn super_admin_sees_every_namespace() {
        let (tx, _rx) = broadcast::channel(16);
        let mut body = open(&tx, tenant("ns-root", TenantRole::SuperAdmin)).await;

        tx.send(entry("evt-a", Some("ns-a"))).unwrap();
        tx.send(entry("evt-b", Some("ns-b"))).unwrap();
        tx.send(entry("evt-none", None)).unwrap();

        for expected in ["evt-a", "evt-b", "evt-none"] {
            let chunk = next_chunk(&mut body).await.expect("an event");
            assert_eq!(id_of(&chunk), expected);
        }
    }

    #[tokio::test]
    async fn admin_role_is_still_limited_to_its_own_namespace() {
        let (tx, _rx) = broadcast::channel(16);
        let mut body = open(&tx, tenant("ns-a", TenantRole::Admin)).await;

        tx.send(entry("foreign", Some("ns-b"))).unwrap();
        tx.send(entry("own", Some("ns-a"))).unwrap();

        let chunk = next_chunk(&mut body).await.expect("an event");
        assert_eq!(id_of(&chunk), "own");
    }

    #[tokio::test]
    async fn stream_survives_a_lagging_receiver() {
        let (tx, _rx) = broadcast::channel(2);
        let mut body = open(&tx, tenant("ns-a", TenantRole::User)).await;

        // Five events into a two-slot channel before the client reads any.
        for i in 1..=5 {
            tx.send(entry(&format!("evt-{i}"), Some("ns-a"))).unwrap();
        }

        // The oldest events were dropped; the stream keeps going with the rest.
        let first = next_chunk(&mut body).await.expect("an event");
        let second = next_chunk(&mut body).await.expect("an event");
        assert_eq!(id_of(&first), "evt-4");
        assert_eq!(id_of(&second), "evt-5");

        tx.send(entry("evt-6", Some("ns-a"))).unwrap();
        let third = next_chunk(&mut body).await.expect("an event");
        assert_eq!(id_of(&third), "evt-6");
    }

    #[tokio::test]
    async fn stream_ends_when_the_channel_is_closed() {
        let (tx, rx) = broadcast::channel(16);
        let mut body = open(&tx, tenant("ns-a", TenantRole::User)).await;

        tx.send(entry("last", Some("ns-a"))).unwrap();
        drop(tx);
        drop(rx);

        let chunk = next_chunk(&mut body).await.expect("the pending event");
        assert_eq!(id_of(&chunk), "last");
        assert!(
            next_chunk(&mut body).await.is_none(),
            "the stream must end once every sender is gone"
        );
    }

    #[tokio::test]
    async fn each_subscriber_gets_its_own_copy() {
        let (tx, _rx) = broadcast::channel(16);
        let mut first = open(&tx, tenant("ns-a", TenantRole::User)).await;
        let mut second = open(&tx, tenant("ns-a", TenantRole::User)).await;

        tx.send(entry("shared", Some("ns-a"))).unwrap();

        assert_eq!(id_of(&next_chunk(&mut first).await.unwrap()), "shared");
        assert_eq!(id_of(&next_chunk(&mut second).await.unwrap()), "shared");
    }
}
