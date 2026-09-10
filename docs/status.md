# Stav implementace

## Hotové a ověřené

- oddělené demo „Odposlechy“ s vlastní navigací, MP3 uploadem, volbou počtu mluvčích a režimu
  zpracování, živým progressem, historií, přepisem a přiřazením hlasů; osoby, hlasové reference,
  nahrávky i přepisy jsou v samostatných tabulkách bez vazby na podcastová data,
- SVG favicon s bílým mikrofonem na modrém gradientu, sdílená všemi stránkami webu,
- nasazení aktuálního webu a workeru na NAS (2026-09-07) prošlo včetně migrací, kontroly storage a
  audio-ML readiness; web i favicon vrací HTTP 200, SVG má správný MIME typ,
- ověření změn variant přepisů (2026-09-06): `deno task check` (102 unit testů), 18 integračních
  testů na izolovaném PostgreSQL včetně skutečného HTTP webu a migrace 024, 29 Python ML testů a
  `docker compose config --quiet`; prohlížeč nebyl dostupný, vizuální kontrola zatím neproběhla,
- varianty přepisů s vlastní diarizací, počtem hlasů a přiřazením osob; porovnání po časových
  úsecích, explicitní výběr před identifikací a indexací, zachování původní varianty i přiřazení,
- model a způsob zpracování v seznamu i detailu epizod, přegenerování jako další varianta; autopilot
  přeskakuje výsledky čekající na výběr a pokračuje další epizodou,
- ElevenLabs Scribe adaptér v TypeScriptu se streamovaným uploadem, Zod validací a uložením vlastní
  diarizace bez omezení na počet hlasů lokálního modelu; kontrakt ověřen testovacími odpověďmi,
- checkbox automatického stahování nových dílů v nastavení podcastu; RSS import zařazuje nově
  nalezené epizody transakčně a idempotentně pouze ke stažení, bez spuštění ML,
- počítadlo „ve frontě / běží“ ignoruje stav `downloaded`,
- strict Deno workspace, konfigurace, migrace a Compose konfigurace,
- idempotentní RSS parser/import včetně namespaces, HTML, fallback ID a bezpečné obnovy, která
  zachová epizody odstraněné z feedu; iTunes i standardní RSS logo se při refreshi aktualizuje,
- per-podcast denní RSS automatika plánuje nízkoprioritní idempotentní `IMPORT_FEED` nejvýše jednou
  za 24 hodin a advisory lock brání duplicitám mezi workery,
- PostgreSQL fronta se `SKIP LOCKED`, heartbeat, stale takeover a backoff,
- per-podcast autopilot po minutě atomicky zařazuje nejnovější nezpracovanou epizodu, pokud není
  aktivní jiná processing pipeline; hromadné předstažení jej neblokuje a chyby ponechává k ručnímu
  opakování,
- per-podcast hromadné předstažení všech dostupných chybějících audií používá nízkoprioritní
  idempotentní download joby, které po stažení nepokračují do ML; automatika na připravené epizody
  později naváže od normalizace,
- samostatné download a processing fronty sdílejí auditní tabulku, ale používají oddělené claim
  filtry a konfigurovatelné worker sloty; stránka úloh jejich příslušnost zobrazuje,
- cache skutečného využití storage po podcastu s rozpadem na audio, přepisy a ostatní soubory;
  worker ji obnovuje po každém episode jobu a UI zobrazuje rozpad v tooltipu,
- ručně spouštěné hlasové návrhy pro epizody bez přiřazených hlasů porovnávají clustery pouze s
  ověřenými referencemi stálých moderátorů stejného podcastu; návrhy vyžadují ruční potvrzení a
  seznam epizod upozorňuje na všechny nepotvrzené hlasy,
- ruční přiřazení hlasu nabízí existujícího i nového moderátora nebo hosta; existující osoby se
  vybírají filtrovacím dropdownem ovladatelným i z klávesnice, vytvoření osoby a zápis role
  účastníka proběhnou transakčně přímo z karty hlasu, zatímco ověřená karta se zmenší a lze ji znovu
  otevřít tlačítkem „Editovat“,
- globální osoby mají M:N vazbu na podcast s rolí host nebo moderátor; migrace odvodí vazby
  současných osob z účasti, hlasových clusterů a referencí a výběr hlasu i jednotlivé promluvy
  nabízí pouze osoby aktuálního podcastu,
- ruční vyloučení epizody s chybným nebo cizojazyčným přepisem z fulltextového i vektorového
  retrievalu, RAG zdrojů, autopilotu a workflow nepřiřazených hlasů; audio zůstává, zatímco chybný
  přepis, chunky, speaker data a odvozené embeddingy se odstraní,
