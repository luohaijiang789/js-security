import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-extractor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, code] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, code);
  }
  return root;
}
