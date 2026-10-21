import type { CanvasContent, CardButton } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { ArrowUpRight, Check, ImageOff } from 'lucide-react-native';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';
import { CARD_IMAGE_RATIO, cardButtonAction, cardButtonState, isWebLink } from '../../lib/board';
import { alertError } from '../../lib/options-menu';
import { colors } from '../../theme';
import { Markdown } from '../markdown';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { CanvasImage } from './canvas-image';
import { Pill } from './pill';

type Card = Extract<CanvasContent, { kind: 'card' }>;

/** Opens a page in the phone's browser (never on a bot's PC). */
export function openWebLink(url: string, failed: () => void) {
  if (!isWebLink(url)) return;
  Linking.openURL(url.trim()).catch(failed);
}

interface Props {
  content: Card;
  /** The bot's workspace, for a picture stored there. */
  workspaceId: string | null;
  /** Changes when the picture may have changed. */
  version: string;
  /**
   * In a message: the label of the button the user pressed (null: not yet), the card is then
   * answered. Left out on Home, where a card can be answered again.
   */
  pressed?: string | null;
  /** A button that answers the bot was pressed: resolves true once the bot has the answer. */
  onAnswer(index: number): Promise<boolean>;
}

/**
 * A product, a place, a link: its picture, title, a few words and up to three buttons (the
 * first one is the key action). Tapping the card opens its page when it has one.
 */
export function CardBody({ content, workspaceId, version, pressed, onAnswer }: Props) {
  const { t } = useTranslation();
  const [sending, setSending] = useState<number | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const failed = () => alertError(t('common.actionFailed'));
  const link = content.url && isWebLink(content.url) ? content.url : null;

  const press = (button: CardButton, index: number) => {
    const action = cardButtonAction(button);
    const state = cardButtonState(button, index, pressed);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (action.open) openWebLink(action.open, failed);
    if (!action.answer || state.locked || sending !== null) return;
    setSending(index);
    void onAnswer(index)
      .then((ok) => {
        if (ok) setSent(index);
      })
      .finally(() => setSending(null));
  };

  const main: ReactNode = (
    <>
      {content.image ? (
        <CanvasImage
          src={content.image}
          workspaceId={workspaceId}
          alt={content.title}
          version={version}
          style={styles.image}
          fallback={
            <View style={[styles.image, styles.noImage]}>
              <ImageOff size={22} color={colors.textFaint} />
            </View>
          }
        />
      ) : null}
      <View style={styles.heading}>
        <T variant="headline" numberOfLines={3}>
          {content.title}
        </T>
        {content.subtitle ? (
          <T variant="footnote" tone="muted" numberOfLines={2}>
            {content.subtitle}
          </T>
        ) : null}
      </View>
      {content.text?.trim() ? <Markdown text={content.text} style={styles.text} /> : null}
    </>
  );

  return (
    <View style={styles.root}>
      {link ? (
        <Touchable
          accessibilityRole="link"
          accessibilityHint={t('board.canvas.opensPage')}
          onPress={() => openWebLink(link, failed)}
          style={styles.main}
        >
          {main}
        </Touchable>
      ) : (
        <View style={styles.main}>{main}</View>
      )}
      {content.buttons.length > 0 && (
        <View style={styles.buttons}>
          {content.buttons.map((button, index) => {
            const action = cardButtonAction(button);
            const state = cardButtonState(button, index, pressed);
            const done = state.chosen || (pressed === undefined && sent === index);
            return (
              <Pill
                // biome-ignore lint/suspicious/noArrayIndexKey: a card's buttons never reorder
                key={index}
                label={button.label}
                icon={done ? Check : action.open ? ArrowUpRight : undefined}
                variant={state.primary ? 'solid' : 'outline'}
                loading={sending === index}
                // Answering again is off (the choice stays readable); pages still open.
                disabled={state.locked}
                accessibilityLabel={
                  state.chosen
                    ? `${button.label}, ${t('board.canvas.chosen')}`
                    : done
                      ? `${button.label}, ${t('board.canvas.sent')}`
                      : undefined
                }
                onPress={() => press(button, index)}
                style={state.chosen ? styles.chosen : undefined}
              />
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 14 },
  main: { gap: 12, borderRadius: 12 },
  image: {
    width: '100%',
    aspectRatio: CARD_IMAGE_RATIO,
    borderRadius: 12,
    borderCurve: 'continuous',
  },
  noImage: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  heading: { gap: 2 },
  text: { fontSize: 14.5, lineHeight: 21 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chosen: { opacity: 1 },
});
