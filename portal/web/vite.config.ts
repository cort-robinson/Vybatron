import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The first screen's text font, preloaded so it downloads alongside the script instead of after
// React renders the first text. Fonts always load in CORS mode, so the preload needs crossorigin
// to be reused. Hashed names come from the build, so this runs after bundling.
const preloadedFonts = [/^assets\/archivo-latin-wdth-normal-[\w-]{8}\.woff2$/];
function preloadFonts(): Plugin {
  return {
    name: 'vybertron-preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }) {
        const files = Object.keys(bundle || {});
        return preloadedFonts.map(pattern => {
          const file = files.find(name => pattern.test(name));
          if (!file) throw new Error(`No built font matches ${pattern}`);
          return { tag: 'link', attrs: { rel: 'preload', href: `/${file}`, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' };
        });
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target = env.VITE_API_PROXY || 'http://127.0.0.1:3001';
  return {
    plugins: [react(), preloadFonts()],
    server: {
      host: '127.0.0.1',
      proxy: { '/api': { target }, '/auth': { target }, '/health': { target } },
    },
    // The portal CSP permits self-hosted fonts only, including small subsets.
    build: { sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
  };
});
