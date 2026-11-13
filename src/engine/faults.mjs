/**
 * The fault catalog.
 *
 * A fault is a *plausible* way a repository breaks: the kind of damage that
 * looks like ordinary work in progress, not a synthetic red test. Every fault
 * is deterministic (it obeys the run's seeded generator), reversible (the
 * original bytes are kept sealed), and mechanically verifiable (a sealed check
 * decides whether the workspace actually works again).
 *
 * Each fault declares `apply(context)` which mutates the workspace and returns
 * the *evidence anchors* a correct diagnosis should name. Those anchors are the
 * ground truth for detection scoring, and they never reach the agent's side of
 * the fence — they go to `sealed/`.
 *
 * @module dsh-gauntlet/engine/faults
 */

import { isAbsolute, join, normalize, sep } from 'node:path';
import { readText, writeText, exists, sha256 } from './workspace.mjs';

/**
 * @typedef {object} FaultContext
 * @property {string} workspaceDir - The agent-visible copy being damaged.
 * @property {string} sealedDir - Ground truth and sealed checks.
 * @property {ReturnType<import('./rng.mjs').createRng>} rng - Seeded generator.
 * @property {string} target - Workspace-relative path this fault acts on.
 * @property {object} scenario - The loaded scenario record.
 */

/**
 * @typedef {object} FaultEvidence
 * @property {string} path - Workspace-relative path a diagnosis must name.
 * @property {string} category - One of the fault's declared issue kinds.
 * @property {string} detail - Human-readable statement of what went wrong.
 */

/**
 * @typedef {object} FaultApplication
 * @property {FaultEvidence[]} evidence - What a correct diagnosis should state.
 * @property {string[]} restored - Paths whose original bytes were sealed.
 * @property {string} [note] - One line for the post-run reveal.
 */

/**
 * Is this target absolute on any platform?
 *
 * `path.isAbsolute` answers for the running platform only, which makes a shared
 * scenario file behave differently on Windows and on Linux: `C:/Windows/win.ini`
 * is absolute on one and a harmless relative path on the other. A scenario is
 * data that people copy between machines, so the answer must not depend on where
 * it is read. A drive-letter or UNC prefix is refused everywhere, and the error
 * says "not workspace-relative" rather than "does not exist" — the second message
 * would invite someone to add the file to the workspace instead of fixing the
 * scenario.
 *
 * @param {string} target
 * @returns {boolean}
 */
function isAbsoluteAnywhere(target) {
  if (isAbsolute(target)) return true;
  if (target.startsWith('\\\\') || target.startsWith('//')) return true;
  return /^[A-Za-z]:[\\/]/.test(target);
}

/** Resolve a scenario target inside the workspace and refuse to escape it. */
function resolveTarget(workspaceDir, target) {
  if (typeof target !== 'string' || target === '') {
    throw new Error('a fault needs a non-empty target path');
  }
  if (isAbsoluteAnywhere(target)) throw new Error(`target must be workspace-relative: ${target}`);
  const full = normalize(join(workspaceDir, target));
  const root = normalize(workspaceDir);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`target escapes the workspace: ${target}`);
  }
  return full;
}

/** Read a required file, with a message that names the scenario defect. */
function requireFile(full, target) {
  const text = readText(full);
  if (text === null) {
    throw new Error(`scenario target does not exist: ${target}`);
  }
  return text;
}

/** Seal the pre-damage bytes so the run can be verified and revealed. */
function seal(sealedDir, workspaceDir, target, original) {
  const record = {
    path: target,
    bytes: Buffer.byteLength(original, 'utf8'),
    sha256: sha256(original),
    content: original,
  };
  writeText(join(sealedDir, 'restore', target.replace(/[\\/]/g, '__') + '.json'), JSON.stringify(record, null, 2));
  return target;
}

/**
 * Truncate a source file mid-expression.
 *
 * The damage is deliberately at a boundary that produces a *plausible* error:
 * a truncated file usually fails to parse, but the reported line is the last
 * line of the file, which points at the symptom rather than the cause. Agents
 * that trust the error position "fix" the tail and leave the file broken.
 */
