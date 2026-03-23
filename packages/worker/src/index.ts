/**
 * @iina-watch-party/worker
 *
 * Cloudflare Worker entry point with HTTP router and Durable Object binding.
 */

export { Room } from "./room.js";

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return new Response(JSON.stringify({ status: "not-implemented" }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/ws/")) {
      return new Response(JSON.stringify({ status: "not-implemented" }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export interface Env {
  ROOM: DurableObjectNamespace;
}
