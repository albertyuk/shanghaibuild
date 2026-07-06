import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { chapters as sourceChapters, site as sourceSite } from "../data/chapters";
import { formatCoordinate } from "../lib/coords";
import type { EditableChapter, SiteContent } from "./types";
import { generateChaptersTs } from "./generate";
import { MapPicker } from "./MapPicker";
import { assertWriteAccess, bytesToBase64, publishFile, textToBase64 } from "./publish";

/**
 * The private content editor (/edit.html — unlinked, noindexed). The site
 * is static with no backend, so this page edits a draft in memory and
 * exports a ready-to-commit src/data/chapters.ts. Nothing persists until
 * that file is committed and deployed.
 */

const deepCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** PBKDF2 digest of the editor password — the plaintext never ships,
 *  and 600k iterations make offline cracking of the (public) hash cost
 *  hours-per-guess-batch instead of being free. Still a curtain, not a
 *  vault: the editor holds no secrets and can write nothing without a
 *  GitHub token — real locking belongs at the hosting layer. */
const PASS_HASH = "0f929d34b9b85f6fc0838ed9ebe56a985e1c7951df7339e79ba963835a60ce1e";
const PASS_SALT = "atlas-editor-gate-v1";
const PASS_ITERATIONS = 600_000;

async function gateHash(text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(text), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(PASS_SALT), iterations: PASS_ITERATIONS },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Dropped photo files, keyed by their sanitized target filename, so the
 *  export step can hand them back for saving into public/photos. */
export interface DroppedFile {
  file: File;
  url: string;
}

const sanitizeFilename = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".") // no dot runs — the name joins a repo path
    .replace(/^[.-]+|[-.]+$/g, "")
    .slice(0, 100);

/** Web/mail schemes only — anything else in an href would be a script
 *  vector on the live site. */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Photos are shown in a ~230px panel; anything bigger than this edge
 *  is wasted bytes for every visitor. Dropped images get downscaled and
 *  re-encoded before they ever enter the publish queue. */
const PHOTO_MAX_EDGE = 1200;
const PHOTO_PASSTHROUGH_BYTES = 300_000;

async function downscalePhoto(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= PHOTO_PASSTHROUGH_BYTES) {
      bitmap.close();
      return file; // already small — keep the original bytes
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.82),
    );
    // Only take the re-encode when it actually wins.
    if (!blob || blob.size >= file.size) return file;
    const stem = file.name.replace(/\.[^.]*$/, "") || "photo";
    return new File([blob], `${stem}.webp`, { type: "image/webp" });
  } catch {
    return file; // odd format the browser can't decode — pass through
  }
}

