import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // The audited sample extract is ~720 KB and is replaced wholesale once
        // Supabase is connected. Keeping it in its own chunk means it does not
        // invalidate the app or vendor bundles on every deploy.
        manualChunks(id) {
          if (id.includes('ledger-sample.json')) return 'ledger-sample'
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
})
