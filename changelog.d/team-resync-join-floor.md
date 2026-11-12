### Security
- Team audit upload no longer reads records from before this machine joined when the server asks for a resync: a resync point earlier than the join is refused and nothing is uploaded.
