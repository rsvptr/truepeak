import type { ChannelLabel, ChannelLayout } from "@/types/audio";

// WAVE speaker-position mask bits (Microsoft WAVEFORMATEXTENSIBLE dwChannelMask).
// Kept in ascending bit order — that is the order channels are interleaved in the
// stream, so filtering this table by set bits reproduces the channel order.
const SPEAKER_FRONT_LEFT = 0x1;
const SPEAKER_FRONT_RIGHT = 0x2;
const SPEAKER_FRONT_CENTER = 0x4;
const SPEAKER_LOW_FREQUENCY = 0x8;
const SPEAKER_BACK_LEFT = 0x10;
const SPEAKER_BACK_RIGHT = 0x20;
const SPEAKER_FRONT_LEFT_OF_CENTER = 0x40;
const SPEAKER_FRONT_RIGHT_OF_CENTER = 0x80;
const SPEAKER_BACK_CENTER = 0x100;
const SPEAKER_SIDE_LEFT = 0x200;
const SPEAKER_SIDE_RIGHT = 0x400;
const SPEAKER_TOP_CENTER = 0x800;
const SPEAKER_TOP_FRONT_LEFT = 0x1000;
const SPEAKER_TOP_FRONT_CENTER = 0x2000;
const SPEAKER_TOP_FRONT_RIGHT = 0x4000;
const SPEAKER_TOP_BACK_LEFT = 0x8000;
const SPEAKER_TOP_BACK_CENTER = 0x10000;
const SPEAKER_TOP_BACK_RIGHT = 0x20000;

// Default label per bit. BACK_LEFT/BACK_RIGHT default to true rears (Lb/Rb); they
// are re-interpreted as ~110 degree surrounds (Ls/Rs) only in the ITU 5.1-style
// case (a front-centre present and no dedicated side channels) — see
// resolveMaskLabel, backBitsAreSurroundChannels, and deriveChannelLayout.
const SPEAKER_MASK_BITS: Array<[number, ChannelLabel]> = [
  [SPEAKER_FRONT_LEFT, "L"],
  [SPEAKER_FRONT_RIGHT, "R"],
  [SPEAKER_FRONT_CENTER, "C"],
  [SPEAKER_LOW_FREQUENCY, "LFE"],
  [SPEAKER_BACK_LEFT, "Lb"],
  [SPEAKER_BACK_RIGHT, "Rb"],
  [SPEAKER_FRONT_LEFT_OF_CENTER, "Lc"],
  [SPEAKER_FRONT_RIGHT_OF_CENTER, "Rc"],
  [SPEAKER_BACK_CENTER, "Cs"],
  [SPEAKER_SIDE_LEFT, "Ls"],
  [SPEAKER_SIDE_RIGHT, "Rs"],
  [SPEAKER_TOP_CENTER, "Tc"],
  [SPEAKER_TOP_FRONT_LEFT, "Tfl"],
  [SPEAKER_TOP_FRONT_CENTER, "Tfc"],
  [SPEAKER_TOP_FRONT_RIGHT, "Tfr"],
  [SPEAKER_TOP_BACK_LEFT, "Tbl"],
  [SPEAKER_TOP_BACK_CENTER, "Tbc"],
  [SPEAKER_TOP_BACK_RIGHT, "Tbr"],
];

/**
 * Which interleave convention a maskless container follows.
 *
 * There is no single count-only answer for 8 channels. WAVE orders 7.1 as
 * FL, FR, FC, LFE, BL, BR, SL, SR (the order SPEAKER_MASK_BITS walks, so
 * `deriveChannelLayout(8, 0x63F)` yields L, R, C, LFE, Lb, Rb, Ls, Rs), while
 * AIFF and CoreAudio put the sides at indices 4 and 5 instead. Since the two
 * disagree about which pair gets the sqrt(2) surround weight, guessing one for
 * both made an 8-channel file read 1.5 LU hotter through the wrong table. The
 * caller knows its container, so it says.
 */
