// ============================================================================
// NUMERO GAME - 5턴 안에 가장 큰 숫자를 만드는 게임
// ============================================================================
// Supabase 통합은 현재 주석 처리됨 (향후 멀티플레이/리더보드용)
// import { getSupabaseStatus } from "./supabase.js";

// ============================================================================
// 1. 게임 상수 및 유틸 함수
// ============================================================================

const MAX_TURNS = 5; // 게임 총 5턴 진행
const SAFE_INT_LIMIT = Number.MAX_SAFE_INTEGER; // 오버플로우 방지용 최대 안전 정수값
const NEGATIVE_OPTION_CHANCE = 0; // 네거티브 선택지 등장 확률 (코더가 조정 가능)
const ENHANCED_OPTION_CHANCE = 0.15; // 강화됨 선택지 등장 확률 (코더가 조정 가능)
const OPTION_APPEAR_INTERVAL_MS = 400; // 선택지 순차 등장 간격
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
        {
            formula: "pointVal + modVal",
            compute: (a, b) => a + b,
            unselectedLuckGain: 2,
        },

        {
            formula: "pointVal * 2",
            compute: (a, b) => a * 2,
            unselectedLuckGain: 3,
        },

        {
            formula: "pointVal - modVal",
            compute: (a, b) => a - b,
            unselectedLuckGain: 4,
        },
        {
            formula: "pointVal * -2",
            compute: (a, b) => a * -2,
            unselectedLuckGain: 4,
        },
        {
            formula: "= 5",
            compute: (a, b) => 5,
            unselectedLuckGain: 4
        },
    ],
    rare: [
        {
            formula: "pointVal * modVal",
            compute: (a, b) => a * b,
            unselectedLuckGain: 5,
        },
        {
            formula: "(pointVal + modVal) * 2",
            compute: (a, b) => (a + b) * 2,
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal + (modVal * 2)",
            compute: (a, b) => a + (b * 2),
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal * 2 + modVal",
            compute: (a, b) => (a * 2) + b,
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal - modVal^3",
            compute: (a, b) => a - Math.pow(b, 3),
            unselectedLuckGain: 5,
        },
        {
            formula: "= 15",
            compute: (a, b) => 15,
            unselectedLuckGain: 5
        },
    ],
    epic: [
        {
            formula: "pointVal + modVal!",
            compute: (a, b) => a + factorial(b),
            unselectedLuckGain: 7,
        },
        {
            formula: "pointVal * modVal * 2",
            compute: (a, b) => a * b * 2,
            unselectedLuckGain: 8,
        },
        {
            formula: "(pointVal / modVal) ^ 2 (올림)",
            compute: (a, b) => Math.pow(Math.ceil(a / b), 2),
            unselectedLuckGain: 8,
        },
        {
            formula: "= 40",
            compute: (a, b) => 40,
            unselectedLuckGain: 8
        },
        {
            formula: "-(pointVal ^ 3)",
            compute: (a, b) => -Math.pow(a, 3),
            unselectedLuckGain: 8,
        },

    ],
    legend: [
        {
            formula: "(pointVal / (modVal+3)) ^ (modVal/2) (올림)",
            compute: (a, b) => Math.pow(Math.ceil(a / (b + 3)), Math.ceil(b / 2)),
            unselectedLuckGain: 11,
        },
        {
            formula: "pointVal + (modVal + 6) ^ modVal",
            compute: (a, b) => a + Math.pow(b + 6, b),
            unselectedLuckGain: 11,
        },
        {
            formula: "pointVal * (modVal + 1)!",
            compute: (a, b) => a * factorial(b + 1),
            unselectedLuckGain: 11,
        },
        {
            formula: "pointVal ^ 2",
            compute: (a, b) => Math.pow(a, 2),
            unselectedLuckGain: 11,
        },
        {
            formula: "= 1000",
            compute: (a, b) => 1000,
            unselectedLuckGain: 11,
        },
    ],
};

