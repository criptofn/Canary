`IdLookup.uniquePrefix` decides whether a prefix is ambiguous with a REFERENCE comparison on the mapped value:

```java
if (match != null && match != entry.getValue()) return null;
```

Two different keys that map to the same value (the same `Player` registered under two ids, or two equal strings that are not the same object) therefore look like one match, and the method returns a value for a prefix that matches more than one id — directly contradicting the class contract: "Ein Präfix darf niemals zufällig den ersten Treffer wählen."

Fix it so ambiguity is decided by the number of matching KEYS: `uniquePrefix` must return `null` whenever more than one key matches the prefix, whatever those keys map to, and must keep returning the mapped value when exactly one key matches. Exact (case-insensitive) key matches must keep winning as they do today.

Add a JUnit test to `src/test/java/net/schniedelsmp/smp/util/IdLookupTest.java` that fails before your fix and passes after it.
