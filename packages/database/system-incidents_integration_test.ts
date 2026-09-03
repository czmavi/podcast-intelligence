import { assertEquals } from "@std/assert";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { SystemIncidentRepository } from "./repositories/system-incidents.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: incident slučuje výskyty, omezuje notifikace a po potvrzení založí nový",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const repository = new SystemIncidentRepository(sql);
    const fingerprint = `integration:${crypto.randomUUID()}`;
    try {
      const first = await repository.record({
        kind: "test",
        fingerprint,
        severity: "critical",
        title: "Test",
        message: "První výskyt",
        details: {},
      });
      const reservation = await repository.reserveNotification(first.id, 10_800_000);
      assertEquals(reservation?.incident.id, first.id);
      assertEquals(await repository.reserveNotification(first.id, 10_800_000), null);

      const repeated = await repository.record({
        kind: "test",
        fingerprint,
        severity: "critical",
        title: "Test",
        message: "Druhý výskyt",
        details: {},
      });
      assertEquals(repeated.id, first.id);
      assertEquals(repeated.occurrenceCount, 2);
      await repository.accept(first.id, "integration-test");

      const reopened = await repository.record({
        kind: "test",
        fingerprint,
        severity: "critical",
        title: "Test",
        message: "Nový incident",
        details: {},
      });
      assertEquals(reopened.id === first.id, false);
      assertEquals(reopened.occurrenceCount, 1);
    } finally {
      await sql`DELETE FROM system_incidents WHERE fingerprint = ${fingerprint}`;
      await sql.end();
    }
  },
});
