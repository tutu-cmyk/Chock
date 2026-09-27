// Parser：Token 流 → AST。Python 亲缘缩进语法的递归下降解析器。
import type { Tok, TokKind } from "./lexer.js";
import { tokenize } from "./lexer.js";
import type { DiagnosticCollector } from "./diag.js";
import { Code } from "./diag.js";
import { spanOf, mergeSpan, type Span } from "./span.js";
import type * as A from "./ast.js";

export function parse(file: string, src: string, diag: DiagnosticCollector): A.Program {
  const toks = tokenize(file, src, diag);
  const p = new Parser(file, toks, diag);
  return p.parseProgram();
}

class Parser {
  private i = 0;
  constructor(
    private file: string,
    private toks: Tok[],
    private diag: DiagnosticCollector,
  ) {}

  private peek(off = 0): Tok { return this.toks[Math.min(this.i + off, this.toks.length - 1)]; }
  private at(...kinds: TokKind[]): boolean { return kinds.includes(this.peek().kind); }
  private span(t: Tok): Span {
    return spanOf(this.file, t.line, t.col, t.endLine, t.endCol);
  }

  private advance(): Tok {
    const t = this.peek();
    if (t.kind !== "EOF") this.i++;
    return t;
  }

  private skipTrivia(): void {
    while (this.at("COMMENT")) this.advance();
  }

  private expect(kind: TokKind, what?: string): Tok {
    this.skipTrivia();
    const t = this.peek();
    if (t.kind !== kind) {
      this.diag.error({
        code: Code.ParseError, phase: "parser",
        message: `语法错误：期望 ${what ?? kind}，但遇到 '${t.value || t.kind}'`,
        span: this.span(t),
      });
      // 强制推进一个 token，保证解析总能终止（防止错误恢复死循环）
      if (t.kind !== "EOF") this.advance();
      return t;
    }
    return this.advance();
  }

  private consumeNewlines(): void {
    this.skipTrivia();
    while (this.at("NEWLINE")) this.advance();
    this.skipTrivia();
  }

  private commentMap = new Map<A.Node, string[]>();
  // type/enum 体尾（下一个顶层声明之前）收集到的注释，交给 parseProgram 挂给下一声明
  private bodyTrailing: string[] = [];

  // 收集连续的整行注释与空行；注释文本存入 out（供 fmt 保留）。
  // 注意：不能调用 skipTrivia()——它会把 COMMENT 一并吞掉。
  private collectComments(out: string[]): void {
    for (;;) {
      if (this.at("COMMENT")) { out.push(this.advance().value.trimEnd()); continue; }
      if (this.at("NEWLINE")) { this.advance(); continue; }
      break;
    }
  }

