### Security

- The experimental Rust gateway (built from source only) now makes request-supplied values safe before it logs them. The Origin header, tool names, agent ids and error texts have line breaks, terminal escape sequences and text-direction controls replaced with visible escapes, and are cut at 200 characters, so a hostile client can no longer forge log lines or change what a terminal shows. Info-level log lines also show your home folder as `~` instead of the full path.
