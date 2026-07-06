import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import { MeshBasicMaterial } from "three";
import { chapters, type Chapter, type Pin } from "../data/chapters";
import { cssToken, withAlpha } from "../lib/cssTokens";
import { formatCoordinate } from "../lib/coords";

interface Props {
  activeId: string | null;
  isDesktop: boolean;
  reducedMotion: boolean;
  /** True while the "down to earth" dive is playing. */
  diving: boolean;
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
 * The globe is fully vector: a flat-shaded sphere plus land drawn from
 * locally served 1:50M coastline data — no raster textures, so it stays
 * crisp at any zoom and pixel density. Land arrives in two locally built
 * pieces: polygon caps pre-clipped into 15° tiles (the cap triangulation
 * in three-globe runs a point-in-polygon filter that is quadratic in ring
 * vertices, so whole continents freeze the page for seconds while bounded
 * tiles stay cheap) and the original untiled rings drawn as thin line
 * paths, so coastlines never reveal the tile cuts. If either request
 * fails, the sphere, pins, and arcs still render; the site never blanks.
 */
const LAND_TILES_URL = "/geo/land-tiles.geojson";
const COAST_RINGS_URL = "/geo/land-rings.json";
const BORDERS_URL = "/geo/land-borders.json";
const TERRAIN_URL = "/geo/terrain.json";

/** Opening view: wide over Asia, where five of the six chapters happened. */
const HERO_POV = { lat: 26, lng: 106, altitude: 2.4 };
const FLIGHT_MS = 1200;
/** Latest-wins debounce: fast scrolling never queues stale camera flights. */
const FLIGHT_DEBOUNCE_MS = 160;
/** Multi-pin chapters tour their pins: fly, dwell, fly on. A leg's
 *  duration grows with its length, so short hops don't crawl and ocean
 *  crossings don't whip. */
const TOUR_LEG_MS = 1900;
const TOUR_DWELL_MS = 400;
/** Mid-leg climb per radian² of leg length. Quadratic, so regional hops
 *  barely change altitude at all and only ocean crossings truly rise. */
const TOUR_CLIMB = 0.25;
/** The finale: pull back until the whole journey fits in frame. */
const TOUR_OVERVIEW_MS = 1800;
/** The "down to earth" plunge. */
const DIVE_MS = 900;
const DIVE_ALTITUDE = 0.03;
const IDLE_ROTATE_SPEED = 0.35;
/** Draw-in timings — the slow reveal for arcs and pins. */
const ARC_ENTER_MS = 700;
const PIN_ENTER_MS = 500;
/** The briefing-map graticule: faint electric grid over the whole map. */
const GRID_OPACITY = 0.18;

// Stable identity matters: a new accessor function per render would make
// three-globe tear down and re-tessellate every land polygon. A null side
// color skips side-wall geometry entirely (the lib treats falsy as "none",
// but its TS types only admit strings).
const NO_SIDE_COLOR = (() => null) as unknown as () => string;

interface LandPolygon {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "Polygon"; coordinates: number[][][] };
  /** Lakes: filled with the ocean wash instead of land white. */
  water?: boolean;
}

/** A run of [lng, lat] points: a coastline, lake shore, or border. */
type LineRun = number[][];

/** Path-layer datum: coasts and lake shores draw strongest, interior
 *  borders a step quieter. */
interface PathDatum {
  points: LineRun;
  kind: "coast" | "border";
}

const tileVertices = (tile: LandPolygon) =>
  tile.geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0);

// Even with bounded tiles, building all land in one task would still jam
// first open, so tiles and coastlines stream onto the globe one budgeted
// chunk per animation frame — biggest tiles first, so continents appear
// immediately and islets fill in behind. three-globe keys polygons by a
// stamped id and skips geometry rebuilds when coordinates match by
// reference, so a growing array never re-tessellates what is built.
// Line paths are far cheaper per vertex, hence the looser budget.
const TILE_CHUNK_VERTICES = 1500;
const RING_CHUNK_POINTS = 4000;

