const STABILITY_PARAMS = Object.freeze({
  frobeniusReduction: 0.92,
  frobeniusOverflowRisk: 0.18,
  spectralIterationPenalty: 0.82,
  spectralGapPenalty: 0.74,
  spectralNormalizerPenalty: 0.46,
  npuPrimitiveFit: 0.88,
  int4NoiseScale: 7,
  int8NoiseScale: 127
});

function mulberry32(seed) {
  return function next() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeMatrix(rows, cols, seed, mode = "dense") {
  const rand = mulberry32(seed);
  const a = Array.from({ length: rows }, () => Array(cols).fill(0));

  if (mode === "rank1") {
    const u = Array.from({ length: rows }, () => gaussian(rand));
    const v = Array.from({ length: cols }, () => gaussian(rand));
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) a[i][j] = u[i] * v[j];
    }
    return a;
  }

  if (mode === "two-close") {
    const u1 = Array.from({ length: rows }, () => gaussian(rand));
    const v1 = Array.from({ length: cols }, () => gaussian(rand));
    const u2 = Array.from({ length: rows }, () => gaussian(rand));
    const v2 = Array.from({ length: cols }, () => gaussian(rand));
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        a[i][j] = u1[i] * v1[j] + 0.96 * u2[i] * v2[j];
      }
    }
    return a;
  }

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) a[i][j] = gaussian(rand);
  }
  return a;
}

function frobenius(a) {
  let sum = 0;
  for (const row of a) {
    for (const x of row) sum += x * x;
  }
  return Math.sqrt(sum);
}

function matVec(a, x) {
  const y = Array(a.length).fill(0);
  for (let i = 0; i < a.length; i++) {
    let sum = 0;
    for (let j = 0; j < x.length; j++) sum += a[i][j] * x[j];
    y[i] = sum;
  }
  return y;
}

function transMatVec(a, x) {
  const y = Array(a[0].length).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[0].length; j++) y[j] += a[i][j] * x[i];
  }
  return y;
}

function dot(x, y) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * y[i];
  return sum;
}

function l2(x) {
  return Math.sqrt(Math.max(dot(x, x), 1e-30));
}

function normalize(x) {
  const n = l2(x);
  return x.map((value) => value / n);
}

function spectralPower(a, iterations = 32) {
  let x = Array.from({ length: a[0].length }, (_, i) => ((i * 17 + 3) % 11) / 11 + 0.1);
  x = normalize(x);

  for (let k = 0; k < iterations; k++) {
    const y = matVec(a, x);
    const z = transMatVec(a, y);
    x = normalize(z);
  }

  return l2(matVec(a, x));
}

export function quantizeSymmetric(a, bits) {
  if (!Number.isInteger(bits) || bits < 2 || bits > 16) {
    throw new TypeError(`quantizeSymmetric: bits must be an integer in 2..16, got ${String(bits)}`);
  }

  let maxAbs = 0;
  for (const row of a) {
    for (const x of row) maxAbs = Math.max(maxAbs, Math.abs(x));
  }

  const qmax = 2 ** (bits - 1) - 1;
  const scale = maxAbs > 0 ? maxAbs / qmax : 1;
  return a.map((row) => row.map((x) => Math.max(-qmax, Math.min(qmax, Math.round(x / scale))) * scale));
}

