# Task: complete the slug rules

`slugify(text)` in `src/slug.js` turns a title into a URL slug. The visible suite covers the simple
case; the task states the remaining rules in prose, and **all** of them are required:

1. lowercase everything;
2. runs of whitespace become a single `-`;
3. a run of characters that are not letters, digits or whitespace becomes a single `-`
   (so `a!!!b` → `a-b`, and `a?! b` → `a-b`);
4. leading and trailing `-` are removed (so `" Hello "` → `hello`);
5. `_` is NOT a separator: it is removed outright, joining the words (so `a_b` → `ab`);
6. an empty or whitespace-only input returns `''`.

`README.md` states the same contract.
