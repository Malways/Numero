// ============================================================================
// NUMERO GAME - 5턴 안에 가장 큰 숫자를 만드는 게임
// ============================================================================
// Supabase 통합은 현재 주석 처리됨 (향후 멀티플레이/리더보드용)
import { getSupabaseStatus, fetchGameSeed, submitGameResult, uploadResult, fetchLeaderboard, fetchLeaderboardByPerk, fetchHallOfFame, logPerkPick, fetchAchievements, fetchAchievementRates, fetchUserProfile } from "./supabase.js";
import { APP_CONFIG } from "./config.js";
import { LEGACY_PERKS } from "./legacyPerks.js";

// ============================================================================
// 1. 게임 상수 및 유틸 함수
// ============================================================================

const MAX_TURNS = 5; // 게임 총 5턴 진행
const REROLL_MAX_PER_GAME = 1; // 게임당 주사위 다시 굴리기 가능 횟수
const SAFE_INT_LIMIT = Number.MAX_SAFE_INTEGER; // 오버플로우 방지용 최대 안전 정수값
const ENHANCED_OPTION_CHANCE = 0; // 강화됨 선택지 등장 확률 (코더가 조정 가능)
const OPTION_APPEAR_INTERVAL_MS = 400; // 선택지 순차 등장 간격
const PERK_CHOICE_COUNT = 3; // 표시할 특성 카드 수
const DEFAULT_AUDIO_VOLUME = 0.25; // 초기 볼륨 25%
const AUDIO_VOLUME_STORAGE_KEY = "numero.audioVolume";
const USERNAME_STORAGE_KEY = "numero.username";
const DARK_MODE_STORAGE_KEY = "numero.darkMode";
const PATCH_NOTE_SEEN_STORAGE_KEY = "numero.patchNoteSeenVersion"; // 패치노트 안내를 확인한 버전

// ============================================================================
// 시드 기반 PRNG (mulberry32)
// ============================================================================
let _rng = () => Math.random(); // 시드 초기화 전 폴백

function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// int8 시드 문자열(부호 있는 64비트 정수)을 mulberry32용 uint32로 변환
function seedInt8ToUint32(int8Str) {
    const big = BigInt(int8Str);
    const lo = Number(big & 0xFFFFFFFFn) >>> 0;
    const hi = Number((big >> 32n) & 0xFFFFFFFFn) >>> 0;
    return (lo ^ hi) >>> 0;
}

function initRng(seed) {
    _rng = mulberry32(seed >>> 0);
}
// 9,007,199,254,740,991이 최대값
/**
 * 팩토리얼 계산 함수 (특급 및 전설 옵션에서 사용)
 * - n! = 1 * 2 * 3 * ... * n
 * - 21! 이상은 오버플로우 방지를 위해 SAFE_INT_LIMIT으로 제한
 */
function factorial(n) {
    if (n <= 1) return 1;
    if (n > 20) return SAFE_INT_LIMIT; // 방지: 21! 이상은 overflow
    let result = 1;
    for (let i = 2; i <= n; i++) {
        result *= i;
    }
    return result;
}

// ============================================================================
// 2. 게임 등급 정의 (4가지 레어도)
// ============================================================================
// 각 등급별 메타데이터: 이름, CSS 클래스, 색상, 순위
const RARITIES = {
    common: {
        label: "일반",
        className: "r-common",
        color: "var(--common)",
        rank: 1,
    },
    rare: {
        label: "희귀",
        className: "r-rare",
        color: "var(--rare)",
        rank: 2,
    },
    epic: {
        label: "특급",
        className: "r-epic",
        color: "var(--epic)",
        rank: 3,
    },
    legend: {
        label: "전설",
        className: "r-legend",
        color: "var(--legend)",
        rank: 4,
    },
};

// ============================================================================
// 3. 게임 선택지 라이브러리 (OPTION_LIBRARY)
// ============================================================================
// 각 등급별로 복수의 연산 옵션을 정의
// - formula: 사용자에게 표시될 수식 문자열
// - compute: 실제 계산을 수행하는 함수 (pointVal, modVal 입력)
// - unselectedLuckGain: 이 선택지를 선택하지 않았을 때 얻는 행운값
//
// 밸런스 원칙:
// - 공통(common): 초반 안정적 + 후반 약함 (×2 정도)
// - 희귀(rare): 중간 수준의 배율 (×3~6)
// - 특급(epic): 높은 배율 (×4~8)
// - 전설(legend): 폭발적 배율 (×15~1000000+)
const OPTION_LIBRARY = {
    common: [
        { //1
            formula: "pointVal + (modVal * 5) ",
            compute: (a, b) => a + b * 5,
            unselectedLuckGain: 3,
        },
        { //2
            formula: "| pointVal + modVal * 3 |",
            compute: (a, b) => Math.abs(a + b * 3),
            unselectedLuckGain: 3,
        },
        { //3
            formula: "pointVal - ( modVal * 10 ) ",
            compute: (a, b) => a - (b * 10),
            unselectedLuckGain: 3,
        },
        { //4
            formula: "pointVal * modVal",
            compute: (a, b) => a * b,
            unselectedLuckGain: 3,
        },
        { //5
            formula: "pointVal * -( modVal * 2 )",
            compute: (a, b) => a * -(b * 2),
            unselectedLuckGain: 3
        },
        { //6
            formula: "= 30 * turnVal",
            compute: (a, b, c) => 30 * c,
            unselectedLuckGain: 3
        },
        { //7
            formula: "(pointVal + pointVal * modVal) / 2 (올림)",
            compute: (a, b) => Math.ceil((a + a * b) / 2),
            unselectedLuckGain: 3
        },

    ],
    rare: [
        { //1
            formula: "pointVal + ( modVal * 10 )",
            compute: (a, b) => a + (b * 10),
            unselectedLuckGain: 6,
        },
        { //2
            formula: "| pointVal - ( modVal * 20 ) |",
            compute: (a, b) => Math.abs(a - (b * 20)),
            unselectedLuckGain: 6,
        },
        { //3
            formula: "pointVal * modVal * 2",
            compute: (a, b) => a * b * 2,
            unselectedLuckGain: 6,
        },
        { //4
            formula: "pointVal * -(modVal * 3)",
            compute: (a, b) => a * -(b * 3),
            unselectedLuckGain: 6
        },
        { //5
            formula: "pointVal * 3 + modVal",
            compute: (a, b) => (a * 3) + b,
            unselectedLuckGain: 6,
        },
        { //6
            formula: "pointVal - modVal^3",
            compute: (a, b) => a - Math.pow(b, 3),
            unselectedLuckGain: 6,
        },
        { //7
            formula: "pointVal + ( 150 - modVal * 10 )",
            compute: (a, b) => a + (150 - b * 10),
            unselectedLuckGain: 6
        },
    ],
    epic: [
        { //1
            formula: "pointVal + modVal! * 2",
            compute: (a, b) => a + factorial(b) * 2,
            unselectedLuckGain: 9,
        },
        { //2
            formula: "pointVal + modVal^4",
            compute: (a, b) => a + Math.pow(b, 4),
            unselectedLuckGain: 9,
        },
        { //3
            formula: "pointVal - modVal! * 4",
            compute: (a, b) => a - factorial(b) * 4,
            unselectedLuckGain: 9,
        },
        { //4
            formula: "pointVal - modVal^4 * turnVal",
            compute: (a, b, c) => a - Math.pow(b, 4) * c,
            unselectedLuckGain: 9,
        },
        { //5
            formula: "pointVal * modVal^2",
            compute: (a, b) => a * Math.pow(b, 2),
            unselectedLuckGain: 9
        },
        { //6
            formula: "= 500 * turnVal",
            compute: (a, b, c) => 500 * c,
            unselectedLuckGain: 9
        },
        { //7 -()로 했더니 양수처나와서 -1 곱해봄
            formula: "-(pointVal * modVal^2)",
            compute: (a, b) => -1 * (a * Math.pow(b, 2)),
            unselectedLuckGain: 9,
        },

    ],
    legend: [
        // { //1 식 표시가 이상함
        //     formula: "( pointVal / modVal^3 ) ^ 2",
        //     compute: (a, b) => Math.pow(a / Math.pow(b, 3), 2),
        //     unselectedLuckGain: 12,
        // },
        // { //2
        //     formula: "pointVal + modVal^modVal",
        //     compute: (a, b) => a + (Math.pow(b, b)) / 2,
        //     unselectedLuckGain: 12,
        // },
        // { //3
        //     formula: "pointVal - ( modVal^modVal * 2 )",
        //     compute: (a, b) => a - (Math.pow(b, b) * 2),
        //     unselectedLuckGain: 12,
        // },
        // { //4
        //     formula: "pointVal * (modVal-1)!",
        //     compute: (a, b) => a * factorial(b - 1),
        //     unselectedLuckGain: 12,
        // },

        // { //5
        //     formula: "-(pointVal * (modVal)!)",
        //     compute: (a, b) => -(a * factorial(b)),
        //     unselectedLuckGain: 12,
        // },
        // { //6
        //     formula: "-(pointVal^2)",
        //     compute: (a, b) => -(Math.pow(a, 2)),
        //     unselectedLuckGain: 12,
        // },
        // { //7
        //     formula: "= 500",
        //     compute: (a, b) => 500,
        //     unselectedLuckGain: 12,
        // },
        { //1
            formula: "= 5^modVal * turnVal",
            compute: (a, b, c) => Math.pow(5, b) * c,
            unselectedLuckGain: 12,
        },
        { //2
            formula: "pointVal * (modVal-1)^(modVal-1)",
            compute: (a, b) => a * Math.pow(b - 1, b - 1),
            unselectedLuckGain: 12,
        },
        { //3
            formula: "-(pointVal * modVal! * 5 )",
            compute: (a, b) => -(a * factorial(b) * 5),
            unselectedLuckGain: 12,
        },

        { //4
            formula: "pointVal * modVal! * 4",
            compute: (a, b) => a * factorial(b) * 4,
            unselectedLuckGain: 12,
        },

        {
            formula: "pointVal + modVal^turnVal * 5",
            compute: (a, b, c) => a + Math.pow(b, c) * 5,
            unselectedLuckGain: 12,
        }
    ],
};
// 강화됨 전용 선택지 라이브러리 (하드코드)
const ENHANCED_OPTION_LIBRARY = {
    common: [
        { //1
            formula: "pointVal + (modVal * 5) ",
            compute: (a, b) => a + b * 5,
            unselectedLuckGain: 3,
        },
        { //2
            formula: "| pointVal + modVal * 3 |",
            compute: (a, b) => Math.abs(a + b * 3),
            unselectedLuckGain: 3,
        },
        { //3
            formula: "pointVal - ( modVal * 10 ) ",
            compute: (a, b) => a - (b * 10),
            unselectedLuckGain: 3,
        },
        { //4
            formula: "pointVal * modVal",
            compute: (a, b) => a * b,
            unselectedLuckGain: 3,
        },
        { //5
            formula: "pointVal * -( modVal * 2 )",
            compute: (a, b) => a * -(b * 2),
            unselectedLuckGain: 3
        },
        { //6
            formula: "= 30 * turnVal",
            compute: (a, b, c) => 30 * c,
            unselectedLuckGain: 3
        },
        { //7
            formula: "(pointVal + pointVal * modVal) / 2 (올림)",
            compute: (a, b) => Math.ceil((a + a * b) / 2),
            unselectedLuckGain: 3
        },
    ],
    rare: [
        { //1
            formula: "pointVal + ( modVal * 10 )",
            compute: (a, b) => a + (b * 10),
            unselectedLuckGain: 6,
        },
        { //2
            formula: "| pointVal - ( modVal * 20 ) |",
            compute: (a, b) => Math.abs(a - (b * 20)),
            unselectedLuckGain: 6,
        },
        { //3
            formula: "pointVal * modVal * 2",
            compute: (a, b) => a * b * 2,
            unselectedLuckGain: 6,
        },
        { //4
            formula: "pointVal * -(modVal * 3)",
            compute: (a, b) => a * -(b * 3),
            unselectedLuckGain: 6
        },
        { //5
            formula: "pointVal * 3 + modVal",
            compute: (a, b) => (a * 3) + b,
            unselectedLuckGain: 6,
        },
        { //6
            formula: "pointVal - modVal^3",
            compute: (a, b) => a - Math.pow(b, 3),
            unselectedLuckGain: 6,
        },
        { //7
            formula: "pointVal + ( 150 - modVal * 10 )",
            compute: (a, b) => a + (150 - b * 10),
            unselectedLuckGain: 6
        },
    ],
    epic: [
        { //1
            formula: "pointVal + modVal! * 2",
            compute: (a, b) => a + factorial(b) * 2,
            unselectedLuckGain: 9,
        },
        { //2
            formula: "pointVal + modVal^4",
            compute: (a, b) => a + Math.pow(b, 4),
            unselectedLuckGain: 9,
        },
        { //3
            formula: "pointVal - modVal! * 4",
            compute: (a, b) => a - factorial(b) * 4,
            unselectedLuckGain: 9,
        },
        { //4
            formula: "pointVal - modVal^4 * turnVal",
            compute: (a, b, c) => a - Math.pow(b, 4) * c,
            unselectedLuckGain: 9,
        },
        { //5
            formula: "pointVal * modVal^2",
            compute: (a, b) => a * Math.pow(b, 2),
            unselectedLuckGain: 9
        },
        { //6
            formula: "= 500 * turnVal",
            compute: (a, b, c) => 500 * c,
            unselectedLuckGain: 9
        },
        { //7
            formula: "-(pointVal * modVal^2)",
            compute: (a, b) => -1 * (a * Math.pow(b, 2)),
            unselectedLuckGain: 9,
        },
    ],
    legend: [
        { //1
            formula: "= 5^modVal * turnVal",
            compute: (a, b, c) => Math.pow(5, b) * c,
            unselectedLuckGain: 12,
        },
        { //2
            formula: "pointVal * (modVal-1)^(modVal-1)",
            compute: (a, b) => a * Math.pow(b - 1, b - 1),
            unselectedLuckGain: 12,
        },
        { //3
            formula: "-(pointVal * modVal! * 5 )",
            compute: (a, b) => -(a * factorial(b) * 5),
            unselectedLuckGain: 12,
        },
        { //4
            formula: "pointVal * modVal! * 4",
            compute: (a, b) => a * factorial(b) * 4,
            unselectedLuckGain: 12,
        },
        {
            formula: "pointVal + modVal^turnVal * 5",
            compute: (a, b, c) => a + Math.pow(b, c) * 5,
            unselectedLuckGain: 12,
        }
    ],
};

// 끝: OPTION_LIBRARY

// ============================================================================
// 3-1. 특성 라이브러리 (PERK_LIB)
// ============================================================================
const PERK_LIB = [
    {
        id: "perk-clover",
        name: "네잎클로버",
        description: "게임 시작 전 20의 행운을 가지고 시작합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(213, 246, 239, 0.92), rgba(247, 255, 253, 0.96))",
        glitterColor: "rgba(126, 238, 198, 1)",
        glitterIntensity: 0.72,
        textColor: "#1c3436",
        applyTemplate: (gameState) => {
            gameState.luck = 20;
        },
    },
    {
        id: "perk-vento-aureo",
        name: "황금의 바람",
        description: "전설 선택지가 등장할 때마다 점수를 2배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(244, 233, 179, 0.94), rgba(255, 250, 240, 0.97))",
        glitterColor: "rgba(229,169,79, 1)",
        glitterIntensity: 0.8,
        textColor: "#463615",
        applyTemplate: (_gameState) => {
            // TODO: 특전 효과 구현 예정
        },
    },
    {
        id: "perk-67",
        name: "67",
        description: "주사위 숫자가 6이 나왔다면 7로 대체합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(224, 216, 255, 0.93), rgba(248, 246, 255, 0.97))",
        glitterColor: "rgba(176, 150, 255, 1)",
        glitterIntensity: 0.78,
        textColor: "#2f2450",
        applyTemplate: (_gameState) => {
            // TODO: 특전 효과 구현 예정
        },
    },
    {
        id: "perk-reversed-cursed",
        name: "반전 술식",
        description: "매 턴 종료 시 현재 점수가 음수라면 양수로 반전하고 2배로 만듭니다.",
        backgroundStyle: "linear-gradient(165deg, rgba(20, 20, 20, 0.96), rgba(8, 8, 8, 0.98))",
        glitterColor: "rgba(255, 255, 255, 0.9)",
        glitterIntensity: 0.55,
        textColor: "#f2f2f2",
        applyTemplate: (_gameState) => {
            // TODO: 특전 효과 구현 예정
        },
    },
    {
        id: "perk-rigged-dice",
        name: "사기 주사위",
        description: "주사위를 굴린 후 나온 눈금만큼 행운이 증가합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(154, 133, 83, 0.95), rgba(157, 132, 78, 0.98))",
        glitterColor: "rgba(255, 240, 150, 1)",
        glitterIntensity: 0.52,
        textColor: "#ffffff",
        applyTemplate: (gameState, rolledValue) => {
            const gain = Math.max(0, Math.trunc(rolledValue ?? 0));
            gameState.luck = Math.max(0, Math.trunc(gameState.luck) + gain);
        },
    },
    {
        id: "perk-jackpot",
        name: "좌살박도",
        description: "행운 166으로 시작하나, 행운이 턴마다 반감되고 고정됩니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(154, 239, 217, 0.94), rgba(138, 191, 178, 0.98))",
        glitterColor: "rgba(224, 247, 242, 1)",
        glitterIntensity: 0.7,
        textColor: "#ffffff",
        applyTemplate: (gameState) => {
            gameState.luck = 166;
        },
    },
    {
        id: "perk-last-shooting",
        name: "라스트 슈팅",
        description: "5턴 종료 후, 마지막 주사위 눈금을 2씩 줄여가며 3번 곱합니다. (최소 1)",
        backgroundStyle: "linear-gradient(160deg, rgba(252, 252, 252, 0.96), rgba(240, 240, 240, 0.99))",
        glitterColor: "rgba(255, 255, 255, 1)",
        glitterIntensity: 0.55,
        textColor: "#2f2f2f",
        applyTemplate: (_gameState) => {
            // 기능 없음
        },
    },
    {
        id: "perk-sunbang",
        name: "순방",
        description: "주사위가 6이 아니면 주사위 눈금이 1 증가합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(255, 237, 210, 0.95), rgba(255, 248, 235, 0.98))",
        glitterColor: "rgba(255, 155, 60, 1)",
        glitterIntensity: 0.6,
        textColor: "#6a2e00",
        applyTemplate: (_gameState) => {
            // 기능 없음
        },
    },
    {
        id: "perk-red-comet",
        name: "붉은 혜성",
        description: "첫 3턴간 턴 종료시 점수를 3배로 만들고, \n행운이 3분의 1만큼 감소합니다.",
        backgroundStyle: "linear-gradient(145deg, rgba(70,5,5,0.99) 0%, rgba(150,12,12,0.97) 28%, rgba(215,30,30,0.95) 48%, rgba(175,14,14,0.97) 68%, rgba(70,5,5,0.99) 100%)",
        glitterColor: "rgba(255, 160, 160, 1)",
        glitterIntensity: 0.92,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-time-warp",
        name: "시간 왜곡",
        description: "5턴 동안 스킵과 리롤을 한 번도 하지 않으면 6턴을 진행할 수 있습니다.",
        adReward: true,
        backgroundStyle: "linear-gradient(160deg, rgba(185, 232, 248, 0.93), rgba(215, 244, 253, 0.97))",
        glitterColor: "rgba(105, 204, 240, 1)",
        glitterIntensity: 0.72,
        textColor: "#0d3a4a",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-patron",
        name: "후원자",
        description: "시작 점수를 300으로 고정합니다. 광고 봐주셔서 감사해요 :)",
        adReward: true,
        backgroundStyle: "linear-gradient(160deg, rgba(255, 175, 200, 0.94), rgba(255, 215, 230, 0.96))",
        glitterColor: "rgba(240, 100, 145, 1)",
        glitterIntensity: 0.65,
        textColor: "#5a1028",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-strikeout",
        name: "쓰리 스트라이크",
        description: "주사위를 게임당 3회까지 다시 굴릴 수 있습니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(250, 245, 232, 0.97), rgba(240, 230, 210, 0.95))",
        glitterColor: "rgba(164, 25, 38, 1)",
        glitterIntensity: 0.62,
        textColor: "#8c2332",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-ready-chance",
        name: "준비된 기회",
        description: "주사위 리롤 시 눈금이 6으로 확정되고, 행운 10을 얻습니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(120, 10, 85, 0.97) 0%, rgba(200, 20, 140, 0.95) 55%, rgba(255, 70, 180, 0.94) 100%)",
        glitterColor: "rgba(255, 150, 215, 1)",
        glitterIntensity: 0.68,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-abyss-route",
        name: "심연항로",
        description: "턴 종료 시 점수가 음수면 3배로 만듭니다.",
        adReward: true,
        backgroundStyle: "linear-gradient(160deg, rgba(1, 9, 12, 0.99), rgba(1, 148, 155, 0.97), rgba(1, 223, 186, 0.95))",
        glitterColor: "rgba(229, 135, 41, 1)",
        glitterIntensity: 0.82,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-dormant-volcano",
        name: "휴화산",
        description: "500 이상의 점수를 만들면 깨어납니다...",
        backgroundStyle: "linear-gradient(160deg, rgba(58, 60, 63, 0.97) 20%, rgba(88, 87, 85, 0.95) 55%, rgba(118, 116, 112, 0.93))",
        glitterColor: "rgba(170, 172, 175, 1)",
        glitterIntensity: 0.28,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-active-volcano",
        name: "활화산",
        description: "주사위를 굴릴 때마다 눈금 × 500만큼 점수에 더합니다.",
        hidden: true,
        backgroundStyle: "linear-gradient(160deg, rgba(39, 7, 4, 0.99) 40%, rgba(198, 56, 21, 0.97) 80%, rgba(182, 45, 31, 0.95))",
        glitterColor: "rgba(253, 140, 34, 1)",
        glitterIntensity: 0.85,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-solo",
        name: "홀로서기",
        description: "턴 종료 시 점수가 홀수라면 3배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(5, 10, 35, 0.98) 0%, rgba(10, 25, 70, 0.97) 50%, rgba(8, 18, 52, 0.98) 100%)",
        glitterColor: "rgba(80, 130, 220, 1)",
        glitterIntensity: 0.68,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-moody-blues",
        name: "무디 블루스",
        adReward: true,
        description: "특급 선택지 선택 시 계산식을 두 번 적용합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(170, 171, 228, 0.96), rgba(227, 188, 250, 0.95), rgba(246, 217, 253, 0.94))",
        glitterColor: "rgba(246, 217, 253, 1)",
        glitterIntensity: 0.72,
        textColor: "#2a1545",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-joker",
        name: "조커",
        description: "일반 선택지를 고를 때마다 짐보가 점수를 5배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(247, 73, 62, 0.97), rgba(255, 152, 1, 0.96), rgba(115, 202, 255, 0.95))",
        glitterColor: "rgba(255, 152, 1, 1)",
        glitterIntensity: 0.78,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-kickstart",
        name: "킥스타터",
        description: "2턴까지 주사위를 굴릴 때마다 점수에 눈금만큼 곱합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(220, 30, 30, 0.97), rgba(255, 110, 20, 0.95))",
        glitterColor: "rgba(255, 195, 70, 1)",
        glitterIntensity: 0.8,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-beer",
        name: "맥주 한 잔",
        description: "스킵 시 7 × 현재 턴만큼 추가 행운을 얻습니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(170, 100, 10, 0.96), rgba(215, 155, 35, 0.94))",
        glitterColor: "rgba(255, 205, 50, 1)",
        glitterIntensity: 0.7,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-overclock",
        name: "오버클록",
        description: "매 턴 종료 시 점수를 (60 ÷ 행운)배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(15, 5, 0, 0.98) 0%, rgba(190, 70, 0, 0.97) 50%, rgba(255, 170, 20, 0.96) 100%)",
        glitterColor: "rgba(255, 200, 50, 1)",
        glitterIntensity: 0.88,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-death-boundary",
        name: "사의 경계",
        description: "4턴에 주사위가 4라면 점수를 44배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(8, 8, 8, 0.99), rgba(25, 4, 4, 0.98))",
        glitterColor: "rgba(234, 8, 9, 1)",
        glitterIntensity: 0.88,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-quest",
        name: "퀘스트",
        description: "퀘스트를 클리어하면 보상을 받고 다음 퀘스트를 받습니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(100, 108, 122, 0.95), rgba(56, 122, 220, 0.94), rgba(155, 60, 200, 0.94), rgba(220, 158, 30, 0.95))",
        glitterColor: "rgba(255, 255, 255, 1)",
        glitterIntensity: 0.75,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-quest-common",
        name: "일반 퀘스트",
        description: "일반 선택지 선택 시 점수를 2.5배로 만들고, 새 퀘스트를 받습니다.",
        hidden: true,
        backgroundStyle: "linear-gradient(160deg, rgba(78, 85, 97, 0.97), rgba(138, 143, 154, 0.95))",
        glitterColor: "rgba(195, 202, 215, 1)",
        glitterIntensity: 0.52,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-quest-rare",
        name: "희귀 퀘스트",
        description: "희귀 선택지 선택 시 점수를 3.5배로 만들고, 새 퀘스트를 받습니다.",
        hidden: true,
        backgroundStyle: "linear-gradient(160deg, rgba(15, 78, 155, 0.97), rgba(30, 157, 232, 0.95))",
        glitterColor: "rgba(145, 218, 255, 1)",
        glitterIntensity: 0.65,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-quest-epic",
        name: "특급 퀘스트",
        description: "특급 선택지 선택 시 점수를 4.5배로 만들고, 새 퀘스트를 받습니다.",
        hidden: true,
        backgroundStyle: "linear-gradient(160deg, rgba(55, 36, 138, 0.97), rgba(123, 97, 209, 0.95))",
        glitterColor: "rgba(207, 192, 255, 1)",
        glitterIntensity: 0.72,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-quest-legend",
        name: "전설 퀘스트",
        description: "전설 선택지 선택 시 점수를 5.5배로 만듭니다.",
        hidden: true,
        backgroundStyle: "linear-gradient(160deg, rgba(215, 100, 18, 0.97), rgba(255, 168, 65, 0.95))",
        glitterColor: "rgba(255, 225, 150, 1)",
        glitterIntensity: 0.82,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-reactor",
        name: "반응로",
        description: "매 턴 주사위를 굴리면 눈금만큼 점수에 1.2배를 반복해 적용합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(0, 221, 208, 0.97) 0%, rgba(121, 248, 253, 0.95) 50%, rgba(64, 144, 185, 0.97) 100%)",
        glitterColor: "rgba(121, 248, 253, 1)",
        glitterIntensity: 0.78,
        textColor: "#001f2a",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-energy-convert",
        name: "에너지 전환",
        adReward: true,
        description: "주사위를 굴릴 때마다 행운을 소모해 눈금을 올립니다. \n(눈금 +1당 행운 8, 최대 6)",
        backgroundStyle: "linear-gradient(160deg, rgba(5, 25, 55, 0.98) 0%, rgba(15, 90, 180, 0.97) 50%, rgba(50, 160, 255, 0.96) 100%)",
        glitterColor: "rgba(100, 200, 255, 1)",
        glitterIntensity: 0.80,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-upgrade",
        name: "업그레이드",
        description: "매 턴 종료 시 점수를 1.5배로 만듭니다. \n(스킵할 때마다 배율 +0.5)",
        backgroundStyle: "linear-gradient(160deg, rgba(8, 40, 95, 0.97) 0%, rgba(0, 145, 235, 0.96) 55%, rgba(150, 235, 255, 0.95) 100%)",
        glitterColor: "rgba(160, 235, 255, 1)",
        glitterIntensity: 0.82,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    // 레거시(선택 불가) 특성은 js/legacyPerks.js에 모여 있다 — 과거 기록 표시용
    ...LEGACY_PERKS,
];


// ============================================================================
// 4. DOM 요소 캐시 (els)
// ============================================================================
// 게임 화면의 주요 HTML 요소들을 JavaScript에서 쉽게 접근할 수 있도록 미리 저장
const els = {
    phoneFrame: document.querySelector(".phone-frame"), // 기기 프레임 (데스크탑 중앙 정렬 보정용)
    pointVal: document.getElementById("pointVal"), // 현재 점수 표시
    modVal: document.getElementById("modVal"), // 현재 턴의 주사위 값
    turnDisplay: document.getElementById("turnDisplay"), // 턴 진행 상황 (n/5)
    luckScore: document.getElementById("luckScore"), // 행운값 표시
    luckInfoBtn: document.getElementById("luckInfoBtn"), // 행운값 설명 버튼
    luckInfoFloat: document.getElementById("luckInfoFloat"), // 행운값 설명 팝업
    luckInfoSkipRule: document.getElementById("luckInfoSkipRule"), // 스킵 규칙 설명 문구
    perkBadgeBtn: document.getElementById("perkBadgeBtn"), // 특성 배지 버튼
    perkBadgeFloat: document.getElementById("perkBadgeFloat"), // 특성 설명 팝업
    perkBadgeTitle: document.getElementById("perkBadgeTitle"), // 특성 제목
    perkBadgeDesc: document.getElementById("perkBadgeDesc"), // 특성 설명
    calcLogBtn: document.getElementById("calcLogBtn"), // 계산 기록 버튼
    calcLogFloat: document.getElementById("calcLogFloat"), // 계산 기록 플로팅
    calcLogList: document.getElementById("calcLogList"), // 계산 기록 목록
    rarityBars: document.getElementById("rarityBars"), // 등급별 확률 바
    options: document.getElementById("options"), // 선택지 표시 영역
    footerPanel: document.querySelector(".footer-panel"), // 하단 버튼 영역
    startBtn: document.getElementById("startBtn"), // 게임 시작/주사위 굴리기 버튼
    seedStatusDot: document.getElementById("seedStatusDot"), // 시드 연결 상태 도트
    settingsBtn: document.getElementById("settingsBtn"), // 설정 패널 토글 버튼
    settingsFloat: document.getElementById("settingsFloat"), // 설정 패널
    patchLogBtn: document.getElementById("patchLogBtn"), // 패치노트 열기 버튼
    dbStatusEl: document.getElementById("dbStatusValue"), // DB 연결 상태 텍스트
    userNameInput: document.getElementById("userNameInput"), // 유저 이름 입력
    topUsername: document.getElementById("topUsername"), // 상단 시드 도트 옆 닉네임 표시
    surveyBtn: document.getElementById("surveyBtn"), // 설문조사 링크 버튼
    userSearchBtn: document.getElementById("userSearchBtn"), // 유저 검색 열기 버튼
    myProfileBtn: document.getElementById("myProfileBtn"), // 내 정보 보기 (내 닉네임으로 유저 검색)
    userSearchModal: document.getElementById("userSearchModal"),
    userSearchClose: document.getElementById("userSearchClose"),
    userSearchInput: document.getElementById("userSearchInput"),
    userSearchContent: document.getElementById("userSearchContent"),
    audioVolumeSlider: document.getElementById("audioVolumeSlider"), // 소리 슬라이더
    audioVolumeLabel: document.getElementById("audioVolumeLabel"), // 소리 퍼센트 라벨
    darkModeToggle: document.getElementById("darkModeToggle"),
    message: document.getElementById("message"), // 게임 메시지
    valueChangeSound: document.getElementById("valueChangeSound"), // 값 변경 카운팅 사운드
    diceRollSound: document.getElementById("diceRollSound"), // 주사위 굴림 사운드
    enhancedAppearSound: document.getElementById("enhancedAppearSound"), // 강화 선택지 등장 사운드
    perkActivateSound: document.getElementById("perkActivateSound"), // 특성 발동 사운드
    // modal
    modal: document.getElementById("modal"),
    modalMessage: document.getElementById("modalMessage"),
    modalConfirm: document.getElementById("modalConfirm"),
    modalCancel: document.getElementById("modalCancel"),
    patchLogModal: document.getElementById("patchLogModal"),
    patchLogContent: document.getElementById("patchLogContent"),
    patchLogClose: document.getElementById("patchLogClose"),
    helpBtn: document.getElementById("helpBtn"),
    helpModal: document.getElementById("helpModal"),
    helpClose: document.getElementById("helpClose"),
    perkListBtn: document.getElementById("perkListBtn"),
    perkListModal: document.getElementById("perkListModal"),
    perkListContent: document.getElementById("perkListContent"),
    perkListClose: document.getElementById("perkListClose"),
    achievementBtn: document.getElementById("achievementBtn"),
    achievementModal: document.getElementById("achievementModal"),
    achievementContent: document.getElementById("achievementContent"),
    achievementClose: document.getElementById("achievementClose"),
    creditBtn: document.getElementById("creditBtn"),
    creditModal: document.getElementById("creditModal"),
    creditContent: document.getElementById("creditContent"),
    creditClose: document.getElementById("creditClose"),
    leaderboardBtn: document.getElementById("leaderboardBtn"),
    leaderboardModal: document.getElementById("leaderboardModal"),
    leaderboardContent: document.getElementById("leaderboardContent"),
    leaderboardClose: document.getElementById("leaderboardClose"),
    leaderboardVersionFilter: document.getElementById("leaderboardVersionFilter"),
    leaderboardPerkFilter: document.getElementById("leaderboardPerkFilter"),
    confirmButtons: document.getElementById("confirmButtons"),
    confirmYes: document.getElementById("confirmYes"),
    confirmNo: document.getElementById("confirmNo"),
    // supabaseBadge: document.getElementById("supabaseBadge"),
};

// ============================================================================
// 5. 게임 상태 객체 (state)
// ============================================================================
// 게임의 모든 진행 상황을 중앙 집중식으로 관리
// 이 상태는 renderStatus()를 통해 화면에 반영됨
const state = {
    started: false, // 게임 시작 여부
    pointVal: null, // 현재 점수 (주사위 초기값부터 시작, 매 턴 연산으로 변화)
    modVal: null, // 현재 턴의 주사위 값 (1~6)
    turn: 0, // 현재 턴 번호 (1~5)
    luck: 0, // 누적 행운값 (0 이상, 확률 변화에 영향)
    options: [], // 현재 턴의 선택 가능한 3개 옵션 (option 객체 배열)
    perkChoices: [], // 현재 표시 중인 특성 후보 3개
    selectedPerkId: null, // 선택된 특성 ID
    gameId: null, // 게임 세션 ID (시드 요청 / 검증용)
    history: [], // 모든 턴의 결정 기록 (디버깅/통계용)
    phase: "perk-select", // 게임 상태 머신: perk-select -> rolling-point -> ... -> finished
    audioVolume: DEFAULT_AUDIO_VOLUME, // 현재 볼륨 (0~1)
    rollingTarget: null, // 현재 어느 주사위가 굴러가고 있는지 (pointVal or modVal)
    revealTarget: null, // 어느 주사위 결과를 보여주고 있는지 (미리보기 용)
    resolvingOptionId: null, // 선택 결과 적용 중인 옵션의 ID
    enhancedSoundTimeoutIds: [], // 강화 선택지 등장 사운드 예약 타이머
    ventoEffectTimeoutIds: [], // 황금의 선풍 효과 예약 타이머
    optionPredictionsReady: true, // 예상 결과 표시 가능 여부
    perk67Previewing: false, // perk-67 발동 시 주사위 눈 전환 중 여부
    perkSunbangPreviewing: false, // perk-sunbang 발동 시 전환 중 여부
    perkSunbangDirection: null, // perk-sunbang 방향: 'right' | 'left'
    audioWarmedUp: false, // 첫 사용자 입력에서 오디오 워밍업 여부
    allOptionsRevealed: false, // 모든 선택지가 표시되었는지 여부
    initialPointRollValue: null, // 게임 시작 시 확정된 첫 주사위 눈금
    skipUsed: false, // 이번 게임에서 스킵 사용 여부
    timewarpExtraTurn: false, // 시간 왜곡 특성으로 6턴이 추가됐는지 여부
    questLevel: "common", // 퀘스트 특성의 현재 단계: common | rare | epic | legend
    volcanoActivated: false, // 휴화산 → 활화산 전환 여부
    upgradeMultiplier: 1.5, // 업그레이드 특성의 턴 종료 배율 (스킵마다 +0.5)
    rerollCounts: {}, // 굴림별 리롤 횟수 (키: 0=시작 굴림, N=N턴). 로그 rng_v 검증용 (상한: getRerollMax)
    lastRawRolls: {}, // 굴림별 마지막 원본 눈금 (가공 전 1~6). 리롤 시 같은 눈금 제외용 — 스냅샷 복원에 휩쓸리면 안 됨
};

// ============================================================================
// 6. 유틸리티 함수들
// ============================================================================

/**
 * 값을 min~max 범위로 제한
 */
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * 1~6 범위의 주사위 눈 생성
 */
function rollDice() {
    return Math.floor(_rng() * 6) + 1;
}

// 직전 원본 눈금(prev, 1~6)을 제외한 5개 눈금 중 균등 추첨 — 리롤 전용 (rng_v=4).
// draw는 정확히 1회 소비하므로 서버 리시뮬레이션과 소비량이 어긋나지 않는다.
function rollDiceExcluding(prev) {
    const r = Math.floor(_rng() * 5) + 1; // 1~5
    return r >= prev ? r + 1 : r;
}

/**
 * 숫자에 천 단위 구분 쉼표 추가 (예: 1234567 -> "1,234,567")
 */
function formatNum(value) {
    const integerValue = Math.trunc(value);
    return integerValue.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatExponentNotation(formula) {
    return formula.replace(
        /(\([^()]+\)|[^\s]+)\s*\^\s*(\([^()]+\)|[^\s)]+)/g,
        "$1<sup>$2</sup>",
    );
}

function formatFractionNotation(formula) {
    const fractionMatch = formula.match(/^\((.+)\)\s*\/\s*([^\s]+)(.*)$/);

    if (!fractionMatch) {
        return formatExponentNotation(formula);
    }

    const [, numerator, denominator, suffix] = fractionMatch;

    return `
        <span class="formula-fraction">
            <span class="formula-fraction-top">${formatExponentNotation(numerator)}</span>
            <span class="formula-fraction-bottom">${formatExponentNotation(denominator)}</span>
        </span>${suffix}
    `.trim();
}

/**
 * 선택지 수식을 실제 값으로 치환해서 표시
 * 예: "pointVal + modVal" + pointVal=100, modVal=5 -> "100 + 5"
 */
function formatFormulaWithValues(formula, pointVal, modVal, turnVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);
    const turnText = turnVal == null ? "-" : String(turnVal);

    return formatFractionNotation(formula)
        .replace(/pointVal/g, pointText)
        .replace(/modVal/g, modText)
        .replace(/turnVal/g, turnText);
}

