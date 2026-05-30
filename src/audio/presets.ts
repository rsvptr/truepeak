import type { TargetPreset } from "@/types/audio";

export const TARGET_PRESETS: TargetPreset[] = [
  {
    id: "streaming-standard",
    label: "Streaming Standard",
    category: "platform",
    evidence: "inferred",
    sourceLabel: "Cross-platform house preset",
    referenceNote:
      "Use this when you do not have service-specific delivery notes. It follows the common streaming convention around -14 LUFS with a -1 dBTP ceiling.",
    highlights: ["Music uploads", "General streaming", "Safe default"],
    loudnessTargetLufs: -14,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "General music preset for modern streaming releases.",
  },
  {
    id: "spotify-normal",
    label: "Spotify Normal",
    category: "platform",
    evidence: "official",
    sourceLabel: "Spotify loudness normalization",
    referenceUrl: "https://support.spotify.com/us/artists/article/loudness-normalization/",
    referenceNote:
      "Spotify says Normal playback adjusts tracks to -14 LUFS and recommends masters below -1 dBTP, including for lossless playback.",
    highlights: ["Album playback", "Playlist-safe", "Official target"],
    loudnessTargetLufs: -14,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Spotify's published Normal playback target.",
  },
  {
    id: "spotify-loud",
    label: "Spotify Loud",
    category: "platform",
    evidence: "official",
    sourceLabel: "Spotify Premium loud mode",
    referenceUrl: "https://support.spotify.com/us/artists/article/loudness-normalization/",
    referenceNote:
      "Spotify documents a Loud setting at -11 LUFS and notes that playback may use a limiter rather than follow the same peak handling as Normal mode.",
    highlights: ["Noisy environments", "Limiter at playback", "Reference mode"],
    loudnessTargetLufs: -11,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "loudness-first",
    description: "Playback reference for Spotify Loud, useful for comparison rather than conservative mastering.",
  },
  {
    id: "spotify-quiet",
    label: "Spotify Quiet",
    category: "platform",
    evidence: "official",
    sourceLabel: "Spotify Premium quiet mode",
    referenceUrl: "https://support.spotify.com/us/artists/article/loudness-normalization/",
    referenceNote:
      "Spotify documents a Quiet playback setting at -19 LUFS across both compressed and lossless playback.",
    highlights: ["Late-night listening", "Quiet environments", "Dynamic playback"],
    loudnessTargetLufs: -19,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Playback reference for quieter listening modes where more dynamics can stay intact.",
  },
  {
    id: "apple-podcasts",
    label: "Apple Podcasts",
    category: "podcast",
    evidence: "official",
    sourceLabel: "Apple Podcasts audio requirements",
    referenceUrl: "https://podcasters.apple.com/support/893-audio-requirements",
    referenceNote:
      "Apple recommends overall loudness around -16 LKFS with +/-1 dB tolerance and true peak not exceeding -1 dBFS. Apple also notes that Sound Check playback uses -16 dB when metadata is present.",
    highlights: ["Speech-first", "Sound Check", "Official guidance"],
    loudnessTargetLufs: -16,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Speech-first podcast preset based on Apple's published guidance.",
  },
  {
    id: "broadcast-ebu",
    label: "Broadcast EBU R128",
    category: "broadcast",
    evidence: "official",
    sourceLabel: "EBU R 128",
    referenceUrl: "https://tech.ebu.ch/publications/r128",
    referenceNote:
      "EBU R 128 recommends an average programme loudness of -23 LUFS, and version 3 tightened the target tolerance to +/-0.5 LU.",
    highlights: ["Europe", "Television", "Tight tolerance"],
    loudnessTargetLufs: -23,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 0.5,
    policy: "protect-true-peak",
    description: "European broadcast preset aligned with EBU R128.",
  },
  {
    id: "broadcast-atsc",
    label: "Broadcast ATSC A/85",
    category: "broadcast",
    evidence: "official",
    sourceLabel: "ATSC A/85",
    referenceUrl: "https://www.atsc.org/wp-content/uploads/2025/06/A85-2013-with-Corrigendum-No-1.pdf",
    referenceNote:
      "ATSC A/85 says content without metadata should target -24 LKFS and keep true peak below -2 dBTP, with small measurement variations anticipated.",
    highlights: ["North America", "Television", "Extra headroom"],
    loudnessTargetLufs: -24,
    truePeakCeilingDbtp: -2,
    toleranceLufs: 2,
    policy: "protect-true-peak",
    description: "North American broadcast preset based on ATSC A/85.",
  },
  {
    id: "hifi-dynamic",
    label: "HiFi Dynamic",
    category: "hifi",
    evidence: "inferred",
    sourceLabel: "Qobuz / TIDAL HiFi listening",
    referenceUrl: "https://help.qobuz.com/en/articles/10127-the-qobuz-experience",
    referenceNote:
      "Qobuz describes HiFi/HD listening and TIDAL documents lossless FLAC and HiRes FLAC tiers, but neither service publishes a loudness target. This is an app-side listening preset rather than a platform requirement.",
    highlights: ["Lossless playback", "Album dynamics", "Inference, not mandate"],
    loudnessTargetLufs: -18,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1.5,
    policy: "protect-true-peak",
    description: "Lower, more open preset for lossless listening where headroom matters more than level.",
  },
];

export const DEFAULT_TARGET_PRESET = TARGET_PRESETS[0];















