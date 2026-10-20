import { useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native';
import { type Block, type Inline, isSafeLink, parseMarkdown } from '../lib/markdown';
import { colors, fonts, type } from '../theme';

/** Blinking block caret at the end of a streaming answer. */
function Caret() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setOn((value) => !value), 530);
    return () => clearInterval(timer);
  }, []);
  return <Text style={{ color: on ? colors.textMuted : 'transparent' }}> ▍</Text>;
}

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return nodes.map((node, index) => {
    // Inline nodes never reorder: their position is their identity.
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case 'text':
        return node.text;
      case 'code':
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.text}
          </Text>
        );
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            <InlineNodes nodes={node.children} />
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={styles.em}>
            <InlineNodes nodes={node.children} />
          </Text>
        );
      case 's':
        return (
          <Text key={key} style={styles.strike}>
            <InlineNodes nodes={node.children} />
          </Text>
        );
      default:
        return (
          <Text
            key={key}
            style={styles.link}
            accessibilityRole="link"
            onPress={isSafeLink(node.href) ? () => void Linking.openURL(node.href) : undefined}
          >
            <InlineNodes nodes={node.children} />
          </Text>
        );
    }
  });
}

interface BlockProps {
  block: Block;
  base: TextStyle;
  caret: boolean;
}

function BlockView({ block, base, caret }: BlockProps) {
  switch (block.type) {
    case 'paragraph':
      return (
        <Text style={base} selectable>
          <InlineNodes nodes={block.children} />
          {caret && <Caret />}
        </Text>
      );
    case 'heading':
      return (
        <Text style={[base, block.level <= 2 ? styles.h1 : styles.h3]} selectable>
          <InlineNodes nodes={block.children} />
          {caret && <Caret />}
        </Text>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items never reorder
            <View key={index} style={styles.item}>
              <Text style={[base, styles.bullet]}>
                {block.ordered ? `${block.start + index}.` : '•'}
              </Text>
              <View style={styles.itemBody}>
                <Blocks
                  blocks={item}
                  base={base}
                  caret={caret && index === block.items.length - 1}
                />
              </View>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={styles.quote}>
          <Blocks blocks={block.children} base={[base, styles.quoteText]} caret={caret} />
        </View>
      );
    case 'code':
      return (
        <ScrollView horizontal style={styles.codeBlock} showsHorizontalScrollIndicator={false}>
          <Text style={styles.code} selectable>
            {block.text}
            {caret && <Caret />}
          </Text>
        </ScrollView>
      );
    case 'rule':
      return <View style={styles.rule} />;
    case 'table':
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.table}>
            {[block.head, ...block.rows].map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: table rows never reorder
              <View key={r} style={[styles.row, r === 0 && styles.headRow]}>
                {row.map((cell, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table cells never reorder
                  <Text key={c} style={[base, styles.cell, r === 0 && styles.strong]}>
                    <InlineNodes nodes={cell} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
  }
}

function Blocks({
  blocks,
  base,
  caret,
}: {
  blocks: Block[];
  base: TextStyle | TextStyle[];
  caret: boolean;
}) {
  const flat = StyleSheet.flatten(base);
  return (
    <View style={styles.blocks}>
      {blocks.map((block, index) => (
        <BlockView
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks only ever append while streaming
          key={index}
          block={block}
          base={flat}
          caret={caret && index === blocks.length - 1}
        />
      ))}
    </View>
  );
}

interface Props {
  text: string;
  /** Streaming: show a blinking caret after the last word. */
  caret?: boolean;
  style?: TextStyle;
}

/** Bot answers as native Markdown (paragraphs, lists, code, quotes, tables, links). */
export function Markdown({ text, caret = false, style }: Props) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const base = useMemo(() => StyleSheet.flatten([styles.base, style]), [style]);
  if (blocks.length === 0) return caret ? <Caret /> : null;
  return <Blocks blocks={blocks} base={base} caret={caret} />;
}

const styles = StyleSheet.create({
  base: { ...type.body, color: colors.text },
  blocks: { gap: 10 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: {
    color: colors.accentStrong,
    textDecorationLine: 'underline',
    textDecorationColor: 'rgba(255, 255, 255, 0.4)',
  },
  inlineCode: {
    fontFamily: fonts.mono,
    fontSize: 13.5,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    color: colors.text,
  },
  h1: { fontSize: 18, lineHeight: 25, fontWeight: '700', marginTop: 4 },
  h3: { fontSize: 16.5, lineHeight: 23, fontWeight: '600', marginTop: 2 },
  list: { gap: 6 },
  item: { flexDirection: 'row', gap: 8 },
  bullet: { minWidth: 14, color: colors.textMuted },
  itemBody: { flex: 1 },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(255, 255, 255, 0.25)',
    paddingLeft: 12,
  },
  quoteText: { color: colors.textMuted },
  codeBlock: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.text,
    padding: 12,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderStrong,
    marginVertical: 4,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headRow: { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
  cell: { minWidth: 96, maxWidth: 220, paddingHorizontal: 10, paddingVertical: 7, fontSize: 14 },
});
