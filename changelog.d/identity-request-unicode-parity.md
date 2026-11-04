### Fixed
- The identity-request rules (pi:identity_request and pi:identity_request_multi) now give the same result in the Node and Python packages on text with folded letters such as the long s, the Kelvin sign and the dotless i: before, one package flagged text the other let through when the raw text was checked. The normalised text is still checked as before.
