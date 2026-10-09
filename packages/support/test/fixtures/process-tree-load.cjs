let n = 0;
setInterval(() => {
  const until = Date.now() + 3;
  while (Date.now() < until) n = Math.imul(n + 1, 1_664_525);
}, 10);
