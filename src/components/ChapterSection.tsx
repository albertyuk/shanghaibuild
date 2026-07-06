import { chapters, type Chapter } from "../data/chapters";
import { chapterEyebrow } from "../lib/coords";
import { Decode } from "./Decode";

interface Props {
  chapter: Chapter;
  index: number;
}

/**
 * Moon-phase path for the chapter glyph: the lit (right) half-disc plus a
 * terminator ellipse whose x-radius runs the phase, so chapters advance
 * from new moon (01) to full (06). Degenerate at fraction 0 — fills
 * nothing, leaving only the outline ring.
 */
function moonPath(fraction: number): string {
  const rx = Math.abs(2 * fraction - 1) * 8;
  const sweep = fraction > 0.5 ? 1 : 0;
  return `M10 2 A8 8 0 0 1 10 18 A${rx} 8 0 0 ${sweep} 10 2`;
}

export function ChapterSection({ chapter, index }: Props) {
  const meta = [chapter.role, chapter.org, chapter.dates].filter(Boolean).join(" · ");
  const eyebrow = chapterEyebrow(chapter);
  // Long multi-city eyebrows sweep faster so the decode never drags —
  // the whole line lands in roughly a second regardless of length.
  const eyebrowStep = Math.max(14, Math.min(38, Math.round(1100 / eyebrow.length)));

  return (
    <section
      className="chapter"
      id={chapter.id}
      data-observe={chapter.id}
      data-fade
      aria-labelledby={`${chapter.id}-title`}
    >
      <p className="chapter-num">
        {String(index + 1).padStart(2, "0")}
        <svg className="moon-glyph" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="8" />
          <path d={moonPath(index / Math.max(1, chapters.length - 1))} />
        </svg>
      </p>
      <p className="eyebrow">
        <Decode text={eyebrow} step={eyebrowStep} />
      </p>
      <h2 id={`${chapter.id}-title`}>{chapter.title}</h2>
      {meta && <p className="chapter-meta">{meta}</p>}
      <p className="blurb">{chapter.blurb}</p>
      {/* Authored content: only web links may render (scheme backstop —
       * the editor validates this too). */}
      {chapter.link && /^https?:\/\//i.test(chapter.link) && (
        <a className="chapter-link" href={chapter.link} target="_blank" rel="noreferrer">
          {chapter.link.replace(/^https?:\/\/(www\.)?/, "")}{" "}
          <span className="link-arrow" aria-hidden="true">
            ↗
          </span>
        </a>
      )}
    </section>
  );
}
