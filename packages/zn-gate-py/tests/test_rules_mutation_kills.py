"""Boundary tests for the Python rules engine, written to kill mutants that the
older rule tests let survive: the personal-data validators (IBAN, card, DNI/NIE,
SSN), the per-provider token length and randomness checks, and the Windows cmd
caret and percent readers.

Everything here is fake and built at runtime. Nothing in this file changes what
rules.py does; every expectation is an independent restatement of the public
format rule (ISO 13616 IBAN, Luhn, card network ranges, the DNI letter table).
"""

import re
import unittest

from zn_gate import rules as R

DIGITS = "0123456789"
LOWER26 = "qazwsxedcrfvtgbyhnujmikolp"
ALNUM = "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0Ks"
HEX = "3a7f0c95e1b2d846"
LOWDIG = "qa7zt3lm9pw2ny5rb8vx1cd4fg6hj0ks"
UPDIG = "QZ7K3LM9PW2NY5RB"
B64 = ALNUM + "+/"
URL = ALNUM + "-_"


def cyc(n, alphabet=ALNUM):
    return "".join(alphabet[i % len(alphabet)] for i in range(n))


def rules_hit(text):
    return {d["rule"] for d in R.redact_secrets(text)[1]}


# ---------------------------------------------------------------------------
# Luhn and cards
# ---------------------------------------------------------------------------

def luhn_digit(partial):
    """Check digit that makes partial + digit pass Luhn (independent of rules.py)."""
    total = 0
    for i, ch in enumerate(reversed(partial)):
        d = int(ch)
        if i % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return str((10 - total % 10) % 10)


def make_card(prefix, n):
    body = prefix
    fill = "7352918406"
    i = 0
    while len(body) < n - 1:
        body += fill[i % len(fill)]
        i += 1
    return body + luhn_digit(body)


class LuhnTests(unittest.TestCase):
    def test_known_numbers(self):
        self.assertTrue(R._luhn_ok("79927398713"))
        self.assertFalse(R._luhn_ok("79927398710"))
        self.assertTrue(R._luhn_ok("0"))
        self.assertFalse(R._luhn_ok("1"))

    def test_non_digit_rejected(self):
        self.assertFalse(R._luhn_ok("7992739871a"))
        self.assertFalse(R._luhn_ok("7992 7398 713"))

    def test_every_single_digit_change_is_caught(self):
        good = make_card("4", 16)
        self.assertTrue(R._luhn_ok(good))
        for pos in range(len(good)):
            for delta in (1, 2, 5, 9):
                d = (int(good[pos]) + delta) % 10
                bad = good[:pos] + str(d) + good[pos + 1:]
                self.assertFalse(R._luhn_ok(bad), (pos, delta))

    def test_cut_exact(self):
        self.assertTrue(R._luhn_ok("42"))     # dbl(4)=8, 8+2=10
        self.assertFalse(R._luhn_ok("43"))
        self.assertTrue(R._luhn_ok("59"))     # dbl(5)=10->1, 1+9=10
        self.assertFalse(R._luhn_ok("58"))
        self.assertTrue(R._luhn_ok("00"))
        self.assertTrue(R._luhn_ok("91"))     # dbl(9)=18->9, 9+1=10


NETWORK_CASES = [
    # (prefix, valid lengths, label)
    ("4", (13, 16, 19), "visa"),
    ("51", (16,), "mc51"),
    ("55", (16,), "mc55"),
    ("222100", (16,), "mc2221"),
    ("272099", (16,), "mc2720"),
    ("34", (15,), "amex34"),
    ("37", (15,), "amex37"),
    ("6011", (16, 17, 18, 19), "disc6011"),
    ("65", (16, 17, 18, 19), "disc65"),
    ("644", (16, 17, 18, 19), "disc644"),
    ("649", (16, 17, 18, 19), "disc649"),
    ("3528", (16, 17, 18, 19), "jcb3528"),
    ("3589", (16, 17, 18, 19), "jcb3589"),
    ("36", (14, 15, 16, 17, 18, 19), "diners36"),
    ("38", (14, 15, 16, 17, 18, 19), "diners38"),
    ("39", (14, 15, 16, 17, 18, 19), "diners39"),
    ("300", (14, 15, 16, 17, 18, 19), "diners300"),
    ("305", (14, 15, 16, 17, 18, 19), "diners305"),
    ("62", (16, 17, 18, 19), "unionpay"),
]

OUTSIDE = ["500000", "560000", "222099", "272100", "330000", "350000", "601000", "601200", "643000",
           "352700", "359000", "306000", "610000", "630000", "700000", "900000", "100000", "200000", "800000"]


