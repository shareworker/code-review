import { minimatch } from "minimatch";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MatchRulesResult, PathRule, RulesConfig } from "./types.js";

/**
 * Built-in generic default rule, aligned with open-code-review's default.md.
 * Covers correctness, security, performance, maintainability, test coverage.
 * Used as the final fallback when no user rule and no language-specific rule matches.
 */
export const BUILT_IN_DEFAULT_RULE = `#### Correctness
Is the logic correct? Are there missing boundary conditions?
Are exceptions handled properly?
Is it thread-safe in concurrent scenarios?

#### Security
Are there security vulnerabilities such as SQL injection or XSS?
Is sensitive information handled correctly?
Is permission validation complete?

#### Performance
Are there obvious performance issues (e.g., N+1 queries, unnecessary loops)?
Are resources properly released?

#### Maintainability
Is the code clear and easy to understand?
Do names accurately express intent?
Does it follow the project's existing code style and architecture patterns?

#### Test Coverage
Do critical logic paths have corresponding test cases?
Do test cases cover boundary conditions?`;

/**
 * Built-in language/file-type-specific rules.
 * First match wins (by pattern order). When a path matches one of these,
 * the corresponding rule text replaces the generic default. The patterns
 * are matched case-insensitively against the normalized path.
 *
 * Content is originally written for this project (not copied from
 * alibaba/open-code-review's rule_docs) to avoid Apache-2.0 attribution
 * obligations under this project's MIT license.
 */
