import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
if (dirname(output) !== root || output === root) throw new Error('Unsafe build output path.');
await rm(output, { recursive: true, force: true });
await mkdir(output);
// Only publish public assets, never source code, SQL, tests or local secrets.
await cp(join(root, 'index.html'), join(output, 'index.html'));
await cp(join(root, 'functions', '404.html'), join(output, '404.html'));
await cp(join(root, 'asset'), join(output, 'asset'), { recursive: true });
await writeFile(join(output, '_routes.json'), JSON.stringify({
    version: 1,
    include: ['/*'],
    exclude: ['/', '/index.html', '/404.html', '/asset/*'],
}, null, 2));
