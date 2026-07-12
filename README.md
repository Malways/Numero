# Numero Dice

사용한 에셋 - 



모바일 우선 반응형으로 설계된 바닐라 JavaScript 게임 프로젝트입니다.


이 글은 Claude Sonnet 4.6으로 추정되는 텅텅이가 썼습니다.


어쩌피 테스트용 레포니 신경 안 쓰셔도 됩니다.

각설하고 플레이는 https://numerodagame.netlify.app/ 에서 하실 수 있습니다.


미완성된 버전이고, 이후 DB를 추가하면 프라이빗 레포가 될 예정입니다.


## 게임 규칙

1. 시작 시 주사위를 굴려 첫 숫자 `pointVal`을 정합니다.
2. 각 턴마다 주사위를 굴려 `modVal`을 정합니다.
3. `modVal` 기반의 3개 선택지가 뜨고, 각 선택지는 `일반/희귀/특급/전설` 등급을 가집니다.
4. 하나를 선택해 계산한 결과를 새 `pointVal`로 적용합니다.
5. 선택되지 않은 카드의 등급에 비례해 Luck이 증가하고, 다음 턴 고등급 카드 등장 확률이 올라갑니다.
6. 총 3턴 후 최종 `pointVal`이 점수입니다.

## 폴더 구조

- `index.html`: 메인 화면
- `css/style.css`: 모바일 우선 UI + 데스크탑 폰 비율 유지 스타일
- `js/main.js`: 게임 로직, 확률/턴 처리, 렌더링
- `js/config.js`: Supabase 연동을 위한 설정 자리
- `js/supabase.js`: 추후 Supabase 클라이언트 연결용 래퍼

## 로컬 실행

정적 파일 프로젝트이므로 VS Code Live Server 또는 간단한 정적 서버로 실행하면 됩니다.

예시(PowerShell):

```powershell
# Python이 있다면
python -m http.server 5500
```

그리고 브라우저에서 `http://localhost:5500` 접속.

## Supabase 연결 준비

현재는 실제 연결을 하지 않고 구조만 준비되어 있습니다.

1. `js/config.js`에서 아래 값을 채웁니다.
   - `supabaseEnabled`
   - `supabaseUrl`
   - `supabaseAnonKey`
2. 추후 `js/supabase.js`에 `@supabase/supabase-js` 연결 로직을 추가합니다.

## GitHub Private Repo 업로드

```bash
git init
git add .
git commit -m "feat: bootstrap Numero Dice project"
git branch -M main
git remote add origin <PRIVATE_REPO_URL>
git push -u origin main
```

## 배포 옵션

### 1) Vercel

- New Project -> GitHub private repo 가져오기
- Framework Preset: `Other`
- Build Command: 비움
- Output Directory: `.`

정적 사이트라 추가 빌드 없이 바로 배포됩니다.

### 2) GitHub Pages

- 저장소 Settings -> Pages
- Source: `Deploy from a branch`
- Branch: `main`, Folder: `/ (root)`

private repo Pages는 요금제/조직 정책에 따라 제약이 있을 수 있습니다.

## 구현 참고

- 모바일에서는 화면을 꽉 채우고,
- 데스크탑에서는 중앙에 폰 비율 프레임을 유지하며 바깥은 배경으로 채웁니다.

## 특성 글린트(반짝임) 구현 규칙

특성 카드의 글린트는 두 방식이 있으며, 표시 위치가 3곳이라 셀렉터를 빠짐없이 챙겨야 합니다.

### 1) 기본 글린트 (대부분의 특성)

PERK_LIB의 `glitterColor`(빛줄기 색) + `glitterIntensity`(불투명도 0~1)만 정의하면
아래 3곳에 자동 적용됩니다. 별도 CSS 불필요.

- 특성 선택지 카드 (`.perk-option-btn::before`)
- 리더보드 특성 뱃지 (`.lb-perk-badge::before`)
- 유저 검색 최다 플레이 특성 카드 (`.user-stat-row.perk-colored::before`
  — JS가 인라인 변수 `--tier-glitter`, `--stat-glitter-opacity`로 전달)

주의: 배경(`backgroundStyle`)이 밝은 특성에 흰색/연한 glitterColor를 주면
글린트가 안 보입니다 (라스트 슈팅이 이 케이스여서 전용 글린트로 해결).

### 2) 전용 글린트 (라스트 슈팅, 붉은 혜성 등 커스텀 애니메이션)

전용 keyframes를 쓰는 특성은 `data-perk-id` 셀렉터로 오버라이드합니다.
**새 전용 글린트를 만들 때는 아래 3개 셀렉터를 반드시 함께 등록할 것:**

```css
.perk-option-btn[data-perk-id="perk-이름"]::before,
.lb-perk-badge[data-perk-id="perk-이름"]::before,
.user-stat-row.perk-colored[data-perk-id="perk-이름"]::before {
    /* 전용 배경/애니메이션 */
}
```

- 유저 검색 셀렉터는 `.perk-colored`를 붙여 특이도를 올려야 합니다 —
  일반 글린트 규칙(`.user-stat-row.perk-colored::before`)이 CSS 뒤쪽에 있어서
  특이도가 같으면 전용 규칙이 덮어써집니다.
- 애니메이션 주기는 다른 특성과 동일하게 2.2s로 맞춥니다
  (유저 검색의 점수 등급 카드만 예외적으로 1.6s).
