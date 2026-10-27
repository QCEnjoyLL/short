import page404 from './404.html';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

async function recordVisit({ request, env }, url, slug) {
    await env.DB.prepare(`INSERT INTO logs (url, slug, ip, referer, ua, create_time)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(url, slug, request.headers.get('CF-Connecting-IP'),
            request.headers.get('Referer')?.slice(0, 2048) ?? null,
            request.headers.get('User-Agent')?.slice(0, 512) ?? null, new Date().toISOString()).run();
}

async function redirect(context) {
    const { request, env, params } = context;
    try {
        // Do not restrict legacy slugs to the newer creation format.
        const link = await env.DB.prepare('SELECT url FROM links WHERE slug = ?1 AND status = 1 ORDER BY id LIMIT 1')
            .bind(params.id).first();
        if (!link) {
            return new Response(request.method === 'HEAD' ? null : page404, {
                status: 404, headers: { ...headers, 'Content-Type': 'text/html;charset=UTF-8' },
            });
        }
        const target = new URL(link.url);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Invalid stored redirect URL.');
        if (env.LOG_VISITS === 'true' && request.method === 'GET') {
            context.waitUntil(recordVisit(context, link.url, params.id).catch(error => {
                console.error('Visit logging failed', error);
            }));
        }
        return new Response(null, {
            status: 302, headers: { ...headers, Location: target.href, 'Referrer-Policy': 'no-referrer' },
        });
    } catch (error) {
        console.error('Short link lookup failed', error);
        return new Response(request.method === 'HEAD' ? null : 'Service temporarily unavailable.', {
            status: 503, headers: { ...headers, 'Content-Type': 'text/plain;charset=UTF-8', 'Retry-After': '60' },
        });
    }
}

export const onRequestGet = redirect;
export const onRequestHead = redirect;

export function onRequest() {
    return new Response('Method not allowed.', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
}