// 강화됨 전용 선택지 라이브러리 (하드코드)
const ENHANCED_OPTION_LIBRARY = {
    common: [
        {
            formula: "pointVal + modVal * 2",
            compute: (a, b) => a + b * 2,
            unselectedLuckGain: 6,
        },

        {
            formula: "pointVal * 3",
            compute: (a, b) => a * 3,
            unselectedLuckGain: 6,
        },

        {
            formula: "pointVal - modVal * 10",
            compute: (a, b) => a - b * 10,
            unselectedLuckGain: 6,
        },
        {
            formula: "pointVal * -4",
            compute: (a, b) => a * -4,
            unselectedLuckGain: 6,
        },
        {
            formula: "= 10",
            compute: (a, b) => 5,
            unselectedLuckGain: 6
        },
    ],
    rare: [
        {
            formula: "(pointVal + modVal) * modVal",
            compute: (a, b) => (a + b) * b,
            unselectedLuckGain: 9,
        },
        {
            formula: "(pointVal + modVal) * 3",
            compute: (a, b) => (a + b) * 3,
            unselectedLuckGain: 9,
        },
        {
            formula: "pointVal + (modVal * 3)",
            compute: (a, b) => a + (b * 3),
            unselectedLuckGain: 9,
        },
        {
            formula: "pointVal * 3 + modVal",
            compute: (a, b) => (a * 3) + b,
            unselectedLuckGain: 9,
        },
        {
            formula: "pointVal - modVal^4",
            compute: (a, b) => a - Math.pow(b, 4),
            unselectedLuckGain: 9,
        },
        {
            formula: "= 30",
            compute: (a, b) => 30,
            unselectedLuckGain: 9
        },
    ],
    epic: [
        {
            formula: "pointVal + (modVal + 1)!",
            compute: (a, b) => a + factorial(b + 1),
            unselectedLuckGain: 12,
        },
        {
            formula: "pointVal * modVal * 3",
            compute: (a, b) => a * b * 3,
            unselectedLuckGain: 12,
        },
        {
            formula: "(pointVal / 2 ) ^ 2 (올림)",
            compute: (a, b) => Math.pow(Math.ceil(a / 2), 2),
            unselectedLuckGain: 12,
        },
        {
            formula: "= 60",
            compute: (a, b) => 60,
            unselectedLuckGain: 12
        },
        {
            formula: "-(pointVal ^ 4)",
            compute: (a, b) => -Math.pow(a, 4),
            unselectedLuckGain: 12,
        },
    ],
    legend: [
        {
            formula: "(pointVal+modVal) ^ (modVal/2) (올림)",
            compute: (a, b) => Math.pow(a + b, Math.ceil(b / 2)),
            unselectedLuckGain: 15,
        },
        {
            formula: "pointVal + (modVal*5) ^ modVal",
            compute: (a, b) => a + Math.pow(b * 5, b),
            unselectedLuckGain: 15,
        },
        {
            formula: "pointVal * (modVal + 3)!",
            compute: (a, b) => a * factorial(b + 3),
            unselectedLuckGain: 15,
        },
        {
            formula: "| pointVal ^ 2 |", // 수정 필요
            compute: (a, b) => Math.abs(Math.pow(a, 2)),
            unselectedLuckGain: 15,
        },
        {
            formula: "= 2000",
            compute: (a, b) => 2000,
            unselectedLuckGain: 11,
        },
    ],
};

