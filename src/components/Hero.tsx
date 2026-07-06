import { site } from "../data/chapters";
import { Decode } from "./Decode";

export function Hero() {
  return (
    <header className="hero" data-observe="hero">
      {/* Types itself in when the boot veil lifts (.booted un-pauses
       * the sweep — see global.css). */}
      <p className="hero-kicker">
        <Decode text={site.kicker} step={38} />
      </p>
      <h1>{site.name}</h1>
      <p className="hero-identity">{site.identity}</p>
      <p className="scroll-cue">{site.scrollCue}</p>
    </header>
  );
}