// Stable accessors for the coastline/border/river path layer.
const PATH_POINTS = (datum: object) => (datum as PathDatum).points;
const PATH_POINT_LAT = (point: object) => (point as number[])[1];
const PATH_POINT_LNG = (point: object) => (point as number[])[0];
// Layer altitudes: land 0.007, lake fills 0.010, lines 0.012. The gaps
// are sized to real error budgets, not taste: lakes are perimeter-only
// triangulations (too small for the 5° interior grid), so Lake Superior's
// widest triangles sag ~0.0006·R below the lake shell — a smaller gap
// lets exactly-at-shell land vertices (the 15° tile edge at 90°W crosses
// Superior) poke white through the fill. And at hero distance one depth-
// buffer LSB is ~0.0007·R, so sub-LSB gaps would z-fight; these gaps keep
// every pair of layers several LSBs apart.
const POLYGON_ALTITUDE = (polygon: object) =>
  (polygon as LandPolygon).water ? 0.01 : 0.007;
const LINE_ALTITUDE = 0.012;

/** three-globe's internal globe radius. */
const GLOBE_RADIUS = 100;

/** Briefing-map stipple: a whisper of texture on a fine ~0.75° dot
 *  grid — felt more than seen. */
const STIPPLE_CELLS_PER_RAD = 76.4; /* 57.296 deg/rad ÷ 0.75 deg cells */
const STIPPLE_BOOST = 0.22;

/**
 * Land and coastlines float slightly above the ocean sphere, so a band of
 * the far side (~sqrt(2·altitude) radians wide) stays geometrically
 * visible past the limb and would draw as a ring hugging the horizon —
 * no winding or culling can prevent that. Discard fragments that lie
 * beyond the globe's horizon from the camera instead; the small cosine
 * slack keeps the clip from nibbling geometry right at the limb.
 *
 * With `stipple`, the fragment shader also lifts the material color on a
 * spherical dot grid — the briefing map's dot-matrix landmass — reusing
 * the same varying, so texture comes at zero geometry cost.
 */
function clipBehindHorizon<T extends { onBeforeCompile: unknown; customProgramCacheKey?: unknown }>(
  material: T,
  stipple = false,
): T {
  (material as { onBeforeCompile: (shader: { vertexShader: string; fragmentShader: string }) => void }).onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlobePos;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvGlobePos = (modelMatrix * vec4(position, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlobePos;")
      .replace(
        "void main() {",
        `void main() {\n\tif (dot(normalize(vGlobePos), normalize(cameraPosition)) < ${GLOBE_RADIUS.toFixed(1)} / length(cameraPosition) - 0.005) discard;`,
      );
    if (stipple) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `vec3 spN = normalize(vGlobePos);
\tvec2 spCell = fract(vec2(atan(spN.z, spN.x), asin(clamp(spN.y, -1.0, 1.0))) * ${STIPPLE_CELLS_PER_RAD.toFixed(2)}) - 0.5;
\toutgoingLight *= 1.0 + ${STIPPLE_BOOST.toFixed(2)} * (1.0 - smoothstep(0.12, 0.3, length(spCell)));
\t#include <opaque_fragment>`,
      );
    }
  };
  (material as { customProgramCacheKey: () => string }).customProgramCacheKey = () =>
    stipple ? "horizon-clip-stipple" : "horizon-clip";
  return material;
}

const RAD = Math.PI / 180;

const pinVec = (pin: Pin): [number, number, number] => [
  Math.cos(pin.lat * RAD) * Math.cos(pin.lng * RAD),
  Math.cos(pin.lat * RAD) * Math.sin(pin.lng * RAD),
  Math.sin(pin.lat * RAD),
];

/**
 * Overview camera for a chapter (used under reduced motion, where the
 * multi-pin tour is skipped): the spherical midpoint of the two farthest
 * pins, at an altitude that keeps every pin on the visible cap. A naive
 * lat/lng average breaks for chapters spanning the Pacific — Shanghai →
 * Pennsylvania averages to the wrong hemisphere entirely.
 */
