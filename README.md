# Podcast Intelligence

Produkčně rozumný MVP základ pro import podcastového RSS, bezpečné stažení a normalizaci audia,
časovaný přepis, diarizaci, ruční identifikaci hlasů a fulltextové/vektorové hledání. Aplikační,
databázová a orchestrační vrstva je v Deno/TypeScriptu; Python slouží výhradně pro audio a embedding
ML.

## Architektura

- `apps/web`: Deno HTTP server, administrační UI, validované JSON API a Range audio streaming.
- `apps/worker`: oddělený worker nad PostgreSQL frontou; download, ffmpeg, ML, chunking a
  embeddingy.
- `packages`: doména, RSS, storage, databáze a retrieval.
- `services/audio-ml`: FastAPI, Whisper přes Transformers/PyTorch, pyannote a sentence-transformers.
- PostgreSQL 17 + pgvector je jediná databáze i fronta. V produkci běží PostgreSQL, web a worker na
  Synology a audio je do kontejnerů připojené přímo z `/volume1/Podcasts`.

Podrobnosti a diagram jsou v [architektuře](docs/architecture.md).

## Předpoklady

- Deno 2.9+,
- Docker + Docker Compose,
- ffmpeg/ffprobe 7+ pro spuštění workeru mimo Docker,
- alespoň 8 GB RAM pro malé Whisper modely; `large-v3` potřebuje výrazně více,
- HF token s přijatými podmínkami pyannote modelů pro diarizaci,
- NVIDIA Container Toolkit pouze pro GPU režim.

Worker Docker image instaluje vlastní `ffmpeg` a `ffprobe`; systémové binárky jsou potřeba pouze při
spuštění workeru přímo přes Deno mimo Docker.

Lokální `psql` není nutný. Vývojové prostředí zjištěné při vytvoření projektu má Deno 2.9.3, Python
3.13.2, Compose 5.1.4 a ffmpeg 7.1, ale nemá `psql` ani NVIDIA runtime. ML kontejner proto používá
podporovaný Python 3.11.

## Spuštění v Dockeru

```bash
cp .env.example .env
# doplňte HF_TOKEN
docker compose up --build
```

Web poběží na `http://localhost:8000`, interní ML API je publikované pouze na loopbacku
`127.0.0.1:8001`. Migrate kontejner čeká na PostgreSQL a web/worker čekají na dokončené migrace.

GPU:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

Vyžaduje NVIDIA runtime. Bez override běží CPU fallback; pro vývoj nastavte například
`WHISPER_MODEL=small`, protože výchozí `large-v3` je náročný.

## Lokální spuštění

```bash
cp .env.example .env
docker compose up -d postgres
deno task db:migrate
deno task dev:web
```

Je-li port 5432 obsazený, nastavte například `POSTGRES_PORT=55432` a upravte stejně port v
`DATABASE_URL`.

V druhém terminálu:

```bash
deno task dev:worker
```

ML službu je nejsnazší spustit kontejnerem:

```bash
docker compose up -d audio-ml
```

Pro Python virtualenv použijte Python 3.11–3.13:

```bash
cd services/audio-ml
python3.11 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

## Synology a vzdálený DGX Spark

Produkční PostgreSQL, web a worker běží v Container Manageru na Synology. Podcastové soubory se do
webu a workeru bind-mountují z `/volume1/Podcasts` jako `/data`; databáze je uložená odděleně v
`/volume1/docker/podcast-tool/postgres`. DGX Spark připojuje stejný podcastový share pouze pro
čtení. Worker předává ML službě relativně mapovanou cestu, takže mountpoint na NAS a DGX nemusí být
stejný.

Kořenový `.env` obsahuje adresu Sparku, přístup k NAS a náhodný `AUDIO_ML_API_TOKEN`. Soubor je v
`.gitignore`; nesmí se commitovat. Pro diarizaci je ještě nutné doplnit `HF_TOKEN` a přijmout
podmínky použitých pyannote modelů.

Na řídicím počítači nainstalujte Ansible. Spark se spravuje přes SSH konfiguraci a klíč, bez
interaktivního shellu:

```bash
deno task spark:bootstrap
deno task spark:deploy
deno task spark:status
```

`spark:bootstrap` pouze ověří ARM64, Docker, NVIDIA runtime a dostupnost SMB. `spark:deploy` přenese
`services/audio-ml`, sestaví image přímo na Sparku, spustí jej s GPU a ověří readiness všech audio
modelů. Stejný idempotentní postup pro další verze má kratší alias:

```bash
deno task spark:update
```

Synology používá údaje `NAS_HOST`, `NAS_ANSIBLE_USER` a `NAS_ANSIBLE_PASSWORD` z ignorovaného
`.env`. Bootstrap ověří architekturu, Docker, Compose, volné místo, podcastový adresář a práva přes
`sudo`. Deploy přenese zdroje, sestaví amd64 obrazy přímo na NASu, provede dopředné migrace a ověří
web, zápis do storage a připravenost vzdáleného ML:

```bash
deno task synology:bootstrap
deno task synology:deploy
deno task synology:status
```

Port PostgreSQL není z NASu publikovaný; web je v LAN na `http://NAS_HOST:8000`. Produkční `.env` a
generované databázové heslo na NASu mají omezená práva. Model cache zůstává v Docker volume na SSD
Sparku, nikoli na NAS. Lokální `compose:nas:*` úlohy zůstávají jen pro vývojový režim, ve kterém se
NAS share připojuje přes CIFS do Docker Desktopu.

