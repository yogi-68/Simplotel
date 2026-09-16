import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  // Bundle the workspace contract package so the deployed artifact needs no
  // workspace resolution at runtime (Render installs prod deps only).
  noExternal: ['@hotel/contracts'],
  // JSON data files are imported with `assert`-free resolveJsonModule and get
  // inlined by tsup, so the dist bundle is fully self-contained.
});
