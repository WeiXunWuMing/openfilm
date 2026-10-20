import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../shell/vite.config.ts';

const chat = join(dirname(fileURLToPath(import.meta.url)), '../chat/src');
const importers = [join(chat, 'App.tsx'), join(chat, 'App.tsx').replaceAll('\\', '/')];

test('chat aliases resolve to the chat with both native and Vite path separators', () => {
  const aliases = config.plugins.find((plugin) => plugin.name === 'openfilm-two-trees');
  for (const importer of importers) {
    const resolved = aliases.resolveId.call({ resolve: (path) => path }, '@/components/GenerationOptions', importer, {});
    assert.equal(resolved, join(chat, 'components/GenerationOptions'));
  }
});

test('chat CSS stays scoped with both native and Vite path separators', () => {
  const scope = config.css.postcss.plugins[0];
  for (const importer of importers) {
    const rule = { selectors: ['.example'] };
    scope.Once({ walkRules: (visit) => visit(rule) }, { result: { opts: { from: importer } } });
    assert.deepEqual(rule.selectors, ['.of-chat .example']);
  }
});
