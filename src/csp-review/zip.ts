// Small deterministic ZIP store writer. Inputs are fixed ASCII entry names.
// No compression/dependency; independent readers verify CRC and size in tests.
export function storedZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const file of files) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(file.name) || names.has(file.name))
      throw new Error("unsafe or duplicate ZIP entry");
    names.add(file.name);
    const name = Buffer.from(file.name), data = Buffer.from(file.bytes);
    if (data.length > 25 * 1024 * 1024) throw new Error("ZIP entry too large");
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
