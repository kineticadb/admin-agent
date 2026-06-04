import pc from "picocolors";
import { getVersion } from "./version.js";

const LOGO = `\
  ██╗  ██╗██╗███╗   ██╗███████╗████████╗██╗ ██████╗ █████╗
  ██║ ██╔╝██║████╗  ██║██╔════╝╚══██╔══╝██║██╔════╝██╔══██╗
  █████╔╝ ██║██╔██╗ ██║█████╗     ██║   ██║██║     ███████║
  ██╔═██╗ ██║██║╚██╗██║██╔══╝     ██║   ██║██║     ██╔══██║
  ██║  ██╗██║██║ ╚████║███████╗   ██║   ██║╚██████╗██║  ██║
  ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚═╝  ╚═╝`;

export { LOGO };

type Rgb = readonly [number, number, number];

function lerpRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

function dimRgb(color: Rgb, factor: number): Rgb {
  return [
    Math.round(color[0] * factor),
    Math.round(color[1] * factor),
    Math.round(color[2] * factor),
  ];
}

const SHADOW_CHARS = new Set(["╗", "╔", "║", "╝", "╚", "═"]);
const DIM_FACTOR = 0.4;

function gradientize(text: string): string {
  const PURPLE: Rgb = [147, 51, 234];
  const HOT_PINK: Rgb = [236, 72, 153];
  const RESET = "\x1b[0m";

  const lines = text.split("\n");
  const maxIdx = Math.max(lines.length - 1, 1);

  return lines
    .map((line, i) => {
      const bright = lerpRgb(PURPLE, HOT_PINK, i / maxIdx);
      const dim = dimRgb(bright, DIM_FACTOR);

      let result = "";
      let currentMode: "bright" | "dim" | null = null;

      for (const ch of line) {
        const mode = SHADOW_CHARS.has(ch) ? "dim" : "bright";
        if (mode !== currentMode) {
          const [r, g, b] = mode === "dim" ? dim : bright;
          result += `\x1b[38;2;${r};${g};${b}m`;
          currentMode = mode;
        }
        result += ch;
      }

      return result + RESET;
    })
    .join("\n");
}

/**
 * Prints the startup banner (gradient logo + version subtitle) to stderr.
 *
 * @param model - Optional agent model shorthand (e.g., "sonnet"). When provided,
 *   a dim `Model: <name>` line is appended directly beneath the subtitle so the
 *   operator sees which Claude model is powering the session before any
 *   investigation begins.
 */
export function printBanner(model?: string): string {
  const version = getVersion();
  const subtitle = `admin-agent ${pc.dim(`v${version}`)}`;
  const header = model ? `${subtitle}\n${pc.dim(`Model: ${model}`)}` : subtitle;

  process.stderr.write("\n\n" + gradientize(LOGO) + "\n\n" + header + "\n");

  return subtitle;
}
