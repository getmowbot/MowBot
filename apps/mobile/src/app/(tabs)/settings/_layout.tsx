import { useTranslation } from 'react-i18next';
import { TabStack } from '../../../components/tab-stack';

export default function SettingsLayout() {
  const { t } = useTranslation();
  return <TabStack title={t('tabs.settings')} />;
}
