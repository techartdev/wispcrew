/**
 * workspace.ts — the one place a tool decides whether a path is allowed.
 *
 * Hard rule 6 says file tools stay inside the workspace root. It was true of
 * `read_file`, `write_file`, `list_dir` and `edit_file` — and quietly false
 * of `grep` and `shell`, which each resolved a model-supplied path their own
 * way and checked nothing.
 *
 * How that looked from outside: an agent whose workspace was
 * `D:\Mine\OpenClawHomeAssistant` reported the repository there as
 * `techartdev/wispcrew`, because its shell had run somewhere else entirely.
 * It was not lying; it was reading a real answer from the wrong folder, and
 * then reasoning confidently on top of it. A boundary that holds for four
 * tools out of six is worse than none, because the prompt promises it.
 *
 * The specific trap, and the reason two implementations were not enough:
 *
 *     path.resolve('/workspace', '/etc')   // => '/etc'
 *
 * `path.resolve` DISCARDS everything to the left of an absolute segment. So
 * the natural-looking `path.resolve(root, args.path)` silently honours any
 * absolute path a model supplies. It reads like containment and is not.
 */
import path from 'node:path';

/** Raised when a requested path lies outside the workspace root. */
export class PathOutsideWorkspaceError extends Error {
  readonly target: string;
  readonly root: string;

  constructor(target: string, root: string) {
    super(
      `${target} is outside this agent's workspace (${root}). ` +
        'Paths are confined to the workspace folder; change it in the agent\u2019s ' +
        'Configure panel if it should be somewhere else.',
    );
    this.name = 'PathOutsideWorkspaceError';
    this.target = target;
    this.root = root;
  }
}

/** The workspace root for this call, absolute. */
export function workspaceRootOf(ctx: { workspaceRoot?: string }): string {
  return path.resolve(ctx.workspaceRoot || process.cwd());
}

/**
 * Is `target` the root itself, or inside it?
 *
 * Compared with a trailing separator so `/workspace-other` is not treated as
 * living inside `/workspace` — a prefix match without it accepts any sibling
 * whose name merely starts the same way.
 */
export function isInsideRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Resolve a model-supplied path against the workspace, or refuse.
 *
 * Relative paths behave as expected. An absolute path is accepted only if it
 * already points inside the workspace, which keeps the common case — a model
 * echoing back a path a tool just printed — working, while an absolute path
 * to somewhere else is refused rather than silently honoured.
 *
 * `..` is handled by resolving first and comparing afterwards, so no amount
 * of traversal in the middle of a path can climb out.
 */
export function resolveInRoot(ctx: { workspaceRoot?: string }, p: string): string {
  const root = workspaceRootOf(ctx);
  const target = path.resolve(root, p);
  if (!isInsideRoot(target, root)) throw new PathOutsideWorkspaceError(target, root);
  return target;
}