- řízená souběžnost oddělených worker slotů a konfigurovatelný limit audio pipeline; Synology
  používá jeden processing a dva download sloty, pyannote fáze zůstávají serializované,
- streamovaný download se SHA-256 a atomickým rename,
- ffmpeg normalizace a ffprobe ověření,
- samostatný worker image s dostupnými `ffmpeg` a `ffprobe`,
- verzovaný ML kontrakt a transakční processing run; úplné opakování hotové epizody vytváří nový run
  nad existujícím WAV, původní výsledek zachová a retry váže na zdrojový job,
- overlap-aware diarizace používá běžný pyannote výstup pro detekci souběžné řeči a exclusive turns
  pro přiřazení; proporcionální slovní zarovnání umí změnit hlas uvnitř Whisper segmentu a čisté
  části bez překryvu se používají pro speaker embeddingy; hysteréze tlumí krátké diarizační
  mikroskoky a mezery se přiřazují nejbližšímu turnu místo pevného fallback hlasu,
- per-podcast volba mezi původním segmentovým, překryvovým a novým `overlap_asr_corrected`
  zpracováním; výchozí režim zůstává segmentový a jemné režimy ukládají zvlášť původní Whisper
  začátek pro přesné přehrávání a citace,
- kontextová ASR korekce jako izolovaný Deno post-processing pouze nového režimu: strukturované
  editace z existujícího OpenAI-kompatibilního provideru, kontext napříč mluvčími, bezpečné lokální
  ověření rozsahů, konfigurovatelný práh/souběžnost/časové okno, per-segment fallback a audit raw i
  korigovaného textu; job payload zachovává režim při retry a rozhraní počítá s budoucím suspicious
  region detektorem a audio validátorem,
- kratší chunking, BGE-M3 hybrid retrieval, multilingual reranking, volitelný práh relevance a
  tematický retrieval otázek oddělující hledaný pojem od filtru mluvčího, bezpečný `/api/ask`
  fallback,
- povinný podcastový kontext vyhledávání a volitelný filtr epizody; závislý filtrovací dropdown
  mluvčích ukazuje jen identifikované osoby, které mají promluvu ve vybraném podcastu nebo dílu,
- streamované Answer API a UI: živě ukazuje hledání zdrojů, volitelný reasoning, psaní odpovědi a
  dokončení citací; text přibývá po tokenech, finální JSON i source IDs se stále validují a odpověď
  seskupuje různé významové okruhy do sekcí s klikacím datem epizody a časem výroku; samostatné
  surové source karty se neopakují a stránka skrývá původní ne-AI vyhledávací formulář,
- výsledek zobrazuje vstupní, výstupní a celkový počet tokenů; u dvoufázové odpovědi se sčítá
  analýza i finální generování,
- per-utterance ruční oprava mluvčího s možností konkrétní osoby, neznámého mluvčího nebo návratu k
  hlasové kartě; override je chráněný před pozdějším hromadným přiřazením celé hlasové karty,
- hlasovou kartu lze pro danou epizodu ignorovat a později obnovit; ignorovaný hlas se nezapočítává
  mezi nevyřešené, automatika jej přeskočí a případná clusterová hlasová reference se zneplatní,
- automatický `IDENTIFY_SPEAKERS` krok před chunkingem rovnou přiřazuje jisté stálé moderátory;
  pokud potom zbývá právě jeden neznámý hlas, lokální model může z názvu a popisku při vysoké
  jistotě přiřadit explicitně uvedeného existujícího nebo nového hosta; konkrétní moderátory
  podcastu dostává jako vylučovací seznam a kontrola se neblokujícím jobem spouští i po ručním
  ověření moderátora,
- izolovaný ThinkingCap NVFP4 Answer server ve vLLM na DGX Spark a vypnutelný OpenAI-kompatibilní
  provider s validací citovaných zdrojů; nasazení nerestartuje `audio-ml`,
- per-dotazová volba mezi lokálním ThinkingCapem a `gpt-5.6-luna` přes OpenAI Chat Completions; Luna
  používá vlastní standardní parametry, streamování a stejnou validaci zdrojů a v UI je označeno, že
  vybrané přepisové úryvky odcházejí do OpenAI API,
- český idle eval ThinkingCap: krátký uzemněný JSON za 18,3 s a skutečný osmizdrojový portálový
  dotaz za 49,8 s při přibližně 8 tokenech/s; odpověď byla věrná citovanému úryvku,