function validate(chapters: EditableChapter[], site: SiteContent): string[] {
  const errors: string[] = [];
  if (!site.name.trim()) errors.push("Site: name is empty.");
  site.contact.forEach((item, i) => {
    if (item.href.trim() && !SAFE_LINK.test(item.href.trim())) {
      errors.push(`Contact ${i + 1}: link must start with https:// (or mailto:).`);
    }
  });
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
    if (chapter.altitude < 0.01 || chapter.altitude > 3) {
      errors.push(`${label}: altitude should be between 0.01 and 3.`);
    }
    if (chapter.link && !/^https?:\/\//i.test(chapter.link)) {
      errors.push(`${label}: link must start with https://.`);
    }
    chapter.pins.forEach((pin, p) => {
      (pin.photos ?? []).forEach((photo, k) => {
        if ((photo.caption ?? "").trim() && !photo.src.trim()) {
          errors.push(
            `${label}, pin ${p + 1}: photo ${k + 1} has a caption but no image URL.`,
          );
        }
      });
      if (pin.panel) {
        const { x, y } = pin.panel;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
          errors.push(`${label}, pin ${p + 1}: panel position must be within 0–100%.`);
        }
      }
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
  const [unlocked, setUnlocked] = useState(false);
  const [attempt, setAttempt] = useState("");
  const [wrongPass, setWrongPass] = useState(false);
  const [dropped, setDropped] = useState<Record<string, DroppedFile>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Photo srcs whose image actually failed to load on the placement
  // page — the honest signal that a file isn't on the site yet.
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  // Publish target + token. The token lives in this state only — never
  // stored, gone when the tab closes.
  const [ghToken, setGhToken] = useState("");
  const [ghOwner, setGhOwner] = useState("albertyuk");
  const [ghRepo, setGhRepo] = useState("shanghaibuild");
  const [ghBranch, setGhBranch] = useState("claude/albert-yuk-portfolio-3zs6lb");
  const [publishing, setPublishing] = useState(false);
  const [publishLog, setPublishLog] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);

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

  // Placement-stage drag: the panel captures the pointer; each move
  // writes its top-left corner into the draft as % of the stage — the
  // same percentages the live site reads as % of the screen. The stage
  // rect is cached at grab time (it never moves mid-drag).
  const dragRef = useRef<{
    chapterIndex: number;
    pinIndex: number;
    dx: number;
    dy: number;
    stage: DOMRect;
  } | null>(null);

  const startPanelDrag = (
    e: ReactPointerEvent<HTMLElement>,
    chapterIndex: number,
    pinIndex: number,
  ) => {
    const stage = e.currentTarget.closest(".pos-stage");
    if (!stage) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      chapterIndex,
      pinIndex,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      stage: stage.getBoundingClientRect(),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const movePanelDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const panel = e.currentTarget.getBoundingClientRect();
    const maxX = Math.max(0, 100 - (panel.width / drag.stage.width) * 100);
    const maxY = Math.max(0, 100 - (panel.height / drag.stage.height) * 100);
    const x = ((e.clientX - drag.dx - drag.stage.left) / drag.stage.width) * 100;
    const y = ((e.clientY - drag.dy - drag.stage.top) / drag.stage.height) * 100;
    patchPin(drag.chapterIndex, drag.pinIndex, {
      panel: {
        x: Math.round(Math.min(Math.max(x, 0), maxX) * 10) / 10,
        y: Math.round(Math.min(Math.max(y, 0), maxY) * 10) / 10,
      },
    });
  };

  const endPanelDrag = () => {
    dragRef.current = null;
  };

  /** Typed coordinate for one axis; the other axis defaults to center
   *  when the panel was previously unplaced. */
  const setPanelAxis = (
    chapterIndex: number,
    pinIndex: number,
    axis: "x" | "y",
    raw: string,
  ) => {
    if (raw.trim() === "") return;
    const value = Math.min(100, Math.max(0, Number(raw) || 0));
    setChapters((prev) =>
      prev.map((c, i) =>
        i === chapterIndex
          ? {
              ...c,
              pins: c.pins.map((pin, j) =>
                j === pinIndex
                  ? { ...pin, panel: { x: 50, y: 50, ...pin.panel, [axis]: value } }
                  : pin,
              ),
            }
          : c,
      ),
    );
  };

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

  const acceptDrop = (
    chapterIndex: number,
    pinIndex: number,
    slot: number,
    file: File | undefined,
  ) => {
    if (!file || !file.type.startsWith("image/")) return;
    // Downscale before anything else sees the file: the publish queue,
    // the preview, and the export all carry the shrunken version.
    void downscalePhoto(file).then((processed) => {
      const name = sanitizeFilename(processed.name) || "photo.jpg";
      setDropped((prev) => {
        if (prev[name]) URL.revokeObjectURL(prev[name].url);
        return { ...prev, [name]: { file: processed, url: URL.createObjectURL(processed) } };
      });
      setPhoto(chapterIndex, pinIndex, slot, { src: `/photos/${name}` });
    });
  };

  const downloadDropped = (name: string) => {
    const a = document.createElement("a");
    a.href = dropped[name].url;
    a.download = name;
    a.click();
  };

  /** Preview source for a slot: the dropped file when we hold it, else
   *  whatever the src points at. */
  const previewFor = (src: string | undefined) => {
    if (!src) return null;
    const name = src.replace(/^\/photos\//, "");
    return dropped[name]?.url ?? src;
  };

  const publish = async () => {
    const target = { owner: ghOwner, repo: ghRepo, branch: ghBranch, token: ghToken };
    const log = (line: string) => setPublishLog((prev) => [...prev, line]);
    setPublishing(true);
    setPublishLog([]);
    try {
      log("Checking token access …");
      await assertWriteAccess(target);
      for (const [name, item] of Object.entries(dropped)) {
        log(`Uploading /photos/${name} …`);
        const base64 = bytesToBase64(await item.file.arrayBuffer());
        await publishFile(
          target,
          `public/photos/${name}`,
          base64,
          `Add photo ${name} (editor publish)`,
        );
      }
      log("Writing src/data/chapters.ts …");
      await publishFile(
        target,
        "src/data/chapters.ts",
        textToBase64(output),
        "Update content (editor publish)",
      );
      log("Published. The site goes live when the host finishes redeploying (~1–2 min).");
    } catch (error) {
      log(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPublishing(false);
    }
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

  if (!unlocked) {
    return (
      <div className="editor gate">
        <form
          className="panel gate-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void gateHash(attempt).then((hex) => {
              if (hex === PASS_HASH) setUnlocked(true);
              else setWrongPass(true);
            });
          }}
        >
          <h2>Content editor</h2>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={attempt}
              autoFocus
              onChange={(e) => {
                setAttempt(e.target.value);
                setWrongPass(false);
              }}
            />
          </label>
          {wrongPass && <p className="gate-error">Wrong password.</p>}
          <button type="submit">Unlock</button>
        </form>
      </div>
    );
  }

  if (previewing) {
    const withAnyPhotos = chapters
      .map((chapter, chapterIndex) => ({
        chapter,
        chapterIndex,
        num: String(chapterIndex + 1).padStart(2, "0"),
        pins: chapter.pins
          .map((pin, pinIndex) => ({ pin, pinIndex }))
          .filter(({ pin }) => (pin.photos ?? []).some((photo) => photo.src.trim())),
      }))
      .filter((entry) => entry.pins.length > 0);
    return (
      <div className="editor preview-page">
        <header className="editor-head">
          <h1>Photo placement</h1>
          <p className="editor-note">
            Each frame is the desktop screen while that chapter is active; the
            dashed line is the map pane's edge. Drag a panel to set exactly
            where it appears on screen — stored as % of the screen from the
            top-left — or type the numbers. Panels without a position use the
            default bottom-right stack. Nothing here is deployed yet.
          </p>
          <button type="button" onClick={() => setPreviewing(false)}>
            Back to editor
          </button>
        </header>
        {withAnyPhotos.length === 0 && (
          <p className="editor-note">No photo slots filled yet.</p>
        )}
        {withAnyPhotos.map(({ chapter, chapterIndex, num, pins }) => {
          const unpositioned = pins
            .filter(({ pin }) => !pin.panel)
            .map(({ pinIndex }) => pinIndex);
          return (
            <section className="preview-chapter" key={chapter.id}>
              <h2>
                {num} · {chapter.title || "(untitled)"}
              </h2>
              <div className="pos-stage">
                <div className="pos-stage-map" aria-hidden="true" />
                {pins.map(({ pin, pinIndex }) => {
                  const photos = (pin.photos ?? [])
                    .filter((photo) => photo.src.trim())
                    .slice(0, 2);
                  const captions = photos.map((photo) => photo.caption).filter(Boolean);
                  const pendingUpload = photos.some((photo) => broken[photo.src]);
                  // Unplaced panels sit in a sketch of the live default
                  // stack (bottom-right, story order top to bottom). All
                  // panels stay direct children of the stage, so a drag
                  // never reparents the node it is capturing.
                  const stackSlot = unpositioned.indexOf(pinIndex);
                  return (
                    <figure
                      className="photo-callout"
                      key={pinIndex}
                      style={
                        pin.panel
                          ? { left: `${pin.panel.x}%`, top: `${pin.panel.y}%` }
                          : {
                              right: "2%",
                              bottom: `${5 + (unpositioned.length - 1 - stackSlot) * 38}%`,
                            }
                      }
                      onPointerDown={(e) => startPanelDrag(e, chapterIndex, pinIndex)}
                      onPointerMove={movePanelDrag}
                      onPointerUp={endPanelDrag}
                      onPointerCancel={endPanelDrag}
                    >
                      <figcaption className="photo-callout-title">{pin.city}</figcaption>
                      <div className="photo-callout-strip">
                        {photos.map((photo, j) => (
                          <img
                            key={j}
                            src={previewFor(photo.src) ?? photo.src}
                            alt={photo.caption ?? pin.city}
                            draggable={false}
                            onError={() =>
                              setBroken((prev) =>
                                prev[photo.src] ? prev : { ...prev, [photo.src]: true },
                              )
                            }
                            onLoad={() =>
                              setBroken((prev) =>
                                prev[photo.src] ? { ...prev, [photo.src]: false } : prev,
                              )
                            }
                          />
                        ))}
                      </div>
                      <p className="photo-callout-data">
                        {formatCoordinate(pin.lat, pin.lng)} · {pin.country.toUpperCase()}
                      </p>
                      {captions.length > 0 && (
                        <p className="photo-callout-caption">{captions.join(" · ")}</p>
                      )}
                      {pendingUpload && (
                        <p className="preview-pending">
                          image not loading — publish or commit the file
                        </p>
                      )}
                    </figure>
                  );
                })}
              </div>
              {pins.map(({ pin, pinIndex }) => (
                <div className="row" key={pinIndex}>
                  <span className="slot-label">{pin.city || `pin ${pinIndex + 1}`}</span>
                  <label className="pos-field">
                    x %
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      value={pin.panel ? pin.panel.x : ""}
                      placeholder="auto"
                      aria-label={`${pin.city || `Pin ${pinIndex + 1}`} panel x`}
                      onChange={(e) => setPanelAxis(chapterIndex, pinIndex, "x", e.target.value)}
                    />
                  </label>
                  <label className="pos-field">
                    y %
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      value={pin.panel ? pin.panel.y : ""}
                      placeholder="auto"
                      aria-label={`${pin.city || `Pin ${pinIndex + 1}`} panel y`}
                      onChange={(e) => setPanelAxis(chapterIndex, pinIndex, "y", e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    disabled={!pin.panel}
                    onClick={() => patchPin(chapterIndex, pinIndex, { panel: undefined })}
                  >
                    default stack
                  </button>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    );
  }

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
          {textField("Loading label", site.loadingLabel, (v) => setSite({ ...site, loadingLabel: v }))}
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
              <span>Camera altitude (0.01 street – 3 far)</span>
              <input
                type="number"
                step="0.001"
                min="0.01"
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
              {[0, 1].map((slot) => {
                const slotKey = `${i}:${p}:${slot}`;
                const preview = previewFor(pin.photos?.[slot]?.src);
                return (
                  <div
                    className={
                      dragOver === slotKey ? "row photo-row drop-active" : "row photo-row"
                    }
                    key={`photo-${slot}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(slotKey);
                    }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(null);
                      acceptDrop(i, p, slot, e.dataTransfer.files[0]);
                    }}
                  >
                    <span className="slot-label">photo {slot + 1}</span>
                    {preview && (
                      <img className="slot-thumb" src={preview} alt="" aria-hidden="true" />
                    )}
                    <input
                      type="text"
                      value={pin.photos?.[slot]?.src ?? ""}
                      placeholder="Drop an image here, or type /photos/… or https://…"
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
                );
              })}
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
          <button type="button" className="ghost" onClick={() => setPreviewing(true)}>
            Preview &amp; place photos
          </button>
          <button type="button" disabled={errors.length > 0} onClick={download}>
            Download chapters.ts
          </button>
          <button type="button" disabled={errors.length > 0} onClick={copy}>
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
        </div>
        {Object.keys(dropped).length > 0 && (
          <>
            <h3>Dropped photo files</h3>
            <p className="editor-note">
              Download each file and save it into <code>public/photos/</code> in
              the repo (same commit as chapters.ts) so the URLs resolve.
            </p>
            {Object.keys(dropped).map((name) => (
              <div className="row" key={name}>
                <img className="slot-thumb" src={dropped[name].url} alt="" aria-hidden="true" />
                <code className="drop-name">/photos/{name}</code>
                <button type="button" className="ghost" onClick={() => downloadDropped(name)}>
                  download
                </button>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="panel publish">
        <h2>Publish to GitHub</h2>
        <p className="editor-note">
          Commits the edited content — and any dropped photos — straight to the
          repo from this tab; the host redeploys automatically (~1–2 min). Needs
          a fine-grained personal access token with Contents read &amp; write on
          this repo. The token stays in this tab's memory only.
        </p>
        <div className="grid">
          <label className="field">
            <span>GitHub token</span>
            <input
              type="password"
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Owner</span>
            <input type="text" value={ghOwner} onChange={(e) => setGhOwner(e.target.value)} />
          </label>
          <label className="field">
            <span>Repo</span>
            <input type="text" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} />
          </label>
          <label className="field">
            <span>Branch</span>
            <input type="text" value={ghBranch} onChange={(e) => setGhBranch(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <button
            type="button"
            disabled={errors.length > 0 || !ghToken.trim() || publishing}
            onClick={() => void publish()}
          >
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
        {publishLog.length > 0 && (
          <ul className="publish-log">
            {publishLog.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
