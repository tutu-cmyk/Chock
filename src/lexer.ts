// Lexer：把 .cok 源码切成 Token，处理 Python 风格的缩进块（INDENT/DEDENT）。
import { spanOf, type Span } from "./span.js";
import { Code, type DiagnosticCollector } from "./diag.js";

export type TokKind =
  | "IDENT" | "INT" | "FLOAT" | "STRING" | "COMMENT"
  | "NEWLINE" | "INDENT" | "DEDENT" | "EOF"
  | "FN" | "ASYNC" | "TYPE" | "ENUM" | "LET" | "VAR" | "RETURN"
  | "IF" | "ELIF" | "ELSE" | "WHILE" | "FOR" | "IN" | "MATCH"
  | "TRUE" | "FALSE" | "NUL" | "AND" | "OR" | "NOT" | "PARALLEL" | "MODULE" | "IMPORT"
  | "INT_KW" | "FLOAT_KW" | "STRING_KW" | "BOOL_KW"
  | "LPAREN" | "RPAREN" | "LBRACK" | "RBRACK" | "LBRACE" | "RBRACE"
  | "COMMA" | "COLON" | "AT" | "DOT" | "QM" | "ARROW"
  | "ASSIGN" | "PLUS_EQ" | "MINUS_EQ" | "STAR_EQ" | "SLASH_EQ"
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "PERCENT"
  | "EQ" | "NE" | "LT" | "LE" | "GT" | "GE";

export interface Tok {
  kind: TokKind;
  value: string;
  line: number;
  col: number; // 起始列（1-based）
  endLine: number;
  endCol: number; // 结束列（1-based, 指向末字符）
}

const KEYWORDS: Record<string, TokKind> = {
  fn: "FN", async: "ASYNC", type: "TYPE", enum: "ENUM", let: "LET", var: "VAR",
  return: "RETURN", if: "IF", elif: "ELIF", else: "ELSE", while: "WHILE",
  for: "FOR", in: "IN", match: "MATCH", true: "TRUE", false: "FALSE", null: "NUL",
  and: "AND", or: "OR", not: "NOT", parallel: "PARALLEL",
  module: "MODULE", import: "IMPORT",
  // 注：Int/Float/String/Bool 是上下文相关的普通标识符：
  // 在类型位置由 parseType 识别，在表达式位置是内置转换函数（Checker BUILTINS）。
};

const SINGLE: Record<string, TokKind> = {
  "(": "LPAREN", ")": "RPAREN", "[": "LBRACK", "]": "RBRACK", "{": "LBRACE", "}": "RBRACE",
  ",": "COMMA", ":": "COLON", "@": "AT", ".": "DOT", "?": "QM",
  "+": "PLUS", "-": "MINUS", "*": "STAR", "/": "SLASH", "%": "PERCENT",
};

