import type { Bot } from '@mowbot/contract';
import * as Clipboard from 'expo-clipboard';
import { router, Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  Ellipsis,
  EllipsisVertical,
  Hand,
  type LucideIcon,
  Maximize2,
  Minimize2,
  MonitorUp,
  Play,
  Power,
  RotateCw,
  Undo2,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BotWindow } from '../../../components/pc/bot-window';
import { type DesktopHandle, DesktopView } from '../../../components/pc/desktop-view';
import { KeyboardBar } from '../../../components/pc/keyboard-bar';
import { ControlBanner, PcStateCard, StatusLine } from '../../../components/pc/pc-status';
import { ViewSwitch } from '../../../components/pc/view-switch';
import { Screen } from '../../../components/screen';
import { Button, IconButton } from '../../../components/ui/button';
import { T } from '../../../components/ui/text';
import { Touchable } from '../../../components/ui/touchable';
import { alertError, confirm, type MenuOption, openOptions } from '../../../lib/options-menu';
import {
  type ComputerAction,
  pcProblem,
  useAppActive,
  useBotBrowser,
  useComputer,
  useComputerAction,
  useShowBotBrowser,
} from '../../../lib/pc-queries';
import { isAndroid } from '../../../lib/platform';
import { useBots, useMe } from '../../../lib/queries';
import { colors, spacing } from '../../../theme';

const SCREEN = 'screen';

/** Same height as `Button`, so the two line up in the action row. */
const ACTION_HEIGHT = isAndroid ? 48 : 50;

function RoundButton({
  icon: Icon,
  label,
  onPress,
  floating = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress(): void;
  /** Over the screen in full screen (dark, smaller). */
  floating?: boolean;
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={[styles.round, floating && styles.roundFloating]}
    >
      <Icon size={20} color={colors.text} strokeWidth={2} />
    </Touchable>
  );
}

/**
 * A PC: its live screen (take control to click and type), or the window of one of the bots
 * working on it. Turn it on, restart or turn it off from here.
 */
