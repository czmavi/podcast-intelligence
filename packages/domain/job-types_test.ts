import { assertEquals } from "@std/assert";
import { downloadJobTypes, jobQueue, processingJobTypes } from "./job-types.ts";

Deno.test("joby jsou rozdělené do download a processing fronty", () => {
  assertEquals(downloadJobTypes, ["DOWNLOAD_AUDIO"]);
  assertEquals((processingJobTypes as readonly string[]).includes("DOWNLOAD_AUDIO"), false);
  assertEquals((processingJobTypes as readonly string[]).includes("IMPORT_FEED"), true);
  assertEquals(jobQueue("DOWNLOAD_AUDIO"), "download");
  assertEquals(jobQueue("IMPORT_FEED"), "processing");
  assertEquals(jobQueue("PROCESS_AUDIO_ML"), "processing");
});
