### Changed
- Three tests that failed on busy CI runners no longer depend on how fast the machine is: the shield flood test waits until the proxy stops moving instead of a fixed 280 s, the Unicode folding cost test compares CPU time taken in turns, and the plugin Node.js version checks give the live hook 60 s to start on Windows (15 s everywhere else, as before).
