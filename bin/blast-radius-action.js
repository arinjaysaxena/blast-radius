#!/usr/bin/env node
import { main } from '../src/action.js';

process.exitCode = await main();
