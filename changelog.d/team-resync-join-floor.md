### Security
- Team audit upload no longer reads records from before this machine joined when the server asks for a resync: a resync point earlier than the join is refused and nothing is uploaded.
- Team audit upload also ignores a leftover upload position from an earlier membership when it lies before the new join point, so records from before joining are never sent or counted as pending.
