import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target = env.VITE_API_PROXY || 'http://127.0.0.1:3001';
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      proxy: { '/api': { target }, '/auth': { target }, '/health': { target } },
    },
    // The portal CSP permits self-hosted fonts only, including small subsets.
    build: { sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
  };
});
