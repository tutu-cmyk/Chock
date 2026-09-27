// Python 3.11+ 转译后端（Phase 0）。
// 产物：*.py（可读源码）+ *.pyi（类型存根）+ *.cokmap（源映射）+ schema/*.json
import * as fs from "node:fs";
import * as path from "node:path";
import type * as A from "./ast.js";

// ---------- 类型节点 → Python 类型字符串 ----------
export function pyType(t: A.TypeNode): string {
  let s: string;
  switch (t.name) {
    case "Int": s = "int"; break;
    case "Float": s = "float"; break;
    case "String": s = "str"; break;
    case "Bool": s = "bool"; break;
    case "Unit": s = "None"; break;
    case "List": s = `list[${t.args.length ? pyType(t.args[0]) : "Any"}]`; break;
    case "Dict": s = `dict[${t.args.length === 2 ? `${pyType(t.args[0])}, ${pyType(t.args[1])}` : "str, Any"}]`; break;
    case "Result": s = `Result[${t.args.length === 2 ? `${pyType(t.args[0])}, ${pyType(t.args[1])}` : "Any, ChockError"}]`; break;
    case "Error": s = "ChockError"; break;
    default: s = t.name + (t.args.length ? `[${t.args.map(pyType).join(", ")}]` : "");
  }
  return t.optional ? `${s} | None` : s;
}

// ---------- 行写入器（带源映射） ----------
class Writer {
  private lines: { text: string; src?: number }[] = [];
  indent = 0;

  line(src: number | undefined, text: string): void {
    this.lines.push({ text: "    ".repeat(this.indent) + text, src });
  }
  blank(): void { this.lines.push({ text: "" }); }
  raw(text: string): void {
    for (const l of text.split("\n")) this.lines.push({ text: "    ".repeat(this.indent) + l });
  }
  get text(): string { return this.lines.map((l) => l.text).join("\n") + "\n"; }
  sourceMap(cokFile: string): unknown {
    const mappings: Record<string, [number, number]> = {};
    this.lines.forEach((l, i) => {
      if (l.src !== undefined) mappings[String(i + 1)] = [l.src, 1];
    });
    return { version: 1, toolchain: "chock/0.1.0", source: cokFile, mappings };
  }
}

