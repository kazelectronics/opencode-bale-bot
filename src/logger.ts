export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly secrets?: readonly string[];
  readonly sink?: (line: string) => void;
  readonly baseFields?: Record<string, unknown>;
}

/**
 * Replaces known secrets and common token-bearing URL shapes.
 * Logs may contain target content, so this is intentionally conservative.
 */
export function redact(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output
    .replace(/(\/bot)[^/&\s]+/gi, "$1[redacted]")
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/gi, "$1 [redacted]");
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, secrets),
      stack: value.stack ? redact(value.stack, secrets) : undefined,
    };
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactDeep(item, secrets);
    }
    return result;
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const secrets = options.secrets ?? [];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const threshold = LEVEL_ORDER[options.level];

  const write = (
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
    baseFields: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    const timestamp = new Date().toISOString();
    const merged = { ...baseFields, ...(fields ?? {}) };
    const suffix =
      Object.keys(merged).length > 0
        ? ` ${JSON.stringify(redactDeep(merged, secrets))}`
        : "";
    sink(`${timestamp} ${level.toUpperCase().padEnd(5)} ${redact(message, secrets)}${suffix}`);
  };

  const make = (baseFields: Record<string, unknown>): Logger => ({
    debug: (message, fields) => write("debug", message, fields, baseFields),
    info: (message, fields) => write("info", message, fields, baseFields),
    warn: (message, fields) => write("warn", message, fields, baseFields),
    error: (message, fields) => write("error", message, fields, baseFields),
    child: (fields) => make({ ...baseFields, ...fields }),
  });

  return make(options.baseFields ?? {});
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}