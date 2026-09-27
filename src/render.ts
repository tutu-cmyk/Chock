// 结构化诊断 → 终端人类可读渲染（JSON 才是一等产物，这里只是渲染器）。
import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "./diag.js";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
  magenta: "\x1b[35m", green: "\x1b[32m",
};

function readLine(file: string, line: number): string {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r\n|\r|\n/);
    return lines[line - 1] ?? "";
  } catch {
    return "";
  }
}

export function renderDiagnostic(d: Diagnostic, useColor: boolean, cwd: string): string {
  const c = useColor ? C : new Proxy(C, { get: () => "" }) as typeof C;
  const out: string[] = [];
  const loc = `${c.cyan}${d.span.file}${c.reset}:${d.span.start.line}:${d.span.start.col}`;
  const sev = d.severity === "error" ? `${c.red}${c.bold}error${c.reset}` : `${c.yellow}${c.bold}warning${c.reset}`;
  out.push(`${loc}  ${sev} ${c.magenta}[${d.code}]${c.reset} ${c.bold}${d.message}${c.reset}`);

  if (d.intent_ref || d.violated?.length) {
    if (d.violated?.length) {
      for (const v of d.violated) out.push(`  ${c.red}违反锚点：${v}${c.reset}`);
    }
  }
  if (d.expected || d.found) {
    out.push(`  ${c.dim}期望:${c.reset} ${d.expected ?? "?"}   ${c.dim}实际:${c.reset} ${d.found ?? "?"}`);
  }

  // 代码帧
  const srcLine = readLine(d.span.file, d.span.start.line);
  if (srcLine) {
    const lineno = String(d.span.start.line);
    out.push(`${c.dim} ${lineno} |${c.reset} ${srcLine}`);
    const pad = " ".repeat(lineno.length + 2 + Math.max(0, d.span.start.col - 1));
    const sameLine = d.span.end.line === d.span.start.line;
    const width = sameLine ? Math.max(1, d.span.end.col - d.span.start.col + 1) : 1;
    out.push(`${pad}${c.red}${"^".repeat(width)}${c.reset}`);
  }

  for (const h of d.hints) {
    out.push(`  ${c.green}提示：${h}${c.reset}`);
  }
  if (d.fix) {
    out.push(`  ${c.green}自动修复（confidence=${d.fix.confidence}）：chock fix --apply${c.reset}`);
  }
  out.push(`  ${c.dim}(${path.relative(cwd, d.span.file)} · phase=${d.phase} · ~${d.cost.tokens} tokens)${c.reset}`);
  return out.join("\n");
}
