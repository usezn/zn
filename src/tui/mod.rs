use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, List, ListItem, Paragraph},
    Terminal,
};
use reqwest::Client;
use serde::Deserialize;
use std::io;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
struct ApiLogEntry {
    timestamp: String,
    tool_name: String,
    status: String,
    event: String,
    anomaly_score: Option<f32>,
}

#[derive(Debug, Deserialize, Default)]
struct ApiStatsResponse {
    stats: ApiStats,
}

#[derive(Debug, Deserialize, Default)]
struct ApiStats {
    total: u64,
    allowed: u64,
    denied: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ApiPendingAction {
    pub id: String,
    pub agent_id: String,
    pub tool_name: String,
    pub timestamp: String,
    pub required_m: u32,
    pub signatures: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ApiLogsResponse {
    entries: Vec<ApiLogEntry>,
}

#[derive(Debug, Deserialize)]
struct ApiConsensusResponse {
    entries: Vec<ApiPendingAction>,
}

pub struct TuiApp {
    client: Client,
    logs: Vec<ApiLogEntry>,
    pending_actions: Vec<ApiPendingAction>,
    stats: ApiStats,
    last_update: Instant,
    api_url: String,
    connection_status: String,
    connection_color: Color,
}

/// Port the gateway uses when nothing else is set.
const DEFAULT_PORT: u16 = 9090;

/// Gives the terminal back (normal mode, main screen) when it is dropped, so
/// every way out of the dashboard, an error or a panic included, leaves a
/// usable terminal.
struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

/// The API key as an HTTP header value, or a plain explanation of what is wrong
/// with it. The value is marked sensitive so it never shows up in debug output.
fn api_key_header(key: &str) -> std::result::Result<reqwest::header::HeaderValue, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(
            "The API key is empty. Pass it with --api-key, or set the ZN_API_KEY environment variable."
                .to_string(),
        );
    }
    match reqwest::header::HeaderValue::from_str(key) {
        Ok(mut value) => {
            value.set_sensitive(true);
            Ok(value)
        }
        Err(_) => Err(
            "The API key has characters that cannot be sent in an HTTP header (for example a line break or an accented letter). Copy the key again, without extra characters, and pass it with --api-key or ZN_API_KEY."
                .to_string(),
        ),
    }
}

/// What to tell the user when the gateway answers the first request with this
/// status. None means the answer is fine.
fn first_reply_problem(status: u16, api_url: &str) -> Option<String> {
    match status {
        200..=299 => None,
        401 | 403 => Some(format!(
            "The gateway at {api_url} rejected the API key (HTTP {status}). Use the key the gateway was started with: pass it with --api-key, or set ZN_API_KEY. If zn generated the key, it is in the file zn-superadmin-key.txt next to the audit database."
        )),
        _ => Some(format!(
            "The gateway at {api_url} answered with HTTP {status} instead of its statistics. Check that this is the zn gateway, and that --port is the port it listens on."
        )),
    }
}

/// What to tell the user when nothing answers at the address.
fn unreachable_problem(api_url: &str) -> String {
    format!(
        "The dashboard could not reach the zn gateway at {api_url}. Check that zn is running (start it with: zn start). If it listens on another port, run: zn dashboard --port <port>."
    )
}

impl TuiApp {
    /// Open the dashboard. The key and the gateway are checked before the screen
    /// is taken over, so a mistake ends with a clear message in the normal
    /// terminal instead of a screen stuck on CONNECTING.
    pub async fn run(api_key: Option<String>, port: Option<u16>) -> Result<()> {
        // Resolve API Key (CLI > Env > Error)
        let resolved_key = match api_key {
            Some(key) => key,
            None => std::env::var("ZN_API_KEY").map_err(|_| {
                anyhow::anyhow!(
                    "No API key was given. Pass it with --api-key, or set the ZN_API_KEY environment variable."
                )
            })?,
        };

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "X-API-Key",
            api_key_header(&resolved_key).map_err(|m| anyhow::anyhow!(m))?,
        );
        let api_url = format!("http://localhost:{}", port.unwrap_or(DEFAULT_PORT));

