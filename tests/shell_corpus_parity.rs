//! The gateway judges shell commands the way zn-gate does: every case of the shared destructive-command corpus
//! (`packages/zn-gate/test/fixtures/destructive_commands.json`) gets the verdict the Node.js rules give. Commands are
//! only passed as text to the judging functions; nothing here runs one.

use serde_json::{json, Value};
use zn::config::ManagedRulesConfig;
use zn::engine::rules::ManagedRuleset;

fn corpus() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/packages/zn-gate/test/fixtures/destructive_commands.json"
    );
    let raw = std::fs::read_to_string(path).expect("shared corpus is readable");
    serde_json::from_str(&raw).expect("shared corpus is JSON")
}

/// The gateway's verdict on a command sent as a tool call: `{"command": "<cmd>"}` to `exec_command`.
fn blocked(cmd: &str) -> bool {
    let args = json!({ "command": cmd }).to_string();
    ManagedRuleset::evaluate(&ManagedRulesConfig::default(), "exec_command", &args).is_err()
}

#[test]
fn gateway_verdicts_equal_the_zn_gate_corpus() {
    let data = corpus();
    let benign = data["benign"].as_array().expect("benign list");
    let risky = data["risky"].as_array().expect("risky list");

    let mut missed: Vec<String> = Vec::new();
    let mut wrong_family: Vec<String> = Vec::new();
    for case in risky {
        let cmd = case["cmd"].as_str().expect("cmd");
        let rule = case["rule"].as_str().expect("rule");
        if !blocked(cmd) {
            missed.push(format!("{rule}: {cmd}"));
        } else if zn::shell_guard::judge(cmd) != Some(rule) {
            wrong_family.push(format!(
                "{rule} != {:?}: {cmd}",
                zn::shell_guard::judge(cmd)
            ));
        }
    }
    let mut over_blocked: Vec<String> = Vec::new();
    for cmd in benign {
        let cmd = cmd.as_str().expect("benign cmd");
        if blocked(cmd) {
            over_blocked.push(format!("{cmd}  [{:?}]", zn::shell_guard::judge(cmd)));
        }
    }

    eprintln!(
        "PARITY risky blocked {}/{} | benign blocked {}/{} | other family {}",
        risky.len() - missed.len(),
        risky.len(),
        over_blocked.len(),
        benign.len(),
        wrong_family.len()
    );
    for m in missed
        .iter()
        .chain(over_blocked.iter())
        .chain(wrong_family.iter())
        .take(80)
    {
        eprintln!("PARITY-DIFF {m}");
    }
    assert!(missed.is_empty(), "{} risky commands pass", missed.len());
    assert!(
        over_blocked.is_empty(),
        "{} benign commands are blocked",
        over_blocked.len()
    );
    assert!(
        wrong_family.is_empty(),
        "{} risky commands match another family than the corpus says",
        wrong_family.len()
    );
}

#[test]
fn the_corpus_is_the_size_this_test_was_written_for() {
    let data = corpus();
    // A corpus that shrinks to nothing would make the parity test pass for the wrong reason.
    assert!(data["benign"].as_array().is_some_and(|a| a.len() > 1000));
    assert!(data["risky"].as_array().is_some_and(|a| a.len() > 600));
}
