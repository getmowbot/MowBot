import { Image, type ImageContentFit } from 'expo-image';
import { type ReactNode, useState } from 'react';
import { type ImageStyle, type StyleProp, StyleSheet } from 'react-native';
import { isWebImage } from '../../lib/board';
import { themed, tint } from '../../theme';
import { MissingImage, WorkspaceImage } from './workspace-image';

interface Props {
  /** A web address, or a path in the bot's workspace. */
  src: string;
  /** The bot's workspace (null: it has none, only web pictures show). */
  workspaceId: string | null;
  alt: string;
  /** Changes when a workspace file may have changed. */
  version?: string;
  contentFit?: ImageContentFit;
  style?: StyleProp<ImageStyle>;
  /** Shown instead when the picture cannot be loaded (default: an icon and the alt text). */
  fallback?: ReactNode;
}

/**
 * A picture of a card or a gallery: a web address loads directly (never with the hub's token),
 * a workspace file through the hub like the other canvases' pictures.
 */
export function CanvasImage({
  src,
  workspaceId,
  alt,
  version,
  contentFit = 'cover',
  style,
  fallback,
}: Props) {
  // The address that failed: a new one (the bot updated the card) gets its chance.
  const [failed, setFailed] = useState<string | null>(null);
  const missing = fallback ?? <MissingImage alt={alt} style={style} />;

  if (isWebImage(src)) {
    if (failed === src) return missing;
    return (
      <Image
        source={{ uri: src.trim() }}
        accessibilityLabel={alt}
        contentFit={contentFit}
        transition={200}
        onError={() => setFailed(src)}
        style={[styles.image, style]}
      />
    );
  }
  if (!workspaceId) return missing;
  return (
    <WorkspaceImage
      key={`${src}:${version ?? ''}`}
      workspaceId={workspaceId}
      path={src}
      alt={alt}
      version={version}
      contentFit={contentFit}
      style={style}
      fallback={fallback}
    />
  );
}

const styles = themed(() =>
  StyleSheet.create({
    image: { backgroundColor: tint.ink(0.04) },
  }),
);