const silentTruncation = {
  id: 'silent-truncation',
  label: { en: 'Silent truncation', zh: '静默截断' },
  category: 'integrity',
  summary: {
    en: 'A source file lost its tail; the failure surfaces at the last surviving line, not at the damage.',
    zh: '某源文件丢了尾部，报错落在存活的最后一行，而不是真正受损处。',
  },
  evidenceKinds: ['truncated-file', 'incomplete-source', 'lost-tail'],
  apply({ workspaceDir, sealedDir, rng, target }) {
    const full = resolveTarget(workspaceDir, target);
    const original = requireFile(full, target);
    const lines = original.split('\n');
    // Keep a deterministic prefix, but never an empty file: a 0-byte file is a
    // different (easier) signal than a plausible partial edit.
    const keep = Math.max(2, Math.floor(lines.length * (0.55 + rng.next() * 0.2)));
    const damaged = lines.slice(0, keep).join('\n') + '\n';
    writeText(full, damaged);
    return {
      evidence: [
        { path: target, category: 'truncated-file', detail: `file ends early, after ${keep} of ${lines.length} lines` },
      ],
      restored: [seal(sealedDir, workspaceDir, target, original)],
      note: `${target}: kept ${keep}/${lines.length} lines`,
    };
  },
};

/**
 * Turn a real implementation into a stub that reports success.
 *
 * This is the fault that punishes "run the tests and believe them". The function
 * keeps its signature and returns a *well-shaped* value, so nothing throws and
 * the happy-path test still passes; only a behavioural check that inspects the
 * value's content catches it.
 */
const lyingSuccess = {
  id: 'lying-success',
  label: { en: 'Lying success', zh: '谎报成功' },
  category: 'truth',
  summary: {
    en: 'An implementation was replaced by a stub that returns a well-shaped empty result and never fails.',
    zh: '某个实现被换成返回"形状正确"的空结果的桩，永不失败。',
  },
  evidenceKinds: ['stubbed-implementation', 'no-op-body', 'silent-empty-result'],
  apply({ workspaceDir, sealedDir, rng, target, scenario }) {
    const full = resolveTarget(workspaceDir, target);
    const original = requireFile(full, target);
    const stub = scenario?.stubs?.[target];
    if (typeof stub !== 'string') {
      throw new Error(`scenario has no stub body for ${target}`);
    }
    const marker = `\n// gauntlet:${rng.int(1000, 9999)}\n`;
    writeText(full, stub.replace(/\s*$/, '\n') + marker);
    return {
      evidence: [
        { path: target, category: 'stubbed-implementation', detail: 'the exported function returns an empty result instead of computing one' },
      ],
      restored: [seal(sealedDir, workspaceDir, target, original)],
      note: `${target}: replaced by a compile-clean stub`,
    };
  },
};

/**
 * Weaken the tests *and* break what they claim to cover.
 *
 * The order matters and is the point of this fault: a weakened assertion alone is
 * harmless (the code is fine, the test is just useless), and a regression alone
 * is caught. Both together are the real-world failure — someone relaxed a test
 * because it was "flaky", and the bug it existed to catch walked in behind it.
 *
 * `scenario.weaken` supplies the damaged test, `scenario.regress` the damaged
 * implementation. A scenario that supplies only one of the two is refused,
 * because either half alone is a different, easier exercise.
 */
const falseGreen = {
  id: 'false-green',
  label: { en: 'False green suite', zh: '假绿灯套件' },
  category: 'truth',
  summary: {
    en: 'An assertion was relaxed and the behaviour it covered regressed in the same breath, so the suite is green over a real bug.',
    zh: '断言被放宽，同时它所覆盖的行为回归了；于是在真 bug 之上，套件是绿的。',
  },
  evidenceKinds: ['weakened-assertion', 'skipped-case', 'test-tampering'],
  apply({ workspaceDir, sealedDir, rng, target, scenario }) {
    const full = resolveTarget(workspaceDir, target);
    const original = requireFile(full, target);
    const damaged = scenario?.weaken?.[target];
    if (typeof damaged !== 'string') {
      throw new Error(`scenario has no weakened body for ${target}`);
    }
    // The regression is what makes the weakened assertion dangerous. Without it
    // this fault only makes the suite useless, which is a different lesson.
    const regressionTarget = scenario?.regress?.target;
    const regressionBody = scenario?.regress?.body;
    if (typeof regressionTarget !== 'string' || typeof regressionBody !== 'string') {
      throw new Error('false-green needs scenario.regress.{target,body}');
    }
    const regressionFull = resolveTarget(workspaceDir, regressionTarget);
    const regressionOriginal = requireFile(regressionFull, regressionTarget);

    writeText(regressionFull, regressionBody.replace(/\s*$/, '\n'));
    writeText(full, damaged.replace(/\s*$/, '\n'));
    return {
      evidence: [
        { path: target, category: 'weakened-assertion', detail: 'the assertion no longer constrains the behaviour it names' },
        { path: regressionTarget, category: 'regressed-behaviour', detail: 'the behaviour the weakened test used to cover is now wrong' },
      ],
      restored: [
        seal(sealedDir, workspaceDir, regressionTarget, regressionOriginal),
        seal(sealedDir, workspaceDir, target, original),
      ],
      note: `${target}: assertion relaxed (${rng.int(2, 9)} lines); ${regressionTarget}: behaviour regressed`,
    };
  },
};

