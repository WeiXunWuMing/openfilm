// @ts-check
import { posix } from 'node:path';
import { listFiles } from '../studio/server/files.mjs';
import { projectAround } from './skills-cli.mjs';

/** Read-only metadata, using the media pane's traversal and linked-place checks. @param {string[]} args */
export async function mediaCommand(args, { cwd = process.cwd() } = {}) {
  const project = projectAround(cwd);
  if (!project) return { ok: false, usage: true, lines: ['Not in an OpenFilm project. Run this command in the film folder.'] };
  const path = posix.normalize((args[0] ?? 'assets').replaceAll('\\', '/')).replace(/\/$/, '');
  if (args.length > 1 || (path !== 'assets' && !path.startsWith('assets/'))) {
    return { ok: false, usage: true, lines: ['Use openfilm media [assets/folder-or-file].'] };
  }
  const listing = await listFiles(project);
  const under = (/** @type {string} */ entry) => entry === path || entry.startsWith(`${path}/`);
  return { ok: true, lines: [JSON.stringify({
    path,
    files: listing.files.filter((file) => under(file.path)),
    folders: listing.folders.filter(under),
    links: Object.fromEntries(Object.entries(listing.links).filter(([entry]) => under(entry) || path.startsWith(`${entry}/`))),
    ...(listing.unreadable ? { unreadable: listing.unreadable.filter((entry) => under(entry) || path.startsWith(`${entry}/`) || entry === '.') } : {}),
    ...(listing.truncated ? { truncated: listing.truncated.filter((entry) => under(entry) || path.startsWith(`${entry}/`)) } : {}),
  }, null, 2)] };
}
