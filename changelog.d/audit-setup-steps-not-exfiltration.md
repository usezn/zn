### Fixed
- zn audit no longer reports ordinary setup steps as secrets being sent out: copying .env.example to .env, or creating or copying an API key from a console URL. Copying, sharing or pasting a secret toward any URL is still flagged, except for steps that take the key "from" a URL or "create" it "at/on/in" a URL, where the setup verb governs the URL.
