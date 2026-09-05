import type { DecodedAudioAsset, DecodedAudioTransfer } from "@/types/audio";

export function toTransferAsset(asset: DecodedAudioAsset): DecodedAudioTransfer {
  const { channels, ...metadata } = asset;
  return {
    ...metadata,
    channelBuffers: channels.map((channel) => {
      if (channel.byteOffset === 0 && channel.byteLength === channel.buffer.byteLength) {
        return channel.buffer as ArrayBuffer;
      }

      return channel.slice().buffer as ArrayBuffer;
    }),
  };
}

export function fromTransferAsset(asset: DecodedAudioTransfer): DecodedAudioAsset {
  return {
    ...asset,
    channels: asset.channelBuffers.map((buffer) => new Float32Array(buffer)),
  };
}
