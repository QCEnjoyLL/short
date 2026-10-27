import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequest as create } from '../functions/create.js';
import { onRequestGet as redirect, onRequestHead as head, onRequest as otherMethod } from '../functions/[id].js';

const schema = readFileSync(new URL('../short.sql', import.meta.url), 'utf8');
const token = 'test-only-token';

function fixture(t) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schema);
    t.after(() => sqlite.close());
    const calls = [];
    const DB = {
        prepare(sql) {
            const statement = sqlite.prepare(sql);
            let values = [];
            return {
                bind(...args) { values = args; return this; },
                async first() { calls.push({ sql, values }); return statement.get(...values) ?? null; },
                async run() {
                    calls.push({ sql, values });
                    const result = statement.run(...values);
                    return { success: true, meta: { changes: Number(result.changes) } };
                },
            };
        },
    };
    const env = { DB, CREATE_TOKEN: token };
    return { sqlite, env, calls };
}

function createRequest(payload = { url: 'https://example.com/page' }, options = {}) {
    const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers });
    return new Request('https://short.test/create', {
        method: options.method ?? 'POST', headers,
        ...((options.method === 'GET' || options.method === 'OPTIONS') ? {} : { body: options.body ?? JSON.stringify(payload) }),
    });
}

function insert(sqlite, slug = 'hello', url = 'https://example.com/page', status = 1) {
    sqlite.prepare('INSERT INTO links (slug, url, status) VALUES (?, ?, ?)').run(slug, url, status);
}

function visit(env, slug = 'hello', options = {}) {
    const pending = [];
    return {
        env, params: { id: slug },
        request: new Request(`https://short.test/${encodeURIComponent(slug)}`, options),
        pending,
        waitUntil(promise) { pending.push(promise); },
    };
}

test('creation fails closed without a configured token and never touches D1', async t => {
    const { env, calls } = fixture(t);
    for (const value of [undefined, '', '   ']) {
        env.CREATE_TOKEN = value;
        assert.equal((await create({ request: createRequest(), env })).status, 503);
    }
    assert.equal(calls.length, 0);
});

test('missing, incorrect and oversized passwords are rejected before database access', async t => {
    const { env, calls } = fixture(t);
    for (const authorization of ['', 'Bearer wrong', 'Basic wrong', `Bearer ${'x'.repeat(1025)}`]) {
        const response = await create({ env, request: createRequest(undefined, { headers: { Authorization: authorization } }) });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(calls.length, 0);
});

for (const flag of [undefined, null, '', 'false', 'FALSE', 'TRUE', '1', ' true ', false, true, 1]) {
    test(`PUBLIC_CREATE=${JSON.stringify(flag)} (${typeof flag}) does not disable password protection`, async t => {
        const { env, calls } = fixture(t);
        env.PUBLIC_CREATE = flag;
        const request = () => createRequest(undefined, { headers: { Authorization: '' } });
        assert.equal((await create({ env, request: request() })).status, 401);
        delete env.CREATE_TOKEN;
        assert.equal((await create({ env, request: request() })).status, 503);
        assert.equal(calls.length, 0);
    });
}

test('clients cannot enable public creation through query parameters, headers or JSON', async t => {
    const { env, calls } = fixture(t);
    const request = new Request('https://short.test/create?PUBLIC_CREATE=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', PUBLIC_CREATE: 'true' },
        body: JSON.stringify({ url: 'https://example.com', PUBLIC_CREATE: 'true' }),
    });
    assert.equal((await create({ env, request })).status, 401);
    assert.equal(calls.length, 0);
});

test('explicit public mode allows creation without a configured secret or bearer token', async t => {
    const { env, sqlite } = fixture(t);
    env.PUBLIC_CREATE = 'true';
    delete env.CREATE_TOKEN;
    const response = await create({ env, request: createRequest(undefined, { headers: { Authorization: '' } }) });
    assert.equal(response.status, 200);
    assert.match((await response.json()).slug, /^[A-Za-z0-9]{6}$/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 1);
});

test('public mode ignores stale passwords but retains origin and input validation', async t => {
    const { env, calls } = fixture(t);
    env.PUBLIC_CREATE = 'true';
    assert.equal((await create({ env, request: createRequest(undefined, { headers: {
        Authorization: 'Bearer stale-password', Origin: 'https://evil.test',
    } }) })).status, 403);
    assert.equal((await create({ env, request: createRequest({ url: 'javascript:alert(1)' }) })).status, 400);
    assert.equal((await create({ env, request: createRequest(undefined, { method: 'GET' }) })).status, 405);
    assert.equal(calls.length, 0);
    assert.equal((await create({ env, request: createRequest(undefined, { headers: { Authorization: 'Bearer stale-password' } }) })).status, 200);
});

