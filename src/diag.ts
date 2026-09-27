// 结构化诊断（设计文档第 7 节）—— JSON 是一等产物，终端彩色输出只是渲染结果。
import type { Span } from "./span.js";

export type Severity = "error" | "warning";

// 诊断码空间：CK0xxx 锚点 / CK1xxx 类型 / CK2xxx 名称作用域 / CK3xxx 效果与可变性 / CK4xxx 并发 / CK5xxx 风格
export const Code = {
  // Lexer / Parser
  LexError: "CK9001",
  ParseError: "CK9002",
  // 意图锚点
  AnchorViolation: "CK0001",
  AnchorExprType: "CK0002",
  // 类型
  TypeMismatch: "CK1001",
  ArgCount: "CK1002",
  NotCallable: "CK1003",
  MissingReturn: "CK1004",
  UnknownType: "CK1005",
  ConditionType: "CK1006",
  // 名称 / 作用域（幻觉 API 高发区）
  UnknownName: "CK2001",
  Redefinition: "CK2002",
  UnknownField: "CK2003",
  UnknownMethod: "CK2004",
  // 效果与可变性
  TryOnNonResult: "CK3001",
  ReassignImmutable: "CK3002",
  MutateImmutableField: "CK3003",
  // 并发
  ParallelNested: "CK4001",
  // 风格
  Style: "CK5001",
} as const;

export type Phase = "lexer" | "parser" | "typecheck" | "codegen";

export interface DiagFix {
  kind: "replace" | "insert" | "delete";
  range: [[number, number], [number, number]];
  text: string;
  confidence: number;
}

export interface DiagCost {
  tokens: number;
  chars: number;
}

export interface Diagnostic {
  toolchain: string;
  severity: Severity;
  code: string;
  phase: Phase;
  message: string;
  human: string;
  span: Span;
  symbol?: string;
  expected?: string;
  found?: string;
  intent_ref?: string;
  violated?: string[];
  hints: string[];
  fix?: DiagFix;
  cost: DiagCost;
}

export const TOOLCHAIN = "chock/0.1.0";
// 单条诊断 token 预算（规范 7.3：默认 ≤ 120 token/条，超出降级）
export const TOKEN_BUDGET = 120;

function roughTokens(s: string): number {
  // 轻量估算：中文按字计、英文按 4 字符 1 token 的保守估计，避免引入 tiktoken 依赖
  let n = 0;
  for (const ch of s) n += /[一-鿿]/.test(ch) ? 1 : 0.25;
  return Math.max(1, Math.round(n));
}

export interface DiagOpts {
  code: string;
  phase: Phase;
  message: string;
  span: Span;
  severity?: Severity;
  symbol?: string;
  expected?: string;
  found?: string;
  intentRef?: string;
  violated?: string[];
  hints?: string[];
  fix?: DiagFix;
}

export class DiagnosticCollector {
  readonly items: Diagnostic[] = [];

  add(o: DiagOpts): void {
    const loc = `${o.span.file}:${o.span.start.line}:${o.span.start.col}`;
    const human = `${loc} ${o.message}`;
    const payload = JSON.stringify(o.message) + JSON.stringify(o.hints ?? []);
    const cost: DiagCost = { tokens: roughTokens(payload), chars: payload.length };
    this.items.push({
      toolchain: TOOLCHAIN,
      severity: o.severity ?? "error",
      code: o.code,
      phase: o.phase,
      message: o.message,
      human,
      span: o.span,
      symbol: o.symbol,
      expected: o.expected,
      found: o.found,
      intent_ref: o.intentRef,
      violated: o.violated,
      hints: o.hints ?? [],
      fix: o.fix,
      cost,
    });
  }

  error(o: DiagOpts): void {
    this.add({ ...o, severity: "error" });
  }

  warn(o: DiagOpts): void {
    this.add({ ...o, severity: "warning" });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  toJSON(): unknown {
    // 超出 token 预算时降级为摘要 + 展开指令
    return this.items.map((d) => {
      if (d.cost.tokens <= TOKEN_BUDGET || d.hints.length === 0) return d;
      return { ...d, hints: d.hints.slice(0, 1), hint_expand: "chock explain <code>" };
    });
  }
}
