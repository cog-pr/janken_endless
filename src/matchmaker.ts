// MatchMaker Durable Object — マッチング管理

interface WaitingPlayer {
    playerId: string;
    timestamp: number;
    matchId?: string;
    deadline?: number;
}

export class MatchMaker implements DurableObject {
    private waitingQueue: WaitingPlayer[] = [];
    private matchedPlayers: Map<string, { matchId: string; deadline: number }> =
        new Map();

    constructor(
        private state: DurableObjectState,
        private env: Env
    ) { }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === "/join" && request.method === "POST") {
                return this.handleJoin();
            }
            if (path === "/cancel" && request.method === "POST") {
                return this.handleCancel(request);
            }
            if (path === "/wait" && request.method === "GET") {
                return this.handleWait(url);
            }
            return jsonResponse({ error: "Not found" }, 404);
        } catch (e) {
            return jsonResponse({ error: "Internal error" }, 500);
        }
    }

    private async handleJoin(): Promise<Response> {
        const playerId = `p_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

        // 古い待機者（60秒以上）を除去
        const now = Date.now();
        this.waitingQueue = this.waitingQueue.filter(
            (w) => now - w.timestamp < 60_000
        );

        if (this.waitingQueue.length > 0) {
            // マッチング成立
            const opponent = this.waitingQueue.shift()!;
            const matchId = `m_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

            // Match DOを初期化
            const matchStub = this.env.MATCH.get(
                this.env.MATCH.idFromName(matchId)
            );

            const initResp = await matchStub.fetch(
                new Request("https://match/init", {
                    method: "POST",
                    body: JSON.stringify({
                        matchId,
                        playerA: opponent.playerId,
                        playerB: playerId,
                    }),
                    headers: { "Content-Type": "application/json" },
                })
            );

            const initData = (await initResp.json()) as { deadline: number };

            // 対戦相手（待機していた側）にもマッチ情報を保存
            this.matchedPlayers.set(opponent.playerId, {
                matchId,
                deadline: initData.deadline,
            });

            return jsonResponse({
                playerId,
                matchId,
                state: "selecting",
                deadline: initData.deadline,
            });
        } else {
            // 待機キューに追加
            this.waitingQueue.push({ playerId, timestamp: now });

            return jsonResponse({
                playerId,
                matchId: null,
                state: "waiting",
                deadline: null,
            });
        }
    }

    private async handleWait(url: URL): Promise<Response> {
        const playerId = url.searchParams.get("playerId");
        if (!playerId) {
            return jsonResponse({ error: "playerId required" }, 400);
        }

        // マッチング成立済みか確認
        const matched = this.matchedPlayers.get(playerId);
        if (matched) {
            this.matchedPlayers.delete(playerId);
            return jsonResponse({
                state: "selecting",
                matchId: matched.matchId,
                deadline: matched.deadline,
            });
        }

        // まだ待機中か確認
        const still = this.waitingQueue.some((w) => w.playerId === playerId);
        if (still) {
            return jsonResponse({ state: "waiting" });
        }

        // キューにもマッチ済みにもない → タイムアウトで除去された等
        return jsonResponse({ state: "expired" });
    }

    private async handleCancel(request: Request): Promise<Response> {
        const body = (await request.json()) as { playerId: string };

        const index = this.waitingQueue.findIndex(
            (w) => w.playerId === body.playerId
        );

        if (index !== -1) {
            this.waitingQueue.splice(index, 1);
            return jsonResponse({ ok: true, cancelled: true });
        }

        return jsonResponse({ ok: true, cancelled: false });
    }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
