import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { APP_CONFIG } from "./config.js";

export const supabase =
    APP_CONFIG.supabaseEnabled && APP_CONFIG.supabaseUrl && APP_CONFIG.supabaseAnonKey
        ? createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey, {
            global: { headers: { apikey: APP_CONFIG.supabaseAnonKey } },
        })
        : null;

export function getSupabaseStatus() {
    if (!APP_CONFIG.supabaseEnabled) {
        return { ready: false, message: "Supabase: 미설정" };
    }
    if (supabase) {
        return { ready: true, message: "Supabase: 준비됨" };
    }
    return { ready: false, message: "Supabase: 키 확인 필요" };
}

// 기존 세션을 반환하거나, 없으면 익명 로그인으로 새 세션을 발급합니다.
async function ensureSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return session;

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw new Error(`익명 로그인 실패: ${error.message}`);
    return data.session;
}

function localSeedInt8() {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return new DataView(buf.buffer).getBigInt64(0).toString();
}

// 리더보드 상위 n개를 가져옵니다.
// 특성 픽률 로깅 — 표시된 3개 특성과 선택된 특성을 서버에 기록합니다.
export async function logPerkPick(choices, selectedId) {
    if (!supabase) return;
    const [id1, id2, id3] = choices.map((p) => p.id);
    supabase.rpc("pick_perk", {
        perk_id1: id1 ?? null,
        perk_id2: id2 ?? null,
        perk_id3: id3 ?? null,
        selected_perk: selectedId,
    }).then(({ error }) => {
        if (error) console.warn("pick_perk 실패:", error.message);
    });
}

export async function fetchLeaderboard(n = 100) {
    if (!supabase) return { data: null, error: "no_connection" };
    const { data, error } = await supabase.rpc("get_leaderboard", { n });
    return { data, error: error?.message ?? null };
}

// hall of fame 반환 행을 리더보드 공통 포맷으로 변환합니다.
function normalizeHallOfFameEntry(entry) {
    return {
        username: entry.username ?? entry.user_name ?? entry.player_name ?? "알 수 없음",
        perk_id: entry.perk_id ?? entry.perk_name ?? "",
        score: entry.score ?? entry.final_value ?? entry.value ?? 0,
    };
}

// 특정 버전의 명예의 전당 기록을 가져옵니다.
export async function fetchHallOfFame(version) {
    if (!supabase) return { data: null, error: "no_connection" };
    const { data, error } = await supabase.rpc("get_hall_of_fame_list", { p_version: '0.63b' });
    if (error) return { data: null, error: error.message };
    return { data: data?.map(normalizeHallOfFameEntry) ?? [], error: null };
}

// 특정 퍽의 리더보드 상위 n개를 가져옵니다.
export async function fetchLeaderboardByPerk(perkId, n = 100) {
    if (!supabase) return { data: null, error: "no_connection" };
    const { data, error } = await supabase.rpc("get_leaderboard_by_perk", { perk_name: perkId, n });
    return { data, error: error?.message ?? null };
}

// get_int8_seed RPC로부터 int8 시드를 받아옵니다.
// rate_limited 응답 시 1.5초 대기 후 1회 재시도, 이후 실패 시 로컬 폴백합니다.
export async function fetchGameSeed(_gameId) {
    const TIMEOUT_MS = 2000;
    const RATE_LIMIT_RETRY_MS = 1500;

    if (!supabase) return { seedInt8: localSeedInt8(), source: "local" };

    async function requestSeed() {
        const rpcPromise = supabase.rpc("get_int8_seed");
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)
        );
        return Promise.race([rpcPromise, timeoutPromise]);
    }

    try {
        await ensureSession();

        let { data, error } = await requestSeed();

        if (!error && data?.seed) {
            return { seedInt8: data.seed, source: "supabase" };
        }

        if (data?.error === "rate_limited") {
            console.warn(`get_int8_seed rate limited, ${RATE_LIMIT_RETRY_MS}ms 후 재시도`);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
            ({ data, error } = await requestSeed());
            if (!error && data?.seed) {
                return { seedInt8: data.seed, source: "supabase" };
            }
        }

        console.warn("get_int8_seed 응답 오류, 로컬 폴백:", error ?? data);
    } catch (e) {
        console.warn("get_int8_seed 실패, 로컬 폴백:", e.message);
    }

    return { seedInt8: localSeedInt8(), source: "local" };
}

// 게임 결과를 리더보드에 업로드합니다.
export async function uploadResult({ username, seedInt8, perkId, score, log }) {
    if (!supabase) return { error: "no_connection" };

    try {
        await ensureSession();
    } catch (e) {
        console.error("세션 획득 실패:", e.message);
        return { error: "no_session" };
    }

    const { data, error } = await supabase.functions.invoke("uploadresult", {
        body: {
            username,
            seed: seedInt8,
            perk_id: perkId,
            score,
            log,
            timestamp: new Date().toISOString(),
        },
    });

    if (error) {
        const body = await error.context?.json?.().catch(() => null);
        console.error("uploadresult 실패:", error.message, "| 서버 응답:", body);
        return { error: body?.error ?? error.message ?? "unknown" };
    }

    return { data };
}

// 게임 결과를 verifygame Edge Function으로 전송합니다.
export async function submitGameResult({ gamePerkId, seedInt8, finalValue, gameplayLog }) {
    if (!supabase) return { error: "no_connection" };

    try {
        await ensureSession();
    } catch (e) {
        console.error("세션 획득 실패:", e.message);
        return { error: "no_session" };
    }

    const payload = {
        game_perk_id: gamePerkId,
        seed_value: seedInt8,
        final_value: finalValue,
        gameplay_log: gameplayLog,
    };

    const { data, error } = await supabase.functions.invoke("verifygame", { body: payload });

    if (error) {
        const body = await error.context?.json?.().catch(() => null);
        console.error("verifygame 실패:", error.message, "| 서버 응답:", body);
        return { error: body?.error ?? error.message ?? "unknown" };
    }

    console.log("verifygame 성공:", data);
    return { data };
}
