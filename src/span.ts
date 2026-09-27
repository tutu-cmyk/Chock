// 源码位置（行、列均从 1 开始，与诊断规范 v1 对齐）
export interface Pos {
  line: number;
  col: number;
}

export interface Span {
  file: string;
  start: Pos;
  end: Pos;
}

export function spanOf(file: string, sl: number, sc: number, el: number, ec: number): Span {
  return { file, start: { line: sl, col: sc }, end: { line: el, col: ec } };
}

export function mergeSpan(a: Span, b: Span): Span {
  return { file: a.file, start: a.start, end: b.end };
}
