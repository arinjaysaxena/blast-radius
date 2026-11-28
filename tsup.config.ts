import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli/bin.ts', action: 'src/action/bin.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  external: ['typescript'],
  // The package `bin` points at dist/cli.js, which needs a shebang to be executable.
  onSuccess: () => {
    const file = 'dist/cli.js';
    const src = readFileSync(file, 'utf8');
    if (!src.startsWith('#!')) writeFileSync(file, `#!/usr/bin/env node\n${src}`);
    chmodSync(file, 0o755);
    return Promise.resolve();
  },
});