export const BUILT_IN_LANGUAGE_RULES: PathRule[] = [
  {
    pattern: "**/*.{ts,tsx,js,jsx,mjs,cjs}",
    rule: `#### TypeScript / JavaScript
- **Type safety**: Avoid \`any\` where a narrower type is feasible; prefer \`unknown\` for opaque values and narrow with type guards. Flag implicit \`any\` from untyped parameters or missing return types on exported functions.
- **Null/undefined handling**: Check for missing null guards on values that can be null/undefined. Prefer optional chaining (\`?.\`) and nullish coalescing (\`??\`) over truthy/falsy checks for null/undefined.
- **Async correctness**: Verify \`async\` functions are awaited or handled (unhandled promise rejections, missing \`await\`). Flag floating promises that swallow errors.
- **Module boundaries**: Check that imports resolve, are used, and follow the project's module style (ESM vs CJS). Flag circular imports and barrel-file re-exports that defeat tree-shaking.
- **React (TSX/JSX)**: Verify hooks rules (no conditional hooks, exhaustive deps in useEffect), key props on lists, and that side effects are not placed in render bodies.
- **Security**: Flag \`eval\`, \`new Function\`, \`innerHTML\` with dynamic content, and unescaped user input in templates. Check for prototype pollution vectors (e.g., \`Object.assign\` with user input).
- **Dead code**: Flag unreachable code after early returns, unused exports, and commented-out blocks. Use \`search_code\` to confirm a symbol has no other callers before flagging as dead.`,
  },
  {
    pattern: "**/package.json",
    rule: `#### package.json
- **Dependency hygiene**: Flag unused dependencies (not imported anywhere in source). Flag missing or overly loose version ranges (\`*\`, \`latest\`) that can pull in unvetted releases.
- **Scripts**: Verify scripts referenced in \`scripts\` exist and are correct (e.g., \`build\` calls the right tool). Flag scripts that reference missing files.
- **Security**: Flag postinstall/preinstall scripts that run arbitrary code — these are supply-chain risk vectors. Check for pinned vs floating dependency versions in production deps.
- **Metadata**: Verify \`name\`, \`version\`, \`license\` are present and correct. Flag \`private: false\` on packages not intended for public publish.
- **Engines**: Check \`engines\` matches the project's actual runtime requirements.`,
  },
  {
    pattern: "**/*.json",
    rule: `#### JSON
- **Schema correctness**: Verify the JSON matches its expected schema (e.g., tsconfig.json fields, .eslintrc structure). Flag unknown or misspelled keys that tools silently ignore.
- **Trailing commas**: JSON does not allow trailing commas — flag any. (JSONC files may allow them; check the file's consumer.)
- **Duplicate keys**: Flag duplicate object keys — the last value wins silently and is almost always a bug.
- **Security**: Flag secrets or tokens hardcoded in JSON config (e.g., \`*.json\` with \`password\`, \`token\`, \`apiKey\` fields).`,
  },
  {
    pattern: "**/*.{yaml,yml}",
    rule: `#### YAML
- **Indentation**: YAML is whitespace-sensitive — verify consistent indentation (spaces, not tabs). Flag mixed indent depths that change meaning.
- **Schema correctness**: Verify required keys are present and match the expected schema (e.g., GitHub Actions, docker-compose, Kubernetes). Flag unknown keys the consumer would silently ignore.
- **Anchors/aliases**: Flag unused anchors (\`&\`) and undefined aliases (\`*\`). Verify merge keys (\`<<:\`) reference existing anchors.
- **Quoting**: Flag unquoted strings that could be misinterpreted as booleans/numbers/null (e.g., \`yes\`, \`no\`, \`on\`, \`off\`, \`null\`, version-like strings like \`1.0\`).
- **Security**: Flag \`!!python/exec\` or other dangerous YAML tags that execute code on parse. Flag secrets in plaintext YAML.`,
  },
  {
    pattern: ".github/workflows/**",
    rule: `#### GitHub Actions Workflow
- **Injection (pull_request_target)**: Flag \`pull_request_target\` with \`checkout\` of the PR head — this runs with write secrets on untrusted code. Use \`github.event.pull_request.head.sha\` carefully and never run build/test steps on attacker-controlled code with secrets available.
- **Secret handling**: Verify secrets are referenced via \`secrets.<NAME>\` and not echoed in logs (\`::add-mask::\` or avoided). Flag secrets passed to actions that log their inputs.
- **Permissions**: Verify \`permissions:\` is set to least-privilege. Flag \`permissions: write-all\` or missing \`permissions\` block on workflows that handle untrusted input.
- **Pin actions by SHA**: Flag actions referenced by \`@v1\` or \`@main\` tags (mutable, supply-chain risk) instead of pinned SHAs.
- **Runner safety**: Flag \`runs-on\` with self-hosted runners on public repos without ephemeral provisioning.
- **Trigger correctness**: Verify \`on:\` triggers match intent (e.g., \`workflow_dispatch\` for manual, \`schedule:\` cron syntax). Flag overly broad triggers that run on every branch.`,
  },
  {
    pattern: "**/*.py",
    rule: `#### Python
- **Type hints**: Verify public functions have type annotations on parameters and return types. Flag \`Any\` used where a narrower type is feasible; prefer \`Unknown\`-style narrowing with \`isinstance\` or \`typing.TypeGuard\`.
- **Exception handling**: Flag bare \`except:\` and \`except Exception:\` that swallow errors silently. Verify exceptions are logged or re-raised, not silently passed. Flag \`raise\` without \`from\` when chaining is appropriate.
- **Security**: Flag \`eval()\`, \`exec()\`, \`os.system()\`, \`subprocess.call(shell=True)\` with dynamic input — these are injection vectors. Check for unsafe deserialization (\`pickle.loads\` on untrusted data, \`yaml.load\` without \`SafeLoader\`).
- **Resource management**: Verify files and connections use \`with\` statements or \`contextlib\` for cleanup. Flag \`open()\` without a context manager.
- **Mutability**: Flag mutable default arguments (\`def foo(x=[])\`) — a classic Python pitfall. Verify lists/dicts are not shared across calls unintentionally.
- **Async**: Flag \`async def\` without \`await\`, and \`await\` outside \`async\` functions. Check for blocking calls (\`time.sleep\`, \`requests.get\`) inside async functions that should use async equivalents.`,
  },
  {
    pattern: "**/*.go",
    rule: `#### Go
- **Error handling**: Flag ignored errors (\`_ = someFunc()\` without justification). Verify errors are checked (\`if err != nil\`) or explicitly wrapped with context (\`fmt.Errorf("...: %w", err)\`).
- **Goroutine leaks**: Flag \`go func()\` without a mechanism to stop or wait for the goroutine. Verify context cancellation (\`ctx.Done()\`) is respected in long-running goroutines.
- **Defer**: Flag \`defer\` in loops (resource won't be released until function returns). Verify \`defer\` is called immediately after resource acquisition, not after error checks that might return early.
- **Concurrency**: Flag shared mutable state accessed without synchronization (\`sync.Mutex\`, channels). Verify map concurrent access is protected — Go maps panic on concurrent writes.
- **Interface design**: Flag overly large interfaces (violation of Go's "accept interfaces, return structs" principle). Verify interfaces are defined at the consumer side, not the producer side.
- **Error wrapping**: Flag \`errors.New\` or \`fmt.Errorf\` without \`%w\` when wrapping an existing error — the original error becomes unreachable for \`errors.Is\`/\`errors.As\`.`,
  },
  {
    pattern: "**/*.java",
    rule: `#### Java
- **Exception handling**: Flag catching \`Exception\` or \`Throwable\` (too broad). Verify specific exception types are caught. Flag empty catch blocks — at minimum log the exception.
- **Resource management**: Verify \`try-with-resources\` is used for \`AutoCloseable\` resources (streams, connections, readers). Flag manual \`close()\` calls in \`finally\` blocks that don't handle exceptions.
- **Concurrency**: Flag shared mutable collections accessed from multiple threads without synchronization. Verify \`ConcurrentHashMap\`, \`synchronized\`, or \`java.util.concurrent\` primitives are used correctly.
- **Null handling**: Flag methods that return \`null\` where \`Optional<T>\` would be more appropriate. Verify callers check for null on methods known to return null.
- **Resource leaks**: Flag \`new Thread()\` without a thread pool (\`ExecutorService\`). Verify thread pools are shut down properly (\`shutdown()\` + \`awaitTermination()\`).
- **Security**: Flag \`Runtime.exec()\` or \`ProcessBuilder\` with user-controlled input (command injection). Check for SQL string concatenation instead of \`PreparedStatement\`.`,
  },
  {
    pattern: "**/*.{c,h,cpp,cc,cxx,c++,hpp,hh,hxx,h++}",
    rule: `#### C / C++
- **Memory safety**: Flag raw \`malloc\`/\`free\` or \`new\`/\`delete\` without a clear ownership story; prefer RAII (\`std::unique_ptr\`/\`std::shared_ptr\`) in C++. Flag manual memory management that can leak on early return or exception paths.
- **Buffer safety**: Flag \`strcpy\`, \`strcat\`, \`sprintf\`, \`gets\` — prefer bounded variants (\`strncpy\`, \`snprintf\`) or \`std::string\`. Verify array/pointer indexing has bounds checks; flag fixed-size buffers filled from untrusted or variable-length input.
- **Undefined behavior**: Flag signed integer overflow, use of uninitialized variables, out-of-bounds pointer arithmetic, and dereferencing after \`free\`/\`delete\` (use-after-free) or double-free.
- **Resource ownership (C++)**: Verify the Rule of Zero/Three/Five is followed when a class manages a resource (copy/move constructor, copy/move assignment, destructor). Flag raw pointers used as owning references; prefer smart pointers or containers.
- **Const-correctness & casts (C++)**: Flag \`const_cast\`, C-style casts, and \`reinterpret_cast\` used where a safer cast (\`static_cast\`) or design change would work. Verify member functions that don't mutate state are marked \`const\`.
- **Concurrency**: Flag shared mutable state accessed without synchronization (mutex, atomics). Verify locks are held via RAII (\`std::lock_guard\`/\`std::unique_lock\`) rather than manual \`lock()\`/\`unlock()\` pairs that can leak on exception.
- **Security**: Flag \`system()\`, \`exec*()\`, or \`popen()\` with unsanitized input (command injection). Check format string functions (\`printf\` family) for user-controlled format strings.`,
  },
  {
    pattern: "**/*.rs",
    rule: `#### Rust
- **Error handling**: Flag \`.unwrap()\`/\`.expect()\` on \`Result\`/\`Option\` in non-test, non-prototype code paths — prefer \`?\` propagation or explicit \`match\`/\`if let\` handling. Verify \`expect()\` messages are descriptive when used deliberately.
- **Unsafe code**: Flag \`unsafe\` blocks without a comment justifying the invariant being upheld (e.g. \`// SAFETY: ...\`). Verify raw pointer dereferences, \`transmute\`, and FFI boundaries are minimal and well-documented.
- **Ownership & borrowing**: Flag unnecessary \`.clone()\` calls that mask a borrow-checker issue rather than solving it. Verify lifetimes are not artificially widened (e.g. \`'static\` bounds) just to satisfy the compiler.
- **Panics**: Flag \`panic!\`, \`unreachable!\`, \`todo!\`, and indexing (\`v[i]\`) in library code paths that should return \`Result\` instead of aborting the caller's process. Prefer \`.get(i)\` over \`v[i]\` when the index isn't already bounds-checked.
- **Concurrency**: Verify \`Arc<Mutex<T>>\` (or equivalent) is used for shared mutable state across threads; flag \`Rc<RefCell<T>>\` used across thread boundaries (not \`Send\`/\`Sync\`). Check for potential deadlocks from nested lock acquisition.
- **Idioms**: Flag needless \`return\`, \`.to_owned()\`/\`.clone()\` where a reference would do, and manual implementations of iterator patterns that \`std::iter\` already provides.`,
  },
  {
    pattern: "**/*.qml",
    rule: `#### QML / Qt
- **Property bindings**: Flag imperative reassignment of a bound property from JavaScript (breaks the binding permanently) — prefer \`Binding\` elements or re-establish the binding explicitly if intentional. Watch for binding loops (property A depends on B which depends on A).
- **Object ownership**: Verify QML-instantiated \`QObject\`-derived objects created dynamically (\`Qt.createComponent\`, \`Component.createObject\`) have a clear parent for ownership, or are destroyed explicitly (\`destroy()\`) — otherwise they leak.
- **Signal/slot & connections**: Flag \`Connections\` targets that don't null-check after the target object may have been destroyed. Verify signal handlers (\`onXxx\`) don't perform heavy synchronous work that blocks the UI thread.
- **JavaScript in QML**: Flag non-trivial logic embedded directly in QML property bindings or signal handlers — prefer moving business logic to C++ or a separate JS module for testability. Flag deprecated \`Qt.include\` over ES module \`import\`.
- **Performance**: Flag large \`Repeater\`/\`ListView\` delegates with expensive bindings evaluated per-item; verify \`asynchronous: true\` is used for heavy \`Loader\`/\`Image\` where appropriate. Flag unnecessary property re-evaluation from over-broad bindings.
- **Versioning**: Verify \`import QtQuick <version>\` (and other module imports) pin a version compatible with the target Qt release; flag mismatched import versions across files in the same module.
- **C++/QML boundary**: When exposing C++ types to QML (\`Q_PROPERTY\`, \`Q_INVOKABLE\`, \`qmlRegisterType\`), verify \`Q_OBJECT\` is declared, properties have \`NOTIFY\` signals for bindability, and ownership semantics (\`QQmlEngine::ObjectOwnership\`) are set correctly for objects returned to QML.`,
  },
  {
    pattern: "**/*.xml",
    rule: `#### XML (SQL Mapper / Config)
- **SQL injection**: Flag \`$\{variable}\` interpolation in MyBatis mappers (SQL injection vector) — prefer \`#{parameter}\` which uses prepared statements. Verify dynamic SQL uses parameterized bindings.
- **Tag closure**: Verify all opened tags are properly closed. Flag mismatched open/close tags and self-closing tags for elements that should have content.
- **Namespace**: Verify XML namespaces are declared and used consistently. Flag undeclared namespace prefixes.
- **Entity expansion**: Flag external entity expansion (\`<!ENTITY ... SYSTEM>\`) — XXE (XML External Entity) attack vector. Verify the parser disables DTD processing for untrusted input.
- **Schema validation**: Verify the XML matches its declared schema or DTD. Flag missing required attributes or elements.`,
  },
  {
    pattern: "**/Dockerfile*",
    rule: `#### Dockerfile
- **Base image pinning**: Flag \`FROM latest\` or \`FROM node:18\` (mutable tag) — prefer full SHA pinning (\`FROM node:18@sha256:...\`) or at minimum a specific patch version. Mutable tags can change content unexpectedly.
- **Multi-stage builds**: Verify the final stage uses a minimal runtime image (\`alpine\`, \`distroless\`). Flag installing build tools in the final stage that aren't needed at runtime.
- **Non-root user**: Flag missing \`USER\` directive — containers should not run as root by default. Verify a non-root user is created and used.
- **Secrets**: Flag \`ENV\` or \`ARG\` with hardcoded secrets, passwords, or tokens. These persist in image layers and are recoverable. Use build-time secrets (\`--secret\` in BuildKit) or runtime mounts.
- **Layer efficiency**: Flag multiple \`RUN\` instructions that could be combined (each layer adds size). Verify \`apt-get install\` is followed by \`apt-get clean && rm -rf /var/lib/apt/lists/*\` in the same layer.
- **COPY scope**: Flag \`COPY . .\` in early stages that copies more than needed (slower builds, larger cache invalidation). Verify \`.dockerignore\` is used to exclude unnecessary files.`,
  },
];

