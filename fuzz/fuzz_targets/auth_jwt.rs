//! Bearer tokens read as JWTs: a token from a client is untrusted text, and so is the claim set inside it.
//!
//! Input: the secret and the token, split at the first NUL byte.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::auth::fuzz_entry;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let (secret, token) = text.split_once('\0').unwrap_or(("fictional-test-secret", &text));

    let granted = fuzz_entry::jwt_grants_access(token, secret);
    // Three dot-separated parts, or no access.
    if granted {
        assert_eq!(token.matches('.').count(), 2, "access without a three-part token");
    }
});
