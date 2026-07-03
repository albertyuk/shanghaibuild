import { site } from "../data/chapters";

export function Hero() {
  return (
    <header className="hero" data-observe="hero">
      <p className="hero-kicker">{site.kicker}</p>
      <h1>{site.name}</h1>
      <p className="hero-identity">{site.identity}</p>
      <p className="scroll-cue">{site.scrollCue}</p>
    </header>
  );
}
