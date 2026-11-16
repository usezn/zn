### Security
- Both packages: the destructive-command check (`checkCommand()` / `check_command()` and the opt-in agent hook rules)
  now reads text that `echo`, `printf` or a here-string feeds into a shell as code, the same way it already read a
  heredoc or a `sh -c` string: `echo 'rm -rf /home/alice' | sh`, `sh <<< 'rm -rf /home/alice'`,
  `printf %s '...' | bash` and `bash -c "$(echo '...')"` are blocked by whichever rule the text hits. Only literal
  text is read; variables are not evaluated.
- Both packages: `chmod -R` on the home folder is blocked for octal modes with extra leading zeros (`00777`) and for
  comma lists of symbolic clauses that leave it writable by others (`u=rwx,g=rwx,o=rwx`).
- Both packages: the fork bomb rule now also matches the `function` keyword, two background calls (`f(){ f&f& };f`),
  extra pipe stages (`f|cat|f&`) and any command separator before the call (`&& :`). A recursive function that calls
  itself once, or only in the foreground, stays allowed.
