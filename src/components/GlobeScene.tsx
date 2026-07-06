import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import { MeshBasicMaterial } from "three";
import { chapters, site, type Chapter, type Pin } from "../data/chapters";
import { cssToken, withAlpha } from "../lib/cssTokens";
import { formatCoordinate } from "../lib/coords";

interface Props {
  activeId: string | null;
  isDesktop: boolean;
  reducedMotion: boolean;
  /** True while the "down to earth" dive is playing. */
  diving: boolean;
  /** Fired once, when the map has fully streamed in (or there was
   *  nothing to stream) — the app drops its boot veil on this. */
  onLoaded?: () => void;
  /** Streaming progress: chunks committed out of the total plan. Fired
   *  once per chunk — the boot veil's progress bar reads this. */
  onProgress?: (done: number, total: number) => void;
  /** Fired when the tour's current stop changes: the chapter shown and
   *  the index of the pin the camera has most recently locked onto
   *  (-1 before the first lock). The photo callouts follow this, so
   *  each location's panels appear as the camera arrives there. */
  onWaypoint?: (chapterId: string | null, pinIndex: number) => void;
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
  enableDamping: boolean;
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
const LAND_TILES_URL = "/geo/land-tiles.json";
const COAST_RINGS_URL = "/geo/land-rings.json";
const BORDERS_URL = "/geo/land-borders.json";
const TERRAIN_URL = "/geo/terrain.json";
/** City-scale detail around every chapter pin: urban footprints
 *  (Natural Earth 10m) and the Shanghai rivers (OSM Huangpu + NE
 *  Suzhou Creek) — what makes a dive into a city read as that city. */
const CITY_DETAIL_URL = "/geo/city-detail.json";

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
/** Waypoints confirm on final approach: the lock-on flicker fires this
 *  far before the camera actually arrives at the pin. */
const LOCK_LEAD_MS = 700;
/** The "down to earth" plunge — deep enough that the city-detail layer
 *  (urban wash, rivers) fills the frame before the words take over. */
const DIVE_MS = 900;
const DIVE_ALTITUDE = 0.012;
const IDLE_ROTATE_SPEED = 0.35;
/** Draw-in timings — the slow reveal for arcs and pins. */
const ARC_ENTER_MS = 700;
const PIN_ENTER_MS = 500;
/** The briefing-map graticule: faint electric grid over the whole map. */
const GRID_OPACITY = 0.14;
/** Reticle tracking altitude — exactly the flat markers' altitude, so
 *  the crosshair centers on its dot from any viewing angle. */
const RETICLE_ALT = 0.008;

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
  /** Urban footprints: a faint accent wash over the land. */
  urban?: boolean;
  /** High-detail replacement fills for a city window (1:10M land and
   *  water), shown only at close zoom where the 1:50M base gets blocky. */
  patch?: "land" | "water";
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
// Line paths are far cheaper per vertex, hence the looser budget — and
// deliberately coarse: three-globe's paths layer re-tessellates EVERY
// existing line on each digest (its transition guard is always true),
// so total rework grows with the square of the chunk count. Five-ish
// line digests keep that rework small; tiles don't pay this tax (their
// geometry is keyed by reference and never rebuilt).
const TILE_CHUNK_VERTICES = 1500;
const RING_CHUNK_POINTS = 12000;

// Stable accessors for the coastline/border/river path layer. Border
// runs carry a stroke, which makes three-globe render them as fat
// lines (Line2) with a screen-constant PIXEL width — coasts and rivers
// stay 1px hairlines. Slightly heavier borders read as admin lines.
const BORDER_STROKE_PX = 1.2;
const PATH_STROKE = (datum: object) =>
  (datum as PathDatum).kind === "border" ? BORDER_STROKE_PX : null;
const PATH_POINTS = (datum: object) => (datum as PathDatum).points;
const PATH_POINT_LAT = (point: object) => (point as number[])[1];
const PATH_POINT_LNG = (point: object) => (point as number[])[0];
// …and for the points/arcs layers: a fresh arrow per render would make
// react-kapsule re-digest the layer on every streamed chunk.
const POINT_LAT = (d: object) => (d as PointDatum).lat;
const POINT_LNG = (d: object) => (d as PointDatum).lng;
const ARC_START_LAT = (d: object) => (d as ArcDatum).startLat;
const ARC_START_LNG = (d: object) => (d as ArcDatum).startLng;
const ARC_END_LAT = (d: object) => (d as ArcDatum).endLat;
const ARC_END_LNG = (d: object) => (d as ArcDatum).endLng;
// Dot radii (angular degrees) per zoom bucket: globe → region → country
// → city. The active dot ends tiny — inside its reticle — at city zoom.
const ACTIVE_DOT_RADIUS = [0.14, 0.077, 0.035, 0.004];
const INACTIVE_DOT_RADIUS = [0.22, 0.121, 0.055, 0.011];
// Layer altitudes: land 0.007, urban wash 0.0085, lake fills 0.010,
// lines 0.012. The gaps
// are sized to real error budgets, not taste: lakes are perimeter-only
// triangulations (too small for the 5° interior grid), so Lake Superior's
// widest triangles sag ~0.0006·R below the lake shell — a smaller gap
// lets exactly-at-shell land vertices (the 15° tile edge at 90°W crosses
// Superior) poke white through the fill. And at hero distance one depth-
// buffer LSB is ~0.0007·R, so sub-LSB gaps would z-fight; these gaps keep
// every pair of layers several LSBs apart.
const POLYGON_ALTITUDE = (polygon: object) => {
  const p = polygon as LandPolygon;
  // Patch fills sit between the base land and the urban wash; they only
  // render at close zoom, where depth precision makes the small gaps safe.
  return p.water ? 0.01 : p.urban ? 0.0085 : p.patch ? 0.0078 : 0.007;
};
/** Line altitude is zoom-dependent: 0.012R (~76km) keeps lines clear of
 *  the fills at globe distance where a depth LSB is coarse — but at
 *  chapter zooms that height is over half the camera's own altitude, so
 *  rivers and borders visibly float and parallax-slide off the ground.
 *  Below regional altitude the lines drop to a whisker above the fills;
 *  depth precision is ample there. Lake shore rings keep the high
 *  altitude always (baked per-point) — their fills sit at 0.01, and a
 *  lowered ring would vanish underneath. */
const LINE_ALTITUDE = 0.012;
const LINE_ALTITUDE_NEAR = 0.0082;

/** three-globe's internal globe radius. */
const GLOBE_RADIUS = 100;

/** Briefing-map stipple: a whisper of texture on a fine ~0.75° dot
 *  grid — felt more than seen. On the paper theme the dots print DARKER
 *  than the land, drifting toward blue (r dims most, b least). */
const STIPPLE_CELLS_PER_RAD = 76.4; /* 57.296 deg/rad ÷ 0.75 deg cells */
const STIPPLE_TINT = "vec3(0.10, 0.07, 0.015)";

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
      // The dot grid fades out as the camera drops toward city scale —
      // its ~0.75° cells would read as giant blobs over a 100km view.
      // Camera length is R·(1+altitude), so 108→122 spans alt 0.08→0.22.
      // It also fades toward the poles (|sin lat| 0.88→0.96 ≈ 62°→74°),
      // where converging meridians squeeze the lng/lat cells into
      // concentric ring artifacts — Antarctica renders clean white.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `vec3 spN = normalize(vGlobePos);
\tvec2 spCell = fract(vec2(atan(spN.z, spN.x), asin(clamp(spN.y, -1.0, 1.0))) * ${STIPPLE_CELLS_PER_RAD.toFixed(2)}) - 0.5;
\tfloat spNear = smoothstep(108.0, 122.0, length(cameraPosition));
\tfloat spPolar = 1.0 - smoothstep(0.88, 0.96, abs(spN.y));
\toutgoingLight *= vec3(1.0) - ${STIPPLE_TINT} * spNear * spPolar * (1.0 - smoothstep(0.12, 0.3, length(spCell)));
\t#include <opaque_fragment>`,
      );
    }
  };
  (material as { customProgramCacheKey: () => string }).customProgramCacheKey = () =>
    stipple ? "horizon-clip-stipple" : "horizon-clip";
  return material;
}

