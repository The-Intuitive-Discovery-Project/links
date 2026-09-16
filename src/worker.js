const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY"
};
const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY"
};
const RESERVED = new Set(["www", "admin", "admin1942", "api", "health"]);
const SAFETY_STATUSES = new Set(["pending", "approved", "blocked"]);

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }
function text(message, status = 200) { return new Response(message, { status, headers: TEXT_HEADERS }); }
function iso() { return new Date().toISOString(); }
function safeEqual(a, b) {
  const left = String(a || ""), right = String(b || "");
  if (!left.length || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
function cleanCode(value) {
  const code = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) || code.length > 80 || RESERVED.has(code)) return null;
  return code;
}
function validDestination(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch { return null; }
}
function normalizeExpiresAt(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString();
}
function normalizeSafetyStatus(value, fallback = "pending") {
  if (value === undefined) return fallback;
  const status = String(value || "").trim().toLowerCase();
  return SAFETY_STATUSES.has(status) ? status : null;
}
function hasMasterAccess(request, env) {
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return Boolean(env.MASTER_ADMIN_SERVICE_TOKEN && safeEqual(given, env.MASTER_ADMIN_SERVICE_TOKEN));
}
function requestDetails(request) {
  const agent = request.headers.get("user-agent") || "";
  const device = /mobile|android|iphone/i.test(agent) ? "mobile" : /tablet|ipad/i.test(agent) ? "tablet" : "desktop";
  const browser = /edg\//i.test(agent) ? "Edge" : /chrome\//i.test(agent) ? "Chrome" : /firefox\//i.test(agent) ? "Firefox" : /safari\//i.test(agent) ? "Safari" : "Other";
  let referrerHost = null;
  try { referrerHost = new URL(request.headers.get("referer") || "").hostname || null; } catch {}
  return { device, browser, referrerHost };
}
async function visitorHash(request, code, env) {
  const source = String(request.headers.get("cf-connecting-ip") || "") + "|" + String(request.headers.get("user-agent") || "") + "|" + code;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.ANALYTICS_HASH_SECRET || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(source));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function listLinks(env) {
  const { results = [] } = await env.DB.prepare(`SELECT l.id,l.code,l.destination_url,l.redirect_mode,l.title,l.is_active,l.expires_at,l.qr_enabled,l.safety_status,l.safety_checked_at,l.created_at,l.updated_at,
    COUNT(c.id) AS total_clicks, COUNT(DISTINCT c.visitor_hash) AS unique_visitors
    FROM links l LEFT JOIN link_clicks c ON c.link_id=l.id WHERE l.deleted_at IS NULL
    GROUP BY l.id ORDER BY l.updated_at DESC`).all();
  return results;
}
async function getLink(env, code) {
  return env.DB.prepare("SELECT * FROM links WHERE code=? AND deleted_at IS NULL").bind(code).first();
}
async function recordClick(env, request, link) {
  if (!env.ANALYTICS_HASH_SECRET) return;
  const details = requestDetails(request);
  const hash = await visitorHash(request, link.code, env);
  await env.DB.prepare("INSERT INTO link_clicks (link_id,occurred_at,visitor_hash,referrer_host,device_class,browser_family,country_code) VALUES (?,?,?,?,?,?,?)")
    .bind(link.id, iso(), hash, details.referrerHost, details.device, details.browser, request.cf?.country || null).run();
}
async function audit(env, linkId, action, details) {
  await env.DB.prepare("INSERT INTO link_admin_audit (link_id,action,actor_type,details_json,occurred_at) VALUES (?,?,?,?,?)")
    .bind(linkId, action, "master-admin", JSON.stringify(details || {}), iso()).run();
}
function expired(link) { return Boolean(link.expires_at && Date.parse(link.expires_at) <= Date.now()); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.DB) return json({ error: "TinyThor v2 database is not configured." }, 503);

    if (url.pathname === "/health") return json({ ok: true, service: "tinythor-links-v2" });

    if (url.pathname === "/api/admin/links") {
      if (!hasMasterAccess(request, env)) return json({ error: "Unauthorized" }, 401);
      if (request.method === "GET") return json({ links: await listLinks(env) });
      if (request.method === "POST") {
        const body = await request.json().catch(() => null);
        const code = cleanCode(body?.code), destination = validDestination(body?.destination_url);
        const expiresAt = normalizeExpiresAt(body?.expires_at);
        if (!code) return json({ error: "Use a lowercase alias with letters, numbers, and single hyphens only. Reserved names cannot be used." }, 400);
        if (!destination) return json({ error: "Destination must be a valid http or https URL without embedded credentials." }, 400);
        if (expiresAt === false) return json({ error: "Expiration must be a valid date/time." }, 400);
        const now = iso();
        try {
          const result = await env.DB.prepare("INSERT INTO links (code,destination_url,redirect_mode,title,is_active,expires_at,qr_enabled,safety_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .bind(code, destination, body?.redirect_mode === "subdomain" ? "subdomain" : "path", String(body?.title || "").trim() || null, 1, expiresAt ?? null, body?.qr_enabled === false ? 0 : 1, "pending", now, now).run();
          await audit(env, result.meta.last_row_id, "create", { code, destination, safety_status: "pending" });
          return json({ ok: true, id: result.meta.last_row_id, safety_status: "pending" }, 201);
        } catch { return json({ error: "That short alias already exists." }, 409); }
      }
      return json({ error: "Method not allowed" }, 405);
    }

    const activity = url.pathname.match(/^\/api\/admin\/links\/(\d+)\/activity$/);
    if (activity) {
      if (!hasMasterAccess(request, env)) return json({ error: "Unauthorized" }, 401);
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const id = Number(activity[1]);
      const link = await env.DB.prepare("SELECT id,code FROM links WHERE id=? AND deleted_at IS NULL").bind(id).first();
      if (!link) return json({ error: "Link not found" }, 404);
      const { results = [] } = await env.DB.prepare("SELECT occurred_at,referrer_host,device_class,browser_family,country_code FROM link_clicks WHERE link_id=? ORDER BY occurred_at DESC LIMIT 100").bind(id).all();
      const summary = await env.DB.prepare("SELECT COUNT(*) total_clicks,COUNT(DISTINCT visitor_hash) unique_visitors FROM link_clicks WHERE link_id=?").bind(id).first();
      return json({ link_id:id, code:link.code, total_clicks:Number(summary?.total_clicks||0), unique_visitors:Number(summary?.unique_visitors||0), recent_activity:results });
    }

    const manage = url.pathname.match(/^\/api\/admin\/links\/(\d+)$/);
    if (manage) {
      if (!hasMasterAccess(request, env)) return json({ error: "Unauthorized" }, 401);
      if (request.method !== "PATCH") return json({ error: "Method not allowed" }, 405);
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "A valid JSON body is required." }, 400);
      const current = await env.DB.prepare("SELECT * FROM links WHERE id=? AND deleted_at IS NULL").bind(Number(manage[1])).first();
      if (!current) return json({ error: "Link not found" }, 404);
      const destination = body.destination_url === undefined ? current.destination_url : validDestination(body.destination_url);
      if (!destination) return json({ error: "Destination must be a valid http or https URL without embedded credentials." }, 400);
      const expiresAt = body.expires_at === undefined ? current.expires_at : normalizeExpiresAt(body.expires_at);
      if (expiresAt === false) return json({ error: "Expiration must be a valid date/time." }, 400);
      const safetyStatus = normalizeSafetyStatus(body.safety_status, current.safety_status);
      if (!safetyStatus) return json({ error: "Safety status must be pending, approved, or blocked." }, 400);
      const active = body.is_active === undefined ? current.is_active : body.is_active ? 1 : 0;
      const qrEnabled = body.qr_enabled === undefined ? current.qr_enabled : body.qr_enabled ? 1 : 0;
      const title = body.title === undefined ? current.title : String(body.title || "").trim() || null;
      const now = iso();
      const safetyCheckedAt = safetyStatus === current.safety_status
        ? current.safety_checked_at
        : safetyStatus === "pending" ? null : now;
      await env.DB.prepare("UPDATE links SET destination_url=?,title=?,is_active=?,expires_at=?,qr_enabled=?,safety_status=?,safety_checked_at=?,updated_at=? WHERE id=?")
        .bind(destination, title, active, expiresAt ?? null, qrEnabled, safetyStatus, safetyCheckedAt, now, current.id).run();
      await audit(env, current.id, "update", {
        destination_url: destination,
        title,
        is_active: active,
        expires_at: expiresAt ?? null,
        qr_enabled: qrEnabled,
        safety_status: safetyStatus
      });
      return json({ ok: true, safety_status: safetyStatus });
    }

    const code = cleanCode(url.pathname.slice(1).split("/")[0]);
    if (!code) return text("Not found", 404);
    const link = await getLink(env, code);
    if (!link || !link.is_active || expired(link) || link.safety_status !== "approved") return text("This short link is unavailable.", 404);
    try { await recordClick(env, request, link); } catch {}
    return Response.redirect(link.destination_url, 302);
  }
};
