import { useMemo, useState } from "react";
import { chapters as sourceChapters, site as sourceSite } from "../data/chapters";
import type { EditableChapter, SiteContent } from "./types";
import { generateChaptersTs } from "./generate";
import { MapPicker } from "./MapPicker";

/**
 * The private content editor (/edit.html — unlinked, noindexed). The site
 * is static with no backend, so this page edits a draft in memory and
 * exports a ready-to-commit src/data/chapters.ts. Nothing persists until
 * that file is committed and deployed.
 */

const deepCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function validate(chapters: EditableChapter[], site: SiteContent): string[] {
  const errors: string[] = [];
  if (!site.name.trim()) errors.push("Site: name is empty.");
  const ids = new Set<string>();
  chapters.forEach((chapter, i) => {
    const label = `Chapter ${String(i + 1).padStart(2, "0")}`;
    if (!chapter.id.trim() || !/^[a-z0-9-]+$/.test(chapter.id)) {
      errors.push(`${label}: id must be a lowercase slug (a-z, 0-9, dashes).`);
    }
    if (ids.has(chapter.id)) errors.push(`${label}: duplicate id "${chapter.id}".`);
    ids.add(chapter.id);
    if (!chapter.title.trim()) errors.push(`${label}: title is empty.`);
    if (!chapter.pins.length) errors.push(`${label}: needs at least one pin.`);
    chapter.pins.forEach((pin, p) => {
      if (Math.abs(pin.lat) > 90) errors.push(`${label}, pin ${p + 1}: lat out of range.`);
      if (Math.abs(pin.lng) > 180) errors.push(`${label}, pin ${p + 1}: lng out of range.`);
    });
    if (chapter.altitude < 0.05 || chapter.altitude > 3) {
      errors.push(`${label}: altitude should be between 0.05 and 3.`);
    }
    chapter.pins.forEach((pin, p) => {
      (pin.photos ?? []).forEach((photo, k) => {
        if ((photo.caption ?? "").trim() && !photo.src.trim()) {
          errors.push(
            `${label}, pin ${p + 1}: photo ${k + 1} has a caption but no image URL.`,
          );
        }
      });
    });
    for (const [from, to] of chapter.arcs ?? []) {
      if (!chapter.pins[from] || !chapter.pins[to]) {
        errors.push(`${label}: arc [${from}, ${to}] points at a missing pin.`);
      }
    }
  });
  return errors;
}

