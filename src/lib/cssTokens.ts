/**
 * Runtime access to the design tokens in styles/tokens.css, for the places
 * (Three.js materials) that need literal color strings. Components never
 * hard-code color values.
 */
export function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Apply an alpha to a #RRGGBB token value. */
export function withAlpha(hexColor: string, alpha: number): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