class CardNetworkTests(unittest.TestCase):
    def test_each_network_accepts_exactly_its_lengths(self):
        for prefix, lengths, label in NETWORK_CASES:
            for n in range(13, 20):
                card = make_card(prefix, n)
                self.assertTrue(R._luhn_ok(card))
                self.assertEqual(R._card_ok(card), n in lengths, (label, n))

    def test_prefix_just_outside_every_range_is_rejected(self):
        for prefix in OUTSIDE:
            for n in range(13, 20):
                self.assertFalse(R._card_ok(make_card(prefix, n)), (prefix, n))

    def test_range_edges_exact(self):
        for bad in ("222099", "272100", "3527", "3590", "643", "56", "50", "306"):
            self.assertFalse(R._card_ok(make_card(bad, 16)), bad)
        for good in ("222100", "272099", "222101", "272098", "250000", "3528", "3589", "3560", "644", "645",
                     "649", "650", "301", "304", "300", "305"):
            self.assertTrue(R._card_ok(make_card(good, 16)), good)

    def test_bad_checksum_is_rejected_for_every_network(self):
        for prefix, lengths, label in NETWORK_CASES:
            n = lengths[0]
            card = make_card(prefix, n)
            bad = card[:-1] + str((int(card[-1]) + 1) % 10)
            self.assertFalse(R._card_ok(bad), label)

    def test_length_window_and_separators(self):
        self.assertFalse(R._card_ok("4" + "1" * 11))   # 12 digits
        self.assertTrue(R._card_ok(make_card("4", 13)))
        self.assertTrue(R._card_ok(make_card("4", 19)))
        self.assertFalse(R._card_ok(make_card("4", 20)))
        card = make_card("4", 16)
        spaced = " ".join(card[i:i + 4] for i in range(0, 16, 4))
        dashed = "-".join(card[i:i + 4] for i in range(0, 16, 4))
        self.assertTrue(R._card_ok(spaced))
        self.assertTrue(R._card_ok(dashed))
        self.assertTrue(R._card_span_ok(spaced))
        self.assertTrue(R._card_span_ok(dashed))
        mixed = card[0:4] + " " + card[4:8] + "-" + card[8:12] + " " + card[12:]
        self.assertTrue(R._card_ok(mixed))
        self.assertFalse(R._card_span_ok(mixed))

    def test_repeated_digit_is_not_a_card(self):
        for d in "0123456789":
            self.assertFalse(R._card_ok(d * 16))
        self.assertFalse(R._card_ok("4" * 16))
        self.assertFalse(R._card_ok("4" * 13))

    def test_found_in_text(self):
        card = make_card("4", 16)
        spaced = " ".join(card[i:i + 4] for i in range(0, 16, 4))
        text = "pay with " + spaced + " today"
        spans = R.find_pii_spans(text)
        self.assertEqual(len(spans), 1)
        s, e, kind = spans[0]
        self.assertEqual((text[s:e], kind), (spaced, "CARD"))
        self.assertNotIn(spaced, R.mask_pii_preview(text))
        bad = card[:-1] + str((int(card[-1]) + 3) % 10)
        self.assertEqual(R.find_pii_spans("pay with " + bad), [])


# ---------------------------------------------------------------------------
# IBAN
# ---------------------------------------------------------------------------

def iban_check_digits(country, bban):
    moved = bban + country + "00"
    num = "".join(str(int(c, 36)) if c.isalpha() else c for c in moved)
    return "%02d" % (98 - int(num) % 97)


def make_iban(country, n):
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    bban = "".join(alphabet[(i * 7 + 3) % 36] for i in range(n - 4))
    return country + iban_check_digits(country, bban) + bban


class IbanTests(unittest.TestCase):
    def test_documented_examples(self):
        for v in ("DE89370400440532013000", "GB82WEST12345698765432", "ES9121000418450200051332",
                  "FR1420041010050500013M02606", "NO9386011117947", "MT84MALT011000012345MTLCAST001S"):
            self.assertTrue(R._iban_ok(v), v)

    def test_every_country_length_in_the_table(self):
        for country, n in R._IBAN_LENGTHS.items():
            good = make_iban(country, n)
            self.assertEqual(len(good), n)
            self.assertTrue(R._iban_ok(good), country)
            self.assertFalse(R._iban_ok(make_iban(country, n + 1)), country)
            self.assertFalse(R._iban_ok(make_iban(country, n - 1)), country)

    def test_only_one_check_digit_pair_is_valid(self):
        for country, n in (("DE", 22), ("GB", 22), ("NO", 15), ("MT", 31), ("AD", 24), ("BE", 16)):
            good = make_iban(country, n)
            ok = [cd for cd in range(100)
                  if R._iban_ok("%s%02d%s" % (country, cd, good[4:]))]
            self.assertEqual(ok, [int(good[2:4])], country)

    def test_remainders_zero_and_two_are_rejected(self):
        good = make_iban("DE", 22)
        seen = set()
        for cd in range(100):
            cand = "DE%02d%s" % (cd, good[4:])
            num = "".join(str(int(c, 36)) for c in cand[4:] + cand[:4])
            seen.add(int(num) % 97)
            if int(num) % 97 in (0, 2):
                self.assertFalse(R._iban_ok(cand))
        self.assertIn(0, seen)
        self.assertIn(2, seen)

    def test_unknown_country_and_shapes(self):
        good = make_iban("DE", 22)
        self.assertFalse(R._iban_ok("ZZ" + good[2:]))
        self.assertFalse(R._iban_ok(""))
        self.assertFalse(R._iban_ok("DE"))
        self.assertFalse(R._iban_ok("DE" + "AB" + good[4:]))   # check digits must be digits
        self.assertFalse(R._iban_ok("D1" + good[2:]))

    def test_separators_and_case(self):
        good = "DE89370400440532013000"
        grouped = " ".join(good[i:i + 4] for i in range(0, 22, 4))
        self.assertTrue(R._iban_ok(grouped))
        self.assertTrue(R._iban_ok("-".join(good[i:i + 4] for i in range(0, 22, 4))))
        self.assertTrue(R._iban_ok(good.lower()))
        self.assertTrue(R._iban_ok("DE89\t3704\n0044 0532\r0130\f00"))
        self.assertFalse(R._iban_ok(good + " 0"))

    def test_found_in_text(self):
        good = "DE89370400440532013000"
        grouped = " ".join(good[i:i + 4] for i in range(0, 22, 4))
        text = "iban " + grouped + " end"
        spans = R.find_pii_spans(text)
        self.assertEqual(len(spans), 1)
        s, e, kind = spans[0]
        self.assertEqual(kind, "IBAN")
        self.assertEqual(text[s:e], grouped)
        bad = "DE88370400440532013000"
        self.assertEqual([k for _, _, k in R.find_pii_spans("iban " + bad)], [])
        self.assertIn("[REDACTED_IBAN]", R.mask_pii_preview(text))


