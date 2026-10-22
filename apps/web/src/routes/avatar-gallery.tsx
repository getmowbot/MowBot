import { useTranslation } from 'react-i18next';
import { BotAvatar, type BotMood, TeamAvatar } from '../components/bot-avatar';

const SEEDS = [
  'chef',
  'nova',
  'iris',
  'atlas',
  'tao',
  'echo',
  'orbit',
  'pixel',
  'mila',
  'zed',
  'kiwi',
  'lune',
];
const MOODS: BotMood[] = ['idle', 'thinking', 'working', 'waiting', 'sleeping', 'error'];

/** Dev-only page to review bot characters (variety, moods, sizes). */
export function AvatarGallery() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-4xl space-y-10 p-6">
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">{t('gallery.characters')}</h1>
        <div className="flex flex-wrap gap-5">
          {SEEDS.map((seed) => (
            <div key={seed} className="flex flex-col items-center gap-1.5">
              <BotAvatar seed={seed} size={64} followPointer />
              <span className="text-xs text-faint">{seed}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="font-medium">{t('gallery.moods')}</h2>
        <div className="flex flex-wrap gap-6">
          {MOODS.map((mood) => (
            <div key={mood} className="flex flex-col items-center gap-1.5">
              <BotAvatar seed="nova" size={72} mood={mood} />
              <span className="text-xs text-faint">{mood}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="font-medium">{t('gallery.list')}</h2>
        <div className="glass w-72 space-y-1 rounded-2xl p-2">
          {SEEDS.slice(0, 5).map((seed, i) => (
            <div
              key={seed}
              className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink/[0.05]"
            >
              <BotAvatar
                seed={seed}
                size={34}
                badge={i === 2}
                mood={i === 1 ? 'working' : 'idle'}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium capitalize">{seed}</p>
                <p className="truncate text-xs text-faint">{t('gallery.lastMessage')}</p>
              </div>
            </div>
          ))}
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <TeamAvatar seeds={['tao', 'iris', 'atlas']} size={34} />
            <p className="text-sm font-medium">{t('common.team')}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