export type ChannelOrderConvention = "wave" | "coreaudio";

// Count-only fallbacks, used when the container carries no speaker map (AIFF,
// the browser decode route, and any WAVE with a plain 16-byte `fmt ` chunk).
// Where a mask equivalent exists, these MUST resolve to the same loudness
// weighting, or the same PCM measures differently depending on whether a
// dwChannelMask happened to be present.
//
// The 4-channel entry is the one that has to be stated carefully:
// backBitsAreSurroundChannels only remaps BACK bits to Ls/Rs when a front centre
// is present, so mask 0x33 (quad) resolves to true rears Lb/Rb at weight 1.0.
// Labelling a maskless quad L/R/Ls/Rs instead gave those two channels the
// sqrt(2) surround boost and read 0.82 LU louder than the identical audio with a
// mask, outside the +/-0.5 LU R128 tolerance and on the headline metric. Both
// conventions agree that a centre-less 4-channel pair is rears, so 4 is shared.
// Every centre-present entry (5, 6, 7) uses Ls/Rs, matching the mask path.
const FALLBACK_LAYOUTS: Record<number, ChannelLabel[]> = {
  1: ["C"],
  2: ["L", "R"],
  3: ["L", "R", "C"],
  4: ["L", "R", "Lb", "Rb"],
  5: ["L", "R", "C", "Ls", "Rs"],
  6: ["L", "R", "C", "LFE", "Ls", "Rs"],
  7: ["L", "R", "C", "LFE", "Ls", "Rs", "Cs"],
  // CoreAudio / MPEG 7.1: the sides sit at indices 4 and 5.
  8: ["L", "R", "C", "LFE", "Ls", "Rs", "Lb", "Rb"],
};

// Arities where the WAVE interleave differs from the table above.
const WAVE_FALLBACK_OVERRIDES: Record<number, ChannelLabel[]> = {
  8: ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs"],
};

function fallbackLabels(
  channelCount: number,
  order: ChannelOrderConvention,
): ChannelLabel[] | undefined {
  if (order === "wave" && WAVE_FALLBACK_OVERRIDES[channelCount]) {
    return WAVE_FALLBACK_OVERRIDES[channelCount];
  }
  return FALLBACK_LAYOUTS[channelCount];
}

function labelsToName(labels: ChannelLabel[]) {
  return labels.join(" / ");
}

function maskHas(speakerMask: number, bit: number) {
  return (speakerMask & bit) === bit;
}

function maskHasSideChannels(speakerMask: number) {
  return maskHas(speakerMask, SPEAKER_SIDE_LEFT) || maskHas(speakerMask, SPEAKER_SIDE_RIGHT);
}

// Whether the mask's BACK_LEFT/BACK_RIGHT bits denote the ITU ~110 degree surrounds
// (Ls/Rs, +1.5 dB) rather than genuine true rears (Lb/Rb, 1.0). WAVE canonically
// encodes ITU 5.1 (L/R/C/LFE + two ~110 degree surrounds) with the BACK bits, so
// the surround re-interpretation applies ONLY to that 5.1-style family: a front
// centre present AND no dedicated SIDE channels. Two masks that must NOT remap:
//   - 0x33 (FL|FR|BL|BR) — quadraphonic, no centre; the back pair is true rears.
//   - 0x63F (FL|FR|FC|LFE|BL|BR|SL|SR) — 7.1 with real side channels present.
// A centre-present, side-absent mask such as 0x3F (5.1) does remap to Ls/Rs.
function backBitsAreSurroundChannels(speakerMask: number) {
  return maskHas(speakerMask, SPEAKER_FRONT_CENTER) && !maskHasSideChannels(speakerMask);
}

// True when BACK bits are present AND we re-interpret them as ~110 degree surrounds
// (Ls/Rs). The bit name alone cannot pin the exact position, so callers surface a
// layout note. Quad-style masks (back bits kept as true rears) are unambiguous and
// get no note.
function maskHasAmbiguousBackChannels(speakerMask: number) {
  const hasBack = maskHas(speakerMask, SPEAKER_BACK_LEFT) || maskHas(speakerMask, SPEAKER_BACK_RIGHT);
  return hasBack && backBitsAreSurroundChannels(speakerMask);
}

