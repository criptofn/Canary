/** Minimal TTY observation fixture (test support, never shipped).
 *  Answers exactly one question: does THIS child see a terminal on stdin and
 *  stdout? Prints machine-readable lines and then consumes one input line, so a
 *  caller can prove input actually flows through the same channel. */
const stdinTty = process.stdin.isTTY === true;
const stdoutTty = process.stdout.isTTY === true;
console.log(`TTY stdin=${stdinTty} stdout=${stdoutTty} platform=${process.platform}`);

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buf += chunk; });
process.stdin.on('end', () => {
  const line = buf.split(/\r?\n/)[0] ?? '';
  console.log(`READ ${JSON.stringify(line)}`);
  process.exit(0);
});
// A terminal does not necessarily send EOF; if a line arrives, stop there.
process.stdin.on('data', () => {
  if (buf.includes('\n')) {
    console.log(`READ ${JSON.stringify(buf.split(/\r?\n/)[0])}`);
    process.exit(0);
  }
});
setTimeout(() => {
  console.log(`READ ${JSON.stringify(buf.split(/\r?\n/)[0] ?? '')}`);
  process.exit(0);
}, 4000).unref?.();
