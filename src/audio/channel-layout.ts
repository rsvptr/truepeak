import type { ChannelLabel, ChannelLayout } from "@/types/audio";

const SPEAKER_MASK_BITS: Array<[number, ChannelLabel]> = [
  [0x1, "L"],
  [0x2, "R"],
  [0x4, "C"],
  [0x8, "LFE"],
  [0x10, "Lb"],
  [0x20, "Rb"],
  [0x40, "Lc"],
  [0x80, "Rc"],
  [0x100, "Cs"],
  [0x200, "Ls"],
  [0x400, "Rs"],
  [0x1000, "Tfl"],
  [0x2000, "Tfc"],
  [0x4000, "Tfr"],
  [0x8000, "Tbl"],
  [0x10000, "Tbc"],
  [0x20000, "Tbr"],
];

const FALLBACK_LAYOUTS: Record<number, ChannelLabel[]> = {
  1: ["C"],
  2: ["L", "R"],
  3: ["L", "R", "C"],
  4: ["L", "R", "Ls", "Rs"],
  5: ["L", "R", "C", "Ls", "Rs"],
  6: ["L", "R", "C", "LFE", "Ls", "Rs"],
  7: ["L", "R", "C", "LFE", "Ls", "Rs", "Cs"],
  8: ["L", "R", "C", "LFE", "Ls", "Rs", "Lb", "Rb"],
};

function labelsToName(labels: ChannelLabel[]) {
  return labels.join(" / ");
}

export function deriveChannelLayout(channelCount: number, speakerMask?: number | null): ChannelLayout {
  if (speakerMask != null && speakerMask > 0) {
    const labels = SPEAKER_MASK_BITS.filter(([bit]) => (speakerMask & bit) === bit).map(([, label]) => label);
    if (labels.length === channelCount) {
      return {
        name: labelsToName(labels),
        labels,
        guessed: false,
        speakerMask,
      };
    }
  }

  const guessed = FALLBACK_LAYOUTS[channelCount] ?? Array.from({ length: channelCount }, () => "Unknown");
  return {
    name: labelsToName(guessed),
    labels: guessed,
    guessed: true,
    speakerMask: speakerMask ?? null,
  };
}

export function getLoudnessWeight(label: ChannelLabel) {
  if (label === "LFE") {
    return 0;
  }

  if (
    label === "Ls" ||
    label === "Rs" ||
    label === "Lb" ||
    label === "Rb" ||
    label === "Cs" ||
    label.startsWith("T")
  ) {
    return Math.sqrt(2);
  }

  return 1;
}

export function describeLayoutRisk(layout: ChannelLayout) {
  if (!layout.guessed || layout.labels.length <= 2) {
    return null;
  }

  return "Channel layout was inferred from channel count because the source metadata did not provide a speaker map.";
}
