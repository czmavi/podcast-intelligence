import { assertEquals } from "@std/assert";
import { selectSpeakerMatchSuggestions } from "./speaker-matching.ts";

Deno.test("hlasový matching vybere jistého moderátora a zachová důkazy", () => {
  const suggestions = selectSpeakerMatchSuggestions([
    {
      clusterId: "speaker-a",
      personId: "host-a",
      displayName: "Moderátor A",
      similarities: [0.91, 0.89, 0.9],
      expectedParticipant: false,
    },
    {
      clusterId: "speaker-a",
      personId: "host-b",
      displayName: "Moderátor B",
      similarities: [0.61],
      expectedParticipant: false,
    },
  ]);
  assertEquals(suggestions.length, 1);
  assertEquals(suggestions[0]?.personId, "host-a");
  assertEquals(suggestions[0]?.voiceSimilarity, 0.9);
  assertEquals(suggestions[0]?.referenceCount, 3);
});

Deno.test("hlasový matching odmítne nejasnou shodu a nepřiřadí osobu dvakrát", () => {
  const suggestions = selectSpeakerMatchSuggestions([
    {
      clusterId: "ambiguous",
      personId: "host-a",
      displayName: "Moderátor A",
      similarities: [0.86],
      expectedParticipant: false,
    },
    {
      clusterId: "ambiguous",
      personId: "host-b",
      displayName: "Moderátor B",
      similarities: [0.84],
      expectedParticipant: false,
    },
    {
      clusterId: "stronger",
      personId: "host-a",
      displayName: "Moderátor A",
      similarities: [0.94],
      expectedParticipant: false,
    },
    {
      clusterId: "weaker",
      personId: "host-a",
      displayName: "Moderátor A",
      similarities: [0.88],
      expectedParticipant: false,
    },
  ]);
  assertEquals(suggestions.map((suggestion) => suggestion.clusterId), ["stronger"]);
});