  // ---------- 程序 ----------
  parseProgram(): A.Program {
    const start = this.peek();
    const prog: A.Program = {
      kind: "program", span: this.span(start), imports: [], decls: [],
      header: [], comments: this.commentMap,
    };
    this.collectComments(prog.header);

    if (this.at("MODULE")) {
      const t = this.advance();
      const name = this.expect("IDENT", "模块名");
      prog.module = { kind: "module", name: name.value, span: mergeSpan(this.span(t), this.span(name)) };
      this.at("NEWLINE") && this.advance();
    }

    let pendingLead: string[] = [];
    while (this.at("IMPORT") || this.at("COMMENT") || this.at("NEWLINE")) {
      const lead: string[] = pendingLead;
      pendingLead = [];
      this.collectComments(lead);
      if (!this.at("IMPORT")) { pendingLead = lead; break; }
      const t = this.advance();
      const impPath = this.parseImportPath();
      const imp: A.ImportDecl = { kind: "import", path: impPath, span: mergeSpan(this.span(t), this.lastTokSpan()) };
      prog.imports.push(imp);
      if (lead.length) this.commentMap.set(imp, lead);
    }

    while (!this.at("EOF")) {
      const lead: string[] = pendingLead;
      pendingLead = [];
      this.collectComments(lead);
      if (this.at("EOF")) break;
      const decorators = this.parseDecorators();
      let decl: A.Decl | null = null;
      if (this.at("FN", "ASYNC")) {
        decl = this.parseFn(decorators);
      } else if (this.at("ENUM")) {
        if (decorators.length) this.diag.error({ code: Code.ParseError, phase: "parser", message: "enum 不支持装饰器", span: decorators[0].span });
        decl = this.parseEnum();
      } else if (this.at("TYPE")) {
        if (decorators.length) this.diag.error({ code: Code.ParseError, phase: "parser", message: "type 不支持装饰器", span: decorators[0].span });
        decl = this.parseType();
      } else {
        const t = this.peek();
        this.diag.error({
          code: Code.ParseError, phase: "parser",
          message: `语法错误：顶层只能是 fn/type/enum/import，遇到 '${t.value || t.kind}'`,
          span: this.span(t),
          hints: ["顶层语句需放入 fn main() 中"],
        });
        this.recoverToNextDecl();
      }
      if (decl) {
        prog.decls.push(decl);
        if (lead.length) this.commentMap.set(decl, lead);
        if (this.bodyTrailing.length) {
          pendingLead = [...this.bodyTrailing, ...pendingLead];
          this.bodyTrailing = [];
        }
      }
    }

    prog.span = mergeSpan(this.span(start), this.span(this.peek()));
    return prog;
  }

  private lastTokSpan(): Span {
    return this.span(this.toks[Math.max(0, this.i - 1)]);
  }

  private recoverToNextDecl(): void {
    // 跳到下一条 NEWLINE，让解析尽量继续
    while (!this.at("EOF", "NEWLINE")) this.advance();
    if (this.at("NEWLINE")) this.advance();
  }

  private parseImportPath(): string {
    // module/path 形式：ident (/ ident)*
    const parts: string[] = [];
    const first = this.expect("IDENT", "模块路径");
    parts.push(first.value);
    while (this.at("SLASH")) {
      this.advance();
      const seg = this.expect("IDENT", "模块名");
      parts.push(seg.value);
    }
    return parts.join("/");
  }

  private parseDecorators(): A.Decorator[] {
    const out: A.Decorator[] = [];
    while (this.at("AT")) {
      const at = this.advance();
      const nameT = this.expect("IDENT", "装饰器名（intent/require/ensure）");
      let text: string | undefined;
      let expr: A.Expr | undefined;
      this.skipTrivia();
      if (this.at("STRING")) {
        const s = this.advance();
        text = parseStringRaw(s.value);
      } else if (!this.at("NEWLINE")) {
        expr = this.parseExpr();
      }
      out.push({
        kind: "decorator", name: nameT.value, text, expr,
        span: mergeSpan(this.span(at), this.lastTokSpan()),
      });
      this.consumeNewlines();
    }
    return out;
  }

  private parseEnum(): A.EnumDecl {
    const kw = this.advance(); // ENUM
    const name = this.expect("IDENT", "枚举名");
    this.expect("COLON");
    const members: string[] = [];
    const memberComments: string[] = [];
    let lead: string[] = [];
    // 允许 ':' 后、INDENT 前存在注释行
    for (;;) {
      if (this.at("COMMENT")) { lead.push(this.advance().value.trimEnd()); continue; }
      if (this.at("NEWLINE")) { this.advance(); continue; }
      break;
    }
    if (this.at("INDENT")) {
      this.advance();
      memberComments.push(...lead);
      lead = [];
      while (!this.at("DEDENT", "EOF")) {
        while (this.at("COMMENT")) lead.push(this.advance().value.trimEnd());
        if (this.at("NEWLINE")) { this.advance(); continue; }
        if (this.at("DEDENT", "EOF")) break;
        const m = this.expect("IDENT", "枚举成员");
        members.push(m.value);
        memberComments.push(...lead); // 成员前注释无法精确归位，保留在 enum 节点上
        lead = [];
        this.skipTrivia();
        if (this.at("COMMA")) this.advance();
        this.skipTrivia();
        if (this.at("NEWLINE")) this.advance();
      }
      this.at("DEDENT") && this.advance();
      if (lead.length) this.bodyTrailing.push(...lead);
    } else {
      // 单行：enum Plan: free, pro, team
      while (!this.at("NEWLINE", "EOF")) {
        const m = this.expect("IDENT", "枚举成员");
        members.push(m.value);
        this.skipTrivia();
        if (this.at("COMMA")) this.advance();
        this.skipTrivia();
      }
      this.at("NEWLINE") && this.advance();
    }
    const node: A.EnumDecl = { kind: "enum", name: name.value, members, span: mergeSpan(this.span(kw), this.lastTokSpan()) };
    if (memberComments.length) {
      const prev = this.commentMap.get(node) ?? [];
      this.commentMap.set(node, [...memberComments, ...prev]);
    }
    return node;
  }

