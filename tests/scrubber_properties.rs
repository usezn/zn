//! Property tests for the secret and PII scrubber (`zn::scrubber::Scrubber::scrub`).
//!
//! They mirror the properties of the Python (`test_scrubber_properties.py`, hypothesis) and Node.js
//! (`scrub_secret_properties.test.js`, fast-check) suites: a generated fake secret embedded in
//! prose, JSON, a `.env` file or a URL is replaced while the text around it is kept; scrubbing is
//! idempotent; the output stays within a size bound; text with nothing secret-like in it comes back
//! unchanged.
//!
//! Every value is fake. Secret bodies are random letters and digits that start with an uppercase
//! letter and a digit, so they are never a placeholder; surrounding words are lowercase letters
//! only; emails use `example.com`; card numbers are the public test numbers of the card networks.
//! The generator is seeded, so a run is repeatable, and the case count is capped to keep the file
//! fast. Failure persistence is off, so a failing run leaves no file in the repository.

use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
use zn::scrubber::Scrubber;

const CASES: u32 = 200;

/// A seeded runner: the same cases on every run (the equivalent of `derandomize=True` in the
/// Python suite and the fixed `SEED` of the Node suite).
fn runner() -> TestRunner {
    TestRunner::new_with_rng(
        Config {
            cases: CASES,
            failure_persistence: None,
            ..Config::default()
        },
        TestRng::from_seed(RngAlgorithm::ChaCha, &[0x5a; 32]),
    )
}

fn check<S: Strategy>(strategy: S, test: impl Fn(S::Value) -> Result<(), TestCaseError>) {
    let mut runner = runner();
    if let Err(e) = runner.run(&strategy, test) {
        panic!("{e}");
    }
}

/// Benign words only, so the text around a secret can never contain one.
fn word() -> impl Strategy<Value = String> {
    "[a-z]{0,12}"
}

/// Names the scrubber treats as secret names (matched case-insensitively).
fn secret_name() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec![
        "api_key",
        "apikey",
        "api-key",
        "secret_key",
        "password",
        "token",
        "auth_token",
        "access_token",
        "API_KEY",
        "Password",
    ])
}

/// A fake secret body: random letters and digits, 8 to 32 characters, with an uppercase letter and
/// a digit first, so it is never a placeholder such as `xxxxxxxx` or `your_token_here`.
fn secret_body() -> impl Strategy<Value = String> {
    "[A-Z][0-9][A-Za-z0-9]{6,30}"
}

fn email() -> impl Strategy<Value = String> {
    "[a-z]{1,8}(\\.[a-z]{1,8})?@(mail\\.)?example\\.com"
}

/// Public test card numbers (Visa, Mastercard, Amex), plain and grouped.
fn card() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec![
        "4111111111111111",
        "4111 1111 1111 1111",
        "4111-1111-1111-1111",
        "5555555555554444",
        "5555 5555 5555 4444",
        "378282246310005",
    ])
}

