/*
 * All portfolio content lives in this file — the six chapters, their pins,
 * and every line of page copy. Components render from here and hard-code
 * nothing. Lines marked TODO(ALBERT) are placeholders Albert edits himself.
 */

export interface Pin {
  city: string;
  country: string;
  lat: number;
  lng: number;
}

export interface Chapter {
  id: string;
  title: string;
  org: string;
  role: string;
  dates: string;
  blurb: string;
  pins: Pin[];
  /** Pairs of indexes into `pins`, drawn as animated arcs while the chapter is active. */
  arcs?: [number, number][];
  /** Globe camera altitude when this chapter is active. */
  altitude: number;
  link?: string;
}

export const chapters: Chapter[] = [
  {
    id: "shein",
    title: "Agentic Marketing Systems",
    org: "SHEIN",
    role: "Global Marketing Intern",
    dates: "Jun – Aug 2026",
    blurb:
      "Built agentic AI workflows in Dify and Apify that automate competitive brand research and influencer evaluation across SHEIN's portfolio of 10+ sub-brands, cutting multi-day manual research to minutes per brand. Shipped bilingual report generation with live web-search grounding and anti-fabrication guardrails, plus an end-to-end Instagram intelligence pipeline that turns captions and engagement metrics into structured spreadsheets.",
    pins: [{ city: "Shanghai", country: "China", lat: 31.2304, lng: 121.4737 }],
    altitude: 0.4,
  },
  {
    id: "chenman",
    title: "Fashion Photography",
    org: "Chen Man Studio",
    role: "Camera Assistant",
    dates: "May – Jun 2025",
    blurb:
      "Assisted photographer Chen Man on roughly 20 commercial fashion shoots — lighting setups, on-set production logistics, and shoot scheduling.",
    pins: [{ city: "Shanghai", country: "China", lat: 31.2304, lng: 121.4737 }],
    altitude: 0.35,
    link: "https://www.yukalbert.com/photograph",
  },
  {
    id: "film-production",
    title: "Film Production",
    org: "", // TODO(ALBERT): production/project names
    role: "Production Crew",
    dates: "", // TODO(ALBERT)
    blurb: "On-set production work across feature and commercial sets.",
    pins: [
      { city: "Beijing", country: "China", lat: 39.9042, lng: 116.4074 },
      { city: "Shenzhen", country: "China", lat: 22.5431, lng: 114.0579 },
    ],
    arcs: [[0, 1]],
    altitude: 0.5,
    link: "https://www.yukalbert.com/filmset",
  },
  {
    id: "old-road",
    title: "Old Road; New Chapter",
    org: "Photojournalism project with Liu Heung Shing, Pulitzer Prize–winning photojournalist",
    role: "Production Assistant",
    dates: "Jun 2024 – Jul 2025",
    blurb:
      "Production assistance across Central Asia and the Middle East, documenting cultural and geopolitical change — the journey behind the Central Asia, Israel, and Iran photo series.",
    // TODO(ALBERT): confirm cities
    pins: [
      { city: "Almaty", country: "Kazakhstan", lat: 43.238, lng: 76.8829 },
      { city: "Samarkand", country: "Uzbekistan", lat: 39.6542, lng: 66.9597 },
      { city: "Jerusalem", country: "Israel", lat: 31.7683, lng: 35.2137 },
      { city: "Tehran", country: "Iran", lat: 35.6892, lng: 51.389 },
    ],
    arcs: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    altitude: 0.55,
    link: "https://www.yukalbert.com/central-asia",
  },
  {
    id: "maga-doc",
    title: "MAGA Hat Production in China",
    org: "Independent documentary",
    role: "Director & Cinematographer",
    dates: "Jul 2024",
    blurb:
      "Solo-directed, shot, and edited a documentary following MAGA hats from the factories of Yiwu through the Port of Shanghai to a rally crowd in Pennsylvania. All-American High School Film Festival Spark Award — top 1% of 2,700+ submissions.",
    pins: [
      { city: "Yiwu", country: "China", lat: 29.3069, lng: 120.0753 },
      { city: "Port of Shanghai", country: "China", lat: 30.6289, lng: 122.0639 },
      { city: "Butler, PA", country: "United States", lat: 40.8612, lng: -79.8953 },
    ],
    arcs: [
      [0, 1],
      [1, 2],
    ],
    altitude: 0.55,
  },
  {
    id: "dacameraroll",
    title: "@dacameraroll",
    org: "Deerfield Academy",
    role: "President, Deerfield Academy Cameraroll",
    dates: "Sep 2022 – May 2026",
    blurb:
      "Led a team of 10+ photographers covering ~200 campus events, reaching 100,000+ monthly views. Photographed 100+ senior portrait sessions featured in the yearbook.",
    pins: [
      { city: "Deerfield, MA", country: "United States", lat: 42.5459, lng: -72.6037 },
    ],
    altitude: 0.4,
    link: "https://www.yukalbert.com/school",
  },
];

export const site = {
  name: "Albert Yuk",
  kicker: "Production log · 2022 – 2026",
  identity:
    "Filmmaker, photographer, and marketing technologist. Six chapters of work, plotted where they happened.",
  scrollCue: "Scroll — the globe follows",
  about:
    "Deerfield Academy, Class of 2026. The work below spans a commercial photo studio, feature and commercial film sets, a photojournalism journey with Liu Heung Shing, a festival-winning documentary, and agentic marketing systems at SHEIN — ordered as chapters, each pinned to the place it happened.",
  chaptersHeading: "Chapters",
  contactHeading: "Contact",
  contact: [
    { label: "yukalbert.com", href: "https://www.yukalbert.com" },
    { label: "yzy.albert@gmail.com", href: "mailto:yzy.albert@gmail.com" },
    { label: "Photographs", href: "https://www.yukalbert.com/photograph" },
    { label: "Film sets", href: "https://www.yukalbert.com/filmset" },
    { label: "Central Asia series", href: "https://www.yukalbert.com/central-asia" },
    { label: "@dacameraroll", href: "https://www.yukalbert.com/school" },
  ],
  earthDown: "Down to earth",
  earthUp: "Back to orbit",
  footerNote:
    "Single static page. The globe is drawn locally from vector coastlines; nothing on this site tracks you.",
  skipLinkLabel: "Skip to chapters",
};
