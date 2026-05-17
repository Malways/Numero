// ============================================================================
// NUMERO GAME - 5턴 안에 가장 큰 숫자를 만드는 게임
// ============================================================================
// Supabase 통합은 현재 주석 처리됨 (향후 멀티플레이/리더보드용)
import { getSupabaseStatus, fetchGameSeed, submitGameResult, uploadResult, fetchLeaderboard } from "./supabase.js";
import { APP_CONFIG } from "./config.js";

// ============================================================================
// 1. 게임 상수 및 유틸 함수
// ============================================================================

const MAX_TURNS = 5; // 게임 총 5턴 진행
const SAFE_INT_LIMIT = Number.MAX_SAFE_INTEGER; // 오버플로우 방지용 최대 안전 정수값
const ENHANCED_OPTION_CHANCE = 0; // 강화됨 선택지 등장 확률 (코더가 조정 가능)
const OPTION_APPEAR_INTERVAL_MS = 400; // 선택지 순차 등장 간격
const PERK_CHOICE_COUNT = 3; // 표시할 특성 카드 수
const DEFAULT_AUDIO_VOLUME = 0.25; // 초기 볼륨 25%
const AUDIO_VOLUME_STORAGE_KEY = "numero.audioVolume";
const USERNAME_STORAGE_KEY = "numero.username";

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
            formula: "pointVal + modVal",
            compute: (a, b) => a + b,
            unselectedLuckGain: 3,
        },
        { //2
            formula: "| pointVal + modVal |",
            compute: (a, b) => Math.abs(a + b),
            unselectedLuckGain: 3,
        },
        { //3
            formula: "pointVal - ( modVal * 3 ) ",
            compute: (a, b) => a - (b * 3),
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
            formula: "= 15",
            compute: (a, b) => 15,
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
            formula: "pointVal + ( modVal * 3 )",
            compute: (a, b) => a + (b * 3),
            unselectedLuckGain: 6,
        },
        { //2
            formula: "| pointVal - ( modVal * 3 ) |",
            compute: (a, b) => Math.abs(a - (b * 3)),
            unselectedLuckGain: 6,
        },
        { //3
            formula: "pointVal * modVal * 2",
            compute: (a, b) => a * b * 2,
            unselectedLuckGain: 6,
        },
        { //4
            formula: "pointVal * -(modVal * 4)",
            compute: (a, b) => a * -(b * 4),
            unselectedLuckGain: 6
        },
        { //5
            formula: "pointVal * 3 + modVal",
            compute: (a, b) => (a * 3) + b,
            unselectedLuckGain: 6,
        },
        { //6
            formula: "pointVal - modVal^2",
            compute: (a, b) => a - Math.pow(b, 2),
            unselectedLuckGain: 6,
        },
        { //7
            formula: "pointVal + ( 100 - modVal * 10 )",
            compute: (a, b) => a + (100 - b * 10),
            unselectedLuckGain: 6
        },
    ],
    epic: [
        { //1
            formula: "pointVal + modVal!",
            compute: (a, b) => a + factorial(b),
            unselectedLuckGain: 9,
        },
        { //2
            formula: "pointVal + modVal^3",
            compute: (a, b) => a + Math.pow(b, 3),
            unselectedLuckGain: 9,
        },
        { //3
            formula: "pointVal - modVal!",
            compute: (a, b) => a - factorial(b),
            unselectedLuckGain: 9,
        },
        { //4
            formula: "pointVal - modVal^3",
            compute: (a, b) => a - Math.pow(b, 3),
            unselectedLuckGain: 9,
        },
        { //5
            formula: "pointVal * modVal^2",
            compute: (a, b) => a * Math.pow(b, 2),
            unselectedLuckGain: 9
        },
        { //6
            formula: "= 100",
            compute: (a, b) => 100,
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
            formula: "5^modVal",
            compute: (a, b) => Math.pow(5, b),
            unselectedLuckGain: 12,
        },
        { //2
            formula: "pointVal * (modVal-1)^(modVal-1)",
            compute: (a, b) => a * Math.pow(b - 1, b - 1),
            unselectedLuckGain: 12,
        },
        { //2
            formula: "-(pointVal * modVal!)",
            compute: (a, b) => -(a * factorial(b)),
            unselectedLuckGain: 12,
        },

        { //2
            formula: "pointVal * (modVal-1)!",
            compute: (a, b) => a * factorial(b - 1),
            unselectedLuckGain: 12,
        },
    ],
};
// 강화됨 전용 선택지 라이브러리 (하드코드)
const ENHANCED_OPTION_LIBRARY = {
    common: [
        {
            formula: "pointVal + modVal * 2",
            compute: (a, b) => a + b * 2,
            unselectedLuckGain: 2,
        },

        {
            formula: "| pointVal + modVal * 2 |",
            compute: (a, b) => Math.abs(a + b * 2),
            unselectedLuckGain: 2,
        },

        {
            formula: "pointVal * 3",
            compute: (a, b) => a * 3,
            unselectedLuckGain: 2,
        },

        {
            formula: "pointVal - modVal*5",
            compute: (a, b) => a - b * 5,
            unselectedLuckGain: 2,
        },
        {
            formula: "pointVal * (-(modVal+1))",
            compute: (a, b) => a * -(b + 1),
            unselectedLuckGain: 2,
        },
        {
            formula: "= 30",
            compute: (a, b) => 30,
            unselectedLuckGain: 2
        },
        {
            formula: "= 30 - pointVal",
            compute: (a, b) => 30 - a,
            unselectedLuckGain: 2
        },
        {
            formula: "(pointVal + pointVal * (modVal + 1)) / 2 (올림)",
            compute: (a, b) => Math.ceil((a + a * (b + 1)) / 2),
            unselectedLuckGain: 2
        },

    ],
    rare: [
        {
            formula: "pointVal * (modVal + 1)",
            compute: (a, b) => a * (b + 1),
            unselectedLuckGain: 5,
        },
        {
            formula: "(pointVal + modVal) * 4",
            compute: (a, b) => (a + b) * 4,
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal + (modVal * 5)",
            compute: (a, b) => a + (b * 5),
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal * 4 + modVal",
            compute: (a, b) => (a * 4) + b,
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal - (modVal+1)^2",
            compute: (a, b) => a - Math.pow(b + 1, 2),
            unselectedLuckGain: 5,
        },
        {
            formula: "= 100",
            compute: (a, b) => 100,
            unselectedLuckGain: 5
        },
        {
            formula: "pointVal + (150 - modVal * 10)",
            compute: (a, b) => a + (150 - b * 10),
            unselectedLuckGain: 5
        },
        {
            formula: "pointVal - (modVal+1)!",
            compute: (a, b) => a - factorial(b + 1),
            unselectedLuckGain: 5
        },
    ],
    epic: [
        {
            formula: "pointVal + (modVal+1)!",
            compute: (a, b) => a + factorial(b + 1),
            unselectedLuckGain: 7,
        },
        {
            formula: "pointVal * modVal * 3",
            compute: (a, b) => a * b * 3,
            unselectedLuckGain: 8,
        },
        {
            formula: "( pointVal - modVal * 5) ^ 2 (올림)",
            compute: (a, b) => Math.pow(Math.ceil((a - b * 5)), 2),
            unselectedLuckGain: 8,
        },
        {
            formula: "= 200",
            compute: (a, b) => 200,
            unselectedLuckGain: 8
        },
        {
            formula: "-((pointVal + modVal) ^ 2)",
            compute: (a, b) => -Math.pow(a + b, 2),
            unselectedLuckGain: 8,
        },

    ],
    legend: [
        { //1
            formula: "7^modVal",
            compute: (a, b) => Math.pow(7, b),
            unselectedLuckGain: 12,
        },
        { //2
            formula: "pointVal * (modVal-1)^(modVal-1)",
            compute: (a, b) => a * Math.pow(b - 1, b - 1),
            unselectedLuckGain: 12,
        },
        { //2
            formula: "-(pointVal * modVal!)",
            compute: (a, b) => -(a * factorial(b)),
            unselectedLuckGain: 12,
        },

        { //2
            formula: "pointVal * (modVal-1)!",
            compute: (a, b) => a * factorial(b - 1),
            unselectedLuckGain: 12,
        },
    ],
};

