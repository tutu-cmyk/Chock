# DeepMove 技术设计文档 v0.1（草案）

| 项目   | 内容                                              |
| ---- | ----------------------------------------------- |
| 文档名称 | DeepMove 语言与编译器 · 初步技术设计文档                      |
| 版本   | v0.1（草案，未经评审）                                   |
| 日期   | 2026-09-26                                      |
| 定位   | 面向 AI Agent 工作流的高级编程语言 + 工具链                    |
| 决策锁  | 免费、快速、独立开发（1 人）可交付                              |
| 状态   | 已完成：市场分析 / 定位 / 语言设计 / 编译器架构 / 路线图；待决：实现语言、开源策略 |

***

## 1. 执行摘要

**一句话定位**：DeepMove 是一门 Python 亲缘的静态可验证高级语言，它把「编译器」重新定义为 **AI Agent 的确定性验证层**——让 AI 写出来的代码在编译期被结构化地拒绝、定位、修复，而不是在运行时才发现。

**三个核心判断**：

1. 2026 年 AI 编程的瓶颈已从「人写得慢」转移到「AI 写得不可信 + token 贵 + 长会话漂移」。语言层的价值正在从「表达力」迁移到「可验证性」。
2. 现有语言在「AI 友好 × 高性能」象限是空白：Python 占了 AI 友好但性能差，Rust/C++ 占性能但 AI 难写难改，Mojo 卡在中间（0.4% 使用率）。
3. 独立开发者不应直接写完整编译器。**正确路径是 Phase 0 先做「DeepMove → Python 转译器 + 结构化诊断」，用 2-4 周验证核心价值，再决定是否上原生后端。**

**推荐路线（决策锁校验结论）**：方向成立，交付形态降级。先用转译器 MVP 验证「幻觉拦截率」与「token 节省」两个可量化指标，数据达标后再投入 MLIR/原生后端。

***

## 2. 市场分析

### 2.1 2026 编程语言格局

| 语言         | 核心优势                                 | AI 时代的结构性短板                           | 关键数据                                   |
| ---------- | ------------------------------------ | ------------------------------------- | -------------------------------------- |
| Python     | 生态垄断（PyTorch / HF / LangChain / JAX） | 解释执行慢 10-100×；GIL 限制并行；基线内存 150-400MB | 30 万+ AI/ML 包；GitHub 使用率第一             |
| TypeScript | 类型护栏 + 全栈统一；AI 训练语料丰富                | 运行时性能一般；非数值计算场景                       | 2025 年 71% 新 Web 项目首选 TS               |
| Go         | 原生并发（goroutine），Agent 编排友好           | AI 库生态薄；数值计算弱                         | Agent 框架侧增长最快                          |
| Rust       | 内存安全 + C++ 级性能 + 无 GC                | **AI 生成质量差**（借用检查器对 LLM 不友好）；人才供给不足   | 需求 3 年 +200%，人才仅 +80%；薪资溢价 20-35%      |
| C++        | 推理引擎 / 内核层事实标准                       | 学习曲线陡；开发速度慢                           | TensorRT / libtorch 底层                 |
| Mojo       | Python 式语法 + MLIR 异构 + 原生性能          | 见 2.3 失败教训                            | 2026-08 发布 1.0，SO 使用率仅 0.4%（向往度 49.3%） |

### 2.2 五类市场痛点

