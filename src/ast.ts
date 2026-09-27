// AST 节点定义（保留全部 span；锚点作为函数声明的一等成员）
import type { Span } from "./span.js";

export interface Node {
  span: Span;
}

// ---------- 类型标注 ----------
export interface TypeNode extends Node {
  kind: "type";
  name: string; // Int/Float/String/Bool/Unit/List/Dict/Result/用户类型
  args: TypeNode[]; // 泛型实参
  optional: boolean; // T?
}

// ---------- 声明 ----------
export interface Param extends Node {
  kind: "param";
  name: string;
  type: TypeNode;
  default?: Expr;
}

export interface Decorator extends Node {
  kind: "decorator";
  name: string; // intent / require / ensure
  text?: string; // @intent "..."
  expr?: Expr; // @require <bool expr>
}

export interface EnumDecl extends Node {
  kind: "enum";
  name: string;
  members: string[];
}

export interface TypeField extends Node {
  kind: "field";
  name: string;
  type: TypeNode;
  default?: Expr;
}

export interface TypeDecl extends Node {
  kind: "type_decl";
  name: string;
  fields: TypeField[];
}

export interface FnDecl extends Node {
  kind: "fn";
  name: string;
  async: boolean;
  params: Param[];
  returnType: TypeNode;
  retExplicit: boolean; // 源码是否显式写了 -> T
  body: Stmt[];
  decorators: Decorator[];
}

export interface ImportDecl extends Node {
  kind: "import";
  path: string; // std/http
}

export interface ModuleDecl extends Node {
  kind: "module";
  name: string;
}

export type Decl = EnumDecl | TypeDecl | FnDecl;

export interface Program extends Node {
  kind: "program";
  module?: ModuleDecl;
  imports: ImportDecl[];
  decls: Decl[];
  header: string[]; // module 之前的文件头注释（fmt 保留）
  // 节点 → 其前导整行注释；formatter 按此保留注释，避免 AI 上下文丢失
  comments: Map<Node, string[]>;
}

// ---------- 语句 ----------
export interface LetStmt extends Node {
  kind: "let";
  name: string;
  mutable: boolean; // let=false, var=true
  type?: TypeNode;
  value?: Expr;
}

export interface ReturnStmt extends Node {
  kind: "return";
  value?: Expr;
  wrapOk?: boolean; // checker 标记：Result 函数返回裸 T 时，codegen 自动包 Ok(...)
}

export interface IfStmt extends Node {
  kind: "if";
  branches: { cond: Expr; body: Stmt[]; span: Span }[];
  elseBody?: Stmt[];
}

export interface WhileStmt extends Node {
  kind: "while";
  cond: Expr;
  body: Stmt[];
}

export interface ForStmt extends Node {
  kind: "for";
  target: string;
  iter: Expr;
  body: Stmt[];
  parallel: boolean;
}

export interface MatchClause extends Node {
  kind: "match_clause";
  pattern: Pattern;
  guard?: Expr;
  body: Stmt[]; // 语句形式
  value?: Expr; // 表达式形式 -> expr
}

export interface MatchStmt extends Node {
  kind: "match";
  scrut: Expr;
  clauses: MatchClause[];
}

export interface AssignStmt extends Node {
  kind: "assign";
  target: Expr; // Ident / Field / Index
  op: "=" | "+=" | "-=" | "*=" | "/=";
  value: Expr;
}

export interface ExprStmt extends Node {
  kind: "expr_stmt";
  expr: Expr;
}

export type Stmt =
  | LetStmt | ReturnStmt | IfStmt | WhileStmt | ForStmt | MatchStmt
  | AssignStmt | ExprStmt;

// ---------- 模式 ----------
export type Pattern =
  | { kind: "pat_wildcard"; span: Span }
  | { kind: "pat_lit"; value: Expr; span: Span } // 字面量 / Plan.pro 枚举成员
  | { kind: "pat_bind"; name: string; span: Span };

// ---------- 表达式 ----------
export interface IntLit extends Node { kind: "int"; value: number; raw: string }
export interface FloatLit extends Node { kind: "float"; value: number; raw: string }
export interface StrLit extends Node { kind: "str"; value: string; raw: string }
export interface BoolLit extends Node { kind: "bool"; value: boolean }
export interface NullLit extends Node { kind: "null" }
export interface Ident extends Node { kind: "ident"; name: string }
export interface ListLit extends Node { kind: "list"; items: Expr[] }
export interface DictLit extends Node { kind: "dict"; items: { key: Expr; value: Expr }[] }
export interface Binary extends Node { kind: "binary"; op: string; left: Expr; right: Expr }
export interface Unary extends Node { kind: "unary"; op: string; expr: Expr }
export interface CallArg extends Node { kind: "call_arg"; name?: string; value: Expr }
export interface Call extends Node { kind: "call"; callee: Expr; args: CallArg[] }
export interface FieldExpr extends Node { kind: "field"; obj: Expr; name: string }
export interface Index extends Node { kind: "index"; obj: Expr; index: Expr }
export interface AwaitExpr extends Node { kind: "await"; expr: Expr }
export interface TryExpr extends Node { kind: "try"; expr: Expr } // expr?
export interface MatchExpr extends Node { kind: "match_expr"; scrut: Expr; clauses: MatchClause[] }

export type Expr =
  | IntLit | FloatLit | StrLit | BoolLit | NullLit | Ident | ListLit | DictLit
  | Binary | Unary | Call | FieldExpr | Index | AwaitExpr | TryExpr | MatchExpr;
