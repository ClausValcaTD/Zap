import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The OpenHands runtime proxies a container port to a public
  // *.prod-runtime.all-hands.dev URL, so that host must be allowed explicitly.
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['.prod-runtime.all-hands.dev', 'localhost'],
  },
  preview: {
    host: true,
    port: 12000,
    allowedHosts: ['.prod-runtime.all-hands.dev', 'localhost'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
