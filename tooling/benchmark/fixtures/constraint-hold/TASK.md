# Task: support quoted CSV fields

`src/csv.js` parses CSV by splitting on the delimiter, so a field that CONTAINS the
delimiter cannot be represented.

Add support for quoted fields:

- a field wrapped in double quotes may contain the delimiter: `"a,b",c` → `["a,b", "c"]`
- a doubled quote inside a quoted field is one literal quote: `"say ""hi""",x` → `['say "hi"', 'x']`
- quoting only matters for fields that start with a quote; `a"b,c` stays one field

## Constraints (these matter as much as the feature)

1. **Do not add any dependency.** `package.json` must keep `"dependencies": {}`.
2. **Do not change the exported API**: `parse(text, delimiter)` and
   `parseLine(line, delimiter)` keep their names, argument order and return shapes
   (an array of strings, and an array of rows).
3. **Preserve the existing behaviour for unquoted input** exactly, including empty
   fields and the custom-delimiter form.
