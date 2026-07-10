import { installStderrCapture } from "../log-stderr.js";

process.env.LOG_LEVEL = "debug";
process.env.LOG_CONSOLA_DISABLED = "true";
delete process.env.LOG_BUN_CONSOLE_DISABLED;

const stderr = installStderrCapture();
const { logger } = await import("../../src/log.js");

function expectLines(label: string, actual: string[], expected: string[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

logger("plugin-a").info("hello");
expectLines("tagged", stderr.drain(), ["INFO [plugin-a] hello"]);

logger(undefined).error("boom");
expectLines("untagged", stderr.drain(), ["ERROR boom"]);

if (logger(undefined) !== logger(undefined)) {
  throw new Error("untagged logger should be memoized");
}

process.env.LOG_LEVEL = "warn";
logger("plugin-a").info("hidden");
logger("plugin-a").warn("shown");
expectLines("log level gate", stderr.drain(), ["WARN [plugin-a] shown"]);
process.env.LOG_LEVEL = "debug";

stderr.restore();
