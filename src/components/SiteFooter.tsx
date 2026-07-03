import { site } from "../data/chapters";

export function SiteFooter() {
  return (
    <footer className="footer" data-fade>
      <p className="footer-kicker">{site.contactHeading}</p>
      <ul className="footer-links">
        {site.contact.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
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
