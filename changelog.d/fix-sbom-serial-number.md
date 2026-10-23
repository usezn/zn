### Fixed
- The CycloneDX SBOMs published with each release now carry a serial number, which GitHub artifact attestations require. It is derived from the package, its version and the artifact hash, so rebuilding the same commit still gives the same SBOM.
