// Worker エントリポイント — APIルーティング

export { MatchMaker } from "./matchmaker";
export { Match } from "./match";

export interface Env {
    MATCHMAKER: DurableObjectNamespace;
    MATCH: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS ヘッダー
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: corsHeaders(),
            });
        }

        try {
            // API ルーティング
            if (path === "/api/join" && request.method === "POST") {
                return proxy(
                    env.MATCHMAKER,
                    env.MATCHMAKER.idFromName("global"),
                    "https://matchmaker/join",
                    "POST"
                );
            }

            if (path === "/api/cancel" && request.method === "POST") {
                const body = (await request.json()) as { playerId: string };
                return proxy(
                    env.MATCHMAKER,
                    env.MATCHMAKER.idFromName("global"),
                    "https://matchmaker/cancel",
                    "POST",
                    JSON.stringify(body)
                );
            }

            if (path === "/api/wait" && request.method === "GET") {
                const playerId = url.searchParams.get("playerId");
                if (!playerId) {
                    return jsonResponse({ error: "playerId required" }, 400);
                }
                return proxy(
                    env.MATCHMAKER,
                    env.MATCHMAKER.idFromName("global"),
                    `https://matchmaker/wait?playerId=${encodeURIComponent(playerId)}`,
                    "GET"
                );
            }

            if (path === "/api/state" && request.method === "GET") {
                const matchId = url.searchParams.get("matchId");
                const playerId = url.searchParams.get("playerId");
                if (!matchId || !playerId) {
                    return jsonResponse({ error: "matchId and playerId required" }, 400);
                }
                return proxy(
                    env.MATCH,
                    env.MATCH.idFromName(matchId),
                    `https://match/state?playerId=${encodeURIComponent(playerId)}`,
                    "GET"
                );
            }

            if (path === "/api/move" && request.method === "POST") {
                const body = (await request.json()) as {
                    matchId: string;
                    playerId: string;
                    move: string;
                };
                if (!body.matchId || !body.playerId || !body.move) {
                    return jsonResponse({ error: "matchId, playerId, move required" }, 400);
                }
                return proxy(
                    env.MATCH,
                    env.MATCH.idFromName(body.matchId),
                    "https://match/move",
                    "POST",
                    JSON.stringify({ playerId: body.playerId, move: body.move })
                );
            }

            // 静的アセットは Workers の assets 機能で配信されるため、
            // ここに到達するのは不明なAPIパスのみ
            return jsonResponse({ error: "Not found" }, 404);
        } catch (e) {
            return jsonResponse({ error: "Internal server error" }, 500);
        }
    },
} satisfies ExportedHandler<Env>;

async function proxy(
    ns: DurableObjectNamespace,
    id: DurableObjectId,
    url: string,
    method: string,
    body?: string
): Promise<Response> {
    const stub = ns.get(id);
    const init: RequestInit = { method };
    if (body) {
        init.body = body;
        init.headers = { "Content-Type": "application/json" };
    }
    const resp = await stub.fetch(new Request(url, init));
    const respBody = await resp.text();

    return new Response(respBody, {
        status: resp.status,
        headers: {
            "Content-Type": "application/json",
            ...Object.fromEntries(corsHeaders().entries()),
        },
    });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...Object.fromEntries(corsHeaders().entries()),
        },
    });
}

function corsHeaders(): Headers {
    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    return headers;
}
