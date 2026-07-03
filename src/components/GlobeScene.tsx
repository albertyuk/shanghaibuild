import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import { MeshBasicMaterial } from "three";
import { chapters, type Chapter } from "../data/chapters";
import { cssToken, withAlpha } from "../lib/cssTokens";

interface Props {
  activeId: string | null;
  isDesktop: boolean;
  reducedMotion: boolean;
}

interface PointDatum {
  lat: number;
  lng: number;
  chapterId: string;
}

interface ArcDatum {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
}

/** The slice of OrbitControls this component touches. */
interface GlobeControls {
  autoRotate: boolean;
  autoRotateSpeed: number;
  enableZoom: boolean;
  enablePan: boolean;
}

/*
 * The globe is fully vector: a flat-shaded sphere plus land polygons from
 * a locally served GeoJSON (1:50M coastlines) — no raster textures, so it
 * stays crisp at any zoom and pixel density. If the land request fails,
 * the sphere, pins, and arcs still render; the site never blanks.
 */
const LAND_GEOJSON = "/geo/land-50m.geojson";

/** Opening view: wide over Asia, where five of the six chapters happened. */
const HERO_POV = { lat: 26, lng: 106, altitude: 2.4 };
const FLIGHT_MS = 1200;
/** Latest-wins debounce: fast scrolling never queues stale camera flights. */
const FLIGHT_DEBOUNCE_MS = 160;
const IDLE_ROTATE_SPEED = 0.35;
const INACTIVE_PIN_OPACITY = 0.35;

// Stable identity matters: a new accessor function per render would make
// three-globe tear down and re-tessellate every land polygon. A null side
// color skips side-wall geometry entirely (the lib treats falsy as "none",
// but its TS types only admit strings).
const NO_SIDE_COLOR = (() => null) as unknown as () => string;

function chapterPointOfView(chapter: Chapter) {
  const lat = chapter.pins.reduce((sum, pin) => sum + pin.lat, 0) / chapter.pins.length;
  const lng = chapter.pins.reduce((sum, pin) => sum + pin.lng, 0) / chapter.pins.length;
  return { lat, lng, altitude: chapter.altitude };
}