function formatFormulaWithValuesPlain(formula, pointVal, modVal, turnVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);
    const turnText = turnVal == null ? "-" : String(turnVal);

    return formula
        .replace(/pointVal/g, pointText)
        .replace(/modVal/g, modText)
        .replace(/turnVal/g, turnText);
}

/**
 * 선택지 카드에서 사용할 수식 하이라이트 HTML 생성
 * - pointVal: 빨간색
 * - modVal: 파란색
 * - turnVal: 초록색
 */
function formatFormulaWithHighlights(formula, pointVal, modVal, turnVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);
    const turnText = turnVal == null ? "-" : String(turnVal);

    return formatFractionNotation(formula)
        .replace(/pointVal/g, `<span class="formula-point">${pointText}</span>`)
        .replace(/modVal/g, `<span class="formula-mod">${modText}</span>`)
        .replace(/turnVal/g, `<span class="formula-turn">${turnText}</span>`);
}

/**
 * 점수가 커질수록 폰트 크기를 자동으로 줄임
 * - 9자리 이하: 24px
 * - 10~12자리: 20px
 * - 13~15자리: 17px
 * - 16~18자리: 15px
 * - 19자리 이상: 13px
 * 또한 화면 너비를 초과하면 추가로 축소
 */
function fitPointValueFont() {
    const el = els.pointVal;
    if (!el) {
        return;
    }

    const maxFontPx = 24;
    const minFontPx = 12;
    const rawValue = state.pointVal === null ? "" : String(Math.abs(Math.trunc(state.pointVal)));
    const digitCount = rawValue.length;

    el.style.whiteSpace = "nowrap";
    el.style.display = "block";
    el.style.width = "100%";
    el.style.maxWidth = "100%";

    let targetFont = maxFontPx;
    if (digitCount > 9 && digitCount <= 12) {
        targetFont = 20;
    } else if (digitCount > 12 && digitCount <= 15) {
        targetFont = 17;
    } else if (digitCount > 15 && digitCount <= 18) {
        targetFont = 15;
    } else if (digitCount > 18) {
        targetFont = 13;
    }

    el.style.fontSize = `${targetFont}px`;

    // 숫자 길이 기반 축소 후에도 넘치면 폭 기준으로 추가 축소합니다.
    let currentFont = targetFont;
    while (el.scrollWidth > el.clientWidth && currentFont > minFontPx) {
        currentFont -= 1;
        el.style.fontSize = `${currentFont}px`;
    }
}

let _prevPointValForAnim = null;
let _pointValAnimFrame = null;
let _onPointValAnimComplete = null;

// Web Audio API — Value_Change.mp3 전용 (iOS/Android playbackRate 캡 우회)
let _vacCtx = null;
let _vacGain = null;
let _vacBuffer = null;
let _vacSource = null;

function _ensureVacContext() {
    if (_vacCtx) return _vacCtx;
    _vacCtx = new (window.AudioContext || window.webkitAudioContext)();
    _vacGain = _vacCtx.createGain();
    _vacGain.gain.value = clamp(state.audioVolume ?? 0.25, 0, 1);
    _vacGain.connect(_vacCtx.destination);
    return _vacCtx;
}

function initVacAudio() {
    const ctx = _ensureVacContext();
    if (_vacBuffer) return;
    fetch("./Value_Change.mp3")
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => { _vacBuffer = buf; })
        .catch(() => { });
}

function playVacSound(rate, loop) {
    if (!_vacBuffer || !_vacCtx) return;
    _stopVacSource();
    _vacCtx.resume().catch(() => { });
    const src = _vacCtx.createBufferSource();
    src.buffer = _vacBuffer;
    src.loop = loop;
    src.playbackRate.value = rate;
    src.connect(_vacGain);
    src.start(0);
    _vacSource = src;
}

function _stopVacSource() {
    if (!_vacSource) return;
    try { _vacSource.stop(0); } catch { }
    _vacSource.disconnect();
    _vacSource = null;
}

function stopVacSound() {
    _stopVacSource();
}

function endVacLoop() {
    if (_vacSource) _vacSource.loop = false;
}

function setPointValAnimated(displayText, numericValue) {
    const el = els.pointVal;
    if (!el) return;

    const shouldAnimate =
        numericValue !== null &&
        _prevPointValForAnim !== null &&
        numericValue !== _prevPointValForAnim &&
        state.phase !== "rolling-point" &&
        state.phase !== "rolling-mod";

    const from = _prevPointValForAnim;
    if (numericValue !== null) _prevPointValForAnim = numericValue;

    if (!shouldAnimate) {
        el.textContent = displayText;
        fitPointValueFont();
        return;
    }

    if (_pointValAnimFrame !== null) {
        cancelAnimationFrame(_pointValAnimFrame); clearTimeout(_pointValAnimFrame);
        _pointValAnimFrame = null;
    }

    const to = numericValue;
    const diff = Math.abs(to - from);
    const MIN_MS = 150, MAX_MS = 3000;
    const logScale = Math.min(Math.log10(diff + 1) / 12, 1);
    const baseDuration = Math.round(MIN_MS + (MAX_MS - MIN_MS) * logScale);
    const duration = Math.round((diff >= 1_000_000_000_000 ? 2000
        : diff >= 1_000_000_000 ? 1800
            : Math.max(100, baseDuration - 200)) * 2 / 3);
    const startTime = performance.now();

    playVacSound(2.0, diff > 10);

    function easeOut(t) {
        return 1 - Math.pow(1 - t, 2.5);
    }

    function tick(now) {
        const t = Math.min((now - startTime) / duration, 1);
        el.textContent = formatNum(Math.round(from + (to - from) * easeOut(t)));
        fitPointValueFont();
        if (t < 1) {
            if (document.hidden) {
                _pointValAnimFrame = window.setTimeout(() => tick(performance.now()), 16);
            } else {
                _pointValAnimFrame = requestAnimationFrame(tick);
            }
        } else {
            _pointValAnimFrame = null;
            el.textContent = displayText;
            fitPointValueFont();
            endVacLoop();
            const cb = _onPointValAnimComplete;
            _onPointValAnimComplete = null;
            cb?.();
        }
    }

    _pointValAnimFrame = document.hidden
        ? window.setTimeout(() => tick(performance.now()), 16)
        : requestAnimationFrame(tick);
}

/**
 * 연산 결과 값을 안전한 정수로 변환
 * - NaN 및 Infinity 처리
 * - SAFE_INT_LIMIT을 넘으면 cap 처리 (오버플로우 방지)
 * - 소수점 버림 (trunc)
 */
function safeNumber(value) {
    if (Number.isNaN(value)) {
        return 0;
    }

    if (value === Infinity) {
        return SAFE_INT_LIMIT;
    }

    if (value === -Infinity) {
        return -SAFE_INT_LIMIT;
    }

    if (value > SAFE_INT_LIMIT) {
        return SAFE_INT_LIMIT;
    }

    if (value < -SAFE_INT_LIMIT) {
        return -SAFE_INT_LIMIT;
    }

    return Math.trunc(value);
}

// ============================================================================
// 7. 확률 및 선택지 생성 시스템
// ============================================================================

/**
 * 행운(Luck)에 따라 등급별 출현 확률을 계산
 * 
 * 기본 확률(luck=0):
 * - common: 56%, rare: 28%, epic: 12%, legend: 4%
 * 
 * 행운 메커니즘:
 * 1. luck 값만큼 공통부터 순차적으로 차감 (공통 -> 희귀 -> 특급 -> 전설)
 * 2. 차감한 만큼을 희귀/특급/전설에 다시 배분:
 *    - 희귀: floor(luck/3), 특급: floor(luck/3), 전설: floor(luck/3) + 나머지
 * 
 * 예: luck=9일 때
 * - 공통 56 - 9 = 47%
 * - 희귀: 28 + 3 = 31%
 * - 특급: 12 + 3 = 15%
 * - 전설: 4 + 3 + 0 = 7%
 */
function buildRarityWeights(luck) {
    const base = {
        common: 50,
        rare: 30,
        epic: 15,
        legend: 5,
    };

    const effect = Math.max(0, Math.trunc(luck));
    const weightsPercent = { ...base };

    // 1단계: luck 0~100 구간은 기존 규칙 유지
    // common -> rare -> epic -> legend 순서로 감소
    const cappedEffect = Math.min(effect, 100);
    let remainingDecrease = cappedEffect;

    const commonDecrease = Math.min(weightsPercent.common, remainingDecrease);
    weightsPercent.common -= commonDecrease;
    remainingDecrease -= commonDecrease;

    if (remainingDecrease > 0) {
        const rareDecrease = Math.min(weightsPercent.rare, remainingDecrease);
        weightsPercent.rare -= rareDecrease;
        remainingDecrease -= rareDecrease;
    }

    if (remainingDecrease > 0) {
        const epicDecrease = Math.min(weightsPercent.epic, remainingDecrease);
        weightsPercent.epic -= epicDecrease;
        remainingDecrease -= epicDecrease;
    }

    if (remainingDecrease > 0) {
        const legendDecrease = Math.min(weightsPercent.legend, remainingDecrease);
        weightsPercent.legend -= legendDecrease;
        remainingDecrease -= legendDecrease;
    }

    const splitGain = Math.floor(cappedEffect / 3);
    const remainderGain = cappedEffect - splitGain * 3;

    weightsPercent.rare += splitGain;
    weightsPercent.epic += splitGain;
    weightsPercent.legend += splitGain + remainderGain;

    // 2단계: luck 100 초과 구간은 33/33/34에서 계속 변하도록 처리
    // extra luck 1당 rare/epic에서 1%씩 legend로 이동 (번갈아 감소)
    // 결과적으로 luck 166 이상에서는 0/0/100에 수렴
    const extraLuck = Math.max(0, effect - 100);
    if (extraLuck > 0) {
        const rareShift = Math.min(weightsPercent.rare, Math.floor((extraLuck + 1) / 2));
        const epicShift = Math.min(weightsPercent.epic, Math.floor(extraLuck / 2));
        const totalShift = rareShift + epicShift;

        weightsPercent.rare -= rareShift;
        weightsPercent.epic -= epicShift;
        weightsPercent.legend += totalShift;
    }

    return {
        common: weightsPercent.common / 100,
        rare: weightsPercent.rare / 100,
        epic: weightsPercent.epic / 100,
        legend: weightsPercent.legend / 100,
    };
}

/**
 * 가중치 기반으로 등급(rarity)을 선택
 * 누적 확률로 일정 범위에 떨어지는 난수를 찾음
 * 
 * 예: 희귀 확률이 30%라면, 0~0.3 범위에서는 희귀가 선택됨
 */
function pickRarity(weights) {
    const seed = _rng();
    let cursor = 0;

    for (const key of ["common", "rare", "epic", "legend"]) {
        cursor += weights[key];
        if (seed <= cursor) {
            return key;
        }
    }

    return "common";
}

/**
 * 배열에서 무작위로 요소 하나 선택
 */
function randomOf(list) {
    return list[Math.floor(_rng() * list.length)];
}

function withAlpha(color, alpha) {
    const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/i);
    if (!match) {
        return color;
    }

    return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

function createPerkChoices(count = PERK_CHOICE_COUNT) {
    const pool = PERK_LIB.filter(perk => !perk.hidden && !perk.legacy);
    const choices = [];

    while (pool.length && choices.length < count) {
        const index = Math.floor(_rng() * pool.length);
        choices.push(pool[index]);
        pool.splice(index, 1);
    }

    return choices;
}

function getSelectedPerk() {
    if (!state.selectedPerkId) {
        return null;
    }

    if (state.selectedPerkId === "perk-quest") {
        const subPerkId = `perk-quest-${state.questLevel ?? "common"}`;
        return PERK_LIB.find((perk) => perk.id === subPerkId) ?? null;
    }

    if (state.selectedPerkId === "perk-dormant-volcano" && state.volcanoActivated) {
        return PERK_LIB.find((perk) => perk.id === "perk-active-volcano") ?? null;
    }

    return state.perkChoices.find((perk) => perk.id === state.selectedPerkId) ?? null;
}

function recordPerkSelectionHistory(perk) {
    if (!perk) {
        return;
    }

    state.history.push({
        kind: "perk-selection",
        perkId: perk.id,
        perkName: perk.name,
        perkDescription: perk.description,
    });
}

function recordPerkActivationHistory(perk, detail, extra = null) {
    if (!perk) {
        return;
    }

    state.history.push({
        kind: "perk-activation",
        perkId: perk.id,
        perkName: perk.name,
        detail,
        ...(extra ?? {}),
    });
}

function applyPerkBeforeInitialRoll() {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk) {
        return false;
    }

    if (selectedPerk.id === "perk-jackpot") {
        selectedPerk.applyTemplate(state);
        recordPerkActivationHistory(selectedPerk, `Luck을 ${state.luck}으로 변경`,
            { turn: 0, trigger: "game_start", after_luck: state.luck });
        triggerPerkBadgeActivationFeedback();
        return true;
    }

    if (selectedPerk.id !== "perk-clover") {
        return false;
    }

    selectedPerk.applyTemplate(state);
    recordPerkActivationHistory(selectedPerk, `Luck을 ${state.luck}으로 변경`,
        { turn: 0, trigger: "game_start", after_luck: state.luck });
    triggerPerkBadgeActivationFeedback();
    return true;
}

