import type { Chapter } from "../data/chapters";
import { chapterEyebrow } from "../lib/coords";

interface Props {
  chapter: Chapter;
  index: number;
}

export function ChapterSection({ chapter, index }: Props) {
  const meta = [chapter.role, chapter.org, chapter.dates].filter(Boolean).join(" · ");

  return (
    <section
      className="chapter"
      id={chapter.id}
      data-observe={chapter.id}
      data-fade
      aria-labelledby={`${chapter.id}-title`}
    >
      <p className="chapter-num">{String(index + 1).padStart(2, "0")}</p>
      <p className="eyebrow">{chapterEyebrow(chapter)}</p>
      <h2 id={`${chapter.id}-title`}>{chapter.title}</h2>
      {meta && <p className="chapter-meta">{meta}</p>}
      <p className="blurb">{chapter.blurb}</p>
      {chapter.link && (
        <a className="chapter-link" href={chapter.link} target="_blank" rel="noreferrer">
          {chapter.link.replace(/^https?:\/\/(www\.)?/, "")} ↗
        </a>
      )}
    </section>
  );
}