/// Put `name`/`body` in one of four contexts: prose, a JSON member, a `.env` line, a URL query.
fn embed(ctx: u8, name: &str, body: &str, pre: &str, post: &str) -> String {
    match ctx % 4 {
        0 => format!("{pre} {name}={body} {post}"),
        1 => format!(r#"{{"note":"{pre}","{name}":"{body}","tail":"{post}"}}"#),
        2 => format!("# {pre}\n{name}={body}\nNOTE={post}\n"),
        _ => format!("https://example.invalid/cb?state={pre}&{name}={body}&lang={post}"),
    }
}

/// (text, secret body, text before, text after)
fn planted_secret() -> impl Strategy<Value = (String, String, String, String)> {
    (0u8..4, secret_name(), secret_body(), word(), word()).prop_map(
        |(ctx, name, body, pre, post)| {
            let text = embed(ctx, name, &body, &pre, &post);
            (text, body, pre, post)
        },
    )
}

/// A piece of a document: plain words, a planted secret, an email, a card number, or any text.
fn fragment() -> impl Strategy<Value = String> {
    prop_oneof![
        word().boxed(),
        planted_secret().prop_map(|(text, ..)| text).boxed(),
        email().boxed(),
        card().prop_map(str::to_string).boxed(),
        "\\PC{0,24}".boxed(),
    ]
}

fn document() -> impl Strategy<Value = String> {
    (
        prop::collection::vec(fragment(), 0..8),
        prop::sample::select(vec![" ", "\n", ", ", " | "]),
    )
        .prop_map(|(parts, sep)| parts.join(sep))
}

#[test]
fn a_planted_secret_is_redacted_and_its_context_kept() {
    check(planted_secret(), |(text, body, pre, post)| {
        let out = Scrubber::scrub(&text);
        prop_assert!(
            !out.contains(&body),
            "secret survived: {out:?} (from {text:?})"
        );
        prop_assert!(
            out.contains("[SECRET_REDACTED]"),
            "no marker in {out:?} (from {text:?})"
        );
        prop_assert!(
            out.contains(&pre),
            "text before the secret changed: {out:?}"
        );
        prop_assert!(
            out.contains(&post),
            "text after the secret changed: {out:?}"
        );
        Ok(())
    });
}

#[test]
fn several_planted_secrets_in_one_text_are_all_redacted() {
    check(prop::collection::vec(planted_secret(), 2..5), |planted| {
        let text = planted
            .iter()
            .map(|(t, ..)| t.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let out = Scrubber::scrub(&text);
        for (_, body, ..) in &planted {
            prop_assert!(
                !out.contains(body),
                "secret survived: {out:?} (from {text:?})"
            );
        }
        Ok(())
    });
}

#[test]
fn a_fake_email_is_redacted() {
    check((word(), email(), word()), |(pre, addr, post)| {
        let text = format!("{pre} {addr} {post}");
        let out = Scrubber::scrub(&text);
        prop_assert!(!out.contains(&addr), "email survived: {out:?}");
        prop_assert!(out.contains("[EMAIL_REDACTED]"), "{out:?}");
        prop_assert_eq!(out, format!("{pre} [EMAIL_REDACTED] {post}"));
        Ok(())
    });
}

#[test]
fn a_test_card_number_is_redacted() {
    check((word(), card(), word()), |(pre, number, post)| {
        let text = format!("{pre} {number} {post}");
        let out = Scrubber::scrub(&text);
        prop_assert!(!out.contains(number), "card number survived: {out:?}");
        prop_assert!(out.contains("[CARD_REDACTED]"), "{out:?}");
        Ok(())
    });
}

#[test]
fn scrubbing_is_idempotent_on_documents() {
    check(document(), |text| {
        let once = Scrubber::scrub(&text);
        let twice = Scrubber::scrub(&once);
        prop_assert_eq!(
            &twice,
            &once,
            "second pass changed the text (input {:?})",
            text
        );
        Ok(())
    });
}

#[test]
fn scrubbing_is_idempotent_on_any_text() {
    check("\\PC{0,120}", |text| {
        let once = Scrubber::scrub(&text);
        let twice = Scrubber::scrub(&once);
        prop_assert_eq!(
            &twice,
            &once,
            "second pass changed the text (input {:?})",
            text
        );
        Ok(())
    });
}

#[test]
fn the_output_length_stays_within_a_bound() {
    // The longest replacement marker is 17 bytes for a match of at least 6 bytes (the shortest
    // email, `a@b.cc`), so the output is under 3 times the input, plus a small constant.
    check(document(), |text| {
        let out = Scrubber::scrub(&text);
        prop_assert!(
            out.len() <= 3 * text.len() + 16,
            "{} bytes became {} bytes (input {:?})",
            text.len(),
            out.len(),
            text
        );
        Ok(())
    });
}

#[test]
fn text_with_nothing_secret_like_is_returned_unchanged() {
    // Lowercase words, short numbers (1 to 3 digits, so no card, SSN or phone shape), and
    // punctuation. No `@`, `+`, `:` or `=`.
    let benign = "([a-z]{1,10}|[0-9]{1,3}|[.,;!?])( [a-z]{1,10}| [0-9]{1,3}|[.,;!?]){0,20}";
    check(benign, |text| {
        prop_assert_eq!(Scrubber::scrub(&text), text);
        Ok(())
    });
}

#[test]
fn secret_names_with_placeholder_values_are_left_alone() {
    let placeholders = prop::sample::select(vec![
        "${API_TOKEN}",
        "$API_TOKEN",
        "<your-api-key>",
        "********",
        "xxxxxxxx",
        "process.env.TOKEN",
        "your_token_here",
    ]);
    check(
        (secret_name(), placeholders, word()),
        |(name, value, post)| {
            let text = format!("{name}={value} {post}");
            prop_assert_eq!(Scrubber::scrub(&text), text);
            Ok(())
        },
    );
}
