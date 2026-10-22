import { BRAND_MARKS, providerBrand } from '@mowbot/design';
import { Plug } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme';

/** A provider's mark (OpenAI, Anthropic, Command Code…), or a plug for an endpoint we don't know. */
export function ProviderMark({
  kind,
  baseUrl,
  size = 18,
  color = colors.text,
}: {
  kind: string;
  baseUrl?: string | null;
  size?: number;
  color?: string;
}) {
  const brand = providerBrand(kind, baseUrl);
  if (!brand) return <Plug size={size} color={color} strokeWidth={2} />;
  const mark = BRAND_MARKS[brand];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityLabel={mark.name}
      accessibilityRole="image"
    >
      <Path d={mark.path} fill={color} fillRule="evenodd" clipRule="evenodd" />
    </Svg>
  );
}
