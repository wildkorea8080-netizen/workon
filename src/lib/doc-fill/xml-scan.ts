/**
 * 원본 XML을 다시 쓰지 않고 위치만 찾는 작은 훑개.
 *
 * 파서로 읽어 다시 쓰면 속성 순서·공백·네임스페이스 표기가 바뀔 수 있다.
 * 한글은 그런 차이에 까다로우므로 바꿀 곳만 문자열로 손댄다(설계 4.3).
 * 속성 값 안의 '>'도 따옴표로 묶여 있으면 태그 끝으로 보지 않는다.
 */
export interface XmlTag {
  /** '<' 위치 */
  start: number;
  /** '>' 다음 위치 */
  end: number;
  /** 접두어 포함 (예: hp:p) */
  name: string;
  kind: 'open' | 'close' | 'self';
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

export function scanTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(xml))) {
    tags.push({
      start: m.index,
      end: m.index + m[0].length,
      name: m[2],
      kind: m[1] ? 'close' : m[4] ? 'self' : 'open',
    });
  }
  return tags;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e in ENTITIES) return ENTITIES[e];
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    // 유니코드 범위 밖의 숫자 참조는 던지지 않고 대체 문자로 읽는다
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
  });
}

/**
 * XML 1.0에서 쓸 수 없는 글자(제어 문자 · 짝 없는 서로게이트 · U+FFFE/FFFF)를 뺀다.
 * 탭과 줄바꿈은 둔다. 한 글자라도 남으면 한글이 파일을 열지 못한다.
 */
export function stripInvalidXmlChars(s: string): string {
  return s.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  );
}

/** 글자 내용(요소 사이)용. 따옴표는 속성 값이 아니므로 그대로 둔다 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 문단 네임스페이스의 접두어. 한글은 보통 hp를 쓰지만 선언을 따른다 */
export function paragraphPrefix(xml: string): string {
  const m = xml.match(/xmlns:([\w.-]+)="http:\/\/www\.hancom\.co\.kr\/hwpml\/2011\/paragraph"/);
  return m ? m[1] : 'hp';
}
