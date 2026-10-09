/**
 * The image and video files carried by a paste or a drop, ignoring anything else.
 *
 * The files list is read first and alone when it has anything. An image pasted
 * from another application — a picture copied out of a browser, say — can be
 * offered through the items list in more than one encoding, as several files for
 * one picture, while the files list holds it once; reading items alongside files
 * then attaches the same image twice. Items is only read when files is empty,
 * which is the case for a few drag sources. Files within one list are still
 * deduplicated by the metadata that identifies them, name, size, type and last
 * modified, since two distinct File objects can represent the one picture.
 */
export function mediaFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];

  const files: File[] = [];
  const seen = new Set<string>();
  const add = (file: File | null | undefined): void => {
    if (!file) return;
    // An empty type happens on a few platforms; the server has the last word.
    if (file.type !== '' && !file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
    const key = `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  if (data.files.length > 0) {
    for (let index = 0; index < data.files.length; index++) add(data.files[index] ?? null);
    return files;
  }
  for (let index = 0; index < data.items.length; index++) {
    const item = data.items[index];
    if (item?.kind === 'file') add(item.getAsFile());
  }

  return files;
}

/** Whether a drag is carrying files at all, as opposed to text or a selection. */
export function dragHasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}