/**
 * Match a path against the built-in language-specific rules (first match wins).
 * Case-insensitive, like matchPathRules.
 */
function matchBuiltInLanguageRules(path: string): PathRule | null {
  return matchPathRules(path, BUILT_IN_LANGUAGE_RULES);
}

/**
 * Load a rules.json file, returning null if missing or unparseable.
 * Parse failures log a warning and return null (caller falls back to default).
 * Accepts both `path` and `pattern` as the glob field key (spec uses `path`).
 */
async function loadRulesFile(dir: string): Promise<RulesConfig | null> {
  const filePath = join(dir, ".code-review", "rules.json");
  try {
    const content = await readFile(filePath, "utf8");
    const raw = JSON.parse(content) as any;
    // Normalize: rules entries may use `path` or `pattern` — map to `pattern`.
    if (raw?.rules && Array.isArray(raw.rules)) {
      raw.rules = raw.rules.map((r: any) => ({
        pattern: r.pattern ?? r.path,
        rule: r.rule,
      }));
    }
    return raw as RulesConfig;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null; // missing: silent fallback
    // Parse error or other failure: warn and fall back.
    console.warn(`[code-review-mcp] Failed to parse ${filePath}: ${err?.message ?? err}. Falling back to default rules.`);
    return null;
  }
}