  private parseType(): A.TypeDecl {
    const kw = this.advance(); // TYPE
    const name = this.expect("IDENT", "类型名");
    this.expect("COLON");
    // 允许 ':' 后、INDENT 前存在注释行（注释行会延迟 INDENT 的发出）
    let lead: string[] = [];
    for (;;) {
      if (this.at("COMMENT")) { lead.push(this.advance().value.trimEnd()); continue; }
      if (this.at("NEWLINE")) { this.advance(); continue; }
      break;
    }
    this.expect("INDENT", "字段缩进块");
    const fields: A.TypeField[] = [];
    while (!this.at("DEDENT", "EOF")) {
      while (this.at("COMMENT")) lead.push(this.advance().value.trimEnd());
      if (this.at("NEWLINE")) { this.advance(); continue; }
      if (this.at("DEDENT", "EOF")) break;
      const fname = this.expect("IDENT", "字段名");
      this.expect("COLON");
      const ftype = this.parseTypeNode();
      let def: A.Expr | undefined;
      this.skipTrivia();
      if (this.at("ASSIGN")) {
        this.advance();
        def = this.parseExpr();
      }
      const field: A.TypeField = {
        kind: "field", name: fname.value, type: ftype, default: def,
        span: mergeSpan(this.span(fname), this.lastTokSpan()),
      };
      fields.push(field);
      if (lead.length) this.commentMap.set(field, lead);
      lead = [];
      this.skipTrivia();
      if (this.at("NEWLINE")) this.advance();
    }
    this.at("DEDENT") && this.advance();
    if (lead.length) this.bodyTrailing.push(...lead);
    return { kind: "type_decl", name: name.value, fields, span: mergeSpan(this.span(kw), this.lastTokSpan()) };
  }

  private parseFn(decorators: A.Decorator[]): A.FnDecl {
    const kw = this.at("ASYNC") ? this.advance() : this.peek();
    const fnT = this.expect("FN");
    const name = this.expect("IDENT", "函数名");
    this.expect("LPAREN");
    const params: A.Param[] = [];
    this.skipTrivia();
    if (!this.at("RPAREN")) {
      for (;;) {
        this.skipTrivia();
        const pname = this.expect("IDENT", "参数名");
        this.expect("COLON");
        const ptype = this.parseTypeNode();
        let pdef: A.Expr | undefined;
        this.skipTrivia();
        if (this.at("ASSIGN")) { this.advance(); pdef = this.parseExpr(); }
        params.push({
          kind: "param", name: pname.value, type: ptype, default: pdef,
          span: mergeSpan(this.span(pname), this.lastTokSpan()),
        });
        this.skipTrivia();
        if (this.at("COMMA")) { this.advance(); continue; }
        break;
      }
    }
    this.expect("RPAREN");
    let returnType: A.TypeNode = this.unitType(fnT);
    let retExplicit = false;
    this.skipTrivia();
    if (this.at("ARROW")) {
      this.advance();
      retExplicit = true;
      returnType = this.parseTypeNode();
    }
    this.expect("COLON");
    const body = this.parseBlock();
    return {
      kind: "fn", name: name.value, async: kw.kind === "ASYNC",
      params, returnType, retExplicit, body, decorators,
      span: mergeSpan(this.span(kw), this.lastTokSpan()),
    };
  }

