import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * Security headers, meta-tag flavor. A static host serves these pages
 * without custom headers by default, so the CSP rides in the documents
 * themselves; if the host later gains a headers config, move these there
 * (and add frame-ancestors + X-Content-Type-Options, which only work as
 * real headers). Injected at build only — the dev server needs inline
 * scripts for HMR/react-refresh, which this policy correctly forbids in
 * production.
 *
 * Notes on the allowances:
 * - style-src 'unsafe-inline': the anti-flash <style> in each html head
 *   and React inline style attributes.
 * - img-src https:: photo slots accept absolute https URLs by design;
 *   blob:/data: cover the editor's drop previews and svg favicon.
 * - connect-src api.github.com: the editor's publish target — the only
 *   external origin in the entire site.
 */
const CSP_SITE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const CSP_EDITOR = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self' https://api.github.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const injectCsp = (): Plugin => ({
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml(_html, ctx) {
    const isEditor = ctx.filename.endsWith('edit.html')
    return [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: isEditor ? CSP_EDITOR : CSP_SITE,
        },
        injectTo: 'head-prepend',
      },
      { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
    ]
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), injectCsp()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // The private content editor. Deployed but unlinked and
        // noindexed — see edit.html.
        edit: resolve(__dirname, 'edit.html'),
      },
      output: {
        // Long-term caching: the three.js stack (~540KB gz) only changes
        // when dependencies bump, so keep it in its own chunk instead of
        // re-downloading it whenever the globe scene code is edited.
        advancedChunks: {
          groups: [
            { name: 'three', test: /node_modules[\\/](three|three-globe|globe\.gl|react-globe\.gl|three-[\w-]+)[\\/]/ },
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
})
