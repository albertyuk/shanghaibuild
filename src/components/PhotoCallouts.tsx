import { chapters } from "../data/chapters";
import { formatCoordinate } from "../lib/coords";

interface Props {
  activeId: string | null;
}

/**
 * Briefing-map photo callouts: for each pin of the active chapter that
 * has photos, a sat-photo panel — mono title bar, desaturated image,
 * coordinate readout — pinned to the map pane's top-left, under the
 * corner tick. Pins without photos render nothing, so the panel column
 * stays invisible until photo slots are filled in chapters.ts (or via
 * the private editor). Desktop only; the mobile pane is too small.
 */
export function PhotoCallouts({ activeId }: Props) {
  const chapter = chapters.find((ch) => ch.id === activeId);
  if (!chapter) return null;
  const withPhotos = chapter.pins
    .filter((pin) => pin.photos && pin.photos.length > 0)
    .slice(0, 2);
  if (!withPhotos.length) return null;

  return (
    <aside className="photo-callouts" key={chapter.id} aria-label={chapter.title}>
      {withPhotos.map((pin) => {
        const photos = (pin.photos ?? []).slice(0, 2);
        const captions = photos.map((photo) => photo.caption).filter(Boolean);
        return (
          <figure className="photo-callout" key={`${pin.lat},${pin.lng}`}>
            <figcaption className="photo-callout-title">
              <span className="photo-callout-place">{pin.city}</span>
              <span className="photo-callout-coords">
                {formatCoordinate(pin.lat, pin.lng)}
              </span>
            </figcaption>
            <div className="photo-callout-strip">
              {photos.map((photo, i) => (
                <img
                  key={i}
                  src={photo.src}
                  alt={photo.caption ?? `${pin.city}, ${pin.country}`}
                  loading="lazy"
                />
              ))}
            </div>
            {captions.length > 0 && (
              <p className="photo-callout-caption">{captions.join(" · ")}</p>
            )}
          </figure>
        );
      })}
    </aside>
  );
}