test('switching public mode off restores password protection without changing existing links', async t => {
    const { env, sqlite } = fixture(t);
    env.PUBLIC_CREATE = 'true';
    const anonymousRequest = () => createRequest(undefined, { headers: { Authorization: '' } });
    const original = await (await create({ env, request: anonymousRequest() })).json();
    env.PUBLIC_CREATE = 'false';
    assert.equal((await create({ env, request: anonymousRequest() })).status, 401);
    assert.equal((await create({ env, request: createRequest(undefined, { headers: { Authorization: 'Bearer wrong' } }) })).status, 401);
    const authenticated = await create({ env, request: createRequest() });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), original);
    assert.equal((await redirect(visit(env, original.slug))).status, 302);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 1);
});

test('only POST is accepted and CORS is not open to arbitrary sites', async t => {
    const { env, calls } = fixture(t);
    const get = await create({ env, request: createRequest(undefined, { method: 'GET' }) });
    assert.equal(get.status, 405);
    const options = await create({ env, request: createRequest(undefined, { method: 'OPTIONS' }) });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('Access-Control-Allow-Origin'), null);
    const crossOrigin = await create({ env, request: createRequest(undefined, { headers: { Origin: 'https://evil.test' } }) });
    assert.equal(crossOrigin.status, 403);
    assert.equal(calls.length, 0);
});

test('malformed JSON and wrong content types are client errors', async t => {
    const { env, calls } = fixture(t);
    assert.equal((await create({ env, request: createRequest(undefined, { body: '{' }) })).status, 400);
    assert.equal((await create({ env, request: createRequest(undefined, { headers: { 'Content-Type': 'text/plain' } }) })).status, 415);
    assert.equal(calls.length, 0);
});

for (const payload of [null, [], 1, 'text', {}, { url: null }, { url: 123 }, { url: {} }]) {
    test(`rejects invalid JSON shape ${JSON.stringify(payload)}`, async t => {
        const { env } = fixture(t);
        assert.equal((await create({ env, request: createRequest(payload) })).status, 400);
    });
}

test('body limits check actual streamed bytes, not just Content-Length', async t => {
    const { env, calls } = fixture(t);
    for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': '999999' }]) {
        const request = createRequest(undefined, { body: JSON.stringify({ url: 'https://example.com', padding: 'x'.repeat(17000) }), headers });
        assert.equal((await create({ env, request })).status, 413);
    }
    const request = new Request('https://short.test/create', {
        method: 'POST', duplex: 'half',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array(9000));
            controller.enqueue(new Uint8Array(9000));
            controller.close();
        } }),
    });
    assert.equal((await create({ env, request })).status, 413);
    assert.equal(calls.length, 0);
});

for (const url of ['', 'javascript:alert(1)', 'ftp://example.com', 'https://', 'https://user:pass@example.com',
    'https://short.test/another', 'https://example.com/\npath', 'https://example.com/' + 'a'.repeat(8192)]) {
    test(`rejects invalid or recursive URL ${url.slice(0, 60)}`, async t => {
        const { env } = fixture(t);
        assert.equal((await create({ env, request: createRequest({ url }) })).status, 400);
    });
}

for (const slug of [null, 7, {}, '', 'x', 'x'.repeat(33), 'a/b', 'a.b', "a'", 'create', 'CREATE', 'asset', '_routes']) {
    test(`rejects invalid or reserved slug ${JSON.stringify(slug)}`, async t => {
        const { env } = fixture(t);
        assert.equal((await create({ env, request: createRequest({ url: 'https://example.com', slug }) })).status, 400);
    });
}