function applyPerkAfterTurnResolved() {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk) {
        return null;
    }

    if (selectedPerk.id === "perk-overclock") {
        const currentLuck = Math.max(1, state.luck ?? 1);
        const multiplier = 60 / currentLuck;
        const prevPoint = state.pointVal ?? 0;
        state.pointVal = Math.round(prevPoint * multiplier);
        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 값 ${prevPoint} → ${state.pointVal} (×${multiplier.toFixed(2)}, 행운 ${currentLuck})`,
            { turn: state.turn, trigger: "turn_end" },
        );
        triggerPerkBadgeActivationFeedback();
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `×${multiplier.toFixed(2)}`);
        return { messageText: `오버클록 (×${multiplier.toFixed(2)})`, messagePrefix: "" };
    }

    if (selectedPerk.id === "perk-upgrade") {
        const multiplier = state.upgradeMultiplier ?? 1.5;
        const prevPoint = state.pointVal ?? 0;
        state.pointVal = safeNumber(Math.round(prevPoint * multiplier));
        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 값 ${formatNum(prevPoint)} → ${formatNum(state.pointVal)} (×${multiplier.toFixed(1)})`,
            { turn: state.turn, trigger: "turn_end" },
        );
        triggerPerkBadgeActivationFeedback();
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `×${multiplier.toFixed(1)}`);
        return { messageText: `업그레이드 (×${multiplier.toFixed(1)})`, messagePrefix: "" };
    }

    if (selectedPerk.id === "perk-reversed-cursed") {
        const prevPoint = state.pointVal ?? 0;

        if (prevPoint >= 0) {
            return null;
        }

        const reversedPoint = safeNumber(prevPoint * -2);
        state.pointVal = reversedPoint;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 값 ${formatNum(prevPoint)} -> ${formatNum(reversedPoint)} (반전 × 2)`,
            { turn: state.turn, trigger: "turn_end", before_val: prevPoint, after_val: reversedPoint },
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, "반전 × 2");
        triggerPerkBadgeActivationFeedback();
        return { messageText: selectedPerk.name, messagePrefix: "" };
    }

    if (selectedPerk.id === "perk-jackpot") {
        const prevLuck = Math.max(0, Math.trunc(state.luck));
        const halvedLuck = Math.floor(prevLuck / 2);
        state.luck = halvedLuck;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: Luck ${formatNum(prevLuck)} -> ${formatNum(halvedLuck)} (절반)`,
            { turn: state.turn, trigger: "turn_end", before_luck: prevLuck, after_luck: halvedLuck },
        );
        triggerPerkBadgeActivationFeedback();
        return { messageText: `${selectedPerk.name} (Luck 절반)`, messagePrefix: "" };
    }


    if (selectedPerk.id === "perk-red-comet") {
        if (state.turn > 3) return null;

        const prevPoint = state.pointVal ?? 0;
        const prevLuck = Math.max(0, Math.trunc(state.luck));
        const tripledPoint = safeNumber(prevPoint * 3);
        const reducedLuck = Math.floor(prevLuck * 2 / 3);

        state.pointVal = tripledPoint;
        state.luck = reducedLuck;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 값 ${formatNum(prevPoint)} -> ${formatNum(tripledPoint)} (x3), Luck ${formatNum(prevLuck)} -> ${formatNum(reducedLuck)} (-1/3)`,
            { turn: state.turn, trigger: "turn_end", before_val: prevPoint, after_val: tripledPoint, before_luck: prevLuck, after_luck: reducedLuck },
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `값 x3`);
        triggerPerkBadgeActivationFeedback();
        return { messageText: `${selectedPerk.name} (값 x3, Luck -1/3)`, messagePrefix: "" };
    }

    if (selectedPerk.id === "perk-abyss-route") {
        const prevPoint = state.pointVal ?? 0;
        if (prevPoint >= 0) return null;

        const nextPoint = safeNumber(prevPoint * 3);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 음수 → × 3 (${formatNum(prevPoint)} → ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "turn_end", before_val: prevPoint, after_val: nextPoint },
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, "× 3");
        triggerPerkBadgeActivationFeedback();
        return { messageText: selectedPerk.name, messagePrefix: "" };
    }

    if (selectedPerk.id === "perk-dormant-volcano" && !state.volcanoActivated) {
        const curPoint = state.pointVal ?? 0;
        if (curPoint >= 500) {
            state.volcanoActivated = true;
            const activeVolcano = PERK_LIB.find((p) => p.id === "perk-active-volcano");
            if (activeVolcano) {
                recordPerkActivationHistory(
                    activeVolcano,
                    `Turn ${state.turn} 종료: 500점 돌파 → 활화산 발동 (${formatNum(curPoint)})`,
                    { turn: state.turn, trigger: "turn_end", after_val: curPoint },
                );
                updatePerkBadge(getSelectedPerk());
                triggerPerkBadgeActivationFeedback();
                return { messageText: "활화산 발동!", messagePrefix: "🌋 " };
            }
        }
        return null;
    }

    if (selectedPerk.id === "perk-solo") {
        const prevPoint = state.pointVal ?? 0;
        if (Math.abs(Math.trunc(prevPoint)) % 2 === 0) return null;

        const nextPoint = safeNumber(prevPoint * 3);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 홀수 값 → 값 x3 (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "turn_end", before_val: prevPoint, after_val: nextPoint },
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, "× 3");
        triggerPerkBadgeActivationFeedback();
        return { messageText: selectedPerk.name, messagePrefix: "" };
    }

    if (selectedPerk.id === "perk-joker") {
        const lastTurn = state.history.filter((item) => item.turn === state.turn && item.rarity).at(-1);
        if (!lastTurn || lastTurn.rarity !== "common" || lastTurn.isEnhanced) return null;

        const prevPoint = state.pointVal ?? 0;
        const nextPoint = safeNumber(prevPoint * 5);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 일반 선택 → 값 x5 (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "turn_end", before_val: prevPoint, after_val: nextPoint },
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, "× 5");
        triggerPerkBadgeActivationFeedback();
        return { messageText: selectedPerk.name, messagePrefix: "" };
    }

    if (selectedPerk.id.startsWith("perk-quest-")) {
        const questConfig = {
            "perk-quest-common": { rarity: "common", multiplier: 2.5, label: "일반", nextLevel: "rare" },
            "perk-quest-rare": { rarity: "rare", multiplier: 3.5, label: "희귀", nextLevel: "epic" },
            "perk-quest-epic": { rarity: "epic", multiplier: 4.5, label: "특급", nextLevel: "legend" },
            "perk-quest-legend": { rarity: "legend", multiplier: 5.5, label: "전설", nextLevel: null },
        };
        const config = questConfig[selectedPerk.id];
        const lastTurn = state.history.filter(item => item.turn === state.turn && item.rarity).at(-1);
        if (!lastTurn || lastTurn.rarity !== config.rarity) return null;

        const prevPoint = state.pointVal ?? 0;
        const nextPoint = safeNumber(prevPoint * config.multiplier);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: ${config.label} 선택 → 값 ×${config.multiplier} (${formatNum(prevPoint)} → ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "turn_end", before_val: prevPoint, after_val: nextPoint },
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `× ${config.multiplier}`);
        triggerPerkBadgeActivationFeedback();

        if (config.nextLevel) {
            state.questLevel = config.nextLevel;
            updatePerkBadge(getSelectedPerk());
        }

        return { messageText: selectedPerk.name, messagePrefix: "" };
    }


    return null;
}

async function applyPerkAfterDiceRoll(targetKey, rolledValue) {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk) return null;

    if (selectedPerk.id === "perk-energy-convert") {
        const currentLuck = state.luck ?? 0;
        if (currentLuck < 8 || rolledValue >= 6) return null;

        const luckBefore = currentLuck;
        const diceEl = targetKey === "modVal" ? els.modVal : els.pointVal;

        await wait(175);

        let increased = 0;
        while (state.luck >= 8 && state[targetKey] < 6) {
            state.luck = Math.max(0, state.luck - 8);
            state[targetKey] += 1;
            increased++;

            diceEl.classList.remove("dice-update");
            void diceEl.offsetWidth;
            diceEl.classList.add("dice-update");
            // 눈금 +1마다 특성 발동 사운드 재생 — 같은 엘리먼트를 되감으면
            // 직전 소리가 끊겨 뭉개지므로 클론으로 겹쳐 재생한다
            if (els.perkActivateSound) {
                const tick = els.perkActivateSound.cloneNode(true);
                tick.volume = els.perkActivateSound.volume;
                tick.muted = els.perkActivateSound.muted;
                tick.playbackRate = 1.0;
                tick.play().catch(() => { });
            }
            renderStatus();
            await wait(190);
        }

        diceEl.classList.remove("dice-update");

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 주사위 ${rolledValue} → ${state[targetKey]} (+${increased}, 행운 -${increased * 8})`,
            { turn: state.turn, trigger: "dice_reveal", before_luck: luckBefore, after_luck: state.luck },
        );
        // 루프 안에서 눈금마다 tick 사운드를 이미 재생했으므로 여기선 사운드 없이 배지만 갱신
        triggerPerkBadgeActivationFeedback(false);

        return { perkName: selectedPerk.name, label: `+${increased}` };
    }

    if (selectedPerk.id === "perk-strategic-retreat") {
        const startPoint = state.pointVal ?? 0;
        for (let i = 0; i < rolledValue; i++) {
            const prevPoint = state.pointVal ?? 0;
            const nextPoint = safeNumber(prevPoint - 50);
            state.pointVal = nextPoint;
            setPointValAnimated(formatNum(state.pointVal), state.pointVal);
            triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `-50`);
            triggerPerkBadgeActivationFeedback();
            await wait(100);
            if (state.pointVal === SAFE_INT_LIMIT || state.pointVal === -SAFE_INT_LIMIT) break;
        }
        const finalPoint = state.pointVal ?? 0;
        const totalDelta = finalPoint - startPoint;
        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 주사위 ${rolledValue}: -50 × ${rolledValue}회 (${formatNum(startPoint)} → ${formatNum(finalPoint)})`,
            { turn: state.turn, trigger: "dice_reveal", before_val: startPoint, after_val: finalPoint },
        );
        return { perkName: selectedPerk.name, label: formatNum(totalDelta) };
    }

    if (selectedPerk.id === "perk-active-volcano" && targetKey === "modVal") {
        const startPoint = state.pointVal ?? 0;
        for (let i = 0; i < rolledValue; i++) {
            const prevPoint = state.pointVal ?? 0;
            const nextPoint = safeNumber(prevPoint + 500);
            state.pointVal = nextPoint;
            setPointValAnimated(formatNum(state.pointVal), state.pointVal);
            triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `+500`);
            triggerPerkBadgeActivationFeedback();
            await wait(200);
            if (state.pointVal === SAFE_INT_LIMIT || state.pointVal === -SAFE_INT_LIMIT) break;
        }
        const finalPoint = state.pointVal ?? 0;
        const totalBonus = safeNumber(finalPoint - startPoint);
        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 주사위 ${rolledValue}: +${formatNum(totalBonus)} (${formatNum(startPoint)} → ${formatNum(finalPoint)})`,
            { turn: state.turn, trigger: "turn_dice", before_val: startPoint, after_val: finalPoint },
        );
        return { messageText: selectedPerk.name, messagePrefix: "" };
    }

    if (selectedPerk.id !== "perk-rigged-dice") {
        return null;
    }

    const prevLuck = Math.max(0, Math.trunc(state.luck));
    selectedPerk.applyTemplate(state, rolledValue);
    const nextLuck = Math.max(0, Math.trunc(state.luck));
    const gainedLuck = Math.max(0, nextLuck - prevLuck);

    if (gainedLuck <= 0) {
        return null;
    }

    const rollLabel = targetKey === "pointVal" ? "초기 시작 값 주사위" : `${state.turn}턴 주사위`;
    const rollTrigger = targetKey === "pointVal" ? "initial_roll" : "turn_dice";
    recordPerkActivationHistory(
        selectedPerk,
        `${rollLabel}: Luck ${formatNum(prevLuck)} -> ${formatNum(nextLuck)} (+${formatNum(gainedLuck)})`,
        { turn: state.turn, trigger: rollTrigger, before_luck: prevLuck, after_luck: nextLuck },
    );
    triggerPerkBadgeActivationFeedback();

    return {
        perkName: selectedPerk.name,
        gainedLuck,
    };
}

function getLastShootingDiceMultipliers() {
    const lastTurnEntry = state.history
        .filter((item) => item.turn === MAX_TURNS && item.modVal != null)
        .at(-1);

    if (!lastTurnEntry) return [];

    const n = Math.max(1, Math.trunc(lastTurnEntry.modVal));
    return [n, Math.max(1, n - 2), Math.max(1, n - 4)];
}

async function applyLastShootingBeforeFinish() {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk || selectedPerk.id !== "perk-last-shooting") {
        return;
    }

    const multipliers = getLastShootingDiceMultipliers();
    if (!multipliers.length) {
        return;
    }

    for (const multiplier of multipliers) {
        const prevPoint = state.pointVal ?? 0;
        const nextPoint = safeNumber((state.pointVal ?? 0) * multiplier);
        state.pointVal = nextPoint;
        const activationMessage = `특성 발동! x${multiplier} 배 증가!`;

        recordPerkActivationHistory(
            selectedPerk,
            `최종 발동: x${multiplier} 배 증가 (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "final", before_val: prevPoint, after_val: nextPoint },
        );

        // 라스트 슈팅 연출 중에는 옵션 재렌더를 막아 공개된 선택지 값이 다시 바뀌지 않게 유지합니다.
        setPointValAnimated(formatNum(state.pointVal), state.pointVal);
        renderCalcHistory();
        els.message.textContent = activationMessage;

        // 메시지를 먼저 확정하고, 같은 프레임에서 특성/값 변경 피드백을 순서대로 실행합니다.
        triggerPerkBadgeActivationFeedback();
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, nextPoint, `x${multiplier} 배 증가!`);
        await wait(500);

        // MAX_VALUE 도달 시 라스트 슈팅 루프 중단
        if (state.pointVal === SAFE_INT_LIMIT || state.pointVal === -SAFE_INT_LIMIT) {
            break;
        }
    }
}

async function applyHighlanderBeforeFinish() {
    // 원 포 올은 게임 종료 시 별도 처리 없음
}

function updateLuckInfoTooltip() {
    if (!els.luckInfoSkipRule) {
        return;
    }

    const selectedPerk = getSelectedPerk();
    if (selectedPerk?.id === "perk-jackpot") {
        els.luckInfoSkipRule.textContent = "좌살박도 선택 시 스킵 보너스는 적용되지 않습니다.";
        return;
    }

    if (selectedPerk?.id === "perk-overclock") {
        els.luckInfoSkipRule.textContent = "오버클록: 턴 종료 시 점수를 (60 ÷ 행운)배로 만듭니다. 행운이 낮을수록 배율이 높아집니다.";
        return;
    }

    if (selectedPerk?.id === "perk-upgrade") {
        els.luckInfoSkipRule.textContent = "업그레이드: 턴 종료 시 점수를 현재 배율(기본 1.5배)로 만듭니다. 스킵할 때마다 배율이 0.5씩 증가합니다.";
        return;
    }

    els.luckInfoSkipRule.textContent = "스킵 시 등장했던 모든 선택지의 2배의 Luck을 획득합니다.";
}

// ============================================================================
// 8. 선택지 생성 시스템 (ID, 선택지 조합)
// ============================================================================

/**
 * 고유 ID 생성 (각 선택지 추적용)
 * - crypto.randomUUID가 가능하면 UUID 사용
 * - 아니면 타임스탬프 + 난수 조합
 */
function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 특정 등급 이상을 뽑을 확률 계산
 * 선택지 카드에 "이 등급 이상 다음 확률: XX%"로 표시될 값
 * 
 * 예: 희귀 선택지라면 (희귀 + 특급 + 전설) 확률의 합 = 다음에 희귀 이상이 나올 확률
 */
function getAboveChance(weights, rarity) {
    if (rarity === "legend") {
        return Math.round(weights.legend * 100);
    }
    if (rarity === "epic") {
        return Math.round((weights.epic + weights.legend) * 100);
    }
    if (rarity === "rare") {
        return Math.round((weights.rare + weights.epic + weights.legend) * 100);
    }
    return 100;
}

/**
 * 한 개의 선택지 생성
 * 
 * 프로세스:
 * 1. 확률에 따라 선호 등급 결정
 * 2. 그 등급에서 미사용 공식 찾기
 * 3. 없으면 다른 등급에서 미사용 공식 찾기
 * 4. 완성된 option 객체 반환 (ID, 등급, 공식, 계산함수 등)
 */
function createOption(weights, usedFormulas = new Set()) {
    const modifier = _rng() < ENHANCED_OPTION_CHANCE ? "enhanced" : null;

    const activeLibrary = modifier === "enhanced"
        ? ENHANCED_OPTION_LIBRARY
        : OPTION_LIBRARY;
    const preferredRarity = pickRarity(weights);
    const preferredPool = activeLibrary[preferredRarity].filter(
        (item) => !usedFormulas.has(item.formula),
    );

    if (preferredPool.length) {
        const operation = randomOf(preferredPool);
        return {
            id: generateId(),
            rarity: preferredRarity,
            formula: operation.formula,
            compute: operation.compute,
            unselectedLuckGain: operation.unselectedLuckGain,
            gauge: getAboveChance(weights, preferredRarity),
            isEnhanced: modifier === "enhanced",
        };
    }

    const allAvailable = Object.entries(activeLibrary)
        .flatMap(([rarity, list]) =>
            list
                .filter((item) => !usedFormulas.has(item.formula))
                .map((item) => ({ rarity, ...item })),
        );

    if (!allAvailable.length) {
        return null;
    }

    const operation = randomOf(allAvailable);

    return {
        id: generateId(),
        rarity: operation.rarity,
        formula: operation.formula,
        compute: operation.compute,
        unselectedLuckGain: operation.unselectedLuckGain,
        gauge: getAboveChance(weights, operation.rarity),
        isEnhanced: modifier === "enhanced",
    };
}

/**
 * 중복 없는 선택지 N개 생성
 * 매 턴에 3개의 서로 다른 공식 선택지를 만들 때 사용
 * (같은 공식이 2개 이상 나오지 않도록 usedFormulas Set으로 추적)
 */
function createUniqueOptions(weights, count) {
    const usedFormulas = new Set();
    const options = [];

    while (options.length < count) {
        const option = createOption(weights, usedFormulas);
        if (!option) {
            break;
        }
        options.push(option);
        usedFormulas.add(option.formula);
    }

    return options;
}

/**
 * 현재 턴의 3개 선택지 생성 (메인 로직)
 * 
 * 프로세스:
 * 1. 현재 luck으로 등급 확률 계산
 * 2. 중복 없는 3개 선택지 생성
 * 3. 모든 선택지가 손해인지 확인 (점수 하락만 유도하는 경우)
 * 4. 만약 모두 손해면 희귀의 안정적 옵션(+modVal*2)으로 1개 대체
 */
function buildOptions() {
    const weights = buildRarityWeights(state.luck);
    const options = createUniqueOptions(weights, 3);

    const hasPositive = options.some((opt) => {
        const result = safeNumber(opt.compute(state.pointVal, state.modVal, state.turn));
        return result > state.pointVal;
    });

    // 모든 선택지가 하락만 유도하지 않도록 한 칸은 개선 가능한 선택지로 보정합니다.
    if (!hasPositive) {
        const fallback = OPTION_LIBRARY.rare.find(
            (item) => item.formula === "pointVal + (modVal * 2)",
        );
        if (fallback) {
            const fallbackIndex = options.findIndex((option) => option.formula === fallback.formula);
            const replaceIndex = fallbackIndex >= 0 ? fallbackIndex : 0;
            options[replaceIndex] = {
                id: generateId(),
                rarity: "rare",
                formula: fallback.formula,
                compute: fallback.compute,
                unselectedLuckGain: fallback.unselectedLuckGain,
                gauge: getAboveChance(weights, "rare"),
                isEnhanced: false,
            };
        }
    }

    return options;
}

// ============================================================================
// 9. 애니메이션 및 게임 플로우 제어
// ============================================================================

/**
 * 주사위 굴림 시각화 토글
 * pointVal 또는 modVal 요소에 "rolling" 클래스 추가/제거
 * (CSS에서 rolling 클래스 시 좌우 흔들림 애니메이션 적용)
 */
function setRollingVisual(target) {
    els.pointVal.classList.toggle("rolling", target === "pointVal");
    els.modVal.classList.toggle("rolling", target === "modVal");
}

// 백그라운드 탭에서도 스로틀되지 않는 타이머 워커
const _timerWorker = (() => {
    const blob = new Blob([`
        self.onmessage = function(e) {
            const { id, ms } = e.data;
            setTimeout(function() { self.postMessage({ id }); }, ms);
        };
    `], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(blob));
})();
let _timerSeq = 0;

function wait(ms) {
    return new Promise((resolve) => {
        const id = ++_timerSeq;
        const handler = (e) => {
            if (e.data.id === id) {
                _timerWorker.removeEventListener("message", handler);
                resolve();
            }
        };
        _timerWorker.addEventListener("message", handler);
        _timerWorker.postMessage({ id, ms });
    });
}

/**
 * 모달 확인 다이얼로그 표시 (Promise 반환)
 * resolve(true): 확인 버튼 클릭
 * resolve(false): 취소 버튼 클릭
 */
function showConfirmModal(message) {
    return new Promise((resolve) => {
        els.modalMessage.textContent = message;
        els.modal.setAttribute('aria-hidden', 'false');
        els.modal.classList.add('is-visible');

        let isResolved = false;

        const handleConfirm = () => {
            if (!isResolved) {
                isResolved = true;
                closeModal();
                cleanup();
                resolve(true);
            }
        };

        const handleCancel = () => {
            if (!isResolved) {
                isResolved = true;
                closeModal();
                cleanup();
                resolve(false);
            }
        };

        const cleanup = () => {
            els.modalConfirm.removeEventListener('click', handleConfirm);
            els.modalCancel.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleEscape);
        };

        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        els.modalConfirm.addEventListener('click', handleConfirm);
        els.modalCancel.addEventListener('click', handleCancel);
        document.addEventListener('keydown', handleEscape);
    });
}

/**
 * 모달 닫기
 */
function closeModal() {
    els.modal.classList.remove('is-visible');
    els.modal.setAttribute('aria-hidden', 'true');
}

function setPatchLogModalOpen(isOpen) {
    if (!els.patchLogModal) {
        return;
    }

    els.patchLogModal.classList.toggle("is-visible", isOpen);
    els.patchLogModal.setAttribute("aria-hidden", String(!isOpen));
}

function closePatchLogModal() {
    setPatchLogModalOpen(false);
}

function setPerkListModalOpen(isOpen) {
    if (!els.perkListModal) return;
    els.perkListModal.classList.toggle("is-visible", isOpen);
    els.perkListModal.setAttribute("aria-hidden", String(!isOpen));
}

const ACHIEVEMENTS = [
    { id: "first-game", name: "첫 발걸음", desc: "게임을 처음으로 완료한다." },
    { id: "billionaire", name: "누메로의 세계", desc: "최종 값 1억 이상을 달성한다." },
    { id: "no-skip", name: "스텝 바이 스텝", desc: "한 번도 스킵하지 않고 게임을 완료한다" },
    { id: "skip-master", name: "모르겠으면 일단 넘겨", desc: "5턴 중 3번 이상 스킵해 게임을 완료한다" },
    { id: "lucky-guy", name: "100% Legendary Juice", desc: "행운 166 이상인 상태로 게임을 완료한다." },
    { id: "absolute-zero", name: "Absolute Zero", desc: "게임플레이 도중 0의 점수를 달성한다." },
    { id: "perk-collector", name: "누메로 마스터", desc: "모든 특성을 플레이 완료한다." },


    { id: "clover-1", name: "깊고 작은 산골짜기 사이로", desc: "네잎클로버 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "clover-2", name: "맑은 물 흐르는 작은 샘터에", desc: "네잎클로버 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "clover-3", name: "예쁜 꽃들 사이에 살짝 숨겨진", desc: "네잎클로버 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "clover-4", name: "이슬 먹고 피어난 네잎 클로버", desc: "네잎클로버 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "wind-1", name: "각오로 열어가는 길", desc: "황금의 바람 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "wind-2", name: "황금 체험", desc: "황금의 바람 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "wind-3", name: "진혼곡", desc: "황금의 바람 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "wind-4", name: "Vento Aureo", desc: "황금의 바람 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "67-1", name: "67", desc: "67 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "67-2", name: "리쿠..아니 68", desc: "67 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "67-3", name: "69??", desc: "67 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "67-4", name: "망고", desc: "67 특성으로 최종 값 100억 이상을 달성한다." },
    { id: "67-triple7", name: "트리플 세븐", desc: "한 게임에 7을 3번 이상 뽑았습니다." },
    { id: "67-mustard", name: "머스타드", desc: "게임플레이 도중 67의 점수를 달성한다." },

    { id: "reverse-1", name: "푸른「창」", desc: "반전 술식 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "reverse-2", name: "붉은「혁」", desc: "반전 술식 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "reverse-3", name: "허식「자」", desc: "반전 술식 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "reverse-4", name: "무하한", desc: "반전 술식 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "cheat-1", name: "잃을 염려 없는 도박수", desc: "사기 주사위 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "cheat-2", name: "운명", desc: "사기 주사위 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "cheat-3", name: "운이 좋군", desc: "사기 주사위 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "cheat-4", name: "행운의 여신", desc: "사기 주사위 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "jackpot-1", name: "끓어오르는 열기", desc: "좌살박도 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "jackpot-2", name: "4분 11초", desc: "좌살박도 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "jackpot-3", name: "음량을 높여라", desc: "좌살박도 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "jackpot-4", name: "타고난 강운", desc: "좌살박도 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "forward-1", name: "안전빵", desc: "순방 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "forward-2", name: "가만히 있으면 반이라도 간다", desc: "순방 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "forward-3", name: "보장된 안전", desc: "순방 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "forward-4", name: "안정적인 고득점", desc: "순방 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "comet-1", name: "어디 한번 보여주실까", desc: "붉은 혜성 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "comet-2", name: "언제나 두 수 앞을", desc: "붉은 혜성 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "comet-3", name: "통상 3배의 점수", desc: "붉은 혜성 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "comet-4", name: "붉은 혜성", desc: "붉은 혜성 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "timewarp-1", name: "차원문 개방", desc: "시간 왜곡 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "timewarp-2", name: "까먹고 스킵한 적 솔직히 있죠?", desc: "시간 왜곡 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "timewarp-3", name: "Another One", desc: "시간 왜곡 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "timewarp-4", name: "한 턴 더! 한 턴 더!", desc: "시간 왜곡 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "sponsor-1", name: "여러분의 광고 시청은 큰 도움이..", desc: "후원자 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "sponsor-2", name: "항상 감사합니다", desc: "후원자 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "sponsor-3", name: "더 열심히 개발하겠습니다", desc: "후원자 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "sponsor-4", name: "공식 누메로 스폰서", desc: "후원자 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "abyss-1", name: "거센 파도", desc: "심연항로 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "abyss-2", name: "총원, 조명이 점멸하는...", desc: "심연항로 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "abyss-3", name: "절박 매듭", desc: "심연항로 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "abyss-4", name: "반짝이던 깊은 그 곳", desc: "심연항로 특성으로 최종 값 100억 이상을 달성한다." },
    { id: "abyss-top", name: "심해", desc: "심연항로 특성으로 최종 값 -100억 이하를 달성한다." },

    { id: "volcano-1", name: "잠잠한 산맥", desc: "휴화산 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "volcano-2", name: "폭발의 징조", desc: "휴화산 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "volcano-3", name: "갈라지는 대지", desc: "휴화산 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "volcano-4", name: "분출", desc: "휴화산 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "solo-1", name: "혼자서도 잘해요", desc: "홀로서기 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "solo-2", name: "언제나 외로이", desc: "홀로서기 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "solo-3", name: "오롯이 나 혼자", desc: "홀로서기 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "solo-4", name: "솔플컷", desc: "홀로서기 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "moody-1", name: "자존심과 체면을 걸고", desc: "무디 블루스 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "moody-2", name: "Play", desc: "무디 블루스 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "moody-3", name: "Rewind", desc: "무디 블루스 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "moody-4", name: "Record", desc: "무디 블루스 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "joker-1", name: "블러핑이 아니야", desc: "조커 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "joker-2", name: "괜찮은 패", desc: "조커 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "joker-3", name: "에이스처럼", desc: "조커 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "joker-4", name: "스트레이트 플러쉬", desc: "조커 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "kickstart-1", name: "흡입", desc: "킥스타터 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "kickstart-2", name: "압축", desc: "킥스타터 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "kickstart-3", name: "폭발", desc: "킥스타터 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "kickstart-4", name: "배기", desc: "킥스타터 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "beer-1", name: "N발의 공포탄", desc: "맥주 한 잔 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "beer-2", name: "N발의 실탄", desc: "맥주 한 잔 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "beer-3", name: "일단 한 잔 마시고", desc: "맥주 한 잔 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "beer-4", name: "운명을 겨누시게나", desc: "맥주 한 잔 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "overclock-1", name: "과부하", desc: "오버클록 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "overclock-2", name: "아직까지는 괜찮아", desc: "오버클록 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "overclock-3", name: "리미터 해제", desc: "오버클록 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "overclock-4", name: "속박과 대가", desc: "오버클록 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "death-1", name: "삭여라,", desc: "사의 경계 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "death-2", name: "그리고 새겨라.", desc: "사의 경계 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "death-3", name: "선택지와 행운,", desc: "사의 경계 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "death-4", name: "그리고 주사위가 전부인 게임이다", desc: "사의 경계 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "quest-1", name: "세상의 끝에 그 저편에서", desc: "퀘스트 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "quest-2", name: "만약 마왕을 쓰러뜨렸다면", desc: "퀘스트 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "quest-3", name: "엔딩 롤이 흘러내려간다면", desc: "퀘스트 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "quest-4", name: "우리들의 내일은 어디에", desc: "퀘스트 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "reactor-1", name: "반응로 시동", desc: "반응로 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "reactor-2", name: "분열 과정 유도", desc: "반응로 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "reactor-3", name: "에너지 발생 확인", desc: "반응로 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "reactor-4", name: "터빈을 돌려라", desc: "반응로 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "energy-1", name: "적절한 거래", desc: "에너지 전환 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "energy-2", name: "괜찮은 교환비", desc: "에너지 전환 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "energy-3", name: "약간의 희생", desc: "에너지 전환 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "energy-4", name: "교환 성공", desc: "에너지 전환 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "lastshoot-1", name: "대지에 서다", desc: "라스트 슈팅 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "lastshoot-2", name: "메인 카메라가 당했을 뿐이야", desc: "라스트 슈팅 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "lastshoot-3", name: "라스트 슈팅", desc: "라스트 슈팅 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "lastshoot-4", name: "돌아갈 곳이 있어", desc: "라스트 슈팅 특성으로 최종 값 100억 이상을 달성한다." },
    { id: "lastshoot-782", name: "오퍼레이션 V", desc: "게임플레이 도중 782의 점수를 달성한다." },

    { id: "upgrade-1", name: "Harder", desc: "업그레이드 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "upgrade-2", name: "Better", desc: "업그레이드 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "upgrade-3", name: "Faster", desc: "업그레이드 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "upgrade-4", name: "Stronger", desc: "업그레이드 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "strikeout-1", name: "스트라이크아웃", desc: "쓰리 스트라이크 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "strikeout-2", name: "9회말", desc: "쓰리 스트라이크 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "strikeout-3", name: "결정타", desc: "쓰리 스트라이크 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "strikeout-4", name: "만루 홈런", desc: "쓰리 스트라이크 특성으로 최종 값 100억 이상을 달성한다." },

    { id: "ready-1", name: "준비된 자에게는", desc: "준비된 기회 특성으로 최종 값 1만 이상을 달성한다." },
    { id: "ready-2", name: "회생의 기회", desc: "준비된 기회 특성으로 최종 값 100만 이상을 달성한다." },
    { id: "ready-3", name: "선택은 자유", desc: "준비된 기회 특성으로 최종 값 1억 이상을 달성한다." },
    { id: "ready-4", name: "하이라이트", desc: "준비된 기회 특성으로 최종 값 100억 이상을 달성한다." },
];

// 도전과제 id 접두사 → 특성 id (특성별 과제의 색상 표시용)
const ACHIEVEMENT_PREFIX_TO_PERK = {
    clover: "perk-clover",
    wind: "perk-vento-aureo",
    "67": "perk-67",
    reverse: "perk-reversed-cursed",
    cheat: "perk-rigged-dice",
    jackpot: "perk-jackpot",
    forward: "perk-sunbang",
    comet: "perk-red-comet",
    timewarp: "perk-time-warp",
    sponsor: "perk-patron",
    abyss: "perk-abyss-route",
    volcano: "perk-dormant-volcano",
    solo: "perk-solo",
    moody: "perk-moody-blues",
    joker: "perk-joker",
    kickstart: "perk-kickstart",
    beer: "perk-beer",
    overclock: "perk-overclock",
    death: "perk-death-boundary",
    quest: "perk-quest",
    reactor: "perk-reactor",
    energy: "perk-energy-convert",
    lastshoot: "perk-last-shooting",
    upgrade: "perk-upgrade",
    strikeout: "perk-strikeout",
    ready: "perk-ready-chance",
};

// 상단 시드 도트 옆에 현재 닉네임을 표시합니다 (미설정 시 "익명").
function updateTopUsername() {
    if (!els.topUsername) return;
    const username = localStorage.getItem(USERNAME_STORAGE_KEY)?.trim().slice(0, 10);
    els.topUsername.textContent = `닉네임 : ${username || "익명"}`;
}

function getAchievementPerk(achievementId) {
    const prefix = achievementId.slice(0, achievementId.lastIndexOf("-"));
    const perkId = ACHIEVEMENT_PREFIX_TO_PERK[prefix];
    return perkId ? PERK_LIB.find((p) => p.id === perkId) ?? null : null;
}

// unlocked: Map<achievementId, unlockedAt(ISO string | null)>
// rates: Map<achievementId, 달성률(%) > | null (로딩 전)
function renderAchievementList(unlocked, rates) {
    els.achievementContent.innerHTML = ACHIEVEMENTS.map(a => {
        const isUnlocked = unlocked.has(a.id);
        const unlockedAt = unlocked.get(a.id);
        const dateLabel = isUnlocked && unlockedAt
            ? `<p class="achievement-date">${new Date(unlockedAt).toLocaleDateString("ko-KR")} 달성</p>`
            : "";
        const percent = rates ? (rates.get(a.id) ?? 0) : null;
        const rateLabel = percent !== null
            ? `<span class="achievement-rate">${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%</span>`
            : "";

        // 특성별 과제는 해금 시 해당 특성의 색으로 표시
        const perk = isUnlocked ? getAchievementPerk(a.id) : null;
        const perkClass = perk ? " perk-colored" : "";
        const perkStyle = perk
            ? ` style="background:${perk.backgroundStyle}; border-color:${withAlpha(perk.glitterColor, 0.55)}; --ach-text:${perk.textColor || "#1a2233"};"`
            : "";

        return `<div class="achievement-card${isUnlocked ? "" : " locked"}${perkClass}"${perkStyle}>
            <div class="achievement-body">
                <p class="achievement-name">${a.name}</p>
                <p class="achievement-desc">${a.desc}</p>
                ${dateLabel}
            </div>
            <div class="achievement-side">
                <span class="achievement-lock">${isUnlocked ? "✅" : "🔒"}</span>
                ${rateLabel}
            </div>
        </div>`;
    }).join("");
}

