/**
 * WebGL support probe. When this returns false the globe is never loaded
 * (no Three.js chunk is fetched) and the chapters render as a plain column.
 */
export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl2") ||
          canvas.getContext("webgl") ||
          canvas.getContext("experimental-webgl")),
    );
  } catch {
    return false;
  }
}