// 반전됨 전용 선택지 라이브러리 (하드코드)
const NEGATIVE_OPTION_LIBRARY = {
    common: [
        {
            formula: "pointVal + modVal", // 수정 필요
            compute: (a, b) => a + b,
            unselectedLuckGain: 2,
        },

        {
            formula: "pointVal * 2", // 수정 필요
            compute: (a, b) => a * 2,
            unselectedLuckGain: 3,
        },

        {
            formula: "pointVal - modVal", // 수정 필요
            compute: (a, b) => a - b,
            unselectedLuckGain: 4,
        },
        {
            formula: "pointVal * -2", // 수정 필요
            compute: (a, b) => a * -2,
            unselectedLuckGain: 4,
        },
        {
            formula: "= 5", // 수정 필요
            compute: (a, b) => 5,
            unselectedLuckGain: 4
        },
    ],
    rare: [
        {
            formula: "pointVal * modVal", // 수정 필요
            compute: (a, b) => a * b,
            unselectedLuckGain: 5,
        },
        {
            formula: "(pointVal + modVal) * 2", // 수정 필요
            compute: (a, b) => (a + b) * 2,
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal + (modVal * 2)", // 수정 필요
            compute: (a, b) => a + (b * 2),
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal * 2 + modVal", // 수정 필요
            compute: (a, b) => (a * 2) + b,
            unselectedLuckGain: 5,
        },
        {
            formula: "pointVal - modVal^3", // 수정 필요
            compute: (a, b) => a - Math.pow(b, 3),
            unselectedLuckGain: 5,
        },
        {
            formula: "= 15", // 수정 필요
            compute: (a, b) => 15,
            unselectedLuckGain: 5
        },
    ],
    epic: [
        {
            formula: "pointVal + modVal!", // 수정 필요
            compute: (a, b) => a + factorial(b),
            unselectedLuckGain: 7,
        },
        {
            formula: "pointVal * modVal * 2", // 수정 필요
            compute: (a, b) => a * b * 2,
            unselectedLuckGain: 8,
        },
        {
            formula: "(pointVal / modVal) ^ 2 (올림)", // 수정 필요
            compute: (a, b) => Math.pow(Math.ceil(a / b), 2),
            unselectedLuckGain: 8,
        },
        {
            formula: "= 40", // 수정 필요
            compute: (a, b) => 40,
            unselectedLuckGain: 8
        },
        {
            formula: "-(pointVal ^ 3)", // 수정 필요
            compute: (a, b) => -Math.pow(a, 3),
            unselectedLuckGain: 8,
        },
    ],
    legend: [
        {
            formula: "pointVal/modVal ^ (modVal/2) (올림)", // 수정 필요
            compute: (a, b) => Math.pow(Math.ceil(a / b), Math.ceil(b / 2)),
            unselectedLuckGain: 11,
        },
        {
            formula: "pointVal + modVal^modVal", // 수정 필요
            compute: (a, b) => a + Math.pow(b, b),
            unselectedLuckGain: 11,
        },
        {
            formula: "pointVal * modVal!", // 수정 필요
            compute: (a, b) => a * factorial(b),
            unselectedLuckGain: 11,
        },
        {
            formula: "| pointVal ^ 3 |", // 수정 필요
            compute: (a, b) => Math.abs(Math.pow(a, 2)),
            unselectedLuckGain: 11,
        },
    ],
};

// 끝: OPTION_LIBRARY

// ============================================================================
// 4. DOM 요소 캐시 (els)
// ============================================================================
// 게임 화면의 주요 HTML 요소들을 JavaScript에서 쉽게 접근할 수 있도록 미리 저장
const els = {
    pointVal: document.getElementById("pointVal"), // 현재 점수 표시
    modVal: document.getElementById("modVal"), // 현재 턴의 주사위 값
    turnDisplay: document.getElementById("turnDisplay"), // 턴 진행 상황 (n/5)
    luckScore: document.getElementById("luckScore"), // 행운값 표시
    luckInfoBtn: document.getElementById("luckInfoBtn"), // 행운값 설명 버튼
    luckInfoFloat: document.getElementById("luckInfoFloat"), // 행운값 설명 팝업
    calcLogBtn: document.getElementById("calcLogBtn"), // 계산 기록 버튼
    calcLogFloat: document.getElementById("calcLogFloat"), // 계산 기록 플로팅
    calcLogList: document.getElementById("calcLogList"), // 계산 기록 목록
    rarityBars: document.getElementById("rarityBars"), // 등급별 확률 바
    options: document.getElementById("options"), // 선택지 표시 영역
    footerPanel: document.querySelector(".footer-panel"), // 하단 버튼 영역
    startBtn: document.getElementById("startBtn"), // 게임 시작/주사위 굴리기 버튼
    muteBtn: document.getElementById("muteBtn"), // 음소거 토글 버튼
    message: document.getElementById("message"), // 게임 메시지
    diceRollSound: document.getElementById("diceRollSound"), // 주사위 굴림 사운드
    enhancedAppearSound: document.getElementById("enhancedAppearSound"), // 강화 선택지 등장 사운드
    // modal
    modal: document.getElementById("modal"),
    modalMessage: document.getElementById("modalMessage"),
    modalConfirm: document.getElementById("modalConfirm"),
    modalCancel: document.getElementById("modalCancel"),
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
    history: [], // 모든 턴의 결정 기록 (디버깅/통계용)
    phase: "idle", // 게임 상태 머신: idle -> rolling-point -> ... -> finished
    isMuted: false, // 전체 사운드 음소거 여부
    rollingTarget: null, // 현재 어느 주사위가 굴러가고 있는지 (pointVal or modVal)
    revealTarget: null, // 어느 주사위 결과를 보여주고 있는지 (미리보기 용)
    resolvingOptionId: null, // 선택 결과 적용 중인 옵션의 ID
    enhancedSoundTimeoutIds: [], // 강화 선택지 등장 사운드 예약 타이머
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
    return Math.floor(Math.random() * 6) + 1;
}