// ---------- 表达式生成 ----------
const INTERP_RE = /\{[A-Za-z_][A-Za-z0-9_.()[\]\s',]*\}/g;

function strLit(raw: string): string {
  // Chock 字符串转义规则与 Python 同源；含 {expr} 插值的字面量升级为 f-string。
  // 仅当花括号内容"看起来像表达式"（标识符开头，且不含双引号/冒号）才判定为插值，
  // 从而避免 JSON 字面量（{"title": ...}）被误升级。
  const quote = raw[0];
  const body = raw.slice(1, -1);
  const hasInterp = (body.match(INTERP_RE) ?? []).some((m) => {
    const inner = m.slice(1, -1);
    return /^[A-Za-z_]/.test(inner) && !inner.includes('"') && !inner.includes(":");
  });
  if (hasInterp) {
    // 逐段扫描：插值花括号保留，其余字面花括号转义为 {{ }}（f-string 要求）
    let out = "";
    let i = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === "{") {
        const close = body.indexOf("}", i + 1);
        const inner = close >= 0 ? body.slice(i + 1, close) : null;
        if (inner !== null && /^[A-Za-z_][A-Za-z0-9_.()[\]\s',]*$/.test(inner) &&
            !inner.includes('"') && !inner.includes(":")) {
          out += "{" + inner + "}";
          i = close + 1;
          continue;
        }
        out += "{{"; i++; continue;
      }
      if (ch === "}") { out += "}}"; i++; continue; }
      out += ch; i++;
    }
    return "f" + quote + out + quote;
  }
  return quote + body + quote;
}

class CodeGen {
  private w = new Writer();
  private asyncStack: boolean[] = [];
  private get isAsync(): boolean { return this.asyncStack[this.asyncStack.length - 1] ?? false; }

  constructor(private prog: A.Program, private cokFile: string) {}

  // ---------- 头部 ----------
  private header(w: Writer, stub: boolean): void {
    w.line(1, "# ============================================================");
    w.line(1, "# 本文件由 Chock 0.1.0 自动转译，请勿手工修改。");
    w.line(1, `# 源文件：${this.cokFile}`);
    w.line(1, "# ============================================================");
    w.line(1, "from __future__ import annotations");
    if (stub) {
      w.line(1, "from enum import Enum");
      w.line(1, "from dataclasses import dataclass");
      w.line(1, "from typing import Any, Generic, TypeVar");
      w.line(1, "from chock_runtime import Ok, Err, Result, ChockError, ChockModel, Unit");
    } else {
      w.line(1, "from enum import Enum");
      w.line(1, "from dataclasses import dataclass, field");
      w.line(1, "from chock_runtime import (");
      w.indent++;
      for (const n of ["Ok", "Err", "Result", "ChockError", "ChockModel", "Unit", "_chock_try", "_chock_parallel_for", "_chock_parse_int", "_chock_parse_float", "chock_result", "chock_contract"]) {
        w.line(1, n + ",");
      }
      w.indent--;
      w.line(1, ")");
    }
    for (const imp of this.prog.imports) {
      const leaf = imp.path.split("/").pop();
      w.line(imp.span.start.line, `from chock_std import ${leaf}  # import ${imp.path}`);
    }
    w.blank();
  }

  generate(): { py: string; pyi: string; map: unknown } {
    // ---- .py ----
    this.header(this.w, false);
    for (const d of this.prog.decls) {
      if (d.kind === "enum") this.genEnum(d);
      else if (d.kind === "type_decl") this.genRecord(d);
    }
    for (const d of this.prog.decls) {
      if (d.kind === "fn") this.genFn(d);
    }
    const mainFn = this.prog.decls.find((d): d is A.FnDecl => d.kind === "fn" && d.name === "main");
    if (mainFn) {
      this.w.line(mainFn.span.start.line, `if __name__ == "__main__":`);
      if (mainFn.async) {
        this.w.indent++;
        this.w.line(mainFn.span.start.line, "import asyncio");
        this.w.line(mainFn.span.start.line, "asyncio.run(main())");
        this.w.indent--;
      } else {
        this.w.indent++;
        this.w.line(mainFn.span.start.line, "main()");
        this.w.indent--;
      }
      this.w.blank();
    }
    const py = this.w.text;
    const map = this.w.sourceMap(this.cokFile);

    // ---- .pyi ----
    const sw = new Writer();
    this.header(sw, true);
    for (const d of this.prog.decls) {
      if (d.kind === "enum") this.genEnumStub(sw, d);
      else if (d.kind === "type_decl") this.genRecordStub(sw, d);
    }
    for (const d of this.prog.decls) {
      if (d.kind === "fn") this.genFnStub(sw, d);
    }
    return { py, pyi: sw.text, map };
  }

  // ---------- enum ----------
  private genEnum(d: A.EnumDecl): void {
    this.w.line(d.span.start.line, `class ${d.name}(Enum):`);
    this.w.indent++;
    for (const m of d.members) this.w.line(d.span.start.line, `${m} = "${m}"`);
    this.w.indent--;
    this.w.blank();
  }
  private genEnumStub(w: Writer, d: A.EnumDecl): void {
    w.line(d.span.start.line, `class ${d.name}(Enum):`);
    w.indent++;
    for (const m of d.members) w.line(d.span.start.line, `${m} = "${m}"`);
    w.indent--;
    w.blank();
  }

  // ---------- record ----------
  private genRecord(d: A.TypeDecl): void {
    this.w.line(d.span.start.line, "@dataclass");
    this.w.line(d.span.start.line, `class ${d.name}(ChockModel):`);
    this.w.indent++;
    for (const f of d.fields) {
      const tail = f.default ? ` = ${this.expr(f.default)}` : "";
      this.w.line(f.span.start.line, `${f.name}: ${pyType(f.type)}${tail}`);
    }
    this.w.indent--;
    this.w.blank();
  }
  private genRecordStub(w: Writer, d: A.TypeDecl): void {
    w.line(d.span.start.line, "@dataclass");
    w.line(d.span.start.line, `class ${d.name}(ChockModel):`);
    w.indent++;
    for (const f of d.fields) {
      let tail = "";
      if (f.default) tail = f.default.kind === "null" ? ` = None` : ` = ...`;
      w.line(f.span.start.line, `${f.name}: ${pyType(f.type)}${tail}`);
    }
    w.indent--;
    w.blank();
  }

  // ---------- fn ----------
  private contractDecorator(d: A.FnDecl): string[] {
    const intent = d.decorators.find((x) => x.name === "intent");
    const reqs = d.decorators.filter((x) => x.name === "require" && x.expr);
    const ens = d.decorators.filter((x) => x.name === "ensure" && x.expr);
    if (!intent && !reqs.length && !ens.length) return [];
    const pnames = d.params.map((p) => p.name);
    const lines: string[] = ["@chock_contract("];
    if (intent?.text !== undefined) lines.push(`    intent=${JSON.stringify(intent.text)},`);
    if (reqs.length) {
      const ps = pnames.join(", ");
      lines.push(`    requires=[${reqs.map((r) => `lambda ${ps}: ${this.expr(r.expr!)}`).join(", ")}],`);
    }
    if (ens.length) {
      const ps = pnames.join(", ");
      lines.push(`    ensures=[${ens.map((r) => `lambda result, ${ps}: ${this.expr(r.expr!)}`).join(", ")}],`);
    }
    lines.push(")");
    return lines;
  }

  private genFn(d: A.FnDecl): void {
    const returnsResult = d.returnType.name === "Result";
    // 意图注释（语义锚，随源码走，防止 Agent 上下文漂移）
    const intent = d.decorators.find((x) => x.name === "intent");
    if (intent?.text !== undefined) this.w.line(d.span.start.line, `# @intent ${JSON.stringify(intent.text)}`);
    for (const dec of d.decorators.filter((x) => x.name === "require" || x.name === "ensure")) {
      if (dec.expr) this.w.line(dec.span.start.line, `# @${dec.name} ${this.expr(dec.expr)}`);
    }
    if (returnsResult) this.w.line(d.span.start.line, "@chock_result");
    for (const l of this.contractDecorator(d)) this.w.line(d.span.start.line, l);
    const params = d.params.map((p) =>
      p.default ? `${p.name}=${this.expr(p.default)}` : p.name,
    ).join(", ");
    this.w.line(d.span.start.line, `${d.async ? "async def" : "def"} ${d.name}(${params}) -> ${pyType(d.returnType)}:`);
    this.w.indent++;
    this.asyncStack.push(d.async);
    if (d.body.length === 0) this.w.line(d.span.start.line, "pass");
    for (const s of d.body) this.stmt(s);
    this.asyncStack.pop();
    this.w.indent--;
    this.w.blank();
  }

  private genFnStub(w: Writer, d: A.FnDecl): void {
    if (d.async) w.line(d.span.start.line, "async def ", );
    const params = d.params.map((p) => {
      const tail = p.default ? ` = ...` : "";
      return `${p.name}: ${pyType(p.type)}${tail}`;
    }).join(", ");
    const prefix = d.async ? "async def" : "def";
    w.line(d.span.start.line, `${prefix} ${d.name}(${params}) -> ${pyType(d.returnType)}: ...`);
    w.blank();
  }

  // ---------- 语句 ----------
  private stmt(s: A.Stmt): void {
    switch (s.kind) {
      case "let": {
        if (s.value) this.w.line(s.span.start.line, `${s.name} = ${this.expr(s.value)}`);
        else this.w.line(s.span.start.line, `${s.name} = None  # var ${s.name}: ${pyType(s.type!)}`);
        return;
      }
      case "return": {
        if (!s.value) { this.w.line(s.span.start.line, "return"); return; }
        const v = this.expr(s.value);
        this.w.line(s.span.start.line, s.wrapOk ? `return Ok(${v})` : `return ${v}`);
        return;
      }
      case "if": {
        s.branches.forEach((b, i) => {
          const kw = i === 0 ? "if" : "elif";
          this.w.line(b.span.start.line, `${kw} ${this.expr(b.cond)}:`);
          this.w.indent++;
          b.body.forEach((x) => this.stmt(x));
          if (!b.body.length) this.w.line(b.span.start.line, "pass");
          this.w.indent--;
        });
        if (s.elseBody) {
          this.w.line((s.elseBody[0] ?? s).span.start.line, "else:");
          this.w.indent++;
          s.elseBody.forEach((x) => this.stmt(x));
          if (!s.elseBody.length) this.w.line(s.span.start.line, "pass");
          this.w.indent--;
        }
        return;
      }
      case "while": {
        this.w.line(s.span.start.line, `while ${this.expr(s.cond)}:`);
        this.w.indent++;
        s.body.forEach((x) => this.stmt(x));
        if (!s.body.length) this.w.line(s.span.start.line, "pass");
        this.w.indent--;
        return;
      }
      case "for": {
        if (s.parallel && !this.isAsync) {
          // 结构化数据并行（Phase 0：线程池实现，热路径加速留待 Phase 2）
          this.w.line(s.span.start.line, `def _chock_parallel_body(${s.target}):`);
          this.w.indent++;
          s.body.forEach((x) => this.stmt(x));
          if (!s.body.length) this.w.line(s.span.start.line, "pass");
          this.w.indent--;
          this.w.line(s.span.start.line, `_chock_parallel_for(${this.expr(s.iter)}, _chock_parallel_body)  # parallel for`);
        } else {
          if (s.parallel) this.w.line(s.span.start.line, "# parallel for（async 函数内 Phase 0 降级为顺序执行）");
          this.w.line(s.span.start.line, `for ${s.target} in ${this.expr(s.iter)}:`);
          this.w.indent++;
          s.body.forEach((x) => this.stmt(x));
          if (!s.body.length) this.w.line(s.span.start.line, "pass");
          this.w.indent--;
        }
        return;
      }
      case "match": {
        this.genMatch(s.scrut, s.clauses, undefined);
        return;
      }
      case "assign": {
        const op = s.op === "=" ? "=" : s.op;
        this.w.line(s.span.start.line, `${this.lvalue(s.target)} ${op} ${this.expr(s.value)}`);
        return;
      }
      case "expr_stmt": {
        this.w.line(s.span.start.line, this.expr(s.expr));
        return;
      }
    }
  }

  private genMatch(scrut: A.Expr, clauses: A.MatchClause[], binder: string | undefined): void {
    const sc = this.expr(scrut);
    let first = true;
    let wildcarded = false;
    for (const c of clauses) {
      const src = c.span.start.line;
      if (c.pattern.kind === "pat_wildcard") {
        this.w.line(src, "else:");
        wildcarded = true;
      } else if (c.pattern.kind === "pat_bind") {
        this.w.line(src, "else:");
        wildcarded = true;
        this.w.indent++;
        this.w.line(src, `${c.pattern.name} = ${sc}`);
        this.emitClauseValue(c, binder, src);
        this.w.indent--;
        first = false;
        continue;
      } else {
        const cond = `${sc} == ${this.expr(c.pattern.value)}`;
        const g = c.guard ? ` and (${this.expr(c.guard)})` : "";
        this.w.line(src, `${first ? "if" : "elif"} ${cond}${g}:`);
      }
      this.w.indent++;
      this.emitClauseValue(c, binder, src);
      this.w.indent--;
      first = false;
    }
    if (!wildcarded && binder) {
      // 穷尽性在 Phase 0 不做强制；预置 None 保证绑定存在
    }
  }

  private emitClauseValue(c: A.MatchClause, binder: string | undefined, src: number): void {
    if (binder) {
      this.w.line(src, c.value ? `${binder} = ${this.expr(c.value)}` : `${binder} = None`);
    } else if (c.value) {
      this.w.line(src, this.expr(c.value)); // 表达式语句（Python 允许裸字面量）
    }
  }

  private lvalue(e: A.Expr): string { return this.expr(e); }

  // ---------- 表达式 ----------
  private expr(e: A.Expr): string {
    switch (e.kind) {
      case "int": return e.raw.replace(/_/g, "");
      case "float": return e.raw.replace(/_/g, "");
      case "str": return strLit(e.raw);
      case "bool": return e.value ? "True" : "False";
      case "null": return "None";
      case "ident": return e.name;
      case "list": return `[${e.items.map((x) => this.expr(x)).join(", ")}]`;
      case "dict": return `{${e.items.map((x) => `${this.expr(x.key)}: ${this.expr(x.value)}`).join(", ")}}`;
      case "unary": return e.op === "not" ? `(not ${this.expr(e.expr)})` : `(-${this.expr(e.expr)})`;
      case "binary": return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      case "call": return this.genCall(e);
      case "field": return `${this.expr(e.obj)}.${e.name}`;
      case "index": return `${this.expr(e.obj)}[${this.expr(e.index)}]`;
      case "await": return `await ${this.expr(e.expr)}`;
      case "try": return `_chock_try(${this.expr(e.expr)})`;
      case "match_expr": {
        // match 表达式降级为嵌套三元（clause 必有值）
        return this.matchToCond(e);
      }
    }
  }

  private matchToCond(e: A.MatchExpr): string {
    const sc = this.expr(e.scrut);
    let fallback = "None";
    for (let i = e.clauses.length - 1; i >= 0; i--) {
      const c = e.clauses[i]!;
      const v = c.value ? this.expr(c.value) : "None";
      if (c.pattern.kind === "pat_wildcard" || c.pattern.kind === "pat_bind") {
        fallback = v;
        continue;
      }
      const cond = `${sc} == ${this.expr(c.pattern.value)}`;
      const g = c.guard ? ` and (${this.expr(c.guard)})` : "";
      fallback = `(${v} if ${cond}${g} else ${fallback})`;
    }
    return fallback;
  }

  private genCall(e: A.Call): string {
    const args = e.args.map((a) => (a.name ? `${a.name}=${this.expr(a.value)}` : this.expr(a.value)));

    // 类型转换函数 → Python 内建
    if (e.callee.kind === "ident") {
      const n = e.callee.name;
      if (n === "Int") return `int(${args.join(", ")})`;
      if (n === "Float") return `float(${args.join(", ")})`;
      if (n === "String") return `str(${args.join(", ")})`;
      if (n === "Bool") return `bool(${args.join(", ")})`;
      if (n === "is_ok") return `isinstance(${args[0] ?? ""}, Ok)`;
      if (n === "is_err") return `isinstance(${args[0] ?? ""}, Err)`;
      return `${n}(${args.join(", ")})`;
    }

    // String 方法重写
    if (e.callee.kind === "field") {
      const recv = this.expr(e.callee.obj);
      const m = e.callee.name;
      if (m === "trim") return `${recv}.strip()`;
      if (m === "parse_int") return `_chock_parse_int(${recv})`;
      if (m === "parse_float") return `_chock_parse_float(${recv})`;
      if (m === "contains") return `(${args[0] ?? '""'} in ${recv})`;
      return `${recv}.${m}(${args.join(", ")})`;
    }

    return `${this.expr(e.callee)}(${args.join(", ")})`;
  }
}

export function generatePython(prog: A.Program, cokFile: string): { py: string; pyi: string; map: unknown } {
  return new CodeGen(prog, cokFile).generate();
}

// ---------- JSON Schema 导出（5.4 Schema-First） ----------
export function typeSchemaName(t: A.TypeNode): string {
  if (t.optional) return typeSchemaName({ ...t, optional: false });
  switch (t.name) {
    case "Int": return "integer";
    case "Float": return "number";
    case "String": return "string";
    case "Bool": return "boolean";
    case "Unit": return "null";
    case "List": return "array";
    default: return t.name;
  }
}

export function generateSchemas(prog: A.Program): Record<string, unknown> {
  const enums = new Map(prog.decls.filter((d): d is A.EnumDecl => d.kind === "enum").map((d) => [d.name, d]));
  const records = prog.decls.filter((d): d is A.TypeDecl => d.kind === "type_decl");
  const out: Record<string, unknown> = {};

  const schemaOf = (t: A.TypeNode): unknown => {
    const base = (): unknown => {
      switch (t.name) {
        case "Int": return { type: "integer" };
        case "Float": return { type: "number" };
        case "String": return { type: "string" };
        case "Bool": return { type: "boolean" };
        case "Unit": return { type: "null" };
        case "List": return { type: "array", items: t.args[0] ? schemaOf(t.args[0]) : {} };
        case "Dict": return { type: "object", additionalProperties: t.args[1] ? schemaOf(t.args[1]) : {} };
        case "Result": return { oneOf: [t.args[0] ? schemaOf(t.args[0]) : {}, { $ref: "#/$defs/Error" }] };
        default:
          if (enums.has(t.name)) return { $ref: `#/$defs/${t.name}` };
          return { $ref: `#/$defs/${t.name}` };
      }
    };
    return t.optional ? { ...(base() as object), "x-nullable": true } : base();
  };

  // 所有 type 合并到一个 schema 文档（$defs），并为每个 type 单独导出
  const $defs: Record<string, unknown> = {};
  for (const en of enums.values()) {
    $defs[en.name] = { type: "string", enum: en.members, title: en.name };
  }
  $defs.Error = { type: "object", properties: { message: { type: "string" } }, required: ["message"] };

  for (const r of records) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const f of r.fields) {
      let sch = schemaOf(f.type) as Record<string, unknown>;
      if (!f.type.optional && !f.default) required.push(f.name);
      // 字段约束（Phase 0 仅识别 { max_len: n } 风格的简化标注不进语法，保留扩展点）
      props[f.name] = sch;
      void sch;
    }
    const def = { type: "object", properties: props, required, additionalProperties: false };
    $defs[r.name] = { title: r.name, ...def };
    out[r.name] = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: r.name,
      ...def,
      $defs: JSON.parse(JSON.stringify($defs)),
    };
  }
  return out;
}

