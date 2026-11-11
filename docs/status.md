# Stav implementace

## Modelové plánování otázek nasazené 2026-11-10

Web `podcast-web:planner-20261110` používá pro otázky nad zdroji validovaný plán od zvoleného
modelu. Operátory `any` a `all` určují povinné shody v úryvku, `prefer` upravuje pořadí a `coverage`
výběr napříč větvemi. Obě varianty API (JSON i stream) používají stejný výběr zdrojů. Při
nedostupném nebo neplatném plánu se použije původní hledání.

Na NAS původní otázka „Jak hodnotí americké kandidáty na prezidenta, kamalu harris a donalda
trumpa?“ s filtry Insider a Michal Půr dříve vrátila 0 úryvků. Ve třech měřeních s ThinkingCap
zvolil model obě jména jako `any` s `each_branch`. Výběr vrátil 16 úryvků, z toho deset se zmínkou o
Trumpovi a osm o Harrisové. Samostatná kontrola `all` našla čtyři úryvky obsahující oba kandidáty.
Plánování včetně validace trvalo 6,644 / 6,632 / 6,528 s (medián 6,632 s), bez navazujícího hledání
a generování odpovědi.

`deno task check` prošel se 124 unit testy. Při přepnutí pouze webu zůstaly stejné kontejnery a časy
startu workeru a PostgreSQL. Rozpracovaný ML job `2ba8c352-590e-4947-9aeb-600a2e629823` pokračoval
na prvním pokusu. Zálohy zdrojů a provozní výpisy jsou v
`/volume1/docker/podcast-tool/planner-20261110`.

Produkční `/api/ask` potvrdilo plán za 6,547 s a vrátilo všech 16 podkladů přiřazených pouze Michalu
Půrovi. Finální generování ThinkingCap při této kontrole vrátilo v jedné sekci více než tři citace.
Validátor proto odmítl výslednou odpověď a API vrátilo zdrojové úryvky s varováním.

## Obecné hledání osob nasazené 2026-10-30

- V 22:24 CET byla původní výjimka pro Trumpa a Harrisovou nahrazena obecným plánováním dvouslovných
  osobních jmen. Nasazeny byly pouze `packages/search/query.ts`, `search.ts` a nový `names.ts`,
  image `podcast-web:general-search-20261030` (`1fae36a654af`, produkční tag `podcast-web:managed`).
  Ostatní rozpracované změny nebyly součástí nasazení.
- Jména rozpoznává lexikon křestních jmen rozšířený z katalogu osob. Celá jména mají přednost;
  příjmení a běžné české pády se přidávají až po doložení identity v aktivních přepisech. Při více
  rozpoznaných osobách se stejným příjmením je nutný rozlišující kontext v dílu nebo celé jméno ve
  vybraném výroku. Pravidla fungují i bez srovnání a zachovávají všechny filtry. Neznámá a složená
  jména se konzervativně nerozšiřují; nejde o úplné rozpoznávání entit a přesnost stále závisí na
  přepisu a lexikonu.
- Indexový předvýběr používá existující `normalized_search_vector` před agregací výroků mluvčího.
  Nevznikla migrace, reindexace ani další modelové volání. `deno task check` prošel se 123 unit
  testy a všechny čtyři integrační testy vyhledávání prošly v izolovaném PostgreSQL. Regrese pokrývá
  Fialu/Babiše, dvě osoby jménem Novák, pořadí celých jmen, výrok jiného mluvčího, obecná témata,
  filtry i neaktivní/vyloučený kontext identity.
- Finální benchmark na produkčním archivu: pět dotazů, tři opakování každé verze, střídání pořadí
  stará/nová verze, sériové read-only dotazy s jedním připojením. Filtry Insider a Michal Půr, limit
  16, stejné podmínky pro obě verze; každé měření vrátilo 16 podkladů. Časy měří pouze dohledání
  zdrojů bez generování odpovědi. Jde o měření na běžícím NAS, nikoli garantovanou latenci při
  libovolné zátěži.

| Dotaz                         | Původní medián | Nový medián |
| ----------------------------- | -------------: | ----------: |
| Donald Trump vs Kamala Harris |       14,102 s |     4,474 s |
| Petr Fiala vs Andrej Babiš    |       14,779 s |     6,238 s |
| Petr Pavel vs Miloš Zeman     |       14,048 s |     4,869 s |
| Petr Fiala                    |        7,192 s |     2,772 s |
| Deník N                       |        6,942 s |     0,603 s |

