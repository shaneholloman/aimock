export type LogLevel = "silent" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export class Logger {
  private level: number;

  constructor(level: LogLevel = "silent") {
    this.level = LEVELS[level];
  }

  info(...args: unknown[]): void {
    if (this.level >= LEVELS.info) {
      console.log("[aimock]", ...args);
    }
  }

  debug(...args: unknown[]): void {
    if (this.level >= LEVELS.debug) {
      console.log("[aimock]", ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (this.level >= LEVELS.warn) {
      console.warn("[aimock]", ...args);
    }
  }

  error(...args: unknown[]): void {
    if (this.level >= LEVELS.warn) {
      console.error("[aimock]", ...args);
    }
  }
}
