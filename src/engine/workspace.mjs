/**
 * Filesystem primitives, so every other module handles text rather than bytes.
 *
 * The gauntlet manipulates a *copy* of a workspace, never the caller's tree, and
 * it needs four guarantees from this layer: reads that never throw for a missing
 * file, writes that create parents, a content hash that is stable across
 * platforms, and a directory walk that cannot follow a symlink out of the tree.
 *
 * @module dsh-gauntlet/engine/workspace
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Directories never worth copying into a fresh workspace. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.dsh-gauntlet', '.venv', '__pycache__', '.cache']);

/** `true` when the path exists, without following a broken link's target. */
export function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a UTF-8 file, or `null` when it is missing. Never throws on ENOENT: a
 * fault target that does not exist is reported by the fault, not by the reader.
 * @param {string} path - Absolute path.
 * @returns {string | null}
 */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return null;
    throw error;
  }
}

/** Write a UTF-8 file, creating parents. */
export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * Write by rename, so a reader never sees a half-written file. Used for the
 * ledger and the run record, both of which another process may poll.
 */
export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, path);
}

/** Read a JSON file, or `null`. A corrupt file is `null`, never a throw. */
export function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Write pretty JSON. */
export function writeJson(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Stable content hash: SHA-256 over the UTF-8 bytes. */
export function sha256(text) {
  return createHash('sha256').update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).digest('hex');
}

/** `true` when the path is a directory. */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Remove a path, tolerating absence. */
export function remove(path) {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Copy a workspace, skipping the directories a code agent never needs and that
 * would make a copy slow or huge.
 *
 * Symlinks are copied as links rather than followed, so a hostile scenario
 * cannot pull an unrelated tree into the run.
 *
 * @param {string} from - Source directory.
 * @param {string} to - Destination (created).
 * @returns {number} How many files were copied.
 */
export function copyTree(from, to) {
  if (!isDirectory(from)) throw new Error(`not a directory: ${from}`);
  remove(to);
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isSymbolicLink()) {
      cpSync(source, destination, { recursive: false, verbatimSymlinks: true });
      count += 1;
      continue;
    }
    if (entry.isDirectory()) {
      count += copyTree(source, destination);
      continue;
    }
    if (entry.isFile()) {
      cpSync(source, destination);
      count += 1;
    }
  }
  return count;
}

/**
 * Every file under a directory, as workspace-relative POSIX paths, sorted.
 *
 * The sort is what makes a manifest diffable between runs. Symlinks are skipped
 * outright: following one would let the walk read outside the tree.
 *
 * @param {string} root - Directory to walk.
 * @param {{ skip?: (relativePath: string) => boolean }} [options]
 * @returns {string[]}
 */
export function listFiles(root, options = {}) {
  const skip = options.skip ?? (() => false);
  const found = [];
  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (skip(rel)) continue;
      found.push(rel);
    }
  }
  walk(root);
  return found.sort();
}

/**
 * A deterministic snapshot of a tree: `{ path: sha256 }` for every file.
 * Two snapshots being equal means the workspace is byte-identical, which is the
 * strongest statement a verification can make and the cheapest to compute.
 */
export function snapshot(root) {
  const files = {};
  for (const rel of listFiles(root)) {
    const text = readText(join(root, rel));
    files[rel] = text === null ? 'unreadable' : sha256(text);
  }
  return files;
}

/**
 * Snapshot difference, in both directions.
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 */
export function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, hash] of Object.entries(after)) {
    if (!(path in before)) added.push(path);
    else if (before[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) removed.push(path);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Resolve `candidate` against `root` and refuse anything that lands outside it.
 * Every path that comes from a scenario, a ledger record, or a model argument
 * goes through here.
 * @param {string} root - Trusted root.
 * @param {string} candidate - Possibly hostile relative path.
 * @returns {string} Absolute path inside the root.
 */
export function contain(root, candidate) {
  const base = resolve(root);
  const full = resolve(base, candidate);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`path escapes ${base}: ${candidate}`);
  }
  return full;
}
