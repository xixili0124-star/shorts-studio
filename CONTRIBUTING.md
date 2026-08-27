# 같이 작업하기

## AI 로 작업한다면

**[CLAUDE.md](CLAUDE.md) 를 AI 에게 먼저 읽히세요.** 클로드 코드는 자동으로 읽지만,
다른 도구를 쓴다면 대화 시작할 때 그 파일 내용을 붙여넣으면 됩니다.

설계 제약(빌드 없음, npm 의존성 없음, 파일을 서버로 안 보냄)과 이미 실측으로 확인한
함정들이 적혀 있습니다. 이걸 모르면 AI 가 "더 좋게" 바꾸려다 되돌려 놓습니다.

## 처음 한 번

```bash
git clone https://github.com/xixili0124-star/shorts-studio.git
cd shorts-studio
npx serve public      # http://localhost:3000 에서 열린다
```

빌드 단계가 없다. 설치할 것도 없고 `npx serve` 하나면 바로 뜬다.

## 작업 순서

**항상 브랜치를 따서 작업한다.** main 에 바로 커밋하면 서로 밀어내면서 충돌한다.

```bash
git switch main
git pull                      # 시작 전에 항상 최신으로
git switch -c 작업이름          # 예: git switch -c 자막-스타일
# ... 작업 ...
git add -A
git commit -m "무엇을 왜 바꿨는지"
git push -u origin 작업이름
```

그다음 GitHub 에서 **Pull Request** 를 연다. 서로 한 번 보고 합치면
"내 것만 남고 네 것이 사라지는" 사고가 안 난다.

## 충돌이 났을 때

```bash
git switch main && git pull
git switch 작업이름
git merge main                # 여기서 충돌 표시가 뜬다
# 표시된 파일을 열어 <<<<<<< ======= >>>>>>> 부분을 정리
git add -A && git commit
```

무섭게 생겼지만 파일 안의 표시된 부분만 고르면 된다.

## 배포

**`main` 에 합쳐지면 Cloudflare 가 알아서 배포한다.** 따로 할 일이 없다.

```
PR 승인 -> main 병합 -> 자동 배포 -> https://shorts-studio-75p.pages.dev
```

배포 상태는 여기서 본다.

```bash
npx wrangler pages deployment list --project-name shorts-studio
```

**`wrangler pages deploy` 로 직접 올리지 않는다.** Git 연결이 돼 있으므로
직접 업로드를 섞으면 어느 쪽이 현재 사이트인지 추적이 안 된다.
(연결 여부는 `npx wrangler pages project list` 의 `Git Provider` 열로 확인한다)

## 건드리면 안 되는 것

| 파일 | 이유 |
|---|---|
| `public/vendor/mediabunny.min.js` | 외부 라이브러리. 수정하지 말고 버전만 올린다 |
| `stt-worker/` | 배포하면 자동 자막 서버가 바뀐다. 혼자 실험하지 말 것 |

## 코드에 개인 키를 넣지 않는다

- 유튜브 OAuth 클라이언트 ID 는 각자 브라우저(localStorage)에 저장된다. 코드에 넣지 않는다
- 인스타 발행은 이 저장소가 아니라 별도 로컬 프로젝트에 있다. 토큰도 거기 있다
- 실수로 키를 커밋했다면 **지우는 커밋만으로는 안 지워진다.** 이력에 남으므로
  그 키를 폐기하고 새로 발급받아야 한다

## 커밋 메시지

무엇을 바꿨는지보다 **왜 바꿨는지**를 적는다. 코드를 보면 무엇은 알 수 있지만
왜는 알 수 없다.

```
자막 문턱값을 무음 바닥 기준으로 변경

피크 기준으로 잡으니 웅얼거린 구간(RMS 0.008)이 또렷한 말(0.07)에 밀려
묵음 처리됐다. 정작 찾아야 할 구간이 안 잡히는 문제.
```
