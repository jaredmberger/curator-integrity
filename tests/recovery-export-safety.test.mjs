import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Integrity recovery export is protected and scoped to its own KV',async()=>{
  const source=await readFile(new URL('../src/index-v1.4.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/recovery-export/);
  assert.match(source,/RECOVERY_EXPORT_TOKEN/);
  assert.match(source,/x-curator-recovery-key/);
  assert.match(source,/CURATOR_INTEGRITY_RECORDS/);
  assert.match(source,/77798f0b676c4257bdd03fc656532c3f/);
  assert.doesNotMatch(source,/binding:'CURATOR_ERROR_RECORDS'/);
  assert.match(source,/list_complete/);
  assert.match(source,/dataSha256/);
});
