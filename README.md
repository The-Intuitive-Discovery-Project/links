# TinyThor Short Links

Development repository for the TinyThor.cc short-link rebuild.

## Safety boundary

The live shortener and its existing `/admin1942` panel remain unchanged while this rebuild is developed and tested. No credentials, Worker secrets, raw IP addresses, or production exports belong in this repository.

## Rebuild goals

- Custom aliases and normal/subdomain redirects
- Link activation, expiration, QR-code status, and a master-admin disable switch
- Total clicks and privacy-preserving unique visitor counts
- Link-level activity: timestamp, referrer when available, browser/device class, and country only when safely derived without retaining raw IP
- Existing link migration before replacement
- Per-user isolated admin access later, with master admin control
- URL safety review and re-checks before public use
- Backup workflow for code and database exports

## Status

Foundation only. The live Worker source/database structure must be backed up and compared before a production migration is designed.
