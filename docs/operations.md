# Provoz

## Synology

Produkční aplikační stack běží na Synology DS1525+ pod Compose projektem `podcast-intelligence`:

- instalace, Compose a tajná konfigurace: `/volume1/docker/podcast-tool`,
- PostgreSQL data: `/volume1/docker/podcast-tool/postgres`,
- databázové dumpy: `/volume1/docker/podcast-tool/backups`,
- audio a odvozené soubory: `/volume1/Podcasts`, bind-mountované jako `/data`.

PostgreSQL nemá publikovaný host port. Web naslouchá v LAN na portu 8000 a worker komunikuje s
audio-ML na DGX Spark přes bearer token. Správa z Macu používá heslové SSH údaje uložené pouze v
ignorovaném `.env`; vzdálené příkazy běží přes `sudo`. DSM Python 3.8 je starší než požadavek
aktuálního Ansible Core, proto Synology role záměrně používá vzdálené `raw` příkazy a na NAS
neinstaluje alternativní Python.

```bash
deno task synology:bootstrap
deno task synology:deploy
deno task synology:status
```

Deploy je opakovatelný: přenese zdroje bez macOS AppleDouble metadat, sestaví obrazy na x86_64 NASu,
spustí dopředné migrace, obnoví web a worker a provede health, storage read-write a audio-ML
readiness test. Po úspěchu vytvoří marker `/volume1/docker/podcast-tool/.migration-complete`.

