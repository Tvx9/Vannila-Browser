// Returns the byte offset where the ZIP payload starts inside a .crx (v2 or v3) package
module.exports = buf => {
  if (buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('Could not download that extension (not a valid package).');
  return buf.readUInt32LE(4) === 3 ? 12 + buf.readUInt32LE(8) : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
};
