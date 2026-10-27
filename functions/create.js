const MAX_BODY_BYTES = 16 * 1024;
const RESERVED_SLUGS = new Set(['create', 'asset', 'index', '_worker', '_routes', '_headers', '_redirects']);

function json(body, status = 200, headers = {}) {
    return Response.json(body, {
        status,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
    });
}

async function verifyToken(expected, supplied) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    // Web Crypto verifies the MAC without a timing-sensitive string comparison.
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
    return crypto.subtle.verify('HMAC', key, signature, encoder.encode(supplied));
}

async function readJson(request) {
    if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
        throw new RangeError('Request body too large.');
    }
    const reader = request.body?.getReader();
    if (!reader) throw new SyntaxError('Missing request body.');
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
                await reader.cancel();
                throw new RangeError('Request body too large.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function randomSlug() {
    const characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let slug = '';
    while (slug.length < 6) {
        for (const byte of crypto.getRandomValues(new Uint8Array(12))) {
            if (byte < 248) slug += characters[byte % characters.length];
            if (slug.length === 6) break;
        }
    }
    return slug;
}

export async function onRequest({ request, env }) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS', 'Cache-Control': 'no-store' } });
    }
    if (request.method !== 'POST') {
        return json({ message: 'Method not allowed.' }, 405, { Allow: 'POST, OPTIONS' });
    }
    const origin = new URL(request.url).origin;
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && requestOrigin !== origin) {
        return json({ message: 'Cross-origin creation is not allowed.' }, 403);
    }
    // Public creation is opt-in; missing or mistyped flags keep password protection.
    if (env.PUBLIC_CREATE !== 'true') {
        if (typeof env.CREATE_TOKEN !== 'string' || !env.CREATE_TOKEN.trim()) {
            return json({ message: 'Creation is disabled. Configure the CREATE_TOKEN secret first.' }, 503);
        }
        const supplied = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
        if (!supplied || supplied.length > 1024 || !await verifyToken(env.CREATE_TOKEN, supplied)) {
            return json({ message: 'Invalid creation password.' }, 401, { 'WWW-Authenticate': 'Bearer' });
        }
    }
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json({ message: 'Content-Type must be application/json.' }, 415);
    }

    let payload;
    try {
        payload = await readJson(request);
    } catch (error) {
        return json({ message: error instanceof RangeError ? 'Request body too large.' : 'Invalid JSON body.' },
            error instanceof RangeError ? 413 : 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.url !== 'string') {
        return json({ message: 'A URL string is required.' }, 400);
    }
    const url = payload.url.trim();
    let target;
    try {
        if (url.length > 8192 || !/^https?:\/\//i.test(url) || /[\u0000-\u001f\u007f]/.test(url)) throw new Error();
        target = new URL(url);
        if (!target.hostname || target.username || target.password) throw new Error();
    } catch {
        return json({ message: 'Provide a valid HTTP(S) URL without embedded credentials (maximum 8192 characters).' }, 400);
    }
    if (target.hostname === new URL(origin).hostname) {
        return json({ message: 'You cannot shorten a link to the same domain.' }, 400);
    }
    const slug = payload.slug;
    if (slug !== undefined && (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{2,32}$/.test(slug) || RESERVED_SLUGS.has(slug.toLowerCase()))) {
        return json({ message: 'Slug must be 2-32 letters, digits, underscores or hyphens, and not a reserved path.' }, 400);
    }

    try {
        if (!slug) {
            const existing = await env.DB.prepare('SELECT slug FROM links WHERE url = ?1 AND status = 1 ORDER BY id LIMIT 1')
                .bind(url).first();
            if (existing) return json({ slug: existing.slug, link: `${origin}/${encodeURIComponent(existing.slug)}` });
        }
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = slug || randomSlug();
            // The unique index arbitrates concurrent requests; never overwrite an existing link.
            const result = await env.DB.prepare(`INSERT INTO links (url, slug, ip, status, ua, create_time)
                VALUES (?1, ?2, ?3, 1, ?4, ?5) ON CONFLICT(slug) DO NOTHING`)
                .bind(url, candidate, request.headers.get('CF-Connecting-IP'),
                    request.headers.get('User-Agent')?.slice(0, 512) ?? null, new Date().toISOString()).run();
            if (result.meta.changes > 0) return json({ slug: candidate, link: `${origin}/${candidate}` });
            if (slug) {
                const existing = await env.DB.prepare('SELECT url, status FROM links WHERE slug = ?1 LIMIT 1').bind(slug).first();
                if (existing?.url === url && existing.status === 1) return json({ slug, link: `${origin}/${slug}` });
                return json({ message: 'Slug already exists.' }, 409);
            }
        }
        return json({ message: 'Could not allocate a short link. Please retry.' }, 503);
    } catch (error) {
        console.error('Short link creation failed', error);
        return json({ message: 'Unable to save the link. Check the database binding and schema.' }, 503);
    }
}