PostgreSQL Compose konfigurace používá `init: true`, aby osiřelé procesy healthchecků přebíral
Docker init místo postmasteru. Healthcheck spouští `pg_isready` přímo přes `CMD`, s klientským
timeoutem 10 s a Docker timeoutem 15 s. Postmaster jako PID 1 může exit 2 osiřelého klienta
vyhodnotit jako pád backendu a obnovit celý cluster; tento mechanismus byl 2026-10-30 reprodukován
na izolovaném kontejneru stejného image. Oprava je nasazená od 2026-10-30 v 19:55 CET po bezpečném
dokončení ML úlohy, ověřené záloze a znovuvytvoření PostgreSQL kontejneru; podrobnosti jsou v
`docs/status.md`. Samotný běžný deploy webu/workeru existující databázový kontejner nepřepíná. Popis
stejného problému a opravy je v
[upstream incidentu SuperSync](https://github.com/super-productivity/super-productivity/pull/9917).

Při výměně workeru během dlouhého ML jobu nejprve připravte a ověřte nový image. SIGTERM obsloužený
workerem zastaví nové claimy a plánování, ale nechá současný handler doběhnout. Nepoužívejte
`docker stop` s kratší prodlevou než zbývající úloha: po prodlevě posílá SIGKILL. Samotné
`docker kill --signal=TERM` neplánuje násilné ukončení; výměna pak musí čekat na exit, ověřit
dokončení úlohy a spustit nový worker. Během tohoto čekání neprovádějte jiný deploy. Připravený
jednorázový postup z 2026-10-30 a jeho markery jsou popsané v `docs/status.md`.

Před ručním zásahem do databáze vytvořte custom-format `pg_dump` do adresáře `backups` a ověřte jej
pomocí `pg_restore --list`. Obnova musí proběhnout při zastaveném webu a workeru. Samotný PostgreSQL
adresář nekopírujte za běhu databáze. Podcastové soubory a databázový dump zálohujte ve stejném
maintenance okně.

## DGX Spark

Spark je spravovaný Ansible playbooky v `infra/ansible`. Inventory používá SSH alias `gx10-d8fb` a
uživatele `mvich`; SSH klíč a host mapping zůstávají v uživatelském SSH configu. Nasazení nevyžaduje
`sudo`, protože Docker a NVIDIA runtime jsou na DGX připravené a účet je členem Docker skupiny.

```bash
deno task spark:bootstrap
deno task spark:deploy
deno task spark:status
deno task spark:update
```

Deploy kopíruje pouze Python ML službu do `~/.local/share/podcast-audio-ml`, buildí ARM64 image,
provede Compose update a kontroluje `gpuAvailable`. Kontejner má restart policy `unless-stopped`.
Synology share je připojen Docker CIFS volume pouze pro čtení; model cache je lokální named volume.
Tajné hodnoty se čtou z ignorovaného kořenového `.env` a vzdálený `.env` má mód `0600`.

Port 8001 není určen k publikování do internetu. API kontroluje bearer token; v důvěryhodné LAN je
dále vhodné omezit port firewallem na IP počítače s workerem.

## Obnova RSS

Tlačítko „Aktualizovat RSS“ na přehledu a stránce nastavení podcastu načte feed znovu. Import přidá
nové epizody, aktualizuje metadata existujících a obnoví příznak epizody, která se ve feedu znovu
objeví. Položky, jež už feed neobsahuje, dostanou stav „Mimo RSS“ a datum prvního zjištění. Záznam
ani navázaná data se nemažou. Pokud už má taková epizoda stažené audio, lze ji dál přehrávat,
zpracovat a prohledávat; bez dříve staženého audia ji není možné nově stáhnout.

Per-podcast přepínač automatické aktualizace zařazuje nízkoprioritní idempotentní `IMPORT_FEED` job,
pokud od posledního úspěšného importu uplynulo alespoň 24 hodin. PostgreSQL advisory lock zabrání
souběžnému naplánování více workery. Aktivní job i jakýkoli pokus vytvořený v posledních 24 hodinách
blokuje další naplánování, takže nedostupný feed nevytvoří rychlou nekonečnou retry smyčku.

## Retry a zotavení

Worker navyšuje `attempts`, posílá heartbeat a retry plánuje exponenciálně. Running job bez
čerstvého heartbeat může jiný worker převzít po `JOB_LOCK_TIMEOUT_SECONDS`. SIGINT/SIGTERM zastaví
claimování dalších jobs a aktuální doběhne. Po max attempts je job `failed` a epizoda `failed`.

Výpadek databáze při claimování nebo ukládání výsledku/chyby neukončí celý worker. Každý slot
zaloguje chybu s ID úlohy, pokud ji již převzal, a další odběr opakuje s exponenciální prodlevou od
`max(1000, JOB_POLL_INTERVAL_MS)` do 30 sekund. Úspěšný průchod prodlevu resetuje. Handler se
neopakuje přímo: další pokus vždy prochází databázovým claimem, protože přerušený zápis mohl být
potvrzený. Pokud se nepodařilo uložit selhání úlohy, její zámek zůstává do vypršení heartbeat
timeoutu. Ostatní sloty pokračují a čekání na další pokus lze přerušit SIGINT/SIGTERM.

Audio ML klient nepoužívá pevný limit na celý požadavek. `AUDIO_ML_IDLE_TIMEOUT_MS` (výchozí 30
minut) měří pouze dobu bez progress eventu; při čekání na pipeline slot posílá služba pravidelný
keepalive. Odpojení klienta nastaví kooperativní cancellation, která ukončí čekání okamžitě a
aktivní výpočet nejpozději na hranici právě běžícího Whisper chunku nebo další ML fáze.

Každé selhání `PROCESS_AUDIO_ML` zařadí prioritní `CHECK_AUDIO_ML_HEALTH`. Kontrola volá
autentizovaný `/health/diagnostics`, který v novém procesu provede CUDA výpočet a inicializaci NVML,
a zároveň ověří načtené modely a čitelnost sdíleného úložiště. Kritické výsledky se slučují podle
selhaných kontrol do tabulky `system_incidents`. Dokud incident na stránce `/system-incidents` není
potvrzený, odešle se stejná Pushover zpráva nejvýše jednou za `PUSHOVER_NOTIFICATION_COOLDOWN_MS`
(výchozí tři hodiny). Potvrzení ukončí daný incident; nový výskyt poté založí nový záznam. Historie
zůstává zachovaná.

Pushover vyžaduje současně `PUSHOVER_APP_TOKEN` a `PUSHOVER_USER_KEY`. Bez nich diagnostika a
historie fungují dál, pouze se zpráva neodešle. Tlačítko „Otestovat notifikaci“ na stránce
upozornění posílá přímou testovací zprávu a tříhodinový limit obchází.

Whisper ukládá každý dokončený pětiminutový chunk atomicky do persistentního volume
`transcription-checkpoints`. Checkpoint je svázaný s ID jobu, fingerprintem audia, modelem, jazykem
a parametry dělení. Jeden chunk má až `TRANSCRIPTION_CHUNK_MAX_ATTEMPTS` lokálních pokusů s
exponenciální prodlevou; následný job retry načte hotové chunky a pokračuje prvním chybějícím. Změna
audia, modelu nebo parametrů automaticky vytvoří nový podpis a starý checkpoint nepoužije. Diarizace
zůstává celosouborová fáze.

`WORKER_CONCURRENCY` určuje počet processing slotů a `DOWNLOAD_WORKER_CONCURRENCY` počet nezávislých
download slotů v jednom worker procesu. Compose má výchozí hodnotu dva pro každou frontu; aktuální
Synology konfigurace používá jeden processing a dva download sloty. Audio služba omezuje počet
kompletních audio pipeline přes `AUDIO_PIPELINE_MAX_CONCURRENCY`; po benchmarku zůstává produkční
hodnota jedna. Experimentální hodnota dvě dovolí souběžný Whisper, zatímco diarizace a hlasové
embeddingy zůstávají kvůli sdíleným pyannote modelům serializované. Endpoint `/health/ready` vrací
kapacitu a aktuální počet aktivních a čekajících audio pipeline.

Worker současně každých `AUTO_PROCESS_INTERVAL_MS` (výchozí hodnota 60 sekund) kontroluje autopilot.
Pokud neexistuje žádný běžný `queued` ani `running` processing job, atomicky vybere nejnovější
nezpracovanou epizodu z podcastů s povoleným automatickým zpracováním a zařadí její první chybějící
krok. Nízkoprioritní hromadné downloady s `continuePipeline=false` tuto kontrolu neblokují a již
stažené epizody mají přednost. Výběr používá transakční advisory lock, takže ani více worker procesů
nevytvoří dvě úlohy. Epizody ve stavu `failed` se automaticky neopakují a epizoda mimo RSS bez
uloženého audia se přeskočí.

## Varianty přepisů a ElevenLabs Scribe

První dokončený přepis se automaticky vybere a spustí přiřazení moderátorů, identifikaci a indexaci.
Uložení, výběr a zařazení identifikace probíhají v jedné transakci; opakování stejné úlohy nevytvoří
další identifikaci. Až další vytvořená varianta čeká na ruční výběr v detailu epizody, kde volba
„Použít pro přiřazení hlasů“ spustí identifikaci a indexaci. Dosavadní vybraný přepis zůstává během
přípravy další varianty dostupný pro vyhledávání. Původní přepisy i jejich přiřazení osob se
uchovávají; každá varianta může mít jiné hlasy a jiný počet mluvčích.

Detail i seznam epizod ukazují použitý model a způsob zpracování. „Přegenerovat lokálně“ použije
aktuální Whisper a nastavení diarizace podcastu. V detailu lze přes „Vytvořit / přegenerovat přepis“
zvolit Scribe nebo lokální přepis s konkrétním režimem zarovnání. Porovnání zobrazí dvojici variant
vedle sebe po 30sekundových úsecích podle začátku promluv; timestamp přehraje příslušné místo audia.
Zvýraznění označuje jiný text nebo segmentaci, nikoli automatické hodnocení kvality.

- `POST /api/episodes/:id/transcripts` přijímá `provider: local | elevenlabs` a volitelný
  `transcriptAlignmentMode: segment | overlap | overlap_asr_corrected` (jen lokální přepis).
- `GET /api/episodes/:id/transcripts` vrací dokončené varianty a počty hlasů a promluv.
- `POST /api/episodes/:id/transcripts/select` přijímá `{ "runId": "UUID" }`; výběr cizího runu nebo
  změna během běžící úlohy je odmítnuta.

Pro Scribe nastavte `ELEVENLABS_API_KEY` ve webu a workeru, volitelně
`ELEVENLABS_SCRIBE_MODEL=scribe_v2` a `ELEVENLABS_TIMEOUT_MS=1800000`. Compose a Synology Ansible
tyto hodnoty přenášejí z `.env`. Bez klíče je volba nedostupná. Audio se odesílá do ElevenLabs a
účtuje podle příslušného účtu. Scribe zpracuje uložené originální audio bez závislosti na Sparku;
lokální varianta vyžaduje normalizované audio. Pipeline nepřechází na mock ani na jiný provider.

Nový výchozí lokální model je `Cem13/whisper-large-v3-czech`, načítaný přes stávající
Transformers/PyTorch backend. `WHISPER_MODEL` musí být aktualizovaný i v běžící audio-ML službě;
změna zdrojů sama produkční model nepřepne. Při nasazení proveďte migraci 024 a aktualizujte web,
worker i konfiguraci audio-ML na Sparku. První načtení nového modelu vyžaduje stažení vah.
Existující výsledky zůstávají označené původním modelem.

Kontrakty providerů:
[ElevenLabs Scribe](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) a
[český Whisper](https://huggingface.co/Cem13/whisper-large-v3-czech).

## Hromadné předstažení

`POST /api/podcasts/:id/download-missing` hromadně zařadí `DOWNLOAD_AUDIO` pro epizody daného
podcastu, které jsou stále v RSS, nejsou vyloučené z RAG a nemají uložené originální audio. Joby
mají prioritu `-20` a payload `continuePipeline=false`, takže po úspěšném stažení nevytvoří
normalizační job. Epizoda zůstane `downloaded`; autopilot ji později vybere běžným pořadím a
pokračuje od normalizace. Opakované volání je idempotentní díky unikátnímu aktivnímu jobu
typu/epizody. Download joby claimují pouze download sloty, takže předstažení neobsadí processing
sloty. Stránka `/jobs` ukazuje u každé úlohy příslušnou logickou frontu.

Detail podcastu odkazuje přes tlačítko „⚙ Nastavení“ na `/podcasts/:id/settings`. Tato stránka
sdružuje ruční i automatickou denní aktualizaci RSS, hromadné stažení, přepínač automatického
zpracování a volbu diarizace; z detailu byly tyto provozní akce odstraněny.

Viditelný panel automatizace se načte při otevření nastavení a obnovuje se každých 30 sekund, pokud
je stránka viditelná. Epizodu počítá jako zpracovanou už po dokončení přepisu včetně korekcí; výběr
varianty, přiřazení hlasů ani navazující indexace ji nevracejí do odhadu zbývající práce. Epizody
čekající na výběr přepisu nebo doladění hlasů ukazuje zvlášť jako podmnožinu zpracovaných. Epizody
vyloučené z RAG se do backlogu nezapočítávají. Odhad násobí počet zbývajících epizod průměrem
aktivních dob stažení, normalizace a přepisu posledních pěti dokončených přepisů, včetně těch
čekajících na ruční doladění. Čekání ve frontě ani identifikace a indexace se do průměru nepočítají.
Bez historie se použije konzervativní fallback 60 minut na epizodu. Jde o odhad práce po celých
epizodách, nikoli průběžný odpočet času právě běžící úlohy.

Opětovné zpracování běžně vybere první chybějící artefakt. Download i normalizace znovu používají
validní soubor; uložený dokončený processing run zabrání opakovanému ML volání po pádu mezi uložením
výsledku a dokončením jobu.

U již hotové epizody tlačítko pro nové zpracování posílá režim `full`. Ten znovu spustí celý audio
ML krok nad existujícím normalizovaným WAV a vytvoří nový processing run. Původní run ani jeho
promluvy se nemažou a nový run se stane aktivním až po kompletním transakčním uložení výsledku.
Ruční přiřazení nebo ignorování clusterů se mezi runy automaticky nepřenáší, protože nové clustery
nemusejí mít stejné hranice ani labels. `processing_runs.source_job_id` zajišťuje, že retry stejného
vynuceného jobu nevytvoří další run ani neopakuje dokončené ML volání.

Na stránce nastavení podcastu lze zvolit zarovnání přepisu a hlasů. `segment` je výchozí původní
režim se stabilními Whisper segmenty; `overlap` používá jemné proporcionální zarovnání a vyhlazení
krátkých změn hlasu pro pořady s častým skákáním do řeči. `overlap_asr_corrected` nad stejným
výsledkem navíc kontextově opravuje pouze pravděpodobné ASR chyby v názvech, anglicismech a
odborných termínech. Volba se snapshotuje do payloadu audio jobu, takže retry zachová původně
zvolený režim, zapisuje se do nového processing runu a uplatní se při příštím kompletním zpracování,
nikoli zpětně na existující run. Jemně zarovnaný čas a čas přehrávání se ukládají odděleně; kliknutí
i vyhledávací citace používají původní Whisper začátek.

ASR korekce používá existující OpenAI-kompatibilní generativní server: přednost má lokální
`ANSWER_GENERATION_PROVIDER=openai-compatible`, fallback je už nakonfigurované OpenAI API. Model lze
přepsat přes `ASR_CORRECTION_MODEL`; bez něj se použije model příslušného existujícího provideru.
`ASR_CORRECTION_AUTO_APPLY_THRESHOLD` (výchozí `0.85`) řídí automatické přijetí,
`ASR_CORRECTION_CONCURRENCY` (4) souběžnost a `ASR_CORRECTION_CONTEXT_SIZE` (90) počet sekund na
každé straně cíle. Bez dostupného provideru job bezpečně uloží raw diarizovaný přepis a warning.
Každé modelové selhání je lokální pro jednu promluvu; souhrnný log obsahuje jen počty, dobu a
tokeny. V development prostředí se pro přijaté editace zapisuje čitelný debug výpis, produkce text
do logu nepřidává.

## Využití úložiště

Worker po dokončení nebo selhání každého episode jobu změří skutečné soubory dané epizody a obnoví
cache podcastu. Audio zahrnuje originální soubor i normalizované WAV, přepisy zahrnují
`derived/transcript-*.json` a ostatní zachytí další soubory v adresáři epizody. Databázová režie
PostgreSQL se do údaje nepočítá. Po migraci nebo ruční změně storage lze všechny podcasty přepočítat
příkazem `deno task storage:recalculate`.

## Modely a reindexace

Vyhledávání i Answer API vyžadují `podcastId` a volitelně přijímají `episodeId`. Endpoint
`GET /api/search/filters` vrací pro vybraný podcast pouze epizody s aktuálními prohledatelnými
chunky a mluvčí s identifikovanou promluvou; po volbě epizody se mluvčí zúží na daný díl. V UI se
mluvčí vybírá filtrovacím dropdownem, který hledá ve jménech bez ohledu na diakritiku. Epizody
vyloučené z RAG se ve volbách ani výsledcích neobjeví.

Stránka vyhledávání zobrazuje pouze formulář otázky nad zdroji; samostatný klasický search formulář
je v UI skrytý, API `/api/search` zůstává dostupné. Answer výsledek ukazuje tematické sekce a jejich
klikací citace s datem a časem, ale neopakuje pod nimi celé surové bloky zdrojových úryvků.

Na detailu epizody lze u každé jednotlivé promluvy rozbalit „Změnit mluvčí“ a vybrat existující
osobu daného podcastu, neznámého mluvčího nebo návrat k identitě hlasové karty. Ruční volba se
ukládá jako override a pozdější přiřazení celé hlasové karty ji nepřepíše. Návrat k hlasové kartě
override odstraní a okamžitě převezme její aktuální osobu. Nově vybraná osoba se zároveň
idempotentně doplní mezi účastníky epizody s dosud neznámou rolí.

Vyhledávání osoby v segmentu ignoruje diakritiku i pořadí částí jména; výběr lze potvrdit klávesou
Enter. Editor se inicializuje až při otevření segmentu. Uložení odešle
`PATCH /api/utterances/:id/speaker` a z odpovědi aktualizuje jméno a štítek ruční úpravy přímo v
segmentu, bez načtení celé stránky nebo přerušení audia. Chyba se zobrazí u segmentu a volba zůstane
připravená pro opakování.

Tlačítko „Přeskočit díl“ v sekci Mluvčí vyřadí celou epizodu z navigace „Další díl“ a počtu „k
doladění“, včetně čekání na výběr varianty. Epizoda má štítek „Přeskočený“ a v seznamu podcastu
vlastní filtr `status=skipped`; ostatní stavové filtry ji vynechávají, „Všechny stavy“ ji ponechává.
Přepis, audio, přiřazení i indexace zůstávají zachované. „Vrátit k přiřazování hlasů“ znovu povolí
nabízení epizody, pokud ještě obsahuje nevyřešené hlasy nebo čeká na výběr přepisu. Jde o příznak
`episodes.speaker_review_skipped` z migrace `026_episode_speaker_review_skip.sql`, nezávislý na
stavu automatického zpracování; zůstává nastavený i po vytvoření další varianty přepisu. API
`PATCH /api/episodes/:id/speaker-review` přijímá `{ "skipped": true | false }`.

Osoby jsou globální, jejich role je ale vztažená ke konkrétnímu podcastu přes `podcast_persons`.
Vazba je M:N a obsahuje právě roli `moderator` nebo `guest`; stejný člověk proto může mít v různých
podcastech odlišnou roli. Migrace `016_podcast_persons.sql` odvodí současné vazby z účastníků
epizod, přiřazených clusterů, promluv, hlasových referencí a claimů. Při výběru celé hlasové karty i
jednotlivé promluvy server nabídne a přijme jen osobu navázanou na podcast dané epizody. Vytvoření
nové osoby z hlasové karty vytvoří vazbu transakčně; samostatné UI pro připojení už existující osoby
k dalšímu podcastu zatím není součástí aplikace.

Tlačítko „Ignorovat hlas“ na kartě clusteru označí pouze hlas aktuálního processing runu. Přepis ani
chunky nemaže, ale hlas vyřadí z počtu nevyřešených hlasů, navigace na další díl i automatické
identifikace. Clusterové přiřazení osoby se odstraní a embedding vytvořený z clusteru přestane být
ověřenou hlasovou referencí; ruční změny mluvčího na jednotlivých promluvách zůstanou beze změny.
„Obnovit hlas“ vrátí kartu jako nepřiřazenou. Po kompletním novém zpracování vznikne nový processing
run s novými clustery, takže dřívější ignorování se na něj automaticky nepřenáší.

Epizody s nekvalitním nebo jazykově chybným přepisem lze na detailu ručně vyloučit z RAG. Příznak
`episodes.rag_excluded` se uplatňuje při výběru fulltextových i vektorových kandidátů, a tím i při
výběru zdrojů pro Answer API. Potvrzená akce odstraní všechny processing runs epizody, a s nimi
přepis, chunky, textové i hlasové embeddingy, speaker clustery a transcriptové JSON artefakty.
Originální a normalizované audio zůstává. Epizoda se vynechá také z autopilotu a workflow
nepřiřazených hlasů. Po opětovném povolení RAG je nutné ručně spustit nový přepis. Tato provozní
pojistka nenahrazuje budoucí per-episode volbu jazyka pro smíšené nahrávky.

Generativní Answer model běží jako samostatný OpenAI-kompatibilní server a není součástí `audio-ml`.
Nasazuje a kontroluje se bez restartu audio pipeline:

```bash
deno task spark:answer:deploy
deno task spark:answer:status
```

Pro ThinkingCap se používá `bottlecapai/ThinkingCap-Qwen3.6-27B-NVFP4` ve vLLM. Samostatný server
publikuje autentizované API v důvěryhodné LAN na portu 8002; bearer token načítá z prostředí a není
součástí příkazové řádky procesu. Produkční profil má kontext 16 384 tokenů, nejvýše dva současné
požadavky, chunked prefill, prefix cache a FP8 KV cache. Po jeho ověření nastavte
`ANSWER_GENERATION_PROVIDER=openai-compatible` a
`ANSWER_GENERATION_BASE_URL=http://gx10-d8fb:8002/v1` ve webové službě. Během aktivního přepisu
epizod může Answer server obsloužit až dva dotazy najednou: samostatný kontejner sice nerestartuje
`audio-ml`, ale při generování sdílí jeho GPU a může dočasně zvýšit latenci přepisu. V idle stavu
zůstávají váhy v unified paměti, ale model neprovádí inference. Provider je ve výchozím stavu
vypnutý a jeho selhání nezablokuje vyhledání zdrojů.

Formulář „Otázka nad zdroji“ umí pro každý dotaz přepnout mezi lokálním ThinkingCapem a modely
OpenAI `gpt-5.6-luna`, `gpt-6.1-sol`, `gpt-6-sol` a `gpt-6-luna` přes Chat Completions API. Všechny
volby OpenAI používají stávající `OPENAI_API_KEY`; bez něj jsou v nabídce nedostupné.
`OPENAI_ANSWER_MODEL` zachovává přepsání modelu původní volby GPT-5.6 Luna; nové volby posílají své
vlastní pevné API ID. Timeout, výstupní limit a reasoning sdílejí nastavení
`OPENAI_ANSWER_TIMEOUT_MS`, `OPENAI_ANSWER_MAX_TOKENS` a `OPENAI_ANSWER_REASONING_EFFORT`. Výchozí
effort je `low` a limit 4000 tokenů. OpenAI větev neposílá vLLM-specifické parametry a používá
`max_completion_tokens`; finální odpověď prochází stejnou validací JSON a source IDs jako lokální
model. GPT-6.1 Sol nepodporuje effort `none`, takže používá alespoň `low` i při sestavení finální
JSON odpovědi. Ostatní nové modely `none` podporují. Názvy a parametry byly ověřeny v
[OpenAI Docs pro GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) a
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna). Při volbě kteréhokoli modelu
OpenAI opouštějí dohledané přepisové úryvky lokální síť a jsou odeslány do OpenAI API, na což UI
výslovně upozorňuje.

Analýza vybírá nejvýše 16 úryvků, obvykle nejvýše dva z jedné epizody; při explicitním filtru
epizody může použít více samostatných pasáží z téhož dílu. Výběr má přednostně pokrýt různé díly.
Databázový limit kandidátů se uplatňuje až po odstranění identických textů a vyvážení epizod, takže
opakování v jednom přepisu nevytlačí další díly. Dlouhé opakující se ASR smyčky a výrazně
překrývající se pasáže se do podkladů nezařazují; původní přepis zůstává beze změny. Krátké
vyhledávací termíny (například samostatné „N“) se hledají přesně. Počet v průběhu odpovědi označuje
vybrané úryvky a epizody, nikoli celkový počet zmínek v archivu. Tato úprava nevyžaduje reindexaci.

Před hledáním se od tématu oddělí běžný rámec otázky: například „Co říká o Deníku N“, „Jak hodnotí
Deník N“ a „Jaký má názor na Deník N“ hledají stejné téma. Slovesa jako „hodnotí“ se nevyžadují
doslova ve zdrojovém úryvku. Dovětek „a jak se jeho názor v čase měnil“ zůstává pokynem pro model,
ale neomezuje fulltext; původní otázka se modelu předává celá. Filtr mluvčího, epizody a data,
přesná shoda krátkého „N“ i pravidla výběru různých epizod zůstávají platná pro všechny modely.

Před výběrem podkladů pro otázku požádá web zvolený model o vyhledávací plán. Posílá otázku a jméno
vybraného mluvčího. Plán přijímá nejvýše čtyři podmínky (zmínka osoby nebo téma). `all` vyžaduje
shodu všech ve stejném úryvku, `any` připouští jednotlivé shody. Až čtyři volitelné výrazy `prefer`
ovlivní pořadí před databázovým limitem. `each_branch` střídá výsledky větví, `ranked` upřednostní
skóre. Filtry formuláře se aplikují na každou větev a shoda se ověřuje v textu vybraného mluvčího.
Web plán validuje přes Zod a dotaz sestavuje s databázovými parametry. Chybějící provider, chyba,
neplatný plán nebo timeout (nejvýše 15 s) vedou k původnímu fulltextovému hledání. Platný plán s
nulou shod se automaticky nerozšiřuje. Výsledek validace a dobu volání v ms zaznamenává událost
`search_planning`. Finální odpověď používá původní otázku a vybrané úryvky.

Explicitní srovnání dvou témat oddělených „vs“, „versus“ nebo „proti“ hledá každou stranu samostatně
a výsledky střídá před odstraněním duplicit. Společná zmínka obou témat není podmínkou. Při
fulltextovém výběru podkladů pro odpověď se dvouslovná osobní jména rozpoznávají podle lexikonu
křestních jmen doplněného o jména z katalogu `persons`. Stejný postup funguje i pro samostatný dotaz
na jednu osobu. Celé jméno má vyšší prioritu než samotné příjmení; podporují se běžné české pádové
tvary. Nejde o úplný jazykový analyzátor: neznámá křestní jména, složená jména a nerozpoznané tvary
zůstávají přísným dotazem. Obecná témata jako „Česká televize“ se na poslední slovo nezkracují.

Příjmení se použije samostatně, až když aktivní a nevyloučené přepisy ve vybraném rozsahu doloží
celé jméno. Pokud kontext obsahuje více rozpoznaných křestních jmen se stejným příjmením, musí
samotné příjmení pocházet z dílu, kde je doložena pouze požadovaná osoba, nebo musí vybraný úryvek
obsahovat její celé jméno. Kontext může dodat jiný mluvčí; samotné výsledky však stále obsahují jen
výroky vybrané osoby. Rozlišení závisí na přepisu a pokrytí lexikonu, není zárukou identity každé
zmínky. Obě strany zachovávají filtry podcastu, epizody, mluvčího i data.

Kandidáty nejprve omezí existující GIN index `normalized_search_vector`, teprve pak se ověřuje text
vybraného mluvčího. Rozšíření nepotřebuje modelové volání, migraci, reindexaci ani nové zpracování
audia. Původní otázka dál řídí odpověď modelu.

ThinkingCap používá režim `responseStyle: "quotes"`: jedním voláním bez reasoningu vybírá doslovné
citace a jejich tematické zařazení. `ANSWER_GENERATION_MAX_TOKENS` a `ANSWER_GENERATION_TIMEOUT_MS`
nadále omezují volání; nastavení reasoning effort/budget se v tomto režimu nepoužívá. Každá citace
musí být souvislým úsekem konkrétního dodaného přepisu. Server povoluje pouze sjednocení bílých
znaků, ostatní změny textu odmítne. Po ověření zobrazuje text převzatý ze zdroje s vlastním odkazem
na díl a čas. Model nevytváří úvodní faktické shrnutí; tematické nadpisy pouze organizují citace.
Ověření doslovnosti nepotvrzuje správnost samotného audio přepisu.

Volby OpenAI nadále používají shrnutí: při zapnutém reasoningu nejprve připraví pracovní návrh a pak
finální JSON proti zdrojům. Finální odpověď má celý nakonfigurovaný výstupní limit, bez dodatečného
stropu 1000 tokenů. Kontrola známých source IDs není sémantickým ověřením každého tvrzení.

Web volá `/api/ask` s `Accept: application/x-ndjson`. U ThinkingCapu se zobrazují fáze hledání,
výběru citací a ověření doslovnosti; text se odešle až po úplné validaci. U shrnutí se pole `answer`
průběžně dekóduje a po dokončení se validuje celý JSON, source IDs a Zod kontrakt. Klientské
odpojení stream ukončí bez restartu modelu.

Při změně textového modelu nejprve přidejte migraci pro správnou dimenzi, pak vynulujte
embedding/model sloupce dotčených chunků a spusťte `deno task search:reindex`. Příkaz znovu vytvoří
kratší chunky a enqueueuje `CREATE_TEXT_EMBEDDINGS`; audio přepis ani diarizaci neopakuje.
Nemíchejte modely v jednom indexu. Nový audio model má vytvořit nový processing run a až po
kompletním zápisu změnit aktivní run.

## Zálohy

Databáze a storage jsou jeden konzistentní celek. Zálohujte `pg_dump` a storage volume ve stejném
maintenance okně. Transcript JSON je auditní artefakt, ale nenahrazuje databázovou zálohu.

## Mazání

FK jsou převážně `ON DELETE CASCADE`: smazání epizody odstraní odvozená data, ale fyzické storage
soubory musí produkční maintenance job odstranit až po commitnutí DB transakce. Smazání osoby
odstraní její hlasové reference a nastaví identitu clusterů/utterances na NULL dle FK. MVP zatím
destruktivní HTTP endpointy záměrně nevystavuje; provozní implementace musí přidat audit, potvrzení
a recoverable retention.

## Observabilita

Worker loguje JSON s job ID, typem, episode ID, worker ID, pokusem a dobou. `/jobs` a `/api/jobs`
ukazují posledních 100 jobs, související epizodu a podcast, stav, pokusy, chybu a průběh. Whisper
hlásí průběh po pětiminutových blocích, následně se zobrazuje fáze diarizace a hlasových embeddingů;
stránka se obnovuje každé tři sekundy. Logy neobsahují tokeny, celé embeddingy ani transcript. Další
etapa může doplnit Prometheus histogramy pro download/ffmpeg/ML real-time factor.

## Automatická identifikace mluvčích

Po `PROCESS_AUDIO_ML` běží před chunkingem idempotentní job `IDENTIFY_SPEAKERS`. Hlasové shody se
stálými moderátory používají pouze ověřené reference stejného podcastu, minimální podobnost 0,78,
minimální kombinované skóre 0,61 a odstup od druhého kandidáta alespoň 0,05. Jistá shoda se rovnou
propíše do clusteru, promluv a účastníků epizody, ale automaticky vzniklý embedding se neoznačí jako
nová ověřená reference; tím se omezuje samoposilující chyba. Kandidáty jsou jen osoby vedené jako
moderátor v M:N vazbě daného podcastu.

Po přiřazení moderátorů se LLM extrakce hosta spustí pouze při právě jednom clusteru se stavem
`unknown`. Používá lokální `ANSWER_GENERATION_*` provider, no-thinking JSON výstup a nejvýše 200
výstupních tokenů. Přijme pouze vysokou jistotu, celé osobní jméno dohledatelné v názvu nebo popisku
(včetně běžného českého skloňování) a jméno odlišné od už rozpoznaných moderátorů. Existující
normalizovaně stejnojmenná osoba se znovu použije, jinak vznikne nový host. Při nule nebo více
neznámých hlasech, nejednoznačných metadatech nebo nedostupném provideru pipeline pokračuje bez
automatického hosta. Nalezená nebo vytvořená osoba dostane roli hosta právě v tomto podcastu;
existující role moderátora se automaticky nepřepíše. Ruční účastníci ani ruční opravy promluv se
nepřepisují. Model dostává konkrétní seznam moderátorů podcastu jako závazný seznam jmen, která má
ignorovat. Stejná kontrola se jako doplňkový, neblokující job zařadí také po ručním ověření
moderátora, pokud tím zůstane právě jeden neznámý hlas; znovu přitom nespouští chunking ani
indexaci. Migrace `018_backfill_guest_identification_jobs.sql` jednorázově zařadí i dříve zpracované
způsobilé epizody. Pokud `ANSWER_GENERATION_API_KEY` není nastavený, Answer provider používá
společný `AUDIO_ML_API_TOKEN`, stejně jako webové Answer API.
