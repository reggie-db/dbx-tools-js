/**
 * Server-side networking helpers. Re-exports every browser-safe URL
 * helper from {@link ./net.browser.ts} verbatim and adds node-only
 * additions (currently {@link getRandomPort}), so the `netUtils`
 * namespace exposes the same URL surface from either entry point and
 * picks up node-only helpers automatically on the server.
 */

import net from "node:net";

export * from "./net.browser.js";


/**
 * Bind a transient TCP listener on port `0`, read the OS-assigned
 * port, close the listener, and resolve with the port. Used to grab
 * a free local port for tests, devloops, and child processes.
 */
export async function getRandomPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
