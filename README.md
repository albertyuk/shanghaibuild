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
(framework preset: Vite, output directory: `dist`). Globe textures are served
locally from `public/textures/`, so no runtime requests leave the origin.
