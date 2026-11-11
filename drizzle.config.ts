/**
 * # drizzle.config.ts - drizzle-kit settings for generating SQL migrations from lib/db/schema.ts
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "postgresql", schema: "./lib/db/schema.ts", out: "./drizzle" });