| 编号 | 痛点                | 表现                                           | 量化证据                                                                     |
| -- | ----------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| P1 | **Python 性能/部署墙** | CPU 密集逻辑被迫下沉到 C++/CUDA；Serverless / 边缘部署内存吃紧 | 慢 10-100×；内存 150-400MB vs Rust 15-50MB；FastAPI 12k RPS vs Actix 183k RPS |
| P2 | **AI 幻觉无验证层**     | LLM 编造不存在的 API / 变量 / 模块，动态语言无人拦截            | 前沿模型幻觉率 10-20%，永不归零                                                      |
| P3 | **Token 成本税**     | 冗长语法与糟糕架构吃掉上下文窗口                             | 混乱代码库使 Agent 破坏率高 15-30%；「命名即提示词」                                        |
| P4 | **长会话漂移**         | 上下文超限后 AI 遗忘约束、改错变量名、架构走样                    | 需反复重述上下文，算力与人力双重浪费                                                       |
| P5 | **双语言栈割裂**        | Python 胶水 + Rust/C++ 内核，团队与心智成本翻倍            | Rust 人才缺口见 2.1                                                           |

### 2.3 竞品深度剖析：Mojo（最重要的前车之鉴）

**事实基线**

- 作者：Chris Lattner（LLVM / Clang / Swift / MLIR 之父）+ Tim Davis，公司 Modular。
- 2026-08-11 发布 1.0，编译器与工具链全面开源（Apache 2.0 + LLVM 例外）；2026 年中 Modular 被 Qualcomm 收购。
- 技术栈：静态类型 + 仿射类型系统（借用检查器，无 GC）+ MLIR（CPU/GPU/TPU/ASIC 一套代码）+ 一等 SIMD + `parallelize`。
- 实测：EWMA 递推 177×、蒙特卡洛期权定价 24.6×；**但在点积这类已被 BLAS 调优的算子上下风于 NumPy**。

**必须吸收的失败教训**

| 教训              | 说明                                     | DeepMove 对策                        |
| --------------- | -------------------------------------- | ---------------------------------- |
| 「Python 超集」承诺破产 | 2026-03 无限期推迟，现有 Python 代码无法直接编译为 Mojo | **从第一天就不做超集**，只做「互操作 + 语法亲缘」       |
| CPython 互操作边界昂贵 | 需在本地拉起 CPython 运行时 + 数据封送，仅适合粗粒度计算块    | Phase 0 直接**转译为 Python 源码**，边界成本为零 |
| 生态冷启动           | 无自动迁移路径、无行业协议原生库                       | 复用 Python 生态（stdlib 只做 AI 工作流增量）   |
| 闭源 → 开源摇摆       | 社区信任成本高                                | **Day 1 开源**                       |

**结论**：Mojo 验证了「Python 语法 + 原生性能」需求真实（向往度 49.3%），也证明了**生态与心智成本才是新语言的真正杀手**，而非编译器技术。DeepMove 不能走同一条路——它必须在 Mojo 不做的维度（AI Agent 可验证性）上建立差异。

### 2.4 市场空白与机会窗口

- **空白象限**：AI 友好 × 高性能（右上）无人占据。
- **窗口期**：「AI-Agent 原生语言」目前只有学术讨论（AI 理解效率作为第三设计轴）和零星实验项目，**尚无成型赢家**，先发叙事价值高。
- **需求信号**：84% 开发者已在用或计划用 AI 编程工具（2025 SO 调查）；企业 Agent 编排（LangChain / CrewAI / AutoGen）几乎全部 Python 原生，性能与可靠性 complaints 正在积累。

***

## 3. 目标用户与场景

### 3.1 用户画像

| 画像                        | 特征                                                  | 核心诉求                         |
| ------------------------- | --------------------------------------------------- | ---------------------------- |
| **A. AI Agent 工程师**（首要）   | 用 Claude Code / Cursor / Codex 批量产出代码，维护 Agent 编排系统 | 让 AI 产出一次就对；减少返工轮次与 token 花费 |
| **B. 独立开发者 / 小团队**        | 1-3 人，快速交付，无专职 QA                                   | 一人也能保证正确性；不想维护双语言栈           |
| **C. AI Infra / 推理服务工程师** | Python 写编排、C++ 写内核                                  | 一处语法覆盖胶水与热路径，且可被 AI 安全修改     |

### 3.2 核心场景（Job Stories）

