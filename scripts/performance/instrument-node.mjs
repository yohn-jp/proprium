// Benchmark-process-only interception; install before dynamically importing Core/API.
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
export const counts = { gitProcesses: 0, readFileCalls: 0, readFileBytes: 0 };
export const gitCommands = [];
for (const name of ['execFile', 'spawn']) {
  const original = childProcess[name];
  childProcess[name] = function(file, args, ...rest) {
    if (file === 'git') { counts.gitProcesses++; gitCommands.push({ at: Date.now(), args }); }
    return Reflect.apply(original, this, [file, args, ...rest]);
  };
  if (name === 'execFile') childProcess[name][Symbol.for('nodejs.util.promisify.custom')] = (...args) =>
    new Promise((resolve, reject) => childProcess[name](...args, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
    }));
}
const originalRead = fs.readFile;
fs.readFile = async function(...args) {
  if (String(args[0]).startsWith('/proc/')) return Reflect.apply(originalRead, this, args);
  counts.readFileCalls++;
  const value = await Reflect.apply(originalRead, this, args);
  counts.readFileBytes += Buffer.byteLength(value);
  return value;
};
syncBuiltinESMExports();