/**
 * Match a file path against a list of path rules (first match wins).
 * Case-insensitive, supports glob patterns including ** and brace expansion.
 */
function matchPathRules(path: string, rules: PathRule[]): PathRule | null {
  const lowerPath = path.toLowerCase();
  for (const rule of rules) {
    if (minimatch(lowerPath, rule.pattern.toLowerCase())) {
      return rule;
    }
  }
  return null;
}

/**
 * Match review rules for a file path, returning a ready-to-use prompt_section.
 *
 * Priority: repo .code-review/rules.json > home ~/.code-review/rules.json > built-in default.
 * First match wins at each layer; the first layer with a match takes precedence.
 */
export async function matchRules(
  repo: string,
  path: string
): Promise<MatchRulesResult> {
  const normalizedPath = path.replace(/\\/g, "/");

  // Layer 1: repo rules.
  const repoConfig = await loadRulesFile(repo);
  if (repoConfig?.rules) {
    const matched = matchPathRules(normalizedPath, repoConfig.rules);
    if (matched) {
      return {
        path: normalizedPath,
        matchedRules: [matched],
        promptSection: formatPromptSection([matched.rule]),
        usedDefault: false,
      };
    }
  }

  // Layer 2: home rules.
  const homeConfig = await loadRulesFile(homedir());
  if (homeConfig?.rules) {
    const matched = matchPathRules(normalizedPath, homeConfig.rules);
    if (matched) {
      return {
        path: normalizedPath,
        matchedRules: [matched],
        promptSection: formatPromptSection([matched.rule]),
        usedDefault: false,
      };
    }
  }

  // Layer 3: built-in language-specific rules (e.g., TS/JS, JSON, YAML, GitHub Actions).
  const langMatch = matchBuiltInLanguageRules(normalizedPath);
  if (langMatch) {
    return {
      path: normalizedPath,
      matchedRules: [langMatch],
      promptSection: formatPromptSection([langMatch.rule]),
      usedDefault: true,
    };
  }

  // Layer 4: built-in generic default.
  return {
    path: normalizedPath,
    matchedRules: [],
    promptSection: formatPromptSection([BUILT_IN_DEFAULT_RULE]),
    usedDefault: true,
  };
}

/**
 * Format rule texts into a single prompt_section string.
 */
function formatPromptSection(rules: string[]): string {
  if (rules.length === 0) return "";
  if (rules.length === 1) return rules[0];
  return rules.map((r) => `- ${r}`).join("\n");
}
