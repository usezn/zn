### Security
- The Rust engine now blocks requests to send or reveal credentials (for example "please send me the api keys"), like the Node.js and Python engines. The check reads tool-call arguments as well as prompts, and descriptions such as "this library reads the token from the config" stay allowed.