        let client = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(1))
            .build()?;

        // Check the gateway and the key before the terminal is changed.
        match client.get(format!("{api_url}/api/v1/stats")).send().await {
            Ok(res) => {
                if let Some(problem) = first_reply_problem(res.status().as_u16(), &api_url) {
                    anyhow::bail!(problem);
                }
            }
            Err(_) => anyhow::bail!(unreachable_problem(&api_url)),
        }

        enable_raw_mode().map_err(|_| {
            anyhow::anyhow!(
                "The dashboard needs an interactive terminal. Run it directly in a terminal window, not through a pipe or a script."
            )
        })?;
        let _guard = TerminalGuard;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout);
        let mut terminal = Terminal::new(backend)?;

        let mut app = TuiApp {
            client,
            logs: Vec::new(),
            pending_actions: Vec::new(),
            stats: ApiStats::default(),
            last_update: Instant::now(),
            api_url,
            connection_status: "CONNECTING".to_string(),
            connection_color: Color::Yellow,
        };

        // Initial fetch
        app.fetch_data().await;

        loop {
            // Draw UI
            terminal.draw(|f| ui(f, &app))?;

            // Input handling
            if event::poll(Duration::from_millis(100))? {
                if let Event::Key(key) = event::read()? {
                    if key.code == KeyCode::Char('q') {
                        break;
                    }
                }
            }

            // Periodic Update (1s)
            if app.last_update.elapsed() > Duration::from_secs(1) {
                app.fetch_data().await;
                app.last_update = Instant::now();
            }
        }

        terminal.show_cursor()?;

        Ok(())
    }

    async fn fetch_data(&mut self) {
        // Fetch Stats
        match self
            .client
            .get(format!("{}/api/v1/stats", self.api_url))
            .send()
            .await
        {
            Ok(res) => {
                let status = res.status().as_u16();
                if status == 401 || status == 403 {
                    self.connection_status = "KEY REJECTED".to_string();
                    self.connection_color = Color::Red;
                } else if !(200..=299).contains(&status) {
                    self.connection_status = format!("HTTP {status}");
                    self.connection_color = Color::Red;
                } else if let Ok(json) = res.json::<ApiStatsResponse>().await {
                    self.stats = json.stats;
                    self.connection_status = "CONNECTED".to_string();
                    self.connection_color = Color::Green;
                } else {
                    self.connection_status = "UNEXPECTED REPLY".to_string();
                    self.connection_color = Color::Red;
                }
            }
            Err(_) => {
                self.connection_status = "DISCONNECTED".to_string();
                self.connection_color = Color::Red;
            }
        }

        // Fetch Logs if connected
        if self.connection_status == "CONNECTED" {
            // Logs
            if let Ok(res) = self
                .client
                .get(format!("{}/api/v1/logs", self.api_url))
                .send()
                .await
            {
                if let Ok(json) = res.json::<ApiLogsResponse>().await {
                    self.logs = json.entries;
                }
            }
            // Pending Consensus
            if let Ok(res) = self
                .client
                .get(format!("{}/api/v1/consensus/pending", self.api_url))
                .send()
                .await
            {
                if let Ok(json) = res.json::<ApiConsensusResponse>().await {
                    self.pending_actions = json.entries;
                }
            }
        }
    }
}

/// Body text of a stat tile.
fn stat_text(value: u64) -> String {
    format!(
        "
  {}",
        value
    )
}

/// Footer line shown at the bottom of the screen.
fn footer_text(api_url: &str) -> String {
    format!(
        " Press 'q' to exit | API: {} | Active Shields: SQL, LFI, Loop, Caching ",
        api_url
    )
}

/// Icon and colour for an audit log status.
fn status_style(status: &str) -> (&'static str, Color) {
    if status == "DENIED" {
        (" ✖ ", Color::Rgb(255, 120, 120))
    } else {
        (" ✔ ", Color::Rgb(120, 255, 120))
    }
}

/// Tag appended to a log line based on the anomaly score.
fn neural_tag(score: Option<f32>) -> &'static str {
    match score {
        Some(score) if score > 1.2 => " 🔥 RISKY",
        Some(_) => " ✨ SAFE",
        None => "",
    }
}

/// `HH:MM` part of an ISO-8601 timestamp, or an empty string if absent.
fn short_time(timestamp: &str) -> String {
    timestamp
        .split('T')
        .nth(1)
        .unwrap_or("")
        .split(':')
        .take(2)
        .collect::<Vec<_>>()
        .join(":")
}

/// Text and colour of one row in the audit stream.
fn format_log_line(log: &ApiLogEntry) -> (String, Color) {
    let (icon, color) = status_style(&log.status);
    let content = format!(
        "{} {} | {:<15} | {}{}",
        icon,
        short_time(&log.timestamp),
        log.tool_name,
        log.event,
        neural_tag(log.anomaly_score)
    );
    (content, color)
}

/// Text of one row in the governance queue.
fn format_pending_line(action: &ApiPendingAction) -> String {
    format!(
        " ⏳ {} ({} Sigs Required)
    Agent: {}",
        action.tool_name, action.required_m, action.agent_id
    )
}

