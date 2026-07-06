import type { Chapter } from "../data/chapters";
import { site } from "../data/chapters";

/** A chapter as edited: pins may be transiently empty mid-edit — the
 *  tuple constraint is enforced by validation before export. */
export type EditableChapter = Omit<Chapter, "pins"> & {
  pins: Chapter["pins"][number][];
};

export type SiteContent = typeof site;
