type LogLevel = "debug" | "info" | "warn" | "error";

export function log(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): void {
  const safe = Object.fromEntries(
    Object.entries(context).filter(([key]) =>
      !/token|secret|api.?key|embedding|transcript/i.test(key)
    ),
  );
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
