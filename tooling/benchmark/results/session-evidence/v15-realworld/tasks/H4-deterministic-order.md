In `src/workflows/fileOrganizer.js`, `previewOrganization` builds `moves` in whatever order `fs.readdir` happens to return, so the same directory can produce a differently ordered preview on different filesystems or runs. Every other output of the function is derived from the file metadata and is stable, so the order is the only non-deterministic part.

Make the preview deterministic: the returned `moves` array must be ordered by file name, ascending, using a locale-independent comparison. Do not change which files are selected, what each entry contains, or any other behaviour.
