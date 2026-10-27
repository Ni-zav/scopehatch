import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readContextKey } from '../identity-context.mjs';

test('context authority has no default key and refuses exposed, malformed or symlinked files', () => {
  const prior=process.env.SCOPEHATCH_CONTEXT_KEY_FILE;
  const dir=mkdtempSync(join(tmpdir(),'scopehatch-context-key-'));
  const path=join(dir,'key');
  try {
    delete process.env.SCOPEHATCH_CONTEXT_KEY_FILE;
    assert.throws(()=>readContextKey());
    process.env.SCOPEHATCH_CONTEXT_KEY_FILE=path;
    writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600});
    assert.equal(readContextKey().length,32);
    chmodSync(path,0o644);
    assert.throws(()=>readContextKey());
    chmodSync(path,0o600);
    writeFileSync(path,'invalid');
    assert.throws(()=>readContextKey());
    const link=join(dir,'link');symlinkSync(path,link);
    process.env.SCOPEHATCH_CONTEXT_KEY_FILE=link;
    assert.throws(()=>readContextKey());
  } finally {
    if(prior===undefined)delete process.env.SCOPEHATCH_CONTEXT_KEY_FILE;
    else process.env.SCOPEHATCH_CONTEXT_KEY_FILE=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});
