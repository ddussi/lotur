import { readFile, readdir } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
import ts from "typescript";

export function collectModuleSpecifiers(source, fileName) {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const specifiers = [];
  const createRequireNames = new Set();
  const moduleNamespaceNames = new Set();
  const requireNames = new Set(["require"]);
  const moduleRequireNames = new Set(["module"]);

  const isModuleBuiltinLoad = (node) => {
    if (!ts.isCallExpression(node)) return false;
    const [specifier] = node.arguments;
    if (
      specifier === undefined ||
      !ts.isStringLiteralLike(specifier) ||
      !["node:module", "module"].includes(specifier.text)
    ) return false;
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(node.expression)) {
      return requireNames.has(node.expression.text);
    }
    return ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "require" &&
      ts.isIdentifier(node.expression.expression) &&
      moduleRequireNames.has(node.expression.expression.text);
  };

  const discoverLoaderImports = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      ["node:module", "module"].includes(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      if (clause?.name !== undefined) moduleNamespaceNames.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        moduleNamespaceNames.add(bindings.name.text);
      } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "createRequire") {
            createRequireNames.add(element.name.text);
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      ["node:module", "module"].includes(node.moduleReference.expression.text)
    ) {
      moduleNamespaceNames.add(node.name.text);
      moduleRequireNames.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isModuleBuiltinLoad(node.initializer)
    ) {
      if (ts.isIdentifier(node.name)) {
        moduleNamespaceNames.add(node.name.text);
        moduleRequireNames.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const importedName = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
          if (importedName === "createRequire" && ts.isIdentifier(element.name)) {
            createRequireNames.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, discoverLoaderImports);
  };
  discoverLoaderImports(sourceFile);

  const isCreateRequireCall = (node) => {
    if (!ts.isCallExpression(node)) return false;
    if (ts.isIdentifier(node.expression)) {
      return createRequireNames.has(node.expression.text);
    }
    return ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "createRequire" &&
      ts.isIdentifier(node.expression.expression) &&
      moduleNamespaceNames.has(node.expression.expression.text);
  };
  const discoverRequireBindings = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCreateRequireCall(node.initializer)
    ) {
      requireNames.add(node.name.text);
    }
    ts.forEachChild(node, discoverRequireBindings);
  };
  discoverRequireBindings(sourceFile);

  const addLiteral = (node) => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      addLiteral(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      requireNames.has(node.expression.text)
    ) {
      addLiteral(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "require" &&
      ts.isIdentifier(node.expression.expression) &&
      moduleRequireNames.has(node.expression.expression.text)
    ) {
      addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

export function resolveImportTarget(sourceFile, specifier, workspaceDirectories) {
  if (specifier.startsWith(".")) {
    return normalize(resolve(dirname(sourceFile), specifier));
  }
  const match = /^@review-tunnel\/([^/]+)(?:\/(.*))?$/.exec(specifier);
  if (match === null) return undefined;
  const packageName = match[1];
  const subpath = match[2];
  if (packageName === undefined) return undefined;
  const fullPackageName = `@review-tunnel/${packageName}`;
  const workspaceDirectory = workspaceDirectories?.get(fullPackageName);
  if (workspaceDirectory === undefined) {
    throw new Error(`unknown workspace package: ${fullPackageName}`);
  }
  return normalize(resolve(
    workspaceDirectory,
    "src",
    subpath === undefined || subpath === "" ? "index.ts" : subpath,
  ));
}

export async function loadWorkspaceDirectories(root) {
  const directories = new Map();
  for (const group of ["apps", "packages"]) {
    const groupDirectory = resolve(root, group);
    for (const entry of await readdir(groupDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(groupDirectory, entry.name);
      const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
      if (typeof manifest.name !== "string" || !manifest.name.startsWith("@review-tunnel/")) {
        throw new Error(`${group}/${entry.name}/package.json must declare an internal package name`);
      }
      if (directories.has(manifest.name)) {
        throw new Error(`duplicate workspace package name: ${manifest.name}`);
      }
      directories.set(manifest.name, directory);
    }
  }
  return directories;
}
