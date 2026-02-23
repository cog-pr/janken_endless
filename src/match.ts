// Match Durable Object — 1試合を管理する

type Move = "rock" | "paper" | "scissors";
type Outcome = "win" | "lose" | "draw";
type Reason = "normal" | "timeout_win" | "timeout_lose" | "double_timeout";

interface MatchResult {
    outcomeA: Outcome;
    outcomeB: Outcome;
    reason: Reason;
}

interface MatchData {
    matchId: string;
    playerA: string;
    playerB: string;
    moveA: Move | null;
    moveB: Move | null;
    deadline: number;
    resolved: boolean;
    result?: MatchResult;
}

export class Match implements DurableObject {
    private data: MatchData | null = null;

    constructor(
        private state: DurableObjectState,
        private env: Env
    ) { }

    private async loadData(): Promise<MatchData | null> {
        if (!this.data) {
            this.data = (await this.state.storage.get<MatchData>("match")) ?? null;
        }
        return this.data;
    }

    private async saveData(): Promise<void> {
        if (this.data) {
            await this.state.storage.put("match", this.data);
        }
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === "/init" && request.method === "POST") {
                return this.handleInit(request);
            }
            if (path === "/move" && request.method === "POST") {
                return this.handleMove(request);
            }
            if (path === "/state" && request.method === "GET") {
                return this.handleState(url);
            }
            return jsonResponse({ error: "Not found" }, 404);
        } catch (e) {
            return jsonResponse({ error: "Internal error" }, 500);
        }
    }

    private async handleInit(request: Request): Promise<Response> {
        const body = (await request.json()) as {
            matchId: string;
            playerA: string;
            playerB: string;
        };

        this.data = {
            matchId: body.matchId,
            playerA: body.playerA,
            playerB: body.playerB,
            moveA: null,
            moveB: null,
            deadline: Date.now() + 10_000,
            resolved: false,
        };

        await this.saveData();

        return jsonResponse({ ok: true, deadline: this.data.deadline });
    }

    private async handleMove(request: Request): Promise<Response> {
        const body = (await request.json()) as {
            playerId: string;
            move: Move;
        };

        const data = await this.loadData();
        if (!data) {
            return jsonResponse({ error: "Match not found" }, 404);
        }

        if (data.resolved) {
            return jsonResponse({ error: "Match already resolved" }, 400);
        }

        // deadline 超過後の手は受け付けない
        if (Date.now() > data.deadline) {
            this.resolveTimeout(data);
            await this.saveData();
            return jsonResponse({ error: "Deadline passed" }, 400);
        }

        // 有効な手かチェック
        if (!["rock", "paper", "scissors"].includes(body.move)) {
            return jsonResponse({ error: "Invalid move" }, 400);
        }

        // プレイヤーの手を記録
        if (body.playerId === data.playerA) {
            if (data.moveA !== null) {
                return jsonResponse({ error: "Already moved" }, 400);
            }
            data.moveA = body.move;
        } else if (body.playerId === data.playerB) {
            if (data.moveB !== null) {
                return jsonResponse({ error: "Already moved" }, 400);
            }
            data.moveB = body.move;
        } else {
            return jsonResponse({ error: "Invalid player" }, 403);
        }

        // 両者揃ったら即判定
        if (data.moveA !== null && data.moveB !== null) {
            this.resolveNormal(data);
        }

        await this.saveData();

        const state =
            data.resolved ? "result" : data.moveA !== null && data.moveB !== null ? "result" : "locked";

        return jsonResponse({ ok: true, state });
    }

    private async handleState(url: URL): Promise<Response> {
        const playerId = url.searchParams.get("playerId");
        if (!playerId) {
            return jsonResponse({ error: "playerId required" }, 400);
        }

        const data = await this.loadData();
        if (!data) {
            return jsonResponse({ error: "Match not found" }, 404);
        }

        // deadline 超過チェック（未解決の場合のみ）
        if (!data.resolved && Date.now() > data.deadline) {
            this.resolveTimeout(data);
            await this.saveData();
        }

        const isA = playerId === data.playerA;
        const isB = playerId === data.playerB;

        if (!isA && !isB) {
            return jsonResponse({ error: "Invalid player" }, 403);
        }

        if (data.resolved && data.result) {
            const myMove = isA ? data.moveA : data.moveB;
            const oppMove = isA ? data.moveB : data.moveA;
            const outcome = isA ? data.result.outcomeA : data.result.outcomeB;
            return jsonResponse({
                state: "result",
                outcome,
                reason: data.result.reason,
                myMove: myMove ?? "none",
                oppMove: oppMove ?? "none",
            });
        }

        // 自分が選択済みか
        const myMove = isA ? data.moveA : data.moveB;
        if (myMove !== null) {
            return jsonResponse({
                state: "locked",
                deadline: data.deadline,
            });
        }

        return jsonResponse({
            state: "selecting",
            deadline: data.deadline,
        });
    }

    // ──────── 勝敗判定ロジック ────────

    private resolveNormal(data: MatchData): void {
        if (data.resolved) return;

        const a = data.moveA!;
        const b = data.moveB!;

        if (a === b) {
            data.result = { outcomeA: "draw", outcomeB: "draw", reason: "normal" };
        } else if (
            (a === "rock" && b === "scissors") ||
            (a === "scissors" && b === "paper") ||
            (a === "paper" && b === "rock")
        ) {
            data.result = { outcomeA: "win", outcomeB: "lose", reason: "normal" };
        } else {
            data.result = { outcomeA: "lose", outcomeB: "win", reason: "normal" };
        }
        data.resolved = true;
    }

    private resolveTimeout(data: MatchData): void {
        if (data.resolved) return;

        if (data.moveA !== null && data.moveB === null) {
            // Aのみ選択 → Aの不戦勝
            data.result = {
                outcomeA: "win",
                outcomeB: "lose",
                reason: "timeout_win",
            };
        } else if (data.moveA === null && data.moveB !== null) {
            // Bのみ選択 → Bの不戦勝
            data.result = {
                outcomeA: "lose",
                outcomeB: "win",
                reason: "timeout_win",
            };
        } else if (data.moveA === null && data.moveB === null) {
            // 両者未選択 → 両方負け
            data.result = {
                outcomeA: "lose",
                outcomeB: "lose",
                reason: "double_timeout",
            };
        } else {
            // 両者選択済み — 通常判定
            this.resolveNormal(data);
            return;
        }
        data.resolved = true;
    }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