function chapterOverview(chapter: Chapter) {
  const { pins, altitude } = chapter;
  if (pins.length === 1) return { lat: pins[0].lat, lng: pins[0].lng, altitude };
  const vecs = pins.map(pinVec);
  let [a, b] = [vecs[0], vecs[1]];
  let minDot = Infinity; // smallest dot product = largest angular distance
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const d = vecs[i][0] * vecs[j][0] + vecs[i][1] * vecs[j][1] + vecs[i][2] * vecs[j][2];
      if (d < minDot) {
        minDot = d;
        [a, b] = [vecs[i], vecs[j]];
      }
    }
  }
  const mid = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const len = Math.hypot(mid[0], mid[1], mid[2]) || 1;
  // Half the farthest-pair separation, padded, decides how high to sit.
  const spread = Math.acos(Math.max(-1, Math.min(1, minDot))) / 2;
  const fitAltitude = 1 / Math.cos(Math.min(spread + 0.25, 1.4)) - 1;
  return {
    lat: Math.asin(mid[2] / len) / RAD,
    lng: Math.atan2(mid[1] / len, mid[0] / len) / RAD,
    altitude: Math.max(altitude, fitAltitude),
  };
}

/** The lng equivalent (±360k) nearest to a reference, so camera tweens
 *  take the short way around — Shanghai → Pennsylvania flies the Pacific,
 *  not backwards over Europe. */
const nearestLng = (lng: number, ref: number) => lng - 360 * Math.round((lng - ref) / 360);

