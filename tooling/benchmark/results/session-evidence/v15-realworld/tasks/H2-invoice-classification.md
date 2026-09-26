In `src/workflows/fileOrganizer.js`, the `invoices` rule only fires for `.pdf`, `.docx` and `.xlsx`:

```js
{ group: "invoices", test: (name, ext) => [".pdf", ".docx", ".xlsx"].includes(ext) && /(rechnung|invoice|receipt|beleg|tax)/i.test(name) },
```

so `Rechnung_2026-03.txt` or `invoice-2026.md` is filed under `documents` even though the name says exactly what it is.

Make a name-based invoice match win for every document extension this module already handles: `.pdf`, `.doc`, `.docx`, `.txt`, `.md`, `.xlsx`, `.pptx`. The `invoices` group must still be evaluated before the generic `documents` group, and no other group may change its classification.
