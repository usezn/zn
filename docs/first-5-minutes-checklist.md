# First 5 minutes checklist

A printable version of the numbered steps in [First 5 minutes with zn-gate](first-5-minutes.md). Run every command in your own terminal, not through your agent. The full page explains each step.

- [ ] 1. Install: `npx -y zn-gate init`
- [ ] 2. Check that it worked: `npx -y zn-gate check` (`OK` next to your agent means it is protected)
- [ ] 2. Optional, status and built-in examples: `npx -y zn-gate status` and `npx -y zn-gate test`
- [ ] 3. Know what you will see while you work: a block, an approval question, a warning. If a block is a surprise, read its reason and ask your agent why it wanted that file. For a `.env` file, run `npx -y zn-gate env shadow .env`

See [What you will see while you work](first-5-minutes.md#3-what-you-will-see-while-you-work) for examples of each message, and [Remove zn-gate](first-5-minutes.md#remove-zn-gate) if you want to take it off.

## Where next

- [First 5 minutes with zn-gate](first-5-minutes.md): the full page behind this checklist
- [Why was this blocked?](why-was-this-blocked.md): read a block message and decide what to do
- [Troubleshooting](troubleshooting.md): when a command fails or `check` does not say `OK`
- [Commands cheatsheet](commands-cheatsheet.md): the commands you will use most
- [Glossary](glossary.md): words you do not know
- [Uninstall](uninstall.md): take zn-gate off
