import { assertEquals } from "@std/assert";
import { htmlToPlainText } from "./text.ts";

Deno.test("HTML popis převede na bezpečný prostý text i po dekódování entit", () => {
  assertEquals(
    htmlToPlainText("&lt;html&gt;&lt;p&gt;Český &amp; čistý&lt;/p&gt;&lt;/html&gt;"),
    "Český & čistý",
  );
  assertEquals(htmlToPlainText("<style>bad</style><p>Popis&nbsp;dílu</p>"), "Popis dílu");
});
