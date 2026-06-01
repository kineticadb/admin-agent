import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Walk up from startDir to find the nearest package.json and return its version.
 *
 * Works in both dev mode (src/cli/ — 2 levels deep) and the CJS bundle (dist/ — 1 level deep)
 * by walking up the directory tree instead of assuming a fixed depth.
 */
export function getVersion(): string {
  try {
    let dir = __dirname;
    while (dir !== dirname(dir)) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          version: string;
        };
        return pkg.version;
      }
      dir = dirname(dir);
    }
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}