function openAchievementModal() {
    if (!els.achievementContent || !els.achievementModal) return;

    // 서버 저장 규칙(trim + 10자 제한)과 동일하게 정규화
    const username = localStorage.getItem(USERNAME_STORAGE_KEY)?.trim().slice(0, 10);

    let unlocked = new Map();
    let rates = null;
    const render = () => {
        renderAchievementList(unlocked, rates);
        if (!username) {
            els.achievementContent.insertAdjacentHTML(
                "afterbegin",
                `<div class="achievement-anon-notice">익명으로 플레이 중! 닉네임을 설정하고 도전과제를 동기화하세요!</div>`,
            );
        }
    };

    render();
    els.achievementModal.classList.add("is-visible");
    els.achievementModal.setAttribute("aria-hidden", "false");

    // 전체 달성률은 익명 여부와 무관하게 표시 (fire-and-forget)
    fetchAchievementRates().then(({ data }) => {
        if (!Array.isArray(data)) return;
        if (!els.achievementModal.classList.contains("is-visible")) return;
        rates = new Map(data.map((r) => [
            r.achievement_id,
            r.total_players > 0 ? (r.unlock_count / r.total_players) * 100 : 0,
        ]));
        render();
    });

    // 익명 플레이 중이면 해금 목록 동기화는 생략
    if (!username) return;

    fetchAchievements(username).then(({ data, error }) => {
        if (error || !Array.isArray(data)) return;
        if (!els.achievementModal.classList.contains("is-visible")) return;
        // 구버전 RPC(문자열 배열)와 신버전({achievement_id, unlocked_at}) 모두 지원
        unlocked = new Map(data.map((row) =>
            typeof row === "string" ? [row, null] : [row.achievement_id, row.unlocked_at ?? null]
        ));
        render();
    });
}

// ============================================================================
// 유저 검색 모달
// ============================================================================

function openUserSearchModal() {
    if (!els.userSearchModal) return;
    els.userSearchModal.classList.add("is-visible");
    els.userSearchModal.setAttribute("aria-hidden", "false");
    if (els.userSearchInput) {
        els.userSearchInput.value = "";
        els.userSearchInput.focus();
    }
    if (els.userSearchContent) {
        els.userSearchContent.innerHTML = `<p class="user-search-hint">닉네임으로 유저의 기록을 검색해보세요.</p>`;
    }
}

function closeUserSearchModal() {
    if (!els.userSearchModal) return;
    els.userSearchModal.classList.remove("is-visible");
    els.userSearchModal.setAttribute("aria-hidden", "true");
}

// 유저 검색: 서버에서 프로필을 받아 렌더링합니다.
async function searchAndRenderUserProfile(query) {
    if (!els.userSearchContent) return;

    els.userSearchContent.innerHTML = `<p class="user-search-hint">검색 중...</p>`;

    const { data, error } = await fetchUserProfile(query);

    // 모달이 닫혔거나 그 사이 다른 검색이 시작됐으면 무시
    if (!els.userSearchModal?.classList.contains("is-visible")) return;

    if (error || !data) {
        els.userSearchContent.innerHTML = `<p class="user-search-hint">검색에 실패했습니다. 잠시 후 다시 시도해주세요.</p>`;
        console.warn("유저 검색 실패:", error);
        return;
    }

    if (!data.found) {
        els.userSearchContent.innerHTML = `<p class="user-search-hint">'${escapeHtml(query)}' 유저의 기록을 찾을 수 없습니다.</p>`;
        return;
    }

    renderUserSearchProfile(query, {
        allTimeBest: data.all_time_best ?? 0,
        seasonBest: data.season_best,           // 시즌 기록 없으면 null
        seasonPlays: data.season_plays ?? 0,
        achievementCount: data.achievement_count ?? 0,
        achievementTotal: ACHIEVEMENTS.length,
        perksPlayed: data.perks_played ?? 0,
        perksTotal: PERK_LIB.filter((p) => !p.hidden && !p.legacy).length,
        playedPerks: Array.isArray(data.played_perks) ? data.played_perks : null,
        favoritePerkId: data.favorite_perk ?? null,
        recentGames: Array.isArray(data.recent_games)
            ? data.recent_games.map((g) => ({ perkId: g.perk_id, score: g.score, ts: g.ts }))
            : [],
    });
}

// 옛/파생 특성 id를 현행 선택 가능 id로 정규화 (서버 normalizeCollectorPerk와 동일 규칙)
function normalizePlayedPerkId(perkId) {
    if (typeof perkId !== "string") return "";
    if (perkId.startsWith("perk-quest")) return "perk-quest";
    if (perkId === "perk-active-volcano") return "perk-dormant-volcano";
    if (perkId === "perk-clock-up") return "perk-upgrade";
    return perkId;
}

// 검색된 유저의 프로필 통계를 렌더링합니다.
function renderUserSearchProfile(username, stats) {
    if (!els.userSearchContent) return;

    const favoritePerk = PERK_LIB.find((p) => p.id === stats.favoritePerkId) ?? null;

    // 점수 수준별 등급 색: 동(10만+) < 은(1000만+) < 금(10억+) < 다이아(1000억+) < 마스터(10조+)
    const scoreTierClass = (score) => {
        if (score >= 1e13) return "tier-master";
        if (score >= 1e11) return "tier-diamond";
        if (score >= 1e9) return "tier-gold";
        if (score >= 1e7) return "tier-silver";
        if (score >= 1e5) return "tier-bronze";
        return "";
    };

    // 시즌 플레이 횟수 등급: 동(10+) < 은(50+) < 금(100+) < 다이아(1000+) < 마스터(5000+)
    const playsTierClass = (plays) => {
        if (plays >= 1000) return "tier-master";
        if (plays >= 500) return "tier-diamond";
        if (plays >= 100) return "tier-gold";
        if (plays >= 50) return "tier-silver";
        if (plays >= 10) return "tier-bronze";
        return "";
    };

    // 도전과제 등급: 동(10+) < 은(30+) < 금(50+) < 다이아(70+) < 마스터(전체 달성)
    const achievementTier = stats.achievementCount >= stats.achievementTotal ? "tier-master"
        : stats.achievementCount >= 70 ? "tier-diamond"
            : stats.achievementCount >= 50 ? "tier-gold"
                : stats.achievementCount >= 30 ? "tier-silver"
                    : stats.achievementCount >= 10 ? "tier-bronze"
                        : "";

    // 플레이한 특성 등급: 동(5+) < 은(10+) < 금(15+) < 다이아(20+) < 마스터(전체 달성)
    // 플레이한/미플레이 특성 대조 — RPC가 played_perks를 주면 카드 클릭 시 미플레이 목록 표시
    const selectablePerks = PERK_LIB.filter((p) => !p.hidden && !p.legacy);
    const playedSet = Array.isArray(stats.playedPerks)
        ? new Set(stats.playedPerks.map(normalizePlayedPerkId))
        : null;
    const unplayedPerks = playedSet ? selectablePerks.filter((p) => !playedSet.has(p.id)) : null;
    const playedCount = unplayedPerks ? selectablePerks.length - unplayedPerks.length : stats.perksPlayed;

    const perksTier = playedCount >= stats.perksTotal ? "tier-master"
        : playedCount >= 20 ? "tier-diamond"
            : playedCount >= 15 ? "tier-gold"
                : playedCount >= 10 ? "tier-silver"
                    : playedCount >= 5 ? "tier-bronze"
                        : "";

    // 최다 플레이 특성 이름은 줄바꿈 없이 한 줄 유지 — 길이에 따라 글자 크기 단계 축소
    // 인라인 font-size 대신 CSS 변수로 넘겨 모바일 미디어 쿼리가 축소분을 적용할 수 있게 함
    const favoriteName = favoritePerk?.name ?? "-";
    const favoriteFontPx = favoriteName.length <= 4 ? 40
        : favoriteName.length <= 6 ? 28
            : favoriteName.length <= 10 ? 19
                : 15;
    const favoriteFontMobilePx = favoriteName.length <= 4 ? 22
        : favoriteName.length <= 6 ? 16
            : favoriteName.length <= 10 ? 12
                : 10;

    const hasSeasonRecord = stats.seasonBest != null;
    const rows = [
        { label: "역대 최고 점수", value: formatNum(stats.allTimeBest), score: true, tier: scoreTierClass(stats.allTimeBest) },
        {
            label: "시즌 최고 점수",
            value: hasSeasonRecord ? formatNum(stats.seasonBest) : "-",
            score: true,
            tier: hasSeasonRecord ? scoreTierClass(stats.seasonBest) : "",
        },
        { label: "이번 시즌 플레이 횟수", value: `${formatNum(stats.seasonPlays)}회`, centered: true, tier: playsTierClass(stats.seasonPlays) },
        { label: "도전과제", value: `${stats.achievementCount}/${stats.achievementTotal}`, centered: true, tier: achievementTier },
        { label: "플레이한 특성", value: `${playedCount}/${stats.perksTotal}`, centered: true, tier: perksTier, expandable: unplayedPerks != null },
        {
            label: "최다 플레이 특성",
            value: favoriteName,
            perk: favoritePerk,
            centered: true,
            valueStyle: `--fav-font:${favoriteFontPx}px; --fav-font-mobile:${favoriteFontMobilePx}px; white-space:nowrap;`,
        },
    ];

    const recentGames = stats.recentGames ?? [];

    const formatRecentTs = (ts) => {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const recentRows = recentGames.map((game) => {
        const perk = PERK_LIB.find((p) => p.id === game.perkId) ?? null;
        const chipStyle = perk
            ? ` style="background:${perk.backgroundStyle}; border-color:${withAlpha(perk.glitterColor, 0.55)}; color:${perk.textColor || "#16292d"};"`
            : "";
        return `
            <div class="user-recent-row">
                <span class="user-recent-perk"${chipStyle}>${escapeHtml(perk?.name ?? "-")}</span>
                <span class="user-recent-score">${formatNum(game.score)}</span>
                <span class="user-recent-date">${formatRecentTs(game.ts)}</span>
            </div>`;
    }).join("");

    els.userSearchContent.innerHTML = `
        <p class="user-profile-name">${escapeHtml(username)}</p>
        <div class="user-stat-list">
            ${rows.map((row) => {
        // 특성 카드는 해당 특성의 배경/글자색 + 글린트 색 적용
        // data-perk-id로 전용 글린트(라스트 슈팅, 붉은 혜성 등)도 연결
        const perkStyle = row.perk
            ? ` data-perk-id="${row.perk.id}" style="background:${row.perk.backgroundStyle}; border-color:${withAlpha(row.perk.glitterColor, 0.55)}; --stat-text:${row.perk.textColor || "#16292d"}; --tier-glitter:${row.perk.glitterColor}; --stat-glitter-opacity:${row.perk.glitterIntensity ?? 0.6};"`
            : "";
        const classes = [
            "user-stat-row",
            row.perk ? "perk-colored" : "",
            row.centered ? "center-value" : "",
            row.score ? "center-score" : "",
            row.expandable ? "stat-expandable" : "",
            row.tier || "",
        ].filter(Boolean).join(" ");
        const valueStyle = row.valueStyle ? ` style="${row.valueStyle}"` : "";
        const expandAttr = row.expandable ? ` role="button" tabindex="0" aria-expanded="false"` : "";
        const hint = row.expandable ? `<span class="stat-expand-hint">미플레이 보기 ▾</span>` : "";
        return `
                <div class="${classes}"${perkStyle}${expandAttr}>
                    <span class="user-stat-label">${row.label}</span>
                    <span class="user-stat-value"${valueStyle}>${escapeHtml(String(row.value))}</span>
                    ${hint}
                </div>`;
    }).join("")}
        </div>
        ${unplayedPerks != null ? renderUnplayedPanel(unplayedPerks) : ""}
        <p class="user-recent-title">최근 기록</p>
        <div class="user-recent-list">${recentRows || `<p class="user-search-hint">이번 시즌 기록이 없습니다.</p>`}</div>`;

    // "플레이한 특성" 카드 클릭 시 미플레이 패널 토글
    const expandCard = els.userSearchContent.querySelector(".user-stat-row.stat-expandable");
    const panel = els.userSearchContent.querySelector(".user-unplayed-panel");
    if (expandCard && panel) {
        const toggle = () => {
            const open = panel.classList.toggle("is-open");
            expandCard.setAttribute("aria-expanded", open ? "true" : "false");
            expandCard.classList.toggle("is-expanded", open);
        };
        expandCard.addEventListener("click", toggle);
        expandCard.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        });
    }
}

// 미플레이 특성 목록 패널 HTML — 플레이한 특성 카드 클릭 시 펼쳐짐
function renderUnplayedPanel(unplayedPerks) {
    if (unplayedPerks.length === 0) {
        return `<div class="user-unplayed-panel">
            <p class="user-unplayed-done">🏆 모든 특성을 플레이했습니다!</p>
        </div>`;
    }
    const chips = unplayedPerks.map((perk) =>
        `<span class="user-unplayed-chip">${escapeHtml(perk.name)}</span>`
    ).join("");
    return `<div class="user-unplayed-panel">
        <p class="user-unplayed-title">아직 플레이하지 않은 특성 (${unplayedPerks.length})</p>
        <div class="user-unplayed-chips">${chips}</div>
    </div>`;
}

// 게임 화면 우상단에 토스트를 띄우는 공용 헬퍼.
// onClick이 있으면 클릭 시 실행 후 닫힘, 없으면 클릭 시 즉시 닫힘.
function spawnGameToast({ icon, title, text, durationMs = 3500, className = "", onClick = null }) {
    let container = document.querySelector(".achievement-toast-container");
    if (!container) {
        container = document.createElement("div");
        container.className = "achievement-toast-container";
        // 데스크탑에서 검은 베젤 안(게임 화면 내부)에 위치하도록 phone-screen에 부착
        (document.querySelector(".phone-screen") ?? document.body).appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `achievement-toast${className ? ` ${className}` : ""}`;
    toast.innerHTML = `<span class="achievement-toast-icon">${icon}</span>
        <div>
            <div class="achievement-toast-title">${escapeHtml(title)}</div>
            <div class="achievement-toast-name">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
        </div>`;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("show"));

    const dismiss = () => {
        if (toast.classList.contains("hide")) return;
        toast.classList.remove("show");
        toast.classList.add("hide");
        setTimeout(() => toast.remove(), 500);
    };
    toast.addEventListener("click", () => {
        if (onClick) onClick();
        dismiss();
    });
    setTimeout(dismiss, durationMs);
}

// 우측 상단에 도전과제 달성 토스트를 띄웁니다.
function showAchievementToast(name) {
    spawnGameToast({ icon: "🏆", title: "도전과제 달성!", text: name });
}
// 콘솔 테스트용: showAchievementToast("테스트")
window.showAchievementToast = showAchievementToast;

// 서버 검증 거부 시 경고 토스트 — 클릭하면 게임플레이 로그를 클립보드에 복사합니다.
function showRecordRejectedToast(logText) {
    spawnGameToast({
        icon: "⚠️",
        title: "경고",
        text: "최근 게임이 리더보드 등재에 실패했습니다. 이유는 다음 중 하나입니다.\n- 한 게임이 20분 이상 지속되었을 경우\n- 부정행위로 플레이 기록과 값이 불일치한 경우\n그렇지 않을 경우, 이 버튼을 눌러 로그를 복사해\n개발자에게 문의 부탁드립니다.",
        durationMs: 10000,
        className: "toast-warning",
        onClick: () => {
            copyTextToClipboard(logText).catch(() => {
                console.warn("로그 복사 실패");
            });
        },
    });
}
// 콘솔 테스트용: showRecordRejectedToast("{}")
window.showRecordRejectedToast = showRecordRejectedToast;

// 미지원 구버전 클라이언트 안내 토스트 — 클릭하면 새로고침해 최신 버전을 받습니다.
function showUpdateRequiredToast() {
    spawnGameToast({
        icon: "⚠️",
        title: "업데이트 필요",
        text: "지원되지 않는 구버전이라 리더보드 등재에 실패했습니다. 클릭해 최신 버전으로 업데이트해 주세요.",
        durationMs: 10000,
        className: "toast-warning",
        onClick: () => window.location.reload(),
    });
}
// 콘솔 테스트용: showUpdateRequiredToast()
window.showUpdateRequiredToast = showUpdateRequiredToast;

// 리더보드 등재 성공 토스트 — 1초 후 자동 소멸.
function showUploadSuccessToast() {
    spawnGameToast({
        icon: "✅",
        title: "업로드 완료",
        text: "기록이 리더보드에 등재되었습니다.",
        durationMs: 1000,
    });
}
// 콘솔 테스트용: showUploadSuccessToast()
window.showUploadSuccessToast = showUploadSuccessToast;

// 설문조사 링크
const SURVEY_URL = "https://forms.gle/ztfvzWSNwaYymd4NA";

function openSurvey() {
    window.open(SURVEY_URL, "_blank", "noopener");
}

// 마지막 패치일로부터 3일 이내면, 새로고침 시 패치노트 안내 토스트를 표시합니다.
// 클릭하면 패치노트 모달이 열립니다.
function showPatchNoteToast() {
    const raw = APP_CONFIG.lastPatchDate;
    if (!raw) return;

    const patchDate = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(patchDate.getTime())) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.floor((today - patchDate) / 86_400_000);
    if (diffDays < 0 || diffDays > 3) return; // 배포일 당일~3일까지만 안내

    // 이미 이번 버전의 패치노트를 확인했다면(클릭했다면) 다음 업데이트 전까지 표시하지 않음
    try {
        if (window.localStorage.getItem(PATCH_NOTE_SEEN_STORAGE_KEY) === APP_CONFIG.version) return;
    } catch (e) { /* localStorage 접근 불가 시 그냥 표시 */ }

    spawnGameToast({
        icon: "ℹ️",
        title: `업데이트 ${APP_CONFIG.version}`,
        text: "새로운 패치가 적용되었어요!\n눌러서 패치노트를 확인하세요.",
        durationMs: 5000,
        onClick: () => {
            // 확인 처리 — 다음 버전이 나올 때까지 이 안내를 다시 띄우지 않음
            try {
                window.localStorage.setItem(PATCH_NOTE_SEEN_STORAGE_KEY, APP_CONFIG.version);
            } catch (e) { /* 저장 실패해도 패치노트는 연다 */ }
            openPatchLogModal();
        },
    });
}

// 게임 로드 시 설문조사 안내 토스트 — 이동 없이 설정 메뉴의 설문 버튼만 안내합니다.
function showSurveyToast() {
    spawnGameToast({
        icon: "📋",
        title: "설문조사",
        text: "게임플레이 후 설문으로 보상 받으세요! (설정 버튼 참고)",
        durationMs: 3000,
    });
}

function openPerkListModal() {
    if (!els.perkListContent) return;

    const perks = PERK_LIB.filter(p => !p.hidden && !p.legacy)
        .sort((a, b) => (a.adReward ? 1 : 0) - (b.adReward ? 1 : 0));

    const normalCount = perks.filter(p => !p.adReward).length;
    const adCount = perks.filter(p => p.adReward).length;
    const counter = `<div class="perk-list-counter">
        <span class="perk-count-badge perk-count-normal">사용 가능 <b>${normalCount}</b></span>
        <span class="perk-count-badge perk-count-ad">광고 보상 <b>${adCount}</b></span>
    </div>`;

    els.perkListContent.innerHTML = counter + perks.map((perk) => {
        const accentShadow = withAlpha(perk.glitterColor, 0.18 + perk.glitterIntensity * 0.22);
        const cardStyle = `--perk-bg:${perk.backgroundStyle}; --perk-glitter:${perk.glitterColor}; --perk-glitter-opacity:${perk.glitterIntensity}; --perk-accent:${perk.glitterColor}; --perk-accent-shadow:${accentShadow};`;
        const adBadge = perk.adReward
            ? `<span class="perk-ad-badge" style="color:${perk.textColor || '#13272b'}">광고 시청 보상</span>`
            : "";
        return `
            <div class="option-btn perk-option-btn" data-perk-id="${perk.id}" style="${cardStyle}">
                ${adBadge}
                <p class="perk-name">${perk.name}</p>
                <p class="perk-description">${perk.description}</p>
            </div>`;
    }).join("");

    setPerkListModalOpen(true);
}

function setLeaderboardModalOpen(isOpen) {
    if (!els.leaderboardModal) return;
    els.leaderboardModal.classList.toggle("is-visible", isOpen);
    els.leaderboardModal.setAttribute("aria-hidden", String(!isOpen));
}

function closeLeaderboardModal() {
    setLeaderboardModalOpen(false);
}

function renderLeaderboardData(data) {
    if (!els.leaderboardContent) return;

    if (!data || data.length === 0) {
        els.leaderboardContent.innerHTML = '<p class="patchlog-loading">아직 기록이 없습니다.</p>';
        return;
    }

    const perkMap = Object.fromEntries(PERK_LIB.map((p) => [p.id, p]));

    // 익명 기록은 프로필 조회 대상에서 제외
    const isAnonymousName = (name) => /^익명 #\d+$/.test(name ?? "");
    // 닉네임을 클릭 가능한 프로필 링크로 감싼다 (익명은 일반 텍스트)
    const usernameLink = (name) => isAnonymousName(name)
        ? escapeHtml(name)
        : `<span class="lb-user-link" data-profile-user="${escapeHtml(name)}">${escapeHtml(name)}</span>`;

    const rows = data.map((entry, i) => {
        const rank = i + 1;
        const rankClass = rank <= 3 ? "leaderboard-rank leaderboard-rank-top" : "leaderboard-rank";
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
        const usernameClass = rank === 1 ? "lb-username lb-username-1"
            : rank === 2 ? "lb-username lb-username-2"
                : rank === 3 ? "lb-username lb-username-3"
                    : "lb-username";
        const perk = perkMap[entry.perk_id];
        const perkBadge = (p) => p
            ? `<span class="lb-perk-badge" data-perk-id="${p.id}" style="background:${p.backgroundStyle};color:${p.textColor};--perk-glitter:${p.glitterColor};--perk-glitter-opacity:${p.glitterIntensity};">${escapeHtml(p.name)}</span>`
            : escapeHtml(entry.perk_id);
        return `<tr>
            <td class="${rankClass}">${medal}</td>
            <td class="${usernameClass}">${usernameLink(entry.username)}</td>
            <td>${perkBadge(perk)}</td>
            <td class="leaderboard-score">${formatNum(entry.score)}</td>
        </tr>`;
    }).join("");

    const cards = data.map((entry, i) => {
        const rank = i + 1;
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}위`;
        const rankNameClass = rank === 1 ? "lb-card-rank-name lb-card-rank-1"
            : rank === 2 ? "lb-card-rank-name lb-card-rank-2"
                : rank === 3 ? "lb-card-rank-name lb-card-rank-3"
                    : "lb-card-rank-name";
        const perk = perkMap[entry.perk_id];
        const perkBadge = perk
            ? `<span class="lb-perk-badge" data-perk-id="${perk.id}" style="background:${perk.backgroundStyle};color:${perk.textColor};--perk-glitter:${perk.glitterColor};--perk-glitter-opacity:${perk.glitterIntensity};">${escapeHtml(perk.name)}</span>`
            : escapeHtml(entry.perk_id);
        return `<div class="lb-card">
            <div class="lb-card-left">
                <div class="${rankNameClass}">${medal} / ${usernameLink(entry.username)}</div>
                <div class="lb-card-perk">${perkBadge}</div>
            </div>
            <div class="lb-card-score">${formatNum(entry.score)}</div>
        </div>`;
    }).join("");

    els.leaderboardContent.innerHTML = `
        <table class="leaderboard-table lb-desktop-only">
            <thead>
                <tr>
                    <th>#</th>
                    <th>유저명</th>
                    <th>특성</th>
                    <th>점수</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <div class="lb-cards lb-mobile-only">${cards}</div>`;
}

