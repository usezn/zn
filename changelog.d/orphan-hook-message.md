### Fixed
- When zn-gate is removed but its hooks are still set up, the agent now gets a clear message: zn-gate is not installed any more, the hooks still point at it, and the fix (install it again, or remove the hooks with `npx -y zn-gate hooks uninstall <agent>`).