## Použití

1. Na `/` vložte veřejné HTTP(S) RSS URL; import je idempotentní. Tlačítko „Aktualizovat RSS“ doplní
   nové díly a upraví metadata existujících. Epizody, které vydavatel z feedu odstranil, zůstanou v
   knihovně označené jako „Mimo RSS“; uložené audio a odvozená data se nemažou.
2. Otevřete epizodu a klikněte na „Zpracovat“. Web pouze založí job.
3. Worker postupně stáhne audio, vytvoří 16 kHz mono WAV, zavolá ML API, uloží processing run,
   transcript, chunky a embeddingy.
4. Na detailu přiřaďte speaker cluster existující nebo nové osobě. Potvrzení transakčně vytvoří
   případnou novou osobu, zapíše účastníka, propíše osobu do utterances a označí hlasový embedding
   jako citlivou ověřenou referenci.
5. `/search` nabízí fulltext, semantic/hybrid retrieval a otázku nad zdroji. Podcast je povinný
   filtr, epizoda volitelný; filtrovací dropdown mluvčích se automaticky zúží na osoby s promluvami
   ve vybraném podcastu nebo epizodě. Není-li generativní provider nakonfigurován, `/api/ask`
   bezpečně vrací pouze citované zdrojové úseky.

Epizodu s nepoužitelným nebo cizojazyčným přepisem lze na jejím detailu ručně „Vyloučit z RAG“.
Audio zůstane uložené, ale přepis, chunky, processing run a identifikace hlasů se odstraní. Epizoda
se pak nevrací ve vyhledávání, nepoužívá se jako zdroj odpovědí ani se nepočítá mezi díly s
nepřiřazenými hlasy. Opětovné povolení je možné, ale vyžaduje nový přepis tlačítkem „Opakovat“.

Při ručním přiřazování hlasu lze přes filtrovací dropdown zvolit existujícího moderátora či hosta
nebo vytvořit novou osobu v obou rolích včetně poznámky. Nová osoba se vytvoří a přiřadí transakčně;
role se současně uloží mezi účastníky epizody. Ověřené karty hlasů se zobrazují kompaktně a tlačítko
„Editovat“ znovu zpřístupní přiřazení.

Detail podcastu odkazuje tlačítkem „⚙ Nastavení“ na samostatnou stránku pro ruční i automatickou
denní aktualizaci RSS, hromadné stažení chybějících dílů, automatické zpracování a volbu diarizace.
Boolean automatiky se ovládají přepínači a stav backlogu s odhadem je na stránce trvale viditelný.
Hromadné download joby mají nižší prioritu, po stažení nespouštějí ML pipeline a epizody zůstanou ve
stavu `downloaded`. Zapnutá automatika je později postupně vybere a naváže normalizací, přepisem a
indexací. Stahování a zpracování používají samostatné worker sloty, takže dlouhá fronta předstažení
neblokuje normalizaci ani ML pipeline.

Demo bez modelů:

```bash
deno task db:seed
```

Data jsou viditelně označená `[DEMO]` a netvrdí, že pocházejí ze skutečného ML zpracování.

