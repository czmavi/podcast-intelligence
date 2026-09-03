import { z } from "zod";
import type { Config } from "./config.ts";
import { DomainError } from "../domain/errors.ts";

const pushoverResponseSchema = z.object({
  status: z.literal(1),
  request: z.string().min(1),
});

type PushoverConfig = Pick<Config, "PUSHOVER_APP_TOKEN" | "PUSHOVER_USER_KEY">;
type Fetch = typeof fetch;

export class PushoverClient {
  constructor(
    private readonly config: PushoverConfig,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.PUSHOVER_APP_TOKEN && this.config.PUSHOVER_USER_KEY);
  }

  async send(title: string, message: string): Promise<{ requestId: string }> {
    const token = this.config.PUSHOVER_APP_TOKEN;
    const user = this.config.PUSHOVER_USER_KEY;
    if (!token || !user) {
      throw new DomainError(
        "Pushover není nakonfigurovaný. Nastavte PUSHOVER_APP_TOKEN a PUSHOVER_USER_KEY.",
        "PUSHOVER_NOT_CONFIGURED",
        503,
      );
    }
    const body = new URLSearchParams({
      token,
      user,
      title: title.slice(0, 250),
      message: message.slice(0, 1024),
      priority: "0",
    });
    let response: Response;
    try {
      response = await this.fetchFn("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new DomainError("Pushover API není dostupné.", "PUSHOVER_UNAVAILABLE", 502, true);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new DomainError(
        `Pushover odmítl notifikaci (HTTP ${response.status}).`,
        "PUSHOVER_ERROR",
        502,
        response.status >= 500,
      );
    }
    const parsed = pushoverResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError("Pushover vrátil neplatnou odpověď.", "PUSHOVER_RESPONSE", 502);
    }
    return { requestId: parsed.data.request };
  }
}