// 끝: OPTION_LIBRARY

// ============================================================================
// 3-1. 특성 라이브러리 (PERK_LIB)
// ============================================================================
// 기능 효과는 이후 구현 예정: 현재는 선택 UI/템플릿만 제공합니다.
const PERK_LIB = [
    {
        id: "perk-clover",
        name: "네잎클로버",
        description: "게임 시작 전 15의 행운을 가지고 시작합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(213, 246, 239, 0.92), rgba(247, 255, 253, 0.96))",
        glitterColor: "rgba(126, 238, 198, 1)",
        glitterIntensity: 0.72,
        textColor: "#1c3436",
        applyTemplate: (gameState) => {
            gameState.luck = 15;
        },
    },
    {
        id: "perk-exchange",
        name: "등가교환",
        description: "매 턴이 끝날 때 행운을 절반으로 만들고, 값을 2배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(210, 232, 255, 0.92), rgba(245, 251, 255, 0.96))",
        glitterColor: "rgba(143, 201, 255, 1)",
        glitterIntensity: 0.68,
        textColor: "#1d2f45",
        applyTemplate: (_gameState) => {
            // TODO: 특전 효과 구현 예정
        },
    },
    {
        id: "perk-vento-aureo",
        name: "황금의 바람",
        description: "전설 선택지가 등장할 때마다 값이 2배가 됩니다.",
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
        id: "perk-reverse",
        name: "술식 반전",
        description: "게임당 한 번, 턴 종료 시 값이 음수라면 양수로 부호 반전합니다.",
        backgroundStyle: "linear-gradient(165deg, rgba(20, 20, 20, 0.96), rgba(8, 8, 8, 0.98))",
        glitterColor: "rgba(255, 255, 255, 0.9)",
        glitterIntensity: 0.55,
        textColor: "#f2f2f2",
        applyTemplate: (_gameState) => {
            // TODO: 특전 효과 구현 예정
        },
    },
    {
        id: "perk-bank",
        name: "적금 통장",
        description: "4턴까지 매 턴 종료마다 값의 절반을 저금하고, 2배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(221, 245, 221, 0.96), rgba(244, 255, 244, 0.99))",
        glitterColor: "rgba(120, 194, 120, 1)",
        glitterIntensity: 0.42,
        textColor: "#2f5a2f",
        applyTemplate: (_gameState) => {
            // 기능 없음
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
        description: "5턴 종료 직후, 3 / 4 / 5 턴의 주사위 값을 순서대로 곱합니다.",
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
        description: "주사위가 6이 아니면 주사위 값이 1 증가합니다.",
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
        description: "첫 3턴간 턴 종료시 값이 3배가 되고, 행운이 3분의 1만큼 감소합니다.",
        backgroundStyle: "linear-gradient(145deg, rgba(70,5,5,0.99) 0%, rgba(150,12,12,0.97) 28%, rgba(215,30,30,0.95) 48%, rgba(175,14,14,0.97) 68%, rgba(70,5,5,0.99) 100%)",
        glitterColor: "rgba(255, 160, 160, 1)",
        glitterIntensity: 0.92,
        textColor: "#ffffff",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-placeholder-3",
        name: "플레이스홀더 3",
        description: "기능이 준비되지 않은 자리입니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(240, 240, 240, 0.92), rgba(247, 247, 247, 0.98))",
        glitterColor: "rgba(178, 178, 178, 1)",
        glitterIntensity: 0.26,
        textColor: "#525252",
        applyTemplate: (_gameState) => {
            // 기능 없음
        },
    },
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
    audioVolumeSlider: document.getElementById("audioVolumeSlider"), // 소리 슬라이더
    audioVolumeLabel: document.getElementById("audioVolumeLabel"), // 소리 퍼센트 라벨
    message: document.getElementById("message"), // 게임 메시지
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
    leaderboardBtn: document.getElementById("leaderboardBtn"),
    leaderboardModal: document.getElementById("leaderboardModal"),
    leaderboardContent: document.getElementById("leaderboardContent"),
    leaderboardClose: document.getElementById("leaderboardClose"),
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
    perkReverseUsed: false, // 술식 반전 특성 게임당 한 번 사용 여부
    allOptionsRevealed: false, // 모든 선택지가 표시되었는지 여부
    piggyBankStored: 0, // 저금통에 저장된 누적 값
    initialPointRollValue: null, // 게임 시작 시 확정된 첫 주사위 눈금
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
function formatFormulaWithValues(formula, pointVal, modVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);

    return formatFractionNotation(formula)
        .replace(/pointVal/g, pointText)
        .replace(/modVal/g, modText);
}

function formatFormulaWithValuesPlain(formula, pointVal, modVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);

    return formula
        .replace(/pointVal/g, pointText)
        .replace(/modVal/g, modText);
}

