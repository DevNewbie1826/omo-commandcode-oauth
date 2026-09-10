import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
<<<<<<< HEAD
    include: ["test/**/*.test.ts", "test/test-*.ts", "test/**/*.ts"],
=======
    include: ["test/**/*.ts"],
>>>>>>> feat/accounts
  },
  resolve: {
    extensions: [".ts", "..."],
  },
});
