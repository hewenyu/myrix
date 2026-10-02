import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor } from "oxc-parser";

const root = fileURLToPath(new URL("../", import.meta.url));
const relative = value => path.relative(root, value).split(path.sep).join("/");

// Deliberately narrow, shrinking migration exceptions. Do not make these internals public
// just to satisfy the check: both writes must remain atomic with the business transaction.
export const exceptions = new Map([
  ["apps/bff/src/runtime-router.ts -> packages/platform-store/src/repositories/audit", "Move delivery transitions + audit into platform-store use cases (architecture review M2)."],
  ["apps/bff/src/runtime-recovery.ts -> packages/platform-store/src/repositories/audit", "Move recovery transitions + audit into platform-store use cases (architecture review M2)."],
]);

const pure = new Set(["@myrix/contracts", "@myrix/governance", "@myrix/registry", "@myrix/novel-protocol"]);

export function checkEdge(owner, specifier, target, packages) {
  if (specifier.startsWith("/") || specifier.startsWith("file:") || specifier.startsWith("#")) {
    return "absolute paths and import aliases must not bypass package boundaries";
  }
  if (specifier.startsWith(".")) {
    if (!target.startsWith(`${owner.directory}/`)) return "cross-package relative import; use an explicit public export";
    return undefined;
  }
  if (pure.has(owner.name) && !["@myrix/contracts"].includes(specifier)) {
    return "pure domain modules may depend only on contracts and local code";
  }
  if (owner.name === "@myrix/novel-web" && specifier.startsWith("@myrix/") && specifier !== "@myrix/contracts") {
    return "browser code must not import server or runtime implementations";
  }
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  const dependency = packages.get(name);
  if (!dependency) return undefined;
  if (name !== owner.name && !Object.hasOwn(owner.dependencies ?? {}, name)) return "workspace dependency is not declared in dependencies";
  if (owner.directory.startsWith("packages/") && !dependency.directory.startsWith("packages/")) {
    return "shared packages must not depend on applications or plugins";
  }
  if (owner.directory.startsWith("plugins/") && dependency.directory.startsWith("apps/")) {
    return "runtime plugins must not depend on application implementations";
  }
  if (name !== owner.name && owner.directory.startsWith("apps/") && dependency.directory.startsWith("apps/")) {
    return "applications communicate through ports/protocols, not implementation imports";
  }
  // Even a dependency-free plugin subpath installs the entire plugin closure.
  if (owner.directory.startsWith("apps/") && dependency.directory.startsWith("plugins/")) {
    return "applications must not load Cordis plugin implementations";
  }
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  if (dependency.exports !== undefined) {
    const exports = dependency.exports;
    const exported = typeof exports === "string" || Array.isArray(exports)
      ? subpath === "."
      : exports !== null && (Object.keys(exports).some(key => key.startsWith("."))
        ? Object.hasOwn(exports, subpath) && exports[subpath] !== null
        : subpath === ".");
    if (!exported) return "workspace import is not an explicit package export";
  } else if (subpath !== ".") {
    return "package without exports may only be imported through its main entry";
  }
  return undefined;
}

// Parse source syntax (including import type / export type / import("...").Type),
// not emitted JS: transpilers erase precisely the edges this gate must also police.
export function importSpecifiers(file, source) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors.map(error => error.message).join("; ")}`);
  const imports = [];
  const collect = node => {
    if (node?.type === "Literal" && typeof node.value === "string") imports.push(node.value);
    else if (node?.type === "TemplateLiteral" && node.expressions.length === 0) imports.push(node.quasis[0].value.cooked);
    else throw new Error(`${file}: computed module imports need an explicit, reviewable static mapping`);
  };
  new Visitor({
    ImportDeclaration: node => collect(node.source),
    ExportNamedDeclaration: node => { if (node.source) collect(node.source); },
    ExportAllDeclaration: node => collect(node.source),
    ImportExpression: node => collect(node.source),
    TSImportType: node => collect(node.source),
    TSExternalModuleReference: node => collect(node.expression),
    CallExpression: node => {
      if (node.callee.type === "Identifier" && node.callee.name === "require") collect(node.arguments[0]);
    },
  }).visit(parsed.program);
  return imports;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  }));
  return nested.flat();
}

export async function checkWorkspace() {
  const packages = new Map();
  const owners = new Map();
  for (const group of ["packages", "plugins", "apps"]) {
    for (const entry of await readdir(path.join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${group}/${entry.name}`;
      const manifest = await readFile(path.join(root, directory, "package.json"), "utf8").catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!manifest) continue;
      const owner = { ...JSON.parse(manifest), directory };
      packages.set(owner.name, owner);
      for (const file of await sourceFiles(path.join(root, directory, "src"))) owners.set(file, owner);
    }
  }
  const errors = new Set();
  const usedExceptions = new Set();
  for (const [file, owner] of owners) {
    for (const specifier of importSpecifiers(file, await readFile(file, "utf8"))) {
      const target = relative(path.resolve(path.dirname(file), specifier));
      const key = `${relative(file)} -> ${target}`;
      const reason = checkEdge(owner, specifier, target, packages);
      if (reason && exceptions.has(key)) usedExceptions.add(key);
      else if (reason) errors.add(`${relative(file)}: ${specifier}: ${reason}`);
    }
  }
  for (const key of exceptions.keys()) {
    if (!usedExceptions.has(key)) errors.add(`Remove stale boundary exception: ${key}`);
  }
  if (errors.size) throw new Error([...errors].sort().join("\n"));
  console.log(`Module boundaries passed: ${owners.size} source files; ${usedExceptions.size} tracked migration exceptions.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkWorkspace();
}