- Ověřena shoda SHA-256 všech tří souborů, zdravý web a HTTP `/health`. ID i časy startu workeru a
  PostgreSQL jsou před a po nasazení totožné. ML job `4d8b5067-a6b6-4da2-bc38-d2f55bd12450` zůstal
  běžet na prvním pokusu; heartbeat během nasazení postoupil z 22:24:25 na 22:24:54 CET.
- Po nasazení prošly živé dotazy Trump/Harris, Fiala/Babiš, Fico/Orbán a Macron/Scholz s filtry
  Insider a Michal Půr (každý 16 podkladů). V Briefingu #59 (`02c6f695-5b72-4e4a-b5dc-815cc988d497`)
  dotaz „Petr Fiala“ vrátil tři úryvky včetně výroku s pouhým „Fiala“, bez křestního jména. Ověřován
  byl výběr podkladů a jejich přiřazení mluvčímu, bez volání generativního modelu.
- Staging, zálohy zdrojů, časy benchmarku a kontrolní výpisy jsou na NAS v
  `/volume1/docker/podcast-tool/general-search-20261030`. Původní web je zachovaný jako
  `podcast-web:before-general-search-20261030`. Dočasná testovací databáze i benchmarkový kontejner
  byly odstraněny.

## Srovnávací vyhledávání nasazené 2026-10-30

Tuto první verzi v 22:24 CET nahradilo obecné řešení popsané výše.

- V 22:06 CET byla nasazena oprava pouze dvou modulů `packages/search/query.ts` a
  `packages/search/search.ts` do webu (`podcast-web:comparison-20261030`, produkční tag
  `podcast-web:managed`, image `dd4b8c989093`). Ostatní rozpracované změny nebyly zahrnuté.
- Otázky se dvěma tématy oddělenými „vs“, „versus“ nebo „proti“ získávají podklady pro každou stranu
  samostatně. Celá jména Donald Trump a Kamala Harris se při tomto hledání převádějí na příjmení s
  prefixovým hledáním českých pádů. Výsledky se střídají a zbavují duplicit; obě strany zachovávají
  původní filtry a hledají pouze ve výrocích vybraného mluvčího.
- Produkční read-only ověření stejné cesty výběru zdrojů jako `/api/ask` pro dotaz „názor na donald
  trump vs kamala harris“, podcast Insider a mluvčího Michala Půra vrátilo 16 úryvků ze 16 epizod
  místo původních nula. Jedenáct úryvků obsahuje Trumpa, osm Harrisovou (některé obsahují oba).
  Generování odpovědi modelem nebylo součástí této kontroly.
- `deno task check` prošel se 121 unit testy. V izolovaném dočasném PostgreSQL na NAS prošly všechny
  tři integrační testy vyhledávání včetně samostatných příjmení, vyvážení při limitu dvou výsledků,
  filtrů osoby/podcastu/epizody/data, RAG exclusion a neaktivního přepisu. Testovací databáze byla
  odstraněna; produkční data se při testech neměnila.
- Ověřena shoda SHA-256 obou nasazených modulů se stagingem, zdravý web a HTTP `/health`. ID i časy
  startu workeru a PostgreSQL zůstaly stejné. Reindexace není potřeba. Původní image je zachovaný
  jako `podcast-web:before-comparison-20261030`; staging a zálohy zdrojů jsou v
  `/volume1/docker/podcast-tool/comparison-search-20261030`.

## Dokončené nasazení konfigurace PostgreSQL 2026-10-30

- V 19:55 CET bylo dokončeno autorizované nasazení `init: true`, přímého `CMD` healthchecku a
  timeoutů 10/15 s. Nasazený Compose se od původní verze liší pouze těmito třemi změnami; databázový
  image zůstává `sha256:17a06c0a60bf6fb548a8493b8f6057dc830b791bbbe1f1ab706ca4b9d97c8180`.
  `deno task check` (120 unit testů), lokální i produkční Compose validace prošly.
