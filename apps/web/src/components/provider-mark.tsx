import { BRAND_MARKS, providerBrand } from '@mowbot/design';
import { Plug } from 'lucide-react';
import { cn } from '../lib/utils';

/** A provider's mark (OpenAI, Anthropic, Command Code…), or a plug for an endpoint we don't know. */
export function ProviderMark({
  kind,
  baseUrl,
  className,
}: {
  kind: string;
  baseUrl?: string | null;
  className?: string;
}) {
  const brand = providerBrand(kind, baseUrl);
  if (!brand) return <Plug className={cn('size-4 shrink-0', className)} aria-hidden />;
  const mark = BRAND_MARKS[brand];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      className={cn('size-4 shrink-0', className)}
      role="img"
      aria-label={mark.name}
    >
      <title>{mark.name}</title>
      <path d={mark.path} />
    </svg>
  );
}