// ---------- 运行时落盘 ----------
const RUNTIME_PY = `"""Chock Phase 0 Python 运行时（自动随编译器分发）。"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, fields, is_dataclass
from enum import Enum
from typing import Any, Generic, Optional, TypeVar, Union, get_args, get_origin, get_type_hints

Unit = None
T = TypeVar("T")
E = TypeVar("E")


class Ok(Generic[T]):
    __slots__ = ("value",)
    def __init__(self, value: T):
        self.value = value
    def __repr__(self):
        return f"Ok({self.value!r})"


class Err(Generic[E]):
    __slots__ = ("error",)
    def __init__(self, error: E):
        self.error = error
    def __repr__(self):
        return f"Err({self.error!r})"


Result = Union[Ok[T], Err[E]]


class ChockError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class ChockContractError(Exception):
    """意图锚点（@require/@ensure）被违反。"""
    def __init__(self, kind: str, intent: str, detail: str):
        self.kind = kind
        self.intent = intent
        super().__init__(f"[{kind}] 意图锚点被违反（{intent}）：{detail}")


class _CokReturn(Exception):
    def __init__(self, error):
        self.error = error


def _chock_try(result):
    """Chock '?' 操作符：Ok 解包，Err 提前传播。"""
    if isinstance(result, Err):
        raise _CokReturn(result.error)
    if isinstance(result, Ok):
        return result.value
    raise TypeError(f"'?' 只能用于 Result，实际收到 {type(result).__name__}")


def chock_result(fn):
    """把函数体内经 '?' 传播的错误统一转换为 Err 返回。"""
    import functools
    if __import__("inspect").iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def _awrapper(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except _CokReturn as r:
                return Err(r.error)
        return _awrapper
    @functools.wraps(fn)
    def _wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except _CokReturn as r:
            return Err(r.error)
    return _wrapper


def chock_contract(intent: str = "", requires=(), ensures=()):
    import functools
    def deco(fn):
        @functools.wraps(fn)
        def _run(args, kwargs):
            ba = None
            try:
                import inspect
                ba = inspect.signature(fn).bind(*args, **kwargs)
                ba.apply_defaults()
            except (TypeError, ValueError):
                return
            for i, check in enumerate(requires):
                if not check(*ba.args, **ba.kwargs):
                    raise ChockContractError("@require", intent or fn.__name__, f"前置条件 #{i + 1} 不成立")
            return ba
        if __import__("inspect").iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def _aw(*args, **kwargs):
                _run(args, kwargs)
                result = await fn(*args, **kwargs)
                value = result.value if isinstance(result, Ok) else result
                for i, check in enumerate(ensures):
                    if not check(value, *args, **kwargs):
                        raise ChockContractError("@ensure", intent or fn.__name__, f"后置条件 #{i + 1} 不成立")
                return result
            return _aw
        @functools.wraps(fn)
        def _w(*args, **kwargs):
            _run(args, kwargs)
            result = fn(*args, **kwargs)
            value = result.value if isinstance(result, Ok) else result
            for i, check in enumerate(ensures):
                if not check(value, *args, **kwargs):
                    raise ChockContractError("@ensure", intent or fn.__name__, f"后置条件 #{i + 1} 不成立")
            return result
        return _w
    return deco


# ---------- Schema 驱动的安全解析（5.4 类型即 Schema 的运行时侧） ----------
def _chock_coerce(value, ty):
    if ty is Any or ty is None:
        return value
    origin = get_origin(ty)
    if origin is Union:
        args = [a for a in get_args(ty) if a is not type(None)]
        none_allowed = type(None) in get_args(ty)
        if value is None:
            if none_allowed:
                return None
            raise ChockError("收到 null，但字段不可为空")
        last = None
        for a in args:
            try:
                return _chock_coerce(value, a)
            except Exception as exc:  # noqa: BLE001
                last = exc
        raise ChockError(str(last))
    if ty is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ChockError(f"期望 int，实际 {type(value).__name__}")
        return value
    if ty is float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ChockError(f"期望 float，实际 {type(value).__name__}")
        return float(value)
    if ty is str:
        if not isinstance(value, str):
            raise ChockError(f"期望 str，实际 {type(value).__name__}")
        return value
    if ty is bool:
        if not isinstance(value, bool):
            raise ChockError(f"期望 bool，实际 {type(value).__name__}")
        return value
    if origin in (list,):
        item_t = get_args(ty)[0] if get_args(ty) else Any
        if not isinstance(value, list):
            raise ChockError(f"期望 list，实际 {type(value).__name__}")
        return [_chock_coerce(v, item_t) for v in value]
    if origin in (dict,):
        kt, vt = get_args(ty) if len(get_args(ty)) == 2 else (str, Any)
        if not isinstance(value, dict):
            raise ChockError(f"期望 dict，实际 {type(value).__name__}")
        return {_chock_coerce(k, kt): _chock_coerce(v, vt) for k, v in value.items()}
    if isinstance(ty, type) and issubclass(ty, Enum):
        try:
            return ty(value)
        except ValueError:
            raise ChockError(f"{ty.__name__} 没有取值 {value!r}")
    if isinstance(ty, type) and issubclass(ty, ChockModel):
        return ty.parse(value).value
    return value


@dataclass
class ChockModel:
    @classmethod
    def parse(cls, raw) -> "Result":
        try:
            data = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
            if not isinstance(data, dict):
                return Err(ChockError(f"{cls.__name__}.parse 期望 JSON 对象，实际 {type(data).__name__}"))
            hints = get_type_hints(cls)
            kwargs = {}
            from dataclasses import MISSING
            for f in fields(cls):
                if f.name not in data:
                    if f.default is not MISSING or f.default_factory is not MISSING:
                        continue
                    return Err(ChockError(f"{cls.__name__} 缺少必填字段 {f.name!r}"))
                kwargs[f.name] = _chock_coerce(data[f.name], hints.get(f.name, Any))
            return Ok(cls(**kwargs))
        except Exception as exc:  # noqa: BLE001
            return Err(ChockError(str(exc)))


def _chock_parse_int(s: str) -> "Result":
    try:
        return Ok(int(s))
    except (TypeError, ValueError) as exc:
        return Err(ChockError(str(exc)))


def _chock_parse_float(s: str) -> "Result":
    try:
        return Ok(float(s))
    except (TypeError, ValueError) as exc:
        return Err(ChockError(str(exc)))


def _chock_parallel_for(items, body, max_workers=None):
    """parallel for 的 Phase 0 实现（线程池）。异常立即向上抛出。"""
    items = list(items)
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        return list(pool.map(body, items))
`;

