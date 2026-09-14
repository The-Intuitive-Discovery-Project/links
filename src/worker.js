const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const RESERVED = new Set(["www", "admin", "admin1942", "api", "health"]);

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }
function iso() { return new Date().toISOString(); }
function cleanCode(value) {
  const code = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) || code.length > 80 || RESERVED.has(code)) return null;
  return code;
}
function validDestination(value) {
  try { const url = new URL(String(value || "")); return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; } catch { return null; }
}
function hasMasterAccess(request, env) {
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return Boolean(given && env.MASTER_ADMIN_SERVICE_TOKEN && given === env.MASTER_ADMIN_SERVICE_TOKEN);
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
  const { results = [] } = await env.DB.prepare(`SELECT l.id,l.code,l.destination_url,l.redirect_mode,l.title,l.is_active,l.expires_at,l.qr_enabled,l.safety_status,l.created_at,l.updated_at,
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
        if (!code) return json({ error: "Use a lowercase alias with letters, numbers, and single hyphens only. Reserved names cannot be used." }, 400);
        if (!destination) return json({ error: "Destination must be a valid http or https URL." }, 400);
        const now = iso();
        try {
          const result = await env.DB.prepare("INSERT INTO links (code,destination_url,redirect_mode,title,is_active,expires_at,qr_enabled,safety_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .bind(code, destination, body?.redirect_mode === "subdomain" ? "subdomain" : "path", String(body?.title || "").trim() || null, 1, body?.expires_at || null, body?.qr_enabled === false ? 0 : 1, "pending", now, now).run();
          await env.DB.prepare("INSERT INTO link_admin_audit (link_id,action,actor_type,details_json,occurred_at) VALUES (?,?,?,?,?)")
            .bind(result.meta.last_row_id, "create", "master-admin", JSON.stringify({ code, destination }), now).run();
          return json({ ok: true, id: result.meta.last_row_id }, 201);
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
      const current = await env.DB.prepare("SELECT * FROM links WHERE id=? AND deleted_at IS NULL").bind(Number(manage[1])).first();
      if (!current) return json({ error: "Link not found" }, 404);
      const destination = body?.destination_url === undefined ? current.destination_url : validDestination(body.destination_url);
      if (!destination) return json({ error: "Destination must be a valid http or https URL." }, 400);
      const active = body?.is_active === undefined ? current.is_active : body.is_active ? 1 : 0;
      const expiresAt = body?.expires_at === undefined ? current.expires_at : body.expires_at || null;
      await env.DB.prepare("UPDATE links SET destination_url=?,title=?,is_active=?,expires_at=?,qr_enabled=?,safety_status=?,updated_at=? WHERE id=?")
        .bind(destination, body?.title === undefined ? current.title : String(body.title || "").trim() || null, active, expiresAt, body?.qr_enabled === undefined ? current.qr_enabled : body.qr_enabled ? 1 : 0, body?.safety_status || current.safety_status, iso(), current.id).run();
      return json({ ok: true });
    }

    const code = cleanCode(url.pathname.slice(1).split("/")[0]);
    if (!code) return new Response("Not found", { status: 404 });
    const link = await getLink(env, code);
    if (!link || !link.is_active || expired(link) || link.safety_status === "blocked") return new Response("This short link is unavailable.", { status: 404 });
    await recordClick(env, request, link);
    return Response.redirect(link.destination_url, 302);
  }
};