1. 「当我让 AI Agent 改一个 3 万行的服务时，我希望编译期就能把**不存在的 API、越界的类型、被破坏的架构约束**拦下来，而不是靠 Code Review 碰运气。」
2. 「当我用 Agent 迭代第 20 轮时，我希望**业务意图被写进代码并被编译器守护**，防止 AI 悄悄把『折扣不低于 0』这类约束改掉。」
3. 「当我要把一段 Python 热路径提速 20× 时，我希望**只改少量标注**就能编译到原生，而不是重写成 Rust。」

***

## 4. 产品定位与设计原则

### 4.1 三轴模型

语言设计传统上有两轴：**人类可读性 × 机器执行效率**。2026 年新增第三轴：

```
                人类可读性
                    ↑
                    |
   AI 理解效率 ←----+----→ 机器执行效率
   (LLM-friendliness)
```

DeepMove 的优化目标是**三轴同时不低**，优先级为：AI 理解效率 > 人类可读性 > 机器执行效率（Phase 0-1），Phase 2 后补足执行效率。

### 4.2 五条设计公理

1. **可验证优先于灵活**：任何能被编译期判定的错误，不允许留到运行时。
2. **错误必须机器可读**：诊断信息的一等公民是 JSON，人类可读文本只是它的渲染结果。
3. **语法亲缘 Python**：缩进语法、常见关键字保持一致，直接继承 LLM 的海量训练语料。
4. **token 精简**：同样的语义用更少的 token 表达（目标：比等价 Python 少 20-35%）。
5. **增量采用**：可只迁移一个模块，与 Python 混用，迁移成本可控。

***

## 5. 语言设计

### 5.1 设计坐标

| 维度            | 选择                                     | 理由                  |
| ------------- | -------------------------------------- | ------------------- |
| 语法风格          | Python 亲缘（缩进块、`fn` / `type` / `match`） | 继承 LLM 语料，降低学习成本    |
| 类型系统          | 静态 + 渐进（局部可推断，公共签名强制标注）                | 幻觉护栏；P2 对策          |
| 空值            | 默认非空，`T?` 显式可选                         | 消除 NPE 类幻觉          |
| 错误            | `Result[T, E]` + `?` 传播，无异常            | 强制 AI 处理失败分支        |
| 可变性           | `let` 不可变 / `var` 可变                   | LLM 易推理副作用          |
| 内存（Phase 0-1） | 托管（引用计数 / 后续 GC），无借用检查                 | 降低 AI 生成门槛（Rust 教训） |
| 内存（Phase 2+）  | 可选所有权标注 `@owned` / 借用检查（渐进开启）          | 性能与 AI 友好可切换        |
| 并发            | `async` + 结构化并发；`parallel for` 数据并行    | Agent 编排与数值计算双覆盖    |
| 异构            | Phase 3：`@target gpu` 标注 + MLIR 后端     | 远期，不进 MVP           |

### 5.2 语法总览（示例）

```deepmove
# 文件：src/billing.dm
module billing

import std/http
import std/ai

enum Plan: free, pro, team

type User:
    id: Int
    name: String
    plan: Plan = Plan.free
    credits: Float = 0.0

@intent "计算用户本月应付金额：按套餐折扣，结果不为负且不超过原价"
@require amount >= 0
@ensure 0 <= result <= amount
fn bill(u: User, amount: Float) -> Float:
    let rate = match u.plan:
        Plan.pro  -> 0.9
        Plan.team -> 0.8
        _         -> 1.0
    return max(amount * rate, 0.0)

async fn load_user(id: Int) -> Result[User, Error]:
    let raw = http.get("/users/{id}").await?
    return User.parse(raw)?

fn main() -> Result[Unit, Error]:
    let u = load_user(42).await?
    parallel for item in orders:          # 数据并行，自动向量化/多线程
        print(bill(u, item.amount))
    return Ok(Unit)
```