export function tokenize(file: string, src: string, diag: DiagnosticCollector): Tok[] {
  const toks: Tok[] = [];
  const lines = src.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const indentStack = [0];
  let bracketDepth = 0;
  let atLineStart = true;

  const push = (kind: TokKind, value: string, l: number, c: number, el?: number, ec?: number) => {
    toks.push({ kind, value, line: l, col: c, endLine: el ?? l, endCol: ec ?? c + value.length - 1 });
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineNo = li + 1;
    // 计算缩进
    let i = 0;
    let indent = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) {
      indent += line[i] === "\t" ? 4 : 1;
      i++;
    }
    // 空行：括号外直接跳过。纯注释行：发出 COMMENT/NEWLINE 但不改动缩进栈，
    // 这样注释可被 parser/fmt 保留，又不会制造幽灵 INDENT/DEDENT。
    const rest = line.slice(i);
    const restTrim = rest.trim();
    const commentLine = restTrim.startsWith("#");
    if (restTrim === "" && bracketDepth === 0) continue;

    if (bracketDepth === 0 && atLineStart) {
      if (!commentLine && indent > indentStack[indentStack.length - 1]) {
        // 注释行不能开启新缩进块（避免幽灵 INDENT）
        indentStack.push(indent);
        push("INDENT", "", lineNo, i + 1);
      } else {
        // 注释行参与退缩进：否则 DEDENT 会延迟到下一代码行，
        // 导致块外注释被内层块的 parser 吞掉
        while (indent < indentStack[indentStack.length - 1]) {
          indentStack.pop();
          push("DEDENT", "", lineNo, i + 1);
        }
        if (!commentLine && indent !== indentStack[indentStack.length - 1]) {
          diag.error({
            code: Code.LexError, phase: "lexer",
            message: "缩进不一致：未与任何外层缩进对齐",
            span: spanOf(file, lineNo, 1, lineNo, i + 1),
          });
        }
      }
    }

    // 切分本行 token
    let emitted = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === " " || ch === "\t") { i++; continue; }
      const col = i + 1;

      if (ch === "#") {
        const raw = line.slice(i);
        push("COMMENT", raw, lineNo, col, lineNo, i + raw.length);
        emitted++;
        break;
      }

      // 字符串（不支持三引号）
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === "\\" && j + 1 < line.length) j += 2;
          else j++;
        }
        if (j >= line.length) {
          diag.error({
            code: Code.LexError, phase: "lexer",
            message: "字符串缺少结束引号",
            span: spanOf(file, lineNo, col, lineNo, line.length),
          });
          i = line.length;
          continue;
        }
        push("STRING", line.slice(i, j + 1), lineNo, col, lineNo, j + 1);
        i = j + 1;
        emitted++;
        continue;
      }

      // 数字
      if (/[0-9]/.test(ch)) {
        let j = i + 1;
        let isFloat = false;
        while (j < line.length && /[0-9_]/.test(line[j])) j++;
        if (line[j] === "." && /[0-9]/.test(line[j + 1] ?? "")) {
          isFloat = true;
          j++;
          while (j < line.length && /[0-9_]/.test(line[j])) j++;
        }
        if (line[j] === "e" || line[j] === "E") {
          isFloat = true;
          j++;
          if (line[j] === "+" || line[j] === "-") j++;
          while (j < line.length && /[0-9]/.test(line[j])) j++;
        }
        const text = line.slice(i, j);
        push(isFloat ? "FLOAT" : "INT", text, lineNo, col, lineNo, col + text.length - 1);
        i = j;
        emitted++;
        continue;
      }

      // 标识符 / 关键字
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
        const text = line.slice(i, j);
        const kind = KEYWORDS[text] ?? "IDENT";
        push(kind, text, lineNo, col, lineNo, col + text.length - 1);
        i = j;
        emitted++;
        continue;
      }

      // 多字符操作符
      const two = line.slice(i, i + 2);
      if (two === "->") { push("ARROW", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === "==") { push("EQ", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === "!=") { push("NE", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === "<=") { push("LE", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === ">=") { push("GE", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === "+=") { push("PLUS_EQ", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === "-=") { push("MINUS_EQ", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === "*=") { push("STAR_EQ", two, lineNo, col); i += 2; emitted++; continue; }
      if (two === "/=") { push("SLASH_EQ", two, lineNo, col); i += 2; emitted++; continue; }
      if (ch === "=") { push("ASSIGN", "=", lineNo, col); i += 1; emitted++; continue; }
      if (ch === "<") { push("LT", "<", lineNo, col); i += 1; emitted++; continue; }
      if (ch === ">") { push("GT", ">", lineNo, col); i += 1; emitted++; continue; }

      if (SINGLE[ch]) {
        const kind = SINGLE[ch];
        push(kind, ch, lineNo, col);
        if (ch === "(" || ch === "[" || ch === "{") bracketDepth++;
        if (ch === ")" || ch === "]" || ch === "}") bracketDepth = Math.max(0, bracketDepth - 1);
        i++;
        emitted++;
        continue;
      }

      diag.error({
        code: Code.LexError, phase: "lexer",
        message: `无法识别的字符 '${ch}'`,
        span: spanOf(file, lineNo, col, lineNo, col),
      });
      i++;
      emitted++;
    }

    if (bracketDepth === 0 && emitted > 0) {
      const lastCol = Math.max(1, line.replace(/\s+$/, "").length + 1);
      push("NEWLINE", "", lineNo, lastCol);
      atLineStart = true;
    } else if (bracketDepth > 0) {
      atLineStart = false;
    }
  }

  // EOF：补齐 DEDENT 与终止 NEWLINE
  while (indentStack.length > 1) {
    indentStack.pop();
    push("DEDENT", "", lines.length, 1);
  }
  push("NEWLINE", "", lines.length, 1);
  push("EOF", "", lines.length, 1);
  return toks;
}

export function tokSpan(file: string, t: Tok): Span {
  return spanOf(file, t.line, t.col, t.endLine, t.endCol);
}
