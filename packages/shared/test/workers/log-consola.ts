import { mock } from "bun:test";

import { installStderrCapture } from "../log-stderr.js";

type ReporterLogObj = {
  type: string;
  tag?: string;
  args: unknown[];
};

type CapturedLog = ReporterLogObj & {
  stdout: unknown;
};

const captured: CapturedLog[] = [];

const defaultReporter = {
  log(logObj: { type: string; tag?: string; args: unknown[] }, ctx: { options: { stdout?: unknown } }) {
    captured.push({
      type: logObj.type,
      tag: logObj.tag ?? "",
      args: [...logObj.args],
      stdout: ctx.options.stdout,
    });
    const out = ctx.options.stdout as { write?: (chunk: string) => void } | undefined;
    if (typeof out?.write === "function") {
      const tag = logObj.tag ? `[${logObj.tag}] ` : "";
      out.write(`${tag}${logObj.type}: ${String(logObj.args[0] ?? "")}\n`);
    }
  },
};

function mockConsolaInstance(createOptions?: {
  reporters?: Array<{ log: (logObj: ReporterLogObj, ctx: { options: { stdout?: unknown } }) => void }>;
}) {
  const reporters = createOptions?.reporters ?? [];
  const levels = ["debug", "info", "warn", "error"] as const;

  function makeLogger(tag?: string) {
    const logger: Record<string, unknown> = {
      options: createOptions,
      withTag(next: string) {
        return makeLogger(tag ? `${tag}:${next}` : next);
      },
    };
    for (const level of levels) {
      logger[level] = (...args: unknown[]) => {
        const logObj = { type: level, tag: tag ?? "", args };
        const ctx = {
          options: {
            stdout: process.stdout,
            stderr: process.stderr,
            ...createOptions,
          },
        };
        for (const reporter of reporters) {
          reporter.log(logObj, ctx);
        }
      };
    }
    return logger;
  }

  return makeLogger();
}

mock.module("consola", () => ({
  LogLevels: { verbose: Number.POSITIVE_INFINITY },
  consola: { options: { reporters: [defaultReporter] } },
  createConsola: (createOptions: Parameters<typeof mockConsolaInstance>[0]) =>
    mockConsolaInstance(createOptions),
}));

process.env.LOG_LEVEL = "debug";
delete process.env.LOG_CONSOLA_DISABLED;

const stderr = installStderrCapture();
const { logger } = await import("../../src/log.js");

logger("plugin-a").info("hello");
if (captured.length !== 1 || JSON.stringify(captured[0]?.args) !== JSON.stringify(["hello"])) {
  throw new Error(`expected raw hello args, got ${JSON.stringify(captured[0]?.args)}`);
}
if (captured[0]?.tag !== "plugin-a") {
  throw new Error(`expected plugin-a tag, got ${captured[0]?.tag}`);
}
captured.length = 0;
stderr.drain();

logger("plugin-a").warn("careful");
const warnLines = stderr.drain();
if (JSON.stringify(warnLines) !== JSON.stringify(["[plugin-a] warn: careful"])) {
  throw new Error(`expected stderr warn line, got ${JSON.stringify(warnLines)}`);
}
if (captured[0]?.stdout !== process.stderr) {
  throw new Error("expected consola reporter to redirect stdout to stderr");
}
captured.length = 0;

logger(undefined).error("boom");
const untaggedEntry = captured[0];
if (!untaggedEntry || untaggedEntry.tag !== "" || JSON.stringify(untaggedEntry.args) !== JSON.stringify(["boom"])) {
  throw new Error(`expected untagged boom, got ${JSON.stringify(untaggedEntry)}`);
}
captured.length = 0;

process.env.LOG_LEVEL = "info";
logger("plugin-a").debug("hidden");
logger("plugin-a").info("shown");
if (captured.map((entry) => entry.type).join(",") !== "info") {
  throw new Error(`expected only info, got ${captured.map((entry) => entry.type).join(",")}`);
}
if (JSON.stringify(captured[0]?.args) !== JSON.stringify(["shown"])) {
  throw new Error(`expected shown args, got ${JSON.stringify(captured[0]?.args)}`);
}

stderr.restore();
