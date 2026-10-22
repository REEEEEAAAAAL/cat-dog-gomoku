import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { stdout } from 'node:process';

const out='dist/cloudbase/database';
await mkdir(out,{recursive:true});
for(const file of await readdir('cloudbase/migrations')){
  if(file.endsWith('.sql'))await copyFile(`cloudbase/migrations/${file}`,`${out}/${file}`);
}
stdout.write('CloudBase candidate packaged locally. No cloud resources were contacted or deployed.\n');
