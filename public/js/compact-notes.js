// 설명 문단을 한 줄로 접고, 누르면 그 문단만 펼칩니다.
// 패널은 편집할 때마다 통째로 다시 그려지므로, 개별 요소에 리스너를 달지 않고
// 문서 한 곳에서 위임으로 받습니다. 접힘 여부는 그릴 때마다 다시 재야 합니다.

const HOSTS = ['libraryContent', 'inspectorContent'];
const SELECTOR = '.inspector-note, .library-hint';
const STORAGE = 'studio.hints';

/** 실제로 잘린 문단에만 펼치기 표시를 답니다. 한 줄로 끝나는 글은 건드리지 않습니다. */
function markClampable(root = document) {
  for (const note of root.querySelectorAll(SELECTOR)) {
    if (note.classList.contains('is-open')) continue;
    note.classList.toggle('is-clampable', note.scrollHeight - note.clientHeight > 1);
  }
}

export function setupCompactNotes() {
  let queued = false;
  const remeasure = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; markClampable(); });
  };

  // 펼치기·접기
  document.addEventListener('click', event => {
    const note = event.target.closest?.(SELECTOR);
    if (!note || !note.classList.contains('is-clampable')) return;
    note.classList.toggle('is-open');
  });

  // 패널이 다시 그려질 때마다 다시 잽니다.
  const observer = new MutationObserver(remeasure);
  for (const id of HOSTS) {
    const host = document.getElementById(id);
    if (host) observer.observe(host, { childList: true, subtree: true });
  }
  window.addEventListener('resize', remeasure);

  // 앱바 토글. 켜면 예전처럼 전부 펼쳐진 상태가 됩니다.
  const button = document.getElementById('toggleHints');
  const apply = on => {
    if (on) document.documentElement.dataset.hints = 'on';
    else delete document.documentElement.dataset.hints;
    if (button) {
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', on ? '설명 문구 접기' : '설명 문구 펼치기');
      button.title = on ? '설명 접기 · 화면을 간결하게' : '설명 펼치기 · 기능 설명 보기';
    }
    if (!on) remeasure();
  };
  let saved = false;
  try { saved = localStorage.getItem(STORAGE) === 'on'; } catch { saved = false; }
  apply(saved);
  button?.addEventListener('click', () => {
    const next = document.documentElement.dataset.hints !== 'on';
    apply(next);
    try { localStorage.setItem(STORAGE, next ? 'on' : 'off'); } catch { /* 저장 못 해도 이번 세션은 동작합니다 */ }
  });

  remeasure();
}