/**
 * 숫자에 천 단위 구분 쉼표 추가 (예: 1234567 -> "1,234,567")
 */
function formatNum(value) {
    const integerValue = Math.trunc(value);
    return integerValue.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 선택지 수식을 실제 값으로 치환해서 표시
 * 예: "pointVal + modVal" + pointVal=100, modVal=5 -> "100 + 5"
 */
function formatFormulaWithValues(formula, pointVal, modVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);

    return formula.replace(/pointVal/g, pointText).replace(/modVal/g, modText);
}

/**
 * 선택지 카드에서 사용할 수식 하이라이트 HTML 생성
 * - pointVal: 빨간색
 * - modVal: 파란색
 */
function formatFormulaWithHighlights(formula, pointVal, modVal) {
    const pointText = pointVal === null ? "-" : formatNum(pointVal);
    const modText = modVal === null ? "-" : formatNum(modVal);

    return formula
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
    const seed = Math.random();
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
    return list[Math.floor(Math.random() * list.length)];
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
    let modifier = null;
    const seed = Math.random();
    if (seed < ENHANCED_OPTION_CHANCE) {
        modifier = "enhanced";
    } else if (seed < ENHANCED_OPTION_CHANCE + NEGATIVE_OPTION_CHANCE) {
        modifier = "negative";
    }

    const activeLibrary = modifier === "negative"
        ? NEGATIVE_OPTION_LIBRARY
        : modifier === "enhanced"
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
            isNegative: modifier === "negative",
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
        isNegative: modifier === "negative",
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
                isNegative: false,
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

function applyAudioMuteState(isMuted) {
    if (els.diceRollSound) {
        els.diceRollSound.muted = isMuted;
    }

    if (els.enhancedAppearSound) {
        els.enhancedAppearSound.muted = isMuted;
    }
}

function updateMuteButtonUi() {
    if (!els.muteBtn) {
        return;
    }

    els.muteBtn.setAttribute("aria-pressed", String(state.isMuted));
    els.muteBtn.textContent = state.isMuted ? "소리 OFF" : "소리 ON";
}

function setMuted(isMuted) {
    state.isMuted = isMuted;
    applyAudioMuteState(isMuted);
    updateMuteButtonUi();
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

function clearEnhancedAppearSoundSchedule() {
    state.enhancedSoundTimeoutIds.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
    });
    state.enhancedSoundTimeoutIds = [];
}