### 5.3 差异化核心 A：意图锚点（Intent Anchor）

**问题**：长会话中 AI 会漂移——悄悄删掉边界检查、改坏不变量。

**方案**：把业务意图写成**一等语法**，编译器在每次编译（含 AI 每次修改后）校验其成立。

```deepmove
@intent "折扣计算"
@require amount >= 0
@ensure  0 <= result <= amount
@ensure  result != null
fn bill(u: User, amount: Float) -> Float: ...
```

- `@intent`：自然语言意图，原样进入诊断信息与 Agent 上下文（防止漂移的语义锚）。
- `@require` / `@ensure`：编译期可静态证明则证明；不可证明则自动生成运行时断言 + 属性测试桩。
- **违反锚点的编译错误优先级最高**（诊断码 `DM0xxx`），Agent 收到后必须修复而非绕过。

### 5.4 差异化核心 B：类型驱动的 AI 调用（Schema-First）

**问题**：LLM 返回自由文本，解析与校验全靠手写胶水，是 Agent 应用的重灾区。

**方案**：DeepMove 类型即 JSON Schema，LLM 输出直接绑定类型系统。

```deepmove
type Summary:
    title: String
    points: List[String] { max_len: 5 }

fn summarize(doc: String) -> Summary:
    return ai.extract(doc, into: Summary, model: "qwen-max")
```

编译器/运行时自动：由 `Summary` 生成 JSON Schema → 约束解码 → 校验失败自动重试（次数可配）→ 类型安全返回。等价于把「幻觉」关进类型笼子。

### 5.5 差异化核心 C：结构化诊断（详见第 7 节）

***

## 6. 编译器架构

### 6.1 流水线

```
源码 .dm
   │
   ├─[1] Lexer / Parser ──────→ AST（保留全部 span 与注释/锚点）
   │
   ├─[2] 语义分析 + 类型检查 ─→ Typed AST + 符号表
   │        └─ 锚点（@require/@ensure）验证 / 生成运行时断言
   │
   ├─[3] 诊断中心 ────────────→ 结构化诊断 JSON（一等产物）
   │
   ├─[4] IR  lowering ────────→ DeepMove IR（SSA，显式效果标注）
   │
   └─[5] 后端
         ├─ Phase 0：Python 源码后端（转译，零互操作成本）
         ├─ Phase 2：LLVM / C 后端（原生性能）
         └─ Phase 3：MLIR 后端（CPU/GPU/TPU 异构）
```

### 6.2 Phase 0 转译后端（MVP 关键决策）

- **输入**：DeepMove 子集（函数 / 类型 / 控制流 / Result / 基础 async）。
- **输出**：可读的 Python 3.11+ 源码 + `.pyi` 类型存根 + 源映射（source map）。
- **锚点处理**：`@require` / `@ensure` 转译为函数入口/出口的断言代码。
- **AI 调用**：`ai.extract` 转译为 std 运行时调用（Python 实现），Schema 由类型生成。
- **收益**：Day 1 复用 30 万+ Python 包；调试栈可读；迁移成本≈0。
- **代价**：性能等于 Python——**Phase 0 明确不承诺性能**，只承诺「可验证 + 省 token」。

### 6.3 实现语言选型（待决）

| 候选          | 优势                           | 劣势        |
| ----------- | ---------------------------- | --------- |
| Rust        | 性能好、解析器生态成熟、单文件分发            | 独立开发者产能较低 |
| TypeScript  | 上手快、LSP 生态成熟、易接 MCP/Agent 工具 | 编译性能一般    |
| Python（自举前） | 最快出原型                        | 后续重写成本    |

**建议**：Phase 0-1 用 TypeScript 抢速度（LSP/MCP 生态天然契合），Phase 2 若上原生后端再以 Rust 重写前端，或用 Rust 写核心 + TS 写工具层。

### 6.4 编译产物