- V 17:35:02 CET worker přijal SIGTERM pro bezpečné dokončení aktuální úlohy. ML job
  `25c03206-52f6-4b27-9c93-17222dee50be` (Insider #98 – Petr Holec a Petr Honzejk) doběhl bez
  přerušení na prvním pokusu v 19:53 CET. Worker i původní PostgreSQL skončily korektně s exit 0,
  bez násilného timeoutu.
- Jednorázový skript `/volume1/docker/podcast-tool/pg-healthcheck-20261030/deploy-after-drain.sh` po
  dokončení jobu vytvořil custom-format dump
  `/volume1/docker/podcast-tool/backups/pre-pg-healthcheck-20261030.dump` (378 433 440 B), ověřil
  katalog pomocí `pg_restore --list` a uložil SHA-256 do `backup.sha256`. Databázi korektně ukončil
  přes SIGINT a přepnul konfiguraci. Marker `SUCCESS` je z 19:55:43 CET; průběh je uložený v
  `deploy.log` a původní Compose v `compose.original.yml`.
- Následná read-only kontrola potvrdila `HostConfig.Init=true`, PID 1 `docker-init`, přesný
  `CMD pg_isready -U podcast -d podcast -t 10`, Docker timeout 15 s a zdravý PostgreSQL. Image,
  datové mounty a system identifier `7678052124980187180` zůstaly stejné. Nový databázový kontejner
  je `c90ff265ef26`; worker `0bdc4b3bc877` byl obnoven v 19:55:34 CET. Navazující identifikace
  mluvčích, chunky i embeddingy Insideru #98 se dokončily na prvním pokusu do 19:56:01 CET. Web
  nebyl restartovaný, zůstává zdravý a HTTP health vrací `ok`. Dočasný dohled je po ověření
  dokončení ukončený.
- V 17:31:30 CET nový worker zaznamenal `CONNECT_TIMEOUT` při claimování download slotu, naplánoval
  retry za 2 s a zůstal běžet; aktivní ML úloha nebyla přerušena. To je také živý doklad fungování
  již nasazené opravy odolnosti workeru.

## Dokončené nasazení workeru 2026-10-30

- Oprava odolnosti workeru běží od 15:41 CET jako `podcast-worker:resilience-20261030`
  (`4906ed998430`, produkční tag `podcast-worker:managed`). Obsahuje pouze opravu smyčky v
  produkčním `main.ts` a nový `services/worker-loop.ts`; jiné lokální změny nebyly zahrnuté. Původní
  image je zachovaný jako `podcast-worker:before-resilience-20261030`.
- V 11:42:55 CET worker přijal SIGTERM a zastavil nové claimy. ML job
  `65b73bd7-d27a-48fa-b0d8-41c6dde08662` (Insider #99 – Pražský speciál) doběhl bez přerušení na
  prvním pokusu; původní worker skončil s exit 0. Jednorázový skript na NAS v
  `/volume1/docker/podcast-tool/worker-resilience-20261030/deploy-after-drain.sh` vyměnil pouze
  worker a vytvořil `SUCCESS` v 15:41:31 CET. Při kontrole v 15:47 CET odpovídaly image ID i SHA-256
  obou souborů stagingu, nový kontejner `0bdc4b3bc877` měl 0 restartů. Navazující identifikace
  mluvčích, chunky i embeddingy Insideru #99 jsou dokončené na prvním pokusu. Worker dokončil také
  tři RSS importy a pokračuje normalizací Insideru #98 s čerstvým heartbeatem. Web i PostgreSQL
  zůstaly zdravé a nebyly restartované; HTTP health vrací `ok`.
- Ověření: `deno task check` (120 unit testů), integrační test obnovy po skutečném přerušení spojení
  na izolovaném lokálním PostgreSQL, typecheck výsledného produkčního image a Compose validace
  prošly. Lokální testovací databáze byla zastavena.
- Noční incident: 30. 10. v 02:53:33, 02:54:17 a 02:54:49 CET PostgreSQL hlásil proces s exit 2 a
  obnovil cluster. Worker skončil na `CONNECTION_CLOSED`, Docker jej obnovil v 02:56:59 CET. Insider
  #101 a předchozí #102 jsou `ready`. OOM čítač je 0, kernelové I/O chyby nebyly nalezené, RAID1 je
  `[UU]` a volume má přibližně 8 TB volných.
- Silná hypotéza příčiny: osiřelý `pg_isready` z `CMD-SHELL` healthchecku se při timeoutu shellu
  stane potomkem PostgreSQL běžícího jako PID 1; jeho exit 2 spustí obnovu clusteru. Izolovaná
  reprodukce na stejném NAS a image PostgreSQL 17.11 pomocí osiřelého testovacího procesu s exit 2
  vyvolala přesně stejnou hlášku a obnovu. Kontrolní kontejner s `--init` se neobnovoval. Oba
  testovací kontejnery bez produkčních dat byly odstraněny. Toto potvrzuje mechanismus, nikoli
  identitu konkrétních nočních PID, pro které už chybí záznam healthchecku.
- `init: true`, healthcheck bez shellu a klientský timeout 10 s pod Docker timeoutem 15 s jsou
  nasazené od 2026-10-30 v 19:55 CET; viz dokončené nasazení konfigurace PostgreSQL výše.

## Hotové a ověřené

- oprava převodu otázek na fulltext (2026-10-29, nasazeno v 17:31 CET): přesný dotaz ze snímku „Jak
  hodnotí deník n“ s filtrem Michal Půr vracel nulu, protože `hodnoti:*` zůstával povinným termínem.
  Totéž postihovalo ukázkovou otázku ve formuláři. Normalizace nyní odděluje běžné formulace
  hodnocení/názoru i závěrečnou otázku na vývoj názoru v čase; původní otázku model stále dostává
  celou. V produkci všechny čtyři kontrolní formulace vracejí 16 úryvků ze 13 epizod. Prošlo
  `deno task check` (120 unit testů) a dva databázové integrační testy přesné produkční verze,
  včetně JSON a streamovaného HTTP API pro všechny čtyři otázky. Nasazen pouze
  `packages/search/query.ts` po ověření 85 původních hashů a záloze modulu i webového image.
  Produkční build, typecheck, health a kontrola nových hashů prošly; worker nebyl restartovaný a
  automatické zpracování Insideru zůstalo zapnuté. Bez migrace či reindexace. Marker je
  `.query-framing-20261029`, potvrzení v `/tmp/podcast-query-20261029`. Po výslovném souhlasu
  uživatele s odesláním vybraných úryvků do OpenAI API prošel také celý produkční streamovaný dotaz
  „Jak hodnotí deník n“ s GPT-6.1 Sol: za 32,0 s vrátil odpověď v šesti tematických sekcích nad 16
  úryvky ze 13 epizod, bez chyb a varování. Výsledek je v `answer-verification.json`,
- společné nasazení na NAS dokončeno 2026-10-29 v 00:00 UTC (01:00 CET): po transakčním vypnutí
  automatického zpracování doběhla původní ML úloha `1176d6a9-2b07-48cf-973b-802b3a003276` v
  23:56:54 UTC a worker se korektně ukončil. Nasazeno přesně 15 připravených souborů pro přeskočení
  dílů, AJAX úpravy mluvčích, opravu analýzy a tři nové modely OpenAI, včetně migrace 026; demo
  Odposlechy a jiná rozpracovaná změna workeru nebyly zahrnuty. Před nasazením ověřeno 81 původních
  hashů a původní images; uložena záloha 11 souborů, images a databáze
  `backups/before-review-20261028.dump` ověřená přes `pg_restore --list`. Prošly formát, lint,
  typecheck, 113 unit a 21 integračních testů přesného balíčku na izolovaném PostgreSQL. Produkční
  build, typecheck a dopředná migrace prošly; opakovaná kontrola potvrdila všech 15 hashů v běžícím
  webu i workeru, zdraví webu a PostgreSQL, nové ovládání/API, modely, storage a audio-ML readiness.
  Kontrolní dotaz k Deníku N s Michalem Půrem vrací 16 úryvků ze 13 epizod. Worker je spuštěný a
  automatické zpracování Insideru znovu zapnuté; u ostatních podcastů zůstalo vypnuté, stahování a
  RSS zachovaly původní nastavení. Navazující identifikace hlasů, chunky a embeddingy původní
  epizody už skutečně dokončily zpracování (nejde jen o vložení do fronty). Potvrzení jsou v
  `/tmp/podcast-review-20261028`, původní nastavení na NAS v
  `backups/review-settings-20261028.json`, marker úspěchu `.review-analysis-models-20261028`.
  Jednorázová automatizace byla po ověření odstraněna,
- další modely OpenAI v analýze (2026-10-28, nasazené 2026-10-29): GPT-6.1 Sol (`gpt-6.1-sol`),
  GPT-6 Sol (`gpt-6-sol`) a GPT-6 Luna (`gpt-6-luna`) vedle stávajících voleb. Společný katalog řídí
  nabídku i validaci API, všechny používají existující `OPENAI_API_KEY`; bez klíče jsou nedostupné.
  Nové volby posílají přesné API ID, původní volba zachovává `OPENAI_ANSWER_MODEL`. GPT-6.1 Sol
  používá alespoň reasoning `low` i ve finálním volání, protože nepodporuje `none`. Názvy a
  parametry ověřeny v OpenAI Docs, metadata všech tří modelů vrátila přes existující klíč HTTP 200.
  Placené generování na nových modelech nebylo při této změně spouštěno. Prošlo `deno task check`
  (118 unit testů) a 22 integračních testů; pokryto směrování modelů, JSON i streamování, reasoning
  a nabídka/API bez klíče. Změna nevyžaduje migraci,
- diagnostika analýzy „Co říká o deníku N“ s filtrem Michal Půr (2026-10-28): produkční vyhledávání
  vracelo osm úryvků z Briefingu #92. ASR smyčka opakovala stejnou poškozenou větu, tím zvýšila
  fulltextové skóre a zaplnila všech osm míst. Další zmínky zůstaly v databázi a indexu. Produkční
  ThinkingCap při kontrolním volání skutečně obrátil původce a cíl tvrzení o zničení; další chyba
  prefixového `n:*` připouštěla i pasáže o jiných denících,
- oprava výběru podkladů (2026-10-28, nasazená 2026-10-29): přesné krátké termíny, deduplikace a
  vyvážení epizod před limitem kandidátů, omezení vlivu četnosti stejného termínu, vynechání
  dlouhých ASR smyček a překryvů. Analýza vybírá nejvýše 16 úryvků, obvykle nejvýše dva z jedné
  epizody, a počet označuje jako vybrané podklady. Čtecí ověření nové verze nad produkčními daty
  vrátilo nejprve 16 úryvků ze 14 epizod; po vynechání i krátkých fragmentů uvnitř ASR smyčky
  finální výběr obsahuje 16 úryvků ze 13 epizod. Databáze a původní přepisy se neměnily; reindexace
  není potřeba. Regresní test pokrývá 70 opakujících se úryvků, filtr mluvčího, data, neaktivní
  verze, RAG exclusion a běžné i streamované HTTP API,
- lokální analýza ThinkingCap (2026-10-28, nasazená 2026-10-29): po výslovné volbě uživatele vrací
  tematicky uspořádané doslovné citace místo volných parafrází. Každá musí být souvislým úsekem
  daného zdroje; povolené je pouze sjednocení bílých znaků. Změněné nebo spojené fragmenty a neznámé
  source IDs jsou odmítnuty před zobrazením, duplicitní citace vynechány, každá má vlastní odkaz na
  díl a čas. Úvod je pevný, bez tvrzení vygenerovaných modelem. Kontrolní generování na skutečném
  ThinkingCapu nad produkčními zdroji prošlo za 140,5 s: pět témat, všechny citace doslovně ověřeny.
  Přehrání tohoto zaznamenaného výstupu finálním validátorem (včetně hranic slov a deduplikace)
  ponechalo osm různých citací ze sedmi epizod v pěti tématech. Kontrola parafrází stejným modelem
  se v experimentech neosvědčila a není součástí lokálního režimu. Změny nemění přepis ani
  nepotvrzují jeho správnost vůči audiu. Prošlo `deno task check` (115 unit testů) a 22 integračních
  testů na izolovaném PostgreSQL, včetně obou HTTP cest s testovacím generátorem citací. Produkční
  web se během diagnostiky neměnil a zpracování podcastů nebylo přerušeno,
- přeskočení celého dílu při přiřazování hlasů (2026-10-27): vratné tlačítko „Přeskočit díl“, štítek
  a filtr „Přeskočený“, vynechání z navigace „Další díl“ i počtu „k doladění“; příznak
  `speaker_review_skipped` zachovává přepis, přiřazení a původní stav zpracování. Změna včetně
  dopředné migrace `026_episode_speaker_review_skip.sql` je nasazená od 2026-10-29,
- úprava mluvčího segmentu (2026-10-27): hledání jmen bez diakritiky, podle více částí jména v
  libovolném pořadí a s ovládáním klávesnicí; uložení přes JSON API aktualizuje jen daný segment,
  zachovává přehrávání audia a při chybě ponechá editor otevřený pro opakování. Prošlo
  `deno task check` (110 unit testů), 21 integračních testů na izolovaném PostgreSQL a
  `docker compose config --quiet`. V prohlížeči ověřeno uložení za běžícího audia, hledání,
  neúspěšné uložení a opakování, přeskočení a filtr. Změna je nasazená od 2026-10-29,
- worker přežije výpadek databáze při claimování i při ukládání výsledku/chyby; retry každého slotu
  používá omezenou exponenciální prodlevu a nový databázový claim, takže neopakuje handler mimo
  zámek úlohy; pět regresních unit testů pokrývá obnovu, neúspěšné uložení výsledku i chyby, reset a
  strop prodlevy, ukončení při čekání a nezávislost souběžných slotů; integrační test ověřuje obnovu
  po skutečném přerušení testovacího PostgreSQL spojení; oprava z 2026-10-21 je nasazená od
  2026-10-30 v 15:41 CET,
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
  úsecích, automatický výběr prvního přepisu s navazujícím přiřazením moderátorů a indexací;
  explicitní výběr až při dalších variantách, zachování původní varianty i přiřazení,
- ověření automatického výběru prvního přepisu (2026-10-26): `deno task check` (108 unit testů) a 19
  integračních testů na izolovaném PostgreSQL prošlo, včetně souběžného opakování uložení prvního
  přepisu a ručního výběru dalších variant; změna je nasazená společně s opravou odhadu zpracování,
- jednorázové doplnění existujících epizod na NASu (2026-10-26): po ověřené záloze databáze byl
  vybrán jediný dokončený přepis u 258 epizod Insideru. Do fronty bylo transakčně vloženo 346 úloh
  identifikace mluvčích (322 Insider, 21 středo/věk, 3 Vojta Žižka); 88 z nich doplňuje neznámé
  mluvčí již vybraných přepisů bez opakované indexace. Stav všech 346 epizod a úloh byl přečtením
  ověřen. Druhý průchod po nasazení vybral také právě dokončenou epizodu Insideru a přidal jednu
  identifikaci: celkem 259 nově vybraných přepisů a 347 úloh (323 Insider, 21 středo/věk, 3 Vojta
  Žižka). Kontrola v 09:17 UTC zjistila 6 dokončených identifikací, 1 běžící a 340 čekajících, žádný
  nesoulad vybraných přepisů. Zdroj úloh je `single_transcript_backfill_20261026`, opakování pro
  stejný přepis je chráněné proti duplicitám,
- oprava odhadu zpracování (2026-10-26) je nasazená společně s výběrem přepisu: dokončené přepisy se
  počítají jako zpracované, výběr varianty a nevyřešené hlasy jako samostatné „k doladění“. Odhad
  používá posledních pět dokončených přepisů do fáze ML včetně korekcí; vyloučené epizody,
  identifikace a indexace backlog nezvyšují. Panel se obnovuje po 30 sekundách. Čtecí ověření nad
  produkčními daty snížilo backlog Insideru z 342 na 84 epizod, středo/věk z 1 na 0; předchozí počty
  zahrnovaly hotové přepisy čekající na další kroky. Prošlo `deno task check` (109 unit testů) a 20
  integračních testů na izolovaném PostgreSQL včetně HTTP API,
- nasazení obou oprav na NAS (2026-10-26, 09:17 UTC) proběhlo po dokončení původního ML jobu a
  korektním ukončení workeru. Nasazeno pouze sedm připravených souborů po ověření původních hashů a
  záloze zdrojů i images, bez migrace. Build a typecheck přesných produkčních zdrojů prošly, web a
  PostgreSQL jsou healthy, audio-ML readiness i zápis do storage fungují. Všech sedm hashů odpovídá
  připravené verzi v běžícím webu i workeru. HTTP kontrola přehledu všech tří podcastů prošla;
  Insider má v kontrolním snímku 457 zpracovaných, 83 zbývajících a 318 k doladění, středo/věk 53
  zpracovaných, 0 zbývajících a 22 k doladění. Worker znovu zpracovává frontu, nastavení automatiky
  v databázi zůstalo stejné a jednorázová kontrola nasazení je pozastavená. Marker úspěchu je
  `/volume1/docker/podcast-tool/.transcript-selection-20261026`,
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

- oprava odolnosti workeru (2026-10-21): `deno task check` (107 unit testů), nový integrační test
  proti izolovanému lokálnímu PostgreSQL a `docker compose config --quiet` prošly; produkční pád
  následoval po obnově PostgreSQL ve 14:53 CEST a neošetřené chybě `CONNECTION_CLOSED` ve 14:54; NAS
  měl `oom_kill=0`, příčina prvního ukončení databázového procesu (exit 2) nebyla v dostupných
  záznamech uvedená; Docker worker sám restartoval ve 14:55, během diagnostiky nebyl spuštěn ani
  nasazen,
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
