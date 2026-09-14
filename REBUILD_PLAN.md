# TinyThor v2 build order

1. **Preserve current system** — export/back up current live Worker code and D1 schema/data; do not replace `/admin1942`.
2. **Provision isolated v2 Worker + D1** — separate from Central Admin, then connect it to Central Admin with a service token.
3. **Build redirects and link management** — preserve current rules: lowercase aliases, `a-z`, `0-9`, hyphens only, and reserve `www`/admin names.
4. **Add analytics** — store each click event without raw IP addresses. Unique visitors are calculated from a rotating anonymous hash, separately from total clicks.
5. **Add safety controls** — review state, active/disabled master control, and expiration.
6. **Generate QR links** — QR is generated from the live short URL rather than storing image files.
7. **Migrate and test** — import current links into v2, test redirects/analytics/admin actions, then decide whether to retire the old panel.

## Data available to the central dashboard

Per link: destination, status, expiration, QR status, total clicks, unique visitors, recent activity, referrer host, browser/device class, and safety status.

## Explicitly excluded

- Raw IP addresses
- Visitor profiles or cross-link tracking
- Replacing the current live shortener before migration/test approval
