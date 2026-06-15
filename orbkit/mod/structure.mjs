import fs from 'node:fs';
import path from 'node:path';
import {
  assert,
  isMainModule,
  loadConfig,
  resolveContractDir,
  toRootRelative,
} from './common.mjs';

const IGNORED_DIRS = new Set(['target', 'target-windows', '.git', 'node_modules']);
const RUST_SOURCE_EXTENSIONS = new Set(['.rs']);
const NON_FUNCTION_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'match', 'loop']);

function normalizePosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isWorkspaceRelative(value) {
  return Boolean(value) && value !== '.' && !value.startsWith('../') && !path.isAbsolute(value);
}

function loadCkbStdHighLevelApiCatalog(workspaceRoot) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const registrySrc = path.join(home, '.cargo', 'registry', 'src');
  if (!home || !fs.existsSync(registrySrc)) {
    return { names: [], source: null };
  }

  const highLevelCandidates = [];
  for (const registry of fs.readdirSync(registrySrc, { withFileTypes: true })) {
    if (!registry.isDirectory()) continue;
    const registryPath = path.join(registrySrc, registry.name);
    for (const entry of fs.readdirSync(registryPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('ckb-std-')) continue;
      const highLevelPath = path.join(registryPath, entry.name, 'src', 'high_level.rs');
      if (fs.existsSync(highLevelPath)) highLevelCandidates.push(highLevelPath);
    }
  }
  if (highLevelCandidates.length === 0) return { names: [], source: null };

  highLevelCandidates.sort((left, right) => right.localeCompare(left));
  const selected = highLevelCandidates[0];
  const text = fs.readFileSync(selected, 'utf8');
  const names = [...text.matchAll(/\bpub\s+fn\s+([a-zA-Z_]\w*)\s*\(/g)].map((match) => match[1]);
  return {
    names: [...new Set(names)].sort((a, b) => a.localeCompare(b)),
    source: normalizePosix(toRootRelative(workspaceRoot, selected)),
  };
}

function resolveContractInput(input = {}) {
  const rawContractPath = String(input?.contractPath || input?.path || '').trim();
  assert(rawContractPath, 'contractPath is required.');

  const cfg = input?.workspaceRoot ? null : loadConfig(input?.configPath || undefined);
  const workspaceRoot = path.resolve(input?.workspaceRoot || cfg?._resolved?.workspaceRoot || process.cwd());
  const contractDir = path.isAbsolute(rawContractPath)
    ? path.resolve(rawContractPath)
    : resolveContractDir(workspaceRoot, rawContractPath);

  assert(fs.existsSync(contractDir) && fs.statSync(contractDir).isDirectory(), `Contract directory not found: ${contractDir}`);
  assert(fs.existsSync(path.join(contractDir, 'Cargo.toml')), `Cargo.toml not found for contract: ${contractDir}`);

  const workspaceRelative = normalizePosix(toRootRelative(workspaceRoot, contractDir));
  const normalizedContractPath = isWorkspaceRelative(workspaceRelative)
    ? workspaceRelative
    : normalizePosix(rawContractPath);

  return {
    config: cfg,
    workspaceRoot,
    contractDir,
    contractPath: normalizedContractPath || path.basename(contractDir),
  };
}

function buildStructureTree(contractDir, contractPath) {
  function walk(currentPath, relativeBase) {
    return fs.readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .map((entry) => {
        const nextPath = path.join(currentPath, entry.name);
        const nextRelative = path.posix.join(relativeBase, entry.name);

        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path: nextRelative,
            type: 'directory',
            children: walk(nextPath, nextRelative),
          };
        }

        return {
          name: entry.name,
          path: nextRelative,
          type: 'file',
        };
      })
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }

  return walk(contractDir, normalizePosix(contractPath));
}

function collectFilePaths(items) {
  const filePaths = new Set();

  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === 'directory') walk(node.children || []);
      else if (node.type === 'file') filePaths.add(node.path);
    }
  }

  walk(items);
  return filePaths;
}

