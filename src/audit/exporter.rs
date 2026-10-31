//! SIEM Exporter Module
//!
//! Handles exporting audit logs to external SIEM systems (e.g. Elastic, Splunk, Datadog)
//! via HTTP/JSON.

use crate::audit::AuditEntry;
use crate::config::SiemConfig;
use reqwest::Client;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};
use tracing::{error, info, warn};

/// Most events kept while the SIEM endpoint is failing. Beyond this the oldest are dropped.
pub const MAX_BUFFERED_EVENTS: usize = 10_000;
/// Approximate cap, in bytes, on the events kept while the endpoint is failing.
pub const MAX_BUFFERED_BYTES: usize = 16 * 1024 * 1024;
/// Time allowed to open a connection to the SIEM endpoint.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Time allowed for a whole export request, connection included.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// The "events dropped" warning is logged at most once per this interval.
const DROP_WARN_INTERVAL: Duration = Duration::from_secs(30);
/// Events held between the audit broadcast channel and the exporter loop. The broadcast
/// channel is small (`server.channel_capacity`) and drops events for a slow receiver, so a
/// dedicated task moves events from it into this queue while the loop is busy sending.
pub const QUEUE_CAPACITY: usize = 4_096;
/// Healthy flush interval for a partial batch.
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
/// First wait before retrying a failed export; it doubles on each further failure.
pub const BACKOFF_BASE: Duration = Duration::from_secs(2);
/// Longest wait between retries of a failing endpoint.
pub const BACKOFF_MAX: Duration = Duration::from_secs(120);

/// Rough in-memory size of an entry, enough to bound the retry buffer.
fn approx_size(entry: &AuditEntry) -> usize {
    const FIXED: usize = 256;
    FIXED
        + entry.id.len()
        + entry.timestamp.len()
        + entry.event.len()
        + entry.tool_name.len()
        + entry.status.len()
        + entry.policy_match.as_ref().map_or(0, String::len)
        + entry.payload.as_ref().map_or(0, String::len)
        + entry.agent_id.as_ref().map_or(0, String::len)
        + entry.namespace.as_ref().map_or(0, String::len)
}

/// Counts dropped events and rate-limits the warning about them.
struct DropTracker {
    total: u64,
    unreported: u64,
    last_warn: Option<Instant>,
}

impl DropTracker {
    fn new() -> Self {
        Self {
            total: 0,
            unreported: 0,
            last_warn: None,
        }
    }

    fn record(&mut self, dropped: usize) {
        self.record_with(dropped, "SIEM export buffer full: dropped {} oldest events");
    }

    /// `template` holds one `{}` for the number of events not yet reported.
    fn record_with(&mut self, dropped: usize, template: &str) {
        if dropped == 0 {
            return;
        }
        self.total += dropped as u64;
        self.unreported += dropped as u64;
        let due = match self.last_warn {
            None => true,
            Some(t) => t.elapsed() >= DROP_WARN_INTERVAL,
        };
        if due {
            warn!(
                "{} ({} dropped in total)",
                template.replacen("{}", &self.unreported.to_string(), 1),
                self.total
            );
            self.unreported = 0;
            self.last_warn = Some(Instant::now());
        }
    }
}

/// Events waiting to be sent, bounded by count and by approximate bytes. The byte total is kept
/// as events come and go, so a push costs the same however full the buffer is.
struct Buffer {
    entries: VecDeque<AuditEntry>,
    bytes: usize,
    max_events: usize,
    max_bytes: usize,
}

/// What a push did to the buffer.
#[derive(Debug, PartialEq, Eq)]
struct Pushed {
    /// Older events dropped to make room.
    dropped_oldest: usize,
    /// The event alone is above the byte cap, so it was not kept.
    rejected: bool,
}

