export const MAX_CONTAINER_CHUNKS = 100_000;

export interface ContainerChunk {
  id: string;
  headerOffset: number;
  dataOffset: number;
  declaredSize: number;
  size: number | null;
  paddedSize: number | null;
  fitsTotalBytes: boolean;
}

interface ContainerChunkOptions {
  startOffset: number;
  totalBytes: number;
  littleEndian: boolean;
  resolveSize?: (id: string, declaredSize: number) => number | null;
}

export interface ContainerPcmGeometry {
  channelCount: number;
  bitDepth: number;
  frameCount: number;
}

export type BeforePcmAllocation = (geometry: ContainerPcmGeometry) => void;

export function readAscii(view: DataView, offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > view.byteLength - length
  ) {
    return "";
  }

  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += String.fromCharCode(view.getUint8(offset + index));
  }
  return output;
}

export function readSafeUint64(view: DataView, offset: number, littleEndian: boolean) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > view.byteLength - 8) {
    return null;
  }

  const value = view.getBigUint64(offset, littleEndian);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

export function readExtendedFloat80(view: DataView, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > view.byteLength - 10) {
    return Number.NaN;
  }

  const exponentWord = view.getUint16(offset, false);
  const exponent = exponentWord & 0x7fff;
  const sign = exponentWord & 0x8000 ? -1 : 1;
  const high = view.getUint32(offset + 2, false);
  const low = view.getUint32(offset + 6, false);
  if (exponent === 0 && high === 0 && low === 0) {
    return 0;
  }
  if (exponent === 0x7fff) {
    return Number.NaN;
  }

  const mantissa = high * 2 ** -31 + low * 2 ** -63;
  return sign * mantissa * 2 ** (exponent - 16383);
}

export function* iterateContainerChunks(
  view: DataView,
  options: ContainerChunkOptions,
): Generator<ContainerChunk> {
  const { littleEndian, resolveSize } = options;
  if (
    !Number.isSafeInteger(options.startOffset) ||
    options.startOffset < 0 ||
    !Number.isSafeInteger(options.totalBytes) ||
    options.totalBytes < view.byteLength
  ) {
    return;
  }

  let offset = options.startOffset;
  let chunksVisited = 0;
  while (offset <= view.byteLength - 8 && chunksVisited < MAX_CONTAINER_CHUNKS) {
    const id = readAscii(view, offset, 4);
    const declaredSize = view.getUint32(offset + 4, littleEndian);
    const dataOffset = offset + 8;
    const size = resolveSize ? resolveSize(id, declaredSize) : declaredSize;
    const paddedSize =
      size != null && Number.isSafeInteger(size) && size >= 0
        ? size + (size & 1)
        : null;
    const fitsTotalBytes =
      paddedSize != null &&
      Number.isSafeInteger(paddedSize) &&
      dataOffset <= options.totalBytes &&
      paddedSize <= options.totalBytes - dataOffset;

    chunksVisited += 1;
    yield {
      id,
      headerOffset: offset,
      dataOffset,
      declaredSize,
      size,
      paddedSize,
      fitsTotalBytes,
    };

    if (!fitsTotalBytes || paddedSize == null) {
      return;
    }
    offset = dataOffset + paddedSize;
  }
}