/**
 * Leave a half-finished rename: one call site changed, the rest not.
 *
 * This is the classic "it compiles because the old name still exists" damage.
 * It stays green under a build that only resolves at runtime, and fails only
 * when the specific path executes.
 */
const dirtyDiff = {
  id: 'dirty-diff',
  label: { en: 'Half-applied rename', zh: '半截重命名' },
  category: 'integrity',
  summary: {
    en: 'A rename was applied at one call site only; the code still parses, and the breakage is on a path a shallow test never takes.',
    zh: '重命名只改了一处调用点；代码仍能解析，故障藏在浅层测试走不到的路径上。',
  },
  evidenceKinds: ['partial-rename', 'inconsistent-call-site', 'half-applied-diff'],
  apply({ workspaceDir, sealedDir, target, scenario }) {
    const full = resolveTarget(workspaceDir, target);
    const original = requireFile(full, target);
    const from = scenario?.rename?.from;
    const to = scenario?.rename?.to;
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error('dirty-diff needs scenario.rename.{from,to}');
    }
    const occurrences = original.split(from).length - 1;
    if (occurrences === 0) throw new Error(`dirty-diff: "${from}" does not appear in ${target}`);
    // Rewrite exactly one occurrence: the first one that is not the definition.
    let replaced = false;
    const damaged = original
      .split('\n')
      .map((line) => {
        if (replaced || !line.includes(from)) return line;
        if (/^\s*(?:export\s+)?(?:async\s+)?function\s+/.test(line) && line.includes(from)) return line;
        replaced = true;
        return line.replace(from, to);
      })
      .join('\n');
    writeText(full, replaced ? damaged : original.replace(from, to));
    return {
      evidence: [
        { path: target, category: 'partial-rename', detail: `one call site was renamed from ${from} to ${to}; the definition was not` },
      ],
      restored: [seal(sealedDir, workspaceDir, target, original)],
      note: `${target}: ${from} → ${to} at 1 of ${occurrences} sites`,
    };
  },
};

/**
 * Delete a module that nothing imports statically.
 *
 * A dynamic import, a plugin registry, or a CLI subcommand table reaches the
 * file at runtime only. Static analysis and `node --check` both pass.
 */
const removedFile = {
  id: 'removed-file',
  label: { en: 'Vanished module', zh: '消失的模块' },
  category: 'dependency',
  summary: {
    en: 'A module reached only at runtime was deleted; every static check passes and the failure waits for one code path.',
    zh: '只被运行时加载的模块被删了；所有静态检查都通过，故障在等某条代码路径。',
  },
  evidenceKinds: ['missing-module', 'deleted-file', 'dangling-import'],
  apply({ workspaceDir, sealedDir, target }) {
    const full = resolveTarget(workspaceDir, target);
    const original = requireFile(full, target);
    const doomed = join(sealedDir, 'doomed');
    writeText(join(doomed, target.replace(/[\\/]/g, '__') + '.json'), JSON.stringify({ path: target, content: original }, null, 2));
    writeText(full, '');
    // An empty file is worse than an absent one for the agent: it imports
    // cleanly with no exports, so the error text points at the consumer.
    return {
      evidence: [
        { path: target, category: 'missing-module', detail: 'the module exists but exports nothing, so runtime lookup fails at the consumer' },
      ],
      restored: [seal(sealedDir, workspaceDir, target, original)],
      note: `${target}: emptied, not deleted`,
    };
  },
};

/**
 * Replace one exact, whole-token occurrence of a value.
 *
 * `String.replace` is wrong here: searching for `10000` in a file that also
 * contains `100000000` hits the longer number's prefix and silently changes the
 * wrong constant. The value therefore has to stand alone — not preceded or
 * followed by an identifier character — and the first such occurrence wins.
 *
 * @param {string} original - File contents.
 * @param {string} from - Value to replace.
 * @param {string} to - Replacement.
 * @returns {{text: string, replaced: boolean}}
 */