export function EditorApp() {
  const [chapters, setChapters] = useState<EditableChapter[]>(() =>
    deepCopy(sourceChapters as unknown as EditableChapter[]),
  );
  const [site, setSite] = useState<SiteContent>(() => deepCopy(sourceSite));
  const [openMap, setOpenMap] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const errors = useMemo(() => validate(chapters, site), [chapters, site]);
  const output = useMemo(
    () => (errors.length ? "" : generateChaptersTs(chapters, site)),
    [chapters, site, errors],
  );

  const patchChapter = (index: number, patch: Partial<EditableChapter>) =>
    setChapters((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  const patchPin = (
    chapterIndex: number,
    pinIndex: number,
    patch: Partial<EditableChapter["pins"][number]>,
  ) =>
    setChapters((prev) =>
      prev.map((c, i) =>
        i === chapterIndex
          ? { ...c, pins: c.pins.map((p, j) => (j === pinIndex ? { ...p, ...patch } : p)) }
          : c,
      ),
    );

  // Photo slots are a fixed pair per pin; empty srcs are dropped at export.
  const setPhoto = (
    chapterIndex: number,
    pinIndex: number,
    slot: number,
    patch: { src?: string; caption?: string },
  ) =>
    setChapters((prev) =>
      prev.map((c, i) => {
        if (i !== chapterIndex) return c;
        return {
          ...c,
          pins: c.pins.map((pin, j) => {
            if (j !== pinIndex) return pin;
            const photos = [0, 1].map((k) => pin.photos?.[k] ?? { src: "" });
            photos[slot] = { ...photos[slot], ...patch };
            return { ...pin, photos };
          }),
        };
      }),
    );

  const download = () => {
    const blob = new Blob([output], { type: "text/typescript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chapters.ts";
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const textField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    long = false,
  ) => (
    <label className="field">
      <span>{label}</span>
      {long ? (
        <textarea value={value} rows={4} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );

  return (
    <div className="editor">
      <header className="editor-head">
        <h1>Content editor</h1>
        <p className="editor-note">
          Private page — nothing here is saved anywhere. Edit, then export the
          file and replace <code>src/data/chapters.ts</code> in the repo; the
          site updates on the next deploy.
        </p>
      </header>

      <section className="panel">
        <h2>Site copy</h2>
        <div className="grid">
          {textField("Name", site.name, (v) => setSite({ ...site, name: v }))}
          {textField("Kicker", site.kicker, (v) => setSite({ ...site, kicker: v }))}
          {textField("Identity line", site.identity, (v) => setSite({ ...site, identity: v }), true)}
          {textField("Scroll cue", site.scrollCue, (v) => setSite({ ...site, scrollCue: v }))}
          {textField("About", site.about, (v) => setSite({ ...site, about: v }), true)}
          {textField("Footer note", site.footerNote, (v) => setSite({ ...site, footerNote: v }), true)}
          {textField("Contact heading", site.contactHeading, (v) => setSite({ ...site, contactHeading: v }))}
          {textField("Chapters heading", site.chaptersHeading, (v) => setSite({ ...site, chaptersHeading: v }))}
          {textField("Toggle — down", site.earthDown, (v) => setSite({ ...site, earthDown: v }))}
          {textField("Toggle — up", site.earthUp, (v) => setSite({ ...site, earthUp: v }))}
          {textField("Skip link", site.skipLinkLabel, (v) => setSite({ ...site, skipLinkLabel: v }))}
        </div>
        <h3>Contact links</h3>
        {site.contact.map((item, i) => (
          <div className="row" key={i}>
            <input
              type="text"
              value={item.label}
              aria-label={`Contact ${i + 1} label`}
              onChange={(e) =>
                setSite({
                  ...site,
                  contact: site.contact.map((c, j) =>
                    j === i ? { ...c, label: e.target.value } : c,
                  ),
                })
              }
            />
            <input
              type="text"
              value={item.href}
              aria-label={`Contact ${i + 1} URL`}
              onChange={(e) =>
                setSite({
                  ...site,
                  contact: site.contact.map((c, j) =>
                    j === i ? { ...c, href: e.target.value } : c,
                  ),
                })
              }
            />
            <button
              type="button"
              className="ghost"
              onClick={() =>
                setSite({ ...site, contact: site.contact.filter((_, j) => j !== i) })
              }
            >
              remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ghost"
          onClick={() =>
            setSite({ ...site, contact: [...site.contact, { label: "", href: "" }] })
          }
        >
          + add contact link
        </button>
      </section>

      {chapters.map((chapter, i) => (
        <section className="panel" key={i}>
          <h2>
            Chapter {String(i + 1).padStart(2, "0")}
            <span className="panel-actions">
              <button
                type="button"
                className="ghost"
                disabled={i === 0}
                onClick={() =>
                  setChapters((prev) => {
                    const next = [...prev];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    return next;
                  })
                }
              >
                ↑
              </button>
              <button
                type="button"
                className="ghost"
                disabled={i === chapters.length - 1}
                onClick={() =>
                  setChapters((prev) => {
                    const next = [...prev];
                    [next[i + 1], next[i]] = [next[i], next[i + 1]];
                    return next;
                  })
                }
              >
                ↓
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() => setChapters((prev) => prev.filter((_, j) => j !== i))}
              >
                delete chapter
              </button>
            </span>
          </h2>
          <div className="grid">
            {textField("Id (slug)", chapter.id, (v) => patchChapter(i, { id: v }))}
            {textField("Title", chapter.title, (v) => patchChapter(i, { title: v }))}
            {textField("Organization", chapter.org, (v) => patchChapter(i, { org: v }))}
            {textField("Role", chapter.role, (v) => patchChapter(i, { role: v }))}
            {textField("Dates", chapter.dates, (v) => patchChapter(i, { dates: v }))}
            {textField("Link (optional)", chapter.link ?? "", (v) =>
              patchChapter(i, { link: v || undefined }),
            )}
            {textField("Blurb", chapter.blurb, (v) => patchChapter(i, { blurb: v }), true)}
            <label className="field">
              <span>Camera altitude (0.05 close – 3 far)</span>
              <input
                type="number"
                step="0.05"
                min="0.05"
                max="3"
                value={chapter.altitude}
                onChange={(e) =>
                  patchChapter(i, { altitude: Number(e.target.value) || 0 })
                }
              />
            </label>
          </div>

          <h3>Pins (tour order)</h3>
          {chapter.pins.map((pin, p) => (
            <div className="row" key={p}>
              <input
                type="text"
                value={pin.city}
                aria-label="City"
                placeholder="City"
                onChange={(e) => patchPin(i, p, { city: e.target.value })}
              />
              <input
                type="text"
                value={pin.country}
                aria-label="Country"
                placeholder="Country"
                onChange={(e) => patchPin(i, p, { country: e.target.value })}
              />
              <input
                type="number"
                step="0.0001"
                value={pin.lat}
                aria-label="Latitude"
                onChange={(e) => patchPin(i, p, { lat: Number(e.target.value) || 0 })}
              />
              <input
                type="number"
                step="0.0001"
                value={pin.lng}
                aria-label="Longitude"
                onChange={(e) => patchPin(i, p, { lng: Number(e.target.value) || 0 })}
              />
              <button
                type="button"
                className="ghost"
                onClick={() => setOpenMap(openMap === `${i}:${p}` ? null : `${i}:${p}`)}
              >
                {openMap === `${i}:${p}` ? "close map" : "map"}
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() =>
                  patchChapter(i, { pins: chapter.pins.filter((_, j) => j !== p) })
                }
              >
                remove
              </button>
              {openMap === `${i}:${p}` && (
                <MapPicker
                  lat={pin.lat}
                  lng={pin.lng}
                  onPick={(lat, lng) => patchPin(i, p, { lat, lng })}
                />
              )}
              {[0, 1].map((slot) => (
                <div className="row photo-row" key={`photo-${slot}`}>
                  <span className="slot-label">photo {slot + 1}</span>
                  <input
                    type="text"
                    value={pin.photos?.[slot]?.src ?? ""}
                    placeholder="/photos/example.jpg or https://…"
                    aria-label={`Pin ${p + 1} photo ${slot + 1} URL`}
                    onChange={(e) => setPhoto(i, p, slot, { src: e.target.value })}
                  />
                  <input
                    type="text"
                    value={pin.photos?.[slot]?.caption ?? ""}
                    placeholder="Caption (optional)"
                    aria-label={`Pin ${p + 1} photo ${slot + 1} caption`}
                    onChange={(e) => setPhoto(i, p, slot, { caption: e.target.value })}
                  />
                </div>
              ))}
            </div>
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() =>
              patchChapter(i, {
                pins: [...chapter.pins, { city: "", country: "", lat: 0, lng: 0 }],
              })
            }
          >
            + add pin
          </button>

          <h3>Arcs (pin index pairs, tour routes)</h3>
          {(chapter.arcs ?? []).map(([from, to], a) => (
            <div className="row" key={a}>
              <input
                type="number"
                min="0"
                value={from}
                aria-label="Arc from pin"
                onChange={(e) =>
                  patchChapter(i, {
                    arcs: (chapter.arcs ?? []).map((arc, j) =>
                      j === a ? [Number(e.target.value) || 0, arc[1]] : arc,
                    ),
                  })
                }
              />
              <input
                type="number"
                min="0"
                value={to}
                aria-label="Arc to pin"
                onChange={(e) =>
                  patchChapter(i, {
                    arcs: (chapter.arcs ?? []).map((arc, j) =>
                      j === a ? [arc[0], Number(e.target.value) || 0] : arc,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="ghost danger"
                onClick={() =>
                  patchChapter(i, {
                    arcs: (chapter.arcs ?? []).filter((_, j) => j !== a),
                  })
                }
              >
                remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() =>
              patchChapter(i, {
                arcs: [...(chapter.arcs ?? []), [0, Math.min(1, chapter.pins.length - 1)]],
              })
            }
          >
            + add arc
          </button>
        </section>
      ))}

      <button
        type="button"
        className="ghost"
        onClick={() =>
          setChapters((prev) => [
            ...prev,
            {
              id: `chapter-${prev.length + 1}`,
              title: "",
              org: "",
              role: "",
              dates: "",
              blurb: "",
              pins: [{ city: "", country: "", lat: 0, lng: 0 }],
              altitude: 0.65,
            },
          ])
        }
      >
        + add chapter
      </button>

      <section className="panel export">
        <h2>Export</h2>
        {errors.length > 0 ? (
          <ul className="errors">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : (
          <p className="editor-note">
            Valid. Download the file and replace <code>src/data/chapters.ts</code>,
            then commit and deploy.
          </p>
        )}
        <div className="row">
          <button type="button" disabled={errors.length > 0} onClick={download}>
            Download chapters.ts
          </button>
          <button type="button" disabled={errors.length > 0} onClick={copy}>
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
        </div>
      </section>
    </div>
  );
}
