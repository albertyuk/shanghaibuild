import { chapters, site } from "../data/chapters";
import { readingCenterFraction } from "../lib/viewport";

interface Props {
  activeId: string | null;
  isDesktop: boolean;
  reducedMotion: boolean;
}

/**
 * Compact fixed chapter nav — the skip mechanism. A click scrolls the
 * section to the center of the reading window, which is exactly where the
 * IntersectionObserver activates it, so clicking a chapter both scrolls
 * and flies the globe; the animation is never the only way to navigate.
 */
export function ChapterIndex({ activeId, isDesktop, reducedMotion }: Props) {
  const jumpTo = (id: string) => {
    const section = document.getElementById(id);
    if (!section) return;
    const rect = section.getBoundingClientRect();
    const fraction = readingCenterFraction(isDesktop);
    let target =
      window.scrollY + rect.top + rect.height / 2 - window.innerHeight * fraction;
    if (!isDesktop) {
      // A section taller than the mobile reading window would center with
      // its heading under the sticky globe; align its top just below the
      // globe instead. (globe bottom = (2·fraction − 1) · viewport)
      const globeBottom = (2 * fraction - 1) * window.innerHeight;
      const topAligned = window.scrollY + rect.top - globeBottom - 16;
      target = Math.min(target, topAligned);
    }
    window.scrollTo({
      top: Math.max(0, target),
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  return (
    <nav className="chapter-index" aria-label={site.chaptersHeading}>
      {chapters.map((chapter, i) => (
        <button
          key={chapter.id}
          type="button"
          className={chapter.id === activeId ? "index-item is-active" : "index-item"}
          aria-current={chapter.id === activeId ? "true" : undefined}
          onClick={() => jumpTo(chapter.id)}
        >
          <span className="index-num">{String(i + 1).padStart(2, "0")}</span>
          <span className="index-title">{chapter.title}</span>
        </button>
      ))}
    </nav>
  );
}
