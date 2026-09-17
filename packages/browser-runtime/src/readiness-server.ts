/**
 * Minimal local synthetic-page HTTP server for the readiness probe (P6.16, ADR 0004's
 * runtime-ownership table, `docs/adr/0004-deployment-shape-egress-identity.md:123`).
 *
 * Readiness exercises THIS local server — never AMC. The probe's contract is "create and
 * destroy a BrowserContext against the synthetic page"; this server supplies that page.
 * It binds to loopback only, on an ephemeral port unless one is injected.
 */

import { createServer, type Server } from "node:http";

export interface ReadinessServer {
  readonly baseUrl: string;
  setReady?(ready: boolean): void;
  close(): Promise<void>;
}

const READINESS_HTML =
  "<!doctype html><html><head><title>seatfirst synthetic readiness</title></head>" +
  "<body><p>ready</p></body></html>";

/**
 * Start the local synthetic readiness server on 127.0.0.1. `port` defaults to an
 * ephemeral OS-assigned port — a bind hint, not a policy threshold. The page never
 * redirects, so a successful probe lands exactly on `baseUrl`.
 */
export function startReadinessServer(
  options: Readonly<{ port?: number }> = {},
): Promise<ReadinessServer> {
  let isReady = false;
  const server: Server = createServer((request, response) => {
    if (request.url === "/" || request.url === "/synthetic") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(READINESS_HTML);
      return;
    }
    if (request.url === "/readyz") {
      if (isReady) {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ status: "ready" }));
      } else {
        response.writeHead(503, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ status: "not ready" }));
      }
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("readiness server failed to obtain a loopback address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/`,
        setReady: (ready: boolean) => {
          isReady = ready;
        },
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((error) => (error ? rej(error) : res()));
          }),
      });
    });
  });
}
