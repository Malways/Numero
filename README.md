# Numero Dice

모바일 우선 반응형으로 설계된 바닐라 JavaScript 게임 프로젝트입니다.

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
