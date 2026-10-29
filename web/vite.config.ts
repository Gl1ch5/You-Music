import { defineConfig } from 'vitest/config';

// Default build goes straight into the Android assets; WebViewAssetLoader serves it from https://appassets.androidplatform.net/.
// `--mode web` builds the web player and the Windows/Linux app (served by desktop/youmusic) into dist-web/:
// relative paths (it lives under /youmusic/app/ on the site) and a CSP that lets <audio> play the backend's streams.
export default defineConfig(({ mode }) => ({
  base: mode === 'web' ? './' : '/',
  build: {
    outDir: mode === 'web' ? 'dist-web' : '../android/app/src/main/assets/ui',
    emptyOutDir: true,
    target: 'chrome100',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
  },
  plugins: [
    {
      name: 'web-csp',
      transformIndexHtml: (html) =>
        mode === 'web'
          ? html
              .replace("media-src 'none'", "media-src 'self' blob:")
              .replace("connect-src 'self'", "connect-src 'self' https:")
              .replace('<title>You Music</title>', '<title>You Music</title>\n    <link rel="icon" type="image/png" sizes="32x32" href="./icons/icon-32.png" />\n    <link rel="icon" type="image/png" sizes="192x192" href="./icons/icon-192.png" />\n    <link rel="apple-touch-icon" href="./icons/apple-touch.png" />\n    <link rel="manifest" href="./manifest.webmanifest" />')
          : html,
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
}));
