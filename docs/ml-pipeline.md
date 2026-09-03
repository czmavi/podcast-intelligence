# ML pipeline

Worker předává pouze 16 kHz mono PCM WAV. ML služba cestu canonicalizuje a odmítne soubor mimo
`AUDIO_ML_SHARED_ROOT`.

V DGX režimu leží WAV na Synology share. Lokální worker i vzdálený ML kontejner jej vidí pod
vlastním storage rootem a Deno před odesláním přepočítá cestu relativně. ML mount je read-only;
výsledky se vracejí přes autentizované HTTP API a zapisuje je pouze lokální worker.

1. `soundfile` ověří audio a délku.
2. Hugging Face Transformers s PyTorch spustí plný `openai/whisper-large-v3` na CUDA a vytvoří
   segmenty s timestampy. Beam search 5 upřednostňuje přesnost před rychlostí; jazyk může být
   autodetekovaný nebo vynucený (aplikace standardně posílá češtinu).
3. Podcast volí jeden ze tří režimů zpracování. Výchozí `segment` zachová celé původní Whisper
   segmenty a jejich stabilní časování. Režim `overlap` rozdělí text segmentu na slova a jejich časy
   proporcionálně rozloží do jeho rozsahu, takže lze změnit mluvčího i uvnitř dlouhého segmentu.
   `overlap_asr_corrected` používá stejné překryvové zarovnání a až nad hotovými diarizovanými
   promluvami přidá Deno post-processing popsaný níže. Python proto nadále přijímá pouze původní
   hodnoty `segment` a `overlap` a jejich chování se nemění. Experimentální
   `TRANSCRIPTION_TIMESTAMP_MODE=word` používá nativní Whisper word timestampy, ale pro `large-v3`
   je na produkční nahrávce příliš pomalý; produkční hodnota proto zůstává `segment`.
4. `pyannote.audio` 4.x s `speaker-diarization-community-1` vytvoří současně běžnou anotaci pro
   detekci překrývající se řeči a exclusive speaker turns pro jednoznačné zarovnání přepisu.
5. V režimu `overlap` exclusive turns před zarovnáním projdou hysterézí. Ostrov cizího hlasu do
   `DIARIZATION_BRIDGE_MAX_SECONDS` mezi stejným mluvčím se přemostí a samostatný mikroskok do
   `DIARIZATION_ORPHAN_MAX_SECONDS` se připojí k delšímu sousedovi. Produkční prahy jsou 1,2 s a
   0,65 s.
6. V režimu `overlap` se slovní jednotky podle největšího časového překryvu přiřadí stabilizovaným
   turnům a sousední jednotky stejného hlasu se spojí do čitelných promluv. Pokud timestamp leží v
   diarizační mezeře, použije se nejbližší turn s nulovou jistotou, nikdy pevně `SPEAKER_00`.
   Promluva zasahující do souběžné řeči má `overlapDetected=true`.
7. Pro hlas se vyberou dostatečně dlouhé čisté úseky. Intervaly souběžné řeči se před výpočtem
   speaker embeddingů odečtou; pyannote embeddingy ukázek se robustně agregují mediánem a
   normalizují.
8. Každá promluva nese vedle jemně zarovnaného rozsahu také `playbackStart` z původního Whisper
   segmentu. Web i obsahové chunky používají tento stabilní čas pro seek a zobrazenou citaci, takže
   proporcionální odhad neposune přehrávání na jinou část audia.
9. Jen pro `overlap_asr_corrected` Deno pošle každou cílovou promluvu modelu spolu s časově omezeným
   předchozím a následujícím kontextem napříč mluvčími a volitelným názvem/popiskem epizody. Model
   vrací pouze JSON Schema seznam minimálních editací. Lokální aplikátor znovu ověří zdrojový text,
   offsety nebo jednoznačný výskyt a odmítne nízkou jistotu, duplicity i překryvy. Mění se pouze
   `text`; speaker, pořadí, oba časy, confidence a overlap metadata zůstávají ze vstupu.
10. Deno znovu validuje schema version, labels, pořadí a časové hranice a vše uloží v jedné
    transakci. Korigovaný režim ukládá vedle výsledného textu také `rawText`, audit všech přijatých
    i odmítnutých návrhů a souhrn inference. Jednotlivé selhání modelu zachová původní promluvu.

Modely jsou v procesu znovu používané. Produkční Ansible konfigurace načte Whisper už při startu,
aby readiness znamenala, že je model skutečně dostupný. CUDA používá `float16`, CPU fallback
`float32`. OOM, chybějící token, nevalidní audio a nedostupný model mají samostatné strukturované
chyby. CTranslate2 se na DGX Spark ARM64 nepoužívá, protože jeho běžný PyPI ARM64 wheel neobsahuje
CUDA podporu.

Překrývající se řeč zůstává z principu hůře jednoznačná, ale pipeline ji explicitně označí a
nepoužije ji jako hlasovou referenci. Ruční profil moderátora vznikne až potvrzením clusteru; tím se
existující cluster centroid označí `verified_cluster` a spojí s osobou.

Aktuální Transformers wrapper zachovává segmentové nebo experimentální word timestampy, ale Whisper
`avg_logprob`, `no_speech_probability` ani word probability zatím neexportuje a
`transcriptionConfidence` je proto `null`. Korekce na těchto signálech nezávisí; rozhraní
`SuspiciousTranscriptRegion` a `AsrCorrectionValidator` připravují pozdější selektivní výběr a
časově cílené ověření druhým ASR modelem bez změny dnešní audio cesty.
