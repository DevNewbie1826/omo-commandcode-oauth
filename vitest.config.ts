import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    extensions: [".ts", "..."],
  },
  test: {
    include: ["test/**/*.ts"],
  },
});