function extractFunctionNames(content) {
  const names = new Set();
  for (const match of content.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)) {
    const value = match[1]?.trim();
    if (value && !NON_FUNCTION_NAMES.has(value)) names.add(value);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function normalizeRustUseRoot(value) {
  const compact = String(value || '').trim().replace(/\s+/g, '');
  if (!compact) return '';
  const braceIndex = compact.indexOf('::{');
  return braceIndex >= 0 ? compact.slice(0, braceIndex) : compact;
}

function extractRustImports(content) {
  const output = new Set();

  for (const match of content.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)) {
    output.add(`mod:${match[1]}`);
  }

  for (const match of content.matchAll(/^\s*use\s+([^;]+);/gm)) {
    const normalized = normalizeRustUseRoot(match[1]);
    if (normalized) output.add(normalized);
  }

  return Array.from(output);
}

function parseCargoDependencies(content) {
  const depNames = new Set();
  const blocks = [
    /\[dependencies\]([\s\S]*?)(?:\n\[|$)/,
    /\[dev-dependencies\]([\s\S]*?)(?:\n\[|$)/,
    /\[build-dependencies\]([\s\S]*?)(?:\n\[|$)/,
  ];

  for (const blockRegex of blocks) {
    const block = content.match(blockRegex);
    if (!block?.[1]) continue;
    for (const rawLine of block[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const [name] = line.split('=');
      const dep = name?.trim();
      if (dep) depNames.add(dep);
    }
  }

  return Array.from(depNames).sort((a, b) => a.localeCompare(b));
}

function parseCargoPackageName(content) {
  const pkgMatch = content.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/m);
  return pkgMatch?.[1]?.trim() ?? null;
}

function parseCargoCrateTypes(content) {
  const crateTypeMatch = content.match(/crate-type\s*=\s*\[([^\]]+)\]/m);
  if (!crateTypeMatch?.[1]) return [];
  return crateTypeMatch[1]
    .split(',')
    .map((value) => value.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function getRustModuleContext(fromFilePath) {
  const fileName = path.posix.basename(fromFilePath);
  const currentDir = path.posix.dirname(fromFilePath);
  const stem = path.posix.basename(fromFilePath, path.posix.extname(fromFilePath));

  if (fileName === 'mod.rs') {
    return {
      childRoot: currentDir,
      parentRoot: path.posix.dirname(currentDir),
    };
  }

  if (fileName === 'main.rs' || fileName === 'lib.rs') {
    return {
      childRoot: currentDir,
      parentRoot: path.posix.dirname(currentDir),
    };
  }

  return {
    childRoot: path.posix.join(currentDir, stem),
    parentRoot: currentDir,
  };
}

function resolveRustModuleCandidates(basePath, allPaths) {
  const normalizedBase = path.posix.normalize(basePath);
  const candidates = [
    `${normalizedBase}.rs`,
    `${normalizedBase}/mod.rs`,
  ];

  for (const candidate of candidates) {
    if (allPaths.has(candidate)) return candidate;
  }

  return null;
}

function resolveRustPathFromRoot(rootPath, segments, allPaths) {
  if (!rootPath || segments.length === 0) return null;

  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = resolveRustModuleCandidates(
      path.posix.join(rootPath, ...segments.slice(0, length)),
      allPaths,
    );
    if (candidate) return candidate;
  }

  return null;
}

function resolveRustImport(fromFilePath, specifier, allPaths, contractPath) {
  const normalizedSpecifier = String(specifier || '').trim().replace(/\s+/g, '');
  if (!normalizedSpecifier) return null;

  const contractSrcRoot = path.posix.join(normalizePosix(contractPath), 'src');
  const context = getRustModuleContext(fromFilePath);

  if (normalizedSpecifier.startsWith('mod:')) {
    const moduleName = normalizedSpecifier.slice(4);
    return resolveRustModuleCandidates(path.posix.join(context.childRoot, moduleName), allPaths);
  }

  const segments = normalizedSpecifier.replace(/^::+/, '').split('::').filter(Boolean);
  if (segments.length === 0) return null;

  if (segments[0] === 'crate') {
    return resolveRustPathFromRoot(contractSrcRoot, segments.slice(1), allPaths);
  }

  if (segments[0] === 'self') {
    return resolveRustPathFromRoot(context.childRoot, segments.slice(1), allPaths);
  }

  if (segments[0] === 'super') {
    let rootPath = context.parentRoot;
    let index = 0;
    while (segments[index] === 'super') {
      if (index > 0) rootPath = path.posix.dirname(rootPath);
      index += 1;
    }
    return resolveRustPathFromRoot(rootPath, segments.slice(index), allPaths);
  }

  return resolveRustPathFromRoot(context.childRoot, segments, allPaths)
    || resolveRustPathFromRoot(context.parentRoot, segments, allPaths)
    || resolveRustPathFromRoot(contractSrcRoot, segments, allPaths);
}

function isLocalOnlyRustSpecifier(specifier) {
  return String(specifier || '').startsWith('mod:')
    || /^(crate|self|super)::/.test(String(specifier || '').trim());
}

function formatImportSpecifier(specifier) {
  return String(specifier || '').startsWith('mod:') ? String(specifier).slice(4) : String(specifier || '');
}

function classifyContractRole({ cargoManifestText, cargoPackageName, entrypointFiles, hasMainRs, hasLibRs }) {
  const crateTypes = parseCargoCrateTypes(cargoManifestText);
  const hasCdylib = crateTypes.includes('cdylib');
  const hasStaticlib = crateTypes.includes('staticlib');
  if (entrypointFiles.length > 0 || hasCdylib || hasStaticlib) return 'ckb-script';
  if (hasMainRs) return 'rust-binary';
  if (hasLibRs || cargoPackageName) return 'rust-library';
  return 'unknown';
}

function analyzeSingleRustFile(content, vmCatalog) {
  const entrypoints = [...content.matchAll(/ckb_std::entry!\((\w+)\)/g)].map((match) => match[1]);
  const exportedFns = [...content.matchAll(/\bpub\s+fn\s+(\w+)\s*\(/g)].map((match) => match[1]);
  const errorConstants = [...content.matchAll(/\bconst\s+([A-Z0-9_]+)\s*:\s*i8\s*=\s*([^;]+);/g)]
    .map((match) => ({ name: match[1], value: match[2].trim() }));
  const returnedErrorSymbols = [...new Set([
    ...[...content.matchAll(/Err\(([^)]+)\)/g)].map((match) => match[1].trim()),
    ...[...content.matchAll(/return\s+Err\(([^)]+)\)/g)].map((match) => match[1].trim()),
  ])];
  const returnedErrorLiterals = returnedErrorSymbols.filter((value) => /^-?\d+$/.test(value));
  const returnedErrorNames = returnedErrorSymbols.filter((value) => /^[A-Z0-9_]+$/.test(value));
  const errorCodes = errorConstants.filter((entry) => returnedErrorNames.includes(entry.name));

  const importedVmFns = [
    ...content.matchAll(/use\s+ckb_std::high_level::\{([\s\S]*?)\};/g),
  ]
    .flatMap((match) => match[1].split(',').map((value) => value.trim()).filter(Boolean))
    .map((value) => value.replace(/\s+as\s+\w+$/, '').trim())
    .filter((value) => /^[a-zA-Z_]\w*$/.test(value));
  const uniqueImportedVmFns = [...new Set(importedVmFns)];
  const vmCatalogSet = new Set(vmCatalog.names);
  const vmApiImports = vmCatalog.names.length > 0
    ? uniqueImportedVmFns.filter((fnName) => vmCatalogSet.has(fnName))
    : uniqueImportedVmFns;
  const vmApiCalls = vmApiImports.filter((fnName) => new RegExp(`\\b${fnName}\\s*\\(`).test(content));
  const vmCapabilityBuckets = {
    load: vmApiCalls.filter((name) => name.startsWith('load_')),
    query: vmApiCalls.filter((name) => name.startsWith('query_')),
    exec: vmApiCalls.filter((name) => name.startsWith('exec_')),
    look_for: vmApiCalls.filter((name) => name.startsWith('look_for_')),
    misc: vmApiCalls.filter((name) => !/^(load_|query_|exec_|look_for_)/.test(name)),
  };

  const sourceVariants = [...new Set([...content.matchAll(/Source::([A-Za-z_]+)/g)].map((match) => match[1]))];
  const usesInputSource = sourceVariants.includes('Input');
  const usesOutputSource = sourceVariants.includes('Output');
  const readsWitness = /load_witness\s*\(/.test(content);
  const readsCellData = /load_cell_data\s*\(|outputsData|outputs_data/.test(content);
  const validatesScriptArgs = /script\.args|args\s*\[/.test(content);
  const usesWitnessArgs = /WitnessArgs|load_witness_args/.test(content);
  const stateTransitionChecks = {
    checksInputs: usesInputSource,
    checksOutputs: usesOutputSource,
    readsWitness,
    readsCellData,
    validatesScriptArgs,
    usesWitnessArgs,
  };

  let behaviorClassification = 'mixed-or-unknown';
  if (stateTransitionChecks.checksInputs && !stateTransitionChecks.checksOutputs) behaviorClassification = 'lock-like';
  if (stateTransitionChecks.checksOutputs || stateTransitionChecks.readsCellData) behaviorClassification = 'type-like';
  if (!stateTransitionChecks.checksInputs && !stateTransitionChecks.checksOutputs && stateTransitionChecks.validatesScriptArgs) {
    behaviorClassification = 'lock-like';
  }

  const features = [];
  if (entrypoints.length > 0) features.push('entrypoint-validation');
  if (validatesScriptArgs) features.push('script-args-validation');
  if (content.includes('hash_type') || content.includes('code_hash')) features.push('script-identity-checks');
  if (errorCodes.length > 0 || returnedErrorLiterals.length > 0) features.push('custom-error-codes');
  if (vmApiCalls.length > 0) features.push('ckb-vm-syscalls');
  if (stateTransitionChecks.checksInputs) features.push('input-state-checks');
  if (stateTransitionChecks.checksOutputs) features.push('output-state-checks');
  if (stateTransitionChecks.readsCellData) features.push('cell-data-checks');
  if (stateTransitionChecks.readsWitness || stateTransitionChecks.usesWitnessArgs) features.push('witness-access');

  return {
    language: 'rust/ckb-std',
    entrypoints,
    exports: exportedFns,
    errorConstants,
    returnedErrors: {
      symbols: returnedErrorSymbols,
      literals: returnedErrorLiterals,
      named: returnedErrorNames,
    },
    errorCodes,
    vmApiCatalogSource: vmCatalog.source,
    vmApiCatalogCount: vmCatalog.names.length,
    vmApiImports,
    vmApiCalls,
    vmCapabilityBuckets,
    sourceVariants,
    behaviorClassification,
    stateTransitionChecks,
    features,
    featureCount: features.length,
  };
}

function analyzePerFile(contractDir, contractPath, items, vmCatalog) {
  const filePaths = collectFilePaths(items);
  const rustFiles = Array.from(filePaths).filter((filePath) => RUST_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const depNames = new Set();
  const behaviorCounts = {};
  const perFile = {};
  const importedByMap = new Map();
  let totalLines = 0;
  let totalFunctions = 0;
  let sourceFileCount = 0;
  let entrypointCount = 0;

  for (const filePath of filePaths) {
    const relPath = filePath.startsWith(`${contractPath}/`)
      ? filePath.slice(contractPath.length + 1)
      : path.posix.basename(filePath);
    const absPath = path.resolve(contractDir, relPath);
    const ext = path.extname(filePath).toLowerCase();
    let content = '';

    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      perFile[filePath] = {
        lines: 0,
        functions: 0,
        functionNames: [],
        imports: [],
        importedBy: [],
        relatedFiles: [],
        sharedFunctionNames: [],
        sharedFunctionalityWith: [],
        analysis: undefined,
      };
      continue;
    }

    const isRustSource = RUST_SOURCE_EXTENSIONS.has(ext);
    let lines = 0;
    let functionNames = [];
    let rawImports = [];
    let analysis;

    if (isRustSource) {
      sourceFileCount += 1;
      for (const line of content.split(/\r?\n/)) {
        if (line.trim().length > 0) lines += 1;
      }
      functionNames = extractFunctionNames(content);
      rawImports = extractRustImports(content);
      analysis = analyzeSingleRustFile(content, vmCatalog);
      entrypointCount += analysis.entrypoints.length;
    }

    const normalizedImports = rawImports
      .map((specifier) => {
        const resolvedLocal = resolveRustImport(filePath, specifier, filePaths, contractPath);
        return resolvedLocal || formatImportSpecifier(specifier);
      })
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .sort((a, b) => a.localeCompare(b));
    const localRelatedImports = normalizedImports.filter((value) => filePaths.has(value));

    totalLines += lines;
    totalFunctions += functionNames.length;
    perFile[filePath] = {
      lines,
      functions: functionNames.length,
      functionNames,
      imports: normalizedImports,
      importedBy: [],
      relatedFiles: localRelatedImports.slice(),
      sharedFunctionNames: [],
      sharedFunctionalityWith: [],
      analysis,
    };

    if (analysis?.behaviorClassification) {
      behaviorCounts[analysis.behaviorClassification] = (behaviorCounts[analysis.behaviorClassification] || 0) + 1;
    }

    for (const dep of localRelatedImports) {
      const set = importedByMap.get(dep) || new Set();
      set.add(filePath);
      importedByMap.set(dep, set);
    }

    for (const specifier of rawImports) {
      const resolvedLocal = resolveRustImport(filePath, specifier, filePaths, contractPath);
      if (resolvedLocal) continue;
      if (isLocalOnlyRustSpecifier(specifier)) continue;
      const externalName = formatImportSpecifier(specifier);
      if (externalName) depNames.add(externalName);
    }

    if (path.basename(filePath) === 'Cargo.toml') {
      for (const dep of parseCargoDependencies(content)) depNames.add(dep);
    }
  }

  for (const [target, fromSet] of importedByMap.entries()) {
    if (!perFile[target]) continue;
    perFile[target].importedBy = Array.from(fromSet).sort((a, b) => a.localeCompare(b));
    perFile[target].relatedFiles = Array.from(new Set([
      ...perFile[target].relatedFiles,
      ...perFile[target].importedBy,
    ])).sort((a, b) => a.localeCompare(b));
  }

  const cargoTomlPath = path.join(contractDir, 'Cargo.toml');
  const cargoManifestText = fs.readFileSync(cargoTomlPath, 'utf8');
  const cargoPackageName = parseCargoPackageName(cargoManifestText);
  const entrypointFiles = rustFiles.filter((filePath) => (perFile[filePath]?.analysis?.entrypoints?.length || 0) > 0);
  const rustBinaryName = cargoPackageName || path.basename(contractDir);
  const hasMainRs = rustFiles.some((filePath) => filePath.endsWith('/src/main.rs'));
  const hasLibRs = rustFiles.some((filePath) => filePath.endsWith('/src/lib.rs'));

  return {
    stats: {
      codeLines: totalLines,
      functions: totalFunctions,
      deps: depNames.size,
      fileCount: filePaths.size,
      sourceFileCount,
      rustFileCount: rustFiles.length,
      entrypointCount,
      behaviorCounts,
    },
    perFile,
    manifest: {
      packageName: cargoPackageName,
      crateTypes: parseCargoCrateTypes(cargoManifestText),
      dependencies: parseCargoDependencies(cargoManifestText),
      role: classifyContractRole({
        cargoManifestText,
        cargoPackageName,
        entrypointFiles,
        hasMainRs,
        hasLibRs,
      }),
      binaryName: rustBinaryName,
    },
    entrypointFiles,
  };
}

function buildSharedFunctionIndex(perFile) {
  const functionToFiles = new Map();

  for (const [filePath, metrics] of Object.entries(perFile)) {
    for (const fnName of metrics.functionNames || []) {
      const files = functionToFiles.get(fnName) || new Set();
      files.add(filePath);
      functionToFiles.set(fnName, files);
    }
  }

  const sharedFunctions = [];
  for (const [fnName, fileSet] of functionToFiles.entries()) {
    if (fileSet.size < 2) continue;
    sharedFunctions.push({
      name: fnName,
      files: Array.from(fileSet).sort((a, b) => a.localeCompare(b)),
    });
  }

  sharedFunctions.sort((left, right) => left.name.localeCompare(right.name));
  return sharedFunctions;
}

function applySharedFunctionData(perFile, sharedFunctions) {
  const sharedNamesByFile = new Map();
  const sharedFilesByFile = new Map();

  for (const group of sharedFunctions) {
    for (const filePath of group.files) {
      const nameSet = sharedNamesByFile.get(filePath) || new Set();
      nameSet.add(group.name);
      sharedNamesByFile.set(filePath, nameSet);

      const fileSet = sharedFilesByFile.get(filePath) || new Set();
      for (const otherFile of group.files) {
        if (otherFile !== filePath) fileSet.add(otherFile);
      }
      sharedFilesByFile.set(filePath, fileSet);
    }
  }

  for (const [filePath, metrics] of Object.entries(perFile)) {
    metrics.sharedFunctionNames = Array.from(sharedNamesByFile.get(filePath) || []).sort((a, b) => a.localeCompare(b));
    metrics.sharedFunctionalityWith = Array.from(sharedFilesByFile.get(filePath) || []).sort((a, b) => a.localeCompare(b));
    metrics.relatedFiles = Array.from(new Set([
      ...metrics.relatedFiles,
      ...metrics.sharedFunctionalityWith,
    ])).sort((a, b) => a.localeCompare(b));
  }
}

function withFileMetrics(items, perFile) {
  return items.map((node) => {
    if (node.type === 'directory') {
      return {
        ...node,
        children: withFileMetrics(node.children || [], perFile),
      };
    }

    return {
      ...node,
      metrics: perFile[node.path] || {
        lines: 0,
        functions: 0,
        functionNames: [],
        imports: [],
        importedBy: [],
        relatedFiles: [],
        sharedFunctionNames: [],
        sharedFunctionalityWith: [],
        analysis: undefined,
      },
    };
  });
}

export function readContractStructure(input = {}) {
  const { contractDir, contractPath } = resolveContractInput(input);
  return buildStructureTree(contractDir, contractPath);
}

export function getContractStructure(input = {}) {
  const { workspaceRoot, contractDir, contractPath } = resolveContractInput(input);
  const vmCatalog = loadCkbStdHighLevelApiCatalog(workspaceRoot);
  const items = buildStructureTree(contractDir, contractPath);
  const analysis = analyzePerFile(contractDir, contractPath, items, vmCatalog);
  const sharedFunctions = buildSharedFunctionIndex(analysis.perFile);

  applySharedFunctionData(analysis.perFile, sharedFunctions);

  return {
    ok: true,
    workspaceRoot,
    contractPath,
    contractDir,
    manifest: analysis.manifest,
    items: withFileMetrics(items, analysis.perFile),
    stats: {
      ...analysis.stats,
      sharedFunctionGroups: sharedFunctions.length,
    },
    entrypointFiles: analysis.entrypointFiles,
    perFile: analysis.perFile,
    sharedFunctions,
  };
}

function usage() {
  console.log(
    'Usage:\n  node mod/structure.mjs <contractPath> [--config <path>] [--workspace <path>]',
  );
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }

  const positionals = [];
  let configPath;
  let workspaceRoot;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      configPath = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--workspace') {
      workspaceRoot = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length < 1) {
    throw new Error('Missing required arg: <contractPath>');
  }

  return {
    contractPath: String(positionals[0] || '').trim(),
    configPath,
    workspaceRoot,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = getContractStructure(args);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[structure] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