| 产物                 | 说明                             |
| ------------------ | ------------------------------ |
| `out/*.py`         | 转译后的 Python 源码（Phase 0）        |
| `out/*.pyi`        | 类型存根，供 Python 侧 IDE 与 mypy 使用  |
| `out/*.dmmap`      | 源映射，支持在 DeepMove 源码上断点调试       |
| `diagnostics.json` | 结构化诊断，Agent 与 CI 的一等输入         |
| `schema/*.json`    | 由类型生成的 JSON Schema（供 LLM 约束解码） |

***

## 7. 结构化诊断规范（差异化核心 C）

### 7.1 设计原则

**诊断的一等消费者是机器**。人类看到的彩色报错，只是同一份 JSON 的渲染结果。

### 7.2 Schema（v1）

```json
{
  "toolchain": "deepmove/0.1.0",
  "severity": "error",
  "code": "DM1001",
  "phase": "typecheck",
  "message": "类型不匹配：amount 声明为 Float，实参为 String",
  "human": "src/billing.dm:12:18 类型不匹配…建议：用 Float(x) 转换",
  "span": { "file": "src/billing.dm", "start": [12, 18], "end": [12, 24] },
  "symbol": "amount",
  "expected": "Float",
  "found": "String",
  "intent_ref": "INV-bill-001",
  "violated": ["@require amount >= 0"],
  "hints": [
    "amount 来自 http.get 返回值，需显式解析为数值",
    "若确需字符串，请修改 @require 或改用 RawAmount 类型"
  ],
  "fix": {
    "kind": "replace",
    "range": [[12, 18], [12, 24]],
    "text": "Float(amount)",
    "confidence": 0.86
  },
  "cost": { "tokens": 96, "chars": 312 }
}
```

### 7.3 Agent 自修复闭环

```
Agent 生成代码 → deepmove check --json
                      ↓
              diagnostics.json（含 fix + hints + intent_ref）
                      ↓
        Agent 按 confidence 应用修复 → 重新 check
                      ↓
          0 error → 提交；仍失败 → 上报人类
```

**关键约束**：诊断体积有 token 预算（默认 ≤ 120 token/条），超出则降级为摘要 + 展开指令——直接回应 P3（token 成本税）。

### 7.4 诊断码空间

| 段        | 含义                        |
| -------- | ------------------------- |
| `DM0xxx` | 意图锚点违反（最高优先级，Agent 不得绕过）  |
| `DM1xxx` | 类型错误                      |
| `DM2xxx` | 名称/作用域解析失败（幻觉 API 高发区）    |
| `DM3xxx` | 效果与所有权（未处理的 Result、可变性冲突） |
| `DM4xxx` | 并发与并行误用                   |
| `DM5xxx` | 风格与架构约束（可配置为 error/warn）  |

***

## 8. 工具链

### 8.1 CLI

| 命令                                       | 作用                               |
| ---------------------------------------- | -------------------------------- |
| `dm new`                                 | 脚手架（含 Agent 规则文件 `.dm/rules.md`） |
| `dm check --json`                        | 类型检查 + 锚点校验，输出结构化诊断              |
| `dm build --target python\|native\|wasm` | 编译/转译                            |
| `dm run`                                 | 直接运行（内含 JIT 式快速检查）               |
| `dm fix --apply`                         | 应用诊断中的 `fix` 建议（Agent 友好）        |
| `dm fmt`                                 | 格式化（保证 AI 产出风格一致）                |
| `dm schema`                              | 由类型导出 JSON Schema                |
| `dm test`                                | 运行测试 + 由 `@ensure` 自动生成的属性测试     |
| `dm migrate path/to.py`                  | Python → DeepMove 增量迁移（加标注）      |

### 8.2 LSP 能力（Phase 0 最小集）

诊断 / 悬浮类型 / 跳转定义 / 自动补全 / 重命名 / 格式化。LSP 是 Agent 接入的事实标准，**优先级高于编译器后端**。