  private unitType(at: Tok): A.TypeNode {
    return { kind: "type", name: "Unit", args: [], optional: false, span: this.span(at) };
  }

  private parseTypeNode(): A.TypeNode {
    this.skipTrivia();
    const t = this.expect("IDENT", "类型名");
    const args: A.TypeNode[] = [];
    let end: Span = this.span(t);
    if (this.at("LBRACK")) {
      this.advance();
      this.skipTrivia();
      args.push(this.parseTypeNode());
      while (this.at("COMMA")) {
        this.advance();
        this.skipTrivia();
        args.push(this.parseTypeNode());
      }
      this.skipTrivia();
      const rb = this.expect("RBRACK");
      end = this.span(rb);
    }
    let optional = false;
    this.skipTrivia();
    if (this.at("QM")) {
      optional = true;
      end = this.span(this.advance());
    }
    return { kind: "type", name: t.value, args, optional, span: mergeSpan(this.span(t), end) };
  }

  // ---------- 语句块 ----------
  private parseBlock(): A.Stmt[] {
    // 跳过 ':' 后的行尾注释与空行；块首注释收集后挂到第一条语句
    const headComments: string[] = [];
    let sawNewline = false;
    for (;;) {
      // 不能用 skipTrivia：它会吞掉 COMMENT
      if (this.at("COMMENT")) { headComments.push(this.advance().value.trimEnd()); continue; }
      if (this.at("NEWLINE")) { this.advance(); sawNewline = true; continue; }
      break;
    }
    if (sawNewline || this.at("INDENT")) {
      this.expect("INDENT", "缩进语句块");
      const stmts = this.parseStmts();
      this.at("DEDENT") && this.advance();
      if (headComments.length && stmts.length) {
        const prev = this.commentMap.get(stmts[0]) ?? [];
        this.commentMap.set(stmts[0], [...headComments, ...prev]);
      }
      return stmts;
    }
    // 单行块：if x: return y
    return [this.parseStmt()];
  }

  private parseStmts(): A.Stmt[] {
    const out: A.Stmt[] = [];
    for (;;) {
      const lead: string[] = [];
      this.collectComments(lead);
      if (this.at("DEDENT", "EOF")) {
        // 块尾注释挂到最后一条语句，避免丢失
        if (lead.length && out.length) {
          const prev = this.commentMap.get(out[out.length - 1]) ?? [];
          this.commentMap.set(out[out.length - 1], [...prev, ...lead]);
        }
        break;
      }
      if (this.at("RPAREN", "RBRACK")) break;
      const s = this.parseStmt();
      if (lead.length) this.commentMap.set(s, lead);
      out.push(s);
      if (out.length > 5000) break;
    }
    return out;
  }

  private parseStmt(): A.Stmt {
    if (this.at("LET", "VAR")) return this.parseLet();
    if (this.at("RETURN")) return this.parseReturn();
    if (this.at("IF")) return this.parseIf();
    if (this.at("WHILE")) return this.parseWhile();
    if (this.at("FOR", "PARALLEL")) return this.parseFor();
    if (this.at("MATCH")) return this.parseMatchStmt();

    // 表达式语句 或 赋值
    const start = this.peek();
    const expr = this.parseExpr();
    this.skipTrivia();
    const opT = this.peek();
    if (opT.kind === "ASSIGN" || opT.kind === "PLUS_EQ" || opT.kind === "MINUS_EQ" || opT.kind === "STAR_EQ" || opT.kind === "SLASH_EQ") {
      if (expr.kind !== "ident" && expr.kind !== "field" && expr.kind !== "index") {
        this.diag.error({
          code: Code.ParseError, phase: "parser",
          message: "赋值目标必须是变量、字段或下标表达式",
          span: expr.span,
        });
      }
      this.advance();
      const value = this.parseExpr();
      const op = opT.value as A.AssignStmt["op"];
      return { kind: "assign", target: expr, op, value, span: mergeSpan(this.span(start), this.lastTokSpan()) };
    }
    return { kind: "expr_stmt", expr, span: expr.span };
  }

