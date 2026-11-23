import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateConfig, doctor, audit } from './core.mjs';
import { teamAudit, teamLimits } from './team.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function main() {
  const [command = 'plan', ...rest] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--repo', '--config', '--out'].includes(rest[i]) || !rest[i + 1]) throw new Error('Use --repo PATH, --config PATH, --out DIRECTORY.');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  const config = validateConfig(JSON.parse(await readFile(resolve(options.config ?? join(root, 'qa.config.json')), 'utf8')));
  if (command === 'plan') {
    console.log(JSON.stringify({ modes: ['source-audit', 'live-team-source-audit'], team: teamLimits(config), maxParallel: config.maxParallel, perProviderParallel: 1,
      automaticApiFallback: false, liveUiTestsExecuted: false, tasks: config.tasks }, null, 2)); return;
  }
  if (command === 'doctor') {
    const result = await doctor(config); console.log(JSON.stringify(result, null, 2));
    if (Object.values(result).some(p => !p.ready)) process.exitCode = 2;
    return;
  }
  if (!['audit', 'team'].includes(command) || !options.repo) throw new Error('Usage: node src/cli.mjs plan|doctor|audit|team --repo /path/to/project');
  if (process.platform === 'win32') throw new Error('Use WSL2 for this first release so timed-out agent process trees can be stopped reliably.');
  const out = join(resolve(options.out ?? join(root, 'runs')), randomUUID());
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  if (command === 'team') { process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt); }
  let report;
  try {
    report = command === 'team' ? await teamAudit(config, options.repo, out, { signal: controller.signal }) : await audit(config, options.repo, out);
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  console.log(`Report: ${join(out, 'report.json')}`);
  if (Object.values(report.tasks).some(t => t.state !== 'completed')) process.exitCode = 2;
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
