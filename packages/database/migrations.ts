import { dirname, fromFileUrl, join } from "@std/path";
import { createDatabase } from "./client.ts";
import { loadConfig } from "../shared/config.ts";

const root = join(dirname(fromFileUrl(import.meta.url)), "../../migrations");

export function isMigrationFile(name: string): boolean {
  return name.endsWith(".sql") && !name.startsWith("._");
}

async function migrate(sql: ReturnType<typeof createDatabase>): Promise<void> {
  const [migrationTable] = await sql.unsafe<[{ tableName: string | null }]>(
    "SELECT to_regclass('public.schema_migrations')::text AS table_name",
  );
  if (migrationTable.tableName === null) {
    await sql.unsafe(
      "CREATE TABLE schema_migrations (" +
        "version TEXT PRIMARY KEY, " +
        "applied_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
        ")",
    );
  }
  const files = [...Deno.readDirSync(root)]
    .filter((entry) => entry.isFile && isMigrationFile(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    const applied = await sql.unsafe(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [file],
    );
    if (applied.length > 0) continue;
    const source = await Deno.readTextFile(join(root, file));
    await sql.begin(async (tx) => {
      await tx.unsafe(source);
      await tx.unsafe("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    });
    console.log(`Applied migration ${file}`);
  }
}

async function reset(sql: ReturnType<typeof createDatabase>): Promise<void> {
  if (loadConfig().APP_ENV === "production") {
    throw new Error("Reset databáze není povolen v production.");
  }
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql);
}

if (import.meta.main) {
  const sql = createDatabase(loadConfig());
  try {
    if (Deno.args[0] === "reset") await reset(sql);
    else await migrate(sql);
  } finally {
    await sql.end();
  }
}