export default function PcScreen() {
  const { computerId, bot: botParam } = useLocalSearchParams<{
    computerId: string;
    bot?: string;
  }>();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const focused = useIsFocused();
  const active = useAppActive();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const computer = useComputer(computerId);
  const bots = useBots();
  const me = useMe();
  const action = useComputerAction(computerId);
  const showOnScreen = useShowBotBrowser();
  const desktop = useRef<DesktopHandle>(null);
  // The screen, or a bot's id for its window. Opened from a chat: that bot's window first.
  const [shown, setShown] = useState(botParam || SCREEN);
  // Once opened, the screen stays connected while a bot's window is shown: switching back is
  // instant, and closing it would hand control back to the bots.
  const [screenOpened, setScreenOpened] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // What just went through the clipboard, shown for a moment under the keyboard bar.
  const [clipNote, setClipNote] = useState<string | null>(null);
  const clipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const note = (text: string) => {
    setClipNote(text);
    clearTimeout(clipTimer.current);
    clipTimer.current = setTimeout(() => setClipNote(null), 2_500);
  };
  useEffect(() => () => clearTimeout(clipTimer.current), []);
  // Copied on the PC (Ctrl+C there): onto the phone's clipboard.
  const copiedOnPc = (text: string) => {
    void Clipboard.setStringAsync(text).then(() => note(t('pcView.clipboard.copied')));
  };
  // The phone's clipboard, pasted on the PC.
  const pasteOnPc = async () => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (!text) {
      note(t('pcView.clipboard.empty'));
      return;
    }
    desktop.current?.paste(text);
    note(t('pcView.clipboard.pasted'));
  };

  const pc = computer.data;
  const running = pc?.status === 'running';
  const pcBots: Bot[] = (bots.data ?? []).filter((b) => b.computerId === computerId);
  const shownBot = running ? pcBots.find((b) => b.id === shown) : undefined;
  const showingScreen = running && !shownBot;
  const isFullscreen = fullscreen && showingScreen;
  const control = pc?.control ?? null;
  const inControl = Boolean(control && me.data && control.deviceId === me.data.device.id);
  const browser = useBotBrowser(shownBot?.id ?? '', Boolean(shownBot) && focused && active);

  useEffect(() => {
    if (showingScreen) setScreenOpened(true);
  }, [showingScreen]);

  useEffect(() => {
    if (!isFullscreen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setFullscreen(false);
      return true;
    });
    return () => subscription.remove();
  }, [isFullscreen]);

  const failed = (error: unknown) => {
    const problem = pcProblem(error);
    alertError(problem === 'generic' ? t('common.actionFailed') : t(`pcView.errors.${problem}`));
  };
  const run = (kind: ComputerAction) => action.mutate(kind, { onError: failed });
  const pending = (...kinds: ComputerAction[]) =>
    action.isPending && kinds.includes(action.variables as ComputerAction);

  const openMenu = () => {
    if (!pc) return;
    const options: MenuOption[] = [];
    if (pc.status === 'running') {
      options.push(
        {
          label: t('pcView.restart'),
          icon: RotateCw,
          onPress: () =>
            void confirm(t('pcView.restart'), t('pcView.restartConfirm', { name: pc.name }), {
              label: t('pcView.restart'),
              destructive: true,
            }).then((ok) => ok && run('restart')),
        },
        {
          label: t('pcView.turnOff'),
          icon: Power,
          destructive: true,
          onPress: () =>
            void confirm(t('pcView.turnOff'), t('pcView.turnOffConfirm', { name: pc.name }), {
              label: t('pcView.turnOff'),
              destructive: true,
            }).then((ok) => ok && run('stop')),
        },
      );
    } else if (pc.status === 'stopped' || pc.status === 'error') {
      options.push({ label: t('pcView.turnOn'), icon: Play, onPress: () => run('start') });
    }
    if (options.length > 0) openOptions({ title: pc.name, options });
  };

  const menuAvailable = pc && pc.status !== 'starting' && pc.status !== 'stopping';
  const headerRight = menuAvailable
    ? () => (
        <IconButton
          icon={isAndroid ? EllipsisVertical : Ellipsis}
          label={t('pcView.options')}
          onPress={openMenu}
        />
      )
    : undefined;

  if (!pc) {
    return (
      <Screen title={t('pcView.title')} scroll={false}>
        <View style={styles.center}>
          {computer.isPending ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <>
              <T tone="muted">{t('pcView.notFound')}</T>
              <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
            </>
          )}
        </View>
      </Screen>
    );
  }

  const viewOptions = [
    { value: SCREEN, label: t('pcView.screen') },
    ...pcBots.map((b) => ({ value: b.id, label: t('pcView.botWindow', { name: b.name }) })),
  ];

  // Full screen turns the screen a quarter (phone held sideways): the PC's wide desktop then
  // gets the phone's long side. Same elements as inline, so the connection survives.
  const sideways = {
    width: viewport.height - insets.top - insets.bottom,
    height: viewport.width,
    transform: [{ rotate: '90deg' }],
  };

  return (
    <Screen title={pc.name} scroll={false} headerRight={headerRight}>
      {/* Applied after Screen's own options: no header, no back swipe in full screen. */}
      <Stack.Screen
        options={{
          headerShown: !isFullscreen,
          gestureEnabled: !isFullscreen,
          autoHideHomeIndicator: isFullscreen,
          navigationBarHidden: isFullscreen,
        }}
      />
      {isFullscreen ? <StatusBar hidden /> : null}
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        {!isFullscreen && (
          <View style={styles.top}>
            <StatusLine computer={pc} botNames={pcBots.map((b) => b.name)} />
            {running && control ? <ControlBanner mine={inControl} /> : null}
            {running && pcBots.length > 0 ? (
              <ViewSwitch
                options={viewOptions}
                value={shownBot ? shownBot.id : SCREEN}
                onChange={setShown}
                label={t('pcView.views')}
              />
            ) : null}
          </View>
        )}

        <View style={styles.area}>
          {!running ? (
            <View style={styles.inset}>
              <PcStateCard
                computer={pc}
                onTurnOn={() => run('start')}
                turningOn={pending('start')}
              />
            </View>
          ) : null}
          {running && (screenOpened || showingScreen) ? (
            <View
              style={
                isFullscreen
                  ? [styles.fullscreen, { paddingTop: insets.top, paddingBottom: insets.bottom }]
                  : [styles.layer, !showingScreen && styles.hidden]
              }
            >
              <View style={isFullscreen ? sideways : styles.fill}>
                <DesktopView
                  ref={desktop}
                  computerId={computerId}
                  interactive={inControl}
                  bare={isFullscreen}
                  onClipboard={copiedOnPc}
                />
                {isFullscreen ? (
                  <View style={styles.exit}>
                    <RoundButton
                      icon={Minimize2}
                      label={t('pcView.exitFullscreen')}
                      onPress={() => setFullscreen(false)}
                      floating
                    />
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}
          {shownBot ? (
            <View style={styles.layer}>
              <BotWindow bot={shownBot} page={browser.data} loading={browser.isPending} />
            </View>
          ) : null}
        </View>

        {running && !isFullscreen ? (
          <View
            style={[
              styles.dock,
              { paddingBottom: (keyboardVisible ? 0 : insets.bottom) + spacing.md },
            ]}
          >
            {shownBot ? (
              <View style={styles.inset}>
                <Button
                  label={t('pcView.showOnScreen')}
                  icon={MonitorUp}
                  variant="secondary"
                  disabled={!browser.data?.open}
                  loading={showOnScreen.isPending}
                  onPress={() =>
                    showOnScreen.mutate(shownBot.id, {
                      onSuccess: () => setShown(SCREEN),
                      onError: failed,
                    })
                  }
                />
              </View>
            ) : (
              <>
                {inControl ? (
                  <KeyboardBar
                    onKeys={(keys) => desktop.current?.sendKeys(keys)}
                    onCombo={(keys) => desktop.current?.sendCombo(keys)}
                    onPaste={() => void pasteOnPc()}
                  />
                ) : null}
                {inControl && clipNote ? (
                  <T variant="footnote" tone="muted" style={[styles.inset, styles.clipNote]}>
                    {clipNote}
                  </T>
                ) : null}
                {keyboardVisible ? null : (
                  <View style={[styles.inset, styles.actions]}>
                    <Button
                      label={t(inControl ? 'pcView.release' : 'pcView.takeover')}
                      icon={inControl ? Undo2 : Hand}
                      onPress={() => run(inControl ? 'release' : 'takeover')}
                      loading={pending('takeover', 'release')}
                      disabled={action.isPending}
                      style={styles.grow}
                    />
                    <RoundButton
                      icon={Maximize2}
                      label={t('pcView.fullscreen')}
                      onPress={() => setFullscreen(true)}
                    />
                  </View>
                )}
              </>
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  body: { flex: 1 },
  top: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  area: { flex: 1 },
  inset: { paddingHorizontal: spacing.lg },
  // Views of the PC stacked in the area, lined up with the content above.
  layer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: spacing.lg,
    right: spacing.lg,
  },
  // Kept connected but out of sight (and out of reach of touches).
  hidden: { opacity: 0, pointerEvents: 'none' },
  fill: { flex: 1 },
  fullscreen: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  exit: { position: 'absolute', top: spacing.md, right: spacing.md },
  dock: { gap: spacing.md, paddingTop: spacing.md },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  grow: { flex: 1 },
  round: {
    width: ACTION_HEIGHT,
    height: ACTION_HEIGHT,
    borderRadius: ACTION_HEIGHT / 2,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  roundFloating: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  clipNote: { textAlign: 'center' },
});