const CHOCK_STD: Record<string, string> = {
  "__init__.py": `"""Chock 最小标准库占位（Phase 0：只做 Python 生态互操作增量）。"""\n`,
  "core.py": `from chock_runtime import Ok, Err, Result, Unit, ChockError  # noqa: F401\n`,
  "http.py": `"""Phase 1 才提供正式实现；此处为保证转译产物可导入的最小占位。"""\nfrom __future__ import annotations\n\nfrom chock_runtime import Ok, Err, ChockError\n\n\nasync def get(url: str, **kwargs):\n    try:\n        import urllib.request\n        with urllib.request.urlopen(url) as resp:  # noqa: S310\n            return Ok(resp.read().decode("utf-8"))\n    except Exception as exc:  # noqa: BLE001\n        return Err(ChockError(str(exc)))\n\n\nasync def post(url: str, data: str = "", **kwargs):\n    return Err(ChockError("std/http.post 将在 Phase 1 提供"))\n`,
  "ai.py": `"""Phase 1 提供 ai.extract 的 Schema 约束解码；此处为占位。"""\nfrom __future__ import annotations\n\nfrom chock_runtime import Err, ChockError\n\n\ndef extract(doc: str, *, into=None, model: str = ""):\n    return Err(ChockError("std/ai.extract 将在 Phase 1 提供"))\n`,
};

export function emitRuntime(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "chock_runtime.py"), RUNTIME_PY, "utf8");
  const stdDir = path.join(outDir, "chock_std");
  fs.mkdirSync(stdDir, { recursive: true });
  for (const [name, content] of Object.entries(CHOCK_STD)) {
    fs.writeFileSync(path.join(stdDir, name), content, "utf8");
  }
}
