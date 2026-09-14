-- TinyThor Short Links v2 (development only)
-- No raw IP addresses are stored. visitor_hash is a rotating privacy-preserving hash.

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  destination_url TEXT NOT NULL,
  redirect_mode TEXT NOT NULL DEFAULT 'path' CHECK (redirect_mode IN ('path','subdomain')),
  title TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  expires_at TEXT,
  qr_enabled INTEGER NOT NULL DEFAULT 1 CHECK (qr_enabled IN (0,1)),
  safety_status TEXT NOT NULL DEFAULT 'pending' CHECK (safety_status IN ('pending','approved','blocked')),
  safety_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_active_code ON links(code,is_active);
CREATE INDEX IF NOT EXISTS idx_links_expiry ON links(expires_at);

CREATE TABLE IF NOT EXISTS link_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  referrer_host TEXT,
  device_class TEXT,
  browser_family TEXT,
  country_code TEXT,
  FOREIGN KEY(link_id) REFERENCES links(id)
);
CREATE INDEX IF NOT EXISTS idx_clicks_link_time ON link_clicks(link_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_clicks_link_visitor ON link_clicks(link_id,visitor_hash);

CREATE TABLE IF NOT EXISTS link_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  details_json TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY(link_id) REFERENCES links(id)
);