# ---------------------------------------------------------------------------
# DNI, NIE, SSN
# ---------------------------------------------------------------------------

DNI_TABLE = "TRWAGMYFPDXBNJZSQVHLCKE"


class DniNieTests(unittest.TestCase):
    def test_all_23_letters(self):
        for n in range(0, 23):
            num = "%08d" % n
            good = num + DNI_TABLE[n]
            self.assertTrue(R._dni_ok(good), good)
            for wrong in DNI_TABLE:
                if wrong != DNI_TABLE[n]:
                    self.assertFalse(R._dni_ok(num + wrong), num + wrong)

    def test_modulus_is_23(self):
        for n in (23, 24, 46, 12345678, 99999999, 10000000, 87654321):
            self.assertTrue(R._dni_ok("%08d%s" % (n, DNI_TABLE[n % 23])), n)
            self.assertFalse(R._dni_ok("%08d%s" % (n, DNI_TABLE[(n + 1) % 23])), n)

    def test_shapes(self):
        self.assertTrue(R._dni_ok("12345678Z"))
        self.assertTrue(R._dni_ok("12345678-Z"))
        self.assertTrue(R._dni_ok("12345678z"))
        self.assertFalse(R._dni_ok("1234567Z"))
        self.assertFalse(R._dni_ok("123456789Z"))
        self.assertFalse(R._dni_ok("12345678"))
        self.assertFalse(R._dni_ok("12345678-"))

    def test_nie_prefix_values(self):
        for idx, p in enumerate("XYZ"):
            for rest in (0, 1, 1234567, 9999999, 5000000):
                n = idx * 10000000 + rest
                good = "%s%07d%s" % (p, rest, DNI_TABLE[n % 23])
                self.assertTrue(R._nie_ok(good), good)
                self.assertTrue(R._nie_ok(good.lower()), good)
                wrong = "%s%07d%s" % (p, rest, DNI_TABLE[(n + 1) % 23])
                self.assertFalse(R._nie_ok(wrong), wrong)
        # X, Y and Z give different letters for the same digits, so the prefix really counts.
        letters = {R._nie_ok("%s1234567%s" % (p, c)) and c for p in "XYZ" for c in DNI_TABLE}
        letters.discard(False)
        self.assertEqual(len(letters), 3)

    def test_nie_shapes(self):
        self.assertTrue(R._nie_ok("X1234567L"))
        self.assertTrue(R._nie_ok("X-1234567-L"))
        self.assertFalse(R._nie_ok("A1234567L"))
        self.assertFalse(R._nie_ok("W1234567L"))
        self.assertFalse(R._nie_ok("X123456L"))
        self.assertFalse(R._nie_ok("X12345678L"))
        self.assertFalse(R._nie_ok("X1234567"))

    def test_found_in_text(self):
        self.assertEqual([k for _, _, k in R.find_pii_spans("id 12345678Z ok")], ["DNI"])
        self.assertEqual([k for _, _, k in R.find_pii_spans("id 12345678A ok")], [])
        self.assertEqual([k for _, _, k in R.find_pii_spans("id X1234567L ok")], ["NIE"])
        self.assertEqual([k for _, _, k in R.find_pii_spans("id X1234567A ok")], [])
        self.assertIn("[REDACTED_DNI]", R.mask_pii_preview("id 12345678Z ok"))


class SsnTests(unittest.TestCase):
    def test_area_group_serial_edges(self):
        ok = R._ssn_ok
        self.assertTrue(ok("001-01-0001"))
        self.assertTrue(ok("665-01-0001"))
        self.assertTrue(ok("667-01-0001"))
        self.assertTrue(ok("899-99-9999"))
        self.assertFalse(ok("000-12-3456"))
        self.assertFalse(ok("666-12-3456"))
        self.assertFalse(ok("900-12-3456"))
        self.assertFalse(ok("999-12-3456"))
        self.assertFalse(ok("123-00-3456"))
        self.assertTrue(ok("123-01-3456"))
        self.assertFalse(ok("123-45-0000"))
        self.assertTrue(ok("123-45-0001"))
        self.assertFalse(ok("123456789"))
        self.assertFalse(ok("123-45-67890"))