impl Buffer {
    fn new(max_events: usize, max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            max_events,
            max_bytes,
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    /// Add an event, dropping the oldest ones until both caps hold. An event that alone is above the
    /// byte cap is rejected (the buffered events are kept) rather than emptying the buffer for it.
    fn push(&mut self, entry: AuditEntry) -> Pushed {
        let size = approx_size(&entry);
        if size > self.max_bytes {
            return Pushed {
                dropped_oldest: 0,
                rejected: true,
            };
        }
        self.entries.push_back(entry);
        self.bytes += size;
        let mut dropped_oldest = 0;
        while self.entries.len() > self.max_events || self.bytes > self.max_bytes {
            let Some(old) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= approx_size(&old);
            dropped_oldest += 1;
        }
        Pushed {
            dropped_oldest,
            rejected: false,
        }
    }
}

/// Exponential backoff for retries of a failing endpoint.
struct Backoff {
    base: Duration,
    max: Duration,
    failures: u32,
    next_at: Option<Instant>,
}

impl Backoff {
    fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            failures: 0,
            next_at: None,
        }
    }

    /// True when a send may be attempted at `now`.
    fn ready(&self, now: Instant) -> bool {
        self.next_at.is_none_or(|t| now >= t)
    }

    /// Wait implied by the failures so far: base, 2x base, 4x base, ... up to the cap.
    fn delay(&self) -> Duration {
        let doublings = self.failures.saturating_sub(1).min(31);
        self.base
            .saturating_mul(2u32.saturating_pow(doublings))
            .min(self.max)
    }

    fn on_failure(&mut self, now: Instant) -> Duration {
        self.failures = self.failures.saturating_add(1);
        let wait = self.delay();
        self.next_at = Some(now + wait);
        wait
    }

    fn on_success(&mut self) {
        self.failures = 0;
        self.next_at = None;
    }
}

/// Move events from the broadcast channel into the exporter queue without ever waiting for
/// the exporter. Anything that does not fit, or that the broadcast channel already dropped
/// for this receiver, is counted and reported (rate-limited).
async fn pump(
    mut rx: broadcast::Receiver<AuditEntry>,
    queue: mpsc::Sender<AuditEntry>,
    drops: Arc<Mutex<DropTracker>>,
) {
    loop {
        match rx.recv().await {
            Ok(entry) => match queue.try_send(entry) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    drops
                        .lock()
                        .unwrap()
                        .record_with(1, "SIEM export queue full: dropped {} new events");
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            },
            Err(broadcast::error::RecvError::Lagged(n)) => {
                drops.lock().unwrap().record_with(
                    n as usize,
                    "SIEM exporter lagged behind the audit channel: lost {} events",
                );
            }
            Err(broadcast::error::RecvError::Closed) => {
                info!("SIEM exporter stopping: channel closed");
                break;
            }
        }
    }
}

pub struct SiemExporter {
    config: SiemConfig,
    client: Client,
    drops: Arc<Mutex<DropTracker>>,
    backoff: Backoff,
}

impl SiemExporter {
    pub fn new(config: SiemConfig) -> Self {
        Self::with_timeouts(config, CONNECT_TIMEOUT, REQUEST_TIMEOUT)
    }

    fn with_timeouts(config: SiemConfig, connect: Duration, request: Duration) -> Self {
        let client = Client::builder()
            .connect_timeout(connect)
            .timeout(request)
            .build()
            .expect("SIEM HTTP client should build");
        Self {
            config,
            client,
            drops: Arc::new(Mutex::new(DropTracker::new())),
            backoff: Backoff::new(BACKOFF_BASE, BACKOFF_MAX),
        }
    }

