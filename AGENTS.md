# Pokyny pro další práci

- Deno/TypeScript je aplikační, databázová i orchestrační vrstva. Python patří pouze do
  `services/audio-ml` a pouze pro ML.
- Sdílené doménové moduly jsou v `packages`, web v `apps/web`, worker v `apps/worker`, SQL migrace v
  `migrations`.
- Používej strict TypeScript bez nezdůvodněného `any`; externí hranice validuj přes Zod/Pydantic.
- SQL musí být parametrizované a vícekrokové zápisy transakční.
- Job handlery musí být idempotentní. Nikdy neskládej shellový příkaz interpolací; `Deno.Command`
  dostává pole argumentů.
- Produkční ML cesta nesmí používat mock. Mockované ML výstupy patří pouze do testů.
- Testy jsou vedle Deno modulů jako `*_test.ts` a v `services/audio-ml/tests`.
- Příkazy: `deno task check`, `deno task test:integration`, `deno task db:migrate`,
  `docker compose config`.
- Definition of Done: formát, lint, typecheck a relevantní testy projdou; migrace je dopředná;
  dokumentace a `docs/status.md` odpovídají realitě.
- Architektura a provozní detaily jsou v `docs/`.
