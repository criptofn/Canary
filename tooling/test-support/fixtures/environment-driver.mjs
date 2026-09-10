/** Poison the caller environment after Node startup, then exercise production. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [cli,root,poison] = process.argv.slice(2);
process.chdir(root);
process.env.NODE_OPTIONS='--require=missing-preload';
process.env.NODE_PATH=poison;
process.env.npm_config_script_shell=path.join(poison,'npm');
process.env.GIT_DIR=poison;
process.argv = [process.execPath, cli, 'isolate', '--promote', 'c'];
await import(pathToFileURL(cli));