test('quotes in URLs and user agents are data, not SQL; client IP comes from Cloudflare', async t => {
    const { env, sqlite } = fixture(t);
    const url = "https://example.com/?q=';DROP TABLE links;--";
    const response = await create({ env, request: createRequest({ url, slug: 'my-link_1' }, {
        headers: { 'User-Agent': "browser's agent", 'CF-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': 'fake' },
    }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { slug: 'my-link_1', link: 'https://short.test/my-link_1' });
    const row = sqlite.prepare('SELECT * FROM links').get();
    assert.equal(row.url, url);
    assert.equal(row.ua, "browser's agent");
    assert.equal(row.ip, '203.0.113.1');
    assert.match(row.create_time, /^\d{4}-\d{2}-\d{2}T/);
});

test('six-character random slugs and URL reuse avoid unnecessary writes', async t => {
    const { env, sqlite } = fixture(t);
    const first = await (await create({ env, request: createRequest() })).json();
    assert.match(first.slug, /^[A-Za-z0-9]{6}$/);
    const second = await (await create({ env, request: createRequest() })).json();
    assert.deepEqual(second, first);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 1);
});

test('custom slug retries are idempotent; conflicts do not overwrite links', async t => {
    const { env, sqlite } = fixture(t);
    const payload = { url: 'https://example.com/page', slug: 'custom' };
    const a = await create({ env, request: createRequest(payload) });
    const b = await create({ env, request: createRequest(payload) });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), await a.json());
    const conflict = await create({ env, request: createRequest({ ...payload, url: 'https://other.test/' }) });
    assert.equal(conflict.status, 409);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 1);
    assert.equal(sqlite.prepare('SELECT url FROM links').get().url, payload.url);
});

test('concurrent requests cannot claim the same custom slug for different URLs', async t => {
    const { env, sqlite } = fixture(t);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => create({
        env, request: createRequest({ url: `https://example.com/${i}`, slug: 'contended' }),
    })));
    assert.equal(results.filter(response => response.status === 200).length, 1);
    assert.equal(results.filter(response => response.status === 409).length, 7);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 1);
});

test('random slug collisions retry without overwriting and eventually succeed', async t => {
    const { env, sqlite } = fixture(t);
    insert(sqlite, '000000', 'https://existing.test');
    let calls = 0;
    t.mock.method(crypto, 'getRandomValues', bytes => { bytes.fill(calls++ === 0 ? 0 : 1); return bytes; });
    const response = await create({ env, request: createRequest() });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).slug, '111111');
    assert.equal(sqlite.prepare("SELECT url FROM links WHERE slug = '000000'").get().url, 'https://existing.test');
});

test('persistent collisions are bounded to five attempts', async t => {
    const { env, sqlite } = fixture(t);
    insert(sqlite, '000000', 'https://existing.test');
    const random = t.mock.method(crypto, 'getRandomValues', bytes => { bytes.fill(0); return bytes; });
    assert.equal((await create({ env, request: createRequest() })).status, 503);
    assert.equal(random.mock.callCount(), 5);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 1);
});

test('disabled links neither redirect nor get reused or silently re-enabled', async t => {
    const { env, sqlite } = fixture(t);
    insert(sqlite, 'disabled', 'https://example.com/page', 0);
    assert.equal((await redirect(visit(env, 'disabled'))).status, 404);
    assert.equal((await create({ env, request: createRequest({ url: 'https://example.com/page', slug: 'disabled' }) })).status, 409);
    const result = await (await create({ env, request: createRequest() })).json();
    assert.notEqual(result.slug, 'disabled');
});

test('database failures return generic messages, never SQL details', async t => {
    const { env, sqlite } = fixture(t);
    t.mock.method(console, 'error', () => {});
    sqlite.exec('DROP TABLE links');
    const response = await create({ env, request: createRequest() });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /SQLITE|no such table|SELECT/);
    assert.equal((await redirect(visit(env))).status, 503);
});

