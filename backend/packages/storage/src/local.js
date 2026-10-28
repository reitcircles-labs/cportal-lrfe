import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, rm, rmdir} from 'node:fs/promises';
import {dirname, join, resolve, sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {hashingStream} from './hashing.js';

/**
 * Filesystem blob store for local development (EDRMS_STORAGE=local). Has no signed URLs of its
 * own — edrms serves content through its HMAC-signed /content route instead.
 */
export function createLocalStore({root}) {
  const base = resolve(root);
  const pathOf = key => {
    const p = resolve(join(base, key));
    if (!p.startsWith(base + sep)) {
      throw new Error(`Invalid storage key ${key}`);
    }
    return p;
  };
  return {
    kind: 'local',
    async put({key, body}) {
      const target = pathOf(key);
      const {stream, result} = hashingStream(body);
      // the folder is made again if a delete removed it in between (see delete)
      const open = async () => {
        await mkdir(dirname(target), {recursive: true});
        return createWriteStream(target, {flags: 'wx'});
      };
      let file = await open();
      try {
        await new Promise((ok, fail) => {
          file.once('open', ok);
          file.once('error', fail);
        });
      } catch (err) {
        if (err.code !== 'ENOENT') {
          stream.destroy(err); // the upload is not left hanging
          throw err;
        }
        file = await open();
      }
      await pipeline(stream, file);
      return result();
    },
    async getStream(key) {
      return createReadStream(pathOf(key));
    },
    /**
     * Delete a file, and the folders it leaves empty up to the store's root: a folder costs a
     * block on the disk, two per document once intake clears its copy (API-807).
     */
    async delete(key) {
      const target = pathOf(key);
      await rm(target, {force: true});
      for (let dir = dirname(target); dir !== base; dir = dirname(dir)) {
        try {
          await rmdir(dir);
        } catch {
          // not empty, already gone or not ours to remove: stop, the file itself is deleted
          return;
        }
      }
    },
    async signedUrl() {
      return null;
    },
  };
}
