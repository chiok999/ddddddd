// Bundle the playback engine alone, so its behaviour can be tested directly
// against a mocked API. The app's own chunks are code-split and do not export
// the class, and testing a copy of the logic would prove nothing.
import { build } from 'vite';

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    emptyOutDir: true,
    lib: { entry: 'src/lib/playback.ts', formats: ['es'], fileName: () => 'playback.mjs' },
    minify: false,
    // hls.js is 500 KB of player we do not want to re-test; the test supplies its
    // own stand-in and asserts on the calls the engine makes.
    rollupOptions: { external: ['hls.js'] },
  },
});
console.log('dist-test/playback.mjs');
