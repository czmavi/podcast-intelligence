import { assertEquals } from "@std/assert";
import { isMigrationFile } from "./migrations.ts";

Deno.test("isMigrationFile accepts SQL migrations and rejects macOS metadata", () => {
  assertEquals(isMigrationFile("010_job_episode_history_index.sql"), true);
  assertEquals(isMigrationFile("._010_job_episode_history_index.sql"), false);
  assertEquals(isMigrationFile("README.md"), false);
});