test('public redirects use indexed lookup, need no token and do not write logs by default', async t => {
    const { env, sqlite, calls } = fixture(t);
    delete env.CREATE_TOKEN;
    insert(sqlite);
    const context = visit(env);
    const response = await redirect(context);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://example.com/page');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls.length, 1);
    assert.equal(context.pending.length, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM logs').get().count, 0);
    const plan = sqlite.prepare('EXPLAIN QUERY PLAN SELECT url FROM links WHERE slug = ? AND status = 1 ORDER BY id LIMIT 1').all('hello');
    assert.match(plan.map(row => row.detail).join(' '), /USING INDEX links_slug_unique/);
    const urlPlan = sqlite.prepare('EXPLAIN QUERY PLAN SELECT slug FROM links WHERE url = ? AND status = 1 ORDER BY id LIMIT 1').all('https://example.com/page');
    assert.match(urlPlan.map(row => row.detail).join(' '), /USING INDEX links_url_index/);
});

test('optional visit logs are bound and scheduled with waitUntil', async t => {
    const { env, sqlite } = fixture(t);
    env.LOG_VISITS = 'true';
    insert(sqlite);
    const context = visit(env, 'hello', { headers: { Referer: "https://referrer.test/it's", 'User-Agent': "test's UA" } });
    assert.equal((await redirect(context)).status, 302);
    assert.equal(context.pending.length, 1);
    await Promise.all(context.pending);
    const row = sqlite.prepare('SELECT * FROM logs').get();
    assert.equal(row.referer, "https://referrer.test/it's");
    assert.equal(row.ua, "test's UA");
});

test('a failing logger does not break redirects', async t => {
    const { env, sqlite } = fixture(t);
    t.mock.method(console, 'error', () => {});
    env.LOG_VISITS = 'true';
    insert(sqlite);
    sqlite.exec('DROP TABLE logs');
    const context = visit(env);
    assert.equal((await redirect(context)).status, 302);
    await Promise.all(context.pending);
});

test('HEAD redirects and 404s have no body and never record visits', async t => {
    const { env, sqlite } = fixture(t);
    env.LOG_VISITS = 'true';
    insert(sqlite);
    const context = visit(env, 'hello', { method: 'HEAD' });
    const response = await head(context);
    assert.equal(response.status, 302);
    assert.equal(await response.text(), '');
    assert.equal(context.pending.length, 0);
    const missing = await head(visit(env, 'missing', { method: 'HEAD' }));
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), '');
    assert.equal(otherMethod().status, 405);
});

test('missing and SQL-like slugs return 404; legacy non-ASCII slugs keep working', async t => {
    const { env, sqlite } = fixture(t);
    insert(sqlite, '\u4e2d\u6587');
    assert.equal((await redirect(visit(env, '\u4e2d\u6587'))).status, 302);
    assert.equal((await redirect(visit(env, "' OR 1=1--"))).status, 404);
    const missing = await redirect(visit(env, 'missing'));
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('Content-Type'), /text\/html/);
});

test('unsafe URLs already in the database cannot produce executable redirects', async t => {
    const { env, sqlite } = fixture(t);
    t.mock.method(console, 'error', () => {});
    insert(sqlite, 'unsafe', 'javascript:alert(1)');
    assert.equal((await redirect(visit(env, 'unsafe'))).status, 503);
});

test('schema can be applied repeatedly without deleting existing links or logs', t => {
    const { sqlite } = fixture(t);
    insert(sqlite);
    sqlite.prepare('INSERT INTO logs (slug) VALUES (?)').run('hello');
    sqlite.exec(schema);
    sqlite.exec(schema);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM logs').get().count, 1);
});

test('upgrading the original schema preserves rows and refuses to delete duplicate slugs', t => {
    const sqlite = new DatabaseSync(':memory:');
    t.after(() => sqlite.close());
    sqlite.exec(`CREATE TABLE links (id INTEGER PRIMARY KEY, url TEXT, slug TEXT, ua TEXT, ip TEXT, status INT, create_time DATE)`);
    insert(sqlite, 'duplicate', 'https://one.test');
    insert(sqlite, 'duplicate', 'https://two.test');
    assert.throws(() => sqlite.exec(schema), /UNIQUE/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM links').get().count, 2);
});

test('original schema upgrades without changing existing link or log contents', t => {
    const sqlite = new DatabaseSync(':memory:');
    t.after(() => sqlite.close());
    sqlite.exec(`CREATE TABLE links (id INTEGER PRIMARY KEY, url TEXT, slug TEXT, ua TEXT, ip TEXT, status INT, create_time DATE);
        CREATE TABLE logs (id INTEGER PRIMARY KEY, url TEXT, slug TEXT, referer TEXT, ua TEXT, ip TEXT, create_time DATE)`);
    insert(sqlite, 'aB12', 'https://example.com/original');
    sqlite.prepare('INSERT INTO logs (slug, create_time) VALUES (?, ?)').run('aB12', 'legacy timestamp');
    const link = sqlite.prepare('SELECT * FROM links').get();
    const log = sqlite.prepare('SELECT * FROM logs').get();
    sqlite.exec(schema);
    assert.deepEqual(sqlite.prepare('SELECT * FROM links').get(), link);
    assert.deepEqual(sqlite.prepare('SELECT * FROM logs').get(), log);
    assert.throws(() => insert(sqlite, 'aB12', 'https://another.test'), /UNIQUE/);
});
