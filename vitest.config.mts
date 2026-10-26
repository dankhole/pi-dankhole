import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/workers/**/*.test.ts", "tests/package/**/*.test.ts"],
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    coverage: { provider: "istanbul", reporter: ["text", "html"], include: ["src/workers/**/*.ts"] },
  },
  // Worker faux-provider tests and real sessions must share one API registry.
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