# ---------------------------------------------------------------------------
# Provider tokens: length windows
# ---------------------------------------------------------------------------

# (rule id, prefix, alphabet, min body length, max body length or None for open-ended, suffix)
BOUNDS = [
    ("secret:gitlab_token", "glpat-", URL, 20, None, ""),
    ("secret:stripe_key", "sk_live_", ALNUM, 20, 247, ""),
    ("secret:stripe_key", "rk_test_", ALNUM, 20, 247, ""),
    ("secret:stripe_key", "sk_prod_", ALNUM, 20, 247, ""),
    ("secret:stripe_webhook_secret", "whsec_", B64, 32, None, ""),
    ("secret:google_api_key", "AIza", URL, 35, 35, ""),
    ("secret:google_oauth_secret", "GOCSPX-", URL, 28, 28, ""),
    ("secret:hf_token", "hf_", ALNUM, 34, 40, ""),
    ("secret:npm_token", "npm_", ALNUM, 36, 36, ""),
    ("secret:pypi_token", "pypi-AgE", URL, 50, None, ""),
    ("secret:twilio_key", "SK", HEX, 32, 32, ""),
    ("secret:mailgun_key", "key-", HEX, 32, 32, ""),
    ("secret:shopify_token", "shpat_", HEX, 32, 32, ""),
    ("secret:digitalocean_token", "dop_v1_", HEX, 64, 64, ""),
    ("secret:linear_key", "lin_api_", ALNUM, 40, 40, ""),
    ("secret:databricks_token", "dapi", HEX, 32, 32, ""),
    ("secret:vault_token", "hvs.", URL, 24, None, ""),
    ("secret:newrelic_key", "NRAK-", UPDIG, 27, 27, ""),
    ("secret:groq_key", "gsk_", ALNUM, 52, 52, ""),
    ("secret:xai_key", "xai-", ALNUM, 80, 80, ""),
    ("secret:dockerhub_pat", "dckr_pat_", URL, 20, None, ""),
    ("secret:tavily_key", "tvly-", URL, 20, None, ""),
    ("secret:firecrawl_key", "fc-", ALNUM, 20, None, ""),
    ("secret:polar_token", "polar_oat_", URL, 20, None, ""),
    ("secret:replicate_token", "r8_", ALNUM, 37, 37, ""),
    ("secret:supabase_pat", "sbp_", URL, 30, None, ""),
    ("secret:alibaba_key_id", "LTAI", ALNUM, 20, 20, ""),
    ("secret:artifactory_key", "AKCp", ALNUM, 69, 69, ""),
    ("secret:easypost_key", "EZAK", ALNUM, 54, 54, ""),
    ("secret:heroku_key_v2", "HRKU-AA", URL, 58, 58, ""),
    ("secret:perplexity_key", "pplx-", ALNUM, 48, 48, ""),
    ("secret:planetscale_token", "pscale_tkn_", URL, 32, 64, ""),
    ("secret:prefect_key", "pnu_", ALNUM, 36, 36, ""),
    ("secret:pulumi_token", "pul-", HEX, 40, 40, ""),
    ("secret:readme_key", "rdme_", LOWDIG, 70, 70, ""),
    ("secret:rubygems_key", "rubygems_", HEX, 48, 48, ""),
    ("secret:sentry_user_token", "sntryu_", HEX, 64, 64, ""),
    ("secret:shippo_key", "shippo_live_", HEX, 40, 40, ""),
    ("secret:openshift_token", "sha256~", URL, 43, 43, ""),
    ("secret:grafana_token", "glc_", ALNUM, 32, 400, ""),
    ("secret:onepassword_sa_token", "ops_eyJ", B64, 250, None, ""),
    ("secret:flyio_token", "fm2_", B64, 100, None, ""),
    ("secret:flyio_token", "fo1_", URL, 43, 43, ""),
    ("secret:age_secret_key", "AGE-SECRET-KEY-1", "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L", 58, 58, ""),
]


