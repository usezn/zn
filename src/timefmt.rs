//! UTC timestamps as RFC 3339 text.
//!
//! The text is the same as the one the gateway wrote before it used the `time` crate: the fractional
//! seconds are left out when they are zero, otherwise they have 3, 6 or 9 digits (the shortest that
//! loses nothing). `rfc3339_now` ends in `+00:00` (audit rows and tenant records); the serde helpers end
//! in `Z` (JSON of consensus and reputation records).

use serde::{Deserialize, Deserializer, Serializer};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

fn format(t: OffsetDateTime, suffix: &str) -> String {
    let t = t.to_offset(UtcOffset::UTC);
    let n = t.nanosecond();
    let frac = if n == 0 {
        String::new()
    } else if n.is_multiple_of(1_000_000) {
        format!(".{:03}", n / 1_000_000)
    } else if n.is_multiple_of(1_000) {
        format!(".{:06}", n / 1_000)
    } else {
        format!(".{n:09}")
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{frac}{suffix}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

/// The current time as `2026-01-01T00:00:00.123456+00:00`.
pub fn rfc3339_now() -> String {
    format(OffsetDateTime::now_utc(), "+00:00")
}

/// The same text for a given time.
pub fn rfc3339(t: OffsetDateTime) -> String {
    format(t, "+00:00")
}

fn parse_utc<E: serde::de::Error>(text: &str) -> Result<OffsetDateTime, E> {
    OffsetDateTime::parse(text, &Rfc3339)
        .map(|t| t.to_offset(UtcOffset::UTC))
        .map_err(E::custom)
}

/// Serde helper for an `OffsetDateTime` field: `#[serde(with = "crate::timefmt::serde_utc")]`.
pub mod serde_utc {
    use super::*;

    pub fn serialize<S: Serializer>(t: &OffsetDateTime, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format(*t, "Z"))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<OffsetDateTime, D::Error> {
        parse_utc(&String::deserialize(d)?)
    }

    /// For an `Option<OffsetDateTime>` field; add `default` so a missing field is `None`.
    pub mod option {
        use super::*;

        pub fn serialize<S: Serializer>(
            t: &Option<OffsetDateTime>,
            s: S,
        ) -> Result<S::Ok, S::Error> {
            match t {
                Some(t) => super::serialize(t, s),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(
            d: D,
        ) -> Result<Option<OffsetDateTime>, D::Error> {
            Option::<String>::deserialize(d)?
                .map(|text| parse_utc::<D::Error>(&text))
                .transpose()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct Rec {
        #[serde(with = "serde_utc")]
        at: OffsetDateTime,
        #[serde(with = "serde_utc::option", default)]
        until: Option<OffsetDateTime>,
    }

    fn at(unix_nanos: i128) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp_nanos(unix_nanos).unwrap()
    }

    const BASE: i128 = 1_767_225_600 * 1_000_000_000; // 2026-01-01T00:00:00Z

    #[test]
    fn fraction_has_zero_three_six_or_nine_digits() {
        assert_eq!(rfc3339(at(BASE)), "2026-01-01T00:00:00+00:00");
        assert_eq!(
            rfc3339(at(BASE + 120_000_000)),
            "2026-01-01T00:00:00.120+00:00"
        );
        assert_eq!(
            rfc3339(at(BASE + 123_456_000)),
            "2026-01-01T00:00:00.123456+00:00"
        );
        assert_eq!(
            rfc3339(at(BASE + 123_456_789)),
            "2026-01-01T00:00:00.123456789+00:00"
        );
        assert_eq!(rfc3339(at(BASE + 1)), "2026-01-01T00:00:00.000000001+00:00");
    }

    #[test]
    fn serde_text_ends_in_z_and_round_trips() {
        let rec = Rec {
            at: at(BASE + 5_000_000),
            until: Some(at(BASE)),
        };
        let json = serde_json::to_string(&rec).unwrap();
        assert_eq!(
            json,
            r#"{"at":"2026-01-01T00:00:00.005Z","until":"2026-01-01T00:00:00Z"}"#
        );
        assert_eq!(serde_json::from_str::<Rec>(&json).unwrap(), rec);
        let none: Rec = serde_json::from_str(r#"{"at":"2026-01-01T02:00:00+02:00"}"#).unwrap();
        assert_eq!(
            none,
            Rec {
                at: at(BASE),
                until: None
            }
        );
        assert_eq!(
            serde_json::to_string(&none).unwrap(),
            r#"{"at":"2026-01-01T00:00:00Z","until":null}"#
        );
    }

    #[test]
    fn now_is_valid_rfc3339() {
        let s = rfc3339_now();
        assert!(s.ends_with("+00:00"), "{s}");
        assert!(OffsetDateTime::parse(&s, &Rfc3339).is_ok(), "{s}");
    }
}
