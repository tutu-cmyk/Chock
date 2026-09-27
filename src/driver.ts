// 编译驱动器：串联 parse → check → codegen，负责文件发现与产物落盘。
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "./parser.js";
import { Checker } from "./checker.js";
import { DiagnosticCollector } from "./diag.js";
import { generatePython, generateSchemas, emitRuntime } from "./codegen.js";
import { formatProgram } from "./formatter.js";
import type * as A from "./ast.js";

export interface FileResult {
  file: string;
  src: string;
  diag: DiagnosticCollector;
  prog?: A.Program;
}

export function analyzeFile(file: string, src?: string): FileResult {
  const text = src ?? fs.readFileSync(file, "utf8");
  const diag = new DiagnosticCollector();
  const prog = parse(file, text, diag);
  if (!diag.hasErrors) {
    new Checker(file, diag).checkProgram(prog);
  }
  return { file, src: text, diag, prog };
}

export function findCokFiles(input: string): string[] {
  const st = fs.statSync(input);
  if (st.isFile()) return [input];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "out" || ent.name.startsWith(".")) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".cok")) out.push(p);
    }
  };
  walk(input);
  return out.sort();
}

function outPathFor(file: string, root: string, outDir: string, ext: string): string {
  const rel = path.relative(root, file).replace(/\.cok$/, ext);
  return path.join(outDir, rel);
}

export interface BuildResult {
  results: FileResult[];
  outputs: string[];
}

export function build(inputs: string[], outDir: string): BuildResult {
  const files = [...new Set(inputs.flatMap(findCokFiles))];
  // root：取所有输入的公共父目录，保证产物目录结构正确
  const abs = files.map((f) => path.resolve(f));
  const root = abs.length === 1
    ? (fs.statSync(abs[0]).isDirectory() ? abs[0] : path.dirname(abs[0]))
    : commonRoot(abs.map((f) => path.dirname(f)));
  const results: FileResult[] = [];
  const outputs: string[] = [];
  let anyProgram = false;

  for (const f of files) {
    const r = analyzeFile(f);
    results.push(r);
    if (r.diag.hasErrors || !r.prog) continue;
    anyProgram = true;

    const { py, pyi, map } = generatePython(r.prog, path.relative(root, f).replace(/\\/g, "/"));
    const pyPath = outPathFor(f, root, outDir, ".py");
    const pyiPath = outPathFor(f, root, outDir, ".pyi");
    const mapPath = outPathFor(f, root, outDir, ".cokmap");
    fs.mkdirSync(path.dirname(pyPath), { recursive: true });
    fs.writeFileSync(pyPath, py, "utf8");
    fs.writeFileSync(pyiPath, pyi, "utf8");
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf8");
    outputs.push(pyPath, pyiPath, mapPath);

    // JSON Schema 产物（每个 type 一个 schema 文件）
    const schemas = generateSchemas(r.prog);
    for (const [name, schema] of Object.entries(schemas)) {
      const sp = path.join(outDir, "schema", name + ".json");
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      fs.writeFileSync(sp, JSON.stringify(schema, null, 2) + "\n", "utf8");
      outputs.push(sp);
    }
  }

  if (anyProgram) emitRuntime(outDir);
  return { results, outputs };
}

function commonRoot(paths: string[]): string {
  if (!paths.length) return process.cwd();
  const split = paths.map((p) => p.split(path.sep));
  const first = split[0];
  let common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (split.every((s) => s[i] === first[i])) common.push(first[i]);
    else break;
  }
  return common.join(path.sep) || path.parse(paths[0]).root;
}

export function checkFiles(inputs: string[]): FileResult[] {
  return [...new Set(inputs.flatMap(findCokFiles))].map((f) => analyzeFile(f));
}

export function formatFile(file: string, write: boolean): { file: string; before: string; after: string; changed: boolean } {
  const src = fs.readFileSync(file, "utf8");
  const diag = new DiagnosticCollector();
  const prog = parse(file, src, diag);
  if (diag.hasErrors) {
    // 格式化器要求语法正确；返回原文并由调用方报告诊断
    return { file, before: src, after: src, changed: false };
  }
  const after = formatProgram(prog);
  const changed = after !== src;
  if (write && changed) fs.writeFileSync(file, after, "utf8");
  return { file, before: src, after, changed };
}
