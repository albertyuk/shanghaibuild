import { useEffect, useState } from "react";
import { chapters } from "../data/chapters";
import { formatCoordinate } from "../lib/coords";
import { Decode } from "./Decode";

interface Props {
  activeId: string | null;
  reducedMotion: boolean;
}

/** How long the outgoing panels linger to play their dematerialize
 *  before the next chapter's set keys in. Matches the globe overlay. */
const LEAVE_MS = 220;

/**
 * Briefing-map photo callouts: for each pin of the active chapter that
 * has photos, a sat-photo panel — mono title bar, desaturated image,
 * data strip of real coordinates — pinned under the map pane's corner
 * tick. Panels materialize (wipe in) after their leader line draws; the
 * line itself lives in GlobeScene, tracking the pin's projected position
 * every frame. Pins without photos render nothing, so this stays
 * invisible until photo slots are filled. Desktop only; the mobile pane
 * is too small.
 */
export function PhotoCallouts({ activeId, reducedMotion }: Props) {
  // Panels never blink out: on chapter change the outgoing set plays a
  // short dematerialize (CSS `.leaving`), then the new chapter's panels
  // key in and materialize as usual.
  const [view, setView] = useState<{ id: string | null; leaving: boolean }>({
    id: activeId,
    leaving: false,
  });
  useEffect(() => {
    if (view.id === activeId) return;
    if (reducedMotion) {
      setView({ id: activeId, leaving: false });
      return;
    }
    setView((v) => (v.leaving ? v : { ...v, leaving: true }));
    const timer = window.setTimeout(
      () => setView({ id: activeId, leaving: false }),
      LEAVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeId, view.id, reducedMotion]);

  const chapter = chapters.find((ch) => ch.id === view.id);
  if (!chapter) return null;
  const withPhotos = chapter.pins
    .filter((pin) => pin.photos && pin.photos.length > 0)
    .slice(0, 2);
  if (!withPhotos.length) return null;

  return (
    <aside
      className={view.leaving ? "photo-callouts leaving" : "photo-callouts"}
      key={chapter.id}
      aria-label={chapter.title}
    >
      {withPhotos.map((pin) => {
        const photos = (pin.photos ?? []).slice(0, 2);
        const captions = photos.map((photo) => photo.caption).filter(Boolean);
        return (
          <figure
            className="photo-callout"
            key={`${pin.lat},${pin.lng}`}
            // A placed panel leaves the default stack for its authored
            // spot: top-left corner at (x% across, y% down) the screen,
            // clamped so it can never hang off the viewport. It stops
            // sizing from the stack container, so width comes along.
            style={
              pin.panel
                ? {
                    position: "fixed",
                    left: `clamp(8px, ${pin.panel.x}vw, calc(100vw - min(230px, 22vw) - 8px))`,
                    top: `clamp(8px, ${pin.panel.y}vh, calc(100vh - 160px))`,
                    width: "min(230px, 22vw)",
                  }
                : undefined
            }
          >
            <figcaption className="photo-callout-title">
              {/* Decodes as the panel materializes (fresh mount per
               * chapter, so no pause gating needed). */}
              <Decode text={pin.city} step={40} delay={240} />
            </figcaption>
            <div className="photo-callout-strip">
              {photos.map((photo, i) => (
                <img
                  key={i}
                  src={photo.src}
                  alt={photo.caption ?? `${pin.city}, ${pin.country}`}
                />
              ))}
            </div>
            <p className="photo-callout-data">
              {formatCoordinate(pin.lat, pin.lng)} · {pin.country.toUpperCase()}
            </p>
            {captions.length > 0 && (
              <p className="photo-callout-caption">{captions.join(" · ")}</p>
            )}
          </figure>
        );
      })}
    </aside>
  );
}