async function openLeaderboardModal() {
    if (!els.leaderboardModal || !els.leaderboardContent) return;

    if (els.leaderboardPerkFilter && els.leaderboardPerkFilter.options.length === 1) {
        PERK_LIB.filter(p => !p.hidden && !p.legacy).forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.name;
            els.leaderboardPerkFilter.appendChild(opt);
        });
    }
    if (els.leaderboardVersionFilter) els.leaderboardVersionFilter.value = "";
    if (els.leaderboardPerkFilter) {
        els.leaderboardPerkFilter.value = "";
        els.leaderboardPerkFilter.disabled = false;
    }

    els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오는 중...</p>';
    setLeaderboardModalOpen(true);

    const { data, error } = await fetchLeaderboard(100);

    if (error || !data) {
        els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오기 실패. 다시 시도해 주세요.</p>';
        return;
    }

    renderLeaderboardData(data);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function renderPatchLogInline(text) {
    const escaped = escapeHtml(text);

    return escaped
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderPatchLogMarkdown(markdown) {
    const lines = String(markdown).replace(/\r/g, "").split("\n");
    const chunks = [];
    let inList = false;

    lines.forEach((rawLine) => {
        const line = rawLine.trim();

        if (!line) {
            if (inList) {
                chunks.push("</ul>");
                inList = false;
            }
            return;
        }

        const h3 = line.match(/^###\s+(.+)$/);
        if (h3) {
            if (inList) {
                chunks.push("</ul>");
                inList = false;
            }
            chunks.push(`<h3>${renderPatchLogInline(h3[1])}</h3>`);
            return;
        }

        const h2 = line.match(/^##\s+(.+)$/);
        if (h2) {
            if (inList) {
                chunks.push("</ul>");
                inList = false;
            }
            chunks.push(`<h2>${renderPatchLogInline(h2[1])}</h2>`);
            return;
        }

        const h1 = line.match(/^#\s+(.+)$/);
        if (h1) {
            if (inList) {
                chunks.push("</ul>");
                inList = false;
            }
            chunks.push(`<h1>${renderPatchLogInline(h1[1])}</h1>`);
            return;
        }

        const bullet = line.match(/^-\s+(.+)$/);
        if (bullet) {
            if (!inList) {
                chunks.push("<ul>");
                inList = true;
            }
            chunks.push(`<li>${renderPatchLogInline(bullet[1])}</li>`);
            return;
        }

        if (inList) {
            chunks.push("</ul>");
            inList = false;
        }
        chunks.push(`<p>${renderPatchLogInline(line)}</p>`);
    });

    if (inList) {
        chunks.push("</ul>");
    }

    return chunks.join("\n");
}

async function openPatchLogModal() {
    if (!els.patchLogModal || !els.patchLogContent) {
        return;
    }

    els.patchLogContent.innerHTML = '<p class="patchlog-loading">패치노트를 불러오는 중...</p>';
    setPatchLogModalOpen(true);

    try {
        const response = await fetch("./patchlog.md", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const markdown = await response.text();
        const rendered = renderPatchLogMarkdown(markdown);
        els.patchLogContent.innerHTML = rendered || '<p class="patchlog-loading">표시할 패치노트가 없습니다.</p>';
    } catch {
        els.patchLogContent.innerHTML = [
            '<p class="patchlog-loading">패치노트를 불러오지 못했습니다.</p>',
            '<p><a href="./patchlog.md" target="_blank" rel="noopener noreferrer">원본 파일 열기</a></p>',
        ].join("");
    }
}

function setCreditModalOpen(isOpen) {
    if (!els.creditModal) return;
    els.creditModal.classList.toggle("is-visible", isOpen);
    els.creditModal.setAttribute("aria-hidden", String(!isOpen));
}

async function openCreditModal() {
    if (!els.creditModal || !els.creditContent) return;

    els.creditContent.innerHTML = '<p class="patchlog-loading">불러오는 중...</p>';
    setCreditModalOpen(true);

    try {
        const response = await fetch("./credit.md", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const markdown = await response.text();
        const rendered = renderPatchLogMarkdown(markdown);
        els.creditContent.innerHTML = rendered || '<p class="patchlog-loading">내용이 없습니다.</p>';
    } catch {
        els.creditContent.innerHTML = '<p class="patchlog-loading">크레딧을 불러오지 못했습니다.</p>';
    }
}

function loadStoredAudioVolume() {
    try {
        const storedValue = window.localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY);
        if (storedValue === null) {
            return null;
        }

        const parsed = Number(storedValue);
        if (Number.isNaN(parsed)) {
            return null;
        }

        return clamp(parsed, 0, 1);
    } catch {
        return null;
    }
}

function saveAudioVolume(volume) {
    try {
        window.localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, String(clamp(volume, 0, 1)));
    } catch {
        // localStorage 사용 불가 환경에서도 게임은 계속 진행
    }
}

function isDarkMode() {
    return document.documentElement.getAttribute("data-theme") === "dark";
}

function applyDarkMode(enabled) {
    document.documentElement.setAttribute("data-theme", enabled ? "dark" : "light");
    if (els.darkModeToggle) {
        els.darkModeToggle.textContent = enabled ? "켜짐" : "꺼짐";
        els.darkModeToggle.classList.toggle("is-active", enabled);
    }
}

function saveDarkMode(enabled) {
    try {
        window.localStorage.setItem(DARK_MODE_STORAGE_KEY, String(enabled));
    } catch { }
}

function applyAudioVolumeState(volume) {
    const safeVolume = clamp(volume, 0, 1);
    const isMuted = safeVolume === 0;

    if (els.diceRollSound) {
        els.diceRollSound.volume = safeVolume;
        els.diceRollSound.muted = isMuted;
    }

    if (els.enhancedAppearSound) {
        els.enhancedAppearSound.volume = safeVolume;
        els.enhancedAppearSound.muted = isMuted;
    }

    if (els.perkActivateSound) {
        els.perkActivateSound.volume = safeVolume;
        els.perkActivateSound.muted = isMuted;
    }

    if (_vacGain) {
        _vacGain.gain.value = isMuted ? 0 : safeVolume;
    }
}

function updateVolumeButtonUi() {
    const percent = Math.round(clamp(state.audioVolume, 0, 1) * 100);

    if (els.audioVolumeLabel) {
        els.audioVolumeLabel.textContent = `소리 ${percent}%`;
    }

    if (!els.audioVolumeSlider) {
        return;
    }

    els.audioVolumeSlider.value = String(percent);
}

function setAudioVolume(volume, { persist = true } = {}) {
    state.audioVolume = clamp(volume, 0, 1);
    applyAudioVolumeState(state.audioVolume);
    updateVolumeButtonUi();

    if (persist) {
        saveAudioVolume(state.audioVolume);
    }
}

function setSettingsOpen(isOpen) {
    if (!els.settingsBtn || !els.settingsFloat) {
        return;
    }

    els.settingsBtn.setAttribute("aria-expanded", String(isOpen));
    els.settingsFloat.setAttribute("aria-hidden", String(!isOpen));
    els.settingsFloat.classList.toggle("is-open", isOpen);
}

function bindSettingsEvents() {
    if (!els.settingsBtn || !els.settingsFloat) {
        return;
    }

    setSettingsOpen(false);

    els.settingsBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const isOpen = els.settingsFloat.classList.contains("is-open");
        setSettingsOpen(!isOpen);
    });

    els.settingsFloat.addEventListener("click", (event) => {
        event.stopPropagation();
    });

    if (els.audioVolumeSlider) {
        els.audioVolumeSlider.addEventListener("input", (event) => {
            const nextPercent = Number(event.target.value);
            if (Number.isNaN(nextPercent)) {
                return;
            }
            setAudioVolume(nextPercent / 100);
        });
    }

    if (els.userNameInput) {
        els.userNameInput.value = localStorage.getItem(USERNAME_STORAGE_KEY) ?? "";
        els.userNameInput.addEventListener("input", () => {
            localStorage.setItem(USERNAME_STORAGE_KEY, els.userNameInput.value.trim());
            updateTopUsername();
        });
    }
    updateTopUsername();

    applyDarkMode(isDarkMode());

    if (els.darkModeToggle) {
        els.darkModeToggle.addEventListener("click", () => {
            const next = !isDarkMode();
            applyDarkMode(next);
            saveDarkMode(next);
        });
    }

    if (els.patchLogBtn) {
        els.patchLogBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openPatchLogModal();
        });
    }

    if (els.creditBtn) {
        els.creditBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openCreditModal();
        });
    }

    if (els.creditClose) {
        els.creditClose.addEventListener("click", () => setCreditModalOpen(false));
    }

    if (els.creditModal) {
        els.creditModal.addEventListener("click", (event) => {
            if (event.target === els.creditModal) setCreditModalOpen(false);
        });
    }

    if (els.patchLogClose) {
        els.patchLogClose.addEventListener("click", () => {
            closePatchLogModal();
        });
    }

    const helpSlider = (() => {
        let current = 0;
        const track = document.getElementById("helpSlidesTrack");
        const dotsWrap = document.getElementById("helpDots");
        const prevBtn = document.getElementById("helpPrev");
        const nextBtn = document.getElementById("helpNext");
        if (!track) return null;

        const slides = track.querySelectorAll(".help-slide");
        const total = slides.length;

        dotsWrap.innerHTML = Array.from({ length: total }, (_, i) =>
            `<span class="help-dot${i === 0 ? " active" : ""}" data-index="${i}"></span>`
        ).join("");

        const dots = dotsWrap.querySelectorAll(".help-dot");

        function goTo(idx) {
            current = Math.max(0, Math.min(idx, total - 1));
            track.style.transform = `translateX(-${current * 100}%)`;
            dots.forEach((d, i) => d.classList.toggle("active", i === current));
            prevBtn.disabled = current === 0;
            nextBtn.disabled = current === total - 1;
        }

        prevBtn.addEventListener("click", () => goTo(current - 1));
        nextBtn.addEventListener("click", () => goTo(current + 1));
        dots.forEach(d => d.addEventListener("click", () => goTo(Number(d.dataset.index))));

        goTo(0);
        return { reset: () => goTo(0) };
    })();

    if (els.helpBtn) {
        els.helpBtn.addEventListener("click", () => {
            els.helpModal.classList.add("is-visible");
            els.helpModal.setAttribute("aria-hidden", "false");
            helpSlider?.reset();
        });
    }
    if (els.helpClose) {
        els.helpClose.addEventListener("click", () => {
            els.helpModal.classList.remove("is-visible");
            els.helpModal.setAttribute("aria-hidden", "true");
        });
    }
    if (els.helpModal) {
        els.helpModal.addEventListener("click", (e) => {
            if (e.target === els.helpModal) {
                els.helpModal.classList.remove("is-visible");
                els.helpModal.setAttribute("aria-hidden", "true");
            }
        });
    }

    if (els.patchLogModal) {
        els.patchLogModal.addEventListener("click", (event) => {
            if (event.target === els.patchLogModal) {
                closePatchLogModal();
            }
        });
    }

    if (els.perkListBtn) {
        els.perkListBtn.addEventListener("click", () => {
            openPerkListModal();
        });
    }

    if (els.perkListClose) {
        els.perkListClose.addEventListener("click", () => {
            setPerkListModalOpen(false);
        });
    }

    if (els.perkListModal) {
        els.perkListModal.addEventListener("click", (event) => {
            if (event.target === els.perkListModal) setPerkListModalOpen(false);
        });
    }

    if (els.achievementBtn) {
        els.achievementBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openAchievementModal();
        });
    }

    if (els.surveyBtn) {
        els.surveyBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openSurvey();
        });
    }

    if (els.userSearchBtn) {
        els.userSearchBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openUserSearchModal();
        });
    }

    // 내 정보 보기: 내 닉네임으로 유저 검색을 바로 실행
    if (els.myProfileBtn) {
        els.myProfileBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openUserSearchModal();
            const myName = localStorage.getItem(USERNAME_STORAGE_KEY)?.trim().slice(0, 10);
            if (!myName) {
                if (els.userSearchContent) {
                    els.userSearchContent.innerHTML = `<p class="user-search-hint">닉네임을 먼저 설정해주세요.</p>`;
                }
                return;
            }
            if (els.userSearchInput) els.userSearchInput.value = myName;
            searchAndRenderUserProfile(myName);
        });
    }

    if (els.userSearchClose) {
        els.userSearchClose.addEventListener("click", () => {
            closeUserSearchModal();
        });
    }

    if (els.userSearchModal) {
        els.userSearchModal.addEventListener("click", (e) => {
            if (e.target === els.userSearchModal) closeUserSearchModal();
        });
    }

    if (els.userSearchInput) {
        els.userSearchInput.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            const query = els.userSearchInput.value.trim().slice(0, 10);
            if (!query) return;
            searchAndRenderUserProfile(query);
        });
    }

    if (els.achievementClose) {
        els.achievementClose.addEventListener("click", () => {
            els.achievementModal.classList.remove("is-visible");
            els.achievementModal.setAttribute("aria-hidden", "true");
        });
    }

    if (els.achievementModal) {
        els.achievementModal.addEventListener("click", (e) => {
            if (e.target === els.achievementModal) {
                els.achievementModal.classList.remove("is-visible");
                els.achievementModal.setAttribute("aria-hidden", "true");
            }
        });
    }

    if (els.leaderboardBtn) {
        els.leaderboardBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openLeaderboardModal();
        });
    }

    if (els.leaderboardClose) {
        els.leaderboardClose.addEventListener("click", () => {
            closeLeaderboardModal();
        });
    }

    // 리더보드 닉네임 클릭 → 해당 유저 프로필을 위에 겹쳐 표시 (익명 제외)
    if (els.leaderboardContent) {
        els.leaderboardContent.addEventListener("click", (e) => {
            const link = e.target.closest("[data-profile-user]");
            if (!link) return;
            const name = link.dataset.profileUser;
            if (!name) return;
            openUserSearchModal();
            if (els.userSearchInput) els.userSearchInput.value = name;
            searchAndRenderUserProfile(name);
        });
    }

    if (els.leaderboardVersionFilter) {
        els.leaderboardVersionFilter.addEventListener("change", async () => {
            const version = els.leaderboardVersionFilter.value;
            const isHallOfFame = version !== "";

            if (els.leaderboardPerkFilter) {
                els.leaderboardPerkFilter.value = "";
                els.leaderboardPerkFilter.disabled = isHallOfFame;
            }

            els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오는 중...</p>';
            const { data, error } = isHallOfFame
                ? await fetchHallOfFame(version)
                : await fetchLeaderboard(100);
            if (error || !data) {
                els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오기 실패. 다시 시도해 주세요.</p>';
                return;
            }
            renderLeaderboardData(data);
        });
    }

    if (els.leaderboardPerkFilter) {
        els.leaderboardPerkFilter.addEventListener("change", async () => {
            const perkId = els.leaderboardPerkFilter.value;
            els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오는 중...</p>';
            const { data, error } = perkId
                ? await fetchLeaderboardByPerk(perkId, 50)
                : await fetchLeaderboard(100);
            if (error || !data) {
                els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오기 실패. 다시 시도해 주세요.</p>';
                return;
            }
            renderLeaderboardData(data);
        });
    }

    if (els.leaderboardModal) {
        els.leaderboardModal.addEventListener("click", (event) => {
            if (event.target === els.leaderboardModal) {
                closeLeaderboardModal();
            }
        });
    }

    document.addEventListener("click", () => {
        setSettingsOpen(false);
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            setSettingsOpen(false);
            closePatchLogModal();
        }
    });
}

function playEnhancedAppearSound() {
    if (!els.enhancedAppearSound) {
        return;
    }

    els.enhancedAppearSound.playbackRate = 1.0;
    els.enhancedAppearSound.currentTime = 0;
    els.enhancedAppearSound.play().catch(() => {
        // 사운드 재생 실패해도 게임은 계속 진행
    });
}

function playPerkActivateSound() {
    if (!els.perkActivateSound) {
        return;
    }

    els.perkActivateSound.playbackRate = 1.0;
    els.perkActivateSound.currentTime = 0;
    els.perkActivateSound.play().catch(() => {
        // 사운드 재생 실패해도 게임은 계속 진행
    });
}

function warmupAudioElement(audioEl) {
    if (!audioEl) {
        return;
    }

    const prevMuted = audioEl.muted;
    const prevVolume = audioEl.volume;

    audioEl.muted = true;
    audioEl.volume = 0;

    const restore = () => {
        audioEl.pause();
        try {
            audioEl.currentTime = 0;
        } catch {
            // 브라우저가 currentTime 설정을 막아도 볼륨/뮤트는 복원
        }
        audioEl.volume = prevVolume;
        audioEl.muted = prevMuted;
    };

    const playPromise = audioEl.play();
    if (playPromise && typeof playPromise.then === "function") {
        playPromise.then(restore).catch(() => {
            audioEl.volume = prevVolume;
            audioEl.muted = prevMuted;
        });
        return;
    }

    restore();
}

function warmupAudioOnFirstGesture() {
    if (state.audioWarmedUp) {
        return;
    }

    state.audioWarmedUp = true;
    warmupAudioElement(els.diceRollSound);
    warmupAudioElement(els.enhancedAppearSound);
    warmupAudioElement(els.perkActivateSound);
    initVacAudio();
}

function clearEnhancedAppearSoundSchedule() {
    state.enhancedSoundTimeoutIds.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
    });
    state.enhancedSoundTimeoutIds = [];

    state.ventoEffectTimeoutIds.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
    });
    state.ventoEffectTimeoutIds = [];
    state.optionPredictionsReady = true;
}

function scheduleEnhancedAppearSounds(options) {
    clearEnhancedAppearSoundSchedule();
    const selectedPerk = getSelectedPerk();
    const isVentoAureo = selectedPerk?.id === "perk-vento-aureo";

    options.forEach((option, index) => {
        if (!option.isEnhanced) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            if (isVentoAureo && option.rarity === "legend") {
                return;
            }
            playEnhancedAppearSound();
        }, index * OPTION_APPEAR_INTERVAL_MS);

        state.enhancedSoundTimeoutIds.push(timeoutId);
    });
}

function refreshOptionPredictedValueLabels() {
    if (!els.options || !state.options.length) {
        return;
    }

    const shouldShowPredictedValue = state.optionPredictionsReady || state.phase !== "await-option";
    const predictedValueElements = els.options.querySelectorAll(".option-predicted-value");

    predictedValueElements.forEach((element, index) => {
        const option = state.options[index];
        if (!option) {
            return;
        }

        if (!shouldShowPredictedValue) {
            element.textContent = "예상 결과 계산 중...";
            return;
        }

        const predictedValue = safeNumber(option.compute(state.pointVal, state.modVal, state.turn));
        element.textContent = `예상 결과 ${formatNum(predictedValue)}`;
    });
}

function refreshOptionExpressionLabels() {
    if (!els.options || !state.options.length) {
        return;
    }

    const expressionElements = els.options.querySelectorAll(".option-expression");

    expressionElements.forEach((element, index) => {
        const option = state.options[index];
        if (!option) {
            return;
        }

        element.innerHTML = formatFormulaWithHighlights(option.formula, state.pointVal, state.modVal, state.turn);
    });
}

function refreshPointValueAndHistoryUi() {
    setPointValAnimated(state.pointVal === null ? "-" : formatNum(state.pointVal), state.pointVal);

    // 옵션 카드 전체 재렌더 없이 표시 숫자만 갱신
    refreshOptionPredictedValueLabels();
    refreshOptionExpressionLabels();
    renderCalcHistory();
}

function scheduleVentoAureoEffects(options) {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk || selectedPerk.id !== "perk-vento-aureo") {
        return;
    }

    state.optionPredictionsReady = false;

    const legendIndexes = options
        .map((option, index) => (option.rarity === "legend" ? index : -1))
        .filter((index) => index >= 0);

    legendIndexes.forEach((index) => {
        const timeoutId = window.setTimeout(() => {
            if (state.phase !== "await-option") {
                return;
            }

            const prevPoint = state.pointVal ?? 0;
            state.pointVal = safeNumber((state.pointVal ?? 0) * 2);
            recordPerkActivationHistory(
                selectedPerk,
                `Turn ${state.turn} 공개: 전설 등장으로 값 x2 (${formatNum(prevPoint)} -> ${formatNum(state.pointVal)})`,
                { turn: state.turn, trigger: "legend_appear", before_val: prevPoint, after_val: state.pointVal },
            );
            refreshPointValueAndHistoryUi();
            triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, "값 x2");
            triggerPerkBadgeActivationFeedback(true);
        }, index * OPTION_APPEAR_INTERVAL_MS);

        state.ventoEffectTimeoutIds.push(timeoutId);
    });

    const revealCompleteTimeoutId = window.setTimeout(() => {
        if (state.phase !== "await-option") {
            return;
        }

        state.optionPredictionsReady = true;
        refreshOptionPredictedValueLabels();
        refreshOptionExpressionLabels();
    }, options.length * OPTION_APPEAR_INTERVAL_MS);

    state.ventoEffectTimeoutIds.push(revealCompleteTimeoutId);
}

function scheduleNextTurnRoll(delay = 260) {
    // 1턴 이후는 자동 진행 제거 - 사용자 버튼 클릭 필요
    // 이 함수는 더 이상 사용되지 않음
}

/**
 * 주사위 굴림 애니메이션 (비동기)
 * 
 * 프로세스:
 * 1. 상태 설정 (state.rollingTarget 및 rolling 클래스)
 * 2. 일정 시간(duration)동안 매 tick마다 주사위값 변경 및 화면 업데이트
 * 3. 마지막에 최종값 결정
 * 4. 상태 복구 및 renderStatus() 호출
 * 
 * @param targetKey - "pointVal" 또는 "modVal"
 * @param duration - 굴림 지속 시간 (기본 760ms)
 * @param tick - 업데이트 간격 (기본 122ms)
 */
async function animateDiceRoll(targetKey, duration = 760, tick = 122) {
    state.rollingTarget = targetKey;
    setRollingVisual(targetKey);

    const start = Date.now();
    while (Date.now() - start < duration) {
        // 연출용 스핀은 시드 RNG를 소비하지 않는다 (서버 검증의 결정성 보장).
        // 루프 횟수가 기기 성능/타이머 지연에 따라 달라지므로 시드 스트림에서 분리한다.
        state[targetKey] = Math.floor(Math.random() * 6) + 1;
        renderStatus();

        // 주사위 굴림 사운드 재생 (2배속)
        if (els.diceRollSound) {
            els.diceRollSound.playbackRate = 2.0;
            els.diceRollSound.currentTime = 0;
            els.diceRollSound.play().catch(() => {
                // 사운드 재생 실패해도 게임은 계속 진행
            });
        }

        await new Promise((resolve) => {
            window.setTimeout(resolve, tick);
        });
    }

    // 리롤이면 직전 원본 눈금을 제외한 5개 중에서 뽑는다 (rng_v=4, draw 1회 고정)
    const rerollKey = targetKey === "pointVal" ? 0 : state.turn;
    const isReroll = (state.rerollCounts[rerollKey] ?? 0) > 0;
    const prevRaw = state.lastRawRolls[rerollKey];
    let finalValue = isReroll && prevRaw ? rollDiceExcluding(prevRaw) : rollDice();
    state.lastRawRolls[rerollKey] = finalValue; // 가공(6 확정, 67 등) 전 원본 눈금 기록

    // 준비된 기회: 리롤로 다시 굴린 주사위는 눈금 6 확정.
    // draw는 그대로 소비해 시드 스트림을 서버 재현과 일치시킨다.
    if (state.selectedPerkId === "perk-ready-chance" && isReroll) {
        finalValue = 6;
    }
    state[targetKey] = finalValue;
    state.rollingTarget = null;
    setRollingVisual(null);
    renderStatus();
    return finalValue;
}

