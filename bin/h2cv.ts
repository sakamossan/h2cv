#!/usr/bin/env node
import { run } from "../src/cli.js";

const r = run(process.argv.slice(2));
if (r.stdout) console.log(r.stdout);
if (r.stderr) console.error(r.stderr);
process.exit(r.exitCode);
