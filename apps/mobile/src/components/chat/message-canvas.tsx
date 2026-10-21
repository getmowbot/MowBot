import type { Bot, Message } from '@mowbot/contract';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import type { CanvasPart } from '../../lib/activity';
import { problemCode } from '../../lib/hub-url';
import { alertError } from '../../lib/options-menu';
import { usePressCard } from '../../lib/queries';
import { CanvasBody } from '../board/canvas-kinds';
import { Surface } from '../ui/surface';

interface Props {
  message: Message;
  bot: Bot;
  part: CanvasPart;
  /** The part's position in the message (a card's buttons answer by it). */
  index: number;
}

/**
 * What a bot shows inside its answer: the Home canvas kinds, without their card chrome (no menu,
 * fold or size). Pictures stand on their own; the other kinds sit on a flat card.
 */
export function MessageCanvas({ message, bot, part, index }: Props) {
  const { t } = useTranslation();
  const press = usePressCard(bot.id);
  const { content } = part;

  const answer = async (button: number) => {
    const label = content.kind === 'card' ? content.buttons[button]?.label : undefined;
    if (label === undefined) return false;
    try {
      await press.mutateAsync({ messageId: message.id, part: index, button, label });
      return true;
    } catch (error) {
      // Answered meanwhile (another device): the conversation refetches and shows the choice.
      if (problemCode(error) !== 'card_answered') alertError(t('common.actionFailed'));
      return false;
    }
  };

  const body = (
    <CanvasBody
      content={content}
      workspaceId={bot.workspaceId}
      size="m"
      version={message.id}
      title={content.kind === 'card' ? content.title : bot.name}
      pressed={part.pressed}
      onAnswer={answer}
    />
  );
  if (content.kind === 'gallery') return body;
  return <Surface style={styles.card}>{body}</Surface>;
}

const styles = StyleSheet.create({
  card: { padding: 14 },
});
