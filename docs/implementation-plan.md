# Implementační plán

Repozitář byl při zahájení prázdný. Dostupné prostředí: Deno 2.9.3, Python 3.13.2, Docker 29.5.2,
Docker Compose 5.1.4 a ffmpeg/ffprobe 7.1. Lokální `psql` ani NVIDIA runtime nejsou dostupné;
PostgreSQL proto běží v Compose a ML služba musí mít CPU fallback.

## Etapa A — základ a data

- **Cíl:** strict Deno workspace, konfigurace, PostgreSQL/pgvector, migrace, Compose a provozní
  dokumentace.
- **Soubory:** `deno.json`, `.env.example`, `docker-compose.yml`, `migrations/*`,
  `packages/database/*`, `packages/domain/*`, `docs/*`.
- **Testovací kritéria:** formát, lint, typecheck, unit testy, validní Compose, migrace na prázdné
  databázi.
- **Rizika:** lokálně není `psql`; integrační testy vyžadují Docker daemon.

## Etapa B — podcast, audio a fronta

- **Cíl:** idempotentní RSS import, bezpečné storage cesty, perzistentní job queue, streamovaný
  download a ffmpeg normalizace.
- **Soubory:** `packages/podcast-rss/*`, `packages/shared/*`, `apps/worker/*`, API routes a
  repository vrstva.
- **Testovací kritéria:** RSS fixtures, stabilní ID, path traversal, retry, stavový automat,
  atomické claimnutí přes `SKIP LOCKED`, ověřený WAV.
- **Rizika:** nekonzistentní RSS feedy a vzdálené servery bez korektních hlaviček.

## Etapa C — ML a přepis

- **Cíl:** interní FastAPI s reálným Whisper přepisem přes Transformers/PyTorch, volitelnou pyannote
  diarizací, bezpečným shared root a validovaným Deno klientem.
- **Soubory:** `services/audio-ml/*`, `apps/worker/jobs/process_audio_ml.ts`, processing run
  repositories.
- **Testovací kritéria:** Python unit testy bez stažení modelů, validace ML kontraktu v Deno,
  transakční a idempotentní uložení výsledku.
- **Rizika:** velké modely, HF token pro pyannote, Python 3.13 kompatibilita PyTorch balíčků;
  kontejner používá podporovaný Python 3.11.

## Etapa D — identita, transcript a UI

- **Cíl:** administrační web, osoby/účastníci, přehrávání s Range, ruční přiřazení clusteru a
  ověřené hlasové reference.
- **Soubory:** `apps/web/*`, person/speaker repositories.
- **Testovací kritéria:** API validace, přepsání identity pouze explicitně, transakční propagace
  osoby do utterances, seeking audia.
- **Rizika:** lokální MVP nemá zapnuté přihlášení; mutace procházejí připravenou auth boundary.

## Etapa E — indexace a odpovědi

- **Cíl:** tematické chunky, fulltext, lokální/OpenAI embedding provider, hybridní retrieval a
  grounded odpovědi s bezpečným fallbackem.
- **Soubory:** chunking/search služby, `/api/search`, `/api/ask`.
- **Testovací kritéria:** chunking scénáře, filtr skutečné osoby přes vazební tabulku, modelově
  kompatibilní vektory, odpověď vždy se zdroji.
- **Rizika:** PostgreSQL nemá standardní českou text-search konfiguraci; MVP používá `simple`.
  Generování odpovědi vyžaduje externí provider.

## Etapa F — další rozvoj

- **Cíl:** automatická kalibrovaná identifikace, přímá oslovení, claims, audit, mazání citlivých dat
  a širší observabilita.
- **Soubory:** candidate scoring/eval, claims workflow a operations API.
- **Testovací kritéria:** eval na potvrzených párech, žádné automatické přiřazení bez dostatečné
  evidence, claims pouze se zdrojovými utterances.
- **Rizika:** biometrická data a práva ke zpracování vyžadují provozní a právní rozhodnutí mimo kód.
