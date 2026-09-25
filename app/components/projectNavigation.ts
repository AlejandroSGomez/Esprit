/** Search only filenames reachable through broker-issued handles. Never interpret paths as authority. */
export type SearchFile = { id: string; name: string; relativePath: string; kind: 'file'; size: number; modified: number; sensitive: boolean };
type Entry = Omit<SearchFile, 'relativePath' | 'kind'> & { kind: 'file' | 'directory' | 'symlink' | 'other' };
type Directory = { directory_id: string; entries: Entry[]; truncated: boolean };
const excludedFolders = new Set(['results', 'data', 'figures', 'figs', 'logs', 'archive', 'dist', 'out', 'build', 'target', 'node_modules', '__pycache__', '.git', '.next', '.esprit-latex', '.ipynb_checkpoints']);
export const searchProjectFiles = async (
  root: Directory,
  list: (id: string) => Promise<Directory>,
  cancelled: () => boolean,
  showHidden = false,
  limits = { directories: 40, entries: 3500, files: 1500, depth: 8 },
): Promise<{ files: SearchFile[]; directories: number; limited: boolean }> => {
  const queue = [{ id: root.directory_id, path: '', depth: 0, directory: root as Directory | undefined }];
  const visited = new Set<string>();
  const files: SearchFile[] = [];
  let inspected = 0;
  let limited = false;
  while (queue.length && !cancelled()) {
    if (visited.size >= limits.directories || inspected >= limits.entries || files.length >= limits.files) { limited = true; break; }
    const item = queue.shift()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    let directory: Directory;
    try { directory = item.directory ?? await list(item.id); }
    catch { limited = true; continue; }
    if (cancelled()) break;
    limited ||= directory.truncated;
    for (const entry of directory.entries) {
      if (inspected >= limits.entries || files.length >= limits.files) { limited = true; break; }
      inspected += 1;
      if (entry.sensitive || (!showHidden && entry.name.startsWith('.'))) continue;
      const relativePath = item.path ? `${item.path}/${entry.name}` : entry.name;
      if (entry.kind === 'file') files.push({ ...entry, kind: 'file', relativePath });
      else if (entry.kind === 'directory' && !excludedFolders.has(entry.name.toLocaleLowerCase('en'))) {
        if (item.depth < limits.depth) queue.push({ id: entry.id, path: relativePath, depth: item.depth + 1, directory: undefined });
        else limited = true;
      }
    }
  }
  return { files, directories: visited.size, limited: limited || cancelled() };
};
