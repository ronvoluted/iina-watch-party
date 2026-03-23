/**
 * Room Durable Object — manages a single watch-party room.
 * SQLite-backed per PRD requirement.
 */

import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("Room stub", { status: 200 });
  }
}
