import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    // React Compiler memoizes components automatically, so we don't write
    // useMemo, useCallback or memo by hand. Strict: the build fails if a
    // component can't be compiled, instead of skipping it silently.
    babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.RATCHET_API ?? "http://127.0.0.1:4000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
