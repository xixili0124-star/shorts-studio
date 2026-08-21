// SRT / VTT 읽고 쓰기
import { fmtSrtTime, uid } from './util.js';

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})|(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function toSeconds(str) {
  const m = str.trim().match(TIME);
  if (!m) return null;
  if (m[1] !== undefined) {
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
  }
  return (+m[5]) * 60 + (+m[6]) + (+m[7].padEnd(3, '0')) / 1000;
}

/** SRT/VTT 텍스트 -> [{id, start, end, text}] */
export function parseSrt(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').replace(/^WEBVTT.*\n/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    const arrowIdx = lines.findIndex(l => l.includes('-->'));
    if (arrowIdx < 0) continue;
    const [a, b] = lines[arrowIdx].split('-->');
    const start = toSeconds(a), end = toSeconds(b);
    if (start === null || end === null) continue;
    const body = lines.slice(arrowIdx + 1).join('\n').trim();
    if (!body) continue;
    out.push({ id: uid(), start, end: Math.max(end, start + 0.2), text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** [{start, end, text}] -> SRT 문자열 */
export function buildSrt(captions) {
  return captions
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text.trim()}\n`)
    .join('\n');
}
