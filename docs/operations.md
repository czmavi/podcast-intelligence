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

Viditelný panel automatizace se načte při otevření nastavení. Ukazuje počet hotových a zbývajících
epizod, epizody ve frontě či běhu a orientační čas aktivní práce. Odhad je průměr součtu aktivních
dob posledních pěti dokončených epizod; doba čekání ve frontě se nepočítá. Bez historie se použije
konzervativní fallback 60 minut na epizodu.

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

Formulář „Otázka nad zdroji“ umí pro každý dotaz přepnout mezi lokálním ThinkingCapem a
`gpt-5.6-luna` přes OpenAI Chat Completions API. Luna se nabídne po nastavení `OPENAI_API_KEY`;
model, timeout, výstupní limit a reasoning lze změnit přes `OPENAI_ANSWER_MODEL`,
`OPENAI_ANSWER_TIMEOUT_MS`, `OPENAI_ANSWER_MAX_TOKENS` a `OPENAI_ANSWER_REASONING_EFFORT`. Výchozí
effort je `low` a limit 4000 tokenů. OpenAI větev neposílá vLLM-specifické parametry a používá
`max_completion_tokens`; finální odpověď prochází stejnou validací JSON a source IDs jako lokální
model. Při této volbě opouštějí dohledané přepisové úryvky lokální síť a jsou odeslány do OpenAI
API, na což UI výslovně upozorňuje.

Portál používá ve výchozím stavu rychlý režim bez interního uvažování:

```dotenv
ANSWER_GENERATION_REASONING_EFFORT=none
ANSWER_GENERATION_MAX_TOKENS=500
```

Pro experiment s reasoningem je potřeba přepnout effort a současně nechat dostatečný prostor pro
interní úvahu i finální JSON. Praktický výchozí experiment je:

```dotenv
ANSWER_GENERATION_REASONING_EFFORT=high
ANSWER_GENERATION_MAX_TOKENS=4096
ANSWER_GENERATION_THINKING_TOKEN_BUDGET=2048
ANSWER_GENERATION_TIMEOUT_MS=300000
```

Server běží s `--reasoning-parser qwen3`. Reasoning větev je dvoufázová: první volání pošle
`enable_thinking=true`, oddělí interní úvahu a do aplikace ji nevrací; druhé krátké volání v režimu
`no-think` zkontroluje návrh proti zdrojům a vytvoří validovaný JSON. Dvě fáze obcházejí
nespolehlivou kombinaci thinking režimu a vynuceného JSON výstupu tohoto checkpointu.
`THINKING_TOKEN_BUDGET` musí být menší než `MAX_TOKENS`, aby zbyly tokeny na finální odpověď. Změna
těchto hodnot vyžaduje pouze znovuvytvoření web kontejneru, ne Answer serveru ani `audio-ml`.

Web volá `/api/ask` s `Accept: application/x-ndjson`. Odpověď průběžně posílá fáze hledání zdrojů,
reasoningu (je-li zapnutý), generování odpovědi a dokončování citací. Hodnota `answer` se z
vynuceného JSON výstupu bezpečně dekóduje už během generování; po dokončení se stále validuje celý
JSON, povolené source IDs a Zod kontrakt. Klientské odpojení stream ukončí bez restartu modelu.

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
