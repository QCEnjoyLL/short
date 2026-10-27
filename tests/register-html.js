import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

// Match Wrangler's HTML text imports without adding a test framework or bundler.
registerHooks({
    load(url, context, nextLoad) {
        if (url.startsWith('file:') && url.endsWith('.html')) {
            return { format: 'module', source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`, shortCircuit: true };
        }
        return nextLoad(url, context);
    },
});
