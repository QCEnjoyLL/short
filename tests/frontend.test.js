import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function page(options = {}) {
    const calls = [];
    let focused = false;
    let selected = false;
    const refs = {
        settings: { open: false },
        token: { focus() { focused = true; } },
        result: { select() { selected = true; } },
    };
    const app = runInNewContext(`${script}; app`, {
        URL, Error, SyntaxError,
        location: { origin: 'https://short.test' },
        navigator: options.navigator ?? { clipboard: { async writeText() {} } },
        document: { execCommand: options.copy ?? (() => false) },
        async fetch(url, init) {
            calls.push({ url, init });
            return options.response ? options.response() : Response.json({ slug: 'abcdef', link: 'https://short.test/abcdef' });
        },
    });
    app.url = 'https://example.com/page';
    return { app, refs, calls, nextTick: callback => callback(), focused: () => focused, selected: () => selected };
}

test('password mode prompts on server rejection rather than blocking public creation locally', async () => {
    const { app, refs, calls, nextTick, focused } = page({
        response: () => Response.json({ message: 'Invalid creation password.' }, { status: 401 }),
    });
    await app.submit(refs, nextTick);
    assert.equal(refs.settings.open, true);
    assert.equal(focused(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(app.alert.type, 'error');
    assert.equal(app.loading, false);
});

test('public creation succeeds without a password or Authorization header', async () => {
    const { app, refs, calls, nextTick, focused } = page();
    await app.submit(refs, nextTick);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(app.result, 'https://short.test/abcdef');
    assert.equal(app.alert.type, 'success');
    assert.equal(app.loading, false);
    assert.equal(refs.settings.open, false);
    assert.equal(focused(), false);
});

test('generation sends password only as a bearer header and preserves the target URL', async () => {
    const { app, refs, calls, nextTick, selected } = page();
    app.token = 'test-only-password';
    app.slug = ' custom ';
    await app.submit(refs, nextTick);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only-password');
    assert.deepEqual(JSON.parse(calls[0].init.body), { url: 'https://example.com/page', slug: 'custom' });
    assert.equal(app.url, 'https://example.com/page');
    assert.equal(app.result, 'https://short.test/abcdef');
    assert.equal(app.alert.type, 'success');
    assert.equal(app.loading, false);
    assert.equal(selected(), true);
    assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
});

test('clipboard failures do not turn successful creation into an error', async () => {
    const { app, refs, nextTick } = page({
        navigator: { clipboard: { async writeText() { throw new Error('Permission denied'); } } },
        copy() { throw new Error('Copy unavailable'); },
    });
    app.token = 'test-only-password';
    await app.submit(refs, nextTick);
    assert.equal(app.alert.type, 'success');
    assert.equal(app.result, 'https://short.test/abcdef');
    assert.equal(app.loading, false);
});

test('older browsers can fall back to selecting and copying the result', async () => {
    let copied = false;
    const { app, refs, nextTick } = page({ navigator: {}, copy() { copied = true; return true; } });
    app.token = 'test-only-password';
    await app.submit(refs, nextTick);
    assert.equal(app.alert.type, 'success');
    assert.equal(copied, true);
});

for (const status of [400, 401, 403, 409, 413, 503]) {
    test(`HTTP ${status} is presented as an error and resets loading`, async () => {
        const { app, refs, nextTick, focused } = page({ response: () => Response.json({ message: 'Server error' }, { status }) });
        app.token = 'test-only-password';
        await app.submit(refs, nextTick);
        assert.equal(app.alert.type, 'error');
        assert.equal(app.loading, false);
        assert.equal(app.result, '');
        if (status === 401) assert.equal(focused(), true);
    });
}

test('invalid JSON, network errors and invalid result URLs are recoverable', async () => {
    for (const response of [
        () => new Response('not JSON', { status: 502 }),
        () => { throw new Error('Network offline'); },
        () => Response.json({ link: 'https://evil.test/path' }),
        () => Response.json({}),
    ]) {
        const { app, refs, nextTick } = page({ response });
        app.token = 'test-only-password';
        await app.submit(refs, nextTick);
        assert.equal(app.alert.type, 'error');
        assert.equal(app.loading, false);
        assert.equal(app.result, '');
    }
});

test('duplicate submissions are ignored while the request is in flight', async () => {
    const { app, refs, calls, nextTick } = page();
    app.token = 'test-only-password';
    app.loading = true;
    await app.submit(refs, nextTick);
    assert.equal(calls.length, 0);
});

test('frontend rejects non-web URLs and embedded credentials', () => {
    const { app } = page();
    for (const url of ['javascript:alert(1)', 'ftp://example.com', 'https://user:pass@example.com', 'invalid']) {
        app.url = url;
        assert.equal(app.isValidated(), true);
    }
    app.url = '  https://example.com/path  ';
    assert.equal(app.isValidated(), false);
});
