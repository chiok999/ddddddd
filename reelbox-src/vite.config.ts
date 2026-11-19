import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';

// `allowedHosts: true` lets the sandbox preview proxy reach the dev server,
// whose Host header is not the sandbox hostname.
// The build is emitted here and copied into `solo-cinema/app/` by `npm run
// build` (see tools/publish.mjs), so the deploy is the repository and nothing
// else: `npm start` in solo-cinema finds the bundle already in place and has no
// build step to run on the host. Building directly into that directory does not
// work -- the prerender step runs the server bundle from the output directory and
// resolves its dependencies relative to it.
export default defineConfig({
  server: { port: 8792, host: '0.0.0.0', allowedHosts: true },
  preview: { port: 8793, host: '0.0.0.0', allowedHosts: true },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    // SPA mode: the build emits static files only. Troy serves them and stays
    // the single server on the panel's one assigned port -- there is no second
    // process and no build step on the host.
    tanstackStart({
      // Only the shell is needed: every page becomes the same document and the
      // client router renders it. Prerendering each route would bake catalog
      // data into an artifact that has to be rebuilt whenever a provider
      // changes, which is the opposite of what this app needs.
      spa: { enabled: true, prerender: { enabled: false } },
    }),
    viteReact(),
  ],
});
