// 语义分析 + 类型检查（Phase 0 子集）。
// 目标：在编译期拦截幻觉 API、类型不匹配、未处理 Result、可变性冲突等。
import type * as A from "./ast.js";
import { Code, type DiagnosticCollector } from "./diag.js";
import { mergeSpan } from "./span.js";

// ---------- 内部类型表示 ----------
type Ty =
  | { k: "any" }
  | { k: "null" }
  | { k: "prim"; name: "Int" | "Float" | "String" | "Bool" | "Unit" }
  | { k: "named"; name: string }
  | { k: "generic"; name: string; args: Ty[] }
  | { k: "optional"; inner: Ty };

const TAny: Ty = { k: "any" };
const TNull: Ty = { k: "null" };
const TInt: Ty = { k: "prim", name: "Int" };
const TFloat: Ty = { k: "prim", name: "Float" };
const TStr: Ty = { k: "prim", name: "String" };
const TBool: Ty = { k: "prim", name: "Bool" };
const TUnit: Ty = { k: "prim", name: "Unit" };

function tyName(t: Ty): string {
  switch (t.k) {
    case "any": return "Any";
    case "null": return "null";
    case "prim": return t.name;
    case "named": return t.name;
    case "generic": return `${t.name}[${t.args.map(tyName).join(", ")}]`;
    case "optional": return `${tyName(t.inner)}?`;
  }
}

function primFromName(n: string): Ty | null {
  if (n === "Int") return TInt;
  if (n === "Float") return TFloat;
  if (n === "String") return TStr;
  if (n === "Bool") return TBool;
  if (n === "Unit") return TUnit;
  return null;
}

function isNumeric(t: Ty): boolean {
  return (t.k === "prim" && (t.name === "Int" || t.name === "Float")) ||
    (t.k === "optional" && isNumeric(t.inner));
}

function assignable(src: Ty, dst: Ty): boolean {
  if (src.k === "any" || dst.k === "any") return true;
  if (src.k === "null") {
    // null 只能赋给 T?（或 Any/null）
    return dst.k === "null" || dst.k === "optional";
  }
  if (dst.k === "optional") {
    if (src.k === "optional") return assignable(src.inner, dst.inner);
    return assignable(src, dst.inner);
  }
  if (src.k === "optional") return false;
  if (src.k === "prim" && dst.k === "prim") {
    if (src.name === dst.name) return true;
    if (src.name === "Int" && dst.name === "Float") return true; // int 字面量/实参可隐式提升
    return false;
  }
  if (src.k === "named" && dst.k === "named") return src.name === dst.name;
  if (src.k === "generic" && dst.k === "generic") {
    if (src.name !== dst.name || src.args.length !== dst.args.length) return false;
    return src.args.every((a, i) => assignable(a, dst.args[i]));
  }
  return false;
}

// ---------- 符号表 ----------
interface FieldInfo { name: string; ty: Ty; hasDefault: boolean }
interface RecordInfo { name: string; fields: FieldInfo[] }
interface EnumInfo { name: string; members: string[] }
interface ParamInfo { name: string; ty: Ty; hasDefault: boolean }
interface FnSig { name: string; params: ParamInfo[]; ret: Ty; async: boolean }

type Binding =
  | { sort: "var"; ty: Ty; mutable: boolean }
  | { sort: "fn"; sig: FnSig }
  | { sort: "record"; info: RecordInfo }
  | { sort: "enum"; info: EnumInfo }
  | { sort: "module" }
  | { sort: "const"; ty: Ty };

class Scope {
  private map = new Map<string, Binding>();
  constructor(public parent: Scope | null = null) {}
  declare(name: string, b: Binding): boolean {
    if (this.map.has(name)) return false;
    this.map.set(name, b);
    return true;
  }
  lookup(name: string): Binding | null {
    const e = this.map.get(name);
    if (e) return e;
    return this.parent ? this.parent.lookup(name) : null;
  }
  // 仅当前层（用于重定义判定）
  declaredHere(name: string): boolean { return this.map.has(name); }
}

// ---------- 内置 ----------
// argTs 为已完成类型检查的实参类型；check 只负责返回类型与额外校验。
interface BuiltinFn {
  name: string;
  arity?: [number, number]; // [min, max]
  check: (c: Checker, argTs: Ty[], node: A.Call) => Ty;
}

function numericSame(c: Checker, ts: Ty[], node: A.Call): Ty {
  if (ts.some((t) => !isNumeric(t) && t.k !== "any")) {
    c.diag.error({
      code: Code.TypeMismatch, phase: "typecheck", symbol: node.span.file,
      message: "算术运算要求数值类型",
      span: node.span, found: ts.map(tyName).join(", "), expected: "Int/Float",
    });
    return TAny;
  }
  return ts.every((t) => t.k === "prim" && t.name === "Int") ? TInt : TFloat;
}

function arity(n: number): [number, number] { return [n, n]; }

const BUILTINS: Record<string, BuiltinFn> = {
  print: { name: "print", check: () => TUnit },
  len: { name: "len", arity: arity(1), check: () => TInt },
  range: { name: "range", arity: [1, 3], check: () => ({ k: "generic", name: "Range", args: [TInt] }) },
  max: { name: "max", arity: [1, 9], check: (c, a, n) => numericSame(c, a, n) },
  min: { name: "min", arity: [1, 9], check: (c, a, n) => numericSame(c, a, n) },
  abs: { name: "abs", arity: arity(1), check: (c, a, n) => numericSame(c, a, n) },
  Int: { name: "Int", arity: arity(1), check: () => TInt },
  Float: { name: "Float", arity: arity(1), check: () => TFloat },
  String: { name: "String", arity: arity(1), check: () => TStr },
  Bool: { name: "Bool", arity: arity(1), check: () => TBool },
  Ok: {
    name: "Ok", arity: arity(1),
    check: (_c, [v]) => ({ k: "generic", name: "Result", args: [v ?? TAny, TAny] }),
  },
  Err: {
    name: "Err", arity: arity(1),
    check: (_c, [e]) => ({ k: "generic", name: "Result", args: [TAny, e ?? TAny] }),
  },
  is_ok: {
    name: "is_ok", arity: arity(1),
    check: (_c, [t]) => {
      if (t && t.k !== "any" && !(t.k === "generic" && t.name === "Result")) {
        // 非 Result 使用 is_ok 无意义（不阻断，仅由调用方场景决定）
      }
      return TBool;
    },
  },
  is_err: { name: "is_err", arity: arity(1), check: () => TBool },
};

