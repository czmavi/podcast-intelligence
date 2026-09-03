import { assertEquals, assertRejects } from "@std/assert";
import { PushoverClient } from "./pushover.ts";

Deno.test("Pushover klient posílá formulář bez úniku tokenů", async () => {
  let submitted = "";
  const client = new PushoverClient(
    { PUSHOVER_APP_TOKEN: "a".repeat(30), PUSHOVER_USER_KEY: "u".repeat(30) },
    ((_input: string | URL | Request, init?: RequestInit) => {
      submitted = String(init?.body);
      return Promise.resolve(Response.json({ status: 1, request: "request-id" }));
    }) as typeof fetch,
  );
  assertEquals(await client.send("Test", "Funguje"), { requestId: "request-id" });
  assertEquals(submitted.includes("title=Test"), true);
  assertEquals(submitted.includes(`token=${"a".repeat(30)}`), true);
});

Deno.test("Pushover klient jasně odmítne chybějící konfiguraci", async () => {
  const client = new PushoverClient({});
  await assertRejects(() => client.send("Test", "Funguje"), Error, "není nakonfigurovaný");
});
