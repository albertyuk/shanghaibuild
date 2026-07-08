import { chapters, site } from "../data/chapters";

/**
 * The earthbound view: after "down to earth" lands, the site collapses
 * to a single quiet page — a plain one-page résumé assembled from the
 * same chapters that drive the globe, and almost nothing else. The
 * floating toggle (rendered by App) is the way back to orbit.
 */
export function Resume() {
  return (
    <article className="resume">
      <header className="resume-head">
        <p className="resume-kicker">{site.kicker}</p>
        <h1>{site.name}</h1>
        <p className="resume-identity">{site.identity}</p>
        <ul className="resume-contact">
          {site.contact.map((item) => (
            <li key={item.href}>
              <a href={item.href}>{item.label}</a>
            </li>
          ))}
        </ul>
      </header>
      <p className="resume-about">{site.about}</p>
      <h2 className="resume-heading">{site.resumeHeading}</h2>
      <ul className="resume-entries">
        {chapters.map((chapter) => (
          <li className="resume-entry" key={chapter.id}>
            <div className="resume-entry-head">
              <h3>{chapter.title}</h3>
              {chapter.dates && <span className="resume-dates">{chapter.dates}</span>}
            </div>
            <p className="resume-role">
              {[chapter.role, chapter.org].filter(Boolean).join(" · ")}
              {" — "}
              {chapter.pins.map((pin) => pin.city).join(" · ")}
            </p>
            <p className="resume-blurb">{chapter.blurb}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}
