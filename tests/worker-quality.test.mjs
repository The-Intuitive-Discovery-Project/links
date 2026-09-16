import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  normalized() { return this.sql.replace(/\s+/g, ' ').trim().toUpperCase(); }
  async first() {
    const sql = this.normalized();
    if (sql.startsWith('SELECT * FROM LINKS WHERE CODE=?')) {
      const row = this.db.links.find(link => link.code === this.args[0] && !link.deleted_at);
      return row ? { ...row } : null;
    }
    if (sql.startsWith('SELECT * FROM LINKS WHERE ID=?')) {
      const row = this.db.links.find(link => link.id === Number(this.args[0]) && !link.deleted_at);
      return row ? { ...row } : null;
    }
    if (sql.startsWith('SELECT ID,CODE FROM LINKS WHERE ID=?')) {
      const row = this.db.links.find(link => link.id === Number(this.args[0]) && !link.deleted_at);
      return row ? { id: row.id, code: row.code } : null;
    }
    if (sql.includes('COUNT(*) TOTAL_CLICKS')) return { total_clicks: 0, unique_visitors: 0 };
    throw new Error(`Unsupported first SQL: ${this.sql}`);
  }
  async all() {
    const sql = this.normalized();
    if (sql.includes('FROM LINKS L LEFT JOIN LINK_CLICKS')) return { results: this.db.links.map(row => ({ ...row, total_clicks: 0, unique_visitors: 0 })) };
    if (sql.startsWith('SELECT OCCURRED_AT')) return { results: [] };
    throw new Error(`Unsupported all SQL: ${this.sql}`);
  }
  async run() {
    const sql = this.normalized();
    if (sql.startsWith('INSERT INTO LINKS (CODE,DESTINATION_URL')) {
      const [code,destination_url,redirect_mode,title,is_active,expires_at,qr_enabled,safety_status,created_at,updated_at] = this.args;
      if (this.db.links.some(link => link.code === code && !link.deleted_at)) throw new Error('duplicate');
      const id = this.db.nextId++;
      this.db.links.push({ id, code, destination_url, redirect_mode, title, is_active, expires_at, qr_enabled, safety_status, safety_checked_at:null, created_at, updated_at, deleted_at:null });
      return { success:true, meta:{ last_row_id:id, changes:1 } };
    }
    if (sql.startsWith('UPDATE LINKS SET DESTINATION_URL=')) {
      const [destination_url,title,is_active,expires_at,qr_enabled,safety_status,safety_checked_at,updated_at,rawId] = this.args;
      const row = this.db.links.find(link => link.id === Number(rawId) && !link.deleted_at);
      if (row) Object.assign(row,{ destination_url,title,is_active,expires_at,qr_enabled,safety_status,safety_checked_at,updated_at });
      return { success:true, meta:{ changes:row?1:0 } };
    }
    if (sql.startsWith('INSERT INTO LINK_ADMIN_AUDIT')) {
      const [link_id,action,actor_type,details_json,occurred_at] = this.args;
      this.db.audit.push({ link_id,action,actor_type,details_json,occurred_at });
      return { success:true, meta:{ changes:1 } };
    }
    if (sql.startsWith('INSERT INTO LINK_CLICKS')) {
      this.db.clicks.push([...this.args]);
      return { success:true, meta:{ changes:1 } };
    }
    throw new Error(`Unsupported run SQL: ${this.sql}`);
  }
}

class FakeDB {
  constructor() {
    this.links = [
      { id:1, code:'pending-link', destination_url:'https://example.com/pending', redirect_mode:'path', title:null, is_active:1, expires_at:null, qr_enabled:1, safety_status:'pending', safety_checked_at:null, created_at:'2026-09-15T00:00:00.000Z', updated_at:'2026-09-15T00:00:00.000Z', deleted_at:null },
      { id:2, code:'approved-link', destination_url:'https://example.com/approved', redirect_mode:'path', title:null, is_active:1, expires_at:null, qr_enabled:1, safety_status:'approved', safety_checked_at:'2026-09-15T00:01:00.000Z', created_at:'2026-09-15T00:00:00.000Z', updated_at:'2026-09-15T00:01:00.000Z', deleted_at:null },
      { id:3, code:'blocked-link', destination_url:'https://example.com/blocked', redirect_mode:'path', title:null, is_active:1, expires_at:null, qr_enabled:1, safety_status:'blocked', safety_checked_at:'2026-09-15T00:01:00.000Z', created_at:'2026-09-15T00:00:00.000Z', updated_at:'2026-09-15T00:01:00.000Z', deleted_at:null },
      { id:4, code:'expired-link', destination_url:'https://example.com/expired', redirect_mode:'path', title:null, is_active:1, expires_at:'2020-01-01T00:00:00.000Z', qr_enabled:1, safety_status:'approved', safety_checked_at:'2026-09-15T00:01:00.000Z', created_at:'2026-09-15T00:00:00.000Z', updated_at:'2026-09-15T00:01:00.000Z', deleted_at:null }
    ];
    this.nextId = 5;
    this.audit = [];
    this.clicks = [];
  }
  prepare(sql) { return new FakeStatement(this, sql); }
}

