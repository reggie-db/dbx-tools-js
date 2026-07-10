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
expectLines("prefix string", stderr.drain(), ["INFO [plugin-a] hello"]);

logger("mastra/history").info("loaded");
expectLines("path basename", stderr.drain(), ["INFO [history] loaded"]);

logger({ name: "plugin-b" }).warn("careful");
expectLines("name-like", stderr.drain(), ["WARN [plugin-b] careful"]);

logger(undefined).error("boom");
expectLines("untagged", stderr.drain(), ["ERROR boom"]);

logger({ name: "" }).debug("no prefix");
expectLines("empty name", stderr.drain(), ["DEBUG no prefix"]);

logger("plugin-a").info("update", { foo: 1, bar: "x" });
expectLines("attributes", stderr.drain(), [
  'INFO [plugin-a] update {\n  foo: 1,\n  bar: "x",\n}',
]);

const log = logger("plugin-a");
log.debug("d");
log.info("i");
log.warn("w");
log.error("e");
expectLines("all levels", stderr.drain(), [
  "DEBUG [plugin-a] d",
  "INFO [plugin-a] i",
  "WARN [plugin-a] w",
  "ERROR [plugin-a] e",
]);

process.env.LOG_LEVEL = "info";
logger("plugin-a").debug("hidden");
logger("plugin-a").info("shown");
expectLines("log level gate", stderr.drain(), ["INFO [plugin-a] shown"]);
process.env.LOG_LEVEL = "debug";

if (logger(undefined) !== logger(undefined)) {
  throw new Error("untagged logger should be memoized");
}

stderr.restore();