// Resolve a set mask bit to its channel label. Only the BACK bits are layout
// dependent: in a 5.1-style mask (front centre present, no side channels) they are
// the ~110 degree surrounds Ls/Rs; otherwise they keep their default true-rear
// labels Lb/Rb (quad, 7.1, or any centre-absent layout).
function resolveMaskLabel(bit: number, defaultLabel: ChannelLabel, remapBackToSurround: boolean): ChannelLabel {
  if (remapBackToSurround) {
    if (bit === SPEAKER_BACK_LEFT) {
      return "Ls";
    }
    if (bit === SPEAKER_BACK_RIGHT) {
      return "Rs";
    }
  }
  return defaultLabel;
}

export function deriveChannelLayout(
  channelCount: number,
  speakerMask?: number | null,
  // Only consulted when there is no usable mask. Defaults to the CoreAudio/MPEG
  // interleave, which is what AIFF and the browser decode route produce; WAVE
  // passes "wave" so a maskless 7.1 file is weighted the same way the 0x63F mask
  // path weights it.
  order: ChannelOrderConvention = "coreaudio",
): ChannelLayout {
  if (speakerMask != null && speakerMask > 0) {
    const remapBackToSurround = backBitsAreSurroundChannels(speakerMask);
    const labels = SPEAKER_MASK_BITS.filter(([bit]) => maskHas(speakerMask, bit)).map(([bit, label]) =>
      resolveMaskLabel(bit, label, remapBackToSurround),
    );
    if (labels.length === channelCount) {
      return {
        name: labelsToName(labels),
        labels,
        guessed: false,
        speakerMask,
      };
    }
  }

  const guessed =
    fallbackLabels(channelCount, order) ??
    Array.from({ length: channelCount }, (): ChannelLabel => "Unknown");
  return {
    name: labelsToName(guessed),
    labels: guessed,
    guessed: true,
    speakerMask: speakerMask ?? null,
  };
}

// ITU-R BS.1770-5 Annex 3 channel weighting (Rec. tables 4-5). Only low-elevation
// channels in the 60-120 degree azimuth region take the +1.5 dB (sqrt(2) power)
// surround boost — in this label set that is exactly Ls/Rs. Every elevated channel
// (all T*, including Tc), the true rears Lb/Rb (+/-135 degrees), back centre Cs
// (180 degrees), the front-of-centre pair Lc/Rc, and L/R/C are weighted 1.0. LFE
// is excluded from the loudness measurement. Reference: ITU-R BS.1770-5, Annex 3.
export function getLoudnessWeight(label: ChannelLabel) {
  if (label === "LFE") {
    return 0;
  }

  if (label === "Ls" || label === "Rs") {
    return Math.sqrt(2);
  }

  return 1;
}

export function describeLayoutRisk(layout: ChannelLayout) {
  if (layout.guessed) {
    if (layout.labels.length <= 2) {
      return null;
    }

    return "Channel layout was inferred from channel count because the source metadata did not provide a speaker map; the assumed positions decide which channels take the ITU-R BS.1770 surround weighting, so confirm they match the source.";
  }

  // Mask-derived layout: note when BACK bits were interpreted as ~110 degree
  // surrounds (Ls/Rs) because the mask is ITU 5.1-style (front centre present, no
  // dedicated side channels). The loudness weighting is standard-correct; the note
  // flags the position guess. Quad-style masks (e.g. 0x33) keep true rears and get
  // no note.
  if (layout.speakerMask != null && maskHasAmbiguousBackChannels(layout.speakerMask)) {
    return "WAVE back-left/right speaker bits were interpreted as ~110 degree surround channels (Ls/Rs) because the speaker mask pairs them with a front center but declares no dedicated side channels (the ITU 5.1 convention); confirm this matches the source layout.";
  }

  return null;
}
