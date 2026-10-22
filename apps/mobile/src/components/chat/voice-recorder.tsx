import {
  getRecordingPermissionsAsync,
  type RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, Mic, Trash2 } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { alertError } from '../../lib/options-menu';
import { isAndroid } from '../../lib/platform';
import type { OutgoingVoice } from '../../lib/queries';
import {
  cancelProgress,
  formatDuration,
  MAX_RECORDING_MS,
  meteringToLevel,
  releaseOutcome,
  toPeaks,
} from '../../lib/voice';
import { colors, themed } from '../../theme';
import { T } from '../ui/text';

/** Speech in mono AAC (.m4a): small, and played as it is everywhere. */
const VOICE: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
};
/** How often the level and the time are read while recording. */
const POLL_MS = 80;
/** Live bars shown while recording. */
const LIVE_BARS = 28;
/** A hold shorter than this is a tap (which tells how to record). */
const HOLD_MS = 140;

type Phase = 'idle' | 'starting' | 'recording';

/** Drops a recording's file (cancelled, or sent). */
export function discardRecording(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone: nothing to tidy.
  }
}

/**
 * The microphone, held to record: `begin` when the finger goes down (asking for the mic the first
 * time), `end` when it lifts or slides away. While recording, the time and the live level.
 */
export function useVoiceRecorder(onRecorded: (voice: OutgoingVoice) => void) {
  const { t } = useTranslation();
  const recorder = useAudioRecorder(VOICE);
  const phase = useRef<Phase>('idle');
  // Let go before the recorder was ready: what to do once it is.
  const pending = useRef<'send' | 'cancel' | null>(null);
  const levels = useRef<number[]>([]);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState<number[]>([]);
  const [slide, setSlide] = useState(0);

  const reset = () => {
    phase.current = 'idle';
    pending.current = null;
    setRecording(false);
    setElapsed(0);
    setLive([]);
    setSlide(0);
  };

  const finish = async (outcome: 'send' | 'cancel') => {
    if (phase.current !== 'recording') return;
    phase.current = 'idle';
    const durationMs = recorder.getStatus().durationMillis;
    try {
      await recorder.stop();
    } catch {
      // Stopped already (an interruption): the file is what was recorded.
    }
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    const uri = recorder.uri;
    const result = outcome === 'cancel' ? 'cancel' : releaseOutcome(durationMs, 0);
    reset();
    if (!uri) return;
    if (result !== 'send') {
      if (result === 'cancel')
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      discardRecording(uri);
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onRecorded({ uri, durationMs, peaks: toPeaks(levels.current) });
  };

  const begin = async () => {
    if (phase.current !== 'idle') return;
    phase.current = 'starting';
    pending.current = null;
    try {
      const permission = await getRecordingPermissionsAsync();
      if (!permission.granted) {
        // Asked now; the next hold records (the system dialog took the finger).
        const asked = permission.canAskAgain ? await requestRecordingPermissionsAsync() : null;
        if (!asked?.granted && !permission.canAskAgain) alertError(t('chatMedia.voice.micDenied'));
        reset();
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      reset();
      alertError(t('chatMedia.voice.notSent'));
      return;
    }
    levels.current = [];
    phase.current = 'recording';
    setRecording(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (pending.current) void finish(pending.current);
  };

  /** The finger lifted (`slideX`: how far it went left), or the gesture was taken away. */
  const end = (slideX: number) => {
    // Held long enough by definition: only the slide decides.
    const wanted =
      releaseOutcome(Number.POSITIVE_INFINITY, slideX) === 'cancel' ? 'cancel' : 'send';
    if (phase.current === 'starting') pending.current = wanted;
    else void finish(wanted);
  };

  const finishRef = useRef(finish);
  finishRef.current = finish;

  // The clock and the meter while recording; too long, it is sent as it is.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const status = recorder.getStatus();
      const level = meteringToLevel(status.metering);
      levels.current.push(level);
      setElapsed(status.durationMillis);
      setLive((current) => [...current.slice(1 - LIVE_BARS), level]);
      if (status.durationMillis >= MAX_RECORDING_MS) void finishRef.current('send');
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [recording, recorder]);

  // Leaving the conversation drops a recording under way.
  useEffect(() => () => void finishRef.current('cancel'), []);

  return { recording, elapsed, live, slide, setSlide, begin, end };
}

/** While recording: a red dot, the time, the live level, and how to cancel. */
export function RecordingBar({
  elapsed,
  live,
  slide,
}: {
  elapsed: number;
  live: number[];
  slide: number;
}) {
  const { t } = useTranslation();
  const toward = cancelProgress(slide);
  const bars = [...Array.from({ length: LIVE_BARS - live.length }, () => 0), ...live];
  return (
    <View style={styles.bar} accessibilityLiveRegion="polite">
      <View style={styles.dot} />
      <T variant="callout" style={styles.time}>
        {formatDuration(elapsed)}
      </T>
      <View style={styles.levels}>
        {bars.map((level, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: a rolling window of levels
            key={i}
            style={[styles.level, { height: 4 + level * 20 }]}
          />
        ))}
      </View>
      <View style={[styles.hint, { opacity: 0.55 + toward * 0.45 }]}>
        {toward >= 1 ? (
          <Trash2 size={14} color={colors.danger} />
        ) : (
          <ChevronLeft size={14} color={colors.textMuted} />
        )}
        <T variant="caption" tone={toward >= 1 ? 'danger' : 'muted'} numberOfLines={1}>
          {toward >= 1 ? t('chatMedia.voice.releaseToCancel') : t('chatMedia.voice.slideToCancel')}
        </T>
      </View>
    </View>
  );
}

/**
 * The mic: hold to record, let go to send, slide left to drop. A tap only says how. Stays put
 * while recording (the finger is on it), a little larger.
 */
export function HoldToRecord({
  recorder,
  size,
  onTap,
}: {
  recorder: ReturnType<typeof useVoiceRecorder>;
  size: number;
  onTap(): void;
}) {
  const { t } = useTranslation();
  const hold = Gesture.Pan()
    .activateAfterLongPress(HOLD_MS)
    .runOnJS(true)
    .onStart(() => void recorder.begin())
    .onUpdate((event) => recorder.setSlide(Math.min(0, event.translationX)))
    .onEnd((event) => recorder.end(event.translationX))
    .onFinalize((_event, success) => {
      // Taken away mid-hold (a call, a system gesture): what was said is dropped.
      if (!success) recorder.end(Number.NEGATIVE_INFINITY);
    });
  const tap = Gesture.Tap().runOnJS(true).onEnd(onTap);
  return (
    <GestureDetector gesture={Gesture.Exclusive(hold, tap)}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t('chatMedia.voice.record')}
        style={[
          styles.mic,
          { width: size, height: size, borderRadius: isAndroid ? 14 : size / 2 },
          recorder.recording && styles.micActive,
        ]}
      >
        <Mic size={19} color={colors.accentInk} strokeWidth={2.4} />
      </View>
    </GestureDetector>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    bar: {
      flex: 1,
      minHeight: 36,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 12,
    },
    dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
    time: { fontVariant: ['tabular-nums'], minWidth: 40 },
    levels: {
      flex: 1,
      height: 24,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      overflow: 'hidden',
    },
    level: { width: 2.5, borderRadius: 2, backgroundColor: colors.textMuted },
    hint: { flexDirection: 'row', alignItems: 'center', gap: 2, maxWidth: 140 },
    mic: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentStrong,
    },
    micActive: { transform: [{ scale: 1.25 }], backgroundColor: colors.danger },
  }),
);
