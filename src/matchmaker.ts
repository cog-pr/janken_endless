// MatchMaker Durable Object — マッチング管理

interface WaitingPlayer {
    playerId: string;
    timestamp: number;
    matchId?: string;
    deadline?: number;
}

export class MatchMaker implements DurableObject {
    private waitingQueue: WaitingPlayer[] = [];
    // キューから取り出したが、Match DO の初期化が終わっていない待機者
    private pendingPlayers: Set<string> = new Set();
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

        // 古いマッチ情報（deadline から60秒以上）を除去
        for (const [id, matched] of this.matchedPlayers) {
            if (now - matched.deadline >= 60_000) {
                this.matchedPlayers.delete(id);
            }
        }

        if (this.waitingQueue.length > 0) {
            // マッチング成立
            const opponent = this.waitingQueue.shift()!;
            const matchId = `m_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

            // Match DO の初期化を await している間も、相手の /wait は割り込んで処理される。
            // キューにもマッチ済みにもいないと expired と判定されるため、初期化中として保持する
            this.pendingPlayers.add(opponent.playerId);

            let deadline: number;
            try {
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
                if (!initResp.ok) {
                    throw new Error(`Match init failed: ${initResp.status}`);
                }

                const initData = (await initResp.json()) as { deadline: number };
                deadline = initData.deadline;
            } catch (e) {
                // 初期化に失敗したら、相手を待機キューの先頭に戻す
                this.waitingQueue.unshift(opponent);
                return jsonResponse({ error: "Failed to create match" }, 503);
            } finally {
                this.pendingPlayers.delete(opponent.playerId);
            }

            // 対戦相手（待機していた側）にもマッチ情報を保存
            this.matchedPlayers.set(opponent.playerId, { matchId, deadline });

            return jsonResponse({
                playerId,
                matchId,
                state: "selecting",
                deadline,
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
        // 応答の消失やポーリングの重複に備え、ここでは削除せず何度でも同じ結果を返す
        const matched = this.matchedPlayers.get(playerId);
        if (matched) {
            return jsonResponse({
                state: "selecting",
                matchId: matched.matchId,
                deadline: matched.deadline,
            });
        }

        // まだ待機中か確認（Match DO の初期化中も待機中として扱う）
        const still =
            this.pendingPlayers.has(playerId) ||
            this.waitingQueue.some((w) => w.playerId === playerId);
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