export default function GlobeScene({ activeId, isDesktop, reducedMotion }: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const hasScrolled = useRef(false);

  const palette = useMemo(() => {
    const text = cssToken("--text");
    const accent = cssToken("--accent");
    return {
      accent,
      ground: cssToken("--ground"),
      wash: cssToken("--wash"),
      coast: withAlpha(text, 0.4),
      pinDim: withAlpha(accent, INACTIVE_PIN_OPACITY),
      transparent: withAlpha(cssToken("--ground"), 0),
    };
  }, []);

  // Flat, unlit materials: a pale-blue ocean sphere with ground-white land
  // on top — the print-flat look, and no lighting math per frame.
  const globeMaterial = useMemo(
    () => new MeshBasicMaterial({ color: palette.wash }),
    [palette],
  );
  const landMaterial = useMemo(
    () => new MeshBasicMaterial({ color: palette.ground }),
    [palette],
  );

  // Land shapes, fetched from this origin. On failure the globe simply
  // renders without land — never blank.
  const [land, setLand] = useState<object[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(LAND_GEOJSON)
      .then((res) => (res.ok ? res.json() : null))
      .then((geo: { features?: object[] } | null) => {
        if (!cancelled && geo?.features) setLand(geo.features);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The canvas always matches its pane exactly.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Every chapter pin, always visible.
  const points = useMemo<PointDatum[]>(
    () =>
      chapters.flatMap((chapter) =>
        chapter.pins.map((pin) => ({
          lat: pin.lat,
          lng: pin.lng,
          chapterId: chapter.id,
        })),
      ),
    [],
  );

  // globe.gl's intro tween (scale-in + full rotation) is an init-time
  // option, so capture the reduced-motion preference at mount.
  const animateIn = useRef(!reducedMotion);

  // Arcs exist only while their chapter is active.
  const arcs = useMemo<ArcDatum[]>(() => {
    const chapter = chapters.find((ch) => ch.id === activeId);
    if (!chapter?.arcs) return [];
    return chapter.arcs.map(([from, to]) => ({
      startLat: chapter.pins[from].lat,
      startLng: chapter.pins[from].lng,
      endLat: chapter.pins[to].lat,
      endLng: chapter.pins[to].lng,
    }));
  }, [activeId]);

  // Idle rotate: desktop hero only, killed permanently on first scroll.
  const applyAutoRotate = useCallback(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const controls = globe.controls() as unknown as GlobeControls;
    controls.autoRotateSpeed = IDLE_ROTATE_SPEED;
    controls.autoRotate =
      isDesktop && !reducedMotion && activeId === null && !hasScrolled.current;
  }, [activeId, isDesktop, reducedMotion]);

  useEffect(() => {
    if (ready) applyAutoRotate();
  }, [ready, applyAutoRotate]);

  useEffect(() => {
    if (hasScrolled.current) return;
    const stopIdleRotate = () => {
      hasScrolled.current = true;
      applyAutoRotate();
    };
    window.addEventListener("scroll", stopIdleRotate, { once: true, passive: true });
    return () => window.removeEventListener("scroll", stopIdleRotate);
  }, [applyAutoRotate]);

  // One-time setup, keyed on the <Globe> mount (it renders once the pane
  // has been measured). Deliberately NOT the onGlobeReady callback: with
  // waitForGlobeReady={false} three-globe fires ready synchronously inside
  // its constructor, before react-kapsule has attached the callback — it
  // would never be invoked. The ref is guaranteed set by the time this
  // effect runs, and globe.gl builds its controls synchronously at mount.
  const globeMounted = size.width > 0 && size.height > 0;
  useEffect(() => {
    if (!globeMounted || ready) return;
    const globe = globeRef.current;
    if (!globe) return;
    const controls = globe.controls() as unknown as GlobeControls;
    controls.enableZoom = false; // the wheel keeps scrolling the page
    controls.enablePan = false;
    globe.pointOfView(HERO_POV, 0);
    setReady(true);
  }, [globeMounted, ready]);

  // Pixel ratio cap: 1.5 on mobile, 2 on desktop.
  useEffect(() => {
    if (!ready) return;
    globeRef.current
      ?.renderer()
      .setPixelRatio(Math.min(window.devicePixelRatio || 1, isDesktop ? 2 : 1.5));
  }, [ready, isDesktop]);

  // Camera flight on chapter change — only the latest target wins.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      const chapter = chapters.find((ch) => ch.id === activeId);
      globeRef.current?.pointOfView(
        chapter ? chapterPointOfView(chapter) : HERO_POV,
        reducedMotion ? 0 : FLIGHT_MS,
      );
    }, FLIGHT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeId, ready, reducedMotion]);

  return (
    <div ref={containerRef} className="globe-canvas">
      {size.width > 0 && size.height > 0 && (
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor={palette.transparent}
          globeMaterial={globeMaterial}
          atmosphereColor={palette.accent}
          atmosphereAltitude={0.12}
          polygonsData={land}
          polygonCapMaterial={landMaterial}
          polygonSideColor={NO_SIDE_COLOR}
          polygonStrokeColor={palette.coast}
          polygonAltitude={0.004}
          polygonsTransitionDuration={0}
          pointsData={points}
          pointLat={(d) => (d as PointDatum).lat}
          pointLng={(d) => (d as PointDatum).lng}
          pointColor={(d) =>
            (d as PointDatum).chapterId === activeId ? palette.accent : palette.pinDim
          }
          pointRadius={(d) => ((d as PointDatum).chapterId === activeId ? 0.6 : 0.32)}
          pointAltitude={(d) => ((d as PointDatum).chapterId === activeId ? 0.02 : 0.008)}
          pointsTransitionDuration={0}
          arcsData={arcs}
          arcStartLat={(d) => (d as ArcDatum).startLat}
          arcStartLng={(d) => (d as ArcDatum).startLng}
          arcEndLat={(d) => (d as ArcDatum).endLat}
          arcEndLng={(d) => (d as ArcDatum).endLng}
          arcColor={() => palette.accent}
          arcStroke={0.45}
          arcDashLength={reducedMotion ? 1 : 0.35}
          arcDashGap={reducedMotion ? 0 : 0.5}
          arcDashAnimateTime={reducedMotion ? 0 : 1500}
          arcsTransitionDuration={0}
          rendererConfig={{ antialias: true, alpha: true }}
          // No tooltips or click targets on the globe — disabling the
          // hover raycaster avoids testing every coastline triangle on
          // each pointer move. OrbitControls drag is unaffected.
          enablePointerInteraction={false}
          // Without this, three-globe keeps the whole scene hidden until
          // the night texture loads — and its loader has no error
          // callback, so a failed texture request would blank the pane
          // forever. With it, the untextured sphere, pins, and arcs
          // render immediately and the texture drapes in on arrival.
          waitForGlobeReady={false}
          animateIn={animateIn.current}
        />
      )}
    </div>
  );
}