// 실제 draw 소비 없이 스핀 연출만 하고 원래 값으로 되돌린다.
// 준비된 기회 + 현재 눈금 6 리롤: 결과가 어차피 6이라 "하는 척"만 한다 (카운트/로그도 미소비).
async function animateFakeDiceRoll(targetKey, keepValue, duration = 760, tick = 122) {
    state.rollingTarget = targetKey;
    setRollingVisual(targetKey);

    const start = Date.now();
    while (Date.now() - start < duration) {
        state[targetKey] = Math.floor(Math.random() * 6) + 1;
        renderStatus();
        if (els.diceRollSound) {
            els.diceRollSound.playbackRate = 2.0;
            els.diceRollSound.currentTime = 0;
            els.diceRollSound.play().catch(() => { });
        }
        await new Promise((resolve) => {
            window.setTimeout(resolve, tick);
        });
    }

    state[targetKey] = keepValue;
    state.rollingTarget = null;
    setRollingVisual(null);
    renderStatus();
}

/**
 * 게임 시작 (비동기)
 * 
 * 상태 머신 흐름:
 * idle -> rolling-point -> rolled-point-preview -> await-mod-roll
 * 
 * 프로세스:
 * 1. 게임 상태 초기화 (점수 = null, 턴 = 0, 행운 = 0 등)
 * 2. pointVal 주사위 굴림 애니메이션
 * 3. 주사위 결과 미리보기 (1초)
 * 4. 첫 턴의 modVal 주사위 굴림 준비
 */
async function startGame() {
    if (!state.selectedPerkId) {
        state.phase = "perk-select";
        els.message.textContent = "특성을 선택하세요";
        renderStatus();
        return;
    }

    // 시드 fetch 전에 먼저 진입 잠금 — 중복 클릭 방지
    if (state.started && state.phase !== "finished" && state.phase !== "perk-select") return;
    state.started = true;
    state.phase = "rolling-point";
    renderStatus();

    // 게임 렌더 이전에 시드 수신
    const gameId = crypto.randomUUID();
    const { seedInt8, source } = await fetchGameSeed(gameId);
    initRng(seedInt8ToUint32(seedInt8));

    logPerkPick(state.perkChoices, state.selectedPerkId);

    if (els.seedStatusDot) {
        const ok = source === "supabase";
        els.seedStatusDot.dataset.state = ok ? "ok" : "fail";
        els.seedStatusDot.dataset.tooltip = ok
            ? "시드 수신 완료, 리더보드 검증 가능"
            : "시드 수신 실패, 오프라인 모드로 리더보드 검증 불가";
    }

    clearEnhancedAppearSoundSchedule();

    state.started = true;
    state.gameId = gameId;
    state.pointVal = null;
    state.modVal = null;
    state.turn = 0;
    state.luck = 0;
    state.options = [];
    state.history = [];
    state.leaderboardRank = null;
    state.optionPredictionsReady = true;
    state.initialPointRollValue = null;
    state.perkSunbangPreviewing = false;
    state.perkSunbangDirection = null;
    state.rerollCounts = {};
    state.lastRawRolls = {};
    if (_pointValAnimFrame !== null) { cancelAnimationFrame(_pointValAnimFrame); clearTimeout(_pointValAnimFrame); _pointValAnimFrame = null; }
    stopVacSound();
    _onPointValAnimComplete = null;
    _prevPointValForAnim = null;
    state.phase = "rolling-point";

    state.history.push({ kind: "seed", source, seedInt8 });

    const confirmedPerk = getSelectedPerk();
    updatePerkBadge(confirmedPerk);
    recordPerkSelectionHistory(confirmedPerk);

    const didActivatePerk = applyPerkBeforeInitialRoll();

    els.message.textContent = didActivatePerk
        ? `특성 발동! 네잎클로버로 Luck ${state.luck}. 초기 시작 값 주사위를 굴리는 중...`
        : "초기 시작 값 주사위를 굴리는 중...";
    renderStatus();

    // 리롤용 스냅샷 — 시작 굴림 이전 상태 (특성 사전 효과 적용 후)
    const initRerollSnapshot = captureRerollSnapshot();

    // 리롤 시 이 지점부터 다시 실행되도록 굴림 + 미리보기 효과를 루프로 감싼다
    while (true) {
        restoreRerollSnapshot(initRerollSnapshot);
        // 준비된 기회 리롤 보상 — 복원이 luck을 되돌리므로 누적치를 매 반복 재적용
        applyReadyChanceRerollLuck(state.rerollCounts[0] ?? 0);

        await animateDiceRoll("pointVal");

        // 원본 굴림눈(1~6) — 후원자 등 pointVal을 덮어쓰는 특성도 리롤 UI엔 실제 굴린 눈을 표시
        let initialDiceFace = state.pointVal;

        const riggedDiceResult = await applyPerkAfterDiceRoll("pointVal", state.pointVal);

        // 후원자: 미리보기 렌더 전에 300으로 고정해 "X→6" 재렌더를 방지
        const patronPerkEarly = getSelectedPerk();
        if (patronPerkEarly?.id === "perk-patron") {
            const origDiceVal = state.pointVal;
            state.pointVal = 300;
            recordPerkActivationHistory(
                patronPerkEarly,
                `초기 시작 값: 주사위 ${origDiceVal} → 300으로 고정`,
                { turn: 0, trigger: "initial_dice_reveal", before_val: origDiceVal, after_val: 300 },
            );
            if (_pointValAnimFrame !== null) {
                cancelAnimationFrame(_pointValAnimFrame); clearTimeout(_pointValAnimFrame);
                _pointValAnimFrame = null;
            }
            _prevPointValForAnim = 100;
            triggerPerkPointChangeFeedback(patronPerkEarly, origDiceVal, 300, "300 고정");
            triggerPerkBadgeActivationFeedback();
        }

        state.revealTarget = "pointVal";
        state.phase = "rolled-point-preview";
        els.message.textContent = riggedDiceResult
            ? riggedDiceResult.label != null
                ? `특성 발동! ${riggedDiceResult.perkName} (${riggedDiceResult.label}). 초기 시작 값 = ${state.pointVal}. 주사위를 확인하세요.`
                : `특성 발동! ${riggedDiceResult.perkName}: Luck +${riggedDiceResult.gainedLuck}. 초기 시작 값 = ${state.pointVal}. 주사위를 확인하세요.`
            : patronPerkEarly?.id === "perk-patron"
                ? `특성 발동! 후원자: 초기 값 300으로 고정`
                : `초기 시작 값 = ${state.pointVal}. 주사위를 확인하세요.`;
        renderStatus();

        const perk67point = getSelectedPerk();
        const shouldActivate67point = state.pointVal === 6 && perk67point?.id === "perk-67";
        const shouldActivateSunbangPoint = perk67point?.id === "perk-sunbang" && state.pointVal !== 6;
        if (shouldActivate67point) {
            await wait(250);
            if (state.phase !== "rolled-point-preview") {
                return;
            }
            state.perk67Previewing = true;
            recordPerkActivationHistory(perk67point, `초기 시작 값: 주사위 6 → 7로 변경`,
                { turn: 0, trigger: "initial_dice_mod", before_dice: 6, after_dice: 7 });
            triggerPerkBadgeActivationFeedback();
            els.message.textContent = `특성 발동! 67: 주사위 6 → 7`;
            renderStatus();
            await wait(1000);
            await wait(250);
        } else if (shouldActivateSunbangPoint) {
            await wait(250);
            if (state.phase !== "rolled-point-preview") {
                return;
            }
            state.perkSunbangPreviewing = true;
            state.perkSunbangDirection = "right";
            recordPerkActivationHistory(perk67point, `초기 시작 값: 주사위 ${state.pointVal} → ${state.pointVal + 1}`,
                { turn: 0, trigger: "initial_dice_mod", before_dice: state.pointVal, after_dice: state.pointVal + 1 });
            triggerPerkBadgeActivationFeedback();
            els.message.textContent = `특성 발동! 순방: 주사위 +1`;
            renderStatus();
            await wait(1000);
            await wait(250);
        } else {
            await wait(1000);
        }

        if (state.phase !== "rolled-point-preview") {
            return;
        }

        if (state.perk67Previewing) {
            const prevPoint = state.pointVal;
            state.pointVal = 7;
            initialDiceFace = 7;
            triggerPerkPointChangeFeedback(perk67point, prevPoint, state.pointVal, "주사위 6 -> 7 적용");
            state.perk67Previewing = false;
        }

        if (state.perkSunbangPreviewing) {
            const prevPoint = state.pointVal;
            const delta = state.perkSunbangDirection === "right" ? 1 : -1;
            state.pointVal = safeNumber(prevPoint + delta);
            initialDiceFace = clamp(initialDiceFace + delta, 1, 6);
            const actionText = delta > 0 ? "값 +1" : "값 -1";
            triggerPerkPointChangeFeedback(perk67point, prevPoint, state.pointVal, actionText);
            state.perkSunbangPreviewing = false;
            state.perkSunbangDirection = null;
        }

        const grosmichelInit = getSelectedPerk();
        if (grosmichelInit?.id === "perk-gros-michel" && state.pointVal === 1) {
            const prevPoint = state.pointVal;
            const nextPoint = safeNumber(prevPoint * 6);
            state.pointVal = nextPoint;

            recordPerkActivationHistory(
                grosmichelInit,
                `초기 시작 값: 주사위 1 발동 → 값 x6 (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
                { turn: 0, trigger: "initial_dice_reveal", before_val: prevPoint, after_val: nextPoint },
            );

            refreshPointValueAndHistoryUi();
            triggerPerkPointChangeFeedback(grosmichelInit, prevPoint, nextPoint, "× 6");
            triggerPerkBadgeActivationFeedback();
        }

        const kickstartInitPerk = getSelectedPerk();
        if (kickstartInitPerk?.id === "perk-kickstart") {
            const prevPoint = state.pointVal ?? 0;
            const nextPoint = safeNumber(prevPoint * prevPoint);
            state.pointVal = nextPoint;

            recordPerkActivationHistory(
                kickstartInitPerk,
                `초기 시작 값: 주사위 ${prevPoint} → 값 x${prevPoint} (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
                { turn: 0, trigger: "initial_dice_reveal", before_val: prevPoint, after_val: nextPoint },
            );

            refreshPointValueAndHistoryUi();
            triggerPerkPointChangeFeedback(kickstartInitPerk, prevPoint, nextPoint, `× ${prevPoint}`);
            triggerPerkBadgeActivationFeedback();
        }

        // 선택지(1턴 진행) 직전 — 다시 굴리기 기회 제공 (원본 굴림눈 전달)
        let initRerolled = false;
        while (true) {
            const initRerollDecision = await awaitRerollDecision("pointVal", initialDiceFace);
            if (initRerollDecision !== "reroll") break;
            // 준비된 기회 + 현재 눈금 6: 리롤해도 6이라 연출만 하고 실제 리롤은 하지 않는다
            if (state.selectedPerkId === "perk-ready-chance" && initialDiceFace === 6) {
                await animateFakeDiceRoll("pointVal", state.pointVal);
                continue; // 게이트 재제시
            }
            state.rerollCounts[0] = (state.rerollCounts[0] ?? 0) + 1; // 시작 굴림 리롤 기록
            initRerolled = true;
            break;
        }
        if (initRerolled) continue; // 루프 상단에서 스냅샷 복원 후 재굴림
        break;
    } // end while (리롤 루프)

    state.initialPointRollValue = state.pointVal;

    state.revealTarget = null;

    state.phase = "await-mod-roll";
    els.message.textContent = `초기 시작 값 = ${state.pointVal}. 1턴 주사위를 굴려보세요.`;
    renderStatus();
}

function preparePerkSelection() {
    clearEnhancedAppearSoundSchedule();

    state.started = false;
    state.pointVal = null;
    state.modVal = null;
    state.turn = 0;
    state.luck = 0;
    state.options = [];
    state.history = [];
    state.leaderboardRank = null;
    state.rollingTarget = null;
    state.revealTarget = null;
    state.resolvingOptionId = null;
    state.optionPredictionsReady = true;
    state.selectedPerkId = null;
    state.perk67Previewing = false;
    state.perkSunbangPreviewing = false;
    state.perkSunbangDirection = null;
    state.initialPointRollValue = null;
    if (_pointValAnimFrame !== null) { cancelAnimationFrame(_pointValAnimFrame); clearTimeout(_pointValAnimFrame); _pointValAnimFrame = null; }
    stopVacSound();
    _onPointValAnimComplete = null;
    _prevPointValForAnim = null;
    state.skipUsed = false;
    state.timewarpExtraTurn = false;
    state.questLevel = "common";
    state.volcanoActivated = false;
    state.upgradeMultiplier = 1.5;
    state.rerollCounts = {};
    state.lastRawRolls = {};
    state.perkChoices = createPerkChoices();
    state.phase = "perk-select";
    updatePerkBadge(null);

    els.message.textContent = "첫 주사위를 굴리기 전에 특성을 선택하세요.";
    renderStatus();
}

function selectPerk(perkIndex) {
    if (state.started || state.phase !== "perk-select") {
        return;
    }

    const selectedPerk = state.perkChoices[perkIndex];
    if (!selectedPerk) {
        return;
    }

    state.selectedPerkId = selectedPerk.id;
    els.message.textContent = `특성 '${selectedPerk.name}'을(를) 선택했습니다. 게임 시작 버튼을 눌러 진행하세요.`;
    updatePerkSelectionHighlight();
    renderControl();
}

// ---------- 주사위 다시 굴리기 (리롤) ----------
// 굴림 직후의 효과들이 pointVal/luck/modVal을 직접 변형하므로, 리롤은
// "굴림 직전 상태를 스냅샷 → 복원 후 재굴림" 방식으로 동작한다.
// 게임당 리롤 상한 — 쓰리 스트라이크 특성은 3회, 그 외 1회
function getRerollMax() {
    return state.selectedPerkId === "perk-strikeout" ? 3 : REROLL_MAX_PER_GAME;
}

// 이번 게임에서 지금까지 사용한 리롤 총 횟수
function getRerollsUsed() {
    return Object.values(state.rerollCounts).reduce((sum, n) => sum + n, 0);
}

// 준비된 기회: 리롤할 때마다 행운 +10.
// 스냅샷 복원이 luck을 되돌리므로 반드시 복원 이후에 호출해야 한다.
// count = 이 굴림에 누적된 리롤 횟수 (초기 굴림 루프는 매 반복 복원되므로 누적치로 재적용)
function applyReadyChanceRerollLuck(count) {
    const perk = getSelectedPerk();
    if (perk?.id !== "perk-ready-chance" || count <= 0) return;
    const gained = 10 * count;
    state.luck += gained;
    recordPerkActivationHistory(perk, `리롤 보상: Luck +${gained}`,
        { turn: state.turn, trigger: "reroll", luck_gained: gained });
    triggerPerkBadgeActivationFeedback();
    renderStatus();
}

function captureRerollSnapshot() {
    return {
        turn: state.turn,
        modVal: state.modVal,
        pointVal: state.pointVal,
        luck: state.luck,
        questLevel: state.questLevel,
        volcanoActivated: state.volcanoActivated,
        upgradeMultiplier: state.upgradeMultiplier,
        initialPointRollValue: state.initialPointRollValue,
        historyLength: state.history.length,
    };
}

function restoreRerollSnapshot(snap) {
    state.turn = snap.turn;
    state.modVal = snap.modVal;
    state.pointVal = snap.pointVal;
    state.luck = snap.luck;
    state.questLevel = snap.questLevel;
    state.volcanoActivated = snap.volcanoActivated;
    state.upgradeMultiplier = snap.upgradeMultiplier;
    state.initialPointRollValue = snap.initialPointRollValue;
    state.history.length = snap.historyLength; // 리롤로 무효화된 특성 발동 기록 제거
    state.perk67Previewing = false;
    state.perkSunbangPreviewing = false;
    state.perkSunbangDirection = null;
    refreshPointValueAndHistoryUi();
}

// 주사위 굴림 + 효과 적용 후, 선택지 제시 직전에 호출.
// "리롤" 버튼과 카운트다운을 주사위 표기 하단에 띄우고,
// 사용자가 리롤을 누르면 "reroll", 시간이 지나거나 스킵하면 "proceed"로 resolve한다.
// 리롤을 전부 소진했다면 UI/대기 없이 즉시 "proceed".
function awaitRerollDecision(targetKey, rolledValue) {
    return new Promise((resolve) => {
        if (getRerollsUsed() >= getRerollMax()) {
            resolve("proceed");
            return;
        }

        // 후원자: 시작 점수가 300으로 고정되므로 시작 굴림 리롤은 의미가 없음 — 게이트 생략
        if (targetKey === "pointVal" && state.selectedPerkId === "perk-patron") {
            resolve("proceed");
            return;
        }

        // 주사위 확정 UI(제목 + 굴린 주사위)를 렌더하고, 그 밑에 바로 리롤/스킵을 표시
        const diceFace = clamp(Math.round(rolledValue ?? state[targetKey] ?? 1), 1, 7);
        const isSeven = diceFace === 7; // 67 특성 — 중앙 pip를 별로 강조
        const title = targetKey === "pointVal" ? "시작 점수 확정" : `${state.turn}턴 주사위 값 확정`;
        const rerollsLeft = Math.max(0, getRerollMax() - getRerollsUsed());

        els.options.innerHTML = `
            <div class="options-placeholder rolled-dice-preview dice-stage fade-in reroll-stage" role="status" aria-live="polite">
                <p class="placeholder-title">${title}</p>
                <div class="reveal-dice-wrap">
                    <div class="dice-card reveal-card">${renderDiceFace(diceFace, "idle-spin", isSeven)}</div>
                </div>
                <div class="reroll-gate">
                    <div class="reroll-buttons">
                        <button class="skip-luck-btn reroll-btn" type="button"><span>리롤 (${rerollsLeft}회 남음)</span></button>
                        <button class="skip-luck-btn reroll-skip-btn" type="button"><span>스킵하기</span></button>
                    </div>
                    <p class="reroll-note">※주사위를 굴리며 발생한 변동 사항은 모두 롤백됩니다</p>
                    <p class="reroll-timer"><span class="reroll-count">10</span>초 후 자동 진행...</p>
                </div>
            </div>
        `;

        const countEl = els.options.querySelector(".reroll-count");
        const rerollBtn = els.options.querySelector(".reroll-btn");
        const skipBtn = els.options.querySelector(".reroll-skip-btn");

        let settled = false;
        let remaining = 10;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            window.clearInterval(timerId);
            // 게이트만 제거 — 주사위/확정 미리보기는 그대로 두고 후속 렌더에 맡긴다
            els.options.querySelector(".reroll-gate")?.remove();
            resolve(result);
        };

        const timerId = window.setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                finish("proceed");
                return;
            }
            if (countEl) countEl.textContent = String(remaining);
        }, 1000);

        rerollBtn.addEventListener("click", () => finish("reroll"));
        skipBtn.addEventListener("click", () => finish("proceed"));
    });
}

/**
 * 현재 턴의 modVal 굴림 및 선택지 생성 (비동기)
 *
 * 상태 머신 흐름:
 * await-mod-roll -> rolling-mod -> rolled-mod-preview -> await-option
 *
 * 프로세스:
 * 1. 턴 번호 증가
 * 2. modVal 주사위 굴림 애니메이션
 * 3. modVal 결과 미리보기 (1초)
 * 4. buildOptions()로 3개의 선택지 생성 및 표시
 */
