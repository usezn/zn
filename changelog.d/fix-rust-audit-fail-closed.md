### Security
- The gateway no longer forwards an allowed tool call whose audit record could not be written when `audit.fail_closed` is on (the default when `environment` is `production`; set it with `audit.fail_closed` or `ZN_AUDIT_FAIL_CLOSED`). The call is refused with a JSON-RPC error. With it off, the failure is logged at error level and counted in `zn_audit_write_failures_total`, never ignored. A failed audit schema migration is now logged, and in production it stops the gateway at startup.

