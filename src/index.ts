#!/usr/bin/env node
// chock —— Chock 编译器 CLI（Phase 0：check / build / fmt）
import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeFile, build, checkFiles, formatFile, findCokFiles } from "./driver.js";
import { renderDiagnostic } from "./render.js";

interface ParsedArgs {
  command: string;
  json: boolean;
  outDir: string;
  write: boolean;
  target: string;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const a: ParsedArgs = {
    command,
    json: false,
    outDir: "out",
    write: false,
    target: "python",
    positional: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--json") a.json = true;
    else if (t === "--apply" || t === "-w" || t === "--write") a.write = true;
    else if (t === "--out" || t === "-o") a.outDir = rest[++i] ?? "out";
    else if (t === "--target") a.target = rest[++i] ?? "python";
    else if (t.startsWith("--out=")) a.outDir = t.slice(6);
    else if (t.startsWith("--target=")) a.target = t.slice(9);
    else a.positional.push(t);
  }
  return a;
}

const HELP = `Chock 0.1.0 — AI Agent 的确定性验证层

用法:
  chock check [路径] [--json]           类型检查 + 锚点校验，输出结构化诊断
  chock build [路径] [--out out] [--target python]
                                        转译为 Python（.py/.pyi/.cokmap/schema）
  chock fmt [路径] [--apply]            格式化（默认只检查不写盘）
  chock version                         打印版本

退出码: 0 成功；1 存在 error 级诊断；2 用法错误
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

  if (args.command === "version" || args.command === "-v" || args.command === "--version") {
    process.stdout.write("chock/0.1.0\n");
    return;
  }
  if (!args.command || args.command === "help" || args.command === "-h" || args.command === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const targets = args.positional.length ? args.positional : ["."];
  for (const t of targets) {
    if (!fs.existsSync(t)) {
      process.stderr.write(`路径不存在: ${t}\n`);
      process.exit(2);
    }
  }

  if (args.command === "check") {
    const results = checkFiles(targets);
    const all = results.flatMap((r) => r.diag.items);
    if (args.json) {
      process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    } else {
      for (const d of all) process.stdout.write(renderDiagnostic(d, useColor, cwd) + "\n\n");
      const errs = all.filter((d) => d.severity === "error").length;
      const warns = all.length - errs;
      if (!all.length) process.stdout.write(`检查通过：${results.length} 个文件，0 error\n`);
      else process.stdout.write(`共 ${errs} 个 error，${warns} 个 warning（${results.length} 个文件）\n`);
    }
    process.exit(all.some((d) => d.severity === "error") ? 1 : 0);
  }

  if (args.command === "build") {
    if (args.target !== "python") {
      process.stderr.write(`Phase 0 仅支持 --target python（native/mlir 在 Phase 2/3）\n`);
      process.exit(2);
    }
    const { results, outputs } = build(targets, args.outDir);
    const all = results.flatMap((r) => r.diag.items);
    if (args.json) {
      process.stdout.write(JSON.stringify({
        diagnostics: all,
        outputs: outputs.map((o) => path.relative(cwd, o)),
      }, null, 2) + "\n");
    } else {
      for (const d of all) process.stdout.write(renderDiagnostic(d, useColor, cwd) + "\n\n");
      if (all.some((d) => d.severity === "error")) {
        process.stdout.write("编译失败：存在 error 级诊断，未生成产物（已解析文件仍可查看诊断）\n");
        process.exit(1);
      }
      process.stdout.write(`编译完成：${results.length} 个源文件 → ${args.outDir}/（含 Python 运行时与 JSON Schema）\n`);
    }
    process.exit(all.some((d) => d.severity === "error") ? 1 : 0);
  }

  if (args.command === "fmt") {
    const files = [...new Set(targets.flatMap(findCokFiles))];
    let changed = 0;
    const parseErrors: unknown[] = [];
    for (const f of files) {
      const r = formatFile(f, args.write);
      if (r.changed) {
        changed++;
        if (!args.write) process.stdout.write(`需格式化: ${path.relative(cwd, f)}\n`);
      }
      // 语法错误时给出 lexer/parser 诊断
      const ar = analyzeFile(f);
      for (const d of ar.diag.items.filter((x) => x.phase === "parser" || x.phase === "lexer")) {
        parseErrors.push(d);
        process.stdout.write(renderDiagnostic(d, useColor, cwd) + "\n\n");
      }
    }
    if (args.write) process.stdout.write(`格式化完成：${changed}/${files.length} 个文件被修改\n`);
    else process.stdout.write(changed ? `${changed}/${files.length} 个文件需要格式化（加 --apply 写盘）\n` : `全部 ${files.length} 个文件格式正确\n`);
    process.exit(parseErrors.length ? 1 : 0);
  }

  process.stderr.write(`未知命令: ${args.command}\n\n${HELP}`);
  process.exit(2);
}

main();
