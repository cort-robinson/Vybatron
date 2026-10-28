import { parentPort, workerData } from 'node:worker_threads';
import { analyseOgg } from './analysis.js';

// One song's analysis, off the bot's event loop. The worker ends with it, so
// the decoder's WebAssembly memory is released at once rather than at some GC.
try {
  const { data, maxFrames } = workerData;
  const result = await analyseOgg(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { maxFrames });
  parentPort.postMessage({ result }, [result.levels.buffer]);
} catch (error) {
  parentPort.postMessage({ error: { status: error?.status || 503, code: error?.code || 'unavailable', message: error?.message || 'The song could not be analysed.' } });
}
