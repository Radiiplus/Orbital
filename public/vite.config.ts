import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/graphql': 'http://127.0.0.1:4000',
      '/health': 'http://127.0.0.1:4000',
      '/session': 'http://127.0.0.1:4000',
      '/wallets': 'http://127.0.0.1:4000',
      '/contracts': 'http://127.0.0.1:4000',
      '/networks': 'http://127.0.0.1:4000',
      '/orbkit': 'http://127.0.0.1:4000',
      '/projects': 'http://127.0.0.1:4000',
    },
  },
})
