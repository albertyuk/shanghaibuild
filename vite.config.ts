import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // The private content editor. Deployed but unlinked and
        // noindexed — see edit.html.
        edit: resolve(__dirname, 'edit.html'),
      },
    },
  },
})