    /// Run the exporter loop
    pub async fn run(mut self, rx: broadcast::Receiver<AuditEntry>) {
        let endpoint = match &self.config.endpoint {
            Some(e) => e.clone(),
            None => {
                info!("SIEM exporter disabled (no endpoint configured)");
                return;
            }
        };

        info!("SIEM exporter active, sending to {}", endpoint);

        let mut batch = Buffer::new(MAX_BUFFERED_EVENTS, MAX_BUFFERED_BYTES);
        let (queue_tx, mut queue_rx) = mpsc::channel(QUEUE_CAPACITY);
        tokio::spawn(pump(rx, queue_tx, self.drops.clone()));

        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_flush = Instant::now();

        loop {
            let flush;
            tokio::select! {
                next = queue_rx.recv() => {
                    match next {
                        Some(entry) => {
                            let pushed = batch.push(entry);
                            let mut drops = self.drops.lock().unwrap();
                            drops.record(pushed.dropped_oldest);
                            if pushed.rejected {
                                drops.record_with(
                                    1,
                                    "SIEM export: dropped {} events larger than the buffer byte cap",
                                );
                            }
                            drop(drops);
                            flush = batch.len() >= self.config.batch_size;
                        }
                        None => break,
                    }
                }
                // Periodic flush of a partial batch, and the retry timer while backing off.
                _ = tick.tick() => {
                    flush = !batch.is_empty()
                        && (batch.len() >= self.config.batch_size
                            || last_flush.elapsed() >= FLUSH_INTERVAL);
                }
            }
            // While backing off nothing is sent: not per new event, and not by the timer
            // earlier than the backoff allows.
            if flush && !batch.is_empty() && self.backoff.ready(Instant::now()) {
                self.flush(&endpoint, &mut batch).await;
                last_flush = Instant::now();
            }
        }
    }

    /// Send the batch and update the backoff.
    async fn flush(&mut self, endpoint: &str, batch: &mut Buffer) {
        if self.send_batch(endpoint, batch).await {
            self.backoff.on_success();
        } else {
            let wait = self.backoff.on_failure(Instant::now());
            warn!(
                "SIEM export failed {} time(s) in a row; next retry in {:?}, {} events buffered",
                self.backoff.failures,
                wait,
                batch.len()
            );
        }
    }