  private parseLet(): A.LetStmt {
    const kw = this.advance();
    const mutable = kw.kind === "VAR";
    const name = this.expect("IDENT", "变量名");
    let type: A.TypeNode | undefined;
    let value: A.Expr | undefined;
    this.skipTrivia();
    if (this.at("COLON")) {
      this.advance();
      type = this.parseTypeNode();
    }
    this.skipTrivia();
    if (this.at("ASSIGN")) {
      this.advance();
      value = this.parseExpr();
    }
    if (!type && !value) {
      this.diag.error({
        code: Code.ParseError, phase: "parser",
        message: `变量 '${name.value}' 必须提供类型标注或初始值`,
        span: this.span(name),
        hints: ["var 声明无初始值时需要类型，例如 var count: Int"],
      });
    }
    return {
      kind: "let", name: name.value, mutable, type, value,
      span: mergeSpan(this.span(kw), this.lastTokSpan()),
    };
  }

  private parseReturn(): A.ReturnStmt {
    const kw = this.advance();
    this.skipTrivia();
    if (this.at("NEWLINE", "DEDENT", "EOF", "RPAREN")) {
      return { kind: "return", span: this.span(kw) };
    }
    const value = this.parseExpr();
    return { kind: "return", value, span: mergeSpan(this.span(kw), value.span) };
  }

  private parseIf(): A.IfStmt {
    const kw = this.advance();
    const cond = this.parseExpr();
    this.expect("COLON");
    const body = this.parseBlock();
    const branches = [{ cond, body, span: mergeSpan(this.span(kw), this.lastTokSpan()) }];
    let elseBody: A.Stmt[] | undefined;
    this.consumeNewlines();
    while (this.at("ELIF")) {
      const elif = this.advance();
      const c = this.parseExpr();
      this.expect("COLON");
      const b = this.parseBlock();
      branches.push({ cond: c, body: b, span: mergeSpan(this.span(elif), this.lastTokSpan()) });
      this.consumeNewlines();
    }
    if (this.at("ELSE")) {
      this.advance();
      this.expect("COLON");
      elseBody = this.parseBlock();
    }
    return { kind: "if", branches, elseBody, span: this.span(kw) };
  }

  private parseWhile(): A.WhileStmt {
    const kw = this.advance();
    const cond = this.parseExpr();
    this.expect("COLON");
    const body = this.parseBlock();
    return { kind: "while", cond, body, span: mergeSpan(this.span(kw), this.lastTokSpan()) };
  }

  private parseFor(): A.ForStmt {
    const kw = this.advance();
    let parallel = false;
    if (kw.kind === "PARALLEL") {
      parallel = true;
      this.expect("FOR");
    }
    const target = this.expect("IDENT", "循环变量");
    this.expect("IN");
    const iter = this.parseExpr();
    this.expect("COLON");
    const body = this.parseBlock();
    return {
      kind: "for", target: target.value, iter, body, parallel,
      span: mergeSpan(this.span(kw), this.lastTokSpan()),
    };
  }

  private parsePattern(): A.Pattern {
    const t = this.peek();
    if (t.kind === "IDENT" && t.value === "_") {
      this.advance();
      return { kind: "pat_wildcard", span: this.span(t) };
    }
    const e = this.parsePostfix();
    return { kind: "pat_lit", value: e, span: e.span };
  }

