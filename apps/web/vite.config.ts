import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev so the httpOnly refresh cookie flows like in production.
    proxy: {
      '/api': {
        target: process.env.MOWBOT_HUB_URL ?? 'http://localhost:8787',
        // Events and remote desktops are WebSockets.
        ws: true,
      },
    },
  },
});