export class Checker {
  private global = new Scope();
  private records = new Map<string, RecordInfo>();
  private enums = new Map<string, EnumInfo>();
  private fns = new Map<string, { sig: FnSig; decl: A.FnDecl }>();
  private current: { sig: FnSig; scope: Scope; span: import("./span.js").Span } | null = null;
  private externalTypes = new Set<string>(["Error"]);

  constructor(private file: string, readonly diag: DiagnosticCollector) {}

  argCount(name: string, expected: number, actual: number, span: import("./span.js").Span): void {
    this.diag.error({
      code: Code.ArgCount, phase: "typecheck", symbol: name,
      message: `函数 '${name}' 需要 ${expected} 个参数，但提供了 ${actual} 个`,
      span, expected: String(expected), found: String(actual),
      hints: ["AI 常见幻觉：调用了错误数量的参数，请核对函数签名"],
    });
  }

  private resolveType(node: A.TypeNode): Ty {
    const base = primFromName(node.name);
    let t: Ty;
    if (base) {
      t = base;
      if (node.args.length) {
        this.diag.error({
          code: Code.UnknownType, phase: "typecheck", symbol: node.name,
          message: `基础类型 '${node.name}' 不能带泛型参数`,
          span: node.span,
        });
        t = TAny;
      }
    } else if (node.name === "List") {
      if (node.args.length !== 1) {
        this.diag.error({ code: Code.UnknownType, phase: "typecheck", message: "List 需要 1 个类型参数，例如 List[Int]", span: node.span });
        t = { k: "generic", name: "List", args: [TAny] };
      } else t = { k: "generic", name: "List", args: [this.resolveType(node.args[0])] };
    } else if (node.name === "Dict") {
      if (node.args.length !== 2) {
        this.diag.error({ code: Code.UnknownType, phase: "typecheck", message: "Dict 需要 2 个类型参数，例如 Dict[String, Int]", span: node.span });
        t = { k: "generic", name: "Dict", args: [TAny, TAny] };
      } else t = { k: "generic", name: "Dict", args: [this.resolveType(node.args[0]), this.resolveType(node.args[1])] };
    } else if (node.name === "Result") {
      if (node.args.length !== 2) {
        this.diag.error({ code: Code.UnknownType, phase: "typecheck", message: "Result 需要 2 个类型参数，例如 Result[User, Error]", span: node.span });
        t = { k: "generic", name: "Result", args: [TAny, TAny] };
      } else t = { k: "generic", name: "Result", args: [this.resolveType(node.args[0]), this.resolveType(node.args[1])] };
    } else if (this.records.has(node.name) || this.enums.has(node.name)) {
      t = { k: "named", name: node.name };
      if (node.args.length) {
        this.diag.error({ code: Code.UnknownType, phase: "typecheck", symbol: node.name, message: `类型 '${node.name}' 不是泛型类型`, span: node.span });
      }
    } else if (this.externalTypes.has(node.name)) {
      t = { k: "named", name: node.name };
    } else {
      this.diag.error({
        code: Code.UnknownType, phase: "typecheck", symbol: node.name,
        message: `未知类型 '${node.name}'`,
        span: node.span,
        hints: ["AI 常见幻觉：类型名不存在或未导入；可用 Int/Float/String/Bool/Unit/List/Dict/Result 或已声明的 type/enum"],
      });
      t = TAny;
    }
    return node.optional ? { k: "optional", inner: t } : t;
  }

