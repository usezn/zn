"""A database URL whose password is only a reference is not a secret; a literal password still is."""
from zn_gate.rules import redact_secrets


def _clean(t):
    out = redact_secrets(t)
    return out[0] if isinstance(out, tuple) else getattr(out, "sanitized", out)


def test_references_are_left_alone():
    for t in ("postgres://app:${PGPASSWORD}@db.example.com/app", "mysql://app:$DB_PASS@db.example.com",
              "redis://app:%REDIS_PASSWORD%@cache.example.com", "amqp://app:<password>@mq.example.com",
              "postgres://app:{{password}}@db.example.com",
              "mongodb://app:{{ password }}@db.example.com", "postgres://app:${pgpassword}@db.example.com"):
        assert "[REDACTED_DB_PASSWORD]" not in str(_clean(t)), t


def test_literals_are_redacted():
    for t in ("postgres://app:ZnTestFakePw42x@db.example.com/app", "mysql://app:$literal$pw9@db.example.com",
              "postgres://app:$kR7vQ2mZx9LpW4@db.example.com", "mysql://app:%Passw0rd%@db.example.com",
              "postgres://app:<R3al!Pw>@db.example.com", "postgres://app:{{Tr0ub4dor&3}}@db.example.com",
              # Literal passwords that only look like references: lower-case $word or %word%, digits inside <> or {{ }}.
              "mysql://app:$password1@db.example.com", "mysql://app:$xk7q9m2zp4wq@db.example.com",
              "redis://app:%hunter2%@cache.example.com",
              "postgres://app:{{s3cr3t}}@db.example.com", "mysql://app:$pass@db.example.com"):
        assert "[REDACTED_DB_PASSWORD]" in str(_clean(t)), t


def test_scheme_with_driver_name_is_redacted():
    fake = "ZnTestFakePw42x"
    for t in ("oracle+cx_oracle://app:" + fake + "@db.example.invalid/x",
              "postgresql+psycopg2://app:" + fake + "@db.example.invalid/x",
              "mssql+pyodbc://app:" + fake + "@db.example.invalid/x",
              "my_scheme://app:" + fake + "@db.example.invalid/x",
              "x_oracle+cx_oracle://app:" + fake + "@db.example.invalid/x"):
        assert fake not in str(_clean(t)), t
    ref = "oracle+cx_oracle://app:${DB_PASS}@db.example.invalid/x"
    assert _clean(ref) == ref