- srovnávací DGX Spark benchmark llama.cpp a vLLM: při dvou současných dlouhých dotazech vLLM NVFP4
  zkrátil čas z 69,8 s na 53,3 s a zvýšil souhrnnou propustnost z 7,34 na 9,61 tokenu/s; reálný
  produkční no-think RAG dotaz po zahřátí vrátil validní citovaný JSON za 16,45 s,
- volitelný dvoufázový reasoning (interní úvaha a samostatný no-think JSON formatter) prošel proti
  produkčnímu vLLM za 76,1 s a vrátil správný výsledek s validním zdrojem,
- modro-bílé responzivní administrační UI, stavové štítky a zjednodušené filtrování epizod do skupin
  Nestáhnuto, Ve frontě, Zpracovává se, Hotovo a Chyba, stavově odlišené akce, osoby/účastníci,
  ruční identita a Range audio; podcastové karty zobrazují logo a odkazují z názvu, detail podcastu
  vede ozubeným tlačítkem na samostatné nastavení RSS, stahování, automatizace a diarizace; boolean
  automatiky používají toggle přepínače a statistiky backlogu jsou na stránce přímo viditelné,
  epizody zobrazují popis a opakování hotové epizody vyžaduje potvrzovací dialog; blok mluvčích
  odkazuje na další epizodu stejného podcastu s nepotvrzeným hlasem a odkaz skryje, pokud žádná
  nezbývá,
- hover tlačítek nemění jejich geometrii, takže hitbox zůstává stabilní i při najetí přes okraj,
- demo seed jasně označený jako syntetická data,
- vzdálené DGX Spark nasazení přes Ansible, Synology CIFS storage a bearer autentizace ML API,
- produkční PostgreSQL, web a worker na Synology DS1525+ spravované přes Ansible; databáze používá
  lokální NAS bind storage, podcasty přímý bind mount a PostgreSQL port není publikovaný,
- streamovaný Whisper progress ukládaný do jobs a živé jobs UI s vazbou na epizodu/podcast,
- viditelný panel automatizace se stavem backlogu a odhadem z aktivních dob posledních pěti epizod,
- per-job Whisper checkpointy po pětiminutových audio chunkech, lokální retry jednotlivého chunku,
  idle timeout obnovovaný progressem a kooperativní ukončení osiřelého audio výpočtu po odpojení
  workeru,
- živé jobs UI zobrazuje jen posledních 24 hodin, řadí nedokončené úlohy před dokončenými, chybnými
  a zrušenými a ukazuje kumulovanou aktivní dobu zpracování; databázový trigger vynechává čas ve
  frontě, retry prodlevy i čekání na volnou ML kapacitu a funguje bez restartu staršího workeru,
- selhání Audio ML automaticky spouští čerstvou CUDA/NVML, modelovou a storage diagnostiku; kritické
  nálezy vytvářejí slučované systémové incidenty s Pushover omezením na jednu zprávu za tři hodiny
  do potvrzení, webovou historií, potvrzením a přímým testem notifikace.

## Hotové, ale vyžaduje externí konfiguraci

- Scribe vyžaduje `ELEVENLABS_API_KEY`; placený přepis proti skutečnému účtu zatím nebyl ověřen,
- výchozí Whisper v konfiguraci je nově `Cem13/whisper-large-v3-czech`; ověřeny metadata a
  kompatibilní formát u vydavatele, nikoli stažení vah a inference nového modelu na Sparku; změny
  variant přepisů a migrace jsou nasazené na NASu, přepnutí modelu na Sparku zbývá,
- modely se při prvním nasazení jednorázově stáhnou do perzistentní cache Sparku,
- pyannote diarizace a speaker embeddingy vyžadují `HF_TOKEN` a přijetí podmínek modelů,
- semantic search vyžaduje načtený BGE-M3 embedding model a BGE multilingual reranker,
- GPU akcelerace vyžaduje NVIDIA runtime,
- odesílání provozních notifikací vyžaduje `PUSHOVER_APP_TOKEN` a `PUSHOVER_USER_KEY`; bez nich se
  incidenty ukládají a zobrazují, ale Pushover zprávy se neposílají.
- ASR korekce vyžaduje lokální `ANSWER_GENERATION_PROVIDER=openai-compatible` nebo `OPENAI_API_KEY`;
  bez provideru nový režim zachová raw přepis a uloží stav `provider_unavailable`.

## Částečně implementované