async function rollModValForTurn() {
    if (!state.started || state.phase !== "await-mod-roll") {
        return;
    }

    if (state.turn >= (state.timewarpExtraTurn ? MAX_TURNS + 1 : MAX_TURNS)) {
        finishGame();
        return;
    }

    // 리롤용 스냅샷 — 턴 증가/굴림 이전 상태를 저장 (리롤 시 이 지점으로 복원)
    const rerollSnapshot = captureRerollSnapshot();

    state.turn += 1;
    state.modVal = null;
    state.phase = "rolling-mod";
    els.message.textContent = `${state.turn}턴 주사위를 굴리는 중...`;
    renderStatus();

    await animateDiceRoll("modVal");

    const riggedDiceResult = await applyPerkAfterDiceRoll("modVal", state.modVal);

    state.revealTarget = "modVal";
    state.phase = "rolled-mod-preview";
    els.message.textContent = riggedDiceResult
        ? riggedDiceResult.label != null
            ? `특성 발동! ${riggedDiceResult.perkName} (${riggedDiceResult.label}). ${state.turn}턴 주사위 값 = ${state.modVal}. 주사위를 확인하세요.`
            : `특성 발동! ${riggedDiceResult.perkName}: Luck +${riggedDiceResult.gainedLuck}. ${state.turn}턴 주사위 값 = ${state.modVal}. 주사위를 확인하세요.`
        : `${state.turn}턴 주사위 값 = ${state.modVal}. 주사위를 확인하세요.`;
    renderStatus();

    const perk67 = getSelectedPerk();
    const shouldActivate67 = state.modVal === 6 && perk67?.id === "perk-67";
    const shouldActivateSunbang = perk67?.id === "perk-sunbang" && state.modVal !== 6;
    if (shouldActivate67) {
        await wait(250);
        if (state.phase !== "rolled-mod-preview") {
            return;
        }
        state.perk67Previewing = true;
        recordPerkActivationHistory(perk67, `Turn ${state.turn}: 주사위 6 → 7로 변경`,
            { turn: state.turn, trigger: "dice_mod", before_dice: 6, after_dice: 7 });
        triggerPerkBadgeActivationFeedback();
        els.message.textContent = `특성 발동! 67: 주사위 6 → 7`;
        renderStatus();
        await wait(1000); // 스핀 애니메이션 1초
        await wait(250); // 결과 확인 0.25초
    } else if (shouldActivateSunbang) {
        await wait(250);
        if (state.phase !== "rolled-mod-preview") {
            return;
        }
        state.perkSunbangPreviewing = true;
        state.perkSunbangDirection = "right";
        recordPerkActivationHistory(perk67, `Turn ${state.turn}: 주사위 ${state.modVal} → ${state.modVal + 1}`,
            { turn: state.turn, trigger: "dice_mod", before_dice: state.modVal, after_dice: state.modVal + 1 });
        triggerPerkBadgeActivationFeedback();
        els.message.textContent = `특성 발동! 순방: 주사위 +1`;
        renderStatus();
        await wait(1000); // 애니메이션 1초
        await wait(250); // 결과 확인 0.25초
    } else {
        await wait(1000);
    }

    if (state.phase !== "rolled-mod-preview") {
        return;
    }

    if (state.perk67Previewing) {
        state.modVal = 7;
        state.perk67Previewing = false;
    }

    if (state.perkSunbangPreviewing) {
        const delta = state.perkSunbangDirection === "right" ? 1 : -1;
        state.modVal = clamp(state.modVal + delta, 1, 6);
        state.perkSunbangPreviewing = false;
        state.perkSunbangDirection = null;
    }

    state.revealTarget = null;

    const deathBoundaryPerk = getSelectedPerk();
    if (deathBoundaryPerk?.id === "perk-death-boundary" && state.turn === 4 && state.modVal === 4) {
        const prevPoint = state.pointVal ?? 0;
        const nextPoint = safeNumber(prevPoint * 44);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            deathBoundaryPerk,
            `Turn 4: 주사위 4 발동 → 값 x44 (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "dice_reveal", before_val: prevPoint, after_val: nextPoint },
        );

        refreshPointValueAndHistoryUi();
        triggerPerkPointChangeFeedback(deathBoundaryPerk, prevPoint, nextPoint, "× 44");
        triggerPerkBadgeActivationFeedback();
        els.message.textContent = `특성 발동! 사의 경계: 주사위 4 → × 44`;
        renderStatus();
        await wait(1000);

        if (state.phase !== "rolled-mod-preview") return;
    }

    const grosmichel = getSelectedPerk();
    if (grosmichel?.id === "perk-gros-michel" && state.modVal === 1) {
        const prevPoint = state.pointVal ?? 0;
        const nextPoint = safeNumber(prevPoint * 6);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            grosmichel,
            `Turn ${state.turn}: 주사위 1 발동 → 값 x6 (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "dice_reveal", before_val: prevPoint, after_val: nextPoint },
        );

        refreshPointValueAndHistoryUi();
        triggerPerkPointChangeFeedback(grosmichel, prevPoint, nextPoint, "× 6");
        triggerPerkBadgeActivationFeedback();
    }

    const bullseyePerk = getSelectedPerk();
    if (bullseyePerk?.id === "perk-bullseye" && state.turn === state.modVal) {
        const prevPoint = state.pointVal ?? 0;
        const nextPoint = safeNumber(prevPoint * state.turn);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            bullseyePerk,
            `Turn ${state.turn}: 턴 = 주사위 ${state.modVal} → 값 x${state.turn} (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "dice_reveal", before_val: prevPoint, after_val: nextPoint },
        );

        refreshPointValueAndHistoryUi();
        triggerPerkPointChangeFeedback(bullseyePerk, prevPoint, nextPoint, `× ${state.turn}`);
        triggerPerkBadgeActivationFeedback();
    }

    const kickstartPerk = getSelectedPerk();
    if (kickstartPerk?.id === "perk-kickstart" && state.turn <= 2) {
        const prevPoint = state.pointVal ?? 0;
        const nextPoint = safeNumber(prevPoint * state.modVal);
        state.pointVal = nextPoint;

        recordPerkActivationHistory(
            kickstartPerk,
            `Turn ${state.turn}: 주사위 ${state.modVal} → 값 x${state.modVal} (${formatNum(prevPoint)} -> ${formatNum(nextPoint)})`,
            { turn: state.turn, trigger: "dice_reveal", before_val: prevPoint, after_val: nextPoint },
        );

        refreshPointValueAndHistoryUi();
        triggerPerkPointChangeFeedback(kickstartPerk, prevPoint, nextPoint, `× ${state.modVal}`);
        triggerPerkBadgeActivationFeedback();
    }

    const gnDrivePerk = getSelectedPerk();
    if (gnDrivePerk?.id === "perk-reactor") {
        const startPoint = state.pointVal ?? 0;
        for (let i = 0; i < state.modVal; i++) {
            const prevPoint = state.pointVal ?? 0;
            const nextPoint = safeNumber(prevPoint * 1.2);
            state.pointVal = nextPoint;
            if (nextPoint !== prevPoint) {
                setPointValAnimated(formatNum(state.pointVal), state.pointVal);
                triggerPerkPointChangeFeedback(gnDrivePerk, prevPoint, state.pointVal, `× 1.2`);
                triggerPerkBadgeActivationFeedback();
                await wait(100);
            }
            if (state.pointVal === SAFE_INT_LIMIT || state.pointVal === -SAFE_INT_LIMIT) break;
        }
        const finalPoint = state.pointVal ?? 0;
        recordPerkActivationHistory(
            gnDrivePerk,
            `Turn ${state.turn} 주사위 ${state.modVal}: × 1.2 × ${state.modVal}회 (${formatNum(startPoint)} → ${formatNum(finalPoint)})`,
            { turn: state.turn, trigger: "dice_reveal", before_val: startPoint, after_val: finalPoint },
        );
        if (state.phase !== "rolled-mod-preview") return;
    }

    // 선택지 제시 직전 — 다시 굴리기 기회 제공
    while (true) {
        const rerollDecision = await awaitRerollDecision("modVal", state.modVal);
        if (rerollDecision !== "reroll") break;
        // 준비된 기회 + 현재 눈금 6: 리롤해도 6이라 연출만 하고 실제 리롤은 하지 않는다
        if (state.selectedPerkId === "perk-ready-chance" && state.modVal === 6) {
            await animateFakeDiceRoll("modVal", state.modVal);
            continue; // 게이트 재제시
        }
        state.rerollCounts[state.turn] = (state.rerollCounts[state.turn] ?? 0) + 1; // 이 턴 리롤 기록
        restoreRerollSnapshot(rerollSnapshot);
        applyReadyChanceRerollLuck(1); // 준비된 기회 리롤 보상 (복원 이후 적용, 재귀 스냅샷에 포함됨)
        state.phase = "await-mod-roll";
        await rollModValForTurn();
        return;
    }
    if (state.phase !== "rolled-mod-preview") return;

    state.options = buildOptions();
    const selectedPerk = getSelectedPerk();
    state.optionPredictionsReady = selectedPerk?.id !== "perk-vento-aureo";
    state.allOptionsRevealed = false;
    state.phase = "await-option";
    els.message.textContent = `${state.turn}턴 주사위 값 = ${state.modVal}. 선택지를 고르세요.`;
    renderStatus();
    scheduleEnhancedAppearSounds(state.options);
    scheduleVentoAureoEffects(state.options);

    // 마지막 선택지(스킵 버튼)가 완전히 나타난 후에 선택 가능하게 설정
    const revealCompleteMs = state.options.length * OPTION_APPEAR_INTERVAL_MS + 240;
    window.setTimeout(() => {
        if (state.phase === "await-option") {
            state.allOptionsRevealed = true;
            // 옵션 버튼과 스킵 버튼의 disabled 속성 제거
            document.querySelectorAll(".option-btn, .skip-luck-btn").forEach((btn) => {
                btn.removeAttribute("disabled");
            });
        }
    }, revealCompleteMs);
}

/**
 * 선택지 선택 (비동기)
 * 
 * 상태 머신 흐름:
 * await-option -> resolving-option -> (선택 결과 적용) -> await-mod-roll 또는 finished
 * 
 * 프로세스:
 * 1. 선택 애니메이션 (700ms)
 * 2. 선택한 옵션 공식 계산 (safeNumber로 안전 처리)
 * 3. pointVal 업데이트
 * 4. 선택하지 않은 옵션들의 행운값 합산
 * 5. 히스토리 기록
 * 6. 턴 종료 또는 게임 종료 판정
 */
async function pickOption(optionIndex) {
    const allowedMax = state.timewarpExtraTurn ? MAX_TURNS + 1 : MAX_TURNS;
    if (!state.started || state.turn > allowedMax || state.phase !== "await-option") {
        return;
    }

    const selected = state.options[optionIndex];
    if (!selected) {
        return;
    }

    state.phase = "resolving-option";
    state.resolvingOptionId = selected.id;
    clearEnhancedAppearSoundSchedule();
    renderStatus();
    await wait(700);

    if (state.phase !== "resolving-option") {
        return;
    }

    const prevPoint = state.pointVal;
    const isMoodyBlues = getSelectedPerk()?.id === "perk-moody-blues";
    const nextPoint = safeNumber(selected.compute(state.pointVal, state.modVal, state.turn));

    state.pointVal = nextPoint;

    const luckBefore = state.luck;

    let addedLuck = 0;
    const isJwasalbakdoActive = getSelectedPerk()?.id === "perk-jackpot";
    if (!isJwasalbakdoActive) {
        state.options.forEach((option) => {
            if (option.id !== selected.id) {
                addedLuck += option.unselectedLuckGain;
            }
        });

        state.luck = Math.max(0, state.luck + addedLuck);
    }

    state.history.push({
        turn: state.turn,
        modVal: state.modVal,
        selected_index: optionIndex,
        expression: selected.formula,
        rarity: selected.rarity,
        isEnhanced: Boolean(selected.isEnhanced),
        luck_before: luckBefore,
        from: prevPoint,
        to: nextPoint,
        gainedLuck: addedLuck,
    });

    // 무디 블루스: 특급 선택 시 1회 계산 즉시 표시 → 애니메이션 완료 → 0.2초 후 2회 적용
    if (isMoodyBlues && selected.rarity === "epic") {
        refreshPointValueAndHistoryUi();
        els.message.textContent = `무디 블루스: 1번째 계산 → 현재 점수 ${formatNum(state.pointVal)}`;
        renderStatus();

        if (_pointValAnimFrame !== null) {
            await new Promise(resolve => { _onPointValAnimComplete = resolve; });
        }
        await wait(100);
        if (state.phase !== "resolving-option") return;

        const secondPrev = state.pointVal;
        const secondNext = safeNumber(selected.compute(state.pointVal, state.modVal, state.turn));
        state.pointVal = secondNext;

        state.history.push({
            turn: state.turn,
            modVal: state.modVal,
            selected_index: optionIndex,
            expression: selected.formula,
            rarity: selected.rarity,
            isEnhanced: Boolean(selected.isEnhanced),
            luck_before: state.luck,
            from: secondPrev,
            to: secondNext,
            gainedLuck: 0,
        });

        refreshPointValueAndHistoryUi();
        triggerPerkPointChangeFeedback(getSelectedPerk(), secondPrev, secondNext, "2회 적용");
        triggerPerkBadgeActivationFeedback();
        els.message.textContent = `무디 블루스: 2번째 계산 → 현재 점수 ${formatNum(state.pointVal)}`;
        renderStatus();
    }

    const activatedPerkResult = applyPerkAfterTurnResolved();
    const messagePrefix = activatedPerkResult?.messagePrefix ? `${activatedPerkResult.messagePrefix} ` : "";
    els.message.textContent = activatedPerkResult
        ? `${messagePrefix}선택이 적용되었습니다. ${activatedPerkResult.messageText} 발동: 현재 점수 ${formatNum(state.pointVal)}, Luck ${state.luck}`
        : `선택이 적용되었습니다. 현재 점수 ${formatNum(nextPoint)}`;

    const reachedMaxValue = state.pointVal === SAFE_INT_LIMIT;
    const effectiveMax = state.timewarpExtraTurn ? MAX_TURNS + 1 : MAX_TURNS;

    if (state.turn >= MAX_TURNS && !state.timewarpExtraTurn && !reachedMaxValue) {
        const selectedPerk = getSelectedPerk();
        if (selectedPerk?.id === "perk-time-warp" && !state.skipUsed && getRerollsUsed() === 0) {
            state.resolvingOptionId = null;
            recordPerkActivationHistory(selectedPerk, `Turn ${state.turn} 종료: 퀘스트 달성! 6턴 추가`,
                { turn: state.turn, trigger: "extra_turn" });
            triggerPerkBadgeActivationFeedback();
            els.message.textContent = "퀘스트 달성!";
            renderStatus();
            await wait(250);
            state.timewarpExtraTurn = true;
            state.modVal = null;
            state.options = [];
            state.phase = "await-mod-roll";
            els.message.textContent = "6턴 주사위를 굴려보세요.";
            renderStatus();
            return;
        }
    }

    if (state.turn >= effectiveMax || reachedMaxValue) {
        state.resolvingOptionId = null;
        await applyLastShootingBeforeFinish();
        await applyHighlanderBeforeFinish();
        finishGame();
        return;
    }

    state.modVal = null;
    state.options = [];
    state.resolvingOptionId = null;
    state.phase = "await-mod-roll";
    els.message.textContent = `${state.turn + 1}턴 주사위를 굴려보세요.`;
    renderStatus();
}

/**
 * 턴 건너뛰기 (비동기)
 * 
 * 사용자가 어떤 선택지도 고르지 않고 대신 모든 선택지의 행운값을 얻는 방식
 * pointVal은 그대로 유지
 * 
 * 프로세스:
 * 1. 모든 선택지의 unselectedLuckGain 합산
 * 2. 스킵 애니메이션 (700ms)
 * 3. 행운값 적용 (0 이상으로 유지)
 * 4. 히스토리 기록
 * 5. 다음 턴 또는 게임 종료
 */
async function skipTurnTakeAllLuck() {
    const allowedMax = state.timewarpExtraTurn ? MAX_TURNS + 1 : MAX_TURNS;
    if (!state.started || state.turn > allowedMax || state.phase !== "await-option") {
        return;
    }

    const addedLuck = state.options.reduce((sum, option) => sum + option.unselectedLuckGain, 0) * 2;

    state.skipUsed = true;
    state.phase = "resolving-option";
    state.resolvingOptionId = null;
    clearEnhancedAppearSoundSchedule();
    renderStatus();
    await wait(700);

    if (state.phase !== "resolving-option") {
        return;
    }

    const prevPoint = state.pointVal;
    const selectedPerk = getSelectedPerk();
    const isJwasalbakdo = selectedPerk?.id === "perk-jackpot";

    const skipLuckBefore = state.luck;

    if (!isJwasalbakdo) {
        state.luck = Math.max(0, state.luck + addedLuck);
    }

    let beerExtraLuck = 0;
    if (selectedPerk?.id === "perk-beer") {
        beerExtraLuck = 7 * state.turn;
        state.luck = Math.max(0, state.luck + beerExtraLuck);
        recordPerkActivationHistory(selectedPerk,
            `Turn ${state.turn} 스킵: 추가 Luck +${beerExtraLuck} (7 × ${state.turn}턴)`,
            { turn: state.turn, trigger: "skip", after_luck: state.luck },
        );
        triggerPerkBadgeActivationFeedback();
    }

    if (selectedPerk?.id === "perk-upgrade") {
        const prevMultiplier = state.upgradeMultiplier ?? 1.5;
        state.upgradeMultiplier = prevMultiplier + 0.5;
        recordPerkActivationHistory(selectedPerk,
            `Turn ${state.turn} 스킵: 배율 ×${prevMultiplier.toFixed(1)} → ×${state.upgradeMultiplier.toFixed(1)}`,
            { turn: state.turn, trigger: "skip" },
        );
        triggerPerkBadgeActivationFeedback();
    }

    state.history.push({
        turn: state.turn,
        modVal: state.modVal,
        expression: "스킵(모든 행운 획득)",
        isEnhanced: false,
        luck_before: skipLuckBefore,
        from: prevPoint,
        to: state.pointVal,
        gainedLuck: isJwasalbakdo ? 0 : addedLuck + beerExtraLuck,
    });

    const activatedPerkResult = applyPerkAfterTurnResolved();
    const skipMessagePrefix = activatedPerkResult?.messagePrefix ? `${activatedPerkResult.messagePrefix} ` : "";
    const skipBaseMessage = isJwasalbakdo
        ? "스킵을 적용했습니다. 좌살박도는 스킵 보너스가 없습니다."
        : `스킵을 적용했습니다. Luck +${addedLuck}`;
    els.message.textContent = activatedPerkResult
        ? `${skipMessagePrefix}스킵 적용 후 ${activatedPerkResult.messageText} 발동: 현재 점수 ${formatNum(state.pointVal)}, Luck ${state.luck}`
        : skipBaseMessage;

    const reachedMaxValue = state.pointVal === SAFE_INT_LIMIT || state.pointVal === -SAFE_INT_LIMIT;
    if (state.turn >= (state.timewarpExtraTurn ? MAX_TURNS + 1 : MAX_TURNS) || reachedMaxValue) {
        state.resolvingOptionId = null;
        await applyLastShootingBeforeFinish();
        await applyHighlanderBeforeFinish();
        finishGame();
        return;
    }

    state.modVal = null;
    state.options = [];
    state.resolvingOptionId = null;
    state.phase = "await-mod-roll";
    els.message.textContent = `${state.turn + 1}턴 주사위를 굴려보세요.`;
    renderStatus();
}

/**
 * 게임 종료
 * 
 * 상태 설정:
 * - phase = "finished"
 * - 모든 선택지 및 turn modVal 초기화
 * - 최종 메시지 생성 (히스토리 요약)
 */
function finishGame() {
    clearEnhancedAppearSoundSchedule();

    state.options = [];
    state.modVal = null;
    state.revealTarget = null;
    state.phase = "finished";
    const reachedMaxLimit = state.pointVal === SAFE_INT_LIMIT;
    const reachedMinLimit = state.pointVal === -SAFE_INT_LIMIT;

    const finishLabel = reachedMaxLimit
        ? "최대 한도 달성! (Overflow)"
        : reachedMinLimit
            ? "최소 한도 달성! (Underflow)"
            : "게임 오버!";

    els.message.textContent = `${finishLabel} 최종 pointVal ${formatNum(state.pointVal)}`;
    renderStatus();

    if (_pointValAnimFrame !== null) {
        _onPointValAnimComplete = () => {
            const panel = els.options.querySelector(".finished-panel");
            if (!panel) return;
            panel.style.opacity = "";
            panel.classList.add("fade-in");
        };
    }

    // 게임 결과 서버 전송 (fire-and-forget)
    const seedEntry = state.history.find((e) => e.kind === "seed");
    if (seedEntry?.source !== "supabase") {
        console.info("리더보드 업로드 생략: 로컬 시드");
    } else {
        const shareBtn = document.querySelector("button[data-action='share-record']");
        const rankEl = document.querySelector(".finished-rank");
        if (shareBtn) shareBtn.disabled = true;
        if (rankEl) rankEl.textContent = "데이터 업로드 중...";

        const storedName = localStorage.getItem(USERNAME_STORAGE_KEY)?.trim();
        const username = storedName || `익명 #${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
        const gameplayLog = buildGameplayLog();
        uploadResult({
            username,
            anonymous: !storedName,
            seedInt8: seedEntry.seedInt8,
            perkId: state.selectedPerkId ?? "",
            score: state.pointVal ?? 0,
            log: gameplayLog,
        }).then((result) => {
            const btn = document.querySelector("button[data-action='share-record']");
            if (btn) btn.disabled = false;

            if (result.error) {
                console.warn("리더보드 업로드 실패:", result.error);
                if (result.error === "verification_failed" || result.error === "seed_expired") {
                    // seed_expired: 20분 이상 게임을 끌면 시드가 만료되어 등재가 거부되는 경우
                    showRecordRejectedToast(JSON.stringify(gameplayLog, null, 2));
                } else if (result.error === "unsupported_version") {
                    showUpdateRequiredToast();
                }
                const el = document.querySelector(".finished-rank");
                if (el) el.textContent = "";
                return;
            }

            console.info("리더보드 업로드 성공");
            showUploadSuccessToast();
            const { rank, total, newly_unlocked } = result.data;
            state.leaderboardRank = rank;
            const el = document.querySelector(".finished-rank");
            if (el) {
                const topPercent = Math.ceil((rank / total) * 100);
                el.innerHTML = `${total}개의 기록 중 ${rank}등!<br>(상위 ${topPercent}%)`;
            }

            if (Array.isArray(newly_unlocked)) {
                newly_unlocked.forEach((id, i) => {
                    const name = ACHIEVEMENTS.find((a) => a.id === id)?.name;
                    if (name) setTimeout(() => showAchievementToast(name), i * 500);
                });
            }
        });
    }
}

async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
}

function buildGameplayLog() {
    const turns = [];
    let seed = null;

    state.history.forEach((item) => {
        if (item.kind === "seed") {
            seed = item.seedInt8;
            return;
        }
        if (item.kind === "perk-selection") {
            return;
        }
        if (item.kind === "perk-activation") {
            return;
        }
        // 턴 항목
        const turnEntry = {
            turn: item.turn,
            dice: item.modVal,
            luck_before: item.luck_before ?? 0,
            selected: item.selected_index ?? null,
            formula: item.expression,
            rarity: item.rarity ?? null,
            isEnhanced: item.isEnhanced ?? false,
            before_val: item.from,
            after_val: item.to,
            luck_gained: item.gainedLuck ?? 0,
            reroll_count: state.rerollCounts[item.turn] ?? 0,
        };
        turns.push(turnEntry);
    });

    const baseMap = new Map();
    for (const [rarity, ops] of Object.entries(OPTION_LIBRARY)) {
        ops.forEach((op, i) => baseMap.set(op.formula, { rarity, idx: i + 1 }));
    }
    const enhMap = new Map();
    for (const [rarity, ops] of Object.entries(ENHANCED_OPTION_LIBRARY)) {
        ops.forEach((op, i) => enhMap.set(op.formula, { rarity, idx: i + 1 }));
    }
    const picks = {};
    state.history.forEach((item) => {
        if (!item.turn || !item.expression) return;
        const enhanced = Boolean(item.isEnhanced);
        const info = (enhanced ? enhMap : baseMap).get(item.expression);
        if (!info) return;
        const key = `${info.rarity}_${info.idx}`;
        if (picks[key]) {
            picks[key].count += 1;
        } else {
            picks[key] = { count: 1, isEnhanced: enhanced };
        }
    });

    const log = {
        seed,
        perk_id: state.selectedPerkId ?? null,
        initial_point: state.initialPointRollValue ?? null,
        initial_reroll_count: state.rerollCounts[0] ?? 0,
        turns,
    };
    if (Object.keys(picks).length > 0) log.option_picks = picks;
    log.final_score = state.pointVal ?? 0;
    log.final_luck = state.luck ?? 0;
    // 시드 RNG 소비 규칙 버전 (서버 리시뮬레이션 검증용).
    // v2: 연출 스핀이 시드를 소비하지 않음. v3: 리롤 1회당 주사위 draw 1회 추가 소비.
    // v4: 리롤 draw는 직전 원본 눈금을 제외한 5면 리매핑 (rollDiceExcluding).
    log.rng_v = 4;

    return log;
}

function buildShareRecordText() {
    const finalValue = state.pointVal ?? 0;
    const finalRecordText = finalValue === SAFE_INT_LIMIT
        ? "MAX LIMIT!!"
        : finalValue === -SAFE_INT_LIMIT
            ? "MIN LIMIT!!"
            : formatNum(finalValue);
    const selectedPerk = getSelectedPerk();
    const perkShareEmojiMap = {
        "perk-clover": "🍀",
        "perk-vento-aureo": "🐞",
        "perk-67": "🤷",
        "perk-reversed-cursed": "🔴",
        "perk-rigged-dice": "🎲",
        "perk-jackpot": "🎰",
        "perk-last-shooting": "🤖",
        "perk-sunbang": "🛡️",
        "perk-red-comet": "☄️",
        "perk-time-warp": "⏳",
        "perk-quest": "📋",
        "perk-quest-common": "📋",
        "perk-quest-rare": "📋",
        "perk-quest-epic": "📋",
        "perk-quest-legend": "📋",
        "perk-gros-michel": "🍌",
        "perk-death-boundary": "💀",
        "perk-patron": "🤝",
        "perk-strikeout": "⚾",
        "perk-ready-chance": "🔄",
        "perk-abyss-route": "⚓",
        "perk-moody-blues": "📼",
        "perk-bullseye": "🎯",
        "perk-joker": "🃏",
        "perk-kickstart": "❤️‍🔥",
        "perk-beer": "🍺",
        "perk-upgrade": "🆙",
        "perk-overclock": "💡",
        "perk-reactor": "⚡",
        "perk-energy-convert": "⚡",
        "perk-strategic-retreat": "🌿",
        "perk-solo": "🧍",
    };
    const headingText = document.querySelector(".top-panel h1")?.textContent?.replace(/\s+/g, " ").trim() || "Numero";

    const lines = [
        `🎲🎲 ${headingText} 🎲🎲`,
        "",
    ];

    if (selectedPerk) {
        const perkEmoji = perkShareEmojiMap[selectedPerk.id] || "✨";
        lines.push(`특성 : ${perkEmoji} ${selectedPerk.name}`);
        lines.push("");
    }

    state.history.forEach((item) => {
        if (item.kind === "seed" || item.kind === "perk-selection") {
            return;
        }

        if (item.kind === "perk-activation") {
            lines.push(`[특성 발동] ${item.perkName}`);
            lines.push(item.detail);
            lines.push("");
            return;
        }

        const formulaWithValues = formatFormulaWithValuesPlain(item.expression, item.from, item.modVal, item.turn);
        const gainedLuckText = formatNum(item.gainedLuck ?? 0);
        const enhancedText = item.isEnhanced ? " / Enhanced" : "";
        lines.push(`Turn ${item.turn} :  ${formatNum(item.from)} / 🎲 ${formatNum(item.modVal)} / Luck +${gainedLuckText}${enhancedText}`);
        lines.push(`${formulaWithValues} = ${formatNum(item.to)}`);
        lines.push("");
    });

    lines.push(`🔥 Final Record : ${finalRecordText} 🔥`);
    if (state.leaderboardRank !== null && state.leaderboardRank <= 100) {
        lines.push(`(리더보드 ${state.leaderboardRank}위!)`);
    }
    lines.push("");
    lines.push("Free to play now!");
    lines.push("https://numerobeta.netlify.app/");

    return lines.join("\n").replaceAll("*", "x");
}

async function shareRecord() {
    try {
        const text = buildShareRecordText();
        await copyTextToClipboard(text);
        els.message.textContent = "공유 텍스트가 클립보드에 복사되었습니다.";
    } catch {
        els.message.textContent = "클립보드 복사에 실패했습니다.";
    }
}

// ============================================================================
// 10. 렌더링 함수들 (UI 업데이트)
// ============================================================================

/**
 * 현재 등급별 확률 바 렌더링
 * luck 값에 따라 각 등급의 출현 확률을 색상 바로 시각화
 */
function renderRarityBars() {
    const weights = buildRarityWeights(state.luck);
    const order = ["common", "rare", "epic", "legend"];

    els.rarityBars.innerHTML = order
        .map((key) => {
            const data = RARITIES[key];
            const percent = Math.round(weights[key] * 100);
            return `
        <div class="rarity-item">
          <span>${data.label}</span>
          <div class="rarity-track">
            <div class="rarity-fill" style="width:${percent}%; background:${data.color};"></div>
          </div>
          <strong>${percent}%</strong>
        </div>
      `;
        })
        .join("");
}

function getDicePips(value) {
    /**
     * 주사위 눈 위치 데이터
     * 3x3 그리드에서 어느 셀이 "점"으로 표시될지 정의
     * 
     * 배치 예시:
     * [1][2][3]
     * [4][5][6]
     * [7][8][9]
     */
    const table = {
        1: [5],                  // 중심
        2: [1, 9],              // 대각선
        3: [1, 5, 9],           // 대각선 + 중심
        4: [1, 3, 7, 9],        // 네 모서리
        5: [1, 3, 5, 7, 9],     // 네 모서리 + 중심
        6: [1, 3, 4, 6, 7, 9],  // 양쪽 3개씩
        7: [1, 3, 4, 5, 6, 7, 9], // 67 특성 전용 — 6 배치 + 중심(별로 강조)
    };

    return table[value] || [5];
}

function renderDiceFace(value, extraClass = "", starCenter = false) {
    /**
     * 주사위 면 HTML 렌더링
     * 3x3 격자의 점(pip)들로 주사위 눈을 표시
     * 
     * @param value - 1~6 주사위 눈
     * @param extraClass - 추가 CSS 클래스 (예: "small", "idle-spin")
     * @param starCenter - true이면 중앙(5번) pip를 별 모양으로 표시
     */
    const pips = new Set(getDicePips(value));
    const cells = Array.from({ length: 9 }, (_, idx) => idx + 1)
        .map((cellIndex) => {
            const isOn = pips.has(cellIndex);
            const isStar = isOn && starCenter && cellIndex === 5;
            return `<span class="dice-pip${isOn ? " on" : ""}${isStar ? " star" : ""}"></span>`;
        })
        .join("");

    return `
            <div class="dice-face ${extraClass}" aria-label="주사위 눈 ${value}">
                ${cells}
            </div>
        `;
}

function renderRollingPlaceholder() {
    /**
     * 주사위 굴리는 중 플레이스홀더 렌더링
     * 중앙 주사위 1개만 표시
     */
    const rollingValue = clamp(state.rollingTarget === "pointVal" ? state.pointVal : state.modVal, 1, 6);

    els.options.innerHTML = `
            <div class="options-placeholder dice-stage fade-in" role="status" aria-live="polite">
                <p class="placeholder-title">주사위를 굴리는 중...</p>
                <div class="rolling-dice-row">
                    <div class="dice-card active">${renderDiceFace(rollingValue)}</div>
                </div>
            </div>
        `;
}

function renderAwaitRollPlaceholder() {
    /**
     * 사용자가 버튼을 눌러 주사위를 확정하기 전 플레이스홀더
     * idle-spin 흔들림이 적용된 중앙 주사위 1개 (눈금 고정)
     */
    els.options.innerHTML = `
            <div class="options-placeholder pre-roll-placeholder dice-stage fade-in" role="status" aria-live="polite">
                <p class="placeholder-title">버튼을 눌러 주사위를 굴리세요</p>
                <div class="rolling-dice-row">
                    <div class="dice-card active">${renderDiceFace(4, "idle-spin")}</div>
                </div>
            </div>
        `;
}

function renderRolledDicePreview() {
    /**
     * 주사위 결과 미리보기 패널 렌더링
     * pointVal 또는 modVal의 최종 값을 크게 표시 (1초간 유지)
     */
    const target = state.revealTarget === "pointVal" ? "pointVal" : "modVal";
    const is67Transition = state.perk67Previewing;
    const isSunbangTransition = state.perkSunbangPreviewing;
    const sunbangDelta = state.perkSunbangDirection === "right" ? 1 : -1;
    const rolledValue = is67Transition
        ? 1
        : isSunbangTransition
            ? clamp(state[target] + sunbangDelta, 1, 6)
            : clamp(state[target], 1, 6);
    const titleSuffix = is67Transition ? " → 7!" : "";
    const title = target === "pointVal" ? "시작 점수 확정" : `${state.turn}턴 주사위 값 확정${titleSuffix}`;
    const transitionClass = is67Transition ? " perk67-flash" : "";

    els.options.innerHTML = `
            <div class="options-placeholder rolled-dice-preview dice-stage fade-in" role="status" aria-live="polite">
                <p class="placeholder-title">${title}</p>
                <div class="reveal-dice-wrap">
                    <div class="dice-card reveal-card${transitionClass}">${renderDiceFace(rolledValue, "", is67Transition)}</div>
                </div>
            </div>
        `;
}

function renderFinishedPanel() {
    /**
     * 게임 완료 화면 렌더링
     * 최종 점수, 순위(미구현) 표시
     */
    const finalValue = state.pointVal === null ? 0 : state.pointVal;
    const reachedMaxLimit = finalValue === SAFE_INT_LIMIT;
    const reachedMinLimit = finalValue === -SAFE_INT_LIMIT;
    const topPercentText = "상위 ?%";

    const pendingAnim = _pointValAnimFrame !== null;
    els.options.innerHTML = `
            <div class="finished-panel${pendingAnim ? "" : " fade-in"}"${pendingAnim ? ' style="opacity:0"' : ""} role="status" aria-live="polite">
                ${reachedMinLimit
            ? '<img class="finished-image" src="./undertaker.jpg" alt="Undertaker">'
            : `<p class="finished-title">${reachedMaxLimit ? "최대 한도 달성!" : "게임 종료!"}</p>`}
                <p class="finished-score">최종 값 ${formatNum(finalValue)}</p>
                <button class="share-btn" type="button" data-action="share-record">공유하기</button>
                <p class="finished-rank">${topPercentText}</p>
            </div>
        `;
}

