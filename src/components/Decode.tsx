import { Fragment } from "react";

interface Props {
  text: string;
  /** Per-character stagger, ms. */
  step?: number;
  /** Delay before the first character, ms. */
  delay?: number;
}

/**
 * Terminal block-decode: each character lands as a solid accent block,
 * decodes to its letter, drops out once, and holds — the boot screen's
 * typing effect, reusable for any briefing-chrome string. Words stay
 * unbreakable (chars are inline-block, so a naked stream of them would
 * wrap mid-word), spaces pass through as plain text so lines still
 * break normally, and the delay index counts them so the sweep's
 * cadence never skips. Screen readers get the plain string; the
 * animated spans are decoration.
 *
 * Some hosts pause the sweep until a trigger class lands (e.g. the
 * chapter eyebrow waits for .in-view) — that gating lives in CSS via
 * animation-play-state, not here.
 */
export function Decode({ text, step = 45, delay = 0 }: Props) {
  const words = text.split(" ");
  let index = 0;
  return (
    <>
      <span className="decode-sr">{text}</span>
      <span aria-hidden="true">
        {words.map((word, w) => {
          const start = index;
          index += word.length + 1; // +1 keeps the space's beat
          return (
            <Fragment key={w}>
              <span className="decode-word">
                {[...word].map((ch, j) => (
                  <span
                    key={j}
                    className="decode-ch"
                    style={{ animationDelay: `${delay + (start + j) * step}ms` }}
                  >
                    {ch}
                  </span>
                ))}
              </span>
              {w < words.length - 1 && " "}
            </Fragment>
          );
        })}
      </span>
    </>
  );
}
