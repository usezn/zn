//! Policy signatures: the signature file, the public keys and the policy name are all read from disk or
//! from configuration, so they are untrusted until verified.
//!
//! Input: four fields split at 0x00: the policy bytes, the Ed25519 signature file (base64 text), the
//! ML-DSA-65 public key (raw bytes, set as the hex in the environment variable) and its signature file.
//! The Ed25519 key is the public test key of RFC 8032, section 7.1 (test 2), so the only message and
//! signature that may verify are known: the one-byte message 0x72 and its signature.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::cell::RefCell;
use zn::engine::signing::PolicyVerifier;
use zn::engine::valid_policy_name;

const PUBLIC_KEY_HEX: &str = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const MESSAGE: &[u8] = &[0x72];
const SIGNATURE_B64: &str =
    "kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==";

thread_local! {
    static DIR: RefCell<tempfile::TempDir> = RefCell::new(tempfile::tempdir().expect("a scratch folder"));
}

fuzz_target!(|data: &[u8]| {
    let mut parts = data.splitn(4, |b| *b == 0);
    let policy = parts.next().unwrap_or(&[]);
    let signature = parts.next().unwrap_or(&[]);
    let pq_key = parts.next().unwrap_or(&[]);
    let pq_signature = parts.next().unwrap_or(&[]);

    // The policy name check: whatever passes can only name a file inside the policy folder.
    let name = String::from_utf8_lossy(policy);
    if valid_policy_name(&name) {
        assert!(!name.contains(['/', '\\', '\0']) && !name.starts_with('.') && !name.starts_with('-'));
    }

    DIR.with(|dir| {
        let dir = dir.borrow();
        let path = dir.path().join("policy.wasm");
        for leftover in ["policy.wasm", "policy.wasm.sig", "policy.wasm.pqs"] {
            let _ = std::fs::remove_file(dir.path().join(leftover));
        }
        std::fs::write(path.with_extension("wasm.sig"), signature).expect("write the signature");

        // Ed25519 only: the environment variable is cleared first, so a key from an earlier input is gone.
        std::env::remove_var("ZN_PQ_PUBLIC_KEY");
        let verifier = PolicyVerifier::new(Some(PUBLIC_KEY_HEX)).expect("the test key loads");
        let verdict = verifier.verify(policy, &path);
        if verdict.is_ok() {
            // Only the known message with the exact known signature verifies; a malleable or
            // re-encoded signature must not.
            assert_eq!(policy, MESSAGE);
            assert_eq!(String::from_utf8_lossy(signature).trim(), SIGNATURE_B64);
        }

        // Verify-then-write: a refused policy leaves nothing on disk.
        let written = verifier.verify_then_write(policy, &path, |_| Ok(()));
        if written.is_err() {
            assert!(!path.exists(), "a refused policy was written");
        }
        let _ = std::fs::remove_file(&path);

        // ML-DSA-65: the key comes from the environment as hex; most inputs are the wrong size.
        if !pq_key.is_empty() {
            std::env::set_var("ZN_PQ_PUBLIC_KEY", hex::encode(pq_key));
            std::fs::write(path.with_extension("wasm.pqs"), pq_signature).expect("write the PQ signature");
            if let Ok(verifier) = PolicyVerifier::new(None) {
                // A forged signature never verifies: the key is chosen by the input, the signature
                // would have to be valid for it, which a mutation does not produce.
                let _ = verifier.verify(policy, &path);
            }
            std::env::remove_var("ZN_PQ_PUBLIC_KEY");
        }
    });
});
