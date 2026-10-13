import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared'),
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query-vendor': ['@tanstack/react-query'],
          'flow-vendor': ['@xyflow/react'],
        },
      },
    },
  },
  // Dev-only HMR server. Normal use is `npm run build && npm start`, serving
  // everything from port 4319 (see server.mjs) — do not open 5173 for that.
  // 5173 exists solely for live frontend editing; it proxies API traffic to
  // the 4319 backend below. Client source must never live under a top-level
  // directory named api/events/ops — those path prefixes are proxied here,
  // so a source file at e.g. src/client/api/foo.ts gets its own dev-server
  // module request intercepted by the proxy and 404s instead of loading.
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4319',
      '/events': 'http://127.0.0.1:4319',
      '/ops': 'http://127.0.0.1:4319',
    },
  },
});
