const TTL_SECONDS = 120;

export interface Env {
    PIN_RECORD: DurableObjectNamespace;
}

type PinBody = {
    ip: string;
    port: number;
    key: string;
    expiresAt: number;
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
    });
}

function isPrivateIpv4(ip: string): boolean {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!match) {
        return false;
    }
    const octets = match.slice(1).map((part) => Number(part));
    if (octets.some((n) => n > 255)) {
        return false;
    }
    const a = octets[0];
    const b = octets[1];
    if (a === 10) {
        return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }
    return a === 192 && b === 168;
}

function randomPin(): string {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    return n.toString().padStart(6, "0");
}

function randomKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class PinRecord {
    constructor(private state: DurableObjectState) {}

    async alarm(): Promise<void> {
        await this.state.storage.deleteAll();
    }

    async fetch(request: Request): Promise<Response> {
        const action = new URL(request.url).pathname.replace(/^\//, "");
        const stored = await this.state.storage.get<PinBody>("record");
        const live = stored && stored.expiresAt > Date.now() ? stored : null;

        if (action === "create") {
            if (live) {
                return json({ error: "taken" }, 409);
            }
            const body = (await request.json()) as { ip: string; port: number; key: string };
            const record: PinBody = {
                ip: body.ip,
                port: body.port,
                key: body.key,
                expiresAt: Date.now() + TTL_SECONDS * 1000,
            };
            await this.state.storage.put("record", record);
            await this.state.storage.setAlarm(record.expiresAt);
            return json({ ok: true });
        }

        if (!live) {
            return json({ error: "not_found" }, 404);
        }

        if (action === "read") {
            return json({ ip: live.ip, port: live.port });
        }

        const auth = request.headers.get("authorization") ?? "";
        if (auth !== `Bearer ${live.key}`) {
            return json({ error: "unauthorized" }, 401);
        }

        if (action === "refresh") {
            live.expiresAt = Date.now() + TTL_SECONDS * 1000;
            await this.state.storage.put("record", live);
            await this.state.storage.setAlarm(live.expiresAt);
            return json({ ok: true, ttlSeconds: TTL_SECONDS });
        }

        if (action === "delete") {
            await this.state.storage.deleteAlarm();
            await this.state.storage.deleteAll();
            return json({ ok: true });
        }

        return json({ error: "not_found" }, 404);
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "access-control-allow-origin": "*",
                    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
                    "access-control-allow-headers": "authorization,content-type",
                },
            });
        }

        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        if (parts[0] !== "v1" || parts[1] !== "pins") {
            return json({ error: "not_found" }, 404);
        }

        if (request.method === "POST" && parts.length === 2) {
            return createPin(request, env);
        }

        if (parts.length !== 3 || !/^\d{6}$/.test(parts[2])) {
            return json({ error: "not_found" }, 404);
        }

        const action =
            request.method === "GET" ? "read" : request.method === "PUT" ? "refresh" : request.method === "DELETE" ? "delete" : "";
        if (!action) {
            return json({ error: "not_found" }, 404);
        }

        const stub = env.PIN_RECORD.get(env.PIN_RECORD.idFromName(parts[2]));
        const headers = new Headers();
        const auth = request.headers.get("authorization");
        if (auth) {
            headers.set("authorization", auth);
        }
        const inner = await stub.fetch(`https://pin/${action}`, { method: request.method, headers });
        return json(await inner.json(), inner.status);
    },
};

async function createPin(request: Request, env: Env): Promise<Response> {
    let body: { ip?: unknown; port?: unknown };
    try {
        body = (await request.json()) as { ip?: unknown; port?: unknown };
    } catch {
        return json({ error: "bad_request" }, 400);
    }
    const ip = typeof body.ip === "string" ? body.ip : "";
    const port = body.port;
    if (!isPrivateIpv4(ip) || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        return json({ error: "bad_request" }, 400);
    }

    const key = randomKey();
    for (let attempt = 0; attempt < 8; attempt++) {
        const pin = randomPin();
        const stub = env.PIN_RECORD.get(env.PIN_RECORD.idFromName(pin));
        const created = await stub.fetch("https://pin/create", {
            method: "POST",
            body: JSON.stringify({ ip, port, key }),
        });
        if (created.status === 409) {
            continue;
        }
        if (!created.ok) {
            return json({ error: "unavailable" }, 500);
        }
        return json({ pin, key, ttlSeconds: TTL_SECONDS });
    }
    return json({ error: "unavailable" }, 503);
}