### 8.3 MCP Server（Agent 原生入口）

暴露工具：`check_code` / `build` / `explain_error` / `apply_fix` / `migrate_snippet` / `export_schema`。\
让 DeepMove 编译能力直接被任何支持 MCP 的 Agent 调用——这是「AI 原生语言」的定义性特征。

***

## 9. 标准库规划（增量，不重复造轮子）

| 模块          | Phase | 内容                               |
| ----------- | ----- | -------------------------------- |
| `std/core`  | 0     | Option / Result / 迭代器 / 字符串 / 集合 |
| `std/ai`    | 0     | LLM 调用、Schema 约束解码、重试、token 计量   |
| `std/http`  | 1     | 客户端 + 最小服务端（Agent 服务常用）          |
| `std/agent` | 1     | 工具定义、记忆、编排原语（对标 LangChain 最小子集）  |
| `std/data`  | 2     | 列式数据结构、并行 map/reduce             |
| `std/gpu`   | 3     | 核函数与张量原语（对标 Mojo 场景）             |

原则：**凡是 Python 已有的，先做互操作；只做 AI 工作流增量。**

***

## 10. 性能目标与验收 KPI

| 类别          | 指标             | 目标                                      | 测量方法                     |
| ----------- | -------------- | --------------------------------------- | ------------------------ |
| 核心价值        | **AI 幻觉拦截率**   | ≥ 70% 的注入型错误在 `dm check` 阶段被拦截          | 构造 200 例已知幻觉样本集          |
| 核心价值        | **Agent 返工轮次** | 相对 Python 基线降低 ≥ 40%                    | 同一任务跑 Claude Code，对比修复轮数 |
| 核心价值        | **token 节省**   | 等价逻辑源码 token 减少 20-35%；单条诊断 ≤ 120 token | tiktoken 统计              |
| 工程          | 冷启动检查耗时        | 1 万行项目 < 2s（增量 < 200ms）                 | 基准仓库                     |
| 工程          | 转译正确性          | 官方测试集 100% 通过                           | CI                       |
| 性能（Phase 2） | 原生后端相对 CPython | 顺序逻辑 10-30×，并行接近 C++                    | 与 Mojo 公开基准同构 workload   |
| 采用          | MVP 后 3 个月     | GitHub Star ≥ 500、外部贡献者 ≥ 5、真实项目 ≥ 3    | 社区指标                     |

***

## 11. 路线图

| 阶段                  | 周期    | 目标            | 交付物                                                                              | 退出标准                                  |
| ------------------- | ----- | ------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| **Phase 0 · MVP**   | 2-4 周 | 转译器 + 结构化诊断   | Lexer/Parser、子集类型检查、Python 后端、JSON 诊断 v1、CLI `check/build/fmt`、10+ 示例            | 200 例幻觉样本拦截率 ≥ 50%，且能在真实 Python 项目中跑通 |
| **Phase 1 · AI 原生** | 1-2 月 | 锚点 + Agent 接入 | `@intent/@require/@ensure` 校验、`ai.extract` Schema 约束、LSP、MCP Server、`dm migrate` | Agent 返工轮次下降 ≥ 40%（实测）                |
| **Phase 2 · 原生性能**  | 3-6 月 | 性能故事          | LLVM/C 后端、结构化并发、`parallel for`、渐进所有权标注、stdlib v1                                 | 顺序逻辑 ≥ 10× CPython                    |
| **Phase 3 · 异构与生态** | 6 月+  | 规模化           | MLIR/GPU 后端、包管理器、官方文档站、社区治理                                                      | 外部贡献者 ≥ 20，真实生产项目 ≥ 10                |

**Phase 0 明确不做**：所有权/借用检查、GPU、性能承诺、包管理器、自举。

***

## 12. 风险登记册