/**
 * Horizon clip for fat-line materials (three's LineMaterial): their
 * shader lacks the begin_vertex anchor the standard clip injects into,
 * so the varying rides on the segment-start attribute instead. Segments
 * are short, so per-segment clipping is indistinguishable from
 * per-fragment.
 */
function clipFatLineBehindHorizon<T extends { onBeforeCompile: unknown; customProgramCacheKey?: unknown }>(
  material: T,
): T {
  (material as { onBeforeCompile: (shader: { vertexShader: string; fragmentShader: string }) => void }).onBeforeCompile = (shader) => {
    shader.vertexShader =
      "varying vec3 vGlobePos;\n" +
      shader.vertexShader.replace(
        "void main() {",
        "void main() {\n\tvGlobePos = (modelMatrix * vec4(instanceStart, 1.0)).xyz;",
      );
    shader.fragmentShader =
      "varying vec3 vGlobePos;\n" +
      shader.fragmentShader.replace(
        "void main() {",
        `void main() {\n\tif (dot(normalize(vGlobePos), normalize(cameraPosition)) < ${GLOBE_RADIUS.toFixed(1)} / length(cameraPosition) - 0.005) discard;`,
      );
  };
  (material as { customProgramCacheKey: () => string }).customProgramCacheKey = () =>
    "horizon-clip-fatline";
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

/** How long a leaving overlay (reticles, leader lines, photo panels)
 *  lingers to play its exit before the next chapter's set keys in. */
const MARKER_LEAVE_MS = 220;

export default function GlobeScene({
  activeId,
  isDesktop,
  reducedMotion,
  diving,
  onLoaded,
  onProgress,
  onWaypoint,
}: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const hasScrolled = useRef(false);

  // The loaded signal fires exactly once. Refs carry the latest
  // callbacks into the one-shot streaming effect below.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const loadedFired = useRef(false);
  const fireLoaded = useCallback(() => {
    if (loadedFired.current) return;
    loadedFired.current = true;
    onLoadedRef.current?.();
  }, []);

  const palette = useMemo(() => {
    const accent = cssToken("--accent");
    // Briefing-chart wireframe on paper: coastlines carry a luminous
    // halo-blue stroke; interior borders stay quiet ink admin lines.
    // The border alpha is set low on purpose: shared segments appear in
    // two runs and the transparent strokes compound where they overlap
    // (1-(1-a)²), so 0.19 renders as a soft gray, not the dark slate
    // that 0.28 compounded into.
    const coast = withAlpha(cssToken("--globe-coast"), 0.75);
    const border = withAlpha(cssToken("--ink"), 0.19);
    const arc = withAlpha(accent, 0.85);
    return {
      accent,
      pinDim: withAlpha(accent, 0.3),
      bg: cssToken("--bg"),
      ocean: cssToken("--globe-ocean"),
      land: cssToken("--globe-land"),
      // Per-datum accessor props run through accessor-fn, which treats a
      // plain string as a property name — colors there must be functions.
      // Memoized once, so layers never re-digest over accessor identity.
      pathColorAccessor: (datum: object) =>
        (datum as PathDatum).kind === "border" ? border : coast,
      arcColorAccessor: () => arc,
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
  // Urban footprints: a whisper of accent over the paper — enough to
  // read a city's shape at dive altitude without shouting at globe
  // scale, where the footprints are specks anyway.
  const urbanMaterial = useMemo(
    () =>
      clipBehindHorizon(
        new MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.08 }),
      ),
    [palette],
  );
  const capMaterialAccessor = useMemo(
    () => (polygon: object) => {
      const p = polygon as LandPolygon;
      if (p.patch === "water" || p.water) return lakeMaterial;
      return p.urban ? urbanMaterial : landMaterial;
    },
    [lakeMaterial, landMaterial, urbanMaterial],
  );

  // Land tiles, coastline rings, and country borders, fetched from this
  // origin and streamed onto the globe in frame-sized chunks. Each step
  // sets a slice prefix of a stable array, so the stream is idempotent
  // and append-only. On fetch failure the globe simply renders without
  // that layer — never blank.
  const [land, setLand] = useState<LandPolygon[]>([]);
  const [paths, setPaths] = useState<PathDatum[]>([]);
  // The city window's 10m land/water fills — held separately from the
  // streamed base and merged into the polygon layer only at close zoom.
  const [patchPolys, setPatchPolys] = useState<LandPolygon[]>([]);
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
      fetchJson(CITY_DETAIL_URL),
    ]).then(
      ([tilesGeo, ringsData, bordersData, terrainData, cityData]: [
        { features?: LandPolygon[] } | null,
        { rings?: LineRun[] } | null,
        { borders?: LineRun[] } | null,
        { lakes?: number[][][][]; lakeRings?: LineRun[] } | null,
        {
          urban?: number[][][][];
          rivers?: LineRun[];
          patch?: { land?: number[][][][]; water?: number[][][][]; rings?: LineRun[] };
        } | null,
      ]) => {
        if (cancelled) return;
        const asPatch = (kind: "land" | "water") => (coordinates: number[][][]): LandPolygon => ({
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates },
          patch: kind,
        });
        setPatchPolys([
          ...(cityData?.patch?.land ?? []).map(asPatch("land")),
          ...(cityData?.patch?.water ?? []).map(asPatch("water")),
        ]);
        const tiles = (tilesGeo?.features ?? [])
          .slice()
          .sort((a, b) => tileVertices(b) - tileVertices(a));
        // Lakes and urban washes stream after the land they sit on.
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
          ...(cityData?.urban ?? []).map(
            (coordinates): LandPolygon => ({
              type: "Feature",
              properties: {},
              geometry: { type: "Polygon", coordinates },
              urban: true,
            }),
          ),
        ];
        const lines: PathDatum[] = [
          ...(ringsData?.rings ?? []).map((points): PathDatum => ({ points, kind: "coast" })),
          ...(bordersData?.borders ?? []).map((points): PathDatum => ({ points, kind: "border" })),
          ...(terrainData?.lakeRings ?? []).map(
            (points): PathDatum => ({
              // Pinned high: lake fills sit at 0.01, so a ground-hugging
              // shore ring would disappear under its own lake.
              points: points.map(([x, y]) => [x, y, LINE_ALTITUDE]),
              kind: "coast",
            }),
          ),
          // City rivers draw like coasts — they're water edges too, and
          // the window's 10m coastline rings replace the 50m ones that
          // the build removed inside it.
          ...(cityData?.rivers ?? []).map((points): PathDatum => ({ points, kind: "coast" })),
          ...(cityData?.patch?.rings ?? []).map((points): PathDatum => ({ points, kind: "coast" })),
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
        // The map reads complete here — land, coasts, borders. The boot
        // veil lifts at this point; lakes are garnish and fill in behind
        // the fade rather than holding the visitor at the door.
        const baseSteps = plan.length;
        planPolySlices(tiles.length, polys.length);
        planLineSlices(baseLineCount, lines.length);
        // Final step, one frame after the last chunk has committed: give
        // every line the horizon clip. three-globe stamps each datum with
        // its THREE object, and with stable accessors it never rebuilds
        // these materials afterwards.
        plan.push(() => {
          for (const line of lines) {
            const obj = (line as { __threeObjPath?: { material?: { needsUpdate: boolean; userData: Record<string, boolean>; isLineMaterial?: boolean } } }).__threeObjPath;
            const material = obj?.material;
            if (material && !material.userData.horizonClip) {
              if (material.isLineMaterial) {
                clipFatLineBehindHorizon(material as unknown as Parameters<typeof clipFatLineBehindHorizon>[0]);
              } else {
                clipBehindHorizon(material as unknown as Parameters<typeof clipBehindHorizon>[0]);
              }
              material.needsUpdate = true;
              material.userData.horizonClip = true;
            }
          }
        });
        if (!plan.length) {
          onProgressRef.current?.(1, 1);
          fireLoaded();
          return;
        }

        let step = 0;
        const feedChunk = () => {
          if (cancelled) return;
          plan[step]();
          step += 1;
          onProgressRef.current?.(step, plan.length);
          if (step >= baseSteps) fireLoaded(); // idempotent
          if (step < plan.length) frame = requestAnimationFrame(feedChunk);
        };
        frame = requestAnimationFrame(feedChunk);
      },
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [fireLoaded]);

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

  // Map dots shrink as the camera drops: pointRadius is angular
  // (degrees on the globe), so the 0.22° dot that reads as a pin at
  // globe scale would be a 24km blob swallowing a city view. Coarse
  // buckets keep the digest churn to a handful per flight. At the city
  // bucket the ACTIVE dot all but vanishes — the reticle is the marker
  // there, and a fat dot underneath would swallow its diamond — while
  // neighbor pins stay as small readable blobs.
  const [dotBucket, setDotBucket] = useState(0);
  const dotBucketRef = useRef(0);

  // Lines hug the ground at chapter zooms (see LINE_ALTITUDE_NEAR);
  // per-point baked altitudes (lake rings) always win.
  const lineAlt = dotBucket >= 1 ? LINE_ALTITUDE_NEAR : LINE_ALTITUDE;
  const pathPointAltAccessor = useMemo(
    () => (point: object) => (point as number[])[2] ?? lineAlt,
    [lineAlt],
  );


  // The polygon layer: streamed base everywhere; at close zoom the city
  // window's 10m fills ride on top (kept out of the far view so their
  // tight altitude gaps never meet coarse far-plane depth precision).
  const closeUp = dotBucket >= 2;
  const polygonsData = useMemo<LandPolygon[]>(
    () => (closeUp && patchPolys.length ? [...land, ...patchPolys] : land),
    [land, patchPolys, closeUp],
  );


  // Active-chapter styling for the flat map dots. Memoized per chapter
  // change — identity churn here would re-digest the points layer on
  // every render (and renders come one per chunk while the map streams).
  const pointColorAccessor = useMemo(
    () => (d: object) =>
      (d as PointDatum).chapterId === activeId ? palette.accent : palette.pinDim,
    [activeId, palette],
  );
  const pointRadiusAccessor = useMemo(
    () => (d: object) =>
      (d as PointDatum).chapterId === activeId
        ? ACTIVE_DOT_RADIUS[dotBucket]
        : INACTIVE_DOT_RADIUS[dotBucket],
    [activeId, dotBucket],
  );

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

  // Waypoints confirm as the camera reaches them: lockedCount is how
  // many of the active chapter's pins the tour has arrived at so far.
  // Reticles below that index wear .locked (full brightness + the
  // lock-on flicker); the rest wait dim on the scope. The tour effect
  // advances it at each real arrival.
  const [lockedCount, setLockedCount] = useState(0);
  const lockedFor = useRef<string | null>(activeId);

  // Chapter switches never yank the overlay markers away mid-frame: the
  // outgoing set lingers for a short leaving beat (CSS fades it), then
  // the new chapter's markers key in and play their lock-on entrance.
  const [markerId, setMarkerId] = useState<string | null>(activeId);
  const [markersLeaving, setMarkersLeaving] = useState(false);
  useEffect(() => {
    if (activeId === markerId) return;
    if (reducedMotion) {
      setMarkerId(activeId);
      return;
    }
    setMarkersLeaving(true);
    const timer = window.setTimeout(() => {
      setMarkersLeaving(false);
      setMarkerId(activeId);
    }, MARKER_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [activeId, markerId, reducedMotion]);

  // Every active-chapter pin gets a briefing crosshair, tracked on
  // screen each frame — every viewport; the reticle is the chapter's
  // marker, not desktop decoration.
  const activePins = useMemo<Pin[]>(() => {
    const chapter = chapters.find((ch) => ch.id === markerId);
    return chapter ? [...chapter.pins] : [];
  }, [markerId]);

  // The current stop, reported upward as it changes — App feeds it to
  // PhotoCallouts. A ref carries the latest callback, like onLoaded.
  const onWaypointRef = useRef(onWaypoint);
  onWaypointRef.current = onWaypoint;
  useEffect(() => {
    onWaypointRef.current?.(markerId, lockedCount - 1);
  }, [markerId, lockedCount]);

  // The pin the tour is currently at: photo panels and their leader
  // lines exist only for this stop, so each location's photos appear as
  // the camera locks onto it — not the whole chapter's at once. Desktop
  // only: the panels those lines point at never render on mobile.
  const stopPin = useMemo<Pin | null>(() => {
    if (!isDesktop || lockedCount < 1) return null;
    const chapter = chapters.find((ch) => ch.id === markerId);
    if (!chapter) return null;
    return chapter.pins[Math.min(lockedCount - 1, chapter.pins.length - 1)];
  }, [isDesktop, lockedCount, markerId]);
  // One leader line per panel; PhotoCallouts renders one panel per photo.
  const stopPanelCount = stopPin
    ? Math.min((stopPin.photos ?? []).filter((photo) => photo.src).length, 2)
    : 0;

  // Leader lines: from each callout panel's edge to its pin's projected
  // screen position, re-aimed every frame (the camera is usually moving,
  // and panel heights settle as images load). Written straight to the
  // SVG DOM — no React work at frame rate. Lines vanish while their pin
  // is past the horizon, using the same test as the fragment clip.
  const leaderRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const svg = leaderRef.current;
    if (!ready || !svg || !activePins.length) return;
    let frame = 0;
    // The reticle groups belong to this render, so query them once. The
    // photo panels live in another component on its own exit-lag timer —
    // cache them too, but re-query whenever the cached set is stale
    // (wrong count or detached nodes), instead of every frame.
    const marks = svg.querySelectorAll<SVGGElement>("g.waypoint");
    const lines = svg.querySelectorAll<SVGPolylineElement>("polyline");
    let panels: HTMLElement[] = [];
    const panelsFresh = () =>
      panels.length === stopPanelCount && panels.every((p) => p.isConnected);
    const update = () => {
      frame = requestAnimationFrame(update);
      const globe = globeRef.current;
      if (!globe) return;
      const cam = globe.camera().position;
      const camLen = Math.hypot(cam.x, cam.y, cam.z) || 1;
      const horizon = GLOBE_RADIUS / camLen - 0.005;
      const behindHorizon = (pin: Pin) => {
        const pos = globe.getCoords(pin.lat, pin.lng, RETICLE_ALT);
        const posLen = Math.hypot(pos.x, pos.y, pos.z) || 1;
        return (
          (pos.x * cam.x + pos.y * cam.y + pos.z * cam.z) / (posLen * camLen) < horizon
        );
      };
      // Waypoint reticles on every active pin.
      activePins.forEach((pin, i) => {
        const mark = marks[i];
        if (!mark) return;
        if (behindHorizon(pin)) {
          mark.style.visibility = "hidden";
          return;
        }
        const screen = globe.getScreenCoords(pin.lat, pin.lng, RETICLE_ALT);
        mark.setAttribute("transform", `translate(${screen.x}, ${screen.y})`);
        mark.style.visibility = "visible";
      });
      // Leader lines from each photo panel to the current stop's pin.
      if (!panelsFresh()) {
        panels = [...document.querySelectorAll<HTMLElement>(".photo-callout")];
      }
      const stopVisible = stopPin && !behindHorizon(stopPin);
      const screen = stopVisible
        ? globe.getScreenCoords(stopPin.lat, stopPin.lng, RETICLE_ALT)
        : null;
      lines.forEach((line, i) => {
        const panel = panels[i];
        if (!screen || !panel) {
          line.style.visibility = "hidden";
          return;
        }
        const rect = panel.getBoundingClientRect();
        // The line leaves the panel on the side that faces its pin —
        // out of the right edge when the panel sits left of the marker,
        // out of the left when it sits right — runs a short horizontal
        // stub, then breaks for the pin's crosshair.
        const facingRight = screen.x >= rect.left + rect.width / 2;
        const ax = facingRight ? rect.right : rect.left;
        const ay = rect.top + rect.height / 2;
        const stub = facingRight ? ax + 26 : ax - 26;
        line.setAttribute(
          "points",
          `${ax},${ay} ${stub},${ay} ${screen.x},${screen.y}`,
        );
        line.style.visibility = "visible";
      });
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [ready, activePins, stopPin, stopPanelCount]);

  // The South Pole easter egg: no chapter ever flies south of the
  // equator, so anyone looking at the pole dragged the globe there on
  // purpose. A line waits for them, tracked at 90°S like a waypoint.
  const poleEggRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let shown = false;
    const update = () => {
      frame = requestAnimationFrame(update);
      const globe = globeRef.current;
      const el = poleEggRef.current;
      if (!globe || !el) return;
      const pov = globe.pointOfView() as { lat: number };
      const cam = globe.camera().position;
      const camLen = Math.hypot(cam.x, cam.y, cam.z) || 1;
      const pos = globe.getCoords(-90, 0, RETICLE_ALT);
      const posLen = Math.hypot(pos.x, pos.y, pos.z) || 1;
      const visible =
        pov.lat < -45 &&
        (pos.x * cam.x + pos.y * cam.y + pos.z * cam.z) / (posLen * camLen) >=
          GLOBE_RADIUS / camLen - 0.005;
      if (visible) {
        const screen = globe.getScreenCoords(-90, 0, RETICLE_ALT);
        el.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -160%)`;
      }
      if (visible !== shown) {
        shown = visible;
        el.classList.toggle("on", visible);
      }
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

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
    // No inertia: with damping on, the idle auto-rotate leaves residual
    // angular velocity in the controls that keeps steering the camera
    // for seconds AFTER a flight lands — a drift measured in degrees,
    // fatal at city zoom where 2° is the whole metro area.
    controls.enableDamping = false;
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
    // New chapter: every waypoint back to unconfirmed. (Keyed by id so
    // re-runs for other deps don't reset locks mid-view.)
    if (lockedFor.current !== activeId) {
      lockedFor.current = activeId;
      setLockedCount(0);
    }
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
    const flyLeg = (
      from: Pin,
      to: Pin,
      altitude: number,
      onApproach: () => void,
      onArrive: () => void,
    ) => {
      const a = pinVec(from);
      const b = pinVec(to);
      const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      const omega = Math.acos(dot);
      const ms = TOUR_LEG_MS * (0.75 + omega * 0.5);
      const t0 = performance.now();
      let approached = false;
      const step = (now: number) => {
        if (cancelled) return;
        // Final approach: the destination confirms while still inbound.
        if (!approached && now - t0 >= ms - LOCK_LEAD_MS) {
          approached = true;
          onApproach();
        }
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
          // No tour, no flicker — every waypoint reads as confirmed.
          setLockedCount(chapter.pins.length);
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
        // tourFrom(i) runs the moment the camera is AT pin i. Locks fire
        // earlier — on final approach — so the max here is a backstop in
        // case a lead timer was skipped.
        const tourFrom = (i: number) => {
          setLockedCount((count) => Math.max(count, i + 1));
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
                flyLeg(
                  chapter.pins[i],
                  chapter.pins[i + 1],
                  chapter.altitude,
                  () => setLockedCount((count) => Math.max(count, i + 2)),
                  () => tourFrom(i + 1),
                ),
              TOUR_DWELL_MS,
            ),
          );
        };
        // The first waypoint also confirms on final approach, a lead
        // before the approach flight actually lands on it.
        timers.push(
          window.setTimeout(
            () => setLockedCount((count) => Math.max(count, 1)),
            Math.max(0, FLIGHT_MS - LOCK_LEAD_MS),
          ),
        );
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
  // camera move — no React re-renders at 60fps. The dot-scale bucket
  // rides the same callback; it only touches state when the bucket
  // actually flips.
  const handleZoom = useCallback((pov: { lat: number; lng: number; altitude: number }) => {
    const hud = hudRef.current;
    if (hud) {
      const km = Math.max(0, Math.round(pov.altitude * 6371));
      hud.textContent = `${formatCoordinate(pov.lat, nearestLng(pov.lng, 0))} · ${km} km`;
    }
    const alt = pov.altitude;
    const bucket = alt > 1.2 ? 0 : alt > 0.5 ? 1 : alt > 0.15 ? 2 : 3;
    if (bucket !== dotBucketRef.current) {
      dotBucketRef.current = bucket;
      setDotBucket(bucket);
    }
  }, []);

  return (
    <div ref={containerRef} className="globe-canvas">
      <div ref={hudRef} className="globe-hud" aria-hidden="true" />
      <div ref={poleEggRef} className="pole-egg" aria-hidden="true">
        {site.poleEgg}
      </div>
      {activePins.length > 0 && (
        <svg
          ref={leaderRef}
          className={markersLeaving ? "leader-lines leaving" : "leader-lines"}
          key={markerId ?? "none"}
          aria-hidden="true"
        >
          {/* Lines wait for their panels to finish materializing. Keyed
           * per stop, so every arrival replays the draw. */}
          {stopPin &&
            Array.from({ length: stopPanelCount }, (_, i) => (
              <polyline
                key={`${stopPin.lat},${stopPin.lng},${i}`}
                pathLength={1}
                style={{ animationDelay: `${400 + i * 140}ms` }}
              />
            ))}
          {/* Waypoint reticles on every pin of the active chapter: a
           * diamond outline, four outer ticks, and a center dot. The
           * outer group takes the tracker's translate; the inner group
           * carries the lock-on animation, so they never fight. Marks
           * wait dim until the camera actually arrives at their pin —
           * .locked lands per tour stop and plays the flicker then. */}
          {activePins.map((pin, i) => (
            <g key={`${pin.lat},${pin.lng}`} className="waypoint">
              <g className={i < lockedCount ? "waypoint-mark locked" : "waypoint-mark"}>
                <rect
                  className="wp-diamond"
                  x={-5.2}
                  y={-5.2}
                  width={10.4}
                  height={10.4}
                  transform="rotate(45)"
                />
                <path
                  className="wp-ticks"
                  d="M 0 -12 V -8.4 M 0 8.4 V 12 M -12 0 H -8.4 M 8.4 0 H 12"
                />
                <circle className="wp-dot" r={1.5} />
              </g>
            </g>
          ))}
        </svg>
      )}
      {size.width > 0 && size.height > 0 && (
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor={palette.bg}
          globeMaterial={globeMaterial}
          atmosphereColor={palette.accent}
          atmosphereAltitude={0.1}
          polygonsData={polygonsData}
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
          pathPointAlt={pathPointAltAccessor}
          pathStroke={PATH_STROKE}
          pathTransitionDuration={0}
          pointsData={points}
          pointLat={POINT_LAT}
          pointLng={POINT_LNG}
          pointColor={pointColorAccessor}
          // Every location is a flat map dot — the SVG reticle does the
          // marking for the active chapter. No pillars.
          pointRadius={pointRadiusAccessor}
          pointAltitude={0.008}
          pointsTransitionDuration={reducedMotion ? 0 : PIN_ENTER_MS}
          arcsData={arcs}
          arcStartLat={ARC_START_LAT}
          arcStartLng={ARC_START_LNG}
          arcEndLat={ARC_END_LAT}
          arcEndLng={ARC_END_LNG}
          arcColor={palette.arcColorAccessor}
          arcStroke={0.22}
          arcAltitudeAutoScale={0.3}
          arcDashLength={reducedMotion ? 1 : 0.09}
          arcDashGap={reducedMotion ? 0 : 0.13}
          arcDashAnimateTime={reducedMotion ? 0 : 1600}
          arcsTransitionDuration={reducedMotion ? 0 : ARC_ENTER_MS}
          showGraticules={true}
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