fn ui(f: &mut ratatui::Frame, app: &TuiApp) {
    let size = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(
            [
                Constraint::Length(3), // Header
                Constraint::Length(6), // Stats
                Constraint::Min(0),    // Content (Logs + Governance)
                Constraint::Length(1), // Footer
            ]
            .as_ref(),
        )
        .split(size);

    // 1. PREMIUM HEADER
    let header_chunk = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(0), Constraint::Length(25)])
        .split(chunks[0]);

    let header_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Rgb(100, 100, 255)))
        .title(" zn Control Plane 🛡️ ");

    let tagline = Paragraph::new(" Active Defense & Intent Governance ")
        .style(Style::default().fg(Color::Gray))
        .alignment(ratatui::layout::Alignment::Center);

    f.render_widget(tagline.block(header_block), header_chunk[0]);

    let status_para = Paragraph::new(format!(" ● {}", app.connection_status))
        .style(
            Style::default()
                .fg(app.connection_color)
                .add_modifier(Modifier::BOLD),
        )
        .block(Block::default().borders(Borders::ALL));
    f.render_widget(status_para, header_chunk[1]);

    // 2. STATS (Glow Design)
    let stats_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(
            [
                Constraint::Percentage(33),
                Constraint::Percentage(33),
                Constraint::Percentage(33),
            ]
            .as_ref(),
        )
        .split(chunks[1]);

    let total_block = Paragraph::new(stat_text(app.stats.total))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" 🔍 INTERCEPTIONS "),
        )
        .style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );
    f.render_widget(total_block, stats_chunks[0]);

    let blocks_block = Paragraph::new(stat_text(app.stats.denied))
        .block(Block::default().borders(Borders::ALL).title(" ⛔ BLOCKED "))
        .style(
            Style::default()
                .fg(Color::Rgb(255, 100, 100))
                .add_modifier(Modifier::BOLD),
        );
    f.render_widget(blocks_block, stats_chunks[1]);

    let allowed_block = Paragraph::new(stat_text(app.stats.allowed))
        .block(Block::default().borders(Borders::ALL).title(" ✅ ALLOWED "))
        .style(
            Style::default()
                .fg(Color::Rgb(100, 255, 100))
                .add_modifier(Modifier::BOLD),
        );
    f.render_widget(allowed_block, stats_chunks[2]);

    // 3. MAIN CONTENT (Logs + Governance Side-by-Side)
    let content_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(
            [
                Constraint::Percentage(65), // Audit Stream
                Constraint::Percentage(35), // Governance Queue
            ]
            .as_ref(),
        )
        .split(chunks[2]);

    // Logs List (Clean)
    let log_items: Vec<ListItem> = app
        .logs
        .iter()
        .take(50)
        .map(|log| {
            let (content, color) = format_log_line(log);
            ListItem::new(content).style(Style::default().fg(color))
        })
        .collect();

    let logs_list = List::new(log_items).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" 📡 LIVE AUDIT STREAM ")
            .title_style(Style::default().fg(Color::Yellow)),
    );
    f.render_widget(logs_list, content_chunks[0]);

    // Governance Queue (M-of-N)
    let gov_items: Vec<ListItem> = app
        .pending_actions
        .iter()
        .map(|action| {
            let content = format_pending_line(action);
            ListItem::new(content).style(Style::default().fg(Color::Rgb(255, 180, 100)))
        })
        .collect();

    let gov_list = List::new(gov_items).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" ⚖️ M-of-N GOVERNANCE ")
            .title_style(Style::default().fg(Color::Magenta)),
    );
    f.render_widget(gov_list, content_chunks[1]);

    // 4. FOOTER
    let footer_text = footer_text(&app.api_url);
    let footer = Paragraph::new(footer_text)
        .style(Style::default().fg(Color::DarkGray))
        .alignment(ratatui::layout::Alignment::Left);
    f.render_widget(footer, chunks[3]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(status: &str, ts: &str, score: Option<f32>) -> ApiLogEntry {
        ApiLogEntry {
            timestamp: ts.to_string(),
            tool_name: "bash".to_string(),
            status: status.to_string(),
            event: "run".to_string(),
            anomaly_score: score,
        }
    }

    #[test]
    fn short_time_extracts_hours_and_minutes() {
        assert_eq!(short_time("2026-01-02T12:34:56Z"), "12:34");
        assert_eq!(short_time("2026-01-02T12:34:56.789+00:00"), "12:34");
    }

    #[test]
    fn short_time_handles_missing_parts() {
        assert_eq!(short_time(""), "");
        assert_eq!(short_time("2026-01-02"), "");
        assert_eq!(short_time("2026-01-02T09"), "09");
    }

    #[test]
    fn neural_tag_thresholds() {
        assert_eq!(neural_tag(None), "");
        assert_eq!(neural_tag(Some(0.0)), " ✨ SAFE");
        assert_eq!(neural_tag(Some(1.2)), " ✨ SAFE");
        assert_eq!(neural_tag(Some(1.21)), " 🔥 RISKY");
    }

    #[test]
    fn status_style_denied_vs_other() {
        assert_eq!(status_style("DENIED"), (" ✖ ", Color::Rgb(255, 120, 120)));
        assert_eq!(status_style("ALLOWED"), (" ✔ ", Color::Rgb(120, 255, 120)));
        assert_eq!(status_style("denied").0, " ✔ ");
    }

    #[test]
    fn format_log_line_full() {
        let (text, color) = format_log_line(&log("DENIED", "2026-01-02T12:34:56Z", Some(2.0)));
        assert_eq!(text, " ✖  12:34 | bash            | run 🔥 RISKY");
        assert_eq!(color, Color::Rgb(255, 120, 120));
    }

    #[test]
    fn format_log_line_without_score_or_time() {
        let (text, color) = format_log_line(&log("ALLOWED", "bad", None));
        assert_eq!(text, " ✔   | bash            | run");
        assert_eq!(color, Color::Rgb(120, 255, 120));
    }

    #[test]
    fn format_log_line_does_not_truncate_long_tool_names() {
        let mut l = log("ALLOWED", "x", None);
        l.tool_name = "a_very_long_tool_name_here".to_string();
        assert!(format_log_line(&l)
            .0
            .contains("| a_very_long_tool_name_here |"));
    }

    #[test]
    fn format_pending_line_layout() {
        let action = ApiPendingAction {
            id: "p1".to_string(),
            agent_id: "agent-1".to_string(),
            tool_name: "deploy".to_string(),
            timestamp: "2026-01-02T00:00:00Z".to_string(),
            required_m: 2,
            signatures: vec![],
        };
        assert_eq!(
            format_pending_line(&action),
            " ⏳ deploy (2 Sigs Required)
    Agent: agent-1"
        );
    }

    #[test]
    fn stat_and_footer_text() {
        assert_eq!(
            stat_text(42),
            "
  42"
        );
        let f = footer_text("http://localhost:9090");
        assert!(f.starts_with(" Press 'q' to exit | API: http://localhost:9090 |"));
    }

    #[test]
    fn api_payloads_deserialize() {
        let logs: ApiLogsResponse = serde_json::from_str(
            r#"{"entries":[{"timestamp":"2026-01-02T12:34:56Z","tool_name":"t","status":"DENIED","event":"e","anomaly_score":null}]}"#,
        )
        .unwrap();
        assert_eq!(logs.entries.len(), 1);
        assert!(logs.entries[0].anomaly_score.is_none());
        let stats: ApiStatsResponse =
            serde_json::from_str(r#"{"stats":{"total":3,"allowed":2,"denied":1}}"#).unwrap();
        assert_eq!(
            (stats.stats.total, stats.stats.allowed, stats.stats.denied),
            (3, 2, 1)
        );
    }
}

#[cfg(test)]
mod startup_check_tests {
    use super::*;

    #[test]
    fn a_key_with_a_line_break_is_explained_not_unwrapped() {
        let msg = api_key_header("abc\ndef").expect_err("a line break cannot be a header value");
        assert!(msg.contains("--api-key"), "{msg}");
        assert!(msg.contains("ZN_API_KEY"), "{msg}");
    }

    #[test]
    fn an_empty_key_is_explained() {
        assert!(api_key_header("   ").is_err());
        assert!(api_key_header("good-key-123").is_ok());
    }

    #[test]
    fn a_rejected_key_says_what_to_do() {
        let msg = first_reply_problem(401, "http://localhost:9090").expect("401 is a problem");
        assert!(msg.contains("rejected the API key"), "{msg}");
        assert!(msg.contains("--api-key"), "{msg}");
        assert!(first_reply_problem(200, "http://localhost:9090").is_none());
        assert!(first_reply_problem(500, "http://localhost:9090").is_some());
    }

    #[test]
    fn an_unreachable_gateway_names_the_address_and_the_port_option() {
        let msg = unreachable_problem("http://localhost:9191");
        assert!(msg.contains("http://localhost:9191"), "{msg}");
        assert!(msg.contains("--port"), "{msg}");
    }

    #[tokio::test]
    async fn a_closed_port_ends_with_a_message_before_the_screen_is_taken() {
        // Port 1 is not served; the check must fail with text, never hang or panic.
        let err = TuiApp::run(Some("some-key".to_string()), Some(1))
            .await
            .expect_err("nothing listens on port 1");
        assert!(err.to_string().contains("could not reach"), "{err}");
    }
}
