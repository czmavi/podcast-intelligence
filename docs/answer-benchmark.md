# Benchmark Answer modelu na DGX Spark

Měření z 22. srpna 2026 proběhlo při nulové zátěži `audio-ml`. Produkční Answer server ani audio
pipeline nebyly během testu restartovány. Dočasné benchmark kontejnery byly po měření odstraněny;
stažená vLLM modelová cache zůstala zachovaná.

## Konfigurace

- llama.cpp `server-cuda13-b10236`, ThinkingCap Q4_K_M GGUF, kontext 16 384 tokenů na slot,
- vLLM 0.27.1 ARM64, ThinkingCap NVFP4, FlashInfer, FP8 KV cache, maximálně dvě sekvence,
  `gpu-memory-utilization=0.30`, bez MTP speculative decoding,
- syntetický RAG prompt: 7 953 tokenů a vynucených 256 výstupních tokenů,
- při párovém měření měl jeden požadavek zahřátý prefix a druhý nový prompt; stejný postup byl
  použit pro obě inference implementace.

## Výsledky

| Server                | Souběh |          TTFT | Celkový čas | Souhrnná end-to-end propustnost |
| --------------------- | -----: | ------------: | ----------: | ------------------------------: |
| llama.cpp, 1 slot     |      1 |        31,7 s |      63,8 s |                   4,01 tokenu/s |
| llama.cpp, 1 slot     |      2 | 31,5 / 64,7 s |      96,8 s |                   5,29 tokenu/s |
| llama.cpp, 2 sloty    |      1 |        31,3 s |      65,1 s |                   3,93 tokenu/s |
| llama.cpp, 2 sloty    |      2 |  0,4 / 32,8 s |      69,8 s |                   7,34 tokenu/s |
| vLLM, max. 2 sekvence |      1 |        22,2 s |      52,0 s |                   4,90 tokenu/s |
| vLLM, max. 2 sekvence |      2 | 15,5 / 21,6 s |      53,3 s |                   9,61 tokenu/s |

Proti dvouslotovému llama.cpp zkrátil vLLM čas dvojice dotazů přibližně o 24 % a zvýšil souhrnnou
propustnost přibližně o 31 %. Dva současné vLLM dotazy skončily prakticky za stejnou dobu jako
jeden; v tomto konkrétním profilu tedy continuous batching téměř zdvojnásobil propustnost bez
odpovídajícího nárůstu latence.

## Reálný RAG dotaz

Osmizdrojový český dotaz měl 4 600 vstupních tokenů. Výchozí thinking režim vLLM spotřeboval celý
limit 500 tokenů pouze na reasoning a nevrátil finální obsah. S `reasoning_effort=none` a
`enable_thinking=false` vrátil model validní JSON za 19,6 s; druhý kontrolní běh trval 20,4 s,
odpověď byla věrná citovanému `source-2` a model nastavil vysokou jistotu.

Tehdejší llama.cpp profil vyřešil stejný portálový dotaz za 49,8 s. Po produkčním přepnutí na vLLM
trval první běh přes celý portál 29,56 s a opakovaný zahřátý běh 16,45 s; oba vrátily validní
citovanou odpověď bez warningu. Reasoning má být zapnutý jen pro úlohy, které jej skutečně
potřebují, a musí mít samostatný vyšší časový i tokenový limit. Ověřená dvoufázová reasoning cesta
(úvaha a následný no-think JSON formatter) vyřešila kontrolní pravděpodobnostní úlohu za 76,1 s.

## Omezení měření

- NVFP4 start hlásil weight-only Marlin kernel a upozornění na rozdílné global scales u fused
  vrstev; český RAG vzorek prošel, ale po přepnutí produkce je stále nutný širší kvalitativní eval.
- MTP speculative decoding nebylo zapnuté; vLLM tak může mít další výkonovou rezervu.
- Výsledky platí pro jeden DGX Spark a tento konkrétní mix dlouhého prefillingu a krátkého výstupu.
- Start vLLM je výrazně těžší: image má 22,5 GB, model použil 18,78 GiB pro váhy a při nastavení
  0,30 vytvořil 12,61 GiB KV cache. Po zahřátí je modelová cache perzistentní.

Benchmark lze zopakovat pomocí `scripts/benchmark-answer.ts`; API klíč se předává pouze přes
proměnnou `BENCH_API_KEY`.
