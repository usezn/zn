//! Key names the Node scrubber redacts must be redacted here too. Both test
//! suites read the same list: packages/zn-gate/test/fixtures/scrub_key_names_parity.json.

use zn::scrubber::Scrubber;

#[test]
fn redacts_every_shared_key_name() {
    let raw = include_str!("../packages/zn-gate/test/fixtures/scrub_key_names_parity.json");
    let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
    let value = fixture["value"].as_str().unwrap();
    let names = fixture["redacted_names"].as_array().unwrap();
    assert!(names.len() >= 20);
    for name in names {
        let name = name.as_str().unwrap();
        for input in [format!("{name}={value}"), format!("{name}: {value}")] {
            let out = Scrubber::scrub(&input);
            assert!(!out.contains(value), "not redacted: {input}");
            assert!(out.contains("[SECRET_REDACTED]"), "no marker: {input}");
        }
    }
}

#[test]
fn leaves_longer_words_alone() {
    let value = "Zk9fQ2xT7vLm4RwPa83dNb";
    for input in [
        format!("secretary={value}"),
        format!("passport={value}"),
        format!("credentialed={value}"),
    ] {
        assert_eq!(Scrubber::scrub(&input), input);
    }
}
