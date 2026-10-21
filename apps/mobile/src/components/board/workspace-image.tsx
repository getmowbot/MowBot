import { Image, type ImageContentFit } from 'expo-image';
import { ImageOff } from 'lucide-react-native';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ImageStyle, type StyleProp, StyleSheet, View } from 'react-native';
import { workspaceFileUrl } from '../../lib/board';
import { api, authHeaders, hubUrl } from '../../lib/session';
import { colors } from '../../theme';
import { T } from '../ui/text';

interface Props {
  workspaceId: string;
  path: string;
  alt: string;
  /** Changes when the file may have changed (the canvas showing it was updated). */
  version?: string;
  contentFit?: ImageContentFit;
  style?: StyleProp<ImageStyle>;
  /** Shown instead when the file cannot be loaded (default: an icon and the alt text). */
  fallback?: ReactNode;
  /** The picture's own size, once loaded (to fit a frame to it). */
  onSize?(size: { width: number; height: number }): void;
}

/** In place of a picture that cannot be shown: an icon and its name. */
export function MissingImage({ alt, style }: { alt: string; style?: StyleProp<ImageStyle> }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.missing, style]}>
      <ImageOff size={16} color={colors.textFaint} />
      <T variant="caption" tone="faint" numberOfLines={1}>
        {alt || t('board.canvas.imageMissing')}
      </T>
    </View>
  );
}

/**
 * A picture from a bot's workspace, loaded with the device's bearer token (like the web's
 * WorkspaceImage). If the token expired meanwhile, one typed call refreshes it and the image
 * is asked again once.
 */
export function WorkspaceImage({
  workspaceId,
  path,
  alt,
  version,
  contentFit = 'cover',
  style,
  fallback,
  onSize,
}: Props) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const base = hubUrl();

  const onError = () => {
    if (attempt > 0) {
      setFailed(true);
      return;
    }
    // Any typed call renews an expiring access token; then try again with the new one.
    void api()
      .GET('/api/v1/me')
      .catch(() => undefined)
      .finally(() => setAttempt(1));
  };

  if (!base || failed) return fallback ?? <MissingImage alt={alt} style={style} />;

  return (
    <Image
      key={attempt}
      source={{
        uri: workspaceFileUrl(base, workspaceId, path),
        headers: authHeaders(),
        cacheKey: `${workspaceId}:${path}:${version ?? ''}`,
      }}
      accessibilityLabel={alt}
      contentFit={contentFit}
      transition={200}
      onLoad={
        onSize ? ({ source }) => onSize({ width: source.width, height: source.height }) : undefined
      }
      onError={onError}
      style={[styles.image, style]}
    />
  );
}

const styles = StyleSheet.create({
  image: { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
  missing: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    paddingHorizontal: 8,
  },
});