- auth boundary podporuje lokální bearer token, ne správu uživatelů,
- observabilita má strukturované logy a jobs UI s průběhem, ne Prometheus,
- produkce používá rychlé proporcionální slovní zarovnání; nativní Whisper word timestampy jsou
  dostupné experimentálně, ale jejich latence s `large-v3` zatím není provozně přijatelná.
- Transformers audio kontrakt zatím neexportuje Whisper word probability, `avg_logprob` ani
  no-speech probability; korekce funguje bez nich a selektivní suspicious-region detektor zatím není
  implementovaný.

## Neimplementované

- automatické spouštění hlasových návrhů bez ruční akce, širší eval prahů a detekce oslovení,
- claims extrakce/review a časová osa,
- auditované HTTP mazání osoby/epizody a fyzický cleanup storage,
- úplný browser E2E test.

## Známé problémy

- český fulltext používá konfiguraci `simple`,
- reasoning je záměrně vypnutý pro běžné RAG dotazy; experimentální režim je konfigurovatelný přes
  effort, samostatný limit reasoning tokenů a vyšší celkový výstupní limit, ale před trvalým
  zapnutím vyžaduje širší eval kvality a latence,
- plné ML závislosti a modely nebyly lokálně staženy; podporovaná a doporučená cesta je Python 3.11
  kontejner,
- celé modelové testy jsou záměrně oddělené od rychlých unit testů.

## Spuštěné kontroly a výsledky

- vyhledávací schéma unit testem vynucuje podcast a přijímá volitelnou epizodu; databázový
  integrační test ověřuje omezení výsledků i závislé volby epizod a mluvčích,
- lokální HTTP smoke ověřil oba formuláře, 400 bez povinného podcastu a 200 s podcastem a epizodou;
  živý podcastový filtr nabídl 70 epizod a 21 mluvčích a konkrétní epizoda seznam zúžila na 3,
- RAG exclusion je pokryté unit testem ovládání a databázovým integračním testem, který nejprve
  dohledá kontrolní chunk a po vyloučení ověří odstranění přepisu, speaker dat, processing runu,
  chunků i transcriptového souboru,
- schéma čtyř režimů přiřazení hlasu pokrývá unit test; databázový integrační test prošel lokálně a
  ověřil existujícího i nového moderátora nebo hosta, poznámku, přepis utterances a uložení role
  účastníka,
- migrační cutover na Synology prošel: custom-format dump byl ověřen kontrolním součtem a obnoven do
  PostgreSQL 17 + pgvector; přesné počty odpovídají zdroji (564 epizod, 236 speaker clusterů, 128
  974 promluv a 4 708 chunků),
- `synology:deploy` prošel včetně migrací, spuštění webu/workeru, zápisu do `/volume1/Podcasts` a
  readiness audio-ML; `synology:status` hlásí zdravý PostgreSQL a web a běžící worker,
- HTTP smoke z Macu vrátil 200 pro domovskou stránku i detail skutečné epizody a ověřil produkční
  vykreslení tlačítka „Další díl“,
- migrátor ignoruje macOS AppleDouble `._*.sql` metadata a archivace je nevytváří; regresní unit
  test tuto podmínku pokrývá,

- `deno task check`: prošel (`fmt --check`, lint, typecheck, 97 unit testů; šestnáct integračních
  testů bylo v tomto běhu očekávaně ignorováno),
- `RUN_INTEGRATION_TESTS=1 deno task test:integration`: 16/16 prošlo nad lokální PostgreSQL; nové
  testy ověřily snapshot `overlap_asr_corrected` v job payloadu po pozdější změně podcastu i uložení
  raw/korigovaného textu, auditu, speaker labelu a všech časů,
- migrace `022_asr_transcript_correction.sql` byla aplikována nad lokální PostgreSQL; přidala nový
  režim a nullable auditní sloupce bez reinterpretace existujících runů,
- cílené integrační testy front prošly 3/3 nad PostgreSQL: oddělené claimování download/processing,
  neblokující prefetch pro autopilot a idempotentní hromadné předstažení,
- produkční worker log potvrdil dva současně aktivní download sloty a samostatný processing slot;
  web i API označují frontu a hromadné předstažení po graceful restartu pokračuje,
- integrační test hromadného předstažení prošel 1/1 nad PostgreSQL; ověřil výběr pouze dostupných
  chybějících audií, nízkou prioritu, idempotenci, download-only payload a vynechání epizod mimo RSS
  nebo vyloučených z RAG,
- produkční HTTP smoke ověřil tři hlasové formuláře na skutečné epizodě, všechny tři režimy, právě
  jednu aktivní sadu polí v každém formuláři a načtení verzovaných CSS/JS souborů; web i PostgreSQL
  jsou healthy,