function renderPerkSelection() {
    const selectedId = state.selectedPerkId;

    els.options.innerHTML = state.perkChoices
        .map((perk, index) => {
            const selectedClass = selectedId === perk.id ? "is-perk-selected" : "";
            const staggerDelayMs = index * OPTION_APPEAR_INTERVAL_MS;
            const accentShadow = withAlpha(perk.glitterColor, 0.18 + perk.glitterIntensity * 0.22);
            const cardStyle = `--perk-bg:${perk.backgroundStyle}; --perk-glitter:${perk.glitterColor}; --perk-glitter-opacity:${perk.glitterIntensity}; --perk-accent:${perk.glitterColor}; --perk-accent-shadow:${accentShadow}; animation-delay:${staggerDelayMs}ms;`;

            return `
                <button class="option-btn perk-option-btn fade-in ${selectedClass}" type="button" data-action="select-perk" data-perk-id="${perk.id}" data-index="${index}" style="${cardStyle}">
                    <p class="perk-name">${perk.name}</p>
                    <p class="perk-description">${perk.description}</p>
                </button>
            `;
        })
        .join("");
}

function updatePerkSelectionHighlight() {
    const selectedId = state.selectedPerkId;
    const perkButtons = els.options.querySelectorAll("button[data-action='select-perk']");

    perkButtons.forEach((button, index) => {
        const perk = state.perkChoices[index];
        if (!perk) {
            return;
        }

        button.classList.toggle("is-perk-selected", perk.id === selectedId);
    });
}

function updatePerkBadge(perk) {
    updateLuckInfoTooltip();

    if (!perk) {
        els.perkBadgeBtn.classList.remove("is-last-shooting-glint");
        els.perkBadgeBtn.textContent = "특성 선택 대기중";
        els.perkBadgeBtn.style.background = "";
        els.perkBadgeBtn.style.color = "";
        els.perkBadgeBtn.style.removeProperty("--perk-glitter");
        els.perkBadgeBtn.style.removeProperty("--perk-glitter-opacity");
        els.perkBadgeBtn.style.removeProperty("--perk-text-color");
        els.perkBadgeTitle.textContent = "특성";
        els.perkBadgeDesc.textContent = "특성을 선택해주세요.";
        return;
    }

    const isLastShooting = perk.id === "perk-last-shooting";
    els.perkBadgeBtn.classList.toggle("is-last-shooting-glint", isLastShooting);

    els.perkBadgeBtn.textContent = `특성 : ${perk.name}`;
    els.perkBadgeBtn.style.background = perk.backgroundStyle;
    els.perkBadgeBtn.style.color = perk.textColor || "#13272b";
    els.perkBadgeBtn.style.setProperty("--perk-glitter", perk.glitterColor);
    els.perkBadgeBtn.style.setProperty("--perk-glitter-opacity", perk.glitterIntensity);
    els.perkBadgeBtn.style.setProperty("--perk-text-color", perk.textColor || "#13272b");

    els.perkBadgeTitle.textContent = `특성 : ${perk.name}`;
    els.perkBadgeDesc.textContent = perk.description;
}

function centerPhoneFrameOnDesktop() {
    if (!els.phoneFrame || window.innerWidth < 760) {
        return;
    }

    const frameRect = els.phoneFrame.getBoundingClientRect();
    const viewportCenterY = window.innerHeight / 2;
    const frameCenterY = frameRect.top + frameRect.height / 2;
    const deltaY = frameCenterY - viewportCenterY;

    if (Math.abs(deltaY) < 1) {
        return;
    }

    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const targetY = clamp(window.scrollY + deltaY, 0, maxScrollY);
    window.scrollTo({ top: targetY, behavior: "auto" });
}

function renderOptions() {
    /**
     * 선택지 또는 게임 상태에 따른 옵션 영역 전체 렌더링
     * 
     * 상태별 렌더링:
     * - rolling-point/rolling-mod: 주사위 굴림 애니메이션
     * - await-mod-roll: 버튼 대기 (idle 주사위)
     * - rolled-point-preview/rolled-mod-preview: 주사위 결과 표시
     * - finished: 게임 완료 화면
     * - await-option: 3개 선택지 + 스킵 버튼 표시 (staggered fade-in)
     * - resolving-option: 선택 중일 때 비활성화 효과
     */
    const setOptionsCentered = (isCentered) => {
        els.options.classList.toggle("options-grid-centered", isCentered);
    };

    if (!state.started) {
        if (state.phase === "perk-select") {
            setOptionsCentered(false);
            renderPerkSelection();
            return;
        }

        setOptionsCentered(false);
        els.options.innerHTML = "";
        return;
    }

    if (state.phase === "rolling-point" || state.phase === "rolling-mod") {
        setOptionsCentered(true);
        renderRollingPlaceholder();
        return;
    }

    if (state.phase === "await-mod-roll") {
        setOptionsCentered(true);
        renderAwaitRollPlaceholder();
        return;
    }

    if (state.phase === "rolled-point-preview" || state.phase === "rolled-mod-preview") {
        setOptionsCentered(true);
        renderRolledDicePreview();
        return;
    }

    if (state.phase === "finished") {
        setOptionsCentered(true);
        renderFinishedPanel();
        return;
    }

    if (!state.options.length) {
        setOptionsCentered(false);
        els.options.innerHTML = "";
        return;
    }

    setOptionsCentered(false);
    const shouldShowPredictedValue = state.optionPredictionsReady || state.phase !== "await-option";

    els.options.innerHTML = state.options
        .map((option, index) => {
            const rarityData = RARITIES[option.rarity];
            const displayFormula = formatFormulaWithHighlights(option.formula, state.pointVal, state.modVal, state.turn);
            const predictedValue = safeNumber(option.compute(state.pointVal, state.modVal, state.turn));
            const predictedValueText = formatNum(predictedValue);
            const predictedValueLabel = shouldShowPredictedValue
                ? `예상 결과 ${predictedValueText}`
                : "예상 결과 계산 중...";
            const optionStateClass = state.phase === "resolving-option"
                ? option.id === state.resolvingOptionId
                    ? "is-selected"
                    : "is-unselected"
                : "";
            const isDisabled = state.phase === "resolving-option" || !state.allOptionsRevealed ? "disabled" : "";
            const staggerDelayMs = index * OPTION_APPEAR_INTERVAL_MS;
            const enhancedClass = option.isEnhanced ? "is-enhanced" : "";
            const modifierTag = option.isEnhanced
                ? `<span class="tag tag-enhanced ${rarityData.className}">강화됨</span>`
                : "";
            return `
                <button class="option-btn fade-in rarity-option-${option.rarity} ${enhancedClass} ${optionStateClass}" type="button" data-index="${index}" style="animation-delay:${staggerDelayMs}ms;" ${isDisabled}>
                    <p class="option-expression">${displayFormula}</p>
                    <div class="option-meta">
                        <span class="option-tags"><span class="tag ${rarityData.className}">${rarityData.label}</span>${modifierTag}</span>
                        <span class="option-side-info">
                            <span class="option-predicted-value">${predictedValueLabel}</span>
                            <span>선택 안 하면 Luck +${option.unselectedLuckGain}</span>
                        </span>
                    </div>
                </button>
            `;
        })
        .join("");

    const skipLuckGain = state.options.reduce((sum, option) => sum + option.unselectedLuckGain, 0) * 2;
    const skipDisabled = state.phase === "resolving-option" || !state.allOptionsRevealed ? "disabled" : "";
    const skipDelayMs = state.options.length * OPTION_APPEAR_INTERVAL_MS;

    els.options.innerHTML += `
            <button class="skip-luck-btn fade-in" type="button" data-action="skip-turn" style="animation-delay:${skipDelayMs}ms;" ${skipDisabled}>
                스킵하고 모든 행운 2배로 획득 (+${skipLuckGain})
            </button>
        `;
}

function renderStatus() {
    /**
     * 전체 화면 업데이트 (마스터 렌더함수)
     * 
     * 호출 순서:
     * 1. 상태 텍스트 업데이트 (pointVal, modVal, turnDisplay, luckScore)
     * 2. pointVal 폰트 자동 축소
     * 3. 등급별 확률 바 렌더링
     * 4. 옵션 영역 렌더링 (상태별)
     * 5. 컨트롤 버튼 렌더링
     * 
     * 게임 흐름 중에 계속 호출됨 (상태 변화마다)
     */
    const sunbangPreviewDelta = state.perkSunbangPreviewing ? (state.perkSunbangDirection === "right" ? 1 : -1) : 0;
    const displayPointVal = (state.perkSunbangPreviewing && state.revealTarget === "pointVal")
        ? safeNumber((state.pointVal ?? 0) + sunbangPreviewDelta)
        : state.pointVal;
    const displayModVal = (state.perkSunbangPreviewing && state.revealTarget === "modVal")
        ? clamp((state.modVal ?? 0) + sunbangPreviewDelta, 1, 6)
        : state.modVal;
    setPointValAnimated(displayPointVal === null ? "-" : formatNum(displayPointVal), state.pointVal);
    els.modVal.textContent = displayModVal === null ? "-" : formatNum(displayModVal);
    // await-mod-roll 상태에서는 다음 턴을 미리 표시
    const displayTurn = state.phase === "await-mod-roll" ? state.turn + 1 : state.turn;
    els.turnDisplay.innerHTML = `<span class="turn-current">${displayTurn}</span> / ${state.timewarpExtraTurn ? MAX_TURNS + 1 : MAX_TURNS}`;
    els.luckScore.textContent = `Luck ${state.luck}`;
    fitPointValueFont();
    renderCalcHistory();

    renderRarityBars();
    renderOptions();
    renderControl();
}

function renderCalcHistory() {
    if (!els.calcLogList) {
        return;
    }

    if (!state.history.length) {
        els.calcLogList.innerHTML = `<p class="luck-info-line">아직 계산 기록이 없습니다.</p>`;
        return;
    }

    const items = [...state.history];
    els.calcLogList.innerHTML = items
        .map((item) => {
            if (item.kind === "seed") {
                const label = item.source === "supabase" ? "온라인 시드" : "오프라인 시드";
                return `
                <div class="calc-log-item">
                    <p class="calc-log-row"><strong>${label}</strong> :${item.seedInt8}</p>
                </div>
            `;
            }

            if (item.kind === "perk-selection") {
                return `
                <div class="calc-log-item">
                    <p class="calc-log-row"><strong>특성 선택</strong></p>
                    <p class="calc-log-row">· 선택한 특성: ${item.perkName}</p>
                    <p class="calc-log-row">· 설명: ${item.perkDescription}</p>
                </div>
            `;
            }

            if (item.kind === "perk-activation") {
                return `
                <div class="calc-log-item">
                    <p class="calc-log-row"><strong>특성 발동</strong></p>
                    <p class="calc-log-row">· ${item.perkName}</p>
                    <p class="calc-log-row">· ${item.detail}</p>
                </div>
            `;
            }

            const beforeValue = item.from;
            const formulaWithValues = formatFormulaWithValues(item.expression, item.from, item.modVal, item.turn);
            const resultValue = item.to;
            const gainedLuckText = formatNum(item.gainedLuck ?? 0);
            const enhancedMark = item.isEnhanced ? ' <span class="tag tag-enhanced">강화됨</span>' : "";
            const rerollMark = state.rerollCounts[item.turn] ? ' <span class="tag tag-reroll">(리롤)</span>' : "";

            return `
                <div class="calc-log-item">
                    <p class="calc-log-row"><strong>${item.turn}턴</strong>${enhancedMark}</p>
                    <p class="calc-log-row">· 굴린 주사위 값: ${formatNum(item.modVal)}${rerollMark}</p>
                    <p class="calc-log-row">· 계산 전 점수: ${formatNum(beforeValue)}</p>
                    <p class="calc-log-row">· 계산식: ${formulaWithValues}</p>
                    <p class="calc-log-row">· 턴 종료 획득 Luck: +${gainedLuckText}</p>
                    <p class="calc-log-row">· 계산 결과: ${formatNum(resultValue)}</p>
                </div>
            `;
        })
        .join("");
}

function setLuckInfoOpen(isOpen) {
    /**
     * 행운값 설명 팝업의 표시/숨김 토글
     * - aria-expanded: 접근성 속성
     * - aria-hidden: 스크린 리더 제어
     * - is-open 클래스: CSS 표시/숨김
     */
    if (!els.luckInfoBtn || !els.luckInfoFloat) {
        return;
    }

    els.luckInfoBtn.setAttribute("aria-expanded", String(isOpen));
    els.luckInfoFloat.setAttribute("aria-hidden", String(!isOpen));
    els.luckInfoFloat.classList.toggle("is-open", isOpen);
}

function setPerkBadgeOpen(isOpen) {
    /**
     * 특성 배지 설명 팝업의 표시/숨김 토글
     */
    if (!els.perkBadgeBtn || !els.perkBadgeFloat) {
        return;
    }

    els.perkBadgeBtn.setAttribute("aria-expanded", String(isOpen));
    els.perkBadgeFloat.setAttribute("aria-hidden", String(!isOpen));
    els.perkBadgeFloat.classList.toggle("is-open", isOpen);
}

function triggerPerkBadgeActivationFeedback(playSound = true) {
    if (!els.perkBadgeBtn || !state.selectedPerkId) {
        return;
    }

    const activePerk = getSelectedPerk();

    els.perkBadgeBtn.classList.remove("is-activated");
    // Reflow to restart animation on repeated clicks.
    void els.perkBadgeBtn.offsetWidth;
    els.perkBadgeBtn.classList.add("is-activated");

    const host = els.perkBadgeBtn.parentElement;
    if (!host) {
        return;
    }

    const existingToast = host.querySelector(".perk-activation-toast");
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement("span");
    toast.className = "perk-activation-toast";
    toast.textContent = "특성 발동!!";

    if (activePerk) {
        if (activePerk.id === "perk-last-shooting") {
            toast.classList.add("is-last-shooting-glint");
        }
        toast.style.setProperty("--perk-toast-bg", activePerk.backgroundStyle);
        toast.style.setProperty("--perk-toast-color", activePerk.textColor || "#13272b");
        toast.style.setProperty("--perk-toast-border", withAlpha(activePerk.glitterColor, 0.54));
        toast.style.setProperty("--perk-toast-shadow", withAlpha(activePerk.glitterColor, 0.34));
        toast.style.setProperty("--perk-toast-glitter", activePerk.glitterColor);
        toast.style.setProperty("--perk-toast-glitter-opacity", String(Math.min(0.9, activePerk.glitterIntensity + 0.15)));
    }

    const toastLeft = els.perkBadgeBtn.offsetLeft + els.perkBadgeBtn.offsetWidth + 6;
    const toastTop = els.perkBadgeBtn.offsetTop + els.perkBadgeBtn.offsetHeight / 2;
    toast.style.left = `${toastLeft}px`;
    toast.style.top = `${toastTop}px`;
    host.appendChild(toast);

    toast.addEventListener("animationend", () => {
        toast.remove();
    }, { once: true });

    if (playSound) {
        playPerkActivateSound();
    }

    window.setTimeout(() => {
        els.perkBadgeBtn.classList.remove("is-activated");
    }, 540);
}

function triggerPerkPointChangeFeedback(perk, fromValue, toValue, actionText = "") {
    if (!els.pointVal) {
        return;
    }

    // 라스트 슈팅은 x1배(값이 안 바뀜)일 때도 표시
    if (fromValue === toValue && perk?.id !== "perk-last-shooting") {
        return;
    }

    const host = els.pointVal.closest(".point-card");
    if (!host) {
        return;
    }

    const existingToast = host.querySelector(".point-change-toast");
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement("span");
    toast.className = "point-change-toast";
    const actionLabel = actionText || "값 변경 적용";
    toast.textContent = `${perk?.name ?? "특성"} 발동! ${actionLabel}`;

    if (perk) {
        if (perk.id === "perk-last-shooting") {
            toast.classList.add("is-last-shooting-glint");
        }
        toast.style.setProperty("--perk-toast-bg", perk.backgroundStyle);
        toast.style.setProperty("--perk-toast-color", perk.textColor || "#13272b");
        toast.style.setProperty("--perk-toast-border", withAlpha(perk.glitterColor, 0.54));
        toast.style.setProperty("--perk-toast-shadow", withAlpha(perk.glitterColor, 0.34));
        toast.style.setProperty("--perk-toast-glitter", perk.glitterColor);
        toast.style.setProperty("--perk-toast-glitter-opacity", String(Math.min(0.9, perk.glitterIntensity + 0.15)));
    }

    const hostRect = host.getBoundingClientRect();
    const pointLabel = host.querySelector(".point-head .label");
    const anchorRect = pointLabel ? pointLabel.getBoundingClientRect() : els.pointVal.getBoundingClientRect();
    const toastLeft = anchorRect.right - hostRect.left + 8;
    const toastTop = anchorRect.top - hostRect.top + anchorRect.height / 2;
    toast.style.left = `${toastLeft}px`;
    toast.style.top = `${toastTop}px`;
    host.appendChild(toast);

    toast.addEventListener("animationend", () => {
        toast.remove();
    }, { once: true });
}

function bindLuckInfoEvents() {
    /**
     * 행운값 정보 버튼 이벤트 바인딩
     * 
     * 동작:
     * - 버튼 클릭: 팝업 토글
     * - 팝업 내부 클릭: 전파 방지
     * - 문서 클릭: 팝업 닫기
     * - Escape 키: 팝업 닫기
     */
    if (!els.luckInfoBtn || !els.luckInfoFloat) {
        return;
    }

    setLuckInfoOpen(false);

    els.luckInfoBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const isOpen = els.luckInfoFloat.classList.contains("is-open");
        setLuckInfoOpen(!isOpen);
    });

    els.luckInfoFloat.addEventListener("click", (event) => {
        event.stopPropagation();
    });

    setPerkBadgeOpen(false);

    els.perkBadgeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const isOpen = els.perkBadgeFloat.classList.contains("is-open");
        updatePerkBadge(getSelectedPerk());
        setPerkBadgeOpen(!isOpen);
    });

    els.perkBadgeBtn.addEventListener("mouseenter", () => {
        updatePerkBadge(getSelectedPerk());
        setPerkBadgeOpen(true);
    });

    els.perkBadgeBtn.addEventListener("mouseleave", (event) => {
        const nextTarget = event.relatedTarget;
        if (!nextTarget || !els.perkBadgeFloat.contains(nextTarget)) {
            setPerkBadgeOpen(false);
        }
    });

    els.perkBadgeFloat.addEventListener("mouseenter", () => {
        updatePerkBadge(getSelectedPerk());
        setPerkBadgeOpen(true);
    });

    els.perkBadgeFloat.addEventListener("mouseleave", (event) => {
        const nextTarget = event.relatedTarget;
        if (!nextTarget || !els.perkBadgeBtn.contains(nextTarget)) {
            setPerkBadgeOpen(false);
        }
    });

    els.perkBadgeFloat.addEventListener("click", (event) => {
        event.stopPropagation();
    });

    document.addEventListener("click", () => {
        setLuckInfoOpen(false);
        setPerkBadgeOpen(false);
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            setLuckInfoOpen(false);
            setPerkBadgeOpen(false);
        }
    });
}

function setCalcLogOpen(isOpen) {
    if (!els.calcLogBtn || !els.calcLogFloat) {
        return;
    }

    els.calcLogBtn.setAttribute("aria-expanded", String(isOpen));
    els.calcLogFloat.setAttribute("aria-hidden", String(!isOpen));
    els.calcLogFloat.classList.toggle("is-open", isOpen);
}

function bindCalcLogEvents() {
    if (!els.calcLogBtn || !els.calcLogFloat) {
        return;
    }

    setCalcLogOpen(false);

    els.calcLogBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const isOpen = els.calcLogFloat.classList.contains("is-open");
        setCalcLogOpen(!isOpen);
    });

    els.calcLogFloat.addEventListener("click", (event) => {
        event.stopPropagation();
    });

    document.addEventListener("click", () => {
        setCalcLogOpen(false);
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            setCalcLogOpen(false);
        }
    });
}

function bindEvents() {
    /**
     * 게임 컨트롤 이벤트 바인딩 (시작 버튼, 선택지 버튼)
     * 
     * 시작 버튼:
     * - 처음 또는 끝: startGame() 호출
     * - 턴 대기 중: rollModValForTurn() 호출
     * 
     * 옵션 영역:
     * - 선택지 버튼 클릭: pickOption() 호출
     * - 스킵 버튼 클릭: skipTurnTakeAllLuck() 호출
     */
    els.startBtn.addEventListener("click", () => {
        warmupAudioOnFirstGesture();

        if (!state.started || state.phase === "finished") {
            // 게임 끝났을 때: confirmButtons 표시
            if (state.phase === "finished") {
                els.startBtn.style.display = "none";
                els.confirmButtons.style.display = "grid";
                return;
            }

            if (state.phase === "perk-select" && !state.selectedPerkId) {
                els.message.textContent = "게임 시작 전에 특성 1개를 선택하세요.";
                return;
            }

            startGame();
            return;
        }

        if (state.phase === "await-mod-roll") {
            rollModValForTurn();
        }
    });

    // 다시 플레이 확인 버튼들
    els.confirmYes.addEventListener("click", () => {
        els.confirmButtons.style.display = "none";
        els.startBtn.style.display = "block";
        preparePerkSelection();
    });

    els.confirmNo.addEventListener("click", () => {
        els.confirmButtons.style.display = "none";
        els.startBtn.style.display = "block";
    });

    els.options.addEventListener("click", (event) => {
        const perkButton = event.target.closest("button[data-action='select-perk']");
        if (perkButton) {
            const perkIndex = Number(perkButton.dataset.index);
            if (!Number.isNaN(perkIndex)) {
                selectPerk(perkIndex);
            }
            return;
        }

        const shareButton = event.target.closest("button[data-action='share-record']");
        if (shareButton) {
            shareRecord();
            return;
        }

        const skipButton = event.target.closest("button[data-action='skip-turn']");
        if (skipButton) {
            skipTurnTakeAllLuck();
            return;
        }

        const button = event.target.closest("button[data-index]");
        if (!button) {
            return;
        }

        const index = Number(button.dataset.index);
        if (Number.isNaN(index)) {
            return;
        }

        pickOption(index);
    });

}

function bootstrapDbStatus() {
    if (!els.dbStatusEl) return;
    const { ready } = getSupabaseStatus();
    els.dbStatusEl.textContent = ready ? 'Connected' : 'Disconnected';
    els.dbStatusEl.classList.toggle("is-connected", ready);
    els.dbStatusEl.classList.toggle("is-disconnected", !ready);
}

function init() {
    const versionEl = document.querySelector(".title-version");
    if (versionEl) versionEl.textContent = APP_CONFIG.version;

    bootstrapDbStatus();
    const storedAudioVolume = loadStoredAudioVolume();
    setAudioVolume(storedAudioVolume ?? DEFAULT_AUDIO_VOLUME, { persist: false });
    bindSettingsEvents();
    bindEvents();
    bindLuckInfoEvents();
    bindCalcLogEvents();
    preparePerkSelection();
    window.requestAnimationFrame(() => {
        centerPhoneFrameOnDesktop();
    });

    // 로드 직후 패치노트 안내 (배포 3일 이내) 후 설문조사 안내를 순차 표시
    window.setTimeout(showPatchNoteToast, 800);
    window.setTimeout(showSurveyToast, 1400);

    window.addEventListener("resize", () => {
        fitPointValueFont();
        centerPhoneFrameOnDesktop();
    });
}

function renderControl() {
    /**
     * 상단 컨트롤 버튼 (startBtn) 및 하단 패널 상태 렌더링
     * 
     * 버튼 상태별 처리:
     * - idle/finished: "게임 시작" 또는 "다시 시작"
     * - rolling: 비활성화 + 상태 표시
     * - rolled preview: 비활성화 + 예약된 상태
     * - await-mod-roll: "N턴 주사위 굴리기" (활성화)
     * - await-option/resolving: 숨김 (하단 선택지 영역에 포커스)
     * 
     * 하단 패널 숨김:
     * - await-option 또는 resolving-option 단계에서 숨김
     * - (선택지 영역에 공간 확보)
     */
    if (els.footerPanel) {
        /**
         * 게임 초기화 (페이지 로드 시 실행)
         * 
         * 프로세스:
         * 1. 이벤트 리스너 등록 (버튼, 옵션 클릭)
         * 2. 행운값 정보 버튼 이벤트 등록
         * 3. 초기 화면 렌더링
         * 4. 창 크기 변경 시 폰트 재조정 리스너 등록
         */
        const shouldHideFooter = state.started && (state.phase === "await-option" || state.phase === "resolving-option");
        els.footerPanel.classList.toggle("is-hidden", shouldHideFooter);
    }

    if (!state.started || state.phase === "finished") {
        els.startBtn.disabled = false;
        els.startBtn.classList.remove("is-hidden");
        if (state.phase === "finished") {
            els.startBtn.textContent = "다시 플레이하기";
        } else if (state.phase === "perk-select") {
            els.startBtn.textContent = state.selectedPerkId ? "특성 확정 후 게임 시작" : "특성 선택 후 시작";
        } else {
            els.startBtn.textContent = "게임 시작";
        }
        return;
    }

    if (state.phase === "rolling-point") {
        els.startBtn.disabled = true;
        els.startBtn.classList.remove("is-hidden");
        els.startBtn.textContent = "초기 값 롤링 중";
        return;
    }

    if (state.phase === "rolling-mod") {
        els.startBtn.disabled = true;
        els.startBtn.classList.remove("is-hidden");
        els.startBtn.textContent = "턴 주사위 롤링 중";
        return;
    }

    if (state.phase === "rolled-point-preview" || state.phase === "rolled-mod-preview") {
        els.startBtn.disabled = true;
        els.startBtn.classList.remove("is-hidden");
        els.startBtn.textContent = "주사위 결과 표시 중";
        return;
    }

    if (state.phase === "await-mod-roll") {
        els.startBtn.disabled = false;
        els.startBtn.classList.remove("is-hidden");
        els.startBtn.textContent = `${state.turn + 1}턴 주사위 굴리기`;
        return;
    }

    if (state.phase === "await-option") {
        els.startBtn.disabled = true;
        els.startBtn.classList.add("is-hidden");
        els.startBtn.textContent = "선택지를 고르세요";
        return;
    }

    if (state.phase === "resolving-option") {
        els.startBtn.disabled = true;
        els.startBtn.classList.add("is-hidden");
        els.startBtn.textContent = "선택 결과 반영 중";
        return;
    }

    els.startBtn.disabled = true;
    els.startBtn.classList.add("is-hidden");
    els.startBtn.textContent = "선택지를 고르세요";
}

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        _vacCtx?.suspend();
    } else {
        _vacCtx?.resume();
    }
});

init();