const envFor = db => ({ DB:db, MASTER_ADMIN_SERVICE_TOKEN:'test-secret', ANALYTICS_HASH_SECRET:'' });
const adminRequest = (path, init={}) => new Request(`https://tinythor.example${path}`, { ...init, headers:{ authorization:'Bearer test-secret', ...(init.headers||{}) } });

async function jsonBody(response) { return { status:response.status, body:await response.json() }; }

test('pending, blocked, expired and inactive links cannot redirect', async () => {
  const db = new FakeDB();
  for (const code of ['pending-link','blocked-link','expired-link']) {
    const response = await worker.fetch(new Request(`https://tinythor.example/${code}`), envFor(db));
    assert.equal(response.status,404,`${code} should be unavailable`);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  db.links.find(link=>link.code==='approved-link').is_active=0;
  const inactive = await worker.fetch(new Request('https://tinythor.example/approved-link'), envFor(db));
  assert.equal(inactive.status,404);
});

test('approved links redirect without cache persistence', async () => {
  const db = new FakeDB();
  const response = await worker.fetch(new Request('https://tinythor.example/approved-link'), envFor(db));
  assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),'https://example.com/approved');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
});

test('admin endpoints require the service token', async () => {
  const db = new FakeDB();
  const response = await worker.fetch(new Request('https://tinythor.example/api/admin/links'), envFor(db));
  assert.equal(response.status,401);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('new links are created pending and audited', async () => {
  const db = new FakeDB();
  const result = await jsonBody(await worker.fetch(adminRequest('/api/admin/links', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ code:'new-link', destination_url:'https://example.com/new' })
  }), envFor(db)));
  assert.equal(result.status,201);
  assert.equal(result.body.safety_status,'pending');
  const row = db.links.find(link=>link.code==='new-link');
  assert.equal(row.safety_status,'pending');
  assert.equal(row.is_active,1);
  assert.equal(db.audit.at(-1).action,'create');
  const publicResponse = await worker.fetch(new Request('https://tinythor.example/new-link'), envFor(db));
  assert.equal(publicResponse.status,404);
});

test('invalid destination credentials and expiration values are rejected', async () => {
  const db = new FakeDB();
  const credentialed = await worker.fetch(adminRequest('/api/admin/links', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ code:'bad-url', destination_url:'https://user:pass@example.com/' })
  }), envFor(db));
  assert.equal(credentialed.status,400);
  const badExpiry = await worker.fetch(adminRequest('/api/admin/links', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ code:'bad-expiry', destination_url:'https://example.com/', expires_at:'not-a-date' })
  }), envFor(db));
  assert.equal(badExpiry.status,400);
});

test('safety status is validated and approval is timestamped and audited', async () => {
  const db = new FakeDB();
  const invalid = await worker.fetch(adminRequest('/api/admin/links/1', {
    method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({ safety_status:'anything' })
  }), envFor(db));
  assert.equal(invalid.status,400);

  const approved = await jsonBody(await worker.fetch(adminRequest('/api/admin/links/1', {
    method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({ safety_status:'approved' })
  }), envFor(db)));
  assert.equal(approved.status,200);
  assert.equal(approved.body.safety_status,'approved');
  const row = db.links.find(link=>link.id===1);
  assert.equal(row.safety_status,'approved');
  assert.match(row.safety_checked_at,/^\d{4}-\d{2}-\d{2}T/);
  assert.equal(db.audit.at(-1).action,'update');

  const publicResponse = await worker.fetch(new Request('https://tinythor.example/pending-link'), envFor(db));
  assert.equal(publicResponse.status,302);
});

test('schema and source preserve privacy and safety fields', async () => {
  const schema = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema,/safety_status TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(schema,/safety_checked_at TEXT/);
  assert.match(schema,/visitor_hash TEXT NOT NULL/);
  assert.doesNotMatch(schema,/raw_ip|ip_address/i);
  assert.match(source,/link\.safety_status !== "approved"/);
  assert.match(source,/"cache-control": "no-store"/);
});
