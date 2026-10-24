### Fixed
- The hidden-element rule now reads every spelling of a tiny width or height as tiny: a leading dot (`.5px`), leading zeros (`01px`, `00px`) and an exponent (`1e0px`, `0e0px`), with or without spaces or `!important`. Sizes above 1px, such as `2px`, `1.5px` or `1e1px`, still do not count.
