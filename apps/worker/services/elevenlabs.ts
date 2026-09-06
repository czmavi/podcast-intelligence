import { z } from "zod";
import { DomainError } from "../../../packages/domain/errors.ts";
import {
  type ProcessAudioResponse,
  validateProcessAudioResponse,
} from "../../../packages/domain/schemas.ts";

const wordSchema = z.object({
  text: z.string(),
  type: z.enum(["word", "spacing", "audio_event"]),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  speaker_id: z.string().nullable().optional(),
});
export const scribeResponseSchema = z.object({
  language_code: z.string().min(2),
  text: z.string(),
  words: z.array(wordSchema),
  transcription_id: z.string().optional(),
});

export function scribeProcessingResult(
  input: unknown,
  episodeId: string,
  model: string,
  durationSeconds: number,
): ProcessAudioResponse {
  const response = scribeResponseSchema.parse(input);
  const labels = new Map<string, string>();
  const utterances: ProcessAudioResponse["utterances"] = [];
  let spacing = "";
  for (const word of response.words) {
    if (word.end < word.start) throw new Error("Scribe vrátil neplatný čas slova.");
    if (word.type === "spacing") {
      spacing += word.text;
      continue;
    }
    if (word.type !== "word" || !word.text.trim()) continue;
    const speakerId = word.speaker_id ?? "unknown";
    let label = labels.get(speakerId);
    if (!label) {
      label = `SPEAKER_${String(labels.size).padStart(2, "0")}`;
      labels.set(speakerId, label);
    }
    const previous = utterances.at(-1);
    if (
      previous && previous.speaker === label && word.start - previous.end < 2 &&
      word.end - previous.start <= 25
    ) {
      previous.text += (spacing || " ") + word.text;
      previous.end = Math.max(previous.end, word.end);
    } else {
      utterances.push({
        sequence: utterances.length,
        start: word.start,
        end: Math.max(word.end, word.start + 0.001),
        speaker: label,
        text: word.text,
        transcriptionConfidence: null,
        speakerConfidence: null,
        overlapDetected: false,
      });
    }
    spacing = "";
  }
  if (!utterances.length) throw new Error("Scribe nevrátil žádné promluvy.");
  const speakers = [...labels.values()].map((label) => {
    const segments = utterances.filter((utterance) => utterance.speaker === label);
    return {
      label,
      speechSeconds: segments.reduce((total, segment) => total + segment.end - segment.start, 0),
      segmentCount: segments.length,
      representativeSegments: [...segments].sort((a, b) => (b.end - b.start) - (a.end - a.start))
        .slice(0, 5).map((segment) => ({ start: segment.start, end: segment.end, quality: 0.5 })),
      embedding: null,
    };
  });
  return validateProcessAudioResponse({
    schemaVersion: "3",
    episodeId,
    transcriptAlignmentMode: "segment",
    durationSeconds,
    detectedLanguage: response.language_code,
    models: {
      transcription: { name: model, version: null },
      diarization: { name: `${model}-diarization`, version: null },
      speakerEmbedding: null,
    },
    speakers,
    utterances,
    warnings: ["Scribe neposkytuje hlasové embeddingy; osoby přiřaďte podle poslechu."],
  }, episodeId);
}

export async function transcribeWithScribe(options: {
  audioPath: string;
  apiKey: string;
  model: string;
  language: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}): Promise<z.infer<typeof scribeResponseSchema>> {
  const stat = await Deno.stat(options.audioPath);
  if (!stat.isFile || stat.size <= 0 || stat.size >= 5_000_000_000) {
    throw new DomainError(
      "Audio pro Scribe musí být neprázdný soubor menší než 5 GB.",
      "INVALID_SCRIBE_AUDIO",
      400,
    );
  }
  const boundary = `podcast-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const fields = {
    model_id: options.model,
    language_code: options.language,
    diarize: "true",
    timestamps_granularity: "word",
    tag_audio_events: "false",
  };
  const header = encoder.encode(
    Object.entries(fields).map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ).join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const footer = encoder.encode(`\r\n--${boundary}--\r\n`);
  const file = await Deno.open(options.audioPath, { read: true });
  let sentHeader = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHeader) {
        sentHeader = true;
        controller.enqueue(header);
        return;
      }
      const buffer = new Uint8Array(64 * 1024);
      const read = await file.read(buffer);
      if (read === null) {
        controller.enqueue(footer);
        controller.close();
      } else controller.enqueue(buffer.subarray(0, read));
    },
  });
  try {
    const response = await (options.fetcher ?? fetch)(
      "https://api.elevenlabs.io/v1/speech-to-text",
      {
        method: "POST",
        headers: {
          "xi-api-key": options.apiKey,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(header.length + stat.size + footer.length),
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError(
        `ElevenLabs Scribe vrátil HTTP ${response.status}.`,
        "SCRIBE_REQUEST_FAILED",
        502,
      );
    }
    return scribeResponseSchema.parse(await response.json());
  } finally {
    file.close();
  }
}