export default function GlobeScene({ activeId, isDesktop, reducedMotion, diving }: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const hasScrolled = useRef(false);

  const palette = useMemo(() => {
    const accent = cssToken("--accent");
    const accentHot = cssToken("--accent-hot");
    // Briefing-map wireframe: coastlines burn bright over near-black
    // land; interior borders stay quiet admin lines.
    const coast = withAlpha(accentHot, 0.8);
    const border = withAlpha(accent, 0.35);
    const ring = accent;
    return {
      accent,
      accentHot,
      bg: cssToken("--bg"),
      ocean: cssToken("--globe-ocean"),
      land: cssToken("--globe-land"),
      grid: withAlpha(accent, 0.15),
      // Per-datum accessor props run through accessor-fn, which treats a
      // plain string as a property name — colors there must be functions.
      // Memoized once, so layers never re-digest over accessor identity.
      pathColorAccessor: (datum: object) =>
        (datum as PathDatum).kind === "border" ? border : coast,
      // Radar rings fade as they propagate outward.
      ringColorAccessor: () => (t: number) => withAlpha(ring, 0.3 * (1 - t)),
    };
  }, []);

  // Flat, unlit materials: a midnight ocean sphere with abyss-navy land
  // on top — the wireframe-planet look, and no lighting math per frame.
  const globeMaterial = useMemo(
    () => new MeshBasicMaterial({ color: palette.ocean }),
    [palette],
  );
  // Front-side only: the build-time tiler winds every ring to d3-geo's
  // clockwise-exterior convention, so all caps face outward uniformly.
  // The horizon clip removes the far-side band that floats past the limb.
  const landMaterial = useMemo(
    () => clipBehindHorizon(new MeshBasicMaterial({ color: palette.land }), true),
    [palette],
  );
  // Lakes reuse the midnight ocean, floated just above the land caps.
  const lakeMaterial = useMemo(
    () => clipBehindHorizon(new MeshBasicMaterial({ color: palette.ocean })),
    [palette],
  );
  const capMaterialAccessor = useMemo(
    () => (polygon: object) =>
      (polygon as LandPolygon).water ? lakeMaterial : landMaterial,
    [lakeMaterial, landMaterial],
  );

  // Land tiles, coastline rings, and country borders, fetched from this
  // origin and streamed onto the globe in frame-sized chunks. Each step
  // sets a slice prefix of a stable array, so the stream is idempotent
  // and append-only. On fetch failure the globe simply renders without
  // that layer — never blank.
  const [land, setLand] = useState<LandPolygon[]>([]);
  const [paths, setPaths] = useState<PathDatum[]>([]);
  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const fetchJson = (url: string) =>
      fetch(url).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    Promise.all([
      fetchJson(LAND_TILES_URL),
      fetchJson(COAST_RINGS_URL),
      fetchJson(BORDERS_URL),
      fetchJson(TERRAIN_URL),
    ]).then(
      ([tilesGeo, ringsData, bordersData, terrainData]: [
        { features?: LandPolygon[] } | null,
        { rings?: LineRun[] } | null,
        { borders?: LineRun[] } | null,
        { lakes?: number[][][][]; lakeRings?: LineRun[] } | null,
      ]) => {
        if (cancelled) return;
        const tiles = (tilesGeo?.features ?? [])
          .slice()
          .sort((a, b) => tileVertices(b) - tileVertices(a));
        // Lakes stream after the land they sit on.
        const polys: LandPolygon[] = [
          ...tiles,
          ...(terrainData?.lakes ?? []).map(
            (coordinates): LandPolygon => ({
              type: "Feature",
              properties: {},
              geometry: { type: "Polygon", coordinates },
              water: true,
            }),
          ),
        ];
        const lines: PathDatum[] = [
          ...(ringsData?.rings ?? []).map((points): PathDatum => ({ points, kind: "coast" })),
          ...(bordersData?.borders ?? []).map((points): PathDatum => ({ points, kind: "border" })),
          ...(terrainData?.lakeRings ?? []).map((points): PathDatum => ({ points, kind: "coast" })),
        ];

        // One state update per plan step. Order is the page's visual
        // priority: land, then coastlines and borders (the map reads from
        // these), then the terrain garnish — lakes and their shores.
        const plan: (() => void)[] = [];
        const planPolySlices = (from: number, to: number) => {
          let budget = 0;
          for (let i = from; i < to; i++) {
            budget += tileVertices(polys[i]);
            if (budget >= TILE_CHUNK_VERTICES || i === to - 1) {
              const upTo = i + 1;
              plan.push(() => setLand(polys.slice(0, upTo)));
              budget = 0;
            }
          }
        };
        const planLineSlices = (from: number, to: number) => {
          let budget = 0;
          for (let i = from; i < to; i++) {
            budget += lines[i].points.length;
            if (budget >= RING_CHUNK_POINTS || i === to - 1) {
              const upTo = i + 1;
              plan.push(() => setPaths(lines.slice(0, upTo)));
              budget = 0;
            }
          }
        };
        const baseLineCount =
          (ringsData?.rings?.length ?? 0) + (bordersData?.borders?.length ?? 0);
        planPolySlices(0, tiles.length);
        planLineSlices(0, baseLineCount);
        planPolySlices(tiles.length, polys.length);
        planLineSlices(baseLineCount, lines.length);
        // Final step, one frame after the last chunk has committed: give
        // every line the horizon clip. three-globe stamps each datum with
        // its THREE object, and with stable accessors it never rebuilds
        // these materials afterwards.
        plan.push(() => {
          for (const line of lines) {
            const obj = (line as { __threeObjPath?: { material?: { needsUpdate: boolean; userData: Record<string, boolean> } } }).__threeObjPath;
            const material = obj?.material;
            if (material && !material.userData.horizonClip) {
              clipBehindHorizon(material as unknown as Parameters<typeof clipBehindHorizon>[0]);
              material.needsUpdate = true;
              material.userData.horizonClip = true;
            }
          }
        });
        if (!plan.length) return;

        let step = 0;
        const feedChunk = () => {
          if (cancelled) return;
          plan[step]();
          step += 1;
          if (step < plan.length) frame = requestAnimationFrame(feedChunk);
        };
        frame = requestAnimationFrame(feedChunk);
      },
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
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

  // Arcs exist only while their chapter is active. Arc endpoints are
  // hand-authored indexes into pins — a bad index drops that arc rather
  // than crashing the scene.
  const arcs = useMemo<ArcDatum[]>(() => {
    const chapter = chapters.find((ch) => ch.id === activeId);
    if (!chapter?.arcs) return [];
    return chapter.arcs
      .filter(([from, to]) => chapter.pins[from] && chapter.pins[to])
      .map(([from, to]) => ({
        startLat: chapter.pins[from].lat,
        startLng: chapter.pins[from].lng,
        endLat: chapter.pins[to].lat,
        endLng: chapter.pins[to].lng,
      }));
  }, [activeId]);

  // Radar rings sweep out from the active chapter's pins — the briefing
  // map's operation-zone pulse. Inherently ambient, so reduced motion
  // gets none at all.
  const rings = useMemo<{ lat: number; lng: number }[]>(() => {
    if (reducedMotion) return [];
    const chapter = chapters.find((ch) => ch.id === activeId);
    return chapter ? chapter.pins.map((pin) => ({ lat: pin.lat, lng: pin.lng })) : [];
  }, [activeId, reducedMotion]);

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
    // The 10° graticule ships as one LineSegments with a hard-coded
    // lightgrey material at exactly globe radius (it would z-fight the
    // ocean sphere and hide under the land caps). Lift it above the map
    // layers, recolor it to the faint electric grid, and horizon-clip it
    // like everything else. It is the scene's only LineSegments at mount.
    globe.scene().traverse((obj) => {
      if ((obj as { type?: string }).type !== "LineSegments") return;
      const seg = obj as unknown as {
        scale: { setScalar: (s: number) => void };
        material: {
          color: { set: (c: string) => void };
          opacity: number;
          needsUpdate: boolean;
        };
      };
      seg.scale.setScalar(1.013);
      seg.material.color.set(palette.accent);
      seg.material.opacity = GRID_OPACITY;
      clipBehindHorizon(seg.material as unknown as Parameters<typeof clipBehindHorizon>[0]);
      seg.material.needsUpdate = true;
    });
    // Pins float above the land caps, so far-side pins would peek past
    // the limb as stray specks — clip them like the land. Their objects
    // exist by now (points data is set at construction and never changes)
    // and the lib updates pin colors as uniforms, which survive this.
    for (const point of points) {
      const pin = (point as { __threeObjPoint?: { material?: { needsUpdate: boolean; userData: Record<string, boolean> } } }).__threeObjPoint;
      const material = pin?.material;
      if (material && !material.userData.horizonClip) {
        clipBehindHorizon(material as unknown as Parameters<typeof clipBehindHorizon>[0]);
        material.needsUpdate = true;
        material.userData.horizonClip = true;
      }
    }
    setReady(true);
  }, [globeMounted, ready, points, palette]);

  // Pixel ratio cap: 1.5 on mobile, 2 on desktop.
  useEffect(() => {
    if (!ready) return;
    globeRef.current
      ?.renderer()
      .setPixelRatio(Math.min(window.devicePixelRatio || 1, isDesktop ? 2 : 1.5));
  }, [ready, isDesktop]);

  // Camera flight on chapter change — only the latest target wins, and
  // multi-pin chapters tour their pins in story order: fly close to the
  // first, dwell, fly on to the next. Leaving the chapter (or diving)
  // cancels the remaining stops mid-flight.
  useEffect(() => {
    if (!ready || diving) return;
    const timers: number[] = [];
    let frame = 0;
    let cancelled = false;

    // Cubic in-out: smooth acceleration and a gentle settle — quintic
    // read as too abrupt.
    const easeInOut = (t: number) =>
      t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    const smoothstep = (t: number) => t * t * (3 - 2 * t);
    // Aircraft altitude profile: climb out over the first third, hold
    // cruise, descend on final — not a symmetric balloon hop.
    const climbProfile = (e: number) =>
      smoothstep(Math.min(1, e / 0.35)) * smoothstep(Math.min(1, (1 - e) / 0.35));

    // Tour legs slerp the camera along the great circle between the two
    // pins — the exact track the arc draws. (pointOfView tweens lat/lng
    // linearly, a straight line in map space; over the Pacific that path
    // runs thousands of km south of the arc.) The camera climbs with the
    // leg's length and settles back to touring altitude.
    const flyLeg = (from: Pin, to: Pin, altitude: number, onArrive: () => void) => {
      const a = pinVec(from);
      const b = pinVec(to);
      const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      const omega = Math.acos(dot);
      const ms = TOUR_LEG_MS * (0.75 + omega * 0.5);
      const t0 = performance.now();
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - t0) / ms);
        const e = easeInOut(t);
        const [wa, wb] =
          omega < 1e-6
            ? [1 - e, e]
            : [Math.sin((1 - e) * omega) / Math.sin(omega), Math.sin(e * omega) / Math.sin(omega)];
        const x = wa * a[0] + wb * b[0];
        const y = wa * a[1] + wb * b[1];
        const z = wa * a[2] + wb * b[2];
        const len = Math.hypot(x, y, z) || 1;
        globeRef.current?.pointOfView(
          {
            lat: Math.asin(z / len) / RAD,
            lng: Math.atan2(y, x) / RAD,
            altitude: altitude + omega * omega * TOUR_CLIMB * climbProfile(e),
          },
          0,
        );
        if (t < 1) frame = requestAnimationFrame(step);
        else onArrive();
      };
      frame = requestAnimationFrame(step);
    };

    timers.push(
      window.setTimeout(() => {
        const globe = globeRef.current;
        if (!globe) return;
        const chapter = chapters.find((ch) => ch.id === activeId);
        if (!chapter) {
          globe.pointOfView(HERO_POV, reducedMotion ? 0 : FLIGHT_MS);
          return;
        }
        if (reducedMotion) {
          globe.pointOfView(chapterOverview(chapter), 0);
          return;
        }
        // The approach flight has no line to follow — a plain tween, on
        // the short way around.
        const first = chapter.pins[0];
        const refLng = (globe.pointOfView() as { lng: number }).lng;
        globe.pointOfView(
          { lat: first.lat, lng: nearestLng(first.lng, refLng), altitude: chapter.altitude },
          FLIGHT_MS,
        );
        const tourFrom = (i: number) => {
          if (i + 1 >= chapter.pins.length) {
            // The finale: after the last stop, pull back just far enough
            // that the whole journey — every pin and arc — is in frame.
            if (chapter.pins.length > 1) {
              timers.push(
                window.setTimeout(() => {
                  const g = globeRef.current;
                  if (!g) return;
                  const overview = chapterOverview(chapter);
                  const ref = (g.pointOfView() as { lng: number }).lng;
                  g.pointOfView(
                    { ...overview, lng: nearestLng(overview.lng, ref) },
                    TOUR_OVERVIEW_MS,
                  );
                }, TOUR_DWELL_MS),
              );
            }
            return;
          }
          timers.push(
            window.setTimeout(
              () =>
                flyLeg(chapter.pins[i], chapter.pins[i + 1], chapter.altitude, () =>
                  tourFrom(i + 1),
                ),
              TOUR_DWELL_MS,
            ),
          );
        };
        timers.push(window.setTimeout(() => tourFrom(0), FLIGHT_MS));
      }, FLIGHT_DEBOUNCE_MS),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      cancelAnimationFrame(frame);
    };
  }, [activeId, ready, reducedMotion, diving]);

  // The "down to earth" dive: plunge straight into the active place.
  useEffect(() => {
    if (!diving || !ready) return;
    const globe = globeRef.current;
    if (!globe) return;
    const chapter = chapters.find((ch) => ch.id === activeId);
    const target = chapter ? chapter.pins[0] : HERO_POV;
    const refLng = (globe.pointOfView() as { lng: number }).lng;
    globe.pointOfView(
      { lat: target.lat, lng: nearestLng(target.lng, refLng), altitude: DIVE_ALTITUDE },
      reducedMotion ? 0 : DIVE_MS,
    );
  }, [diving, ready, activeId, reducedMotion]);

  // Flight-instrument readout: written straight to the DOM on every
  // camera move — no React re-renders at 60fps.
  const handleZoom = useCallback((pov: { lat: number; lng: number; altitude: number }) => {
    const hud = hudRef.current;
    if (!hud) return;
    const km = Math.max(0, Math.round(pov.altitude * 6371));
    hud.textContent = `${formatCoordinate(pov.lat, nearestLng(pov.lng, 0))} · ${km} km`;
  }, []);

  return (
    <div ref={containerRef} className="globe-canvas">
      <div ref={hudRef} className="globe-hud" aria-hidden="true" />
      {size.width > 0 && size.height > 0 && (
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor={palette.bg}
          globeMaterial={globeMaterial}
          atmosphereColor={palette.accent}
          atmosphereAltitude={0.1}
          polygonsData={land}
          polygonCapMaterial={capMaterialAccessor}
          polygonSideColor={NO_SIDE_COLOR}
          // Altitude must exceed the chord sag of the curvature grid, or
          // the ocean sphere pokes through tile interiors. The grid is a
          // sparse spiral, so 5° keeps worst-case interior spans well
          // under the sag budget (10° left dipping patches). Lakes float
          // above the land caps, below the line layer.
          polygonAltitude={POLYGON_ALTITUDE}
          polygonCapCurvatureResolution={5}
          polygonsTransitionDuration={0}
          // Coastlines drawn from the original untiled rings, floating just
          // above the caps — polygon strokes would trace the tile cuts.
          pathsData={paths}
          pathPoints={PATH_POINTS}
          pathPointLat={PATH_POINT_LAT}
          pathPointLng={PATH_POINT_LNG}
          pathColor={palette.pathColorAccessor}
          pathPointAlt={LINE_ALTITUDE}
          pathTransitionDuration={0}
          pointsData={points}
          pointLat={(d) => (d as PointDatum).lat}
          pointLng={(d) => (d as PointDatum).lng}
          pointColor={(d) =>
            (d as PointDatum).chapterId === activeId ? palette.accentHot : palette.accent
          }
          pointRadius={(d) => ((d as PointDatum).chapterId === activeId ? 0.6 : 0.32)}
          pointAltitude={(d) => ((d as PointDatum).chapterId === activeId ? 0.02 : 0.008)}
          pointsTransitionDuration={reducedMotion ? 0 : PIN_ENTER_MS}
          arcsData={arcs}
          arcStartLat={(d) => (d as ArcDatum).startLat}
          arcStartLng={(d) => (d as ArcDatum).startLng}
          arcEndLat={(d) => (d as ArcDatum).endLat}
          arcEndLng={(d) => (d as ArcDatum).endLng}
          arcColor={() => palette.accent}
          arcStroke={0.45}
          arcAltitudeAutoScale={0.3}
          arcDashLength={reducedMotion ? 1 : 0.25}
          arcDashGap={reducedMotion ? 0 : 0.35}
          arcDashAnimateTime={reducedMotion ? 0 : 1200}
          arcsTransitionDuration={reducedMotion ? 0 : ARC_ENTER_MS}
          showGraticules={true}
          ringsData={rings}
          ringColor={palette.ringColorAccessor}
          ringMaxRadius={5}
          ringPropagationSpeed={1.1}
          ringRepeatPeriod={1600}
          ringAltitude={0.0135}
          onZoom={handleZoom}
          rendererConfig={{ antialias: true, alpha: true }}
          // No tooltips or click targets on the globe — disabling the
          // hover raycaster avoids testing every coastline triangle on
          // each pointer move. OrbitControls drag is unaffected.
          enablePointerInteraction={false}
          // Without this, three-globe would keep the whole scene hidden
          // until its globe layer reports ready; render everything as it
          // arrives instead.
          waitForGlobeReady={false}
          animateIn={animateIn.current}
        />
      )}
    </div>
  );
}
