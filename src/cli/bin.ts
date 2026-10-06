#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from './main.ts';

// Exit quietly when the reader goes away (e.g. `ruby jobs history x | head`).
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

process.exitCode = await main(process.argv.slice(2));
