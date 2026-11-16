import { defineConfig } from 'vite';

/**
 * Build used to produce the double-clickable `Driftfield.html`.
 *
 * Everything has to end up in one file: `file://` pages cannot fetch module
 * scripts or stylesheets, so scripts/build-standalone.mjs inlines the emitted
 * JS and CSS into the HTML afterwards. Assets are inlined by Vite already.
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'standalone/dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        chunkFileNames: 'app.js',
        assetFileNames: 'app[extname]',
      },
    },
  },
});
