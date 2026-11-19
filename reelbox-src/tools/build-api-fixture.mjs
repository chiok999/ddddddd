// Bundle the API layer alone so its request/response contract can be asserted
// directly. The app's chunks are minified and do not export `api` by name.
import { build } from 'vite';

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    // Shared with the engine fixture, so the directory is cleared once, by the
    // engine build, and both entries are written here.
    emptyOutDir: false,
    // Two entries: the API contract, and the item store, which is what decides
    // whether a tapped card can be opened at all.
    lib: {
      entry: { api: 'src/lib/api.ts', 'item-store': 'src/lib/item-store.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.mjs`,
    },
    minify: false,
  },
});
console.log('dist-test/api.mjs');
