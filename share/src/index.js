// share.aziz.tools - signaling only.
//
// Each device opens one WebSocket at /ws. The Worker routes the socket into a
// Durable Object that represents a room: either the caller's network (keyed by
// public IP, which is what makes "same WiFi" discovery work with no codes) or
// an explicit code from ?r=ABCD.
//
// The room keeps the live peer list and relays WebRTC handshake messages
// (SDP + ICE, a few KB per transfer). File bytes never reach Cloudflare: they
// travel device-to-device over the WebRTC data channel.
//
// Deliberately absent: imports, npm packages, storage calls, timers, logs in
// the hot path. State that must survive hibernation lives on the socket
// attachment, so no SQLite rows are ever written.

const MAX_PEERS = 32;
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_MSGS_PER_SEC = 200;
const MAX_RELAY_CHUNK = 64 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (!isUpgrade(request)) {
        return new Response("expected websocket", { status: 426 });
      }

      const room = (url.searchParams.get("r") || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 8);

      // Same network -> same public IP -> same room. No codes, no QR.
      const network = request.headers.get("CF-Connecting-IP") || "local";

      const key = room ? "r:" + room : "n:" + network;
      return env.ROOMS.get(env.ROOMS.idFromName(key)).fetch(request);
    }

    // Tiny diagnostic: lets the page show which "network" it landed in, so two
    // devices that cannot see each other can compare IDs. Hashed, not raw.
    if (url.pathname === "/net") {
      const room = (url.searchParams.get("r") || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 8);
      const body = room
        ? { room: room, net: "" }
        : { room: "", net: await networkLabel(request.headers.get("CF-Connecting-IP") || "local") };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

async function networkLabel(ip) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("aziz.tools/net/" + ip));
  const bytes = new Uint8Array(digest).slice(0, 3);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function isUpgrade(request) {
  return (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

function newId() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

export class Room {
  constructor(state) {
    this.state = state;
    this.cache = new Map();
  }

  // Small cache so the hot path does not re-read socket attachments.
  att(ws) {
    let a = this.cache.get(ws);
    if (!a) {
      a = ws.deserializeAttachment() || {};
      this.cache.set(ws, a);
    }
    return a;
  }

  fetch(request) {
    if (!isUpgrade(request)) {
      return new Response("expected websocket", { status: 426 });
    }
    if (this.state.getWebSockets().length >= MAX_PEERS) {
      return new Response("room full", { status: 503 });
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);

    const id = newId();
    const att = { id: id, name: "", win: 0, n: 0 };
    server.serializeAttachment(att);
    this.cache.set(server, att);

    server.send(JSON.stringify({ t: "welcome", id: id, peers: this.peerList(id) }));
    this.broadcast(id, { t: "join", peer: { id: id, name: "" } });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  peerList(exceptId) {
    const out = [];
    for (const ws of this.state.getWebSockets()) {
      const a = this.att(ws);
      if (a.id && a.id !== exceptId) {
        out.push({ id: a.id, name: a.name || "" });
      }
    }
    return out;
  }

  broadcast(exceptId, msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      const a = this.att(ws);
      if (a.id && a.id !== exceptId) {
        try {
          ws.send(text);
        } catch (e) {
          // socket already gone; webSocketClose removes it
        }
      }
    }
  }

  webSocketMessage(ws, message) {
    const a = this.att(ws);
    if (!a.id) return;

    // Cheap per-socket flood guard: signaling needs a handful of messages.
    const now = Date.now();
    if (now - a.win > 1000) {
      a.win = now;
      a.n = 0;
    }
    if (++a.n > MAX_MSGS_PER_SEC) {
      try {
        ws.close(1008, "slow down");
      } catch (e) {}
      return;
    }

    /*
     * Relay fallback frame: [6-byte recipient id][binary payload].
     * The relay is only used when a direct WebRTC path cannot be established,
     * so both devices still only need outbound access to Cloudflare. The
     * receiving peer gets [6-byte sender id][payload].
     */
    if (typeof message !== "string") {
      let bytes;
      try {
        bytes = new Uint8Array(message);
      } catch (e) {
        return;
      }
      if (bytes.length < 7 || bytes.length > MAX_RELAY_CHUNK + 6) return;

      let target = "";
      for (let i = 0; i < 6; i++) target += String.fromCharCode(bytes[i]);
      const payload = bytes.slice(6);
      const sender = new TextEncoder().encode(a.id);
      const out = new Uint8Array(sender.length + payload.length);
      out.set(sender, 0);
      out.set(payload, sender.length);

      for (const other of this.state.getWebSockets()) {
        const b = this.att(other);
        if (b.id === target) {
          try {
            other.send(out.buffer);
          } catch (e) {}
          return;
        }
      }
      return;
    }

    if (message.length > MAX_SIGNAL_BYTES) return;

    let m;
    try {
      m = JSON.parse(message);
    } catch (e) {
      return;
    }

    if (m.t === "name") {
      a.name = String(m.name || "")
        .replace(/[^\w \-.]/g, "")
        .slice(0, 24);
      ws.serializeAttachment(a);
      this.broadcast(a.id, { t: "peer", peer: { id: a.id, name: a.name } });
      return;
    }

    if (m.t === "signal" && m.to) {
      for (const other of this.state.getWebSockets()) {
        const b = this.att(other);
        if (b.id === m.to) {
          try {
            other.send(JSON.stringify({ t: "signal", from: a.id, data: m.data }));
          } catch (e) {}
          return;
        }
      }
    }

    if (m.t === "relay" && m.to) {
      const kind = String(m.kind || "");
      if (kind !== "start" && kind !== "text" && kind !== "ack" && kind !== "cancel") return;

      const forwarded = JSON.stringify({
        t: "relay",
        from: a.id,
        kind: kind,
        id: String(m.id || "").slice(0, 32),
        name: String(m.name || "").slice(0, 128),
        size: Number(m.size) || 0,
        type: String(m.type || "").slice(0, 64),
        text: kind === "text" ? String(m.text || "").slice(0, 32000) : "",
      });

      for (const other of this.state.getWebSockets()) {
        const b = this.att(other);
        if (b.id === m.to) {
          try {
            other.send(forwarded);
          } catch (e) {}
          return;
        }
      }
    }
  }

  webSocketClose(ws) {
    this.leave(ws);
  }

  webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const a = this.att(ws);
    this.cache.delete(ws);
    if (a.id) {
      this.broadcast(a.id, { t: "leave", id: a.id });
    }
  }
}