/**
 * 선택지 카드에서 사용할 수식 하이라이트 HTML 생성
 * - pointVal: 빨간색
 * - modVal: 파란색
 */
function formatFormulaWithHighlights(formula, pointVal, modVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);

    return formatFractionNotation(formula)
        .replace(/pointVal/g, `<span class="formula-point">${pointText}</span>`)
        .replace(/modVal/g, `<span class="formula-mod">${modText}</span>`);
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
    const pool = [...PERK_LIB];
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

function recordPerkActivationHistory(perk, detail) {
    if (!perk) {
        return;
    }

    state.history.push({
        kind: "perk-activation",
        perkId: perk.id,
        perkName: perk.name,
        detail,
    });
}

function applyPerkBeforeInitialRoll() {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk) {
        return false;
    }

    if (selectedPerk.id === "perk-jackpot") {
        selectedPerk.applyTemplate(state);
        recordPerkActivationHistory(selectedPerk, `Luck을 ${state.luck}으로 변경`);
        triggerPerkBadgeActivationFeedback();
        return true;
    }

    if (selectedPerk.id !== "perk-clover") {
        return false;
    }

    selectedPerk.applyTemplate(state);
    recordPerkActivationHistory(selectedPerk, `Luck을 ${state.luck}으로 변경`);
    triggerPerkBadgeActivationFeedback();
    return true;
}