function replaceWholeToken(original, from, to) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w.$])${escape(from)}(?![\\w.])`);
  const match = pattern.exec(original);
  if (match === null) return { text: original, replaced: false };
  const before = original.slice(0, match.index);
  const after = original.slice(match.index + match[0].length);
  return { text: before + to + after, replaced: true };
}

/**
 * Replace a build/config value with one that is syntactically fine but wrong.
 *
 * A port, a path, a tolerance, or an output directory. Everything runs; the
 * artifact is simply not where the next step looks, or is subtly the wrong one.
 */
const brokenConfig = {
  id: 'broken-config',
  label: { en: 'Plausible config drift', zh: '貌似合理的配置漂移' },
  category: 'config',
  summary: {
    en: 'A config value changed to another valid value: nothing errors, the pipeline just reads and writes the wrong thing.',
    zh: '配置值被换成了另一个合法值：不报错，流水线只是读写错了对象。',
  },
  evidenceKinds: ['config-drift', 'wrong-path', 'silent-misconfiguration'],
  apply({ workspaceDir, sealedDir, target, scenario }) {
    const full = resolveTarget(workspaceDir, target);
    const original = requireFile(full, target);
    const from = scenario?.config?.from;
    const to = scenario?.config?.to;
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error('broken-config needs scenario.config.{from,to}');
    }
    const { text, replaced } = replaceWholeToken(original, from, to);
    if (!replaced) {
      throw new Error(`broken-config: "${from}" does not appear as a whole token in ${target}`);
    }
    writeText(full, text);
    return {
      evidence: [
        { path: target, category: 'config-drift', detail: `"${from}" was changed to "${to}", a value that parses but points at the wrong target` },
      ],
      restored: [seal(sealedDir, workspaceDir, target, original)],
      note: `${target}: ${from} → ${to}`,
    };
  },
};

/**
 * Make an artifact stale relative to its source.
 *
 * The build output, lockfile, or generated file is replaced by an older valid
 * copy. Rebuild-on-demand masks it; incremental or cached flows do not.
 */
const staleArtifact = {
  id: 'stale-artifact',
  label: { en: 'Stale artifact', zh: '陈旧产物' },
  category: 'build',
  summary: {
    en: 'A generated artifact is older than its source, so a cached or incremental flow ships the previous behaviour.',
    zh: '生成物比源旧；缓存或增量流程会把上一版行为发布出去。',
  },
  evidenceKinds: ['stale-output', 'out-of-date-artifact', 'cache-mismatch'],
  apply({ workspaceDir, sealedDir, target, scenario }) {
    const full = resolveTarget(workspaceDir, target);
    const original = requireFile(full, target);
    const stale = scenario?.stale?.[target];
    if (typeof stale !== 'string') throw new Error(`scenario has no stale body for ${target}`);
    writeText(full, stale.replace(/\s*$/, '\n'));
    return {
      evidence: [
        { path: target, category: 'stale-output', detail: 'the generated file does not match the source it claims to be built from' },
      ],
      restored: [seal(sealedDir, workspaceDir, target, original)],
      note: `${target}: rolled back to an earlier valid build`,
    };
  },
};

/** Every fault, by id. */
export const FAULTS = Object.freeze({
  [silentTruncation.id]: silentTruncation,
  [lyingSuccess.id]: lyingSuccess,
  [falseGreen.id]: falseGreen,
  [dirtyDiff.id]: dirtyDiff,
  [removedFile.id]: removedFile,
  [brokenConfig.id]: brokenConfig,
  [staleArtifact.id]: staleArtifact,
});

/** Every fault as a list, in catalog order. */
export const FAULT_LIST = Object.freeze(Object.values(FAULTS));

/**
 * Look up a fault, with a message that lists the real ids.
 * @param {string} id - Fault id.
 */
export function faultById(id) {
  const fault = FAULTS[id];
  if (fault === undefined) {
    throw new Error(`unknown fault "${id}"; known faults: ${Object.keys(FAULTS).join(', ')}`);
  }
  return fault;
}

/**
 * Apply one declared fault. Kept as a function so a bad scenario fails before
 * it can half-damage a workspace.
 * @param {{id: string, target: string}} declaration - Scenario fault entry.
 * @param {FaultContext} context - Where to apply it.
 */
export function applyFault(declaration, context) {
  const fault = faultById(declaration.id);
  if (!exists(context.workspaceDir)) throw new Error(`workspace does not exist: ${context.workspaceDir}`);
  const result = fault.apply({ ...context, target: declaration.target });
  return { id: fault.id, target: declaration.target, ...result };
}
