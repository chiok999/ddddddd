// Bundle the API layer alone so its request/response contract can be asserted
// directly. The app's chunks are minified and do not export `api` by name.
import { build } from 'vite';

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    emptyOutDir: false,
    lib: { entry: 'src/lib/api.ts', formats: ['es'], fileName: () => 'api.mjs' },
    minify: false,
  },
});
console.log('dist-test/api.mjs');
