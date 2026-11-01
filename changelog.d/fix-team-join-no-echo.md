### Fixed
- `zn team join -` no longer shows the join token on the screen when it is typed or pasted in a terminal. The text is hidden while the token is read, and the terminal is restored on Enter, Ctrl-C and every other way out. The usage line now reads `zn team join <token>|-`, and the "Not in a zn organization" hint shows `zn team join -`.
