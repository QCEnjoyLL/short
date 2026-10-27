import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('build publishes only public assets and excludes static requests from Functions', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root });
    assert.deepEqual(readdirSync(new URL('../dist/', import.meta.url)).sort(), ['404.html', '_routes.json', 'asset', 'index.html']);
    const routes = JSON.parse(readFileSync(new URL('../dist/_routes.json', import.meta.url), 'utf8'));
    assert.deepEqual(routes.exclude, ['/', '/index.html', '/404.html', '/asset/*']);
    assert.deepEqual(routes.include, ['/*']);
    assert.equal(readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8'),
        readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
});
