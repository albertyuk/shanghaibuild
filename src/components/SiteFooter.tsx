import { site } from "../data/chapters";
import { Decode } from "./Decode";

/** Contact links are authored content; only web and mail schemes may
 *  reach an href (a javascript: URL here would execute in visitors'
 *  browsers). The editor validates this too — this is the backstop. */
const safeHref = (href: string) =>
  /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;

export function SiteFooter() {
  return (
    <footer className="footer" data-fade>
      <p className="footer-kicker">
        <Decode text={site.contactHeading} />
      </p>
      <ul className="footer-links">
        {site.contact.map((item) => (
          <li key={item.href}>
            <a
              href={safeHref(item.href)}
              {...(item.href.startsWith("http")
                ? { target: "_blank", rel: "noreferrer" }
                : {})}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="footer-note">{site.footerNote}</p>
    </footer>
  );
}
