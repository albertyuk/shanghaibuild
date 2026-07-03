import { chapters, site } from "../data/chapters";

interface Props {
  activeId: string | null;
  reducedMotion: boolean;
}

/**
 * Compact fixed chapter nav — the skip mechanism. Scrolling to a section
 * centers it, which is what triggers the globe flight, so clicking a chapter
 * both scrolls and flies; the animation is never the only way to navigate.
 */
export function ChapterIndex({ activeId, reducedMotion }: Props) {
  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
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
