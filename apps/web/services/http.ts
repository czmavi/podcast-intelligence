import { DomainError } from "../../../packages/domain/errors.ts";
import type { Config } from "../../../packages/shared/config.ts";

export async function readJson(request: Request, maxBytes = 100_000): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) {
    throw new DomainError("JSON payload je příliš velký.", "PAYLOAD_TOO_LARGE", 413);
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new DomainError("JSON payload je příliš velký.", "PAYLOAD_TOO_LARGE", 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("Tělo požadavku není platný JSON.", "INVALID_JSON");
  }
}

export function requireMutationAuth(request: Request, config: Config): void {
  if (config.AUTH_MODE === "disabled") return;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== config.AUTH_TOKEN) {
    throw new DomainError("Chybí platné oprávnění.", "UNAUTHORIZED", 401);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
