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

impl TuiApp {
    pub async fn run(api_key: Option<String>) -> Result<()> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout);
        let mut terminal = Terminal::new(backend)?;

        // Resolve API Key (CLI > Env > Error)
        let resolved_key = match api_key {
            Some(key) => key,
            None => std::env::var("ZN_API_KEY").map_err(|_| {
                anyhow::anyhow!("No API key provided via CLI and ZN_API_KEY is not set.")
            })?,
        };

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("X-API-Key", resolved_key.parse().unwrap());

        let mut app = TuiApp {
            client: Client::builder()
                .default_headers(headers)
                .timeout(Duration::from_secs(1))
                .build()?,
            logs: Vec::new(),
            pending_actions: Vec::new(),
            stats: ApiStats::default(),
            last_update: Instant::now(),
            api_url: "http://localhost:9090".to_string(),
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

        disable_raw_mode()?;
        execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
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
                if let Ok(json) = res.json::<ApiStatsResponse>().await {
                    self.stats = json.stats;
                    self.connection_status = "CONNECTED".to_string();
                    self.connection_color = Color::Green;
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

    let total_block = Paragraph::new(format!("\n  {}", app.stats.total))
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

    let blocks_block = Paragraph::new(format!("\n  {}", app.stats.denied))
        .block(Block::default().borders(Borders::ALL).title(" ⛔ BLOCKED "))
        .style(
            Style::default()
                .fg(Color::Rgb(255, 100, 100))
                .add_modifier(Modifier::BOLD),
        );
    f.render_widget(blocks_block, stats_chunks[1]);

    let allowed_block = Paragraph::new(format!("\n  {}", app.stats.allowed))
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
