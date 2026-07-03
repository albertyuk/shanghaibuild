import { cssToken } from "./cssTokens";

/**
 * Fraction of viewport height where the reading area is centered. On
 * desktop the rail owns the full viewport, so 0.5. On mobile the sticky
 * globe covers the top of the screen, so the usable window runs from the
 * globe's bottom edge to the viewport bottom and its center sits lower —
 * activating chapters there keeps their headings out from under the globe.
 */
export function readingCenterFraction(isDesktop: boolean): number {
  if (isDesktop) return 0.5;
  const globeVh = parseFloat(cssToken("--globe-height-mobile")) || 45;
  return (globeVh + 100) / 200;
}
