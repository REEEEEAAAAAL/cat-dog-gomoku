import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { stdout } from 'node:process';

const out='dist/cloudbase/database';
await mkdir(out,{recursive:true});
for(const file of await readdir('cloudbase/migrations')){
  if(file.endsWith('.sql'))await copyFile(`cloudbase/migrations/${file}`,`${out}/${file}`);
}
stdout.write('CloudBase game, diagnostics and migrations packaged locally. No deployment was performed.\n');