function scheduleEnhancedAppearSounds(options) {
    clearEnhancedAppearSoundSchedule();

    options.forEach((option, index) => {
        if (!option.isEnhanced) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            playEnhancedAppearSound();
        }, index * OPTION_APPEAR_INTERVAL_MS);

        state.enhancedSoundTimeoutIds.push(timeoutId);
    });
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
    clearEnhancedAppearSoundSchedule();

    state.started = true;
    state.pointVal = null;
    state.modVal = null;
    state.turn = 0;
    state.luck = 0;
    state.options = [];
    state.history = [];
    state.phase = "rolling-point";

    els.message.textContent = "초기 시작 값 주사위를 굴리는 중...";
    renderStatus();

    await animateDiceRoll("pointVal");

    state.revealTarget = "pointVal";
    state.phase = "rolled-point-preview";
    els.message.textContent = `초기 시작 값 = ${state.pointVal}. 주사위를 확인하세요.`;
    renderStatus();
    await wait(1000);

    if (state.phase !== "rolled-point-preview") {
        return;
    }

    state.revealTarget = null;

    state.phase = "await-mod-roll";

    els.message.textContent = `초기 시작 값 = ${state.pointVal}. 1턴 주사위를 굴려보세요.`;
    renderStatus();
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

    state.revealTarget = "modVal";
    state.phase = "rolled-mod-preview";
    els.message.textContent = `${state.turn}턴 주사위 값 = ${state.modVal}. 주사위를 확인하세요.`;
    renderStatus();
    await wait(1000);

    if (state.phase !== "rolled-mod-preview") {
        return;
    }

    state.revealTarget = null;

    state.options = buildOptions();
    state.phase = "await-option";
    els.message.textContent = `${state.turn}턴 주사위 값 = ${state.modVal}. 선택지를 고르세요.`;
    renderStatus();
    scheduleEnhancedAppearSounds(state.options);
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
    state.options.forEach((option) => {
        if (option.id !== selected.id) {
            addedLuck += option.unselectedLuckGain;
        }
    });

    state.luck = Math.max(0, state.luck + addedLuck);

    state.history.push({
        turn: state.turn,
        modVal: state.modVal,
        expression: selected.formula,
        isEnhanced: Boolean(selected.isEnhanced),
        from: prevPoint,
        to: nextPoint,
        gainedLuck: addedLuck,
    });

    els.message.textContent = `선택이 적용되었습니다. 현재 값 ${formatNum(nextPoint)}`;

    if (state.turn >= MAX_TURNS) {
        state.resolvingOptionId = null;
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
    state.luck = Math.max(0, state.luck + addedLuck);

    state.history.push({
        turn: state.turn,
        modVal: state.modVal,
        expression: "스킵(모든 행운 획득)",
        isEnhanced: false,
        from: prevPoint,
        to: prevPoint,
        gainedLuck: addedLuck,
    });

    els.message.textContent = `스킵을 적용했습니다. Luck +${addedLuck}`;

    if (state.turn >= MAX_TURNS) {
        state.resolvingOptionId = null;
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
        ? "최대 한도 달성!"
        : reachedMinLimit
            ? "최소 한도 달성!"
            : "게임 종료!";

    els.message.textContent = `${finishLabel} 최종 pointVal ${formatNum(state.pointVal)}`;
    renderStatus();
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

function buildShareRecordText() {
    const finalValue = state.pointVal ?? 0;
    const finalRecordText = finalValue === SAFE_INT_LIMIT
        ? "MAX LIMIT!!"
        : finalValue === -SAFE_INT_LIMIT
            ? "MIN LIMIT!!"
            : formatNum(finalValue);

    const lines = [
        "🎲🎲 Numero 24/7 🎲🎲",
        "",
        `Final Record : ${finalRecordText}`,
        "",
    ];

    state.history.forEach((item, index) => {
        const turnHeader = item.isEnhanced ? `Turn ${item.turn} : (Enhanced)` : `Turn ${item.turn} :`;
        const formulaWithValues = formatFormulaWithValues(item.expression, item.from, item.modVal);
        lines.push(`${turnHeader} ${formatNum(item.from)} / 🎲 ${formatNum(item.modVal)}`);
        lines.push(`${formulaWithValues} = ${formatNum(item.to)}`);
        if (index < state.history.length - 1) {
            lines.push("");
        }
    });

    lines.push("");
    lines.push("Free To Play On");
    lines.push("https://numerodagame.netlify.app/");

    return lines.join("\n");
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

function renderDiceFace(value, extraClass = "") {
    /**
     * 주사위 면 HTML 렌더링
     * 3x3 격자의 점(pip)들로 주사위 눈을 표시
     * 
     * @param value - 1~6 주사위 눈
     * @param extraClass - 추가 CSS 클래스 (예: "small", "idle-spin")
     */
    const pips = new Set(getDicePips(value));
    const cells = Array.from({ length: 9 }, (_, idx) => idx + 1)
        .map((cellIndex) => `<span class="dice-pip${pips.has(cellIndex) ? " on" : ""}"></span>`)
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
    const rolledValue = clamp(state[target], 1, 6);
    const title = target === "pointVal" ? "초기 시작 값 확정" : `${state.turn}턴 주사위 값 확정`;

    els.options.innerHTML = `
            <div class="options-placeholder rolled-dice-preview fade-in" role="status" aria-live="polite">
                <p class="placeholder-title">${title}</p>
                <div class="reveal-dice-wrap">
                    <div class="dice-card reveal-card">${renderDiceFace(rolledValue)}</div>
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

    els.options.innerHTML = state.options
        .map((option, index) => {
            const rarityData = RARITIES[option.rarity];
            const displayFormula = formatFormulaWithHighlights(option.formula, state.pointVal, state.modVal);
            const optionStateClass = state.phase === "resolving-option"
                ? option.id === state.resolvingOptionId
                    ? "is-selected"
                    : "is-unselected"
                : "";
            const isDisabled = state.phase === "resolving-option" ? "disabled" : "";
            const staggerDelayMs = index * OPTION_APPEAR_INTERVAL_MS;
            const negativeClass = option.isNegative ? "is-negative" : "";
            const enhancedClass = option.isEnhanced ? "is-enhanced" : "";
            const modifierTag = option.isNegative
                ? `<span class="tag tag-negative">반전됨</span>`
                : option.isEnhanced
                    ? `<span class="tag tag-enhanced ${rarityData.className}">강화됨</span>`
                    : "";
            return `
                <button class="option-btn fade-in rarity-option-${option.rarity} ${negativeClass} ${enhancedClass} ${optionStateClass}" type="button" data-index="${index}" style="animation-delay:${staggerDelayMs}ms;" ${isDisabled}>
                    <p class="option-expression">${displayFormula}</p>
                    <div class="option-meta">
                        <span class="option-tags"><span class="tag ${rarityData.className}">${rarityData.label}</span>${modifierTag}</span>
                        <span>선택 안 하면 Luck +${option.unselectedLuckGain}</span>
                    </div>
                </button>
            `;
        })
        .join("");

    const skipLuckGain = state.options.reduce((sum, option) => sum + option.unselectedLuckGain, 0) * 2;
    const skipDisabled = state.phase === "resolving-option" ? "disabled" : "";
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
    els.pointVal.textContent = state.pointVal === null ? "-" : formatNum(state.pointVal);
    els.modVal.textContent = state.modVal === null ? "-" : formatNum(state.modVal);
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
            const beforeValue = item.from;
            const formulaWithValues = formatFormulaWithValues(item.expression, item.from, item.modVal);
            const resultValue = item.to;
            const enhancedMark = item.isEnhanced ? ' <span class="tag tag-enhanced">강화됨</span>' : "";

            return `
                <div class="calc-log-item">
                    <p class="calc-log-row"><strong>${item.turn}턴</strong>${enhancedMark}</p>
                    <p class="calc-log-row">· 굴린 주사위 값: ${formatNum(item.modVal)}</p>
                    <p class="calc-log-row">· 계산 전 현재 값: ${formatNum(beforeValue)}</p>
                    <p class="calc-log-row">· 계산식: ${formulaWithValues}</p>
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

    document.addEventListener("click", () => {
        setLuckInfoOpen(false);
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            setLuckInfoOpen(false);
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
        if (!state.started || state.phase === "finished") {
            // 게임 끝났을 때: confirmButtons 표시
            if (state.phase === "finished") {
                els.startBtn.style.display = "none";
                els.confirmButtons.style.display = "grid";
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
        startGame();
    });

    els.confirmNo.addEventListener("click", () => {
        els.confirmButtons.style.display = "none";
        els.startBtn.style.display = "block";
    });

    els.options.addEventListener("click", (event) => {
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

    if (els.muteBtn) {
        els.muteBtn.addEventListener("click", () => {
            setMuted(!state.isMuted);
        });
    }
}

// function bootstrapSupabaseBadge() {
//     const status = getSupabaseStatus();
//     els.supabaseBadge.textContent = status.message;
//     els.supabaseBadge.classList.remove("badge-on", "badge-off");
//     els.supabaseBadge.classList.add(status.ready ? "badge-on" : "badge-off");
// }

function init() {
    // bootstrapSupabaseBadge();
    setMuted(false);
    bindEvents();
    bindLuckInfoEvents();
    bindCalcLogEvents();
    renderStatus();

    window.addEventListener("resize", () => {
        fitPointValueFont();
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
        els.startBtn.textContent = state.phase === "finished" ? "다시 플레이하기" : "게임 시작";
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
