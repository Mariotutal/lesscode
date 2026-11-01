import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { declName, parse, topLevelDecls, type CitedTarget } from "../src/classify/target.js";
import { equivalentHelperReason } from "../src/classify/verify.js";
import { inlineCodemod, inlineSafetyReason, retargetCodemod, retargetSafetyReason, type CodemodResult, type FileSources } from "../src/plan/codemod.js";

function snapshot(files: Record<string, string>): FileSources {
  return new Map(Object.entries(files).map(([file, text]) => [file, { text, sf: parse(file, text) }]));
}

function target(sources: FileSources, file = "src/wrap.ts", name = "wrap"): CitedTarget {
  const decl = topLevelDecls(sources.get(file)!.sf).find((node) => declName(node) === name)!;
  return { file, name, decl };
}

function changed(files: Record<string, string>, result: CodemodResult): Record<string, string> {
  const next = { ...files };
  for (const file of result.deleteFiles) delete next[file];
  for (const file of result.newFiles) next[file.file] = file.content;
  return next;
}

/** Execute the generated program with ordinary module caching, without a model or subprocess. */
function evaluate(files: Record<string, string>, entry = "src/use.ts"): unknown {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const load = (file: string): Record<string, unknown> => {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module);
    const text = files[file];
    if (text === undefined) throw new Error(`module ${file} does not exist`);
    const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`) as (require: (name: string) => unknown, module: unknown, exports: unknown) => void;
    execute((name) => {
      const resolved = posix.normalize(posix.join(posix.dirname(file), name));
      return load(files[resolved] === undefined ? resolved.replace(/\.js$/, ".ts") : resolved);
    }, module, module.exports);
    return module.exports;
  };
  return (load(entry).run as () => unknown)();
}

function comparison(a: string, b: string, extra: Record<string, string> = {}): string | undefined {
  const sources = snapshot({ "src/a.ts": a, "src/b.ts": b, ...extra });
  const decl = (file: string) => topLevelDecls(sources.get(file)!.sf).find((node) => declName(node) === "f")!;
  return equivalentHelperReason(decl("src/a.ts"), decl("src/b.ts"), new Map([...sources].map(([file, source]) => [file, source.sf])));
}

const inner = 'export function inner(a: number, b = 0) { return a + b; }\n';

describe("binding-aware duplicate proof", () => {
  it("accepts parameter and local renames without changing the calculation", () => {
    expect(comparison("export function f(amount: number, count: number) { const total = amount * count; return total; }", "export function f(price: number, quantity: number) { const result = price * quantity; return result; }")).toBeUndefined();
  });

  it("refuses reversed parameter roles", () => {
    expect(comparison("export function f(a: number, b: number) { return a - b; }", "export function f(a: number, b: number) { return b - a; }")).toMatch(/parameter bindings/);
  });

  it("preserves external identity even when the local spelling matches", () => {
    expect(comparison("const rate = 2; export function f(x: number) { return x * rate; }", "const rate = 3; export function f(x: number) { return x * rate; }")).toMatch(/external bindings/);
    expect(comparison('import { left as calc } from "./ops.js"; export function f(x: number) { return calc(x); }', 'import { right as calc } from "./ops.js"; export function f(x: number) { return calc(x); }', { "src/ops.ts": "export function left(x: number) { return x; } export function right(x: number) { return -x; }" })).toMatch(/external bindings/);
  });

  it("recognizes aliases of the same imported declaration", () => {
    expect(comparison('import { calc as left } from "./ops.js"; export function f(x: number) { return left(x); }', 'import { calc as right } from "./ops.js"; export function f(y: number) { return right(y); }', { "src/ops.ts": "export function calc(x: number) { return x * 2; }" })).toBeUndefined();
  });

  it.each([
    ["export function f(x = 1) { return x; }", "export function f(x = 2) { return x; }"],
    ["export async function f(x: number) { return x; }", "export function f(x: number) { return x; }"],
    ["export function* f(x: number) { yield x; }", "export function f(x: number) { return x; }"],
    ["export function f(x: number) { return {x}; }", "export function f(y: number) { return {y}; }"],
    ["export function f(x: number) { let y = x; return y; }", "export function f(x: number) { const y = x; return y; }"],
    ["export function f({left}: {left:number}) { return left; }", "export function f({right}: {right:number}) { return right; }"],
  ])("includes defaults, modifiers, property keys, and binding flags in the proof", (a, b) => {
    expect(comparison(a, b)).toBeDefined();
  });
});

describe("semantically bounded inline transforms", () => {
  it("executes a supported inline with the same result and preserves literal whitespace", () => {
    const files = {
      "src/inner.ts": 'export function inner(x: string) { return x; }\n',
      "src/wrap.ts": 'import {inner} from "./inner.js";\nexport function wrap() { return inner(`two  spaces\n\n\nkeep`); }\n',
      "src/use.ts": 'import {wrap} from "./wrap.js";\nexport function run() { return wrap(); }\n',
    };
    const sources = snapshot(files);
    const result = inlineCodemod(target(sources), "src/wrap.ts", sources)!;
    expect(result).toBeDefined();
    expect(evaluate(changed(files, result))).toBe(evaluate(files));
    expect(evaluate(changed(files, result))).toBe("two  spaces\n\n\nkeep");
  });

  it("preserves a stored transparent wrapper chain and unrelated constructor state", () => {
    const files = {
      "src/inner.ts": 'export class Inner { constructor(private readonly client: {get(): number}) {} fetch() { return this.client.get(); } }\n',
      "src/wrap.ts": 'import {Inner} from "./inner.js"; export class Outer { constructor(private readonly inner: Inner) {} load() { return this.inner.fetch(); } }\n',
      "src/use.ts": 'import {Inner} from "./inner.js"; import {Outer} from "./wrap.js"; class Use { private readonly w: Outer; private readonly unrelated: number; constructor(client: {get(): number}) { this.unrelated = 99; this.w = new Outer(new Inner(client)); } fetch() { return this.w.load(); } } export function run() { let n = 0; const use = new Use({get: () => ++n}); return [use.fetch(), use.fetch()]; }\n',
    };
    let next = files as Record<string, string>;
    for (const [file, name] of [["src/wrap.ts", "Outer"], ["src/inner.ts", "Inner"]] as const) {
      const sources = snapshot(next);
      const resolved = target(sources, file, name);
      expect(inlineSafetyReason(resolved, file, sources)).toBeUndefined();
      const result = inlineCodemod(resolved, file, sources)!;
      expect(result).toBeDefined();
      next = changed(next, result);
    }
    expect(evaluate(next)).toEqual([1, 2]);
    expect(evaluate(next)).toEqual(evaluate(files));
    expect(next["src/use.ts"]).toContain("this.unrelated = 99");
  });

  it("refuses duplicated side-effecting arguments", () => {
    const files = {
      "src/inner.ts": inner,
      "src/wrap.ts": 'import {inner} from "./inner.js";\nexport function wrap(x: number) { return inner(x, x); }\n',
      "src/use.ts": 'import {wrap} from "./wrap.js";\nexport function run() { let n = 0; return [wrap(++n), n]; }\n',
    };
    const sources = snapshot(files);
    expect(evaluate(files)).toEqual([2, 1]);
    expect(inlineSafetyReason(target(sources), "src/wrap.ts", sources)).toMatch(/argument 1.*effects/);
    expect(inlineCodemod(target(sources), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("refuses argument calls whose order or count could change", () => {
    const files = {
      "src/inner.ts": inner,
      "src/wrap.ts": 'import {inner} from "./inner.js";\nexport function wrap(x: number, y: number) { return inner(y, x); }\n',
      "src/use.ts": 'import {wrap} from "./wrap.js";\nlet n = 0; function next() { return ++n; }\nexport function run() { return wrap(next(), next()); }\n',
    };
    const sources = snapshot(files);
    expect(inlineSafetyReason(target(sources), "src/wrap.ts", sources)).toMatch(/argument 1/);
    expect(inlineCodemod(target(sources), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("retains parentheses around a substituted numeric expression", () => {
    const files = {
      "src/inner.ts": inner,
      "src/wrap.ts": 'import {inner} from "./inner.js";\nexport function wrap(x: number) { return inner(x * 2); }\n',
      "src/use.ts": 'import {wrap} from "./wrap.js";\nexport function run() { return wrap(1 + 2); }\n',
    };
    const sources = snapshot(files);
    const result = inlineCodemod(target(sources), "src/wrap.ts", sources)!;
    expect(result).toBeDefined();
    expect(evaluate(changed(files, result))).toBe(6);
    expect(evaluate(changed(files, result))).toBe(evaluate(files));
  });

  it.each([
    "export function wrap(x = 1) { return inner(x); }",
    "export function wrap(...x: number[]) { return inner(x[0]); }",
    "export async function wrap(x: number) { return inner(x); }",
    "export function* wrap(x: number) { return inner(x); }",
  ])("refuses unsupported binding or execution contracts: %s", (declaration) => {
    const sources = snapshot({ "src/inner.ts": inner, "src/wrap.ts": `import {inner} from "./inner.js";\n${declaration}\n`, "src/use.ts": 'import {wrap} from "./wrap.js"; export const x = wrap(1);\n' });
    expect(inlineSafetyReason(target(sources), "src/wrap.ts", sources)).toBeDefined();
    expect(inlineCodemod(target(sources), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("refuses shadowed or module-local free names", () => {
    const sources = snapshot({ "src/inner.ts": inner, "src/wrap.ts": 'import {inner} from "./inner.js";\nexport function wrap(x: number) { return inner(x); }\n', "src/use.ts": 'import {wrap} from "./wrap.js"; export function run() { const inner = () => 99; return wrap(1); }\n' });
    expect(inlineSafetyReason(target(sources), "src/wrap.ts", sources)).toMatch(/free binding inner/);
    expect(inlineCodemod(target(sources), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("transfers imported aliases under their actual exported name", () => {
    const files = { "src/inner.ts": inner, "src/wrap.ts": 'import {inner as send} from "./inner.js";\nexport function wrap(x: number) { return send(x); }\n', "src/use.ts": 'import {wrap} from "./wrap.js";\nexport function run() { return wrap(4); }\n' };
    const sources = snapshot(files);
    const result = inlineCodemod(target(sources), "src/wrap.ts", sources)!;
    expect(result).toBeDefined();
    expect(evaluate(changed(files, result))).toBe(evaluate(files));
  });

  it("refuses functions passed around in addition to their one invocation", () => {
    const sources = snapshot({ "src/inner.ts": inner, "src/wrap.ts": 'import {inner} from "./inner.js";\nexport function wrap(x: number) { return inner(x); }\n', "src/use.ts": 'import {wrap} from "./wrap.js"; export const callback = wrap; export function run() { return wrap(1); }\n' });
    expect(inlineSafetyReason(target(sources), "src/wrap.ts", sources)).toMatch(/identity escapes/);
    expect(inlineCodemod(target(sources), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("refuses dynamic references that would survive deletion of the wrapper", () => {
    const sources = snapshot({ "src/inner.ts": inner, "src/wrap.ts": 'import {inner} from "./inner.js"; export function wrap(x: number) { return inner(x); }', "src/use.ts": 'import {wrap} from "./wrap.js"; export function run() { return wrap(1); }', "src/other.ts": 'export const later = import("./wrap.js");' });
    expect(inlineSafetyReason(target(sources), "src/wrap.ts", sources)).toMatch(/dynamic imports/);
    expect(inlineCodemod(target(sources), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("refuses multi-statement splicing into an expression with earlier effects", () => {
    const sources = snapshot({ "src/wrap.ts": 'function inner(x: number) { return x; } export function wrap(x: number) { const y = inner(x); return y + x; } export function run() { return inner(4) * wrap(2); }' });
    expect(inlineSafetyReason(target(sources), "src/wrap.ts", sources)).toMatch(/reorder or discard/);
    expect(inlineCodemod(target(sources), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("refuses constructors with effects", () => {
    const sources = snapshot({ "src/wrap.ts": 'export class Wrap { constructor(private readonly inner: { get(): number }) { console.log("constructed"); } fetch() { return this.inner.get(); } }\n', "src/use.ts": 'import {Wrap} from "./wrap.js"; export function run() { return new Wrap({get: () => 1}).fetch(); }\n' });
    expect(inlineSafetyReason(target(sources, "src/wrap.ts", "Wrap"), "src/wrap.ts", sources)).toMatch(/constructor effects/);
    expect(inlineCodemod(target(sources, "src/wrap.ts", "Wrap"), "src/wrap.ts", sources)).toBeUndefined();
  });

  it("preserves conditional receiver grouping for a transparent immediate class", () => {
    const files = { "src/wrap.ts": 'export class Wrap { constructor(private readonly inner: { get(): number }) {} fetch() { return this.inner.get(); } }\n', "src/use.ts": 'import {Wrap} from "./wrap.js";\nexport function run() { return new Wrap(true ? {get: () => 3} : {get: () => 7}).fetch(); }\n' };
    const sources = snapshot(files);
    const result = inlineCodemod(target(sources, "src/wrap.ts", "Wrap"), "src/wrap.ts", sources)!;
    expect(result).toBeDefined();
    expect(evaluate(changed(files, result))).toBe(3);
    expect(evaluate(changed(files, result))).toBe(evaluate(files));
  });

  it("does not move a stateful dependency's construction into each method call", () => {
    const sources = snapshot({ "src/wrap.ts": 'export class Wrap { constructor(private readonly inner: { get(): number }) {} fetch() { return this.inner.get(); } }\n', "src/counter.ts": 'export class Counter { constructor(private n = 0) {} get() { return ++this.n; } }', "src/use.ts": 'import {Wrap} from "./wrap.js"; import {Counter} from "./counter.js"; export class Use { private readonly w: Wrap; constructor() { this.w = new Wrap(new Counter()); } run() { return this.w.fetch(); } }\n' });
    expect(inlineSafetyReason(target(sources, "src/wrap.ts", "Wrap"), "src/wrap.ts", sources)).toMatch(/lifetime or side effects/);
    expect(inlineCodemod(target(sources, "src/wrap.ts", "Wrap"), "src/wrap.ts", sources)).toBeUndefined();
  });
});

describe("bounded retarget transforms", () => {
  it("executes a safe retarget with aliased named imports", () => {
    const files = { "src/dup.ts": 'export function f(x: number) { return x * 2; }\n', "src/existing.ts": 'export function f(value: number) { return value * 2; }\n', "src/use.ts": 'import {f as double} from "./dup.js"; export function run() { return double(3); }\n' };
    const sources = snapshot(files);
    const result = retargetCodemod({ file: "src/dup.ts", name: "f" }, "src/existing.ts", sources)!;
    expect(result).toBeDefined();
    expect(evaluate(changed(files, result))).toBe(evaluate(files));
  });

  it.each([
    'import * as helpers from "./dup.js"; export const x = helpers.f(1);',
    'export {f} from "./dup.js";',
    'const helpers = require("./dup.js"); export const x = helpers.f(1);',
    'const helpers = import("./dup.js");',
  ])("refuses importer shapes that changing one import string cannot prove: %s", (consumer) => {
    const sources = snapshot({ "src/dup.ts": 'export function f(x: number) { return x; }\n', "src/existing.ts": 'export function f(x: number) { return x; }\n', "src/use.ts": consumer });
    expect(retargetSafetyReason({ file: "src/dup.ts", name: "f" }, "src/existing.ts", sources)).toBeDefined();
    expect(retargetCodemod({ file: "src/dup.ts", name: "f" }, "src/existing.ts", sources)).toBeUndefined();
  });

  it("does not delete extra exports or module initialization effects", () => {
    const sources = snapshot({ "src/dup.ts": 'export function f(x: number) { return x; }\nexport const other = 42;\n', "src/existing.ts": 'export function f(x: number) { return x; }\n', "src/use.ts": 'import {f,other} from "./dup.js"; export const x = f(other);\n' });
    expect(retargetSafetyReason({ file: "src/dup.ts", name: "f" }, "src/existing.ts", sources)).toMatch(/additional runtime/);
    expect(retargetCodemod({ file: "src/dup.ts", name: "f" }, "src/existing.ts", sources)).toBeUndefined();
  });
});
