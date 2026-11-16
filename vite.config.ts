import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Fail loudly instead of silently moving to 5174 when 5173 is taken;
    // the printed URL should always be the URL that works.
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
