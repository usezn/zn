//! Stand-in for the unmaintained `paste` crate (RUSTSEC-2024-0436).
//! The `gemm` crates (pulled in by candle) call `paste::paste!`; `pastey` is the maintained,
//! drop-in successor, so this crate forwards the macro to it. See the `[patch.crates-io]`
//! entry in the root Cargo.toml. Remove both once gemm moves off `paste`.
pub use pastey::paste;
