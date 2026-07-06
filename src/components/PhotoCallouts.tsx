import { useEffect, useState } from "react";
import { chapters, site } from "../data/chapters";
import { formatCoordinate } from "../lib/coords";
import { Decode } from "./Decode";

/** The globe tour's current position: which chapter, and which of its
 *  pins the camera has most recently locked onto. */
export interface TourStop {
  chapterId: string;
  pinIndex: number;
}

interface Props {
  stop: TourStop | null;
  reducedMotion: boolean;
}

/** How long the outgoing panels linger to play their dematerialize
 *  before the next stop's set keys in. Matches the globe overlay. */
const LEAVE_MS = 220;

/**
 * Briefing-map photo callouts for the tour's current stop: one sat-photo
 * panel per photo of the pin the camera just locked onto — mono title
 * bar, data strip of real coordinates. A second photo of the same place
 * gets its own panel headed by the "Ibid." label rather than repeating
 * the city. Panels materialize (wipe in) as the camera arrives; moving
 * on to the next pin swaps them for that location's set. The leader
 * lines live in GlobeScene, tracking the pin's projected position every
 * frame. Pins without photos render nothing. Desktop only; the mobile
 * pane is too small.
 */
export function PhotoCallouts({ stop, reducedMotion }: Props) {
  // Panels never blink out: on a stop change the outgoing set plays a
  // short dematerialize (CSS `.leaving`), then the new stop's panels
  // key in and materialize as usual.
  const [view, setView] = useState<{ stop: TourStop | null; leaving: boolean }>({
    stop,
    leaving: false,
  });
  useEffect(() => {
    if (
      view.stop?.chapterId === stop?.chapterId &&
      view.stop?.pinIndex === stop?.pinIndex
    )
      return;
    if (reducedMotion || view.stop === null) {
      // Nothing on screen to dematerialize — key the new set straight
      // in, so arrival panels sync with the lock-on flicker.
      setView({ stop, leaving: false });
      return;
    }
    setView((v) => (v.leaving ? v : { ...v, leaving: true }));
    const timer = window.setTimeout(
      () => setView({ stop, leaving: false }),
      LEAVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [stop, view.stop, reducedMotion]);

  const shown = view.stop;
  const chapter = shown ? chapters.find((ch) => ch.id === shown.chapterId) : undefined;
  const pin = chapter && shown ? chapter.pins[shown.pinIndex] : undefined;
  const photos = (pin?.photos ?? []).filter((photo) => photo.src).slice(0, 2);
  if (!chapter || !shown || !pin || photos.length === 0) return null;

  return (
    <aside
      className={view.leaving ? "photo-callouts leaving" : "photo-callouts"}
      key={`${chapter.id}:${shown.pinIndex}`}
      aria-label={chapter.title}
      // A placed pin moves the whole stack from the default corner to
      // its authored spot: top-left at (x% across, y% down) the screen,
      // clamped so it can never hang off the viewport.
      style={
        pin.panel
          ? {
              left: `clamp(8px, ${pin.panel.x}vw, calc(100vw - min(230px, 22vw) - 8px))`,
              top: `clamp(8px, ${pin.panel.y}vh, calc(100vh - 160px))`,
              right: "auto",
              bottom: "auto",
            }
          : undefined
      }
    >
      {photos.map((photo, i) => (
        <figure className="photo-callout" key={i}>
          <figcaption className="photo-callout-title">
            {/* Decodes as the panel materializes (fresh mount per stop,
             * so no pause gating needed). */}
            <Decode text={i === 0 ? pin.city : site.ibidLabel} step={40} delay={240} />
          </figcaption>
          <div className="photo-callout-strip">
            <img src={photo.src} alt={photo.caption ?? `${pin.city}, ${pin.country}`} />
          </div>
          <p className="photo-callout-data">
            {formatCoordinate(pin.lat, pin.lng)} · {pin.country.toUpperCase()}
          </p>
          {photo.caption && <p className="photo-callout-caption">{photo.caption}</p>}
        </figure>
      ))}
    </aside>
  );
}