| #  | 风险                              | 概率 | 影响 | 对策                                     |
| -- | ------------------------------- | -- | -- | -------------------------------------- |
| R1 | **生态冷启动**（Mojo 3 年才 0.4%）       | 高  | 致命 | Day 1 转译到 Python 复用生态；只切 Agent 工作流细分场景 |
| R2 | **独立开发者产能不足**                   | 高  | 高  | 严格 Phase 0 子集；用 AI Agent 自举开发；不做完整编译器  |
| R3 | 互操作/转译边界性能损耗                    | 中  | 中  | Phase 0 只服务编排层，热路径留到 Phase 2           |
| R4 | 锚点表达力不足（复杂约束无法静态证明）             | 中  | 中  | 静态证明 + 运行时断言 + 属性测试三层降级                |
| R5 | 被大厂（Modular / Anthropic / 字节）复制 | 中  | 高  | 抢占叙事与标准（诊断规范、MCP 工具协议），开源建立事实标准        |
| R6 | 模型能力跃升使「防幻觉」价值缩水                | 中  | 高  | 把价值锚定到「确定性工程」而非「补模型短板」；强化架构约束与意图守护     |
| R7 | 语法又被认为「只是 Python 加类型」           | 中  | 中  | 以可量化数据（拦截率 / token）而非语法新颖度做传播          |

***

## 13. 未决问题（Open Questions）

1. **实现语言**：TypeScript（快、LSP 生态好）还是 Rust（性能、长期）？—— 建议 Phase 0-1 TS，Phase 2 评估重写。
2. **开源策略**：何时开源？建议 Day 1 Apache 2.0（吸取 Mojo 闭源摇摆教训）。
3. **首批切入场景**：Agent 编排服务 / AI 数据管道 / 边缘推理，先打哪一个？—— 建议「Agent 编排服务」（与 A 类用户重合度最高）。
4. **是否做包管理器**：Phase 0-2 不做，直接复用 PyPI；Phase 3 再评估。
5. **`@intent`** **语义强度**：仅注释级（可忽略）还是强制级（违反即 error）？—— 建议默认强制，可按模块降级。

***

## 附录 A · 参考资料

- Modular 发布 Mojo 1.0（2026-08-11）：1.0 稳定性、Apache 2.0 开源、MLIR 异构、仿射类型系统；Qualcomm 收购 Modular。
- Mojo 现实约束：Python 超集承诺 2026-03 无限期推迟；CPython 互操作边界昂贵；Stack Overflow 2025 使用率 0.4% / 向往度 49.3%。
- AI 编程现状：84% 开发者使用或计划使用 AI 编程工具（2025 SO 调查）；前沿模型幻觉率 10-20%。
- 语言设计第三轴：AI 理解效率（LLM-friendliness）与 token 效率、verifier-friendly 语义（静态类型作为幻觉护栏）。
- 性能对照：Python vs Rust/C++ 10-100×；内存 150-400MB vs 15-50MB；FastAPI 12k RPS vs Actix 183k RPS。
- 工程实践：混乱代码库使 Agent 破坏率高 15-30%；「命名即提示词」；长会话漂移与概率循环。

## 附录 B · 术语表

| 术语                  | 含义                                                    |
| ------------------- | ----------------------------------------------------- |
| LLM-friendliness    | 语言对大模型生成/理解的友好程度（token 效率 + 可验证性）                     |
| 意图锚点（Intent Anchor） | 一等语法的业务约束声明（`@intent` / `@require` / `@ensure`），编译期守护 |
| 结构化诊断               | 面向机器消费的 JSON 报错，含精确 span、修复建议、意图引用                    |
| Schema-First AI 调用  | 由语言类型自动生成 JSON Schema，约束 LLM 输出并校验                    |
| 转译后端                | 将 DeepMove 编译为 Python 源码的输出目标（Phase 0）                |

***

*本文档为 v0.1 草案，所有数据均标注来源方向，进入 Phase 0 前需完成一次评审与一次竞品实测复核。*
