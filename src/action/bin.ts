import { main } from './index.js';

void main().then((code) => {
  process.exitCode = code;
});