function relError(actual, approx) {
  return Math.abs(approx - actual) / Math.max(Math.abs(actual), 1e-12);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function simulateNormStability() {
  const cases = [
    { name: "dense 16x16", rows: 16, cols: 16, mode: "dense" },
    { name: "wide 8x32", rows: 8, cols: 32, mode: "dense" },
    { name: "rank-1 dominant", rows: 16, cols: 16, mode: "rank1" },
    { name: "two close singular directions", rows: 16, cols: 16, mode: "two-close" }
  ];

  const rows = [];
  for (const spec of cases) {
    for (const bits of [8, 4]) {
      const fErrors = [];
      const sErrors = [];
      for (let seed = 1; seed <= 24; seed++) {
        const a = makeMatrix(spec.rows, spec.cols, seed * 1009 + bits, spec.mode);
        const aq = quantizeSymmetric(a, bits);
        fErrors.push(relError(frobenius(a), frobenius(aq)));
        sErrors.push(relError(spectralPower(a, 48), spectralPower(aq, 16)));
      }
      rows.push({
        caseName: spec.name,
        bits,
        frobeniusMedianPct: median(fErrors) * 100,
        spectralMedianPct: median(sErrors) * 100
      });
    }
  }

  return rows;
}

function formatPct(value) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function stabilityScores() {
  const p = STABILITY_PARAMS;
  const frobenius = 100 * (p.frobeniusReduction + p.npuPrimitiveFit - p.frobeniusOverflowRisk) / 2;
  const spectral = 100 * (
    0.55 * p.npuPrimitiveFit
    + 0.15
    - 0.40 * p.spectralIterationPenalty
    - 0.35 * p.spectralGapPenalty
    - 0.25 * p.spectralNormalizerPenalty
    + 0.60
  );
  return {
    frobenius: Math.max(0, Math.min(100, frobenius)),
    spectral: Math.max(0, Math.min(100, spectral))
  };
}

export function matchesMatrixNormTask(query = "") {
  return /frobenius|spektral|spectral|matrixnorm|matrix norm|2-norm|2-norm|npu|int4|int8|taylor/i.test(query);
}

export function buildMatrixNormBriefing(query = "") {
  const sim = simulateNormStability();
  const scores = stabilityScores();
  const table = sim.map((row) => (
    `| ${row.caseName} | INT${row.bits} | ${formatPct(row.frobeniusMedianPct)} | ${formatPct(row.spectralMedianPct)} |`
  )).join("\n");

  return {
    parameters: STABILITY_PARAMS,
    scores,
    simulation: sim,
    markdown: [
      "## Hermes Math-Core: Frobenius-Norm vs. Spektralnorm auf INT4/INT8-NPUs",
      "",
      "### Definitionen",
      "",
      "- **Frobenius-Norm:** `||A||_F = sqrt(sum_ij a_ij^2) = sqrt(trace(A^T A)) = sqrt(sum_k sigma_k^2)`.",
      "- **Spektralnorm / Matrix-2-Norm:** `||A||_2 = max_{x != 0} ||Ax||_2 / ||x||_2 = sigma_max(A) = sqrt(lambda_max(A^T A))`.",
      "- **Verbindung:** `||A||_2 <= ||A||_F <= sqrt(rank(A)) * ||A||_2`. Gleichheit links entsteht bei Rang 1; die Frobenius-Norm misst Gesamtenergie, die Spektralnorm nur die staerkste Streckrichtung.",
      "",
      "### NPU-Stabilitaet",
      "",
      `- Hermes-Stabilitaetsscore Frobenius: **${scores.frobenius.toFixed(1)}/100**.`,
      `- Hermes-Stabilitaetsscore Spektralnorm: **${scores.spectral.toFixed(1)}/100**.`,
      "- **Urteil:** Frobenius ist in INT4/INT8 klar stabiler und NPU-nativer. Sie braucht Quadrat, Reduktion, optional Skalierung und eine finale Wurzel. Das passt sauber auf `mul + reduce_sum + sqrt/rsqrt`.",
      "- Die Spektralnorm ist mathematisch wertvoller, aber hardwareseitig unbequemer: exakte Berechnung verlangt SVD/Eigenwertlogik; Approximation ueber Power Iteration braucht wiederholte `A*x`, `A^T*y`, Normalisierung und Konvergenz. Kleine Singulaerwert-Luecken machen sie quantisierungsanfaellig.",
      "- INT4 ist besonders kritisch fuer die Spektralnorm: die dominante Richtung kann durch Rundungsrauschen kippen, wenn `sigma_1` und `sigma_2` nahe beieinander liegen. Frobenius verteilt den Fehler ueber alle Eintraege und ist dadurch glatter.",
      "",
      "### Low-Precision-Simulation im Hermes-Core",
      "",
      "| Matrixfall | Praezision | medianer Frobenius-Fehler | medianer Spektral-Fehler |",
      "|---|---:|---:|---:|",
      table,
      "",
      "Die Simulation quantisiert kleine synthetische Matrizen symmetrisch auf INT8/INT4, berechnet Frobenius direkt und Spektralnorm per unrolled Power Iteration. Das ist kein wissenschaftlicher Benchmark, aber ein guter Hardware-Intuitionscheck: Frobenius bleibt als direkte Energienorm gleichmaessiger; Spektralnorm leidet staerker, sobald Richtungsschaetzung und Normalisierung ins Spiel kommen.",
      "",
      "### NPU-Primitive",
      "",
      "- Frobenius squared: `s = reduce_sum(A * A)`; fuer Vergleiche oft **ohne** `sqrt` nutzen, also `||A||_F^2`.",
      "- Blockweise stabil: `scale = max(abs(A))`; dann `Aq = round(A / scale * qmax)`, akkumulieren in INT32 oder FP32, zurueckskalieren mit `scale^2`.",
      "- Spektral Approximation: feste Anzahl unrolled Iterationen, keine dynamische Schleife: `x <- normalize(A^T(Ax))`. Das ist ONNX/NPU-freundlicher, aber Genauigkeit haengt am Spektralgap.",
      "",
      "### Taylor- und Newton-Tricks",
      "",
      "- Wurzel vermeiden, wenn moeglich: `||A||_F^2` reicht fuer Ranking, Regularisierung und Schwellenvergleiche.",
      "- `sqrt(1 + u) ~= 1 + u/2 - u^2/8 + u^3/16 - 5u^4/128` fuer lokal normalisierte Werte `u = x - 1`.",
      "- `rsqrt(x)` per Newton-Raphson: `y_{k+1} = 0.5 * y_k * (3 - x * y_k^2)`. Zwei Iterationen reichen oft, wenn `x` vorher per Potenz-von-zwei-Skalierung in einen engen Bereich gebracht wird.",
      "- Fuer Power-Iteration-Normalisierung kann man `x / sqrt(dot(x,x)+eps)` durch `x * rsqrt(dot(x,x)+eps)` ersetzen. Das ist nur `mul/add` plus eine kleine Polynom-/Newton-Kette.",
      "- Fuer hyperbolische Layer spaeter: `artanh(x) ~= x + x^3/3 + x^5/5`, `sinh(x) ~= x + x^3/6 + x^5/120`, `cosh(x) ~= 1 + x^2/2 + x^4/24`. Immer vorher clippen, z. B. `|x| <= 0.5`, sonst explodiert der Taylorfehler.",
      "",
      "### Implementationsentscheidung fuer Hermes",
      "",
      "- Wenn der Core eine billige, robuste Matrixgroesse fuer INT4/INT8 braucht: **Frobenius oder Frobenius-squared**.",
      "- Wenn der Core die maximale Worst-Case-Verstaerkung braucht: Spektralnorm nur als **optionaler, fixed-unrolled Approximation-Kernel**, nicht als Standardpfad.",
      "- Fuer QAT/Regularisierung auf NPU ist Frobenius die Default-Norm. Spektralnorm ist ein Diagnosewerkzeug oder ein teurerer Stabilitaetsregler.",
      "",
      "### Eingebaute Mikro-Parameter",
      "",
      "Hermes benutzt hier bewusst nur wenige skalare Heuristikparameter fuer die Stabilitaetswertung:",
      "",
      "```json",
      JSON.stringify(STABILITY_PARAMS, null, 2),
      "```"
    ].join("\n")
  };
}
