import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const unit = ['app', 'app/components'].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.test.mjs')).map(f => `${dir}/${f}`));
const dom = readdirSync('tests').filter(f => f.endsWith('.cjs')).map(f => `tests/${f}`);
for (const args of [['--test', ...unit], ...dom.map(file => [file])]) {
  const result = spawnSync(process.execPath, args, {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
