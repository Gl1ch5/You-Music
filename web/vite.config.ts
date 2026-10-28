import { defineConfig } from 'vite';

// The build goes straight into the Android assets; WebViewAssetLoader serves it from https://appassets.androidplatform.net/.
export default defineConfig({
  base: '/',
  build: {
    outDir: '../android/app/src/main/assets/ui',
    emptyOutDir: true,
    target: 'chrome100',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
