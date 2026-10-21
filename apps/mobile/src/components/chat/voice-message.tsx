import type { Message, MessagePart } from '@mowbot/contract';
import { type AudioPlayer, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { ChevronDown, ChevronUp, Pause, Play, RotateCw } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { contentUrl } from '../../lib/files';
import { useRetryTranscript } from '../../lib/queries';
import { hubUrl } from '../../lib/session';
import { freshAuthHeaders } from '../../lib/uploads';
import { fitPeaks, formatDuration, playedFraction } from '../../lib/voice';
import { colors } from '../../theme';
import { ShimmerText } from '../ui/shimmer-text';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

type AudioPart = Extract<MessagePart, { type: 'audio' }>;

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const WAVE_HEIGHT = 30;

/** One voice message plays at a time: starting one pauses the other. */
let playing: AudioPlayer | null = null;

/**
 * A voice message: play/pause, its waveform (a tap moves in it), its length, and under it the
 * transcript made on the hub, folded until asked for (or a retry when it failed). The player is
 * made on the first play: a long conversation holds no native player for each message.
 */
export function VoiceMessage({ message, part }: { message: Message; part: AudioPart }) {
  const { t } = useTranslation();
  const retry = useRetryTranscript(message.botId);
  const player = useRef<AudioPlayer | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [measured, setMeasured] = useState(0);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  const duration = part.durationMs || measured;
  const progress = playedFraction(position, duration);
  const bars = fitPeaks(part.peaks, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));

  // A new file (converted on the hub) or leaving the conversation: the player goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: released when the file changes
  useEffect(() => {
    return () => {
      const current = player.current;
      player.current = null;
      if (current) {
        if (playing === current) playing = null;
        current.remove();
      }
      setIsPlaying(false);
      setPosition(0);
    };
  }, [part.path]);

  const ensurePlayer = async (): Promise<AudioPlayer> => {
    if (player.current) return player.current;
    const hub = hubUrl();
    if (!hub) throw new Error('No hub');
    setLoading(true);
    try {
      // Heard even with the phone on silent, like any voice message.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      const created = createAudioPlayer(
        {
          uri: contentUrl(hub, part.workspaceId, part.path),
          headers: await freshAuthHeaders(),
        },
        { updateInterval: 100 },
      );
      created.addListener('playbackStatusUpdate', (status) => {
        setIsPlaying(status.playing);
        if (status.duration > 0) setMeasured(status.duration * 1000);
        setPosition(status.didJustFinish ? 0 : status.currentTime * 1000);
        if (status.didJustFinish) void created.seekTo(0);
      });
      player.current = created;
      return created;
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    setFailed(false);
    try {
      const audio = await ensurePlayer();
      if (audio.playing) {
        audio.pause();
        return;
      }
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play();
    } catch {
      setFailed(true);
    }
  };

  const seek = async (x: number) => {
    if (width <= 0 || duration <= 0) return;
    const fraction = Math.min(1, Math.max(0, x / width));
    setPosition(fraction * duration);
    try {
      const audio = await ensurePlayer();
      await audio.seekTo((fraction * duration) / 1000);
      if (!audio.playing) {
        if (playing && playing !== audio) playing.pause();
        playing = audio;
        audio.play();
      }
    } catch {
      setFailed(true);
    }
  };

  const unheard =
    part.transcriptStatus === 'failed' || (part.transcriptStatus === 'done' && !part.transcript);

  return (
    <View style={styles.bubble}>
      <View style={styles.row}>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? t('chatMedia.voice.pause') : t('chatMedia.voice.play')}
          onPress={() => void toggle()}
          onAccent
          style={styles.play}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.accentInk} />
          ) : isPlaying ? (
            <Pause size={16} color={colors.accentInk} fill={colors.accentInk} />
          ) : (
            <Play size={16} color={colors.accentInk} fill={colors.accentInk} style={styles.nudge} />
          )}
        </Touchable>
        <View
          style={styles.wave}
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onResponderRelease={(event) => void seek(event.nativeEvent.locationX)}
          accessibilityRole="adjustable"
          accessibilityValue={{ text: formatDuration(position) }}
        >
          {bars.map((peak, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars of a fixed recording
              key={i}
              style={[
                styles.bar,
                {
                  height: Math.max(4, peak * WAVE_HEIGHT),
                  opacity: (i + 0.5) / bars.length <= progress ? 1 : 0.35,
                },
              ]}
            />
          ))}
        </View>
        <T variant="caption" style={styles.time}>
          {formatDuration(isPlaying || position > 0 ? position : duration)}
        </T>
      </View>
      {failed && (
        <T variant="caption" style={styles.note}>
          {t('chatMedia.voice.unplayable')}
        </T>
      )}
      <View style={styles.transcript}>
        {part.transcriptStatus === 'pending' ? (
          <ShimmerText style={styles.note}>{t('chatMedia.voice.transcribing')}</ShimmerText>
        ) : unheard ? (
          <View style={styles.inline}>
            <T variant="caption" style={styles.note}>
              {part.transcriptStatus === 'failed'
                ? t('chatMedia.voice.failed')
                : t('chatMedia.voice.silent')}
            </T>
            <Touchable
              accessibilityRole="button"
              onPress={() => retry.mutate(message.id)}
              disabled={retry.isPending}
              style={styles.inline}
            >
              <RotateCw size={12} color={colors.accentInk} />
              <T variant="caption" style={styles.link}>
                {t('chatMedia.voice.retry')}
              </T>
            </Touchable>
          </View>
        ) : (
          <>
            <Touchable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen((value) => !value)}
              style={styles.inline}
            >
              <T variant="caption" style={styles.link}>
                {t('chatMedia.voice.transcript')}
              </T>
              {open ? (
                <ChevronUp size={14} color={colors.accentInk} />
              ) : (
                <ChevronDown size={14} color={colors.accentInk} />
              )}
            </Touchable>
            {open && (
              <T selectable style={styles.text}>
                {part.transcript}
              </T>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    width: 260,
    maxWidth: '85%',
    borderRadius: 20,
    borderBottomRightRadius: 6,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 9,
    backgroundColor: colors.accent,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  play: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(7, 8, 10, 0.08)',
    overflow: 'hidden',
  },
  nudge: { marginLeft: 2 },
  wave: {
    flex: 1,
    height: WAVE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: BAR_GAP,
    overflow: 'hidden',
  },
  bar: { width: BAR_WIDTH, borderRadius: BAR_WIDTH, backgroundColor: colors.accentInk },
  time: { color: colors.accentInk, opacity: 0.75, fontVariant: ['tabular-nums'], minWidth: 32 },
  transcript: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(7, 8, 10, 0.15)',
    paddingTop: 6,
    gap: 4,
  },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  note: { color: colors.accentInk, opacity: 0.7, fontSize: 12, lineHeight: 16 },
  link: { color: colors.accentInk, fontWeight: '600' },
  text: { color: colors.accentInk, fontSize: 14.5, lineHeight: 21 },
});
