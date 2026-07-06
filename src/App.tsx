import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chapters, site } from "./data/chapters";
import { Hero } from "./components/Hero";
import { ChapterSection } from "./components/ChapterSection";
import { ChapterIndex } from "./components/ChapterIndex";
import { SiteFooter } from "./components/SiteFooter";
import { GlobePlaceholder } from "./components/GlobePlaceholder";
import { GlobeErrorBoundary } from "./components/GlobeErrorBoundary";
import { PhotoCallouts } from "./components/PhotoCallouts";
import { hasWebGL } from "./lib/webgl";
import { readingCenterFraction } from "./lib/viewport";
import { useMediaQuery } from "./hooks/useMediaQuery";

// Three.js loads lazily so first contentful paint never waits on it.
const GlobeScene = lazy(() => import("./components/GlobeScene"));

/** How long the camera plunge runs before the page goes word-only. */
const DIVE_MS = 950;

export default function App() {
  const [activeId, setActiveId] = useState<string | null>(null);
  // "Down to earth": the globe dives into the planet, then the site
  // switches to the plain text column (the same layout the no-WebGL
  // fallback uses — words only, nothing waiting on a canvas).
  const [earthbound, setEarthbound] = useState(false);
  const [diving, setDiving] = useState(false);
  const diveTimer = useRef(0);
  const webgl = useMemo(hasWebGL, []);
  const isDesktop = useMediaQuery("(min-width: 900px)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // Boot veil: covers the page while the globe streams its map in, then
  // fades away. Dismissed by the globe's loaded callback, with a hard
  // failsafe so a stalled fetch can never trap the visitor behind it.
  const [booted, setBooted] = useState(false);
  const [bootLeaving, setBootLeaving] = useState(false);
  // The veil's progress bar is written straight to the DOM as the map
  // chunks commit — no React re-renders at streaming rate.
  const bootBarRef = useRef<HTMLDivElement | null>(null);
  const bootProgress = useCallback((done: number, total: number) => {
    const bar = bootBarRef.current;
    if (bar) bar.style.transform = `scaleX(${total > 0 ? done / total : 1})`;
  }, []);
  const bootDone = useCallback(() => {
    // However we got here (stream finished or failsafe), leave with a
    // full bar rather than freezing mid-fill under the fade.
    const bar = bootBarRef.current;
    if (bar) bar.style.transform = "scaleX(1)";
    setBooted((already) => {
      if (!already) {
        setBootLeaving(true);
        window.setTimeout(() => setBootLeaving(false), 650);
      }
      return true;
    });
  }, []);
  useEffect(() => {
    // No WebGL means no globe to wait for; a Save-Data visitor gets the
    // content immediately rather than a ceremony they're paying for.
    const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (!webgl || conn?.saveData) {
      setBooted(true);
      return;
    }
    const failsafe = window.setTimeout(bootDone, 5000);
    return () => window.clearTimeout(failsafe);
  }, [webgl, bootDone]);

  // Warm the browser cache for every chapter photo once the globe is up,
  // so callout panels never pop in half-loaded mid-scroll. Desktop only:
  // the callout panels never render below 900px, so phones shouldn't
  // spend a byte on them.
  useEffect(() => {
    if (!booted || !isDesktop) return;
    for (const chapter of chapters) {
      for (const pin of chapter.pins) {
        for (const photo of pin.photos ?? []) {
          const img = new Image();
          img.src = photo.src;
        }
      }
    }
  }, [booted, isDesktop]);
  const showGlobe = webgl && !earthbound;

  // Track which section sits at the center of the reading window. The
  // rootMargin leaves a 10% band around that line — the robust equivalent
  // of "threshold ~0.5" that also works for sections taller than the
  // viewport. State only changes when a section crosses the band, so
  // scrolling through the gaps between sections never flickers.
  useEffect(() => {
    const mid = readingCenterFraction(isDesktop) * 100;
    const rootMargin = `-${mid - 5}% 0px -${100 - mid - 5}% 0px`;
    const observed = document.querySelectorAll<HTMLElement>("[data-observe]");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.getAttribute("data-observe");
          setActiveId(id === "hero" ? null : id);
        }
      },
      { rootMargin, threshold: 0 },
    );
    observed.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [isDesktop]);

  // Section entry: a soft fade-up on the section, plus the electronic
  // acquire-flicker CSS keys off the same .in-view class for the
  // briefing chrome inside it. Reduced motion is handled in CSS
  // (sections render in place, flickers collapse), so this observer
  // stays inert there.
  useEffect(() => {
    const faded = document.querySelectorAll<HTMLElement>("[data-fade]");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.12 },
    );
    faded.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(diveTimer.current), []);

  const toggleEarthbound = () => {
    if (earthbound) {
      setEarthbound(false);
      return;
    }
    if (!showGlobe || reducedMotion) {
      setEarthbound(true);
      return;
    }
    // Let the plunge play, then switch to words.
    setDiving(true);
    diveTimer.current = window.setTimeout(() => {
      setEarthbound(true);
      setDiving(false);
    }, DIVE_MS);
  };

  // .booted lands when the veil lifts: the hero and HUD play their
  // signal-acquire flicker at the moment of reveal, not behind it.
  const layoutClass = [
    "layout",
    showGlobe ? "" : "no-globe",
    booted ? "booted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={layoutClass}>
      <a className="skip-link" href="#chapters">
        {site.skipLinkLabel}
      </a>
      {webgl && (!booted || bootLeaving) && (
        <div className={booted ? "boot-veil leaving" : "boot-veil"} role="status">
          <div className="boot-veil-inner">
            <svg className="boot-mark" viewBox="-14 -14 28 28" aria-hidden="true">
              <rect x={-5.2} y={-5.2} width={10.4} height={10.4} transform="rotate(45)" />
              <path d="M 0 -12 V -8.4 M 0 8.4 V 12 M -12 0 H -8.4 M 8.4 0 H 12" />
              <circle r={1.5} />
            </svg>
            {/* The label types itself in per character; screen readers
             * get the plain string, the animated spans are decoration. */}
            <p className="boot-label">
              <span className="boot-label-sr">{site.loadingLabel}</span>
              <span aria-hidden="true">
                {[...site.loadingLabel].map((ch, i) => (
                  <span
                    key={i}
                    className="boot-ch"
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    {ch === " " ? " " : ch}
                  </span>
                ))}
              </span>
            </p>
            <div className="boot-progress" aria-hidden="true">
              <div className="boot-progress-fill" ref={bootBarRef} />
            </div>
          </div>
        </div>
      )}
      {webgl && (
        <button
          type="button"
          className="earth-toggle"
          onClick={toggleEarthbound}
          disabled={diving}
          aria-pressed={earthbound}
        >
          <span className="earth-toggle-label">
            {earthbound ? site.earthUp : site.earthDown}
          </span>
        </button>
      )}
      {showGlobe && isDesktop && (
        <PhotoCallouts activeId={activeId} reducedMotion={reducedMotion} />
      )}
      {showGlobe && (
        <div className="globe-pane" aria-hidden="true">
          <GlobeErrorBoundary fallback={<GlobePlaceholder />}>
            <Suspense fallback={<GlobePlaceholder />}>
              <GlobeScene
                activeId={activeId}
                isDesktop={isDesktop}
                reducedMotion={reducedMotion}
                diving={diving}
                onLoaded={bootDone}
                onProgress={bootProgress}
              />
            </Suspense>
          </GlobeErrorBoundary>
        </div>
      )}
      <ChapterIndex
        activeId={activeId}
        isDesktop={isDesktop}
        reducedMotion={reducedMotion}
      />
      <div className="rail">
        <Hero />
        <main id="chapters">
          <p className="about" data-fade>
            {site.about}
          </p>
          {chapters.map((chapter, i) => (
            <ChapterSection key={chapter.id} chapter={chapter} index={i} />
          ))}
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
