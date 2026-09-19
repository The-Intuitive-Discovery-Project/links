# TinyThor Short Links

Development repository for the TinyThor.cc short-link rebuild.

## Safety boundary

The live shortener and its existing protected admin panel remain unchanged while this rebuild is developed and tested. The admin route is intentionally not documented in this public repository. No credentials, Worker secrets, raw IP addresses, production database exports, or private recovery files belong here.

## Rebuild goals

- Custom aliases and normal/subdomain redirects
- Link activation, expiration, QR-code status, and a master-admin disable switch
- Total clicks and privacy-preserving unique visitor counts
- Link-level activity: timestamp, referrer when available, browser/device class, and country only when safely derived without retaining raw IP
- Existing link migration before replacement
- Per-user isolated admin access later, with master admin control
- URL safety review and re-checks before public use
- Backup workflow for code and database exports

## Security requirements before replacement

- Back up the live Worker source and D1 structure before designing migration changes.
- Treat the admin route name as non-secret; real protection must come from authentication/edge access, not obscurity.
- Keep admin/API responses private and `no-store`, and require same-origin protection for browser writes.
- Keep service tokens and Cloudflare credentials in encrypted environment/GitHub secrets only.
- Do not publish raw production D1 exports in this public repository.
- Preserve a tested rollback path before changing live routes or redirects.

## Status

Foundation only. The authoritative live Worker source/database structure is not stored in this repository yet and must be backed up and compared before a production migration or security refactor is designed.
