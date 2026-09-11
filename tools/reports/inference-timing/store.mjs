import { openTimingStore, ingestTimingFile, timingReport } from '../../../src/platform/index.js';
import * as parser from '../../../src/providers/codex/logs.js';
export const openStore = directory => openTimingStore(directory, parser);
export const ingestFile = ingestTimingFile;
export const report = timingReport;
