import { assertEquals } from "@std/assert";
import { calculateFeedChanges } from "./importer.ts";

Deno.test("RSS refresh rozliší nové, obnovené a chybějící epizody", () => {
  assertEquals(
    calculateFeedChanges(
      [
        { externalId: "stays", isPresentInFeed: true },
        { externalId: "returns", isPresentInFeed: false },
        { externalId: "missing", isPresentInFeed: true },
      ],
      ["stays", "returns", "new"],
    ),
    {
      newEpisodes: 1,
      updatedEpisodes: 2,
      restoredEpisodes: 1,
      missingEpisodes: 1,
    },
  );
});
