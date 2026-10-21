### Fixed
- zn audit no longer reports ordinary setup steps as secrets being sent out: copying .env.example to .env, creating an API key at a console URL, or pasting a key into settings. The rule now needs a send verb aimed at a destination.
