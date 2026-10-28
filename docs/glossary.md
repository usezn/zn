# Glossary

Short meanings of words used in the zn-gate docs.

**Coding agent**: a program such as Claude Code, Codex CLI, Cursor, OpenCode, Antigravity or ZCode desktop app that reads your files and runs commands for you.

**Terminal**: the window where you type commands. Run zn-gate's setup commands in your own terminal, not through an agent.

**Node.js**: the program that runs zn-gate's npm commands. `npx` comes with it. You can get it at [nodejs.org](https://nodejs.org/).

**Secret**: a value that gives access to something, such as an API key, a token or a password.

**`.env` file**: a file in a project that holds secrets and other settings for your app.

**Vault**: an encrypted store on your machine where zn-gate keeps the real values of your secrets.

**Marker**: a stand-in for a secret, such as `__ZN_STRIPE_KEY__`. Your agent sees the marker. The real value stays in the vault. A marker is filled in for web requests and files, never in a command's arguments.

**Redact**: replace a secret in some text with a marker or a label, so nobody who reads the text sees the value.

**Shadow** (`env shadow`): move the secret values of a `.env` file into the vault and leave markers in their place.

**Hook**: a small check that your agent runs before or after it reads a file, runs a command or gets your prompt. zn-gate uses hooks to block or redact.

**Plugin**: the zn-gate add-on for Claude Code. It sets up zn-gate's hooks in one step; since version 1.14.0 it adds no MCP server.

**MCP server**: a tool your agent can call. MCP is the standard way agents connect to tools. zn-gate can also run as one.

**Proxy** (`shield`): a layer that sits between your agent and an MCP server and checks what passes through.

**Prompt injection**: text that tries to make an agent ignore your instructions, for example hidden inside a file or a web page.

**Keychain**: the password store of your operating system.

**Cloud check**: an optional second check, by the Galvanize 2 classifier at usezn.com, of the text sent to zn-gate's `analyze_prompt` tool. It is off until you turn it on. Its figures (recall, false positives) describe that classifier, not zn-gate's local rules.

**Classifier**: a model that sorts text into groups, such as safe or an injection attempt.

**Self-test**: `zn-gate test`. It runs zn-gate's built-in examples.

For setup steps, start with the [README](../README.md#install).
