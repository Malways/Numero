// ============================================================================
// 레거시 특성 모음 — 선택 불가지만 코드는 제거하지 않는다.
// 과거 리더보드/명예의 전당 기록의 표시(특성 이름/색/이모지 렌더)에 필요하다.
// main.js의 PERK_LIB 끝에 병합되며, `legacy: true`로 선택 풀/특성 목록/컬렉터
// 카운트에서 자동 제외된다. 새로 레거시화할 특성은 이 파일로 옮기면 된다.
// ============================================================================

export const LEGACY_PERKS = [
    {
        id: "perk-strategic-retreat",
        name: "전략적 후퇴",
        description: "주사위를 굴릴 때마다 눈금 × -50을 점수에 더합니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(5, 55, 20, 0.97) 0%, rgba(15, 90, 35, 0.96) 50%, rgba(8, 70, 25, 0.97) 100%)",
        glitterColor: "rgba(80, 220, 100, 1)",
        glitterIntensity: 0.72,
        textColor: "#ffffff",
        legacy: true,
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-bullseye",
        name: "불스아이",
        description: "주사위 번호와 턴이 일치하면 점수를 그만큼 배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(165, 0, 18, 0.97), rgba(232, 1, 36, 0.95))",
        glitterColor: "rgba(255, 255, 255, 1)",
        glitterIntensity: 0.72,
        textColor: "#ffffff",
        legacy: true,
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-gros-michel",
        name: "그로 미셸",
        legacy: true,
        description: "주사위가 1이 나올 때마다 점수를 6배로 만듭니다.",
        backgroundStyle: "linear-gradient(160deg, rgba(210, 165, 20, 0.96), rgba(245, 200, 42, 0.94))",
        glitterColor: "rgba(255, 232, 130, 1)",
        glitterIntensity: 0.75,
        textColor: "#2d2000",
        applyTemplate: (_gameState) => { },
    },
    {
        id: "perk-salvation",
        name: "구원",
        description: "게임당 한 번, 주사위가 1이 나오면 6으로 변경합니다.",
        legacy: true,
        backgroundStyle: "linear-gradient(160deg, rgba(250, 238, 160, 0.96), rgba(255, 248, 200, 0.97))",
        glitterColor: "rgba(255, 253, 230, 1)",
        glitterIntensity: 0.7,
        textColor: "#3a2c00",
        applyTemplate: (_gameState) => { },
    },
];