class ProviderLengthTests(unittest.TestCase):
    def check(self, rule, prefix, alphabet, lo, hi, suffix):
        top = lo if hi is None else hi
        self.assertIn(rule, rules_hit(prefix + cyc(lo, alphabet) + suffix), (rule, "min"))
        self.assertIn(rule, rules_hit(prefix + cyc(top, alphabet) + suffix), (rule, "max"))
        self.assertNotIn(rule, rules_hit(prefix + cyc(lo - 1, alphabet) + suffix), (rule, "min-1"))
        if hi is not None:
            self.assertNotIn(rule, rules_hit(prefix + cyc(hi + 1, alphabet) + suffix), (rule, "max+1"))
            mid = (lo + hi) // 2
            self.assertIn(rule, rules_hit(prefix + cyc(mid, alphabet) + suffix), (rule, "mid"))

    def test_every_provider_window(self):
        for spec in BOUNDS:
            with self.subTest(rule=spec[0], prefix=spec[1]):
                self.check(*spec)

    def test_token_start_boundary(self):
        for rule, prefix, alphabet, lo, hi, suffix in BOUNDS:
            tok = prefix + cyc(lo, alphabet) + suffix
            if rule in ("secret:twilio_key",):
                continue
            with self.subTest(rule=rule):
                self.assertNotIn(rule, rules_hit("a" + tok))
                self.assertNotIn(rule, rules_hit("7" + tok))
                self.assertIn(rule, rules_hit(" " + tok + " "))
                self.assertIn(rule, rules_hit("=" + tok + ";"))

    def test_hex_only_rules_reject_a_non_hex_digit_in_the_body(self):
        for rule, prefix, alphabet, lo, hi, suffix in BOUNDS:
            if alphabet != HEX:
                continue
            body = cyc(lo, alphabet)
            bad = body[:5] + "g" + body[6:]
            self.assertNotIn(rule, rules_hit(prefix + bad), rule)

    def test_variant_prefixes(self):
        variants = [
            ("secret:stripe_key", ["sk_live_", "sk_test_", "sk_prod_", "rk_live_", "rk_test_", "rk_prod_"], ALNUM, 24),
            ("secret:gitlab_token", ["glpat-", "gldt-", "glrt-", "glptt-", "glcbt-", "glft-", "glsoat-"], URL, 24),
            ("secret:shopify_token", ["shpat_", "shpca_", "shppa_", "shpss_"], HEX, 32),
            ("secret:digitalocean_token", ["dop_v1_", "doo_v1_", "dor_v1_"], HEX, 64),
            ("secret:easypost_key", ["EZAK", "EZTK"], ALNUM, 54),
            ("secret:newrelic_key", ["NRAK-", "NRII-"], UPDIG, 27),
            ("secret:dockerhub_pat", ["dckr_pat_", "dckr_oat_"], URL, 24),
            ("secret:polar_token", ["polar_oat_", "polar_pat_", "polar_at_u_", "polar_at_o_", "polar_rt_u_",
                                    "polar_rt_o_", "polar_ci_", "polar_cs_"], URL, 24),
            ("secret:planetscale_token", ["pscale_tkn_", "pscale_oauth_", "pscale_pw_"], URL, 40),
            ("secret:shippo_key", ["shippo_live_", "shippo_test_"], HEX, 40),
            ("secret:flyio_token", ["fm1a_", "fm1r_", "fm2_"], B64, 120),
            ("secret:vault_token", ["hvs.", "hvb."], URL, 30),
            ("secret:slack_token", ["xoxa-", "xoxb-", "xoxe-", "xoxp-", "xoxr-", "xoxs-"], None, 0),
        ]
        for rule, prefixes, alphabet, n in variants:
            for p in prefixes:
                if alphabet is None:
                    tok = p + "123456789-" + cyc(12, LOWDIG)
                else:
                    tok = p + cyc(n, alphabet)
                with self.subTest(rule=rule, prefix=p):
                    self.assertIn(rule, rules_hit(tok))
        for p in ("xoxc-", "xoxz-", "xoxx-", "xox-", "glxat-", "sk_live-", "sk_dev_", "pk_live_", "tk_live_",
                  "hvx.", "dap1", "AKID", "EZXK", "fm3_", "pscale_xyz_"):
            tok = p + cyc(60, ALNUM)
            self.assertEqual(rules_hit(tok) - {"secret:generic_secret_value", "secret:high_entropy"}, set(), p)


# ---------------------------------------------------------------------------
# Provider tokens: randomness and placeholder checks
# ---------------------------------------------------------------------------

# (rule, prefix, body length, classes the check needs)
RANDOM_CHECKS = [
    ("secret:stripe_key", "sk_live_", 24, 2),
    ("secret:gitlab_token", "glpat-", 24, 2),
    ("secret:dockerhub_pat", "dckr_pat_", 24, 2),
    ("secret:tavily_key", "tvly-", 24, 2),
    ("secret:firecrawl_key", "fc-", 24, 2),
    ("secret:polar_token", "polar_oat_", 24, 2),
    ("secret:replicate_token", "r8_", 37, 2),
    ("secret:supabase_pat", "sbp_", 32, 2),
    ("secret:hf_token", "hf_", 36, 3),
    ("secret:npm_token", "npm_", 36, 3),
]


