export interface AddressCandidate {
  personId: string;
  displayName: string;
}

export interface AddressEvidence {
  personId: string;
  matchedForm: string;
  timestampSeconds: number;
  nextSpeakerClusterId: string | null;
}

function variants(name: string): string[] {
  const words = name.trim().split(/\s+/u);
  const first = words[0];
  const vocatives = first
    ? [
      first.endsWith("el") ? `${first.slice(0, -2)}le` : null,
      first.endsWith("r") ? `${first.slice(0, -1)}ře` : null,
      first.endsWith("n") ? `${first}e` : null,
      first.endsWith("a") ? `${first.slice(0, -1)}o` : null,
    ]
    : [];
  return [
    ...new Set(
      [name, first, words.at(-1), ...vocatives].filter((part): part is string => !!part),
    ),
  ]
    .map((part) => part.toLocaleLowerCase("cs"));
}

export function detectDirectAddresses(
  moderatorText: string,
  timestampSeconds: number,
  nextSpeakerClusterId: string | null,
  candidates: AddressCandidate[],
): AddressEvidence[] {
  const normalized = moderatorText.toLocaleLowerCase("cs");
  return candidates.flatMap((candidate) => {
    const match = variants(candidate.displayName).find((form) => {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[\\s,])${escaped}(?:[,:]|\\s+(?:co|jak|začnu|prosím))`, "u").test(
        normalized,
      );
    });
    return match
      ? [{
        personId: candidate.personId,
        matchedForm: match,
        timestampSeconds,
        nextSpeakerClusterId,
      }]
      : [];
  });
}
