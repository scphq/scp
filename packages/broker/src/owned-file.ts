import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"

/** Opens a regular file owned by this uid without blocking on a special file. */
export function openOwnedFile(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  const stat = fstatSync(fd)
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
    closeSync(fd)
    throw new Error("file is not regular or owned by this uid")
  }
  return fd
}

export function readOwnedFile(path: string): string {
  const fd = openOwnedFile(path)
  try {
    return readFileSync(fd, "utf8")
  } finally {
    closeSync(fd)
  }
}
