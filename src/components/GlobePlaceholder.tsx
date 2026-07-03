/**
 * Static stand-in matching the globe canvas footprint, shown while the
 * Three.js chunk loads (or forever, if it fails). First contentful paint
 * never waits on WebGL.
 */
export function GlobePlaceholder() {
  return (
    <div className="globe-placeholder" aria-hidden="true">
      <div className="globe-placeholder-disc" />
    </div>
  );
}
