/**
 * Local synthetic HTTPS endpoint for the ADR 0010 passthrough tests (the
 * "ADR 0010 — theatre-search subresource exception (P6.11 amendment)" block of
 * corridor.test.ts).
 *
 * The dedicated supervisor for those tests launches Chrome with
 * `--host-resolver-rules=MAP www.amctheatres.com 127.0.0.1:<port>` and
 * `--ignore-certificate-errors` through `BrowserSupervisorOptions.extraLaunchArgs` —
 * the seam the supervisor reserves for exactly this. A subresource the transport lets
 * through therefore lands on THIS server instead of the real network: P6.19 (no
 * network egress) holds by construction, even if the corridor regressed, because no
 * socket can leave the loopback for the mapped origin.
 *
 * The committed self-signed certificate for `www.amctheatres.com` (see `tls/`) lets
 * the TLS handshake complete; it has no security value and is test-only.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SubresourceServer {
  /** Path of every HTTP request received, in order. Mutable: tests reset the log. */
  readonly requests: string[];
  /** Loopback port; bake it into the supervisor's host-resolver mapping. */
  readonly port: number;
  close(): Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function startSubresourceServer(): Promise<SubresourceServer> {
  const requests: string[] = [];
  const server: Server = createServer(
    {
      key: readFileSync(join(HERE, "tls", "key.pem")),
      cert: readFileSync(join(HERE, "tls", "cert.pem")),
    },
    (request, response) => {
      requests.push(request.url ?? "/");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("synthetic subresource response");
    },
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("subresource server failed to obtain a loopback address"));
        return;
      }
      resolve({
        requests,
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) =>
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
          ),
      });
    });
  });
}
