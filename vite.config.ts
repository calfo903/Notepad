import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import type { IncomingMessage, ServerResponse } from "http";
import { handleChat } from "./server/chatHandler";
import {
  handleGoogleLogin,
  handleLogout,
  handleSession,
} from "./server/authHandler";
import { handleListNotes, handleSync } from "./server/syncHandler";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set when the dev server sits behind a TLS proxy that terminates on 443, so the
// HMR client dials the proxy instead of the Vite port. Local dev leaves it unset.
const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT;

/** Route table mirroring the Vercel `api/` filesystem layout. */
const API_ROUTES: ReadonlyMap<string, (request: Request) => Promise<Response>> = new Map([
  ["/api/chat", handleChat],
  ["/api/auth/google", handleGoogleLogin],
  ["/api/auth/session", handleSession],
  ["/api/auth/logout", handleLogout],
  ["/api/notes/sync", handleSync],
  ["/api/notes", handleListNotes],
]);

/**
 * Serve the Edge endpoints in development.
 *
 * Vercel routes api/*.ts to Edge Functions in production, but `vite` has no such
 * routing, so the same handlers are mounted as connect middleware here. One
 * implementation, two hosts — no duplicated logic and no drift between them.
 */
function apiEndpointPlugin(): Plugin {
  return {
    name: "noteflow-api-endpoints",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        const handler = API_ROUTES.get(pathname);
        if (!handler) {
          next();
          return;
        }
        void serveApi(req, res, handler);
      });
    },
  };
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost:5173";
  const url = new URL(req.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  const controller = new AbortController();
  req.on("close", () => {
    if (!req.complete) controller.abort();
  });

  return new Request(url, {
    method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
    signal: controller.signal,
    // Required by the Fetch spec when a body is present.
    duplex: "half",
  } as RequestInit);
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  if (response.body === null) {
    res.end();
    return;
  }

  // Flush headers immediately so the client sees the SSE stream open rather
  // than waiting for the first model token.
  res.flushHeaders();

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await onceDrain(res);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function onceDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => res.once("drain", () => resolve()));
}

async function serveApi(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>
): Promise<void> {
  const pathname = (req.url ?? "").split("?")[0];

  try {
    const response = await handler(await toWebRequest(req));
    await writeWebResponse(response, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : `Unhandled error in ${pathname}`;
    console.error(`[api]${pathname}`, message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { code: "INTERNAL", message } }));
    } else {
      res.end();
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), apiEndpointPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Accept requests addressed to any hostname (preview/proxy domains, LAN IPs).
    allowedHosts: true,
    hmr: hmrClientPort
      ? { clientPort: Number(hmrClientPort), protocol: "wss" }
      : undefined,
  },
});
