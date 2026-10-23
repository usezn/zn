//! Values split by invisible characters or by wrapped line breaks are redacted, as in the
//! Node.js scrubber (`invisibleView`). Fictitious values only.

use super::invisible::view;
use super::Scrubber;

const ZW: &str = "\u{200B}";

fn scrub(s: &str) -> String {
    Scrubber::scrub(s)
}

#[test]
fn secret_split_by_zero_width_characters_is_redacted() {
    let input = format!("run with api_key=ABCD{ZW}EFGH{ZW}12345678 now");
    assert_eq!(scrub(&input), "run with api_key: [SECRET_REDACTED] now");
    let input = format!("password=hunter{ZW}2hunter2 ok");
    assert_eq!(scrub(&input), "password: [SECRET_REDACTED] ok");
    // Soft hyphen, word joiner, BOM, variation selector and a tag character.
    for c in ["\u{00AD}", "\u{2060}", "\u{FEFF}", "\u{FE0F}", "\u{E0041}"] {
        let input = format!("token=abcd{c}efgh1234");
        assert_eq!(scrub(&input), "token: [SECRET_REDACTED]", "{c:?}");
    }
}

#[test]
fn pii_split_by_zero_width_characters_is_redacted() {
    let input = format!("mail user@exam{ZW}ple.com please");
    assert_eq!(scrub(&input), "mail [EMAIL_REDACTED] please");
    let input = format!("card 4111{ZW} 1111 1111{ZW}1111 end");
    assert_eq!(scrub(&input), "card [CARD_REDACTED] end");
    let input = format!("iban GB82WE{ZW}ST12345698765432 end");
    assert_eq!(scrub(&input), "iban [IBAN_REDACTED] end");
    let input = format!("dni 1234{ZW}5678Z end");
    assert_eq!(scrub(&input), "dni [DNI_REDACTED] end");
}

#[test]
fn secret_split_by_a_wrapped_line_break_is_redacted() {
    for sep in ["\n", "\r\n", " \n  ", "\t\r\n\t"] {
        let input = format!("token=aaaaaaaaaaaa{sep}bbbbbbbbbbbb done");
        assert_eq!(scrub(&input), "token: [SECRET_REDACTED] done", "{sep:?}");
    }
}

#[test]
fn pii_split_by_a_wrapped_line_break_is_redacted() {
    assert_eq!(
        scrub("iban GB82WEST12\n345698765432 end"),
        "iban [IBAN_REDACTED] end"
    );
    assert_eq!(
        scrub("mail longlonglocal@exa\nmple.com"),
        "mail longlonglocal@exa\nmple.com",
        "fewer than ten token characters before the break: not a wrapped line"
    );
    assert_eq!(
        scrub("mail longlonglocal@example.co\nmlonglonglong end"),
        "mail [EMAIL_REDACTED]
mlonglonglong end"
    );
}

#[test]
fn zero_width_and_wrap_together() {
    let input = format!("api_key=abcdefgh{ZW}ijklmnopqrst\nuvwxyzabcdef end");
    assert_eq!(scrub(&input), "api_key: [SECRET_REDACTED] end");
}

#[test]
fn line_breaks_that_do_not_wrap_a_token_are_kept() {
    for input in [
        "short\nlines\nstay",
        "aaaaaaaaaaaa\n\nbbbbbbbbbbbb",
        "aaaaaaaaaaaa\nname = bbbbbbbbbbbb",
        "aaaaaaaaaaaa\nkey: bbbbbbbbbbbb",
        "line one is plain text\nline two is plain text",
    ] {
        assert_eq!(scrub(input), input, "{input:?}");
    }
}

#[test]
fn text_without_such_characters_has_no_view() {
    for input in ["", "plain text", "one\nline break", "ünïcode text ✓\nok"] {
        assert!(view(input).is_none(), "{input:?}");
    }
    assert_eq!(scrub("mail a@example.com"), "mail [EMAIL_REDACTED]");
}

#[test]
fn view_maps_back_to_the_original() {
    let text = format!("ab{ZW}cd\u{00AD}ef");
    let v = view(&text).unwrap();
    assert_eq!(v.clean, "abcdef");
    // "bcd" is bytes 1..4 of the view: original bytes 1 up to and including "d".
    let (s, e) = v.original_span(1, 4);
    assert_eq!(&text[s..e], format!("b{ZW}cd"));
    let v = view("aaaaaaaaaa \r\n bbbbbbbbbb").unwrap();
    assert_eq!(v.clean, "aaaaaaaaaabbbbbbbbbb");
    assert_eq!(v.original_span(0, v.clean.len()), (0, 24));
}

#[test]
fn multibyte_text_around_removed_characters_does_not_panic() {
    let input =
        format!("é{ZW}ü api_key=ABCD{ZW}EFGH1234 ✓{ZW}€\n日本{ZW}語 \u{1F600}{ZW}\u{1F600}");
    assert_eq!(
        scrub(&input),
        "é\u{200B}ü api_key: [SECRET_REDACTED] ✓\u{200B}€\n日本\u{200B}語 \u{1F600}\u{200B}\u{1F600}"
    );
    let input = format!("{ZW}{ZW}user@exam{ZW}ple.com{ZW}é");
    assert_eq!(scrub(&input), format!("{ZW}{ZW}[EMAIL_REDACTED]{ZW}é"));
    for input in [
        "\u{200B}",
        "é\u{200B}",
        "\u{200B}é\n",
        "\n\u{FEFF}\n",
        "a\u{E0100}\u{E0101}",
    ] {
        let _ = scrub(input);
    }
}

#[test]
fn scrubbing_twice_changes_nothing() {
    for input in [
        format!("api_key=ABCD{ZW}EFGH{ZW}12345678 and user@exam{ZW}ple.com"),
        "token=aaaaaaaaaaaa\nbbbbbbbbbbbb and GB82WEST12\n345698765432".to_string(),
        format!("card 4111{ZW} 1111 1111{ZW}1111 api_key=abcdefgh{ZW}ijklmnopqrst\nuvwxyzabcdef"),
        format!("a{ZW}b token=\"abcdefgh{ZW}ijkl\" +1415555{ZW}2671"),
    ] {
        let once = scrub(&input);
        assert_eq!(scrub(&once), once, "{input:?}");
        assert!(!once.contains("ABCD"), "{once:?}");
    }
}

#[test]
fn large_adversarial_text_is_scrubbed_in_bounded_time() {
    let mut text = String::new();
    while text.len() < (1 << 20) {
        text.push_str("aaaaaaaaaaaa \n \t");
        text.push_str(ZW);
        text.push_str("bbbbbbbbbbbb \r\n");
    }
    let start = std::time::Instant::now();
    let _ = scrub(&text);
    // Release builds take ~150 ms; this guards against a quadratic scan, not the exact time.
    assert!(start.elapsed().as_secs() < 60, "{:?}", start.elapsed());
}
