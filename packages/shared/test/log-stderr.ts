/** Capture `process.stderr.write` output for logger sink assertions. */
export function installStderrCapture(): {
  drain: () => string[];
  restore: () => void;
} {
  const stderrLines: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, encoding?, cb?) => {
    stderrLines.push(String(chunk));
    return origStderrWrite(chunk as any, encoding as any, cb as any);
  }) as typeof process.stderr.write;

  return {
    drain() {
      const lines = stderrLines.map((line) =>
        line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd(),
      );
      stderrLines.length = 0;
      return lines;
    },
    restore() {
      process.stderr.write = origStderrWrite;
    },
  };
}
