// The logs of the server, one line per event on the standard output, which Docker collects. A
// line holds the time, the level, the message and, as JSON, the values that go with it.

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

export type LogData = Record<string, unknown>;

export interface Logger {
  debug: (message: string, data?: LogData) => void;
  info: (message: string, data?: LogData) => void;
  warn: (message: string, data?: LogData) => void;
  error: (message: string, data?: LogData) => void;
}

// Writes one line. Errors go to the standard error, the rest to the standard output.
export type LogWriter = (level: LogLevel, line: string) => void;

const writeToConsole: LogWriter = (level, line) => {
  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
};

export function createLogger(
  name: string,
  minimum: LogLevel,
  write: LogWriter = writeToConsole,
): Logger {
  const lowest = logLevels.indexOf(minimum);
  const log = (level: LogLevel) => (message: string, data?: LogData) => {
    if (logLevels.indexOf(level) < lowest) {
      return;
    }
    const values = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    write(
      level,
      `${new Date().toISOString()} ${level.toUpperCase()} (${name}): ${message}${values}`,
    );
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

// The message of an error, for the values of a log line.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