function applyPerkAfterTurnResolved() {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk) {
        return null;
    }

    if (selectedPerk.id === "perk-bank") {
        const prevPoint = state.pointVal ?? 0;
        let activationMessageText = "";

        if (state.turn >= MAX_TURNS) {
            return null;
        }

        const bankedAmount = safeNumber(prevPoint / 2);
        const remainingPoint = safeNumber(prevPoint - bankedAmount);
        const messagePrefix = `[저금 ${formatNum(bankedAmount)}]`;
        const prevStored = state.piggyBankStored ?? 0;
        const afterDepositStored = safeNumber(prevStored + bankedAmount);
        const boostedStored = safeNumber(Math.round(afterDepositStored * 2));
        const savedMessageText = `${formatNum(bankedAmount)}만큼 저금 / 2배로 총액 ${formatNum(boostedStored)}`;

        state.pointVal = remainingPoint;
        state.piggyBankStored = boostedStored;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: ${savedMessageText} (${formatNum(prevPoint)} -> ${formatNum(remainingPoint)})`,
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, savedMessageText);
        triggerPerkBadgeActivationFeedback();
        activationMessageText = savedMessageText;

        if (state.turn === 4) {
            const storedAmount = state.piggyBankStored;
            const beforeReleasePoint = state.pointVal ?? 0;
            const releasedPoint = safeNumber(beforeReleasePoint + storedAmount);

            state.pointVal = releasedPoint;
            state.piggyBankStored = 0;
            activationMessageText = `적금 만기! ${formatNum(storedAmount)}만큼 받음`;

            recordPerkActivationHistory(
                selectedPerk,
                `Turn ${state.turn} 종료: 적금 만기! ${formatNum(storedAmount)}만큼 받음 (${formatNum(beforeReleasePoint)} -> ${formatNum(releasedPoint)})`,
            );
            triggerPerkPointChangeFeedback(selectedPerk, beforeReleasePoint, state.pointVal, activationMessageText);
        }

        return { messageText: activationMessageText, messagePrefix };
    }

    if (selectedPerk.id === "perk-exchange") {
        const prevPoint = state.pointVal ?? 0;
        const prevLuck = Math.max(0, Math.trunc(state.luck));
        const halvedLuck = Math.floor(prevLuck / 2);
        const doubledPoint = safeNumber((state.pointVal ?? 0) * 2);

        state.luck = halvedLuck;
        state.pointVal = doubledPoint;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: Luck ${formatNum(prevLuck)} -> ${formatNum(halvedLuck)}, 값 ${formatNum(prevPoint)} -> ${formatNum(doubledPoint)} (2배)`,
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `값 x2`);
        triggerPerkBadgeActivationFeedback();
        return { messageText: selectedPerk.name, messagePrefix: "" };
    }

    if (selectedPerk.id === "perk-reverse") {
        // 게임당 한 번만 실행
        if (state.perkReverseUsed) {
            return null;
        }

        const prevPoint = state.pointVal ?? 0;

        // 음수 값일 때만 양수로 반전
        if (prevPoint >= 0) {
            return null;
        }

        state.perkReverseUsed = true;
        const reversedPoint = safeNumber(prevPoint * -1);

        state.pointVal = reversedPoint;

        recordPerkActivationHistory(
            selectedPerk,
            `Turn ${state.turn} 종료: 값 ${formatNum(prevPoint)} -> ${formatNum(reversedPoint)} (부호 반전됨)`,
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, "부호 반전됨");
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
        );
        triggerPerkPointChangeFeedback(selectedPerk, prevPoint, state.pointVal, `값 x3`);
        triggerPerkBadgeActivationFeedback();
        return { messageText: `${selectedPerk.name} (값 x3, Luck -1/3)`, messagePrefix: "" };
    }

    return null;
}