  private parseMatchClauses(): A.MatchClause[] {
    // 已消费 MATCH/scratch/COLON，当前应在 NEWLINE 之后、INDENT 之上
    this.expect("NEWLINE", "换行后的 match 分支块");
    this.expect("INDENT", "match 分支缩进块");
    const clauses: A.MatchClause[] = [];
    while (!this.at("DEDENT", "EOF")) {
      this.skipTrivia();
      if (this.at("NEWLINE")) { this.advance(); continue; }
      const start = this.peek();
      const pattern = this.parsePattern();
      let guard: A.Expr | undefined;
      this.skipTrivia();
      if (this.at("IF")) { this.advance(); guard = this.parseExpr(); }
      this.expect("ARROW", "->");
      // -> expr（单行）；暂不支持 -> 后接缩进块
      const value = this.parseExpr();
      const clause: A.MatchClause = {
        kind: "match_clause", pattern, guard, value, body: [],
        span: mergeSpan(this.span(start), this.lastTokSpan()),
      };
      clauses.push(clause);
      this.consumeNewlines();
    }
    this.at("DEDENT") && this.advance();
    return clauses;
  }

  private parseMatchStmt(): A.MatchStmt {
    const kw = this.advance();
    const scrut = this.parseExpr();
    this.expect("COLON");
    const clauses = this.parseMatchClauses();
    return { kind: "match", scrut, clauses, span: mergeSpan(this.span(kw), this.lastTokSpan()) };
  }

  // ---------- 表达式（优先级爬升） ----------
  private parseExpr(): A.Expr {
    if (this.at("MATCH")) return this.parseMatchExpr();
    return this.parseBinary(0);
  }

  private parseMatchExpr(): A.MatchExpr {
    const kw = this.advance();
    const scrut = this.parseExpr();
    this.expect("COLON");
    const clauses = this.parseMatchClauses();
    return { kind: "match_expr", scrut, clauses, span: mergeSpan(this.span(kw), this.lastTokSpan()) };
  }

  private static PREC: Record<string, number> = {
    or: 1, and: 2,
    "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
    "+": 4, "-": 4, "%": 5, "*": 5, "/": 5,
  };

