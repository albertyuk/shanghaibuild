import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
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
 * Textures are served locally from /public/textures — never hot-linked.
 * If a texture request fails, three-globe keeps rendering the untextured
 * sphere, pins, and arcs; the site never blanks.
 */
const NIGHT_TEXTURE = "/textures/earth-night.jpg";
const TOPOLOGY_TEXTURE = "/textures/earth-topology.png";

/** Opening view: wide over Asia, where five of the six chapters happened. */
const HERO_POV = { lat: 26, lng: 106, altitude: 2.4 };
const FLIGHT_MS = 1200;
/** Latest-wins debounce: fast scrolling never queues stale camera flights. */
const FLIGHT_DEBOUNCE_MS = 160;
const IDLE_ROTATE_SPEED = 0.35;
const INACTIVE_PIN_OPACITY = 0.35;

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
    const paper = cssToken("--paper");
    return {
      paper,
      amber: cssToken("--amber"),
      pinDim: withAlpha(paper, INACTIVE_PIN_OPACITY),
      transparent: withAlpha(cssToken("--ink"), 0),
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
          globeImageUrl={NIGHT_TEXTURE}
          bumpImageUrl={TOPOLOGY_TEXTURE}
          atmosphereColor={palette.paper}
          atmosphereAltitude={0.15}
          pointsData={points}
          pointLat={(d) => (d as PointDatum).lat}
          pointLng={(d) => (d as PointDatum).lng}
          pointColor={(d) =>
            (d as PointDatum).chapterId === activeId ? palette.amber : palette.pinDim
          }
          pointRadius={(d) => ((d as PointDatum).chapterId === activeId ? 0.6 : 0.32)}
          pointAltitude={(d) => ((d as PointDatum).chapterId === activeId ? 0.02 : 0.008)}
          pointsTransitionDuration={0}
          arcsData={arcs}
          arcStartLat={(d) => (d as ArcDatum).startLat}
          arcStartLng={(d) => (d as ArcDatum).startLng}
          arcEndLat={(d) => (d as ArcDatum).endLat}
          arcEndLng={(d) => (d as ArcDatum).endLng}
          arcColor={() => palette.amber}
          arcStroke={0.45}
          arcDashLength={reducedMotion ? 1 : 0.35}
          arcDashGap={reducedMotion ? 0 : 0.5}
          arcDashAnimateTime={reducedMotion ? 0 : 1500}
          arcsTransitionDuration={0}
          rendererConfig={{ antialias: true, alpha: true }}
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
