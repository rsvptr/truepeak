// @ts-check
// Shared container fixtures for the validator suites. One implementation of the
// WAV, AIFF and FLAC encoders the suites used to carry a copy of each, typed by
// JSDoc and checked through tsconfig.scripts.json.

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {string} text
 */
function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * Big-endian 80-bit float, enough for the positive sample rates AIFF stores.
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {number} value
 */
export function writeFloat80(view, offset, value) {
  const exponent = Math.floor(Math.log2(value));
  const mantissa = value / 2 ** exponent; // in [1, 2)
  view.setUint16(offset, 16383 + exponent, false);
  view.setUint32(offset + 2, Math.floor(mantissa * 2 ** 31), false);
  view.setUint32(offset + 6, 0, false);
}

/**
 * @typedef {object} WavFixtureOptions
 * @property {Float32Array[]} channels Sample data, one array per channel.
 * @property {number} sampleRate
 * @property {number} [formatTag] 3 = IEEE float (default), 1 = PCM, 0xfffe = extensible.
 * @property {number} [bitsPerSample] Defaults to 32.
 * @property {boolean} [extensible] Emit a 40-byte fmt chunk with a subtype GUID.
 * @property {number} [declaredChannels] Header channel count when it must lie.
 * @property {number} [declaredDataBytes] Header data size when it must lie.
 */

/**
 * Encode a RIFF/WAVE buffer. Samples are written as float32 for a 32-bit IEEE
 * float chunk and as int16 for a 16-bit chunk; any other width leaves the data
 * region zeroed, which is what the header-only fixtures want.
 *
 * @param {WavFixtureOptions} options
 * @returns {ArrayBuffer}
 */
export function encodeWav({
  channels,
  sampleRate,
  formatTag = 3,
  bitsPerSample = 32,
  extensible = false,
  declaredChannels,
  declaredDataBytes,
}) {
  const channelCount = channels.length;
  const writtenChannels = declaredChannels ?? channelCount;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = writtenChannels * bytesPerSample;
  const frameCount = channels[0]?.length ?? 0;
  const dataBytes = frameCount * channelCount * bytesPerSample;
  const fmtSize = extensible ? 40 : 16;
  const buffer = new ArrayBuffer(20 + fmtSize + 8 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, formatTag, true);
  view.setUint16(22, writtenChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  let offset = 36;
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, bitsPerSample, true); // valid bits
    view.setUint32(40, 0x3, true); // speaker mask L|R
    // KSDATAFORMAT subtype GUID: PCM or IEEE float
    view.setUint32(44, formatTag === 3 ? 3 : 1, true);
    view.setUint16(48, 0, true);
    view.setUint16(50, 0x0010, true);
    const tail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    tail.forEach((byte, index) => view.setUint8(52 + index, byte));
    offset = 60;
  }
  writeAscii(view, offset, "data");
  view.setUint32(offset + 4, declaredDataBytes ?? dataBytes, true);
  offset += 8;

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = channels[channel][frame];
      if (bitsPerSample === 32 && formatTag === 3) view.setFloat32(offset, value, true);
      else if (bitsPerSample === 16) view.setInt16(offset, Math.round(value * 32767), true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

/**
 * @typedef {object} AiffFixtureOptions
 * @property {Float32Array[]} channels Sample data, one array per channel.
 * @property {number} sampleRate
 * @property {number} [bitsPerSample] Defaults to 16.
 */

/**
 * Encode an AIFF buffer with a COMM and an SSND chunk. Samples are written for
 * a 16-bit fixture; any other width leaves the data region zeroed.
 *
 * @param {AiffFixtureOptions} options
 * @returns {ArrayBuffer}
 */
export function encodeAiff({ channels, sampleRate, bitsPerSample = 16 }) {
  const channelCount = channels.length;
  const frameCount = channels[0]?.length ?? 0;
  const dataBytes = frameCount * channelCount * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(54 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "FORM");
  view.setUint32(4, buffer.byteLength - 8, false);
  writeAscii(view, 8, "AIFF");
  writeAscii(view, 12, "COMM");
  view.setUint32(16, 18, false);
  view.setUint16(20, channelCount, false);
  view.setUint32(22, frameCount, false);
  view.setUint16(26, bitsPerSample, false);
  writeFloat80(view, 28, sampleRate);
  writeAscii(view, 38, "SSND");
  view.setUint32(42, 8 + dataBytes, false);
  view.setUint32(46, 0, false); // data offset
  view.setUint32(50, 0, false); // block size

  if (bitsPerSample === 16) {
    let offset = 54;
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        view.setInt16(offset, Math.round(channels[channel][frame] * 32767), false);
        offset += 2;
      }
    }
  }
  return buffer;
}

/**
 * Encode a FLAC stream header carrying one STREAMINFO block.
 *
 * @param {number} sampleRate
 * @param {number} channelCount
 * @param {number} bitDepth
 * @param {number} frameCount
 * @param {{ blockSize?: number }} [options] Min and max block size, zero by default.
 * @returns {ArrayBuffer}
 */
export function encodeFlacHeader(sampleRate, channelCount, bitDepth, frameCount, options = {}) {
  const blockSize = options.blockSize ?? 0;
  const buffer = new ArrayBuffer(42);
  const view = new DataView(buffer);
  writeAscii(view, 0, "fLaC");
  view.setUint8(4, 0x80); // last block, type 0 (STREAMINFO)
  view.setUint8(7, 34);
  view.setUint16(8, blockSize, false);
  view.setUint16(10, blockSize, false);
  // bytes 12..17: frame sizes, left zero
  view.setUint8(18, (sampleRate >> 12) & 0xff);
  view.setUint8(19, (sampleRate >> 4) & 0xff);
  view.setUint8(
    20,
    ((sampleRate & 0x0f) << 4) | (((channelCount - 1) & 0x07) << 1) | (((bitDepth - 1) >> 4) & 0x01),
  );
  view.setUint8(21, (((bitDepth - 1) & 0x0f) << 4) | Math.floor(frameCount / 2 ** 32));
  view.setUint32(22, frameCount >>> 0, false);
  return buffer;
}

/**
 * Silent sample data, for header-only fixtures.
 *
 * @param {number} channelCount
 * @param {number} frameCount
 * @returns {Float32Array[]}
 */
export function silentChannels(channelCount, frameCount) {
  return Array.from({ length: channelCount }, () => new Float32Array(frameCount));
}
