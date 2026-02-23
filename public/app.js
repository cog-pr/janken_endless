// じゃんけんえんどれす — クライアントアプリケーション

(function () {
    "use strict";

    // ===== 定数 =====
    const POLL_INTERVAL = 1000; // ポーリング間隔（ミリ秒）
    const TIMER_DURATION = 10; // タイマー（秒）
    const STORAGE_KEY = "janken_streak";
    const APP_URL = location.origin;

    // ===== 手の絵文字マップ =====
    const MOVE_EMOJI = {
        rock: "✊",
        paper: "✋",
        scissors: "✌️",
        none: "❓",
    };

    const MOVE_NAME = {
        rock: "グー",
        paper: "パー",
        scissors: "チョキ",
        none: "未選択",
    };

    // ===== 状態 =====
    let playerId = null;
    let matchId = null;
    let deadline = null;
    let streak = loadStreak();
    let pollTimer = null;
    let countdownTimer = null;
    let currentScreen = "home";

    // ===== DOM要素 =====
    const screens = {
        home: document.getElementById("screen-home"),
        waiting: document.getElementById("screen-waiting"),
        selecting: document.getElementById("screen-selecting"),
        locked: document.getElementById("screen-locked"),
        result: document.getElementById("screen-result"),
    };

    const els = {
        streakCount: document.getElementById("streak-count"),
        btnJoin: document.getElementById("btn-join"),
        btnCancel: document.getElementById("btn-cancel"),
        timerText: document.getElementById("timer-text"),
        timerProgress: document.getElementById("timer-progress"),
        handButtons: document.querySelectorAll(".hand-btn"),
        lockedMoveEmoji: document.getElementById("locked-move-emoji"),
        resultBanner: document.getElementById("result-banner"),
        resultText: document.getElementById("result-text"),
        resultMyMove: document.getElementById("result-my-move"),
        resultOppMove: document.getElementById("result-opp-move"),
        resultReason: document.getElementById("result-reason"),
        resultStreakCount: document.getElementById("result-streak-count"),
        btnContinue: document.getElementById("btn-continue"),
        btnRejoin: document.getElementById("btn-rejoin"),
        btnShare: document.getElementById("btn-share"),
    };

    // ===== 初期化 =====
    updateStreakDisplay();
    bindEvents();

    // ===== イベントバインド =====
    function bindEvents() {
        els.btnJoin.addEventListener("click", handleJoin);
        els.btnCancel.addEventListener("click", handleCancel);

        els.handButtons.forEach((btn) => {
            btn.addEventListener("click", () => {
                const move = btn.dataset.move;
                if (move) handleMove(move);
            });
        });

        els.btnContinue.addEventListener("click", handleJoin);
        els.btnRejoin.addEventListener("click", () => {
            streak = 0;
            saveStreak();
            updateStreakDisplay();
            handleJoin();
        });

        els.btnShare.addEventListener("click", handleShare);
    }

    // ===== 画面切り替え =====
    function showScreen(name) {
        Object.keys(screens).forEach((key) => {
            screens[key].classList.toggle("active", key === name);
        });
        currentScreen = name;
    }

    // ===== API通信 =====
    async function apiPost(path, body = {}) {
        try {
            const resp = await fetch(path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return await resp.json();
        } catch (e) {
            console.error("API error:", e);
            return null;
        }
    }

    async function apiGet(path) {
        try {
            const resp = await fetch(path);
            return await resp.json();
        } catch (e) {
            console.error("API error:", e);
            return null;
        }
    }

    // ===== 参加処理 =====
    async function handleJoin() {
        showScreen("waiting");
        stopPolling();
        stopCountdown();

        const data = await apiPost("/api/join");
        if (!data) {
            showScreen("home");
            return;
        }

        playerId = data.playerId;

        if (data.state === "selecting" && data.matchId) {
            // 即マッチング
            matchId = data.matchId;
            deadline = data.deadline;
            startSelectingPhase();
        } else {
            // 待機 → ポーリング開始
            startWaitPolling();
        }
    }

    // ===== 待機ポーリング =====
    function startWaitPolling() {
        stopPolling();
        pollTimer = setInterval(async () => {
            const data = await apiGet(
                `/api/wait?playerId=${encodeURIComponent(playerId)}`
            );
            if (!data) return;

            if (data.state === "selecting") {
                stopPolling();
                matchId = data.matchId;
                deadline = data.deadline;
                startSelectingPhase();
            } else if (data.state === "expired") {
                stopPolling();
                showScreen("home");
            }
        }, POLL_INTERVAL);
    }

    // ===== 選択フェーズ =====
    function startSelectingPhase() {
        showScreen("selecting");

        // 手の選択状態リセット
        els.handButtons.forEach((btn) => btn.classList.remove("selected"));

        // カウントダウン開始
        startCountdown();
    }

    // ===== カウントダウンタイマー =====
    function startCountdown() {
        stopCountdown();

        const circumference = 2 * Math.PI * 54; // r=54
        els.timerProgress.style.strokeDasharray = circumference;
        els.timerText.classList.remove("warning");

        function tick() {
            const now = Date.now();
            const remaining = Math.max(0, (deadline - now) / 1000);
            const seconds = Math.ceil(remaining);

            els.timerText.textContent = seconds;

            // プログレスリング
            const fraction = remaining / TIMER_DURATION;
            const offset = circumference * (1 - fraction);
            els.timerProgress.style.strokeDashoffset = offset;

            // プログレスの色
            if (seconds <= 3) {
                els.timerProgress.style.stroke = "var(--accent-red)";
                els.timerText.classList.add("warning");
            } else {
                els.timerProgress.style.stroke = "var(--accent-purple-light)";
                els.timerText.classList.remove("warning");
            }

            if (remaining <= 0) {
                stopCountdown();
                // タイムアウト → state ポーリングに切り替え（サーバーが処理する）
                if (currentScreen === "selecting") {
                    startStatePolling();
                }
                return;
            }

            countdownTimer = requestAnimationFrame(tick);
        }

        countdownTimer = requestAnimationFrame(tick);
    }

    function stopCountdown() {
        if (countdownTimer) {
            cancelAnimationFrame(countdownTimer);
            countdownTimer = null;
        }
    }

    // ===== 手の送信 =====
    async function handleMove(move) {
        if (currentScreen !== "selecting") return;

        // 選択ハイライト
        els.handButtons.forEach((btn) => {
            btn.classList.toggle("selected", btn.dataset.move === move);
        });

        const data = await apiPost("/api/move", {
            matchId,
            playerId,
            move,
        });

        if (!data || data.error) {
            // エラー時は state ポーリングで確認
            startStatePolling();
            return;
        }

        if (data.state === "result") {
            // 両者出揃った→即結果取得
            await fetchAndShowResult();
        } else {
            // ロック状態
            els.lockedMoveEmoji.textContent = MOVE_EMOJI[move] || "❓";
            showScreen("locked");
            stopCountdown();
            startStatePolling();
        }
    }

    // ===== state ポーリング =====
    function startStatePolling() {
        stopPolling();
        pollTimer = setInterval(async () => {
            const data = await apiGet(
                `/api/state?matchId=${encodeURIComponent(matchId)}&playerId=${encodeURIComponent(playerId)}`
            );
            if (!data) return;

            if (data.state === "result") {
                stopPolling();
                showResult(data);
            }
        }, POLL_INTERVAL);
    }

    async function fetchAndShowResult() {
        stopPolling();
        const data = await apiGet(
            `/api/state?matchId=${encodeURIComponent(matchId)}&playerId=${encodeURIComponent(playerId)}`
        );
        if (data && data.state === "result") {
            showResult(data);
        }
    }

    // ===== 結果表示 =====
    function showResult(data) {
        stopPolling();
        stopCountdown();

        const { outcome, reason, myMove, oppMove } = data;

        // バナー
        els.resultBanner.className = "result-banner " + outcome;

        if (outcome === "win") {
            els.resultText.textContent = "勝利！ 🎉";
            streak++;
            saveStreak();
        } else if (outcome === "lose") {
            els.resultText.textContent = "敗北... 😢";
            streak = 0;
            saveStreak();
        } else {
            els.resultText.textContent = "あいこ 🤝";
        }

        // 手の表示
        els.resultMyMove.textContent = MOVE_EMOJI[myMove] || "❓";
        els.resultOppMove.textContent = MOVE_EMOJI[oppMove] || "❓";

        // 理由
        switch (reason) {
            case "timeout_win":
                if (outcome === "win") {
                    els.resultReason.textContent = "相手がタイムアウト — 不戦勝！";
                } else {
                    els.resultReason.textContent = "タイムアウト — 不戦敗...";
                }
                break;
            case "timeout_lose":
                if (outcome === "lose") {
                    els.resultReason.textContent = "タイムアウトで敗北...";
                } else {
                    els.resultReason.textContent = "相手がタイムアウト！";
                }
                break;
            case "double_timeout":
                els.resultReason.textContent = "両者タイムアウト — 両方敗北";
                break;
            default:
                els.resultReason.textContent = "";
        }

        // 連勝表示
        updateStreakDisplay();
        els.resultStreakCount.textContent = streak;

        // ボタン表示制御
        if (outcome === "win") {
            els.btnContinue.style.display = "flex";
            els.btnRejoin.style.display = "none";
            els.btnShare.style.display = "flex";
        } else if (outcome === "lose") {
            els.btnContinue.style.display = "none";
            els.btnRejoin.style.display = "flex";
            els.btnShare.style.display = "flex";
        } else {
            // draw
            els.btnContinue.style.display = "flex";
            els.btnRejoin.style.display = "none";
            els.btnShare.style.display = "none";
        }

        showScreen("result");
    }

    // ===== キャンセル =====
    async function handleCancel() {
        stopPolling();
        stopCountdown();

        if (playerId) {
            await apiPost("/api/cancel", { playerId });
        }

        playerId = null;
        matchId = null;
        deadline = null;

        showScreen("home");
    }

    // ===== X共有 =====
    function handleShare() {
        const text =
            streak > 0
                ? `じゃんけんえんどれすで${streak}連勝！ 🔥✊✌️✋`
                : `じゃんけんえんどれすで対戦した！ ✊✌️✋`;
        const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(APP_URL)}`;
        window.open(shareUrl, "_blank", "width=550,height=420");
    }

    // ===== ポーリング管理 =====
    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // ===== 連勝管理 (localStorage) =====
    function loadStreak() {
        try {
            const val = localStorage.getItem(STORAGE_KEY);
            return val ? parseInt(val, 10) || 0 : 0;
        } catch {
            return 0;
        }
    }

    function saveStreak() {
        try {
            localStorage.setItem(STORAGE_KEY, String(streak));
        } catch {
            // silent
        }
    }

    function updateStreakDisplay() {
        els.streakCount.textContent = streak;
    }
})();
