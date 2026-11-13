### Security

- If the check that tells whether a command can reach the network cannot run, the hook now treats the command as one that can, so hidden values are not put back into it. Before, such a command was treated as local.
