const fileObjectIds = new WeakMap<object, number>();
let nextFileObjectId = 1;

/**
 * Dedupe only the exact same File object appearing twice in one browser
 * selection. Browser APIs do not expose a globally unique path: two distinct
 * roots can share relative path, size, and timestamp, so metadata-derived keys
 * would silently discard an ambiguous but valid input.
 */
export function fileIdentityKey(file: object) {
  let id = fileObjectIds.get(file);
  if (id == null) {
    id = nextFileObjectId;
    nextFileObjectId += 1;
    fileObjectIds.set(file, id);
  }
  return `file-object:${id}`;
}
