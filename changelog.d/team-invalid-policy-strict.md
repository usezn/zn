### Security
- zn Team now fails closed when the stored organization policy does not verify (for example an edited copy, or a changed organization key). Before, the whole policy was ignored, including its blocks. Now the machine is in strict mode: every secret is blocked and nothing the organization had opened stays open, until `zn team sync` brings a valid policy. `zn team status` says so.
