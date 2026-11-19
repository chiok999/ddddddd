import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';

// `allowedHosts: true` lets the sandbox preview proxy reach the dev server,
// whose Host header is not the sandbox hostname.
export default defineConfig({
  server: { port: 8792, host: '0.0.0.0', allowedHosts: true },
  preview: { port: 8793, host: '0.0.0.0', allowedHosts: true },
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