function applyPerkAfterDiceRoll(targetKey, rolledValue) {
    const selectedPerk = getSelectedPerk();
    if (!selectedPerk || selectedPerk.id !== "perk-rigged-dice") {
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
    recordPerkActivationHistory(
        selectedPerk,
        `${rollLabel}: Luck ${formatNum(prevLuck)} -> ${formatNum(nextLuck)} (+${formatNum(gainedLuck)})`,
    );
    triggerPerkBadgeActivationFeedback();

    return {
        perkName: selectedPerk.name,
        gainedLuck,
    };
}

function getLastShootingDiceMultipliers() {
    const multipliers = [];

    // 마지막 3개 턴(3, 4, 5턴)의 주사위만 수집
    const lastThreeTurnsThreshold = MAX_TURNS - 2;
    const turnEntries = state.history
        .filter((item) => typeof item.turn === "number" && item.modVal !== null && item.modVal !== undefined && item.turn >= lastThreeTurnsThreshold)
        .sort((a, b) => a.turn - b.turn);

    turnEntries.forEach((item) => {
        const turnRoll = Math.trunc(item.modVal);
        if (Number.isFinite(turnRoll) && turnRoll > 0) {
            multipliers.push(turnRoll);
        }
    });

    return multipliers;
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
        );

        // 라스트 슈팅 연출 중에는 옵션 재렌더를 막아 공개된 선택지 값이 다시 바뀌지 않게 유지합니다.
        if (els.pointVal) {
            els.pointVal.textContent = formatNum(state.pointVal);
            fitPointValueFont();
        }
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

function updateLuckInfoTooltip() {
    if (!els.luckInfoSkipRule) {
        return;
    }

    const selectedPerk = getSelectedPerk();
    if (selectedPerk?.id === "perk-jackpot") {
        els.luckInfoSkipRule.textContent = "좌살박도 선택 시 스킵 보너스는 적용되지 않습니다.";
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
        const result = safeNumber(opt.compute(state.pointVal, state.modVal));
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

/**
 * Promise 기반 대기 함수
 * setTimeout을 깔끔하게 감싸서 async/await 문법 사용 가능하게 함
 */
function wait(ms) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
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

function setLeaderboardModalOpen(isOpen) {
    if (!els.leaderboardModal) return;
    els.leaderboardModal.classList.toggle("is-visible", isOpen);
    els.leaderboardModal.setAttribute("aria-hidden", String(!isOpen));
}

function closeLeaderboardModal() {
    setLeaderboardModalOpen(false);
}

async function openLeaderboardModal() {
    if (!els.leaderboardModal || !els.leaderboardContent) return;

    els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오는 중...</p>';
    setLeaderboardModalOpen(true);

    const { data, error } = await fetchLeaderboard(50);

    if (error || !data) {
        els.leaderboardContent.innerHTML = '<p class="patchlog-loading">불러오기 실패. 다시 시도해 주세요.</p>';
        return;
    }

    if (data.length === 0) {
        els.leaderboardContent.innerHTML = '<p class="patchlog-loading">아직 기록이 없습니다.</p>';
        return;
    }

    const perkMap = Object.fromEntries(
        PERK_LIB.map((p) => [p.id, p])
    );

    const rows = data.map((entry, i) => {
        const rank = i + 1;
        const rankClass = rank <= 3 ? "leaderboard-rank leaderboard-rank-top" : "leaderboard-rank";
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
        const perk = perkMap[entry.perk_id];
        const perkCell = perk
            ? `<span class="lb-perk-badge" data-perk-id="${perk.id}" style="
                background: ${perk.backgroundStyle};
                color: ${perk.textColor};
                --perk-glitter: ${perk.glitterColor};
                --perk-glitter-opacity: ${perk.glitterIntensity};
               ">${escapeHtml(perk.name)}</span>`
            : escapeHtml(entry.perk_id);
        return `<tr>
            <td class="${rankClass}">${medal}</td>
            <td>${escapeHtml(entry.username)}</td>
            <td>${perkCell}</td>
            <td class="leaderboard-score">${formatNum(entry.score)}</td>
        </tr>`;
    }).join("");

    els.leaderboardContent.innerHTML = `
        <table class="leaderboard-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>유저명</th>
                    <th>특성</th>
                    <th>점수</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
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
        });
    }

    if (els.patchLogBtn) {
        els.patchLogBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            openPatchLogModal();
        });
    }

    if (els.patchLogClose) {
        els.patchLogClose.addEventListener("click", () => {
            closePatchLogModal();
        });
    }

    if (els.patchLogModal) {
        els.patchLogModal.addEventListener("click", (event) => {
            if (event.target === els.patchLogModal) {
                closePatchLogModal();
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

        const predictedValue = safeNumber(option.compute(state.pointVal, state.modVal));
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

        element.innerHTML = formatFormulaWithHighlights(option.formula, state.pointVal, state.modVal);
    });
}

function refreshPointValueAndHistoryUi() {
    if (els.pointVal) {
        els.pointVal.textContent = state.pointVal === null ? "-" : formatNum(state.pointVal);
        fitPointValueFont();
    }

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
        state[targetKey] = rollDice();
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

    const finalValue = rollDice();
    state[targetKey] = finalValue;
    state.rollingTarget = null;
    setRollingVisual(null);
    renderStatus();
    return finalValue;
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

    // 게임 렌더 이전에 시드 수신
    const gameId = crypto.randomUUID();
    const { seedInt8, source } = await fetchGameSeed(gameId);
    initRng(seedInt8ToUint32(seedInt8));

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
    state.perkReverseUsed = false;
    state.piggyBankStored = 0;
    state.initialPointRollValue = null;
    state.perkSunbangPreviewing = false;
    state.perkSunbangDirection = null;
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

    await animateDiceRoll("pointVal");

    const riggedDiceResult = applyPerkAfterDiceRoll("pointVal", state.pointVal);

    state.revealTarget = "pointVal";
    state.phase = "rolled-point-preview";
    els.message.textContent = riggedDiceResult
        ? `특성 발동! ${riggedDiceResult.perkName}: Luck +${riggedDiceResult.gainedLuck}. 초기 시작 값 = ${state.pointVal}. 주사위를 확인하세요.`
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
        recordPerkActivationHistory(perk67point, `초기 시작 값: 주사위 6 → 7로 변경`);
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
        recordPerkActivationHistory(perk67point, `초기 시작 값: 주사위 ${state.pointVal} → ${state.pointVal + 1}`);
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
        triggerPerkPointChangeFeedback(perk67point, prevPoint, state.pointVal, "주사위 6 -> 7 적용");
        state.perk67Previewing = false;
    }

    if (state.perkSunbangPreviewing) {
        const prevPoint = state.pointVal;
        const delta = state.perkSunbangDirection === "right" ? 1 : -1;
        state.pointVal = safeNumber(prevPoint + delta);
        const actionText = delta > 0 ? "값 +1" : "값 -1";
        triggerPerkPointChangeFeedback(perk67point, prevPoint, state.pointVal, actionText);
        state.perkSunbangPreviewing = false;
        state.perkSunbangDirection = null;
    }

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

    if (state.turn >= MAX_TURNS) {
        finishGame();
        return;
    }

    state.turn += 1;
    state.modVal = null;
    state.phase = "rolling-mod";
    els.message.textContent = `${state.turn}턴 주사위를 굴리는 중...`;
    renderStatus();

    await animateDiceRoll("modVal");

    const riggedDiceResult = applyPerkAfterDiceRoll("modVal", state.modVal);

    state.revealTarget = "modVal";
    state.phase = "rolled-mod-preview";
    els.message.textContent = riggedDiceResult
        ? `특성 발동! ${riggedDiceResult.perkName}: Luck +${riggedDiceResult.gainedLuck}. ${state.turn}턴 주사위 값 = ${state.modVal}. 주사위를 확인하세요.`
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
        recordPerkActivationHistory(perk67, `Turn ${state.turn}: 주사위 6 → 7로 변경`);
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
        recordPerkActivationHistory(perk67, `Turn ${state.turn}: 주사위 ${state.modVal} → ${state.modVal + 1}`);
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
    if (!state.started || state.turn > MAX_TURNS || state.phase !== "await-option") {
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
    const nextPoint = safeNumber(selected.compute(state.pointVal, state.modVal));

    state.pointVal = nextPoint;

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
        expression: selected.formula,
        isEnhanced: Boolean(selected.isEnhanced),
        from: prevPoint,
        to: nextPoint,
        gainedLuck: addedLuck,
    });

    const activatedPerkResult = applyPerkAfterTurnResolved();
    const messagePrefix = activatedPerkResult?.messagePrefix ? `${activatedPerkResult.messagePrefix} ` : "";
    els.message.textContent = activatedPerkResult
        ? `${messagePrefix}선택이 적용되었습니다. ${activatedPerkResult.messageText} 발동: 현재 값 ${formatNum(state.pointVal)}, Luck ${state.luck}`
        : `선택이 적용되었습니다. 현재 값 ${formatNum(nextPoint)}`;

    const reachedMaxValue = state.pointVal === SAFE_INT_LIMIT;
    if (state.turn >= MAX_TURNS || reachedMaxValue) {
        state.resolvingOptionId = null;
        await applyLastShootingBeforeFinish();
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
    if (!state.started || state.turn > MAX_TURNS || state.phase !== "await-option") {
        return;
    }

    const addedLuck = state.options.reduce((sum, option) => sum + option.unselectedLuckGain, 0) * 2;

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

    if (!isJwasalbakdo) {
        state.luck = Math.max(0, state.luck + addedLuck);
    }

    state.history.push({
        turn: state.turn,
        modVal: state.modVal,
        expression: "스킵(모든 행운 획득)",
        isEnhanced: false,
        from: prevPoint,
        to: state.pointVal,
        gainedLuck: isJwasalbakdo ? 0 : addedLuck,
    });

    const activatedPerkResult = applyPerkAfterTurnResolved();
    const skipMessagePrefix = activatedPerkResult?.messagePrefix ? `${activatedPerkResult.messagePrefix} ` : "";
    const skipBaseMessage = isJwasalbakdo
        ? "스킵을 적용했습니다. 좌살박도는 스킵 보너스가 없습니다."
        : `스킵을 적용했습니다. Luck +${addedLuck}`;
    els.message.textContent = activatedPerkResult
        ? `${skipMessagePrefix}스킵 적용 후 ${activatedPerkResult.messageText} 발동: 현재 값 ${formatNum(state.pointVal)}, Luck ${state.luck}`
        : skipBaseMessage;

    const reachedMaxValue = state.pointVal === SAFE_INT_LIMIT || state.pointVal === -SAFE_INT_LIMIT;
    if (state.turn >= MAX_TURNS || reachedMaxValue) {
        state.resolvingOptionId = null;
        await applyLastShootingBeforeFinish();
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

    // 게임 결과 서버 전송 (fire-and-forget)
    const seedEntry = state.history.find((e) => e.kind === "seed");
    if (seedEntry?.source !== "supabase") {
        console.info("리더보드 업로드 생략: 로컬 시드");
    } else {
        const shareBtn = document.querySelector("button[data-action='share-record']");
        const rankEl = document.querySelector(".finished-rank");
        if (shareBtn) shareBtn.disabled = true;
        if (rankEl) rankEl.textContent = "데이터 업로드 중...";

        const username = localStorage.getItem(USERNAME_STORAGE_KEY)?.trim() || "익명";
        uploadResult({
            username,
            seedInt8: seedEntry.seedInt8,
            perkId: state.selectedPerkId ?? "",
            score: state.pointVal ?? 0,
            log: buildGameplayLog(),
        }).then((result) => {
            const btn = document.querySelector("button[data-action='share-record']");
            if (btn) btn.disabled = false;

            if (result.error) {
                console.warn("리더보드 업로드 실패:", result.error);
                const el = document.querySelector(".finished-rank");
                if (el) el.textContent = "";
                return;
            }

            console.info("리더보드 업로드 성공");
            const { rank, total } = result.data;
            state.leaderboardRank = rank;
            const el = document.querySelector(".finished-rank");
            if (el) el.textContent = `${rank}등`;
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
    const lines = [];
    state.history.forEach((item) => {
        if (item.kind === "seed") {
            const label = item.source === "supabase" ? "온라인 시드" : "오프라인 시드";
            lines.push(`[시드] ${label} :${item.seedInt8}`);
            return;
        }
        if (item.kind === "perk-selection") {
            lines.push(`[특성 선택] ${item.perkName} - ${item.perkDescription}`);
            return;
        }
        if (item.kind === "perk-activation") {
            lines.push(`[특성 발동] ${item.perkName} - ${item.detail}`);
            return;
        }
        const enhanced = item.isEnhanced ? " [강화됨]" : "";
        const formula = formatFormulaWithValuesPlain(item.expression, item.from, item.modVal);
        lines.push(`Turn ${item.turn}${enhanced}: dice=${item.modVal}, from=${item.from}, formula=${formula}, to=${item.to}, luck+=${item.gainedLuck ?? 0}`);
    });
    lines.push(`[결과] ${state.pointVal ?? 0}`);
    return lines.join("\n");
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
        "perk-bank": "💰",
        "perk-clover": "🍀",
        "perk-exchange": "💱",
        "perk-vento-aureo": "🐞",
        "perk-67": "🤷",
        "perk-reverse": "🔴",
        "perk-rigged-dice": "🎲",
        "perk-jackpot": "🎰",
        "perk-last-shooting": "🤖",
        "perk-sunbang": "🛡️",
        "perk-red-comet": "☄️",
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

        const formulaWithValues = formatFormulaWithValuesPlain(item.expression, item.from, item.modVal);
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
     * 좌측(작음), 중앙(큼), 우측(작음) 주사위 표시 + 좌우 깜빡임 애니메이션
     */
    const rollingValue = clamp(state.rollingTarget === "pointVal" ? state.pointVal : state.modVal, 1, 6);

    els.options.innerHTML = `
            <div class="options-placeholder fade-in" role="status" aria-live="polite">
                <p class="placeholder-title">주사위를 굴리는 중...</p>
                <div class="rolling-dice-row">
                    <div class="dice-card ghost">${renderDiceFace(rollingValue, "small")}</div>
                    <div class="dice-card active">${renderDiceFace(rollingValue)}</div>
                    <div class="dice-card ghost">${renderDiceFace(rollingValue, "small")}</div>
                </div>
            </div>
        `;
}

function renderAwaitRollPlaceholder() {
    /**
     * 사용자가 버튼을 눌러 주사위를 확정하기 전 플레이스홀더
     * idle-spin 애니메이션이 적용된 주사위 3개 (좌우 흔들림)
     */
    const previewValues = [2, 4, 6];

    els.options.innerHTML = `
            <div class="options-placeholder pre-roll-placeholder fade-in" role="status" aria-live="polite">
                <p class="placeholder-title">버튼을 누르면 주사위가 확정됩니다</p>
                <div class="rolling-dice-row">
                    <div class="dice-card ghost">${renderDiceFace(previewValues[0], "small idle-spin")}</div>
                    <div class="dice-card active">${renderDiceFace(previewValues[1], "idle-spin")}</div>
                    <div class="dice-card ghost">${renderDiceFace(previewValues[2], "small idle-spin")}</div>
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
    const title = target === "pointVal" ? "초기 시작 값 확정" : `${state.turn}턴 주사위 값 확정${titleSuffix}`;
    const transitionClass = is67Transition ? " perk67-flash" : "";

    els.options.innerHTML = `
            <div class="options-placeholder rolled-dice-preview fade-in" role="status" aria-live="polite">
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

    els.options.innerHTML = `
            <div class="finished-panel fade-in" role="status" aria-live="polite">
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
    if (perk.id === "perk-bank") {
        els.perkBadgeDesc.innerHTML = `${perk.description}<br>현재 저금액: ${formatNum(state.piggyBankStored ?? 0)}`;
    } else {
        els.perkBadgeDesc.textContent = perk.description;
    }
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
            const displayFormula = formatFormulaWithHighlights(option.formula, state.pointVal, state.modVal);
            const predictedValue = safeNumber(option.compute(state.pointVal, state.modVal));
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
    els.pointVal.textContent = displayPointVal === null ? "-" : formatNum(displayPointVal);
    els.modVal.textContent = displayModVal === null ? "-" : formatNum(displayModVal);
    // await-mod-roll 상태에서는 다음 턴을 미리 표시
    const displayTurn = state.phase === "await-mod-roll" ? state.turn + 1 : state.turn;
    els.turnDisplay.textContent = `${displayTurn} / ${MAX_TURNS}`;
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
            const formulaWithValues = formatFormulaWithValues(item.expression, item.from, item.modVal);
            const resultValue = item.to;
            const gainedLuckText = formatNum(item.gainedLuck ?? 0);
            const enhancedMark = item.isEnhanced ? ' <span class="tag tag-enhanced">강화됨</span>' : "";

            return `
                <div class="calc-log-item">
                    <p class="calc-log-row"><strong>${item.turn}턴</strong>${enhancedMark}</p>
                    <p class="calc-log-row">· 굴린 주사위 값: ${formatNum(item.modVal)}</p>
                    <p class="calc-log-row">· 계산 전 현재 값: ${formatNum(beforeValue)}</p>
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

    const activePerk = state.perkChoices.find((perk) => perk.id === state.selectedPerkId) ?? null;

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
        triggerPerkBadgeActivationFeedback(false);
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

init();
