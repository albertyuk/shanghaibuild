# Albert Yuk — Portfolio

Single-page portfolio organized around a 3D globe: six chapters of work, each
pinned to the place it happened. As the page scrolls, the globe flies to the
active chapter; a fixed chapter index doubles as navigation, so the animation
is never the only way to get anywhere.

Stack: Vite + React + TypeScript, `react-globe.gl` (Three.js). Static output,
no backend, no router, no client storage.

## Editing content

All portfolio content — chapters, pins, coordinates, links, and every line of
page copy — lives in **`src/data/chapters.ts`**. Lines marked `TODO(ALBERT)`
are placeholders to fill in.

All colors and type tokens live in **`src/styles/tokens.css`**. Nothing else
in the codebase declares a color.

## Develop

```sh
npm install
npm run dev
```

## Build & deploy

```sh
npm run build    # type-checks, then emits dist/
npm run preview  # serve the production build locally
```

`dist/` is a plain static site; deploy it to Vercel or Cloudflare Pages as-is
(framework preset: Vite, output directory: `dist`). The globe is fully vector
— land, coastlines, borders, and lakes come from the JSON files in
`public/geo/`, served locally — so it stays crisp at any zoom and no runtime
requests leave the origin (the editor's GitHub publish is the one exception,
by design).

If the host supports custom headers, prefer real security headers over the
built-in CSP meta tags (see `vite.config.ts`): copy the same policy and add
`frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`, plus
`cache-control: public, max-age=31536000, immutable` for `/assets/*`.
