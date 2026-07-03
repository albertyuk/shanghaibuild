import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { chapters, site } from "./data/chapters";
import { Hero } from "./components/Hero";
import { ChapterSection } from "./components/ChapterSection";
import { ChapterIndex } from "./components/ChapterIndex";
import { SiteFooter } from "./components/SiteFooter";
import { GlobePlaceholder } from "./components/GlobePlaceholder";
import { GlobeErrorBoundary } from "./components/GlobeErrorBoundary";
import { hasWebGL } from "./lib/webgl";
import { useMediaQuery } from "./hooks/useMediaQuery";

// Three.js loads lazily so first contentful paint never waits on it.
const GlobeScene = lazy(() => import("./components/GlobeScene"));

export default function App() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const webgl = useMemo(hasWebGL, []);
  const isDesktop = useMediaQuery("(min-width: 900px)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  // Track which section sits at the viewport's center. The −45%/−45%
  // rootMargin leaves a 10% band around the center line — the robust
  // equivalent of "threshold ~0.5" that also works for sections taller
  // than the viewport. State only changes when a section crosses center,
  // so scrolling through the gaps between sections never flickers.
  useEffect(() => {
    const observed = document.querySelectorAll<HTMLElement>("[data-observe]");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.getAttribute("data-observe");
          setActiveId(id === "hero" ? null : id);
        }
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );
    observed.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // The one text animation: a single soft fade-up on section entry.
  // Reduced motion is handled in CSS (sections render in place, no
  // transition), so this observer stays inert there.
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

  return (
    <div className={webgl ? "layout" : "layout no-globe"}>
      <a className="skip-link" href="#chapters">
        {site.skipLinkLabel}
      </a>
      {webgl && (
        <div className="globe-pane" aria-hidden="true">
          <GlobeErrorBoundary fallback={<GlobePlaceholder />}>
            <Suspense fallback={<GlobePlaceholder />}>
              <GlobeScene
                activeId={activeId}
                isDesktop={isDesktop}
                reducedMotion={reducedMotion}
              />
            </Suspense>
          </GlobeErrorBoundary>
        </div>
      )}
      <ChapterIndex activeId={activeId} reducedMotion={reducedMotion} />
      <div className="rail">
        <Hero />
        <p className="about" data-fade>
          {site.about}
        </p>
        <main id="chapters">
          {chapters.map((chapter, i) => (
            <ChapterSection key={chapter.id} chapter={chapter} index={i} />
          ))}
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