  private parseBinary(minPrec: number): A.Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const op = t.kind === "AND" ? "and" : t.kind === "OR" ? "or" :
        ["EQ", "NE", "LT", "LE", "GT", "GE", "PLUS", "MINUS", "STAR", "SLASH", "PERCENT"].includes(t.kind) ? t.value : null;
      if (!op) break;
      const prec = Parser.PREC[op];
      if (prec < minPrec) break;
      this.advance();
      const right = this.parseBinary(prec + 1);
      left = { kind: "binary", op, left, right, span: mergeSpan(left.span, right.span) };
    }
    return left;
  }

  private parseUnary(): A.Expr {
    if (this.at("NOT")) {
      const t = this.advance();
      const e = this.parseUnary();
      return { kind: "unary", op: "not", expr: e, span: mergeSpan(this.span(t), e.span) };
    }
    if (this.at("MINUS")) {
      const t = this.advance();
      const e = this.parseUnary();
      return { kind: "unary", op: "-", expr: e, span: mergeSpan(this.span(t), e.span) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): A.Expr {
    let e = this.parsePrimary();
    for (;;) {
      this.skipTrivia();
      if (this.at("DOT")) {
        const dot = this.advance();
        // .await 关键字
        if (this.peek().value === "await") {
          const aw = this.advance();
          e = { kind: "await", expr: e, span: mergeSpan(e.span, this.span(aw)) };
          continue;
        }
        const name = this.expect("IDENT", "字段/方法名");
        e = { kind: "field", obj: e, name: name.value, span: mergeSpan(e.span, this.span(name)) };
        void dot;
        continue;
      }
      if (this.at("LPAREN")) {
        const lp = this.advance();
        const args: A.CallArg[] = [];
        this.skipTrivia();
        if (!this.at("RPAREN")) {
          for (;;) {
            this.skipTrivia();
            let named: string | undefined;
            const first = this.peek();
            // 具名实参：ident '='（注意不要与 == 混淆）
            if (first.kind === "IDENT" && this.toks[this.i + 1]?.kind === "ASSIGN") {
              this.advance(); this.advance();
              named = first.value;
            }
            const value = this.parseExpr();
            args.push({
              kind: "call_arg", name: named, value,
              span: mergeSpan(this.span(first), value.span),
            });
            this.skipTrivia();
            if (this.at("COMMA")) { this.advance(); continue; }
            break;
          }
        }
        const rp = this.expect("RPAREN");
        e = { kind: "call", callee: e, args, span: mergeSpan(e.span, this.span(rp)) };
        continue;
      }
      if (this.at("LBRACK")) {
        const lb = this.advance();
        const idx = this.parseExpr();
        const rb = this.expect("RBRACK");
        e = { kind: "index", obj: e, index: idx, span: mergeSpan(e.span, this.span(rb)) };
        continue;
      }
      if (this.at("QM")) {
        const q = this.advance();
        e = { kind: "try", expr: e, span: mergeSpan(e.span, this.span(q)) };
        continue;
      }
      break;
    }
    return e;
  }

  private parsePrimary(): A.Expr {
    const t = this.peek();
    switch (t.kind) {
      case "INT": {
        this.advance();
        return { kind: "int", value: parseInt(t.value.replace(/_/g, ""), 10), raw: t.value, span: this.span(t) };
      }
      case "FLOAT": {
        this.advance();
        return { kind: "float", value: parseFloat(t.value.replace(/_/g, "")), raw: t.value, span: this.span(t) };
      }
      case "STRING": {
        this.advance();
        return { kind: "str", value: parseStringRaw(t.value), raw: t.value, span: this.span(t) };
      }
      case "TRUE": this.advance(); return { kind: "bool", value: true, span: this.span(t) };
      case "FALSE": this.advance(); return { kind: "bool", value: false, span: this.span(t) };
      case "NUL": this.advance(); return { kind: "null", span: this.span(t) };
      case "IDENT": {
        this.advance();
        return { kind: "ident", name: t.value, span: this.span(t) };
      }
      case "LBRACK": {
        this.advance();
        const items: A.Expr[] = [];
        this.skipTrivia();
        if (!this.at("RBRACK")) {
          for (;;) {
            items.push(this.parseExpr());
            this.skipTrivia();
            if (this.at("COMMA")) { this.advance(); this.skipTrivia(); continue; }
            break;
          }
        }
        const rb = this.expect("RBRACK");
        return { kind: "list", items, span: mergeSpan(this.span(t), this.span(rb)) };
      }
      case "LBRACE": {
        this.advance();
        const items: { key: A.Expr; value: A.Expr }[] = [];
        this.skipTrivia();
        if (!this.at("RBRACE")) {
          for (;;) {
            this.skipTrivia();
            // 键：标识符键（{alice: 90}）是字符串键的简写；否则按表达式解析
            let key: A.Expr;
            if (this.at("IDENT") && this.toks[this.i + 1]?.kind === "COLON") {
              const id = this.advance();
              key = { kind: "str", value: id.value, raw: JSON.stringify(id.value), span: this.span(id) };
            } else {
              key = this.parseExpr();
            }
            this.skipTrivia();
            this.expect("COLON");
            const value = this.parseExpr();
            items.push({ key, value });
            this.skipTrivia();
            if (this.at("COMMA")) { this.advance(); this.skipTrivia(); continue; }
            break;
          }
        }
        const rb2 = this.expect("RBRACE");
        return { kind: "dict", items, span: mergeSpan(this.span(t), this.span(rb2)) };
      }
      case "LPAREN": {
        this.advance();
        const e = this.parseExpr();
        this.expect("RPAREN");
        return e;
      }
      default: {
        this.diag.error({
          code: Code.ParseError, phase: "parser",
          message: `语法错误：意外的 token '${t.value || t.kind}'`,
          span: this.span(t),
        });
        this.advance();
        return { kind: "ident", name: "__cok_error__", span: this.span(t) };
      }
    }
  }
}

export function parseStringRaw(raw: string): string {
  // raw 包含首尾引号；仅用于 AST 语义值（代码生成直接复用 raw，转义规则与 Python 同源）
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      const n = body[i + 1];
      if (n === "n") { out += "\n"; i++; continue; }
      if (n === "t") { out += "\t"; i++; continue; }
      if (n === "r") { out += "\r"; i++; continue; }
      out += n; i++; continue;
    }
    out += ch;
  }
  return out;
}
