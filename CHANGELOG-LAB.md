# 실험판 변경 기록

기준 저장소: `xixili0124-star/shorts-studio`

기준 커밋: `9eb4ef137222d393d247cf79f6f2a1b4b7713368`

작업 방식: 기준 스냅샷을 별도 폴더로 복사했습니다. 로컬 실험판 폴더에는 `.git`이 없습니다. 사용자 요청에 따라 `codex/studio-lab` 공유 브랜치와 검토용 Draft PR을 만들며, 운영 `main`과 원본 참조 clone은 보존합니다.

공유 준비 중 `main`의 새 커밋 `ee8e32563022f20dad147bd23d739ec993e32101`(TTS 추가)을 확인했습니다. 이 시제품은 기존 기준 커밋에서 분기하며, 새 TTS 작업을 자동 병합하거나 덮어쓰지 않습니다. 정식 통합 전에 관련 코어 변경을 조정해야 합니다.

## 새 진입점

`public/studio.html`, `public/studio.css`, `public/js/studio-app.js`가 새 UI입니다. 기존 `public/index.html`, `public/style.css`, `public/js/main.js`는 덮어쓰지 않았습니다. 기존 UI를 새 코어와 함께 정식 사용하도록 검수한 것은 아닙니다.

## 추가 모듈

공유 브랜치의 README에는 실험판 진입 안내를 붙였고 `.gitignore`에 Python 캐시·환경 파일·개인 `.shorts` 저장 파일을 제외했습니다.

- `project-store.js`: 미디어 자원과 편집 문서 분리, undo/redo, IndexedDB, 소재 포함 파일 저장, 원자적 복원.
- `timeline.js`: 트랙 렌더링, 클립 순서·트림·항목 이동, 스냅·확대·파형.
- `presets.js`: 그래픽 6종, 자막 8종, 전환 정의.
- `ai-client.js`: 다중 채널 WAV 변환, 실제 음성 타임스탬프 기반 자막.
- `studio_server.py`: 로컬 정적 서버 및 OpenAI TTS/STT 프록시. 원본 Cloudflare Worker를 호출하지 않음.

## 복사본의 기존 코어 수정

- `state.js`: 전환 겹침 시간표·레이어·음량 가중치, 클립에 연결된 자막/그래픽, 독립 오디오 트랙.
- `render.js`: 두 소스를 불투명 오프스크린 캔버스에서 합성, 그래픽·자막 스타일. 미리보기/내보내기 공통.
- `player.js`: 전환 중 두 영상 동기화, 독립 오디오, 프레임마다 BGM 페이드 갱신, undo와 분리한 비동기 디코더 상태.
- `audio.js`: 전환 크로스페이드, A1/A2 트랙 믹싱, 자막용 믹스에서 배경음악 제외.
- `exporter.js`: 출력 프레임마다 활성 소스 두 개를 디코딩하여 합성. faststart와 무음 오디오 트랙 유지.

## 운영 반영 전

브라우저 조작 및 실제 MP4 검수, HEVC/MKV 등 샘플 조합 검사, 한국어 음질 비교, 제품 UI 피드백이 남았습니다. Cloudflare에 올릴 경우 Python 로컬 프록시를 서버 측 서비스로 별도 이식하고 사용자 인증·요금 한도·권한·비밀키 관리가 필요합니다. 현재 프록시는 이 PC에서의 시제품 확인용입니다.

운영 반영은 승인 후 별도 브랜치와 PR로 진행해야 합니다. 원본 `stt-worker`, `wrangler.jsonc`, YouTube 업로드 설정은 변경하지 않았습니다.
