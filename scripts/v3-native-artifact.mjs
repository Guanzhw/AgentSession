import { nativeTargets } from '../v3/npm/native/targets.mjs';

// Inspect supplied artifact headers without executing foreign-platform payloads.
export function assertNativeArtifact(bytes, target) {
  if (!nativeTargets[target]) throw new Error(`Unsupported native target: ${target}`);
  let compatible = false;
  if (target === 'win32-x64' && bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
    const pe = bytes.readUInt32LE(60);
    compatible = pe <= bytes.length - 6 && bytes.toString('ascii', pe, pe + 4) === 'PE\0\0'
      && bytes.readUInt16LE(pe + 4) === 0x8664;
  } else if (target.startsWith('linux-') && bytes.length >= 64) {
    compatible = bytes.subarray(0, 7).equals(Buffer.from([0x7f, 69, 76, 70, 2, 1, 1]))
      && [2, 3].includes(bytes.readUInt16LE(16))
      && bytes.readUInt16LE(18) === (target === 'linux-x64' ? 62 : 183);
  } else if (target === 'darwin-arm64' && bytes.length >= 32) {
    compatible = bytes.readUInt32LE(0) === 0xfeedfacf
      && bytes.readUInt32LE(4) === 0x0100000c && bytes.readUInt32LE(12) === 2;
  }
  if (!compatible) throw new Error(`Native executable format or architecture is incompatible with ${target}`);
}
