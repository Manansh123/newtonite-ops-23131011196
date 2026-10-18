import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser talks to /api on the Vite origin; Vite forwards it to the Express API (no CORS needed).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});
