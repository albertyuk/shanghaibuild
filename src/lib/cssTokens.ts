/**
 * Runtime access to the design tokens in styles/tokens.css, for the places
 * (Three.js materials) that need literal color strings. Components never
 * hard-code color values.
 */
export function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Apply an alpha to a token color. The token text is whatever the CSS
 * minifier emitted (3- or 6-digit hex, rgb(), …), so let the browser's own
 * parser canonicalize it to rgb()/rgba() instead of slicing hex digits.
 */
export function withAlpha(color: string, alpha: number): string {
  const probe = document.createElement("span");
  probe.style.color = color;
  const match = probe.style.color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}
