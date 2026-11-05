# A hardware-backed vault key (proposal)

**Status: a proposal. Nothing on this page is built, and none of it is planned for a release.** It describes an idea and the questions to settle before anyone writes code. Everything the vault does today is described in [Keep secrets out of your agent](secrets.md) and the [threat model](threat-model.md).

## What problem this would address

Today the vault is encrypted with an age identity. zn-gate keeps that identity in your system keychain (macOS Keychain, Windows Credential Manager or the Linux Secret Service), or behind a passphrase when there is no keychain. While the vault is unlocked, a background process holds the decrypted secrets and a session key in memory.

The [threat model](threat-model.md) says plainly where this stops: malware running as your OS user can read the session key and talk to the unlocked vault, and any program of your user can ask it for a secret. The OS user is the boundary. A key held in software cannot do better than that, because anything that runs as you can read what you can read.

## The idea

Make the vault key, or a key that wraps it, usable only with help from hardware that does not hand the key out:

- **Secure Enclave on macOS.** Secure Enclave keys are non-exportable P-256 keys whose use can be tied to user presence or biometry (see Apple's Security documentation).
- **TPM on Windows and Linux.** On Windows, the Microsoft Platform Crypto Provider creates TPM-protected keys whose private material is non-removable and unique to that TPM. On Linux, systemd can encrypt credentials with a key derived from the local TPM2 chip, a key on disk, or both.
- **A FIDO2 security key, through the `hmac-secret` extension.** The platform asks the authenticator for a secret that is specific to one credential. The authenticator computes it from a salt the platform supplies and a random value it never reveals. This is part of the CTAP 2.2 specification and the W3C WebAuthn Level 3 specification.

**What exists today.** There is a prototype of a related but different feature, on a branch that has not been merged: an opt-in check that holds a few protected shell actions (publishing a package, pushing to a protected branch, deleting many files, changing zn's settings) until the person taps a FIDO2 security key on a local page. It verifies a WebAuthn signature for one exact action, once. It is off by default and has its own tests. It does **not** use `hmac-secret` and does **not** touch the vault key. It would be a starting point for the enrollment and tap flow, not a head start on the key derivation.

## What it would cover, and what it would not

| Threat | Covered? | Why |
|---|---|---|
| The vault key copied from the keychain or the disk by another program or from a backup | Yes, if the key cannot be exported | The key would only work on that hardware |
| A stolen disk or copied files used on another machine | Yes, for a key bound to that machine's TPM or enclave | The private material is unique to the device |
| A program running as you that asks the hardware to unlock while you are present | **No** | The hardware cannot tell which program is asking. A touch or biometry prompt would help only if you notice an unexpected one |
| Malware on the machine after the vault is unlocked | **No** | The decrypted secrets are in the process's memory, as the threat model describes |
| A compromised operating system or administrator | **No** | It can ask the hardware too |
| A secret already in a process's environment | **No** | The value is inside the process you allowed |

## Cost for the user

- A touch or biometry prompt each time the vault unlocks.
- A recovery path that does not depend on the hardware. Without one, losing the device or the key locks the user out of the vault for good.
- Hardware that not everyone has. Machines without it would keep today's behavior.
- Lockout risk. A TPM key sealed to PCR values can stop working after firmware or boot changes. Keys bound to PCR values stop working if the PCR bank in use is switched, and clearing the TPM destroys the keys it created and the data they protect.

## Plan in phases

1. **Phase 0: decide and verify.** Answer the open questions below against the vendors' official documentation. *Done when* every question has a written answer and a decision to go on or stop.
2. **Phase 1: a FIDO2 key as an optional second factor.** A security key with `hmac-secret` would be needed, next to the passphrase or keychain, to unlock the vault. This is the phase that reuses the existing prototype's enrollment and tap flow. *Done when* a vault can be created, unlocked and reset with the key, tested on real keys, and it is documented as optional.
3. **Phase 2: platform keystores, all optional.** Secure Enclave on macOS first, then the TPM on Windows, then a systemd-style TPM credential on Linux. *Done when* each platform unlocks the vault with its keystore and falls back cleanly when it is missing.
4. **Phase 3: recovery and migration.** Move an existing vault to a hardware-backed key and back, and recover when the hardware is lost. *Done when* both directions are tested and nobody can end up locked out by following the documented steps.

## Open questions

- **To verify before publishing any claim about Apple:** the Secure Enclave statement above comes from secondary sources and must be checked against Apple's official documentation.
- Which PCRs, if any, a Linux TPM credential should be bound to. The systemd documentation consulted does not say which PCRs it uses.
- Which algorithms, API names and minimum hardware each platform supports, and how it behaves on older machines.
- Linux desktops without a TPM, WSL, virtual machines and cloud runners: what works there?
- Recovery if the hardware is lost or replaced, and whether the user can have two devices or two keys.
- Headless machines and CI, where nobody can touch a key.
- How this fits with the vault's own confirmation channel (the terminal or system dialog that `zn run` and first use already ask on), and whether a tap should replace or add to it.
