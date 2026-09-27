// chock fmt：从 AST 规范化打印 Chock 源码（4 空格缩进、统一风格）。
// 不做 lexer 级 whitespace 保留；Phase 0 目标是让所有 Agent 产出收敛到同一风格。
import type * as A from "./ast.js";

class Printer {
  private out: string[] = [];
  private depth = 0;
  constructor(private comments: Map<A.Node, string[]>) {}
  private get ind(): string { return "    ".repeat(this.depth); }

  private emit(text: string): void { this.out.push(this.ind + text); }
  private blank(): void { this.out.push(""); }

  // 打印挂在节点上的前导注释
  private lead(node: A.Node): void {
    const cs = this.comments.get(node);
    if (cs) for (const c of cs) this.emit(c);
  }

  format(prog: A.Program): string {
    for (const c of prog.header) this.emit(c);
    if (prog.module) this.emit(`module ${prog.module.name}`);
    if (prog.imports.length) {
      if (prog.module || prog.header.length) this.blank();
      for (const imp of prog.imports) {
        this.lead(imp);
        this.emit(`import ${imp.path}`);
      }
    }
    let first = true;
    for (const d of prog.decls) {
      if (!first || prog.imports.length || prog.module) this.blank();
      first = false;
      this.lead(d);
      if (d.kind === "enum") this.enum_(d);
      else if (d.kind === "type_decl") this.record(d);
      else this.fn(d);
    }
    return this.out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  }

  private enum_(d: A.EnumDecl): void {
    this.emit(`enum ${d.name}:`);
    this.depth++;
    // 多行风格统一
    for (let i = 0; i < d.members.length; i++) {
      this.emit(d.members[i] + (i < d.members.length - 1 ? "," : ""));
    }
    this.depth--;
  }

  private record(d: A.TypeDecl): void {
    this.emit(`type ${d.name}:`);
    this.depth++;
    for (const f of d.fields) {
      const cs = this.comments.get(f);
      if (cs) for (const c of cs) this.emit(c);
      const tail = f.default ? ` = ${this.expr(f.default)}` : "";
      this.emit(`${f.name}: ${this.typeNode(f.type)}${tail}`);
    }
    this.depth--;
  }

  private fn(d: A.FnDecl): void {
    for (const dec of d.decorators) {
      if (dec.name === "intent") this.emit(`@intent ${JSON.stringify(dec.text ?? "")}`);
      else if (dec.expr) this.emit(`@${dec.name} ${this.expr(dec.expr)}`);
    }
    const params = d.params.map((p) =>
      `${p.name}: ${this.typeNode(p.type)}${p.default ? ` = ${this.expr(p.default)}` : ""}`,
    ).join(", ");
    const ret = d.retExplicit ? ` -> ${this.typeNode(d.returnType)}` : "";
    this.emit(`${d.async ? "async " : ""}fn ${d.name}(${params})${ret}:`);
    this.depth++;
    for (const s of d.body) this.stmt(s);
    this.depth--;
  }

  private typeNode(t: A.TypeNode): string {
    let s: string;
    if (t.args.length) s = `${t.name}[${t.args.map((x) => this.typeNode(x)).join(", ")}]`;
    else s = t.name;
    return t.optional ? `${s}?` : s;
  }

  private block(stmts: A.Stmt[]): void {
    this.depth++;
    for (const s of stmts) this.stmt(s);
    this.depth--;
  }

