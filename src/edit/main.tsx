import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../styles/tokens.css";
import "./editor.css";
import { EditorApp } from "./EditorApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>,
);