- navigační SQL pro další epizodu s nepotvrzeným hlasem prošlo read-only kontrolou nad lokální
  PostgreSQL a podmíněné vykreslení odkazu pokrývá unit test,
- nový pgvector integrační test hlasového matchingu prošel 1/1 nad lokální PostgreSQL; ověřil, že
  shoda zůstane pouze návrhem a čerpá z reference stejného podcastu,
- samostatný integrační test RSS refresh prošel 1/1 a ověřil také přepsání změněného loga podcastu,
- integrační test aktivního času prošel 1/1 a ověřil vynechání hodinového čekání ve frontě i
  pozastavení čítače ve fázi `waiting_for_slot`,
- migrace `001_initial.sql` až `011_episode_rag_exclusion.sql`: prošly na PostgreSQL 17 + pgvector,
- Python lightweight unit suite: 18/18 prošlo na Pythonu 3.13 bez modelových downloadů,
- `python3 -m compileall`: prošel,
- `docker compose config --quiet`: prošel pro CPU i GPU override,
- HTTP smoke: web nastartoval a fulltext `/api/search` našel demo chunk včetně epizody, osob a
  timestampu,
- endpoint statistik automatizace odpověděl nad skutečnými daty za 17 ms; Insider použil pět
  historických epizod s aktuálním průměrem přibližně 63 minut aktivní práce na epizodu,
- původní CTranslate2 backend byl na DGX Spark ARM64 diagnostikován jako CPU-only, přestože PyTorch
  CUDA funguje; přepis je proto implementovaný přes Transformers/PyTorch,
- Ansible deploy na ARM64 DGX Spark prošel; kontejner je healthy, API z lokálního workeru vrací
  `gpuAvailable=true` a Synology mount je z DGX read-only a z workeru read/write,
- anonymní ML readiness vrací 401 a request s worker tokenem 200,
- Whisper `openai/whisper-large-v3`, pyannote 4 `speaker-diarization-community-1` a veřejný 256D
  WeSpeaker model se při startu úspěšně načtou na GPU,
- BGE-M3 a BGE reranker v2 M3 se přes Ansible nasadily a načetly na GPU; kontrolní reranking dal
  přímé shodě 0,951 a nesouvisející větě 0,000016,
- osm existujících epizod bylo bez opakování přepisu přeindexováno na kratší chunky a 1024D
  embeddingy; dotaz `citace miloš zeman` ve vyváženém režimu vrací jediný přímý citovaný úryvek,
- 30sekundový český end-to-end průchod na skutečném podcastovém audiu prošel: přepis, dva mluvčí, 14
  promluv a 256D hlasové embeddingy; původní epizoda byla znovu zařazena ke zpracování.
- produkční A/B na 2 h 27 min epizodě `středo/věk/53` dokončil nový run včetně identifikace hlasů a
  indexace; proti původnímu runu klesl počet přepnutí 761 → 721, promluv pod dvě sekundy 1 676 →
  548, A–B–A mikroskoků 64 → 45 a promluv s jistotou pod 0,6 z 340 → 149, zatímco průměrná jistota
  vzrostla z 0,895 na 0,910,
- migrace `020_podcast_transcript_alignment.sql` a ML schema v3 byly nasazeny na Synology a DGX
  Spark; pouze `středo/věk` má režim `overlap`, ostatní podcasty zůstaly v `segment`. Kontrolní nový
  run dílu 53 dokončil 2 171 promluv, 169 chunků a embeddingy bez chyby; produkční HTML u pozdní
  pasáže zobrazilo a použilo původní seek 8272,9 s místo jemného odhadu 8276,838 s,
- benchmark dvou 60sekundových ukázek potvrdil dvě aktivní audio pipeline, ale zrychlil souhrnný čas
  jen z 71,45 s na 69,60 s (1,03×) a latenci každé inference téměř zdvojnásobil; produkční audio
  limit proto zůstává jedna, zatímco dva worker sloty paralelizují ostatní kroky,
- `git diff` nebylo možné použít: předaný prázdný adresář nebyl Git repozitář; finální inventář
  obsahuje pouze zdrojové, konfigurační, testovací a dokumentační soubory uvedené v projektu.

## Přesný postup lokálního spuštění

```bash
cp .env.example .env
docker compose up -d postgres audio-ml
deno task db:migrate
deno task db:seed
deno task dev:web
# v druhém terminálu
deno task dev:worker
```

Otevřete `http://localhost:8000`.