  checkProgram(prog: A.Program): void {
    // 导入模块名作为全局 module 绑定（外部模块，成员按 Any 处理）
    for (const imp of prog.imports) {
      const leaf = imp.path.split("/").pop()!;
      this.global.declare(leaf, { sort: "module" });
    }
    this.global.declare("Unit", { sort: "const", ty: TUnit });

    // 第一遍：收集类型与函数签名
    for (const d of prog.decls) {
      if (d.kind === "enum") {
        if (this.enums.has(d.name) || this.records.has(d.name)) {
          this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: d.name, message: `类型 '${d.name}' 重复定义`, span: d.span });
        }
        const members = [...new Set(d.members)];
        if (members.length !== d.members.length) {
          this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: d.name, message: `枚举 '${d.name}' 存在重复成员`, span: d.span });
        }
        const info: EnumInfo = { name: d.name, members };
        this.enums.set(d.name, info);
      } else if (d.kind === "type_decl") {
        if (this.records.has(d.name) || this.enums.has(d.name)) {
          this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: d.name, message: `类型 '${d.name}' 重复定义`, span: d.span });
        }
        this.records.set(d.name, { name: d.name, fields: [] });
      }
    }
    for (const d of prog.decls) {
      if (d.kind === "type_decl") {
        const info = this.records.get(d.name)!;
        const seen = new Set<string>();
        for (const f of d.fields) {
          if (seen.has(f.name)) {
            this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: f.name, message: `类型 '${d.name}' 的字段 '${f.name}' 重复`, span: f.span });
          }
          seen.add(f.name);
          info.fields.push({ name: f.name, ty: this.resolveType(f.type), hasDefault: !!f.default });
        }
      }
    }
    for (const d of prog.decls) {
      if (d.kind === "enum") {
        const info = this.enums.get(d.name)!;
        for (const m of info.members) {
          if (!this.global.declare(m, { sort: "const", ty: { k: "named", name: d.name } })) {
            this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: m, message: `枚举成员 '${m}' 与其他全局声明冲突`, span: d.span });
          }
        }
        if (!this.global.declare(d.name, { sort: "enum", info })) {
          this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: d.name, message: `'${d.name}' 重复声明`, span: d.span });
        }
      } else if (d.kind === "type_decl") {
        if (!this.global.declare(d.name, { sort: "record", info: this.records.get(d.name)! })) {
          this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: d.name, message: `'${d.name}' 重复声明`, span: d.span });
        }
      }
    }
    for (const d of prog.decls) {
      if (d.kind === "fn") {
        const sig: FnSig = {
          name: d.name,
          params: d.params.map((p) => ({ name: p.name, ty: this.resolveType(p.type), hasDefault: !!p.default })),
          ret: this.resolveType(d.returnType),
          async: d.async,
        };
        if (this.fns.has(d.name) || BUILTINS[d.name]) {
          this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: d.name, message: `函数 '${d.name}' 重复定义`, span: d.span });
        }
        this.fns.set(d.name, { sig, decl: d });
        this.global.declare(d.name, { sort: "fn", sig });
      }
    }

    // 第二遍：检查默认值与函数体
    for (const d of prog.decls) {
      if (d.kind === "type_decl") {
        const info = this.records.get(d.name)!;
        let seenDefault = false;
        for (const f of d.fields) {
          if (f.default) {
            seenDefault = true;
            const scope = new Scope(this.global);
            const vt = this.checkExpr(f.default, scope);
            const fi = info.fields.find((x) => x.name === f.name)!;
            if (!assignable(vt, fi.ty)) {
              this.diag.error({
                code: Code.TypeMismatch, phase: "typecheck", symbol: f.name,
                message: `字段 '${d.name}.${f.name}' 默认值类型不匹配`,
                span: f.default.span, expected: tyName(fi.ty), found: tyName(vt),
              });
            }
          } else if (seenDefault) {
            this.diag.error({
              code: Code.TypeMismatch, phase: "typecheck", symbol: f.name,
              message: `字段 '${f.name}' 无默认值，不能出现在带默认值字段之后（Python 数据类限制）`,
              span: f.span, hints: ["把无默认值字段移到带默认值字段之前"],
            });
          }
        }
      }
      if (d.kind === "fn") {
        for (const p of d.params) {
          if (p.default) {
            const scope = new Scope(this.global);
            const vt = this.checkExpr(p.default, scope);
            const pi = d.params.indexOf(p);
            const pt = this.fns.get(d.name)!.sig.params[pi].ty;
            if (!assignable(vt, pt)) {
              this.diag.error({
                code: Code.TypeMismatch, phase: "typecheck", symbol: p.name,
                message: `参数 '${p.name}' 默认值类型不匹配`,
                span: p.default.span, expected: tyName(pt), found: tyName(vt),
              });
            }
          }
        }
        this.checkFn(d);
      }
    }
  }

  private checkFn(d: A.FnDecl): void {
    const { sig } = this.fns.get(d.name)!;
    const scope = new Scope(this.global);
    const pnames = new Set<string>();
    for (const p of sig.params) {
      if (pnames.has(p.name)) {
        this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: p.name, message: `函数 '${d.name}' 参数 '${p.name}' 重复`, span: d.span });
      }
      pnames.add(p.name);
      scope.declare(p.name, { sort: "var", ty: p.ty, mutable: true });
    }
    this.current = { sig, scope, span: d.span };

    // 意图锚点：@require / @ensure 先做类型校验
    for (const dec of d.decorators) {
      if (dec.name === "intent") {
        if (dec.text === undefined) {
          this.diag.warn({ code: Code.Style, phase: "typecheck", message: "@intent 需要一个自然语言字符串参数", span: dec.span });
        }
        continue;
      }
      if (dec.name === "require" || dec.name === "ensure") {
        if (!dec.expr) continue;
        if (dec.name === "ensure") scope.declare("result", { sort: "const", ty: sig.ret });
        const t = this.checkExpr(dec.expr, scope);
        if (t.k !== "any" && !assignable(t, TBool)) {
          this.diag.error({
            code: Code.AnchorExprType, phase: "typecheck",
            message: `@${dec.name} 表达式必须是 Bool 类型`,
            span: dec.expr.span, expected: "Bool", found: tyName(t),
          });
        }
        continue;
      }
      this.diag.warn({
        code: Code.Style, phase: "typecheck",
        message: `未知装饰器 '@${dec.name}'（Phase 0 支持 @intent/@require/@ensure）`,
        span: dec.span,
      });
    }

    for (const s of d.body) this.stmt(s, scope);

    // 返回路径完整性
    if (!assignable(sig.ret, TUnit) && !this.alwaysReturns(d.body)) {
      this.diag.error({
        code: Code.MissingReturn, phase: "typecheck", symbol: d.name,
        message: `函数 '${d.name}' 声明返回 ${tyName(sig.ret)}，但存在没有 return 的路径`,
        span: mergeSpan(d.span, d.span),
        hints: ["在函数末尾补全 return，或把返回类型改为 Unit"],
      });
    }
    this.current = null;
  }

  private alwaysReturns(stmts: A.Stmt[]): boolean {
    for (let i = stmts.length - 1; i >= 0; i--) {
      const s = stmts[i];
      if (s.kind === "return") return true;
      if (s.kind === "if") {
        if (!s.elseBody) return false;
        return s.branches.every((b) => this.alwaysReturns(b.body)) && this.alwaysReturns(s.elseBody);
      }
      // match/for/while 不做穷尽保证
      return false;
    }
    return false;
  }

  private expectBool(e: A.Expr, scope: Scope, what: string): void {
    const t = this.checkExpr(e, scope);
    if (t.k !== "any" && !assignable(t, TBool)) {
      this.diag.error({
        code: Code.ConditionType, phase: "typecheck",
        message: `${what}条件必须是 Bool 类型`,
        span: e.span, expected: "Bool", found: tyName(t),
      });
    }
  }

  // ---------- 语句 ----------
  private stmt(s: A.Stmt, scope: Scope): void {
    switch (s.kind) {
      case "let": {
        let ty: Ty;
        if (s.type && s.value) {
          ty = this.resolveType(s.type);
          const vt = this.checkExpr(s.value, scope);
          if (!assignable(vt, ty)) {
            this.diag.error({
              code: Code.TypeMismatch, phase: "typecheck", symbol: s.name,
              message: `变量 '${s.name}' 声明为 ${tyName(ty)}，初始值为 ${tyName(vt)}`,
              span: s.value.span, expected: tyName(ty), found: tyName(vt),
              hints: [`用 ${tyName(ty).replace("Float", "Float(...)")}(...) 显式转换，或修正声明类型`],
            });
          }
        } else if (s.value) {
          ty = this.checkExpr(s.value, scope);
        } else if (s.type) {
          ty = this.resolveType(s.type);
        } else {
          ty = TAny;
        }
        if (!scope.declare(s.name, { sort: "var", ty, mutable: s.mutable })) {
          this.diag.error({ code: Code.Redefinition, phase: "typecheck", symbol: s.name, message: `变量 '${s.name}' 在当前作用域重复定义`, span: s.span });
        }
        return;
      }
      case "return": {
        const cur = this.current;
        if (!cur) {
          this.diag.error({ code: Code.ParseError, phase: "typecheck", message: "return 只能出现在函数体内", span: s.span });
          return;
        }
        const vt = s.value ? this.checkExpr(s.value, scope) : TUnit;
        if (assignable(vt, cur.sig.ret)) {
          // 显式 Ok(...)/Err(...) 或类型已一致
          s.wrapOk = false;
        } else if (cur.sig.ret.k === "generic" && cur.sig.ret.name === "Result") {
          // Rust 风格的自动 Ok 包装：Result[T, E] 函数可直接 return T（常见于 expr? 之后）
          const okTy = cur.sig.ret.args[0];
          if (assignable(vt, okTy)) {
            s.wrapOk = true;
          } else {
            this.diag.error({
              code: Code.TypeMismatch, phase: "typecheck", symbol: cur.sig.name,
              message: `返回值类型不匹配：函数 '${cur.sig.name}' 声明返回 ${tyName(cur.sig.ret)}，实际返回 ${tyName(vt)}`,
              span: (s.value ?? s).span, expected: `${tyName(cur.sig.ret)} 或成功值 ${tyName(okTy)}`, found: tyName(vt),
            });
          }
        } else {
          this.diag.error({
            code: Code.TypeMismatch, phase: "typecheck", symbol: cur.sig.name,
            message: `返回值类型不匹配：函数 '${cur.sig.name}' 声明返回 ${tyName(cur.sig.ret)}，实际返回 ${tyName(vt)}`,
            span: (s.value ?? s).span, expected: tyName(cur.sig.ret), found: tyName(vt),
          });
        }
        return;
      }
      case "if": {
        for (const b of s.branches) {
          this.expectBool(b.cond, scope, "if");
          const inner = new Scope(scope);
          b.body.forEach((x) => this.stmt(x, inner));
        }
        if (s.elseBody) {
          const inner = new Scope(scope);
          s.elseBody.forEach((x) => this.stmt(x, inner));
        }
        return;
      }
      case "while": {
        this.expectBool(s.cond, scope, "while");
        const inner = new Scope(scope);
        s.body.forEach((x) => this.stmt(x, inner));
        return;
      }
      case "for": {
        const it = this.checkExpr(s.iter, scope);
        let elem: Ty = TAny;
        if (it.k === "generic" && (it.name === "List")) elem = it.args[0];
        else if (it.k === "generic" && it.name === "Range") elem = TInt;
        else if (it.k === "generic" && it.name === "Dict") elem = it.args[0];
        else if (it.k === "prim" && it.name === "String") elem = TStr;
        else if (it.k !== "any") {
          this.diag.error({
            code: Code.TypeMismatch, phase: "typecheck",
            message: `for 循环要求可迭代类型（List/Dict/String/range），实际为 ${tyName(it)}`,
            span: s.iter.span, expected: "可迭代类型", found: tyName(it),
          });
        }
        const inner = new Scope(scope);
        inner.declare(s.target, { sort: "var", ty: elem, mutable: false });
        s.body.forEach((x) => this.stmt(x, inner));
        return;
      }
      case "match": {
        this.checkMatch(s.scrut, s.clauses, scope, true);
        return;
      }
      case "assign": {
        const vt = this.checkExpr(s.value, scope);
        const tt = this.lvalue(s.target, scope);
        if (tt.k !== "any" && vt.k !== "any") {
          // 复合赋值按数值规则放宽
          if (s.op === "=") {
            if (!assignable(vt, tt)) {
              this.diag.error({
                code: Code.TypeMismatch, phase: "typecheck",
                message: `赋值类型不匹配：目标为 ${tyName(tt)}，值为 ${tyName(vt)}`,
                span: s.value.span, expected: tyName(tt), found: tyName(vt),
              });
            }
          } else if (!isNumeric(tt) || !isNumeric(vt)) {
            this.diag.error({
              code: Code.TypeMismatch, phase: "typecheck",
              message: `复合赋值 '${s.op}' 要求两侧都是数值类型`,
              span: s.span, found: `${tyName(tt)} ${s.op} ${tyName(vt)}`,
            });
          }
        }
        return;
      }
      case "expr_stmt": {
        this.checkExpr(s.expr, scope);
        return;
      }
    }
  }

  private lvalue(target: A.Expr, scope: Scope): Ty {
    if (target.kind === "ident") {
      const b = scope.lookup(target.name);
      if (!b) {
        this.diag.error({
          code: Code.UnknownName, phase: "typecheck", symbol: target.name,
          message: `变量 '${target.name}' 未定义`,
          span: target.span,
          hints: ["AI 常见幻觉：变量名不存在；检查拼写或先用 let/var 声明"],
        });
        return TAny;
      }
      if (b.sort !== "var") return TAny;
      if (!b.mutable) {
        this.diag.error({
          code: Code.ReassignImmutable, phase: "typecheck", symbol: target.name,
          message: `不能重新赋值给不可变变量 '${target.name}'（let 绑定）`,
          span: target.span,
          hints: [`若确需修改，把 'let ${target.name}' 改为 'var ${target.name}'`],
        });
      }
      return b.ty;
    }
    if (target.kind === "field") {
      // 记录字段写入：要求宿主绑定为 var
      if (target.obj.kind === "ident") {
        const b = scope.lookup(target.obj.name);
        if (b?.sort === "var" && !b.mutable) {
          this.diag.error({
            code: Code.MutateImmutableField, phase: "typecheck", symbol: target.name,
            message: `不能修改不可变绑定 '${target.obj.name}' 的字段 '${target.name}'`,
            span: target.span,
            hints: [`把 'let ${target.obj.name}' 改为 'var ${target.obj.name}'`],
          });
        }
      }
      return this.checkExpr(target, scope);
    }
    return this.checkExpr(target, scope); // index
  }

  private checkMatch(scrut: A.Expr, clauses: A.MatchClause[], scope: Scope, stmtForm: boolean): Ty {
    const st = this.checkExpr(scrut, scope);
    let resultTy: Ty | null = null;
    let hasWild = false;
    for (const c of clauses) {
      if (c.pattern.kind === "pat_wildcard") hasWild = true;
      if (c.pattern.kind === "pat_lit") {
        const pt = this.checkExpr(c.pattern.value, scope);
        if (pt.k !== "any" && st.k !== "any" && !assignable(pt, st) && !assignable(st, pt)) {
          this.diag.error({
            code: Code.TypeMismatch, phase: "typecheck",
            message: `match 分支模式类型 ${tyName(pt)} 与被匹配值类型 ${tyName(st)} 不一致`,
            span: c.pattern.span, expected: tyName(st), found: tyName(pt),
          });
        }
        // 枚举成员必须真实存在（checkExpr 已对 field 形式做过记录/枚举校验）
      }
      if (c.guard) this.expectBool(c.guard, scope, "match guard");
      const inner = new Scope(scope);
      if (c.pattern.kind === "pat_bind") {
        inner.declare(c.pattern.name, { sort: "var", ty: st, mutable: false });
      }
      if (stmtForm) {
        c.body.forEach((x) => this.stmt(x, inner));
      } else if (c.value) {
        const vt = this.checkExpr(c.value, inner);
        if (!resultTy) resultTy = vt;
        else if (!assignable(vt, resultTy) && !assignable(resultTy, vt)) {
          this.diag.error({
            code: Code.TypeMismatch, phase: "typecheck",
            message: `match 各分支返回类型不一致：${tyName(resultTy)} 与 ${tyName(vt)}`,
            span: c.span,
          });
        } else if (assignable(vt, resultTy) === false && assignable(resultTy, vt)) {
          resultTy = vt;
        }
      }
    }
    if (!hasWild && !stmtForm && st.k === "named" && this.enums.has(st.name)) {
      // 枚举 match 不强制穷尽（Phase 0），仅提示
      this.diag.warn({
        code: Code.Style, phase: "typecheck",
        message: `对枚举 '${st.name}' 的 match 没有 '_' 兜底分支`,
        span: scrut.span,
      });
    }
    return resultTy ?? TAny;
  }

  // ---------- 表达式 ----------
  checkExpr(e: A.Expr, scope: Scope): Ty {
    switch (e.kind) {
      case "int": return TInt;
      case "float": return TFloat;
      case "str": return TStr;
      case "bool": return TBool;
      case "null": return TNull;
      case "list": {
        if (!e.items.length) return { k: "generic", name: "List", args: [TAny] };
        const ts = e.items.map((x) => this.checkExpr(x, scope));
        const t0 = ts[0];
        for (const t of ts.slice(1)) {
          if (!assignable(t, t0) && !assignable(t0, t)) {
            this.diag.error({
              code: Code.TypeMismatch, phase: "typecheck",
              message: `列表元素类型不一致：${tyName(t0)} 与 ${tyName(t)}`,
              span: e.span,
            });
          }
        }
        return { k: "generic", name: "List", args: [t0] };
      }
      case "dict": {
        if (!e.items.length) return { k: "generic", name: "Dict", args: [TAny, TAny] };
        const ks = e.items.map((x) => this.checkExpr(x.key, scope));
        const vs = e.items.map((x) => this.checkExpr(x.value, scope));
        const k0 = ks[0], v0 = vs[0];
        ks.slice(1).forEach((t, i) => {
          if (!assignable(t, k0) && !assignable(k0, t)) {
            this.diag.error({
              code: Code.TypeMismatch, phase: "typecheck",
              message: `字典键类型不一致：${tyName(k0)} 与 ${tyName(t)}`,
              span: e.items[i + 1].key.span,
            });
          }
        });
        vs.slice(1).forEach((t, i) => {
          if (!assignable(t, v0) && !assignable(v0, t)) {
            this.diag.error({
              code: Code.TypeMismatch, phase: "typecheck",
              message: `字典值类型不一致：${tyName(v0)} 与 ${tyName(t)}`,
              span: e.items[i + 1].value.span,
            });
          }
        });
        return { k: "generic", name: "Dict", args: [k0, v0] };
      }
      case "ident": {
        const b = scope.lookup(e.name);
        if (!b) {
          this.diag.error({
            code: Code.UnknownName, phase: "typecheck", symbol: e.name,
            message: `名称 '${e.name}' 未定义`,
            span: e.span,
            hints: ["AI 常见幻觉：API/变量不存在；检查拼写、导入或先声明"],
          });
          return TAny;
        }
        if (b.sort === "var" || b.sort === "const") return b.ty;
        return TAny; // fn/record/enum/module 作为值使用时（通常出现在调用位置）
      }
      case "unary": {
        const t = this.checkExpr(e.expr, scope);
        if (e.op === "not") {
          if (t.k !== "any" && !assignable(t, TBool)) {
            this.diag.error({ code: Code.TypeMismatch, phase: "typecheck", message: `'not' 要求 Bool，实际为 ${tyName(t)}`, span: e.span, expected: "Bool", found: tyName(t) });
          }
          return TBool;
        }
        if (t.k !== "any" && !isNumeric(t)) {
          this.diag.error({ code: Code.TypeMismatch, phase: "typecheck", message: `一元 '-' 要求数值类型，实际为 ${tyName(t)}`, span: e.span, expected: "Int/Float", found: tyName(t) });
        }
        return t.k === "any" ? TAny : t;
      }
      case "binary": return this.checkBinary(e, scope);
      case "call": return this.checkCall(e, scope);
      case "field": return this.checkField(e, scope);
      case "index": {
        const ot = this.checkExpr(e.obj, scope);
        const it = this.checkExpr(e.index, scope);
        if (ot.k === "any") return TAny;
        if (ot.k === "generic" && ot.name === "List") {
          if (it.k !== "any" && it.k !== "prim") this.diag.error({ code: Code.TypeMismatch, phase: "typecheck", message: "List 下标必须是 Int", span: e.index.span, expected: "Int", found: tyName(it) });
          return ot.args[0];
        }
        if (ot.k === "generic" && ot.name === "Dict") {
          if (it.k !== "any" && !assignable(it, ot.args[0])) this.diag.error({ code: Code.TypeMismatch, phase: "typecheck", message: "Dict 键类型不匹配", span: e.index.span, expected: tyName(ot.args[0]), found: tyName(it) });
          return ot.args[1];
        }
        if (ot.k === "prim" && ot.name === "String") return TStr;
        return TAny;
      }
      case "await": {
        const t = this.checkExpr(e.expr, scope);
        return t; // Phase 0 不对 future 建模；外部调用多为 Any
      }
      case "try": {
        const t = this.checkExpr(e.expr, scope);
        if (t.k === "any") return TAny;
        if (t.k === "generic" && t.name === "Result") return t.args[0];
        this.diag.error({
          code: Code.TryOnNonResult, phase: "typecheck",
          message: `'?' 只能用于 Result[T, E] 类型，实际为 ${tyName(t)}`,
          span: e.span, expected: "Result[T, E]", found: tyName(t),
          hints: ["非失败表达式不需要 '?'；若该调用可能失败，让它返回 Result[T, E]"],
        });
        return TAny;
      }
      case "match_expr": return this.checkMatch(e.scrut, e.clauses, scope, false);
    }
  }

  private checkBinary(e: A.Binary, scope: Scope): Ty {
    const lt = this.checkExpr(e.left, scope);
    const rt = this.checkExpr(e.right, scope);
    const op = e.op;
    const numeric = () => {
      if (lt.k === "any" || rt.k === "any") return TAny;
      if (!isNumeric(lt) || !isNumeric(rt)) {
        this.diag.error({
          code: Code.TypeMismatch, phase: "typecheck",
          message: `'${op}' 要求数值运算，实际为 ${tyName(lt)} ${op} ${tyName(rt)}`,
          span: e.span, expected: "Int/Float", found: `${tyName(lt)}, ${tyName(rt)}`,
        });
        return TAny;
      }
      return lt.k === "prim" && lt.name === "Int" && rt.k === "prim" && rt.name === "Int" ? TInt : TFloat;
    };
    switch (op) {
      case "+": {
        if (lt.k === "any" || rt.k === "any") return TAny;
        if (isNumeric(lt) && isNumeric(rt)) {
          return lt.k === "prim" && lt.name === "Int" && rt.k === "prim" && rt.name === "Int" ? TInt : TFloat;
        }
        if (lt.k === "prim" && lt.name === "String" && rt.k === "prim" && rt.name === "String") return TStr;
        if (lt.k === "generic" && lt.name === "List" && rt.k === "generic" && rt.name === "List") return lt;
        this.diag.error({
          code: Code.TypeMismatch, phase: "typecheck",
          message: `'+' 只能用于数值、字符串或同类型列表：${tyName(lt)} + ${tyName(rt)}`,
          span: e.span,
        });
        return TAny;
      }
      case "-": case "*": case "%": return numeric();
      case "/": {
        if (lt.k === "any" || rt.k === "any") return TFloat;
        if (!isNumeric(lt) || !isNumeric(rt)) {
          this.diag.error({ code: Code.TypeMismatch, phase: "typecheck", message: `'/' 要求数值运算：${tyName(lt)} / ${tyName(rt)}`, span: e.span });
          return TFloat;
        }
        return TFloat; // Chock 中 / 始终为浮点除
      }
      case "==": case "!=": {
        if (lt.k === "any" || rt.k === "any") return TBool;
        if (!assignable(lt, rt) && !assignable(rt, lt)) {
          this.diag.warn({ code: Code.Style, phase: "typecheck", message: `比较 '${op}' 两侧类型无交集：${tyName(lt)} 与 ${tyName(rt)}`, span: e.span });
        }
        return TBool;
      }
      case "<": case "<=": case ">": case ">=": {
        if (lt.k === "any" || rt.k === "any") return TBool;
        const ok = (isNumeric(lt) && isNumeric(rt)) ||
          (lt.k === "prim" && lt.name === "String" && rt.k === "prim" && rt.name === "String");
        if (!ok) {
          this.diag.error({ code: Code.TypeMismatch, phase: "typecheck", message: `'${op}' 要求两侧同为数值或字符串：${tyName(lt)} ${op} ${tyName(rt)}`, span: e.span });
        }
        return TBool;
      }
      case "and": case "or": {
        if (lt.k !== "any" && !assignable(lt, TBool)) this.diag.error({ code: Code.ConditionType, phase: "typecheck", message: `'${op}' 左侧必须是 Bool，实际为 ${tyName(lt)}`, span: e.left.span, expected: "Bool", found: tyName(lt) });
        if (rt.k !== "any" && !assignable(rt, TBool)) this.diag.error({ code: Code.ConditionType, phase: "typecheck", message: `'${op}' 右侧必须是 Bool，实际为 ${tyName(rt)}`, span: e.right.span, expected: "Bool", found: tyName(rt) });
        return TBool;
      }
      default: return TAny;
    }
  }

  private checkField(e: A.FieldExpr, scope: Scope): Ty {
    // 静态形式：Type.member / Type.parse
    if (e.obj.kind === "ident") {
      const b = scope.lookup(e.obj.name);
      if (b?.sort === "enum") {
        if (!b.info.members.includes(e.name)) {
          this.diag.error({
            code: Code.UnknownField, phase: "typecheck", symbol: e.name,
            message: `枚举 '${b.info.name}' 没有成员 '${e.name}'`,
            span: e.span,
            hints: [`可选成员：${b.info.members.join(", ")}`],
          });
        }
        return { k: "named", name: b.info.name };
      }
      if (b?.sort === "record") {
        if (e.name === "parse") return { k: "generic", name: "Result", args: [{ k: "named", name: b.info.name }, { k: "named", name: "Error" }] };
        this.diag.error({
          code: Code.UnknownField, phase: "typecheck", symbol: e.name,
          message: `类型 '${b.info.name}' 没有静态成员 '${e.name}'`,
          span: e.span, hints: ["Phase 0 仅支持 T.parse(raw) 静态解析"],
        });
        return TAny;
      }
      if (b?.sort === "module") return TAny; // 外部模块成员不校验
    }
    const ot = this.checkExpr(e.obj, scope);
    if (ot.k === "any") return TAny;
    if (ot.k === "named") {
      const rec = this.records.get(ot.name);
      if (rec) {
        const f = rec.fields.find((x) => x.name === e.name);
        if (!f) {
          this.diag.error({
            code: Code.UnknownField, phase: "typecheck", symbol: e.name,
            message: `类型 '${ot.name}' 没有字段 '${e.name}'`,
            span: e.span,
            hints: [`可用字段：${rec.fields.map((x) => x.name).join(", ")}`],
          });
          return TAny;
        }
        return f.ty;
      }
      return TAny;
    }
    if (ot.k === "generic") {
      if (ot.name === "List" || ot.name === "Dict") {
        // 字段位置的方法值不常见，宽松处理（方法调用在 checkCall 中精确处理）
        return TAny;
      }
      if (ot.name === "Result") {
        // Ok.value / Err.error（是否有效由 is_ok/is_err 分支保证，类型侧宽松）
        if (e.name === "value") return ot.args[0];
        if (e.name === "error") return ot.args[1];
      }
    }
    return TAny;
  }

  private checkCall(node: A.Call, scope: Scope): Ty {
    // 1) 内置 / 用户函数直调
    if (node.callee.kind === "ident") {
      const name = node.callee.name;
      const b = scope.lookup(name);
      if (BUILTINS[name]) {
        const bi = BUILTINS[name];
        const argTs = node.args.map((a) => this.checkExpr(a.value, scope));
        if (bi.arity && (node.args.length < bi.arity[0] || node.args.length > bi.arity[1])) {
          this.argCount(name, bi.arity[0] === bi.arity[1] ? bi.arity[0] : bi.arity[0], node.args.length, node.span);
        }
        return bi.check(this, argTs, node);
      }
      if (b?.sort === "fn") return this.checkUserCall(b.sig, node.args, node, scope);
      if (b?.sort === "record") return this.checkRecordCall(b.info, node.args, node, scope);
      if (b?.sort === "enum") {
        this.diag.error({ code: Code.NotCallable, phase: "typecheck", symbol: name, message: `枚举类型 '${name}' 不可调用，枚举成员写法为 '${name}.member'`, span: node.span });
        return TAny;
      }
      if (b?.sort === "module") {
        this.diag.error({ code: Code.NotCallable, phase: "typecheck", symbol: name, message: `模块 '${name}' 不可直接调用，需通过 '${name}.函数(...)' 访问`, span: node.span });
        return TAny;
      }
      if (b?.sort === "var") {
        this.diag.error({ code: Code.NotCallable, phase: "typecheck", symbol: name, message: `'${name}' 是变量不是函数，不能调用`, span: node.span, expected: "函数", found: tyName(b.ty) });
        return TAny;
      }
      this.diag.error({
        code: Code.UnknownName, phase: "typecheck", symbol: name,
        message: `函数 '${name}' 未定义`,
        span: node.span,
        hints: ["AI 常见幻觉：调用了不存在的函数/API；检查拼写与 import，或先声明 fn"],
      });
      node.args.forEach((a) => this.checkExpr(a.value, scope));
      return TAny;
    }

    // 2) 方法调用 obj.method(...)
    if (node.callee.kind === "field") {
      const f = node.callee;
      return this.checkMethodCall(f.obj, f.name, node, scope);
    }

    // 3) 其他可调用值
    const ct = this.checkExpr(node.callee, scope);
    node.args.forEach((a) => this.checkExpr(a.value, scope));
    if (ct.k !== "any") {
      this.diag.error({ code: Code.NotCallable, phase: "typecheck", message: `类型为 ${tyName(ct)} 的值不可调用`, span: node.span });
    }
    return TAny;
  }

  private checkUserCall(sig: FnSig, args: A.CallArg[], node: A.Call, scope: Scope): Ty {
    const assigned: (Ty | null)[] = sig.params.map(() => null);
    let positional = 0;
    for (const a of args) {
      const at = this.checkExpr(a.value, scope);
      if (a.name) {
        const idx = sig.params.findIndex((p) => p.name === a.name);
        if (idx < 0) {
          this.diag.error({
            code: Code.UnknownName, phase: "typecheck", symbol: a.name,
            message: `函数 '${sig.name}' 没有参数 '${a.name}'`,
            span: a.span, hints: [`参数列表：${sig.params.map((p) => p.name).join(", ")}`],
          });
          continue;
        }
        assigned[idx] = at;
      } else {
        if (positional >= sig.params.length) {
          this.argCount(sig.name, sig.params.length, args.length, node.span);
          return TAny;
        }
        assigned[positional] = at;
        positional++;
      }
    }
    sig.params.forEach((p, i) => {
      const got = assigned[i];
      if (!got) {
        if (!p.hasDefault) {
          this.diag.error({
            code: Code.ArgCount, phase: "typecheck", symbol: p.name,
            message: `函数 '${sig.name}' 缺少必填参数 '${p.name}'`,
            span: node.span, expected: tyName(p.ty),
          });
        }
        return;
      }
      if (!assignable(got, p.ty)) {
        this.diag.error({
          code: Code.TypeMismatch, phase: "typecheck", symbol: p.name,
          message: `参数 '${p.name}' 类型不匹配：期望 ${tyName(p.ty)}，实参为 ${tyName(got)}`,
          span: node.span, expected: tyName(p.ty), found: tyName(got),
          hints: [`可用 ${p.ty.k === "prim" && p.ty.name === "Float" ? "Float(x)" : "显式构造函数"} 转换`],
        });
      }
    });
    return sig.ret;
  }

  private checkRecordCall(info: RecordInfo, args: A.CallArg[], node: A.Call, scope: Scope): Ty {
    const assigned = new Map<string, Ty>();
    let positional = 0;
    for (const a of args) {
      const at = this.checkExpr(a.value, scope);
      let fname = a.name;
      if (!fname) {
        const f = info.fields[positional];
        if (!f) {
          this.diag.error({ code: Code.ArgCount, phase: "typecheck", symbol: info.name, message: `'${info.name}' 只有 ${info.fields.length} 个字段，实参过多`, span: node.span });
          continue;
        }
        fname = f.name;
        positional++;
      }
      if (!info.fields.some((f) => f.name === fname)) {
        this.diag.error({
          code: Code.UnknownField, phase: "typecheck", symbol: fname,
          message: `类型 '${info.name}' 没有字段 '${fname}'`,
          span: a.span, hints: [`可用字段：${info.fields.map((f) => f.name).join(", ")}`],
        });
        continue;
      }
      assigned.set(fname, at);
    }
    for (const f of info.fields) {
      const got = assigned.get(f.name);
      if (!got) {
        if (!f.hasDefault) {
          this.diag.error({
            code: Code.ArgCount, phase: "typecheck", symbol: f.name,
            message: `构造 '${info.name}' 缺少必填字段 '${f.name}'`,
            span: node.span,
          });
        }
        continue;
      }
      if (!assignable(got, f.ty)) {
        this.diag.error({
          code: Code.TypeMismatch, phase: "typecheck", symbol: f.name,
          message: `字段 '${info.name}.${f.name}' 类型不匹配：期望 ${tyName(f.ty)}，实参为 ${tyName(got)}`,
          span: node.span, expected: tyName(f.ty), found: tyName(got),
        });
      }
    }
    return { k: "named", name: info.name };
  }

  private checkMethodCall(obj: A.Expr, name: string, node: A.Call, scope: Scope): Ty {
    // 静态：User.parse(raw)
    if (obj.kind === "ident") {
      const b = scope.lookup(obj.name);
      if (b?.sort === "record") {
        if (name === "parse") {
          if (node.args.length !== 1) this.argCount(`${b.info.name}.parse`, 1, node.args.length, node.span);
          node.args.forEach((a) => this.checkExpr(a.value, scope));
          return { k: "generic", name: "Result", args: [{ k: "named", name: b.info.name }, { k: "named", name: "Error" }] };
        }
        this.diag.error({ code: Code.UnknownMethod, phase: "typecheck", symbol: name, message: `类型 '${b.info.name}' 没有静态方法 '${name}'`, span: node.span });
        node.args.forEach((a) => this.checkExpr(a.value, scope));
        return TAny;
      }
      if (b?.sort === "module") {
        node.args.forEach((a) => this.checkExpr(a.value, scope));
        return TAny;
      }
    }

    const ot = this.checkExpr(obj, scope);
    const argTs = node.args.map((a) => ({ a, t: this.checkExpr(a.value, scope) }));

    if (ot.k === "any") return TAny;

    if (ot.k === "generic" && ot.name === "List") {
      switch (name) {
        case "append":
          if (node.args.length !== 1) this.argCount("append", 1, node.args.length, node.span);
          else if (argTs[0].t.k !== "any" && !assignable(argTs[0].t, ot.args[0])) {
            this.diag.error({ code: Code.TypeMismatch, phase: "typecheck", symbol: name, message: `append 元素类型不匹配：期望 ${tyName(ot.args[0])}，实参 ${tyName(argTs[0].t)}`, span: node.span, expected: tyName(ot.args[0]), found: tyName(argTs[0].t) });
          }
          return TUnit;
        case "pop":
          if (node.args.length > 1) this.argCount("pop", 1, node.args.length, node.span);
          return { k: "optional", inner: ot.args[0] };
        case "clear": return TUnit;
        case "map": return TAny; // Phase 0 不建 lambda，保留逃生口
        default:
          this.diag.warn({ code: Code.UnknownMethod, phase: "typecheck", symbol: name, message: "List 的未知方法，按 Any 处理（Phase 0 仅内置 append/pop/clear）", span: node.span });
          return TAny;
      }
    }
    if (ot.k === "generic" && ot.name === "Dict") {
      switch (name) {
        case "get":
          if (node.args.length < 1 || node.args.length > 2) this.argCount("get", 2, node.args.length, node.span);
          return { k: "optional", inner: ot.args[1] };
        case "keys": case "values": return { k: "generic", name: "List", args: [name === "keys" ? ot.args[0] : ot.args[1]] };
        default:
          this.diag.warn({ code: Code.UnknownMethod, phase: "typecheck", symbol: name, message: "Dict 的未知方法，按 Any 处理（Phase 0 仅内置 get/keys/values）", span: node.span });
          return TAny;
      }
    }
    if (ot.k === "prim" && ot.name === "String") {
      switch (name) {
        case "upper": case "lower": case "strip": case "trim": return TStr;
        case "contains": return TBool;
        case "parse_int": case "parse_float": return { k: "generic", name: "Result", args: [name === "parse_int" ? TInt : TFloat, { k: "named", name: "Error" }] };
        default:
          this.diag.warn({ code: Code.UnknownMethod, phase: "typecheck", symbol: name, message: "String 的未知方法，按 Any 处理（Phase 0 仅内置 upper/lower/strip/contains）", span: node.span });
          return TAny;
      }
    }
    if (ot.k === "named") {
      const rec = this.records.get(ot.name);
      if (rec) {
        this.diag.error({
          code: Code.UnknownMethod, phase: "typecheck", symbol: name,
          message: `类型 '${ot.name}' 没有实例方法 '${name}'（Phase 0 不支持在 Chock 中为 type 定义方法）`,
          span: node.span,
        });
        return TAny;
      }
    }
    return TAny;
  }
}
