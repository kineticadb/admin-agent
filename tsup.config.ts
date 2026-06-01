import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "admin-agent": "src/cli/index.ts" },
  format: ["cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  bundle: true,
  outExtension: () => ({ js: ".js" }),
  banner: {
    js: "#!/usr/bin/env node",
  },
});