class RandomnessTests(unittest.TestCase):
    def test_two_class_checks(self):
        for rule, prefix, n, classes in RANDOM_CHECKS:
            if classes != 2:
                continue
            with self.subTest(rule=rule):
                pos = prefix + ("7" + (LOWER26 * 3))[:n]
                self.assertIn(rule, rules_hit(pos))
                one_class = prefix + (LOWER26 * 3)[:n]
                self.assertNotIn(rule, rules_hit(one_class))
                flat = prefix + "7" + "a" * (n - 1)
                self.assertNotIn(rule, rules_hit(flat))
                low_entropy = prefix + ("a7" * n)[:n]
                self.assertNotIn(rule, rules_hit(low_entropy))

    def test_three_class_checks(self):
        for rule, prefix, n, classes in RANDOM_CHECKS:
            if classes != 3:
                continue
            with self.subTest(rule=rule):
                pos = prefix + ("7Q" + LOWER26 * 3)[:n]
                self.assertIn(rule, rules_hit(pos))
                two = prefix + ("7" + LOWER26 * 3)[:n]
                self.assertNotIn(rule, rules_hit(two))
                two_b = prefix + ("Q" + LOWER26 * 3)[:n]
                self.assertNotIn(rule, rules_hit(two_b))
                low_entropy = prefix + ("a7Q" * n)[:n]
                self.assertNotIn(rule, rules_hit(low_entropy))

    def test_digit_required_rules(self):
        for rule, prefix in (("secret:tavily_key", "tvly-"), ("secret:firecrawl_key", "fc-"),
                             ("secret:supabase_pat", "sbp_")):
            letters = prefix + (LOWER26.upper()[:12] + LOWER26)[:30]
            self.assertNotIn(rule, rules_hit(letters), rule)
            with_digit = prefix + "7" + (LOWER26.upper()[:12] + LOWER26)[:29]
            self.assertIn(rule, rules_hit(with_digit), rule)

    def test_the_prefix_is_not_part_of_the_random_body(self):
        # A body of one letter class must stay rejected even though the prefix holds symbols and
        # other classes: the check looks at the body only.
        for rule, prefix, n, classes in RANDOM_CHECKS:
            body = (LOWER26 * 4)[:n]
            self.assertNotIn(rule, rules_hit(prefix + body), rule)

    def test_the_first_body_character_counts(self):
        # The only digit sits in the first body position: a check that skips one character too many loses it.
        for rule, prefix, n, classes in RANDOM_CHECKS:
            if classes != 2:
                continue
            pos = prefix + ("7" + LOWER26 * 3)[:n]
            self.assertIn(rule, rules_hit(pos), rule)

    def test_placeholder_bodies_for_prefixed_rules(self):
        cases = [
            ("secret:alibaba_key_id", "LTAI", ALNUM, 20),
            ("secret:artifactory_key", "AKCp", ALNUM, 69),
            ("secret:easypost_key", "EZAK", ALNUM, 54),
            ("secret:heroku_key_v2", "HRKU-AA", URL, 58),
            ("secret:perplexity_key", "pplx-", ALNUM, 48),
            ("secret:planetscale_token", "pscale_tkn_", URL, 40),
            ("secret:prefect_key", "pnu_", ALNUM, 36),
            ("secret:pulumi_token", "pul-", HEX, 40),
            ("secret:readme_key", "rdme_", LOWDIG, 70),
            ("secret:rubygems_key", "rubygems_", HEX, 48),
            ("secret:sentry_user_token", "sntryu_", HEX, 64),
            ("secret:shippo_key", "shippo_live_", HEX, 40),
            ("secret:openshift_token", "sha256~", URL, 43),
        ]
        for rule, prefix, alphabet, n in cases:
            with self.subTest(rule=rule):
                body = cyc(n, alphabet)
                self.assertIn(rule, rules_hit(prefix + body))
                for start in ("0123456789", "1234567890", "abcdef", "ABCDEF", "qwerty", "QWERTY"):
                    ph = start + body[len(start):]
                    if re.fullmatch(r"[A-Za-z0-9_-]+", ph) and (alphabet != HEX or re.fullmatch(r"[0-9a-f]+", ph)):
                        if alphabet == LOWDIG and ph != ph.lower():
                            continue
                        self.assertNotIn(rule, rules_hit(prefix + ph), (rule, start))
                self.assertNotIn(rule, rules_hit(prefix + "a" * n))
                self.assertNotIn(rule, rules_hit(prefix + ("a7" * n)[:n]))
                self.assertNotIn(rule, rules_hit(prefix + "7" * n))

    def test_prefixed_body_needs_two_classes(self):
        # Eight different lowercase letters repeat to a body with one class: not random enough.
        for rule, prefix, n in (("secret:perplexity_key", "pplx-", 48), ("secret:prefect_key", "pnu_", 36),
                                ("secret:openshift_token", "sha256~", 43)):
            body = (LOWER26 * 3)[:n]
            self.assertNotIn(rule, rules_hit(prefix + body), rule)
            self.assertIn(rule, rules_hit(prefix + "7" + body[1:]), rule)

    def test_hf_letters_only_body(self):
        # 34 letters with no digit: accepted unless it reads as a CamelCase identifier.
        letters = "hf_" + "QzLmPwNyRbVxCdFgHjKsQtYuIoPa"[:28] + "mnbvcx"
        self.assertEqual(len(letters) - 3, 34)
        self.assertIn("secret:hf_token", rules_hit(letters))
        camel = "hf_" + "GetUserAccountTokenFromStoreNow"[:34].ljust(34, "x")
        self.assertNotIn("secret:hf_token", rules_hit(camel))
        self.assertNotIn("secret:hf_token", rules_hit("hf_" + "a" * 34))
        self.assertNotIn("secret:hf_token", rules_hit("hf_" + "qazwsxedcrfvtgbyhnujmikolpqazwsxed"[:34]))

    def test_aws_key_repeated_body(self):
        # redact_secrets reports an AWS key under the older rule id, so the provider check is called directly.
        check = R.PROVIDER_MATCH_CHECKS["secret:aws_key_id"]
        self.assertFalse(check("AKIA" + "A" * 16))
        self.assertFalse(check("ASIA" + "7" * 16))
        self.assertTrue(check("AKIA" + "A" * 15 + "B"))
        self.assertTrue(check("AKIA" + "B" + "A" * 15))
        self.assertTrue(check("AKIA" + "7" + "A" * 15))
        pattern = [p for rid, p, _ in R.PROVIDER_SECRET_PATTERNS if rid == "secret:aws_key_id"][0]
        for prefix in ("AKIA", "ASIA", "ABIA", "ACCA"):
            self.assertIsNotNone(pattern.search(prefix + UPDIG), prefix)
            self.assertIsNone(pattern.search(prefix + UPDIG + "Q"), prefix)
            self.assertIsNone(pattern.search(prefix + UPDIG[:15]), prefix)
        for prefix in ("AKID", "ASID", "AKIB", "XKIA"):
            self.assertIsNone(pattern.search(prefix + UPDIG), prefix)

    def test_twilio_auth_token_needs_digit_and_hex_letter(self):
        flt = R.PROVIDER_VALUE_FILTERS["secret:twilio_auth_token"]
        self.assertFalse(flt("3a7f0c95e1b2d8463a7f0c95e1b2d846", ""))
        self.assertTrue(flt("3" * 32, ""))
        self.assertTrue(flt("a" * 32, ""))
        self.assertTrue(flt("1234567890123456", ""))
        self.assertTrue(flt("abcdefabcdefabcd", ""))

    def test_azure_ad_client_secret_checks(self):
        body = "Ab7Q~" + cyc(34, URL.replace("-", "x").replace("_", "y"))
        tok = body
        self.assertIsNotNone(R.PROVIDER_MATCH_CHECKS["secret:azure_ad_client_secret"])
        check = R.PROVIDER_MATCH_CHECKS["secret:azure_ad_client_secret"]
        self.assertTrue(check(tok))
        self.assertFalse(check("a" * 40))
        self.assertFalse(check("7a" * 20))
        self.assertFalse(check(("Ab7" * 14)[:40]))   # three classes but low entropy

    def test_url_password_and_bearer_filters(self):
        pw = R.PROVIDER_VALUE_FILTERS["secret:url_password"]
        br = R.PROVIDER_VALUE_FILTERS["secret:bearer_token"]
        self.assertTrue(br("__ZN_API_KEY__", ""))
        self.assertTrue(br("__ZN_A1__", ""))
        self.assertFalse(br("__ZN_api__x", ""))
        self.assertFalse(br("Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4", ""))
        self.assertTrue(br("changeme-changeme-changeme", ""))
        self.assertFalse(pw("Qa7Zt3Lm9Pw2", "postgres://app:"))
        self.assertTrue(pw("short", "postgres://app:"))
        self.assertTrue(pw("abcde", "postgres://app:"))
        self.assertTrue(pw("changeme", "postgres://app:"))
        self.assertFalse(pw("Qa7Zt3", "postgres://app:"))
        self.assertTrue(pw("app", "postgres://app:"))
        self.assertTrue(pw("Qa7Zt3Lm", "https://Qa7Zt3Lm:"))


