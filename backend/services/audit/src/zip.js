import {crc32, deflateRawSync} from 'node:zlib';

/**
 * A zip file from `[{ path, data }]` (data: Buffer or string), in memory: text files deflated, other
 * files stored (PDFs and images barely shrink, and deflating them would only cost time). Plain zip as every unzip tool reads it;
 * no zip64 (an evidence pack stays far below 4 GB), UTF-8 names. The evidence pack (README.md §6).
 */
export function zip(files, {date = new Date()} = {}) {
  const dosTime =
    ((date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2)) &
    0xffff;
  const dosDate =
    (((date.getFullYear() - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate()) &
    0xffff;
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    // text is deflated; files that are compressed already (PDF, images) are stored as they are
    const deflated = /\.(json|txt|csv|xml|html?)$/i.test(f.path)
      ? deflateRawSync(data)
      : null;
    const [method, body] =
      deflated && deflated.length < data.length ? [8, deflated] : [0, data];
    const crc = crc32(data);
    const head = (sig, extra) => {
      const b = Buffer.alloc(extra);
      b.writeUInt32LE(sig, 0);
      return b;
    };
    const local = head(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const entry = head(0x02014b50, 46);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
