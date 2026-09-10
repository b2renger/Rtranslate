/**
 * What card is in this machine.
 *
 * Shell-level, not engine-level: every engine wants to know the VRAM budget
 * before choosing a model, and none of them should have to shell out for it
 * themselves. It lived in pythonEnv.js when there was only one engine, which
 * made "how much VRAM is there" a question only the Python path could answer.
 *
 * NVIDIA-only, deliberately. Both candidate engines run on this box's NVIDIA
 * card; a machine without one gets `null` and every caller already treats that
 * as "unknown, be conservative".
 */

const { execFile } = require('node:child_process');

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * @returns {Promise<{name:string, vramTotalMiB:number, vramUsedMiB:number,
 *                    vramTotalGiB:number|null, driver:string}|null>}
 */
async function detectGpu() {
  const res = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.used,driver_version',
    '--format=csv,noheader,nounits',
  ]);
  if (!res.ok || !res.stdout.trim()) return null;

  const [line] = res.stdout.trim().split(/\r?\n/);
  const [name, totalMiB, usedMiB, driver] = line.split(',').map((s) => s.trim());
  const total = Number(totalMiB);
  return {
    name,
    vramTotalMiB: total,
    vramUsedMiB: Number(usedMiB),
    vramTotalGiB: Number.isFinite(total) ? total / 1024 : null,
    driver,
  };
}

module.exports = { detectGpu };