# ---------------------------------------------------------------------------
# cmd caret and percent readings
# ---------------------------------------------------------------------------

class CmdCaretTests(unittest.TestCase):
    def test_caret_escapes_the_next_character(self):
        self.assertEqual(R._drop_cmd_carets("a^bc"), "abc")
        self.assertEqual(R._drop_cmd_carets("a^^b"), "a^b")
        self.assertEqual(R._drop_cmd_carets("^.env"), ".env")
        self.assertEqual(R._drop_cmd_carets(".e^nv"), ".env")
        self.assertEqual(R._drop_cmd_carets("a^&b"), "a&b")
        self.assertEqual(R._drop_cmd_carets("a^ b"), "a b")

    def test_trailing_caret_is_dropped(self):
        self.assertEqual(R._drop_cmd_carets("ab^"), "ab")
        self.assertEqual(R._drop_cmd_carets("^"), "")

    def test_caret_line_continuation(self):
        self.assertEqual(R._drop_cmd_carets("a^\r\nb"), "ab")
        self.assertEqual(R._drop_cmd_carets("a^\nb"), "ab")
        self.assertEqual(R._drop_cmd_carets("a^\rb"), "a\rb")
        self.assertEqual(R._drop_cmd_carets("ty^\r\npe x"), "type x")
        self.assertEqual(R._drop_cmd_carets("a^\r"), "a\r")

    def test_quotes_protect_carets(self):
        self.assertEqual(R._drop_cmd_carets('"a^b"'), '"a^b"')
        self.assertEqual(R._drop_cmd_carets('"a^b" ^c'), '"a^b" c')

    def test_quote_state_toggles(self):
        self.assertEqual(R._drop_cmd_carets('x^y"a^b"^z'), 'xy"a^b"z')
        self.assertEqual(R._drop_cmd_carets('"a"^b"c"^d'), '"a"b"c"d')
        self.assertEqual(R._drop_cmd_carets('"open ^x'), '"open ^x')

    def test_percent_unit_expansion(self):
        f = R._expand_cmd_percent
        self.assertEqual(f("set X=.env&type %X%"), "set X=.env&type .env")
        self.assertEqual(f("set x=.env&type %X%"), "set x=.env&type .env")
        self.assertEqual(f("set X=.env&type %x%"), "set X=.env&type .env")
        self.assertEqual(f("set X=.env  &type %X%"), "set X=.env  &type .env")
        self.assertEqual(f('set "X=.env"&type %X%'), 'set "X=.env"&type .env')
        self.assertEqual(f("type %UNKNOWN%x"), "type x")
        self.assertEqual(f("type .e%A%nv"), "type .env")
        self.assertEqual(f("type %A:~1,2%x"), "type x")
        self.assertEqual(f("type %A:x=y%x"), "type x")

    def test_known_percent_units_stay(self):
        f = R._expand_cmd_percent
        for unit in ("%USERPROFILE%", "%homepath%", "%HOMEDRIVE%", "%home%", "%CD%", "%Cd%"):
            self.assertEqual(f("type " + unit + "\\.env"), "type " + unit + "\\.env", unit)
        self.assertEqual(f("type %USERPROFILEX%\\.env"), "type \\.env")
        self.assertEqual(f("type %XUSERPROFILE%\\.env"), "type \\.env")

    def test_percent_edges(self):
        f = R._expand_cmd_percent
        self.assertEqual(f("100%"), "100%")
        self.assertEqual(f("%%"), "%%")
        self.assertEqual(f("a%!%b"), "a%!%b")
        self.assertEqual(f("a%b\nc%d"), "a%b\nc%d")

    def test_readings_need_a_reader(self):
        r = R._cmd_readings
        self.assertEqual(r("echo ^.env"), [])
        self.assertEqual(r("grep ^.env notes.md"), [])
        self.assertEqual(r("type .env"), [])
        self.assertIn("type .env", r("type ^.env"))
        for reader in ("cmd", "cmd.exe", "type", "more", "findstr", "copy", "TYPE", "Cmd.Exe"):
            self.assertIn(reader + " .env", r(reader + " ^.env"), reader)
        self.assertEqual(r("xtype ^.env"), [])
        self.assertEqual(r("typex ^.env"), [])
        self.assertEqual(r("more2 ^.env"), [])
        self.assertIn("a & type .env", r("a & type ^.env"))
        self.assertIn("(type .env", r("(type ^.env"))
        self.assertIsNotNone(R.CMD_READER_RE.search('"type ^.env'))
        self.assertIn("a;type .env", r("a;type ^.env"))
        self.assertIn("a|type .env", r("a|type ^.env"))
        self.assertIn("type\t.env", r("type\t^.env"))

    def test_cmd_c_unwrap(self):
        r = R._cmd_readings
        self.assertIn('cmd /c type .e^nv', r('cmd /c "type .e^nv"'))
        self.assertIn('cmd /c type .env', r('cmd /c "type .e^nv"'))
        self.assertIn('cmd /k type .env', r('cmd /k "type .e^nv"'))
        self.assertIn('cmd /C type .env', r('cmd /C "type .e^nv"'))
        self.assertIn('cmd /c type .env  ', r('cmd /c "type .e^nv"  '))
        self.assertIn('cmd /c type .env', r('cmd /c   "type .e^nv"'.replace("   ", " ")))

    def test_percent_reading_expands_variables(self):
        r = R._cmd_readings
        self.assertIn("set X=.env&type .env", r("set X=.env&type %X%"))
        self.assertIn("type .env", r("type .e%A%nv"))
        self.assertEqual(r("type .env %"), [])