    async fn send_batch(&self, endpoint: &str, batch: &mut Buffer) -> bool {
        let count = batch.len();
        info!("Sending batch of {} events to SIEM", count);

        let mut req = self.client.post(endpoint).json(&batch.entries);

        if let Some(token) = &self.config.token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                batch.clear();
                true
            }
            Ok(resp) => {
                error!(
                    "SIEM export failed: server returned status {}",
                    resp.status()
                );
                // The batch stays in the buffer and is resent on the backoff timer;
                // `Buffer::push` bounds it.
                false
            }
            Err(e) => {
                error!("SIEM export network error: {}", e);
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    const ENDPOINT: &str = "https://siem.example.test/ingest";

    fn entry(id: &str, payload: Option<&str>) -> AuditEntry {
        AuditEntry {
            id: id.to_string(),
            timestamp: "2026-10-18T00:00:00Z".to_string(),
            event: "TOOL_CALL".to_string(),
            tool_name: "shell".to_string(),
            status: "DENIED".to_string(),
            policy_match: Some("no-rm".to_string()),
            payload: payload.map(str::to_string),
            agent_id: Some("agent-1".to_string()),
            namespace: None,
            anomaly_score: None,
            nearest_neighbor: None,
            fusion: None,
        }
    }

    fn config(endpoint: Option<&str>, batch_size: usize) -> SiemConfig {
        SiemConfig {
            endpoint: endpoint.map(str::to_string),
            token: None,
            batch_size,
        }
    }

    #[tokio::test]
    async fn exporter_without_endpoint_returns_immediately() {
        let (_tx, rx) = broadcast::channel::<AuditEntry>(4);
        let exporter = SiemExporter::new(config(None, 10));
        tokio::time::timeout(Duration::from_secs(1), exporter.run(rx))
            .await
            .expect("run should return without an endpoint");
    }

    #[tokio::test]
    async fn exporter_stops_when_the_channel_closes_with_nothing_pending() {
        let (tx, rx) = broadcast::channel::<AuditEntry>(4);
        drop(tx);
        let exporter = SiemExporter::new(config(Some(ENDPOINT), 10));
        tokio::time::timeout(Duration::from_secs(1), exporter.run(rx))
            .await
            .expect("run should stop when the channel is closed");
    }

    #[tokio::test]
    async fn lagged_receiver_keeps_running_until_the_channel_closes() {
        let (tx, rx) = broadcast::channel::<AuditEntry>(2);
        for i in 0..4 {
            tx.send(entry(&format!("e{i}"), None)).unwrap();
        }
        drop(tx);
        // The batch size is above the event count, so nothing is flushed over HTTP.
        let exporter = SiemExporter::new(config(Some(ENDPOINT), 100));
        tokio::time::timeout(Duration::from_secs(1), exporter.run(rx))
            .await
            .expect("run should stop after the lag and the close");
    }

    fn buffer_of(n: usize, payload: Option<&str>, max_events: usize, max_bytes: usize) -> Buffer {
        let mut b = Buffer::new(max_events, max_bytes);
        for i in 0..n {
            b.push(entry(&format!("e{i}"), payload));
        }
        b
    }

    fn ids(b: &Buffer) -> Vec<&str> {
        b.entries.iter().map(|e| e.id.as_str()).collect()
    }

    fn real_bytes(b: &Buffer) -> usize {
        b.entries.iter().map(approx_size).sum()
    }

    #[test]
    fn cap_drops_oldest_events_first() {
        let b = buffer_of(10, None, 4, usize::MAX);
        assert_eq!(ids(&b), ["e6", "e7", "e8", "e9"]);
        let mut b = b;
        let p = b.push(entry("e10", None));
        assert_eq!(p.dropped_oldest, 1);
        assert_eq!(ids(&b), ["e7", "e8", "e9", "e10"]);
    }

    #[test]
    fn byte_cap_drops_oldest_and_keeps_the_newest() {
        let big = "x".repeat(1000);
        let one = approx_size(&entry("e0", Some(&big)));
        let b = buffer_of(5, Some(&big), 100, one * 2 + 1);
        assert_eq!(ids(&b), ["e3", "e4"]);
        assert_eq!(b.bytes, one * 2);
    }

    #[test]
    fn an_event_above_the_byte_cap_is_rejected_and_the_buffer_is_kept() {
        let big = "x".repeat(1000);
        let one = approx_size(&entry("e0", Some(&big)));
        let mut b = buffer_of(2, Some(&big), 100, one * 2);
        let huge = entry("huge", Some(&"y".repeat(one * 3)));
        let p = b.push(huge);
        assert_eq!(
            p,
            Pushed {
                dropped_oldest: 0,
                rejected: true
            }
        );
        assert_eq!(ids(&b), ["e0", "e1"]);
        assert_eq!(b.bytes, real_bytes(&b));
    }

    #[test]
    fn the_byte_counter_always_equals_the_real_sum() {
        let mut b = Buffer::new(50, 20_000);
        for i in 0..2_000usize {
            let payload = "z".repeat((i * 37) % 3_000);
            b.push(entry(&format!("e{i}"), Some(&payload)));
            assert_eq!(b.bytes, real_bytes(&b), "after push {i}");
            assert!(b.len() <= 50 && b.bytes <= 20_000);
        }
        b.clear();
        assert_eq!((b.len(), b.bytes), (0, 0));
    }

    #[test]
    fn pushes_at_the_cap_stay_linear() {
        // Before the byte total was kept incrementally, 100k pushes took about 48 s.
        let mut b = Buffer::new(MAX_BUFFERED_EVENTS, MAX_BUFFERED_BYTES);
        let start = Instant::now();
        for i in 0..100_000 {
            b.push(entry(&format!("e{i}"), None));
        }
        assert_eq!(b.len(), MAX_BUFFERED_EVENTS);
        assert_eq!(b.bytes, real_bytes(&b));
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "100k pushes took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn pushes_at_the_byte_cap_stay_linear() {
        // Large events: the byte cap, not the count, is what bounds the buffer.
        let payload = "p".repeat(4_000);
        let mut b = Buffer::new(MAX_BUFFERED_EVENTS, MAX_BUFFERED_BYTES);
        let start = Instant::now();
        for i in 0..50_000 {
            b.push(entry(&format!("e{i}"), Some(&payload)));
        }
        assert!(b.bytes <= MAX_BUFFERED_BYTES);
        assert_eq!(b.bytes, real_bytes(&b));
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "50k pushes took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn drop_tracker_counts_and_rate_limits_the_warning() {
        let mut t = DropTracker::new();
        t.record(0);
        assert!(t.last_warn.is_none());
        t.record(5);
        assert_eq!((t.total, t.unreported), (5, 0));
        assert!(t.last_warn.is_some());
        // Within the interval: counted, but the warning is held back.
        t.record(3);
        t.record(2);
        assert_eq!((t.total, t.unreported), (10, 5));
    }

    #[tokio::test]
    async fn failed_batches_stay_bounded_and_oldest_are_dropped() {
        // Nothing listens on this port, so every send fails fast.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let endpoint = format!("http://127.0.0.1:{port}/");
        let exporter = SiemExporter::with_timeouts(
            config(Some(&endpoint), 100),
            Duration::from_millis(200),
            Duration::from_millis(500),
        );
        let mut batch = Buffer::new(8, usize::MAX);
        for i in 0..8 {
            batch.push(entry(&format!("e{i}"), None));
        }
        assert!(!exporter.send_batch(&endpoint, &mut batch).await);
        assert_eq!(batch.len(), 8, "a failed batch is kept for retry");
        for i in 8..20 {
            let dropped = batch.push(entry(&format!("e{i}"), None)).dropped_oldest;
            exporter.drops.lock().unwrap().record(dropped);
        }
        assert_eq!(exporter.drops.lock().unwrap().total, 12);
        assert_eq!(batch.len(), 8);
        assert_eq!(batch.entries[0].id, "e12");
    }

    #[tokio::test]
    async fn hung_endpoint_times_out_instead_of_blocking() {
        // Accepts the connection, reads the request, and never answers.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            loop {
                if sock.read(&mut buf).await.unwrap_or(0) == 0 {
                    break;
                }
            }
        });
        let exporter = SiemExporter::with_timeouts(
            config(Some("unused"), 100),
            Duration::from_millis(500),
            Duration::from_millis(400),
        );
        let mut batch = buffer_of(1, None, 100, usize::MAX);
        let endpoint = format!("http://127.0.0.1:{port}/");
        let started = Instant::now();
        let ok = tokio::time::timeout(
            Duration::from_secs(5),
            exporter.send_batch(&endpoint, &mut batch),
        )
        .await
        .expect("send_batch should return on its own timeout");
        assert!(!ok);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(batch.len(), 1, "a timed-out batch is kept for retry");
    }

    #[tokio::test]
    async fn burst_beyond_the_queue_is_counted_not_lost_silently() {
        // Nobody reads the queue, so only `QUEUE` events fit; the rest are counted.
        const QUEUE: usize = 5;
        let (tx, rx) = broadcast::channel::<AuditEntry>(64);
        for i in 0..50 {
            tx.send(entry(&format!("e{i}"), None)).unwrap();
        }
        drop(tx);
        let (queue_tx, mut queue_rx) = mpsc::channel(QUEUE);
        let drops = Arc::new(Mutex::new(DropTracker::new()));
        pump(rx, queue_tx, drops.clone()).await;
        let mut kept = 0;
        while queue_rx.try_recv().is_ok() {
            kept += 1;
        }
        assert_eq!(kept, QUEUE);
        assert_eq!(drops.lock().unwrap().total, 50 - QUEUE as u64);
    }

    #[tokio::test]
    async fn broadcast_lag_is_counted_by_the_pump() {
        let (tx, rx) = broadcast::channel::<AuditEntry>(2);
        for i in 0..10 {
            tx.send(entry(&format!("e{i}"), None)).unwrap();
        }
        drop(tx);
        let (queue_tx, mut queue_rx) = mpsc::channel(100);
        let drops = Arc::new(Mutex::new(DropTracker::new()));
        pump(rx, queue_tx, drops.clone()).await;
        let mut kept = 0;
        while queue_rx.try_recv().is_ok() {
            kept += 1;
        }
        assert_eq!(kept, 2);
        assert_eq!(drops.lock().unwrap().total, 8);
    }

    #[tokio::test]
    async fn burst_through_the_exporter_loses_nothing_while_the_endpoint_hangs() {
        // The endpoint accepts and never answers; sending blocks for the request timeout.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = listener.accept().await {
                held.push(sock);
            }
        });
        let endpoint = format!("http://127.0.0.1:{port}/");
        let (tx, rx) = broadcast::channel::<AuditEntry>(8);
        let exporter = SiemExporter::with_timeouts(
            config(Some(&endpoint), 1),
            Duration::from_millis(500),
            Duration::from_millis(800),
        );
        let drops = exporter.drops.clone();
        let task = tokio::spawn(exporter.run(rx));
        // Paced like a real load (far above the broadcast capacity in total) so the pump
        // keeps up while the loop is blocked in a send.
        for i in 0..400 {
            tx.send(entry(&format!("e{i}"), None)).unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert_eq!(drops.lock().unwrap().total, 0, "no event may be lost");
        drop(tx);
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("run should stop once the channel closes")
            .unwrap();
    }

    /// Minimal HTTP server: counts requests and answers each with `status`.
    async fn counting_server(status: u16) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let h = h.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 65536];
                    let _ = sock.read(&mut buf).await;
                    h.fetch_add(1, Ordering::SeqCst);
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = sock.write_all(reply.as_bytes()).await;
                });
            }
        });
        (format!("http://127.0.0.1:{port}/"), hits)
    }

    #[tokio::test]
    async fn failing_endpoint_is_retried_on_the_timer_not_per_event() {
        use std::sync::atomic::Ordering;
        let (endpoint, hits) = counting_server(500).await;
        let (tx, rx) = broadcast::channel::<AuditEntry>(512);
        let mut exporter = SiemExporter::with_timeouts(
            config(Some(&endpoint), 1),
            Duration::from_millis(500),
            Duration::from_millis(800),
        );
        exporter.backoff = Backoff::new(Duration::from_secs(2), Duration::from_secs(2));
        let task = tokio::spawn(exporter.run(rx));
        // Every event alone fills a batch (batch_size 1). Before the fix each one resent
        // the whole growing batch; now only the first attempt goes out.
        for i in 0..200 {
            tx.send(entry(&format!("e{i}"), None)).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "no send per event while backing off"
        );
        // After the backoff, the timer retries once with the whole buffer.
        tokio::time::sleep(Duration::from_millis(2700)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "one timer retry after the backoff"
        );
        drop(tx);
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    }

    #[test]
    fn backoff_grows_is_capped_and_resets_on_success() {
        let mut b = Backoff::new(Duration::from_secs(2), Duration::from_secs(20));
        let t0 = Instant::now();
        assert!(b.ready(t0));
        let waits: Vec<u64> = (0..6).map(|_| b.on_failure(t0).as_secs()).collect();
        assert_eq!(waits, [2, 4, 8, 16, 20, 20]);
        assert!(!b.ready(t0 + Duration::from_secs(19)));
        assert!(b.ready(t0 + Duration::from_secs(20)));
        b.on_success();
        assert!(b.ready(t0));
        assert_eq!(
            b.on_failure(t0).as_secs(),
            2,
            "restarts from the base after a success"
        );
    }

    #[test]
    fn backoff_does_not_overflow_on_many_failures() {
        let mut b = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
        let t0 = Instant::now();
        for _ in 0..1000 {
            assert!(b.on_failure(t0) <= BACKOFF_MAX);
        }
    }

    #[test]
    fn batch_body_is_a_json_array_with_escaped_strings() {
        let batch = vec![entry("e1", Some("line1\n\"quoted\" \\ path\t\u{1F600}"))];
        let req = Client::new()
            .post(ENDPOINT)
            .json(&batch)
            .build()
            .expect("request should build");
        let body = req
            .body()
            .and_then(|b| b.as_bytes())
            .expect("JSON body should be buffered");

        let parsed: serde_json::Value =
            serde_json::from_slice(body).expect("body should be valid JSON");
        assert_eq!(parsed[0]["id"], "e1");
        assert_eq!(parsed[0]["tool_name"], "shell");
        assert_eq!(parsed[0]["payload"], "line1\n\"quoted\" \\ path\t\u{1F600}");
        assert!(parsed[0]["namespace"].is_null());

        let raw = std::str::from_utf8(body).expect("body should be UTF-8");
        assert!(raw.contains(r#""payload":"line1\n\"quoted\" \\ path\t"#));
        // `fusion` is skipped when absent.
        assert!(!raw.contains("fusion"));
        assert_eq!(
            req.headers()[reqwest::header::CONTENT_TYPE],
            "application/json"
        );
    }
}
