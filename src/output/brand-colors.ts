/**
 * Brand colors — the Kinetica logo gradient endpoints, shared by the startup banner
 * and the terminal markdown renderer so text highlights stay in the brand family
 * instead of a generic cyan/blue.
 *
 * Two tiers:
 *   - BRAND_* : the vivid logo gradient (purple → hot pink). Used as-is for the
 *     banner, where a saturated 6-line logo should pop.
 *   - purple()/pink() : SOFTENED variants for reading text (headings, code, bullets,
 *     prompt answers). The neon brand colors are fatiguing across body-adjacent text
 *     on a dark terminal, so these are desaturated and lightened toward a soft gray —
 *     same hue family, easier on the eyes, better contrast on dark backgrounds.
 *
 * Emitted as 24-bit truecolor (the banner already assumes a truecolor terminal). The
 * wrapper helpers gate on picocolors' color detection, so highlighted text degrades
 * to plain in pipes, CI, NO_COLOR, and redirected files. Pure; never throws.
 */
import pc from "picocolors";

export type Rgb = readonly [number, number, number];

/** Logo gradient endpoints: purple (top of the logo) → hot pink (bottom). Vivid. */
export const BRAND_PURPLE: Rgb = [147, 51, 234]; // #9333EA
export const BRAND_PINK: Rgb = [236, 72, 153]; // #EC4899

// Soften brand colors for reading: blend toward a light gray, which both desaturates
// (pulls off the neon) and lightens (lifts contrast on a dark background). Each color
// gets its own amount — the saturated violet reads harsher on dark than the rose, so
// purple is muted a notch more than pink. Raise an amount for a dustier tone.
const SOFTEN_TARGET: Rgb = [210, 210, 210];
const SOFTEN_PURPLE = 0.55;
const SOFTEN_PINK = 0.45;

function soften([r, g, b]: Rgb, amount: number): Rgb {
  const [tr, tg, tb] = SOFTEN_TARGET;
  return [
    Math.round(r + (tr - r) * amount),
    Math.round(g + (tg - g) * amount),
    Math.round(b + (tb - b) * amount),
  ];
}

/** Muted reading variants (derived from the brand colors) — used for text, not the logo. */
export const TEXT_PURPLE: Rgb = soften(BRAND_PURPLE, SOFTEN_PURPLE); // ~#B68ADD soft lavender
export const TEXT_PINK: Rgb = soften(BRAND_PINK, SOFTEN_PINK); // ~#E086B3 muted rose

/** Build a truecolor wrapper that no-ops when color is unsupported. */
function truecolor([r, g, b]: Rgb): (s: string) => string {
  // \x1b[39m resets only the foreground, so this nests cleanly inside pc.bold/dim.
  return (s: string) => (pc.isColorSupported ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s);
}

/** Wrap text in the softened brand purple — secondary accent (sub-headings, code, bullets). */
export const purple = truecolor(TEXT_PURPLE);

/** Wrap text in the softened brand pink — primary accent (section headings, prompt answers). */
export const pink = truecolor(TEXT_PINK);
