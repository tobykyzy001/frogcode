import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/sandbox/sandbox-worker.ts"],
  format: ["esm", "cjs"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" }
  },
  sourcemap: true,
  clean: true,
  dts: true,
})
