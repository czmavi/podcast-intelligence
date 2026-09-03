import { assertEquals } from "@std/assert";
import { OpenAiCompatibleGuestIdentificationProvider } from "./guest-identification.ts";

function providerWithResult(result: Record<string, unknown>) {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenAiCompatibleGuestIdentificationProvider({
    baseUrl: "http://llm.test:8002/v1",
    model: "test-model",
    apiKey: "test-token",
    timeoutMs: 1000,
  }, (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({
      choices: [{ message: { content: JSON.stringify(result) } }],
    }));
  });
  return { provider, requestBody: () => requestBody };
}

Deno.test("model najde jednoznačného hosta přímo uvedeného v metadatech", async () => {
  const setup = providerWithResult({
    guestName: "Radim Ivan",
    confidence: "high",
    evidence: "pozval Radima Ivana",
  });
  assertEquals(
    await setup.provider.identifyGuest({
      title: "Rozhovor o ODS",
      description: "Michal Půr si pozval Radima Ivana.",
      knownModeratorNames: ["Michal Půr"],
    }),
    {
      displayName: "Radim Ivan",
      confidence: 0.9,
      evidence: "pozval Radima Ivana",
    },
  );
  assertEquals(setup.requestBody()?.model, "test-model");
  assertEquals(setup.requestBody()?.reasoning_effort, "none");
  assertEquals(setup.requestBody()?.response_format, { type: "json_object" });
  assertEquals(setup.requestBody()?.chat_template_kwargs, { enable_thinking: false });
  const messages = setup.requestBody()?.messages as Array<{ content?: unknown }>;
  assertEquals(
    String(messages[0]?.content).includes('["Michal Půr"]'),
    true,
  );
});

Deno.test("model nesmí přiřadit nejisté ani v metadatech nepřítomné jméno", async () => {
  const uncertain = providerWithResult({
    guestName: "Radim Ivan",
    confidence: "medium",
    evidence: null,
  });
  assertEquals(
    await uncertain.provider.identifyGuest({
      title: "Rozhovor s Radimem Ivanem",
      description: null,
      knownModeratorNames: ["Michal Půr"],
    }),
    null,
  );

  const hallucinated = providerWithResult({
    guestName: "Jana Nováková",
    confidence: "high",
    evidence: null,
  });
  assertEquals(
    await hallucinated.provider.identifyGuest({
      title: "Rozhovor bez uvedeného hosta",
      description: "Debata o české politice.",
      knownModeratorNames: ["Michal Půr"],
    }),
    null,
  );

  const moderator = providerWithResult({
    guestName: "Michal Půr",
    confidence: "high",
    evidence: "Michal Půr uvádí",
  });
  assertEquals(
    await moderator.provider.identifyGuest({
      title: "Michal Půr uvádí další rozhovor",
      description: "Nová epizoda podcastu Insider.",
      knownModeratorNames: ["Michal Půr"],
    }),
    null,
  );
});