Worker drží dvě logické fronty nad společnou auditní tabulkou `jobs`. Download sloty claimují pouze
`DOWNLOAD_AUDIO`; processing sloty claimují normalizaci, ML, chunking a embeddingy. Počet slotů je
konfigurovatelný zvlášť, zatímco audio služba samostatně omezuje počet náročných ML pipeline.

## Konfigurace modelů

- `WHISPER_MODEL`: Hugging Face Whisper model, výchozí `openai/whisper-large-v3`. Jde o plný
  multilingual model upřednostňující přesnost před rychlostí; na Sparku běží přes CUDA v PyTorch.
- `DIARIZATION_MODEL`: gated pyannote 4.x pipeline, výchozí
  `pyannote/speaker-diarization-community-1`; před prvním nasazením přijměte jeho podmínky na
  Hugging Face.
- `SPEAKER_EMBEDDING_MODEL`: veřejný WeSpeaker model s 256 rozměry; databázová migrace rozměr
  explicitně kontroluje.
- `TEXT_EMBEDDING_MODEL`: vícejazyčný `BAAI/bge-m3` s 1024 rozměry.
- `TEXT_RERANKER_MODEL`: vícejazyčný cross-encoder `BAAI/bge-reranker-v2-m3`, který znovu seřadí
  kandidáty a odfiltruje slabé shody.
- `SEARCH_MIN_RERANK_SCORE`: minimální skóre ve vyváženém režimu; UI nabízí také přísný režim a
  širší tematické souvislosti.
- Prázdný jazyk umožní autodetekci; výchozí aplikace posílá `cs`.

Změna rozměrů modelu vyžaduje novou migraci/index a re-embedding. Aplikace záměrně odmítne porovnat
nekompatibilní model nebo dimenzi.

## Migrace a testování

```bash
deno task db:migrate
deno task check
RUN_INTEGRATION_TESTS=1 deno task test:integration
cd services/audio-ml && .venv/bin/pytest
docker compose config --quiet
```

`deno task db:reset` je destruktivní a je zakázaný v `APP_ENV=production`.

## Známá omezení

- PostgreSQL MVP používá fulltext konfiguraci `simple`; české skloňování není stemmingem pokryté.
- Automatické voice matching návrhy, přímá oslovení a claims jsou další etapa; ruční identifikace je
  funkční. Generativní odpověď je volitelná a vyžaduje nakonfigurovaný OpenAI-kompatibilní server;
  její lokální ThinkingCap profil ještě čeká na český eval bez souběžné audio zátěže.
- Pyannote vyžaduje HF token a přijetí licence modelu. Bez něj služba vrátí `HF_TOKEN_REQUIRED`,
  nikdy falešnou diarizaci.
- Lokální autentizace je výchozím nastavením vypnutá. Pro sdílené prostředí nastavte
  `AUTH_MODE=header` a `AUTH_TOKEN`; produkce dále potřebuje TLS, správu uživatelů a audit.
- Provozovatel odpovídá za licenci a právní titul ke stažení, přepisu a biometrickému zpracování
  hlasů. Aplikace nestahuje nic mimo veřejnou audio URL uvedenou ve feedu a neobchází DRM ani
  přístupové bariéry.

## Troubleshooting

- `HF_TOKEN_REQUIRED`: doplňte token a přijměte podmínky modelu na Hugging Face.
- nefunkční vzdálené ML: spusťte `deno task spark:status` a ověřte port TCP 8001 mezi NAS workerem a
  Sparkem,
- nefunkční Synology deployment: spusťte `deno task synology:bootstrap` a
  `deno task synology:status`; ověřte údaje `NAS_*` v `.env` a existenci `/volume1/Podcasts`,
- worker hlásí `ML služba zatím není připravená`: ověřte `curl http://localhost:8001/health/ready`.
- ffmpeg chyba: ověřte `ffmpeg -version`, vstupní MIME a artefakt v `storage`.
- nefunkční semantic search: nejprve dokončete `CREATE_TEXT_EMBEDDINGS`; hybrid endpoint při
  nedostupném provideru degraduje na fulltext s varováním.
- po změně textového modelu spusťte `deno task db:migrate` a `deno task search:reindex`; přepis ani
  diarizace se při tom neopakují.
- starý running job převezme jiný worker po `JOB_LOCK_TIMEOUT_SECONDS`; průběžný heartbeat tomu při
  zdravém workeru zabrání.