class CmdSensitivePathTests(unittest.TestCase):
    def test_caret_obfuscation_is_seen(self):
        for cmd in ("type ^.env", "type .e^nv", "type .^e^n^v", "type ^.^env", "more ^.env", "copy ^.env x",
                    "findstr x ^.env", "cmd /c type ^.env", 'cmd /c "type .e^nv"', 'cmd.exe /c "type ^.env"',
                    "type .env^", "type ^.ssh\\id_^rsa", "type ^.aws\\cred^entials"):
            with self.subTest(cmd=cmd):
                self.assertTrue(R._test_sensitive_path(cmd), cmd)

    def test_percent_obfuscation_is_seen(self):
        for cmd in ("set X=.env&& type %X%", "set X=.env & type %X%", "set x=.env&type %X%",
                    "type %CD%\\.e^nv", "type %cd%\\.env", "type %USERPROFILE%\\.env"):
            with self.subTest(cmd=cmd):
                self.assertTrue(R._test_sensitive_path(cmd), cmd)

    def test_posix_carets_stay_allowed(self):
        for cmd in ("grep ^.env notes.md", "echo ^.env", "git log --grep=^.env", "sed -n '/^.e^nv/p' notes.md",
                    "grep -E x notes.md", "echo 100%", "echo %X%"):
            with self.subTest(cmd=cmd):
                self.assertFalse(R._test_sensitive_path(cmd), cmd)

    def test_plain_and_safe(self):
        self.assertTrue(R._test_sensitive_path("type .env"))
        self.assertFalse(R._test_sensitive_path("type .env.example"))
        self.assertFalse(R._test_sensitive_path("type ^.env.example"))
        self.assertFalse(R._test_sensitive_path("type readme^.md"))


if __name__ == "__main__":
    unittest.main()
