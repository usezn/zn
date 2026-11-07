### Security
- The SIEM exporter no longer grows without bound when the endpoint is down: it keeps at most 10,000 events (about 16 MiB), drops the oldest first and logs a rate-limited warning with the count. Export requests now time out (5 s to connect, 15 s in total), so a hung endpoint cannot stall the exporter.