  private stmt(s: A.Stmt): void {
    this.lead(s);
    switch (s.kind) {
      case "let": {
        const ty = s.type ? `: ${this.typeNode(s.type)}` : "";
        if (s.value && s.value.kind === "match_expr") {
          this.emit(`${s.mutable ? "var" : "let"} ${s.name}${ty} = match ${this.expr(s.value.scrut)}:`);
          this.matchClauses(s.value.clauses);
          return;
        }
        const val = s.value ? ` = ${this.expr(s.value)}` : "";
        this.emit(`${s.mutable ? "var" : "let"} ${s.name}${ty}${val}`);
        return;
      }
      case "return":
        if (s.value && s.value.kind === "match_expr") {
          this.emit(`return match ${this.expr(s.value.scrut)}:`);
          this.matchClauses(s.value.clauses);
          return;
        }
        this.emit(s.value ? `return ${this.expr(s.value)}` : "return");
        return;
      case "if": {
        s.branches.forEach((b, i) => {
          this.emit(`${i === 0 ? "if" : "elif"} ${this.expr(b.cond)}:`);
          this.block(b.body);
        });
        if (s.elseBody) {
          this.emit("else:");
          this.block(s.elseBody);
        }
        return;
      }
      case "while":
        this.emit(`while ${this.expr(s.cond)}:`);
        this.block(s.body);
        return;
      case "for":
        this.emit(`${s.parallel ? "parallel " : ""}for ${s.target} in ${this.expr(s.iter)}:`);
        this.block(s.body);
        return;
      case "match":
        this.emit(`match ${this.expr(s.scrut)}:`);
        this.matchClauses(s.clauses);
        return;
      case "assign":
        this.emit(`${this.expr(s.target)} ${s.op} ${this.expr(s.value)}`);
        return;
      case "expr_stmt":
        this.emit(this.expr(s.expr));
        return;
    }
  }

  private matchClauses(cs: A.MatchClause[]): void {
    this.depth++;
    for (const c of cs) {
      let p: string;
      if (c.pattern.kind === "pat_wildcard") p = "_";
      else if (c.pattern.kind === "pat_bind") p = c.pattern.name;
      else p = this.expr(c.pattern.value);
      const g = c.guard ? ` if ${this.expr(c.guard)}` : "";
      this.emit(`${p}${g} -> ${c.value ? this.expr(c.value) : "None"}`);
    }
    this.depth--;
  }

  private expr(e: A.Expr): string {
    switch (e.kind) {
      case "int": return e.raw;
      case "float": return e.raw;
      case "str": return e.raw;
      case "bool": return e.value ? "true" : "false";
      case "null": return "null";
      case "ident": return e.name;
      case "list": return `[${e.items.map((x) => this.expr(x)).join(", ")}]`;
      case "dict": return `{${e.items.map((x) => `${this.expr(x.key)}: ${this.expr(x.value)}`).join(", ")}}`;
      case "unary": return e.op === "not" ? `not ${this.paren(e.expr, 2)}` : `-${this.paren(e.expr, 7)}`;
      case "binary": return `${this.paren(e.left, this.prec(e.op))} ${e.op} ${this.paren(e.right, this.prec(e.op) + 1)}`;
      case "call": {
        const callee = this.expr(e.callee);
        const args = e.args.map((a) => `${a.name ? `${a.name} = ` : ""}${this.expr(a.value)}`).join(", ");
        return `${callee}(${args})`;
      }
      case "field": return `${this.expr(e.obj)}.${e.name}`;
      case "index": return `${this.expr(e.obj)}[${this.expr(e.index)}]`;
      case "await": return `${this.expr(e.expr)}.await`;
      case "try": return `${this.expr(e.expr)}?`;
      case "match_expr":
        // 嵌套在其他表达式中的 match（罕见）：降级为括号形式的单行占位注释
        return "(match ...)";
    }
  }

  private prec(op: string): number {
    if (op === "or") return 1;
    if (op === "and") return 2;
    if (["==", "!=", "<", "<=", ">", ">="].includes(op)) return 3;
    if (op === "+" || op === "-") return 4;
    return 5;
  }

  private paren(e: A.Expr, parentPrec: number): string {
    if (e.kind === "binary") {
      const mine = this.prec(e.op);
      const s = this.expr(e);
      return mine < parentPrec ? `(${s})` : s;
    }
    return this.expr(e);
  }
}

export function formatProgram(prog: A.Program): string {
  return new Printer(prog.comments).format(prog);
}
