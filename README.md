# Chock

[中文文档](#中文文档) ｜ [English](#english)

---

<a id="中文文档"></a>

# 中文文档

## 项目简介

**Chock** 是一门面向 AI 辅助编程场景的小型语言，也是它的编译器（当前处于 Phase 0）。

- 源文件以 `.cok` 为后缀，采用缩进式语法，风格接近 Python；
- 编译器以 TypeScript 实现，通过 `chock` 命令行工具把 `.cok` 源码转译为可读的 Python 代码（`.py` / `.pyi` / `.cokmap` / JSON Schema）；
- 编译期进行类型检查与结构化诊断（诊断码 `CK0xxx ~ CK9xxx`），并通过 `Result`、可选类型 `T?`、契约锚点（`@require` / `@ensure`）等机制，把 AI 生成代码中常见的"幻觉"错误拦截在程序运行之前。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/` | 编译器源码（TypeScript） |
| `src/lexer.ts` `src/parser.ts` `src/ast.ts` | 词法分析、语法分析、AST 定义 |
| `src/checker.ts` | 类型检查与效果检查（可变性、`?` 传播等） |
| `src/codegen.ts` | Python / `.pyi` / 源映射 / JSON Schema 生成，内含 Python 运行时 |
| `src/formatter.ts` | 代码格式化器（`chock fmt`） |
| `src/render.ts` `src/diag.ts` `src/span.ts` | 诊断渲染、诊断收集、源码位置 |
| `src/driver.ts` `src/index.ts` | 编译驱动器与 CLI 入口 |
| `examples/` | 示例程序：`01` ~ `11` 为 11 个合法示例，`errors/` 为 4 个错误样本 |
| `DeepMove-技术设计文档-v0.1.md` | 技术设计文档 |
| `package.json` `tsconfig.json` | Node 工程与 TypeScript 配置 |

> `dist/`（编译器编译产物）与 `out/`（示例构建产物）均由构建命令生成，不纳入版本管理。

## 快速开始

环境要求：Node.js >= 18，运行生成产物需要 Python 3。

```bash
# 安装依赖并编译编译器
npm install
npm run build

# 类型检查（检查整个 examples 目录）
node dist/index.js check examples

# 构建某个示例 → 产物输出到 out/
node dist/index.js build examples/01_hello.cok

# 运行生成的 Python 程序
py out/01_hello.py
```

### CLI 命令

```
chock check [路径] [--json]              类型检查 + 锚点校验，输出结构化诊断
chock build [路径] [--out out]           转译为 Python（.py/.pyi/.cokmap/schema）
chock fmt   [路径] [--apply]             格式化（默认只检查不写盘）
chock version                            打印版本
```

退出码：`0` 成功；`1` 存在 error 级诊断；`2` 用法错误。

## Chock 语法介绍（中文）

### 1. 模块与注释

每个文件以 `module` 声明开头；`#` 之后为行注释；代码块依靠缩进（通常 4 个空格）表示，没有花括号与分号。

```chock
module hello
# 这是一行注释
```

### 2. 基本类型与变量

- 基本类型：`Int`、`Float`、`String`、`Bool`、`Unit`；字面量 `true` / `false` / `null`。
- `let` 声明不可变变量，`var` 声明可变变量；支持 `+=` 等复合赋值。
- 双引号字符串支持 `{表达式}` 插值；单引号字符串为普通字符串。

```chock
let name = "小明"
var count = 0
count += 1
let msg = "你好，{name}，计数 {count}"
```

### 3. 函数

`fn` 定义函数，参数与返回值都需要显式类型；`async fn` 定义异步函数。

```chock
fn add(a: Int, b: Int) -> Int:
    return a + b

async fn load(id: Int) -> Result[String, Error]:
    ...
```

### 4. 记录（type）与枚举（enum）

`type` 声明记录类型，字段可带默认值；`enum` 声明枚举，成员用逗号分隔，以 `枚举名.成员` 访问。使用关键字参数构造记录。

```chock
enum Plan:
    free,
    pro,
    team

type User:
    id: Int
    name: String
    plan: Plan = Plan.free

let u = User(id = 1, name = "小明")
```

### 5. 控制流

支持 `if` / `elif` / `else`、`while`、`for ... in ...`。

```chock
if n % 15 == 0:
    print("FizzBuzz")
elif n % 3 == 0:
    print("Fizz")
else:
    print("{n}")

while count < 10:
    count += 1

for x in range(3):
    print("{x}")
```

### 6. match 表达式

`match` 是表达式，每个分支写作 `模式 -> 值`，`_` 为通配分支。

```chock
let rate = match plan:
    "pro" -> 0.9
    "team" -> 0.8
    _ -> 1.0
```

### 7. 集合

- `List[T]`：方括号列表字面量，如 `[1, 2, 3]`；
- `Dict[K, V]`：花括号字典，如 `{"alice": 90}`；
- 常用操作：`len(xs)`、`xs[0]`、`append`、`pop`、`dict.get`、`dict.keys()` 等。

```chock
let nums = [1, 2, 3]
let scores: Dict[String, Int] = {"alice": 90, "bob": 80}
```

### 8. 可选类型 T?

类型后加 `?` 表示可空；通过 `!= null` 判断后，编译器会将其收窄为非空类型。

```chock
type Profile:
    nickname: String? = null

if p.nickname != null:
    print("{p.nickname}")
```

### 9. Result 与错误传播

`Result[T, E]` 表示可能失败的计算，取值 `Ok` / `Err`；后缀 `?` 会在失败时提前返回错误（传播），成功时取出内部值；异步调用写作 `.await?`。用 `is_ok` / `is_err` 判断，成功后取 `.value`，失败后取 `.error`。

```chock
fn parse(raw: String) -> Result[User, Error]:
    return User.parse(raw)

async fn load(id: Int) -> Result[User, Error]:
    let raw = http.get("https://example.com/{id}").await?
    return User.parse(raw)?
```

### 10. 模块导入

`import std/路径` 导入标准库，以末级名称调用。

```chock
import std/http

let page = http.get("https://example.com")
```

### 11. 并行循环

`parallel for` 使用线程池并行执行循环体，块结束后汇合。

```chock
parallel for x in data:
    print("{x}")
```

### 12. 契约锚点

函数上方可用 `@intent` 描述意图、`@require` 约束入参、`@ensure` 约束返回值（其中 `result` 代表返回值），契约在运行时强制执行，违约即抛出错误。

```chock
@intent "阶乘：输入非负，结果不小于 1"
@require n >= 0
@ensure result >= 1
fn factorial(n: Int) -> Int:
    ...
```

### 13. Schema 优先

每个 `type` 在构建时都会生成 JSON Schema；记录类型自带 `parse` 方法，可在运行时按 Schema 校验 JSON 数据。

```chock
let r = Summary.parse('{"title": "周报", "points": ["完成A"]}')
if is_ok(r):
    print("标题：{r.value.title}")
else:
    print("解析失败：{r.error.message}")
```

## 许可证

Apache-2.0

---

<a id="english"></a>

# English

## Overview

**Chock** is a small programming language designed for AI-assisted coding, together with its compiler (currently at Phase 0).

- Source files use the `.cok` extension and an indentation-based syntax similar to Python.
- The compiler is implemented in TypeScript. The `chock` CLI transpiles `.cok` sources into readable Python (`.py` / `.pyi` / `.cokmap` / JSON Schema).
- It performs static type checking with structured diagnostics (`CK0xxx` ~ `CK9xxx`). Together with `Result`, the optional type `T?`, and contract anchors (`@require` / `@ensure`), it catches common "hallucination" errors in AI-generated code before the program runs.

## Project Layout

| Path | Description |
| --- | --- |
| `src/` | Compiler source code (TypeScript) |
| `src/lexer.ts` `src/parser.ts` `src/ast.ts` | Lexer, parser, and AST definitions |
| `src/checker.ts` | Type and effect checking (mutability, `?` propagation, etc.) |
| `src/codegen.ts` | Python / `.pyi` / source map / JSON Schema generation; embeds the Python runtime |
| `src/formatter.ts` | Code formatter (`chock fmt`) |
| `src/render.ts` `src/diag.ts` `src/span.ts` | Diagnostic rendering, collector, and source spans |
| `src/driver.ts` `src/index.ts` | Build driver and CLI entry point |
| `examples/` | Sample programs: `01` – `11` are valid examples; `errors/` contains 4 error samples |
| `DeepMove-技术设计文档-v0.1.md` | Technical design document |
| `package.json` `tsconfig.json` | Node and TypeScript configuration |

> `dist/` (compiler build output) and `out/` (example build output) are generated and excluded from version control.

## Quick Start

Requirements: Node.js >= 18; Python 3 is needed to run the generated output.

```bash
# Install dependencies and build the compiler
npm install
npm run build

# Type-check the examples directory
node dist/index.js check examples

# Build one example into out/
node dist/index.js build examples/01_hello.cok

# Run the generated Python program
py out/01_hello.py
```

### CLI Commands

```
chock check [path] [--json]              Type-check and validate anchors; emit structured diagnostics
chock build [path] [--out out]           Transpile to Python (.py/.pyi/.cokmap/schema)
chock fmt   [path] [--apply]             Format code (check-only by default)
chock version                            Print version
```

Exit codes: `0` success; `1` error-level diagnostics; `2` usage error.

## Chock Language Syntax (English)

### 1. Modules and Comments

Every file starts with a `module` declaration. Text after `#` is a line comment. Blocks are denoted by indentation (typically 4 spaces) — no braces or semicolons.

```chock
module hello
# This is a comment
```

### 2. Primitive Types and Variables

- Primitives: `Int`, `Float`, `String`, `Bool`, `Unit`; literals `true` / `false` / `null`.
- `let` declares an immutable variable, `var` a mutable one; compound assignment such as `+=` is supported.
- Double-quoted strings support `{expression}` interpolation; single-quoted strings are plain strings.

```chock
let name = "Alice"
var count = 0
count += 1
let msg = "Hello {name}, count {count}"
```

### 3. Functions

`fn` defines a function with explicitly typed parameters and return type; `async fn` defines an asynchronous function.

```chock
fn add(a: Int, b: Int) -> Int:
    return a + b

async fn load(id: Int) -> Result[String, Error]:
    ...
```

### 4. Records (type) and Enums (enum)

`type` declares a record whose fields may have default values. `enum` declares a comma-separated enumeration; members are accessed as `Name.member`. Records are constructed with keyword arguments.

```chock
enum Plan:
    free,
    pro,
    team

type User:
    id: Int
    name: String
    plan: Plan = Plan.free

let u = User(id = 1, name = "Alice")
```

### 5. Control Flow

`if` / `elif` / `else`, `while`, and `for ... in ...` are supported.

```chock
if n % 15 == 0:
    print("FizzBuzz")
elif n % 3 == 0:
    print("Fizz")
else:
    print("{n}")

while count < 10:
    count += 1

for x in range(3):
    print("{x}")
```

### 6. Match Expressions

`match` is an expression. Each arm is written as `pattern -> value`; `_` is the wildcard arm.

```chock
let rate = match plan:
    "pro" -> 0.9
    "team" -> 0.8
    _ -> 1.0
```

### 7. Collections

- `List[T]`: bracket literals such as `[1, 2, 3]`.
- `Dict[K, V]`: brace literals such as `{"alice": 90}`.
- Common operations: `len(xs)`, `xs[0]`, `append`, `pop`, `dict.get`, `dict.keys()`.

```chock
let nums = [1, 2, 3]
let scores: Dict[String, Int] = {"alice": 90, "bob": 80}
```

### 8. Optional Types T?

A `?` suffix makes a type nullable. After a `!= null` check, the compiler narrows it to the non-null type.

```chock
type Profile:
    nickname: String? = null

if p.nickname != null:
    print("{p.nickname}")
```

### 9. Result and Error Propagation

`Result[T, E]` represents a fallible computation with values `Ok` / `Err`. The postfix `?` returns early on error and unwraps the value on success; asynchronous calls are written as `.await?`. Use `is_ok` / `is_err` to inspect, then access `.value` or `.error`.

```chock
fn parse(raw: String) -> Result[User, Error]:
    return User.parse(raw)

async fn load(id: Int) -> Result[User, Error]:
    let raw = http.get("https://example.com/{id}").await?
    return User.parse(raw)?
```

### 10. Imports

`import std/path` imports a standard-library module; call functions through its leaf name.

```chock
import std/http

let page = http.get("https://example.com")
```

### 11. Parallel Loops

`parallel for` runs the loop body concurrently on a thread pool and joins at the end of the block.

```chock
parallel for x in data:
    print("{x}")
```

### 12. Contract Anchors

Above a function, `@intent` states the intent, `@require` constrains the inputs, and `@ensure` constrains the return value (`result` denotes it). Contracts are enforced at runtime and raise on violation.

```chock
@intent "Factorial: non-negative input, result no less than 1"
@require n >= 0
@ensure result >= 1
fn factorial(n: Int) -> Int:
    ...
```

### 13. Schema First

Every `type` produces a JSON Schema at build time. Records also provide a `parse` method that validates JSON data against the schema at runtime.

```chock
let r = Summary.parse('{"title": "Weekly", "points": ["Done A"]}')
if is_ok(r):
    print("Title: {r.value.title}")
else:
    print("Parse failed: {r.error.message}")
```

## License

Apache-2.0
