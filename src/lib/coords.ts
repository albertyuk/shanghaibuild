import type { Chapter } from "../data/chapters";

/** 31.2304, 121.4737 → "31.2304° N / 121.4737° E"; negatives flip hemisphere. */
export function formatCoordinate(lat: number, lng: number): string {
  const latPart = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
  const lngPart = `${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? "E" : "W"}`;
  return `${latPart} / ${lngPart}`;
}

/**
 * Chapter eyebrow, derived from pin data: the first pin's coordinates, then
 * every pin's city name, e.g. "31.2304° N / 121.4737° E — SHANGHAI" or
 * "39.9042° N / 116.4074° E — BEIJING · SHENZHEN".
 */
export function chapterEyebrow(chapter: Chapter): string {
  const [first] = chapter.pins;
  const cities = chapter.pins.map((pin) => pin.city.toUpperCase()).join(" · ");
  return `${formatCoordinate(first.lat, first.lng)} — ${cities}`;
}
