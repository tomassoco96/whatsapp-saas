import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // pool "forks": los workers en threads rompen con módulos nativos en Windows
    // (gotcha G1 del kit motor-agente)
    pool: "forks",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
